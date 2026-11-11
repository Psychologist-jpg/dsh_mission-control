/**
 * Mission Control — Agent Teams 的任务驾驶舱补充插件。
 *
 * 补三个官方 Agent Teams 包没有的能力：
 *  1. 任务级人数上限：mission_start 指定 workers，超过上限的 spawn_teammate 被拒绝。
 *  2. 上下文哨兵：定时用 tokenMeter 测量每个工蜂的上下文压力，超阈值时打断并在新会话里
 *     接续（继承结构化摘要），不依赖任何模型的自我检测。
 *  3. 驾驶舱中继：原初会话里人类发的话，立即扇出给全体工蜂，不等 Lead 跑模型。
 *
 * 所有检测都在 Host 侧完成，不消耗任何会话的 token。
 */

import { readdir, unlink, rm, mkdir, writeFile } from 'node:fs/promises'
import { existsSync, statSync, readdirSync, readFileSync, mkdirSync, writeFileSync, renameSync } from 'node:fs'
import { join, resolve, sep, dirname } from 'node:path'

const DEFAULT_CONFIG = {
  pollIntervalMs: 15000,
  warnRatio: 0.65,
  handoffRatio: 0.85,
  defaultCap: 3,
  fallbackContextWindow: 131072,
  freshProvider: 'spawn',
  // 「结束任务」要删除的临时文件：只有匹配这些模式的文件会被删除，结果文件不受影响
  cleanupGlobs: [
    '*.tmp',
    '*.temp',
    '*.log',
    '*.bak',
    '*.orig',
    '*.rej',
    '*.swp',
    '*.swo',
    '*~',
    '.DS_Store',
    'Thumbs.db',
  ],
  // 「结束任务」要整个删除的临时目录（相对工作目录）
  cleanupDirs: ['.mission-control/tmp'],
  cleanupMaxFiles: 500,
  // 结束时是否物理删除子会话的日志文件（默认关闭：仅归档，不删记录）
  deleteSessionLogs: false,
  // 生图：任务命中关键词时不再切换会话模型（图像模型不支持 chat 协议，会 404），
  // 改为让子会话调用 mission_image 工具，用配置的图像模型真正出图。
  imageModelSwitch: false,
  imageProvider: 'ustc',
  imageModel: 'qwen-image-2.1',
  imageApiBaseUrl: 'https://api.llm.ustc.edu.cn/v1',
  imageApiKeyRef: 'USTC_API_KEY',
  imageApiSize: '1024x1024',
  // 未开启蜂巢模式时禁止创建团队工蜂（spawn_teammate）
  requireHiveModeForSpawns: true,
  // 未开启蜂巢模式时是否也禁止平台内置的 subagent / subagent_fork / workflow 委派
  // 方案 A：开关是唯一入口，默认开启（去关闭可恢复平台原生并行能力）
  blockDelegationOutsideHive: true,
  // 同一条交接链最多续任几代（按链根名统计），防止阈值配置异常时无限 spawn
  maxHandoffRounds: 3,
  // 性能：面板快照缓存 TTL（0=关闭缓存）、上下文测量缓存 TTL
  snapshotCacheTtlMs: 1000,
  measureCacheTtlMs: 1000,
  imageKeywords: [
    '生图', '生成图片', '画图', '绘制', '插图', '配图', '出图',
    '海报', '封面图', '示意图', '图片生成', '文生图',
    'image', 'draw', 'illustration', 'poster',
  ],
}

/** 任务文本是否属于"需要生图"的范畴。 */
function needsImageModel(text, keywords) {
  const source = String(text ?? '').toLowerCase()
  if (!source) return false
  return (keywords ?? []).some((kw) => kw && source.includes(String(kw).toLowerCase()))
}

/** 路由请求体最大字节数（防止无上限 body）。 */
const MAX_BODY_BYTES = 64 * 1024

/** 会产出文件的工具：只有这些工具调用里的路径才算"结果文件"。 */
const WRITE_TOOLS = new Set(['write', 'edit', 'mission_image', 'present'])

/** 把一个 glob（仅支持 * 和 ?）编译成正则。 */
function globToRegExp(glob) {
  const escaped = String(glob).replace(/[.+^${}()|[\]\\]/g, '\\$&')
  const body = escaped.replace(/\*/g, '.*').replace(/\?/g, '.')
  return new RegExp(`^${body}$`, 'i')
}

function textBlock(text) {
  return { type: 'text', text }
}

function blocksToText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n')
    .trim()
}

function errText(error) {
  if (!error) return 'unknown error'
  if (typeof error === 'string') return error
  return String(error.message ?? error)
}

/** 从会话尾部提取最近若干条助手发言，作为交接摘要的素材。 */
function recentAssistantText(session, limit) {
  try {
    const events = session.snapshotEvents()
    const out = []
    for (let i = events.length - 1; i >= 0 && out.length < limit; i -= 1) {
      const event = events[i]
      if (event.type !== 'assistant/message') continue
      const text = blocksToText(event.data?.message?.content)
      if (text) out.push(text)
    }
    return out.reverse()
  } catch {
    return []
  }
}

export const inject = ['tools', 'webServer']

export function apply(ctx, rawConfig) {
  const config = { ...DEFAULT_CONFIG, ...(rawConfig ?? {}) }
  /** sessionId(string) -> mission */
  const missions = new Map()
  /**
   * 曾经开过蜂巢模式、但现在已经关闭/结束的会话。
   * 系统提示据此补一条"回到普通会话"的指令，压掉对话历史里残留的旧分派契约。
   */
  const hiveOffNotice = new Set()

  // ── C1 持久化：任务状态落盘，重启/重载后恢复 ──────────────────────────────
  const stateDir = () => join(dshHome(), 'storages', 'mission-control')
  const stateFile = () => join(stateDir(), 'missions.json')
  const STATE_TTL_MS = 7 * 24 * 60 * 60 * 1000

  /** mission → 可 JSON 化的普通对象（Set/Map 转数组）。 */
  function serializeMission(mission) {
    const arr = (value) => (value instanceof Set ? [...value] : [])
    const entries = (value) =>
      value instanceof Map ? [...value.entries()] : []
    return {
      sessionId: mission.sessionId,
      task: mission.task,
      taskAt: mission.taskAt ?? null,
      cap: mission.cap,
      startedAt: mission.startedAt,
      paused: mission.paused === true,
      baseline: arr(mission.baseline),
      baselineTasks: arr(mission.baselineTasks),
      handedOff: arr(mission.handedOff),
      retired: arr(mission.retired),
      handoffRounds: entries(mission.handoffRounds),
      handoffChainRounds: entries(mission.handoffChainRounds),
      workerModels: entries(mission.workerModels),
      workerBaseModels: entries(mission.workerBaseModels),
      lastHandoff: mission.lastHandoff ?? null,
      lastError: mission.lastError ?? null,
      updatedAt: Date.now(),
    }
  }

  /** 普通对象 → mission（恢复 Set/Map 与默认值）。 */
  function deserializeMission(raw) {
    const asSet = (value) => new Set(Array.isArray(value) ? value : [])
    const asMap = (value) => new Map(Array.isArray(value) ? value : [])
    return {
      sessionId: String(raw.sessionId),
      task: String(raw.task ?? ''),
      taskAt: Number(raw.taskAt) || undefined,
      cap: Number(raw.cap) || Number(config.defaultCap) || 3,
      startedAt: Number(raw.startedAt) || Date.now(),
      paused: raw.paused === true,
      baseline: asSet(raw.baseline),
      baselineTasks: asSet(raw.baselineTasks),
      handoffInFlight: new Set(),
      handoffRounds: asMap(raw.handoffRounds),
      handoffChainRounds: asMap(raw.handoffChainRounds),
      handedOff: asSet(raw.handedOff),
      retired: asSet(raw.retired),
      workerModels: asMap(raw.workerModels),
      workerBaseModels: asMap(raw.workerBaseModels),
      lastHandoff: raw.lastHandoff ?? undefined,
      lastError: raw.lastError ?? undefined,
      restoredAt: Date.now(),
    }
  }

  let persistTimer = null
  /** 去抖写盘（300ms），失败静默——持久化只是缓存，不能影响主流程。 */
  function persistState() {
    // 任何任务状态变更都同时让面板快照失效，保证关键变化即时可见
    invalidateSnapshot()
    if (persistTimer) return
    persistTimer = setTimeout(() => {
      persistTimer = null
      try {
        const dir = stateDir()
        mkdirSync(dir, { recursive: true })
        const file = stateFile()
        const payload = {
          version: 1,
          savedAt: Date.now(),
          missions: [...missions.values()].map(serializeMission),
        }
        const tmp = `${file}.tmp`
        writeFileSync(tmp, JSON.stringify(payload), 'utf8')
        renameSync(tmp, file)
      } catch {
        // 写入失败时下次变更会再试
      }
    }, 300)
  }

  /**
   * 对账：把恢复出来的任务与磁盘/花名册对齐。
   * - 已删除或已归档的成员 → 移入 retired（不再算活跃、不再收广播）
   * - 花名册里不存在的名字 → 从 handedOff/retired 里剔除
   */
  async function reconcileMission(mission, indexArg) {
    const index = indexArg ?? (await sessionDirIndex())
    const archivedSet = archivedSessionIds()
    const agent = services.agents()?.get(mission.sessionId)
    const roster = agent ? teammatesOf(agent) : []
    const rosterNames = new Set(roster.map((m) => String(m.name)))
    let changed = false

    for (const name of [...(mission.handedOff ?? [])]) {
      if (!rosterNames.has(String(name))) {
        mission.handedOff.delete(name)
        changed = true
      }
    }
    for (const name of [...(mission.retired ?? [])]) {
      if (!rosterNames.has(String(name))) {
        mission.retired.delete(name)
        changed = true
      }
    }
    mission.retired = mission.retired ?? new Set()
    const baseline = mission.baseline ?? new Set()
    for (const member of roster) {
      const name = String(member.name)
      if (baseline.has(name)) continue
      const id = String(member.id)
      const alive = index.has(id) && !archivedSet.has(id)
      if (!alive && !mission.retired.has(name)) {
        mission.retired.add(name)
        changed = true
      }
    }
    if (changed) persistState()
    return changed
  }

  /** 启动时恢复：过期/会话已不存在的任务直接丢弃。 */
  async function loadPersistedState() {
    try {
      const file = stateFile()
      if (!existsSync(file)) return
      const raw = JSON.parse(readFileSync(file, 'utf8'))
      const list = Array.isArray(raw?.missions) ? raw.missions : []
      const index = await sessionDirIndex()
      let loaded = 0
      for (const item of list) {
        const sid = String(item?.sessionId ?? '')
        if (!sid) continue
        const updatedAt = Number(item.updatedAt) || 0
        if (updatedAt && Date.now() - updatedAt > STATE_TTL_MS) continue
        // 主会话必须仍然存在（live 或磁盘有日志），否则丢弃
        const exists = services.agents()?.get(sid) || index.has(sid.replace(/^session-/, ''))
        if (!exists) continue
        missions.set(sid, deserializeMission(item))
        loaded += 1
      }
      for (const mission of [...missions.values()]) {
        await reconcileMission(mission, index)
      }
      if (loaded > 0) {
        // 让恢复出来的会话回到正确提示状态
        for (const mission of missions.values()) {
          if (mission.paused === true) hiveOffNotice.add(mission.sessionId)
          else hiveOffNotice.delete(mission.sessionId)
        }
      }
    } catch {
      // 损坏的状态文件不应阻止插件启动
    }
  }

  const services = {
    team: () => ctx.get('agentTeams'),
    agents: () => ctx.get('agents'),
    sessions: () => ctx.get('sessions'),
    meter: () => ctx.get('tokenMeter'),
  }

  function teammatesOf(agent) {
    const team = services.team()
    if (!team || !agent) return []
    try {
      return team.listMembers(agent).filter((m) => m.role === 'teammate')
    } catch {
      return []
    }
  }

  function tasksOf(agent) {
    const team = services.team()
    if (!team || !agent) return []
    try {
      return team.listTasks(agent)
    } catch {
      return []
    }
  }

  /**
   * 当前会话正在使用的模型（用于 revert 时真正切回）。
   * 优先读 Agent 创建时的 options（刚 spawn、还没发过请求也有值）；
   * 再退回请求上下文（已发生过请求的会话）。
   */
  function currentModelOf(memberId) {
    try {
      const live = services.agents()?.get(String(memberId))
      const opts = live?.options
      if (opts && opts.provider && opts.model) {
        return { provider: opts.provider, model: opts.model }
      }
    } catch {
      // 忽略
    }
    try {
      const session = services.sessions()?.get(String(memberId))
      const ctxInfo = session?.requestContext?.()
      if (ctxInfo && ctxInfo.provider && ctxInfo.model) {
        return { provider: ctxInfo.provider, model: ctxInfo.model }
      }
    } catch {
      // 忽略
    }
    return undefined
  }

  /** 切换某个子会话的模型：优先用 agent.model.select()（平台要求在 step 准备前）。 */
  async function switchMemberModel(mission, agent, name, provider, model) {
    const member = teammatesOf(agent).find((m) => String(m.name) === String(name))
    if (!member) return { ok: false, error: `找不到成员 ${name}` }
    const target = services.agents()?.get(String(member.id))
    if (!target) return { ok: false, error: `成员 ${name} 不在线` }

    // 首次切换前记录原模型，供 mission_set_model(revert) 真正切回
    mission.workerBaseModels = mission.workerBaseModels ?? new Map()
    if (!mission.workerBaseModels.has(String(name))) {
      const base = currentModelOf(member.id)
      if (base) mission.workerBaseModels.set(String(name), base)
    }

    const selection = { provider, model }
    try {
      if (target.model && typeof target.model.select === 'function') {
        await target.model.select(selection)
      } else if (typeof target.selectModel === 'function') {
        await target.selectModel(selection)
      } else {
        return { ok: false, error: '当前平台没有 agent.model.select()，无法为子会话切换模型' }
      }
    } catch (error) {
      return { ok: false, error: errText(error) }
    }

    mission.workerModels = mission.workerModels ?? new Map()
    mission.workerModels.set(String(name), selection)
    return { ok: true, selected: `${provider}/${model}` }
  }

  /** 按任务文本决定该工蜂的模型：命中生图关键词 → imageModel，否则默认模型。 */
  async function applyModelPolicy(mission, agent, name, taskText, explicit) {
    if (config.imageModelSwitch !== true) return { applied: false, reason: 'disabled' }
    const wantsImage = explicit?.image === true
      || (explicit?.image !== false && needsImageModel(taskText, config.imageKeywords))
    if (!wantsImage) return { applied: false, reason: 'default-model' }
    const provider = explicit?.provider || config.imageProvider
    const model = explicit?.model || config.imageModel
    if (!provider || !model) return { applied: false, reason: 'no-image-model-configured' }
    const result = await switchMemberModel(mission, agent, name, provider, model)
    return { applied: result.ok, reason: result.ok ? 'image-model' : result.error, model: result.selected }
  }

  /** 解析图像模型的 API key：DSH 凭据库优先，其次进程环境变量。 */
  async function resolveImageApiKey() {
    const name = String(config.imageApiKeyRef || 'USTC_API_KEY')
    try {
      const credentials = ctx.get('credentials')
      if (credentials && typeof credentials.resolve === 'function') {
        const resolved = await credentials.resolve(name)
        if (resolved && resolved.value) return resolved.value
      }
    } catch {
      // 凭据服务不可用时回退环境变量
    }
    return process.env[name] ?? ''
  }

  /** 调用图像模型生成图片并落盘，返回文件路径。 */
  async function generateImage(agent, options) {
    const prompt = String(options?.prompt ?? '').trim()
    if (!prompt) throw new Error('prompt 不能为空')
    const apiKey = await resolveImageApiKey()
    if (!apiKey) throw new Error(`未找到图像模型凭据（${config.imageApiKeyRef}）`)

    const base = String(config.imageApiBaseUrl || '').replace(/\/+$/, '')
    const size = String(options?.size || config.imageApiSize || '1024x1024')
    const response = await fetch(`${base}/images/generations`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: String(options?.model || config.imageModel),
        prompt,
        n: 1,
        size,
        response_format: 'b64_json',
      }),
    })
    if (!response.ok) {
      const text = await response.text().catch(() => '')
      throw new Error(`图像接口 ${response.status}: ${text.slice(0, 300)}`)
    }
    const payload = await response.json()
    const b64 = payload?.data?.[0]?.b64_json
    if (!b64) throw new Error('图像接口未返回 b64_json')

    const root = workspaceOf(agent)
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const relative = String(options?.path || `images/${stamp}.png`).replace(/^[\\/]+/, '')
    const target = resolve(root, relative)
    if (!target.startsWith(resolve(root) + sep)) throw new Error('输出路径必须位于工作目录内')
    await mkdir(dirname(target), { recursive: true })
    const bytes = Buffer.from(b64, 'base64')
    await writeFile(target, bytes)
    return { path: target, bytes: bytes.length, model: String(options?.model || config.imageModel) }
  }

  /**
   * 存活成员：会话目录仍在磁盘、且未被归档。
   * 花名册里会长期保留已删除/已归档的历史条目（平台无移除成员 API），
   * 凡是「发消息 / 广播 / 结束归档 / 计数」都必须先过这一层，避免打到死会话。
   */
  async function liveMembers(agent) {
    const all = teammatesOf(agent)
    if (all.length === 0) return []
    const archivedSet = archivedSessionIds()
    const index = await sessionDirIndex()
    return all.filter((m) => {
      const id = String(m.id)
      return index.has(id) && !archivedSet.has(id)
    })
  }

  /** 当前任务实际创建的成员（排除开任务前就已存在的旧工蜂）。 */
  function missionMembers(mission) {
    const agent = services.agents()?.get(mission.sessionId)
    if (!agent) return []
    const baseline = mission.baseline ?? new Set()
    return teammatesOf(agent).filter((m) => !baseline.has(m.name))
  }

  /**
   * 统一口径：任务的「活跃工蜂」。
   * = missionMembers − 已交接（handedOff）− 已退休（retired：归档/删除过的成员）。
   * 所有计数、上限判定、面板显示、广播、哨兵都只认这一份名单，
   * 避免出现 guard / mission_scale / handoff 三套口径不一致。
   */
  function activeMembersOf(mission) {
    if (!mission) return []
    const handedOff = mission.handedOff ?? new Set()
    const retired = mission.retired ?? new Set()
    return missionMembers(mission).filter((m) => {
      const name = String(m.name)
      return !handedOff.has(name) && !retired.has(name)
    })
  }

  /** 把成员标记为「退休」，立即从活跃名单移除（归档/删除/交接时调用）。 */
  function retireMembers(sessionId, names) {
    const mission = missions.get(String(sessionId))
    if (!mission) return
    mission.retired = mission.retired ?? new Set()
    for (const name of names ?? []) {
      if (name) mission.retired.add(String(name))
    }
    persistState()
  }

  /** 当前任务的任务板条目（排除开任务前已有的旧任务）。 */
  function missionTasks(mission) {
    const agent = services.agents()?.get(mission.sessionId)
    if (!agent) return []
    const baseline = mission.baselineTasks ?? new Set()
    return tasksOf(agent).filter((t) => !baseline.has(t.id))
  }

  /**
   * 配平统计：根据任务板上「待认领的子任务」推算应该开几个工蜂。
   * 目标工蜂数 = min(待办子任务数, 人数上限)；缺口 = 目标 - 现有。
   */
  function missionScale(mission) {
    const tasks = missionTasks(mission)
    const open = tasks.filter((t) => t.status === 'pending' || t.status === 'in_progress')
    const unowned = open.filter((t) => !t.ownerName)
    // 活跃工蜂：统一口径（排除已交接 / 已退休），避免出现 4/2 这种越界计数
    const workers = activeMembersOf(mission).length
    const cap = Number(mission.cap) || 1
    const target = Math.min(Math.max(unowned.length, open.length ? 1 : 0), cap)
    const gap = Math.max(0, target - workers)
    return { workers, cap, openTasks: open.length, unownedTasks: unowned.length, target, gap }
  }

  /** 测量一个成员会话的上下文压力（带短时缓存，measure 为 O(surface)）。 */
  function measureMember(member) {
    const id = String(member.id)
    const ttl = Math.max(0, Number(config.measureCacheTtlMs) || 0)
    const hit = measureCache.get(id)
    if (ttl > 0 && hit && Date.now() - hit.at < ttl) return hit.value
    const sessions = services.sessions()
    const meter = services.meter()
    const session = sessions?.get(id)
    if (!session) {
      const empty = { tokens: 0, window: config.fallbackContextWindow, ratio: 0, known: false }
      measureCache.set(id, { at: Date.now(), value: empty })
      return empty
    }
    let tokens = 0
    let window = config.fallbackContextWindow
    let known = false
    try {
      const measurement = meter?.measure(session)
      if (measurement && Number.isFinite(measurement.totalTokens)) {
        tokens = measurement.totalTokens
        known = true
      }
      const header = session.requestContext?.()
      if (header && Number.isFinite(header.contextWindow)) window = header.contextWindow
    } catch {
      // 测量失败：标记 known=false，面板可据此提示"测量失败"而不是显示 0%
    }
    const value = { tokens, window, ratio: window > 0 ? tokens / window : 0, known }
    measureCache.set(id, { at: Date.now(), value })
    return value
  }

  function missionRows(mission) {
    const agent = services.agents()?.get(mission.sessionId)
    if (!agent) return { agent: undefined, rows: [] }
    const tasks = missionTasks(mission)
    const rows = activeMembersOf(mission).map((member) => {
      const usage = measureMember(member)
      const owned = tasks.filter((t) => t.ownerName === member.name && t.status !== 'completed')
      return {
        name: member.name,
        status: member.status,
        tokens: usage.tokens,
        contextWindow: usage.window,
        ratio: Math.round(usage.ratio * 1000) / 1000,
        activeTasks: owned.map((t) => t.subject),
      }
    })
    return { agent, rows }
  }

  /** sessionId -> 工蜂自报的工作概括（current 一行 + completed 多行） */
  const reports = new Map()

  // ── 性能：增量事件聚合 + 测量/快照缓存 ──────────────────────────────────
  /**
   * 每个工蜂会话的增量聚合游标。只处理 lastSeq 之后的新事件，
   * 避免每次快照都从头遍历整段会话历史（历史只增不减，成本会随任务变大）。
   */
  const sessionAgg = new Map()

  /** 把新增事件累加进游标，返回最新聚合值。 */
  function aggregateSession(session, id) {
    let agg = sessionAgg.get(id)
    if (!agg) {
      agg = { lastSeq: 0, turns: 0, toolCalls: 0, files: [], lastAction: '', actualModel: '' }
      sessionAgg.set(id, agg)
    }
    let events
    try {
      events = session.snapshotEvents()
    } catch {
      return agg
    }
    // 会话被 clear/fork/压缩后事件数可能回退：重置游标重算
    if (events.length < agg.lastSeq) {
      agg.lastSeq = 0
      agg.turns = 0
      agg.toolCalls = 0
      agg.files = []
      agg.lastAction = ''
      agg.actualModel = ''
    }
    for (let i = agg.lastSeq; i < events.length; i += 1) {
      const event = events[i]
      if (event.type === 'turn/end') {
        agg.turns += 1
      } else if (event.type === 'tool/call') {
        agg.toolCalls += 1
        const toolName = event.data?.name
        if (toolName === 'write' || toolName === 'edit') {
          try {
            const args = JSON.parse(event.data?.arguments ?? '{}')
            const path = args.file_path ?? args.path
            if (typeof path === 'string' && path && !agg.files.includes(path)) {
              agg.files.push(path)
              if (agg.files.length > 50) agg.files.shift()
            }
          } catch {
            // 参数不是 JSON 就忽略
          }
        }
      } else if (event.type === 'assistant/message') {
        const source = event.data?.message?.source
        if (source && source.provider) agg.actualModel = `${source.provider}/${source.model}`
        const text = blocksToText(event.data?.message?.content)
        if (text) agg.lastAction = text
      }
    }
    agg.lastSeq = events.length
    return agg
  }

  /** 上下文测量缓存：measure 是 O(surface)，短时间内复用同一结果。 */
  const measureCache = new Map()

  /** Dashboard 快照缓存 + single-flight：并发请求共享同一次计算。 */
  let snapshotCache = { at: 0, data: null }
  let snapshotInFlight = null

  function invalidateSnapshot() {
    snapshotCache = { at: 0, data: null }
  }

  async function cachedDashboardSnapshot() {
    const ttl = Math.max(0, Number(config.snapshotCacheTtlMs) || 0)
    if (ttl > 0 && snapshotCache.data && Date.now() - snapshotCache.at < ttl) {
      return snapshotCache.data
    }
    if (snapshotInFlight) return snapshotInFlight
    snapshotInFlight = Promise.resolve()
      .then(() => dashboardSnapshot())
      .then((data) => {
        snapshotCache = { at: Date.now(), data }
        return data
      })
      .finally(() => {
        snapshotInFlight = null
      })
    return snapshotInFlight
  }

  /** 把一段（可能是英文的）动作文本压成一句短概括。 */
  function deriveShort(text) {
    if (!text) return ''
    const flat = String(text)
      .replace(/[`*_#>]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
    const cut = flat.split(/[。．.!?！？;；\n]/).filter(Boolean)[0] ?? flat
    return cut.length > 48 ? `${cut.slice(0, 48)}…` : cut
  }

  /**
   * 从工蜂自己的会话日志推导「工作概括」：状态文字、已完成任务、正在进行的任务、
   * 最近一次动作、产出文件。任务板只记录工蜂主动创建的任务，所以还要读会话日志。
   */
  function workDetail(member, boardTasks) {
    const session = services.sessions()?.get(member.id)
    const owned = (boardTasks ?? []).filter((t) => t.ownerName === member.name)
    const boardCompleted = owned.filter((t) => t.status === 'completed').map((t) => t.subject)
    const boardCurrent = owned.filter((t) => t.status === 'in_progress').map((t) => t.subject)

    // 增量聚合：只处理会话新增事件，不再每次从头遍历整段历史
    let agg = { turns: 0, toolCalls: 0, files: [], lastAction: '', actualModel: '' }
    if (session) {
      try {
        agg = aggregateSession(session, String(member.id))
      } catch {
        // 会话已关闭或日志不可读
      }
    }
    const turns = agg.turns
    const toolCalls = agg.toolCalls
    const lastAction = agg.lastAction
    const actualModel = agg.actualModel
    const files = agg.files

    // 优先用工蜂自己上报的概括，其次任务板标题，最后从会话日志压一句
    const report = reports.get(String(member.id)) ?? {}

    const statusLabel =
      member.status === 'running'
        ? '工作中'
        : member.status === 'provisioning'
          ? '启动中'
          : member.status === 'failed'
            ? '已失败'
            : (report.completed ?? []).length > 0 || boardCompleted.length > 0 || turns > 0
              ? '已完成'
              : '空闲'
    // 有自报记录就以它为准（含显式清空），否则回退到任务板/日志
    const hasReport = reports.has(String(member.id))
    const completedSummary = [
      ...(report.completed ?? []),
      ...boardCompleted,
    ].filter((v, i, arr) => v && arr.indexOf(v) === i)

    const currentSummary = hasReport
      ? report.current
      : (boardCurrent.join('；') ||
        (member.status === 'running' ? deriveShort(lastAction) : ''))

    return {
      statusLabel,
      currentSummary,
      completedSummary,
      lastAction: deriveShort(lastAction),
      actualModel,
      files: files.slice(-5),
      turns,
      toolCalls,
    }
  }

  /** 完整 Dashboard 快照：总体进度 + 各工蜂进度与工作概括，供 HTTP 路由与面板拉取。 */
  function dashboardSnapshot() {
    const out = {
      active: false,
      at: Date.now(),
      missions: [],
    }
    for (const mission of missions.values()) {
      const tasks = missionTasks(mission)
      const count = (status) => tasks.filter((t) => t.status === status).length
      // 主会话名称：标题服务优先，退回会话 id 尾号
      let title = ''
      try {
        const titleService = ctx.get('sessionTitle')
        const session = services.sessions()?.get(mission.sessionId)
        if (titleService && session && typeof titleService.get === 'function') {
          title = titleService.get(session)?.title ?? ''
        }
      } catch {
        // 标题服务不可用时退回 id
      }
      if (!title) title = `会话 ${String(mission.sessionId).slice(-6)}`
      const teammates = activeMembersOf(mission).map((member) => {
        const usage = measureMember(member)
        return {
          name: member.name,
          status: member.status,
          tokens: usage.tokens,
          contextWindow: usage.window,
          ratio: Math.round(usage.ratio * 1000) / 1000,
          model: (() => {
            const entry = mission.workerModels?.get(String(member.name))
            return entry ? `${entry.provider}/${entry.model}` : ''
          })(),
          ...workDetail(member, tasks),
        }
      })
      out.missions.push({
        sessionId: mission.sessionId,
        title,
        task: mission.task,
        taskSet: Boolean(mission.taskAt),
        scale: missionScale(mission),
        cap: mission.cap,
        paused: mission.paused === true,
        startedAt: mission.startedAt,
        teammates,
        board: {
          pending: count('pending'),
          inProgress: count('in_progress'),
          completed: count('completed'),
          total: tasks.length,
        },
        lastHandoff: mission.lastHandoff ?? null,
        lastError: mission.lastError ?? null,
      })
      out.active = true
    }
    return out
  }

  function buildDigest(mission, agent, member) {
    const session = services.sessions()?.get(member.id)
    const tasks = missionTasks(mission)
    const lines = [
      `# 交接摘要（${member.name} 的续任者）`,
      '',
      '## 任务目标',
      mission.task,
      '',
      '## 任务板现状',
      tasks.length === 0
        ? '（任务板为空）'
        : tasks
            .map((t) => `- [${t.status}] ${t.subject}${t.ownerName ? ` @${t.ownerName}` : ''}`)
            .join('\n'),
    ]
    const recent = session ? recentAssistantText(session, 4) : []
    if (recent.length > 0) {
      lines.push('', '## 前任最近的进展记录')
      recent.forEach((text, index) => {
        lines.push(`### 片段 ${index + 1}`, text.slice(0, 2000))
      })
    }
    lines.push(
      '',
      '## 你的职责',
      '你接手一位因上下文过长而被接管的同伴的工作。先读任务板，认领属于原同伴的未完成任务，',
      '继续保持与其他同伴的协作，完成后把任务标记为 completed。不要重复已经完成的部分。',
    )
    return lines.join('\n')
  }

  async function handoff(mission, agent, member) {
    const name = String(member.name)
    // 续任者形如 <root>-r1 / <root>-r1-r1：按链根去重，避免"换名字就绕过"
    const root = name.replace(/(?:-r\d+)+$/, '')
    // 同一成员只交接一次：已交接过、或正在交接，直接跳过
    if (mission.handoffInFlight.has(name)) return
    if (mission.handedOff?.has(name)) return
    mission.handoffInFlight.add(name)
    try {
      const team = services.team()
      // 整条链的代数上限：防止阈值配置异常/续任者立刻超线导致无限 spawn
      const chainRounds = mission.handoffChainRounds?.get(root) ?? 0
      const maxRounds = Number(config.maxHandoffRounds) || 0
      if (maxRounds > 0 && chainRounds >= maxRounds) {
        mission.lastError = `交接被跳过：${root} 的交接链已达上限 ${maxRounds} 代`
        mission.handedOff?.add(name)
        return
      }
      // 交接是「替换」：退休的旧成员会被标记 handedOff、归档并移出活跃名单。
      // 因此按统一口径的「活跃工蜂数」判定，满员任务同样可以交接。
      if (activeMembersOf(mission).length > mission.cap) {
        mission.lastError = `交接被跳过：活跃工蜂已超过上限 ${mission.cap}`
        mission.handedOff?.add(name)
        return
      }
      const digest = buildDigest(mission, agent, member)
      try {
        team.interrupt(agent, name)
      } catch {
        // 可能已经处于 inactive，忽略
      }
      const round = (mission.handoffRounds.get(name) ?? 0) + 1
      mission.handoffRounds.set(name, round)
      await team.spawnTeammate(agent, {
        name: `${name}-r${round}`,
        description: `接替 ${name}（上下文交接）`,
        prompt: [textBlock(digest)],
        context: 'fresh',
        provider: config.freshProvider,
        signal: new AbortController().signal,
      })
      // 标记已交接：哨兵与广播都不再把它当作可继续工作的成员
      mission.handedOff?.add(name)
      // 退休旧成员：归档它，使它真正让出活跃名额（失败不影响交接结果）
      try {
        const registry = ctx.get('workspaceRegistry')
        if (registry && typeof registry.archiveSession === 'function') {
          await registry.archiveSession(member.id, { stopActivity: true })
          archivedCache = { at: 0, ids: new Set() }
        }
      } catch {
        // 归档失败时，handedOff 标记仍然使哨兵/广播跳过它
      }
      // 记录整条链的代数（按链根计），用于 maxHandoffRounds 上限
      mission.handoffChainRounds = mission.handoffChainRounds ?? new Map()
      mission.handoffChainRounds.set(root, chainRounds + 1)
      mission.lastHandoff = { from: name, to: `${name}-r${round}`, at: Date.now() }
    } catch (error) {
      mission.lastError = errText(error)
      // 失败也标记，避免每 15 秒重复重试造成风暴
      mission.handedOff?.add(name)
    } finally {
      mission.handoffInFlight.delete(name)
      persistState()
    }
  }

  function broadcast(mission, text) {
    // 暂停：子会话继续工作，但主会话的话不再下发给子会话
    if (mission.paused) return 0
    const agent = services.agents()?.get(mission.sessionId)
    const team = services.team()
    if (!agent || !team) return 0
    // 只发给活跃工蜂：已交接 / 已退休 / 已删除 的成员一律不接收广播
    const members = activeMembersOf(mission)
    if (members.length === 0) return 0
    const signal = new AbortController().signal
    let sent = 0
    // 再按磁盘存活过滤：花名册里的已删除/已归档条目不再接收广播
    void liveMembers(agent).then((live) => {
      const liveNames = new Set(live.map((m) => m.name))
      for (const member of members) {
        if (!liveNames.has(member.name)) continue
        try {
          team
            .sendMessage(agent, {
              target: member.name,
              content: [textBlock(`[驾驶舱广播] ${text}`)],
              signal,
            })
            .catch(() => {})
          sent += 1
        } catch {
          // 单个成员失败不影响其他成员
        }
      }
      mission.relayed = (mission.relayed ?? 0) + 1
    })
    return sent
  }

  // ── 工具注册 ────────────────────────────────────────────────────────────────
  ctx.tools.register({
    name: 'mission_start',
    description:
      'Declare a mission on this Team Lead session: records the task and the teammate cap for it. ' +
      'Call it once before spawning teammates. Teammates beyond `workers` are refused, and the mission ' +
      'sentinel starts watching every teammate context.',
    parameters: {
      type: 'object',
      properties: {
        task: {
          type: 'string',
          description: 'The mission goal the whole team must finish, self-contained.',
        },
        workers: {
          type: 'integer',
          description: 'Maximum number of concurrently running teammates for this mission.',
        },
      },
      required: ['task', 'workers'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          workers: { type: 'integer' },
          warnRatio: { type: 'number' },
          handoffRatio: { type: 'number' },
        },
        required: ['ok', 'workers', 'warnRatio', 'handoffRatio'],
      },
      render: (_args, value) => [
        textBlock(
          `Mission started. Cap ${value.workers}; warn at ${Math.round(value.warnRatio * 100)}%, ` +
            `auto-handoff at ${Math.round(value.handoffRatio * 100)}%.`,
        ),
      ],
    },
    execute(args, exec) {
      const agent = exec.agent
      if (!agent) throw new Error('mission_start requires an owning agent session')
      const key = String(agent.id)
      const existing = missions.get(key)
      if (existing) {
        // 重复声明 = 更新任务与上限；保留基线、暂停态与交接记录
        existing.task = String(args.task)
        existing.taskAt = Date.now()
        existing.cap = Number(args.workers)
        existing.paused = false
      } else {
        missions.set(key, {
          sessionId: key,
          task: String(args.task),
          taskAt: Date.now(),
          cap: Number(args.workers),
          startedAt: Date.now(),
          paused: false,
          baseline: new Set(teammatesOf(agent).map((m) => m.name)),
          baselineTasks: new Set(tasksOf(agent).map((t) => t.id)),
          handoffInFlight: new Set(),
          handoffRounds: new Map(),
          handedOff: new Set(),
        })
      }
      persistState()
      return Promise.resolve({
        ok: true,
        workers: Number(args.workers),
        warnRatio: config.warnRatio,
        handoffRatio: config.handoffRatio,
      })
    },
    presentCall: (args) => ({
      card: 'generic',
      title: `Start mission (${args.workers} workers)`,
      kind: 'other',
      rawInput: args,
    }),
  })

  ctx.tools.register({
    name: 'mission_scale',
    description:
      'Spawn only the MISSING teammates needed for this mission, up to the worker cap. ' +
      'Pass the workers you decided the task needs; already-existing ones are skipped, and workers ' +
      'beyond the cap are refused. Use this instead of spawning one by one when rebalancing.',
    parameters: {
      type: 'object',
      properties: {
        workers: {
          type: 'array',
          description: 'Desired teammates: name + a self-contained task prompt for each.',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              name: {
                type: 'string',
                description: 'Unique lower-kebab-case teammate name.',
              },
              task: {
                type: 'string',
                description: 'Complete self-contained sub-task: goal, acceptance, output location.',
              },
              image: {
                type: 'boolean',
                description:
                  'Set true when this sub-task must GENERATE images; the worker then switches to the ' +
                  'configured image model. Omit to let keyword detection decide, false to force the default model.',
              },
              provider: {
                type: 'string',
                description: 'Optional model provider override for this worker (only with an image task).',
              },
              model: {
                type: 'string',
                description: 'Optional model override for this worker (only with an image task).',
              },
            },
            required: ['name', 'task'],
          },
        },
      },
      required: ['workers'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          spawned: { type: 'array', items: { type: 'string' } },
          skipped: { type: 'array', items: { type: 'string' } },
          refused: { type: 'array', items: { type: 'string' } },
          modelSwitches: { type: 'array', items: { type: 'string' } },
          modelErrors: { type: 'array', items: { type: 'string' } },
          workers: { type: 'integer' },
          cap: { type: 'integer' },
        },
        required: ['spawned', 'skipped', 'refused', 'modelSwitches', 'modelErrors', 'workers', 'cap'],
      },
      render: (_args, value) => [
        textBlock(
          `Spawned ${value.spawned.length}${value.skipped.length ? `, skipped ${value.skipped.length}` : ''}` +
            `${value.refused.length ? `, refused ${value.refused.length} (cap ${value.cap})` : ''}. ` +
            `Now ${value.workers}/${value.cap} teammates.` +
            (value.modelSwitches.length ? ` Image model switched: ${value.modelSwitches.join(', ')}.` : '') +
            (value.modelErrors.length ? ` Model switch failed: ${value.modelErrors.join('; ')}.` : ''),
        ),
      ],
    },
    async execute(args, exec) {
      const agent = exec.agent
      if (!agent) throw new Error('mission_scale requires an owning agent session')
      const mission = missions.get(String(agent.id))
      if (!mission) throw new Error('没有进行中的蜂巢任务，请先调用 mission_start')
      const team = services.team()
      if (!team) throw new Error('Agent Teams 服务不可用')

      // 统一口径：只有活跃工蜂算"已存在"与占名额
      const existing = new Set(activeMembersOf(mission).map((m) => m.name))
      const spawned = []
      const skipped = []
      const refused = []
      const modelSwitches = []
      const modelErrors = []
      // 花名册里所有用过的名字（含已删除/已归档）都不能复用，冲突时自动加后缀
      const rosterNames = new Set(teammatesOf(agent).map((m) => String(m.name)))
      const uniqueName = (base) => {
        if (!rosterNames.has(base)) return base
        for (let i = 2; i <= 50; i += 1) {
          const candidate = `${base}-${i}`
          if (!rosterNames.has(candidate)) return candidate
        }
        return undefined
      }
      const signal = new AbortController().signal
      const requested = Array.isArray(args.workers) ? args.workers : []

      for (const item of requested) {
        const rawName = String(item?.name ?? '').trim()
        const task = String(item?.task ?? '').trim()
        if (!rawName || !task) {
          refused.push(rawName || '(empty)')
          continue
        }
        if (existing.has(rawName)) {
          skipped.push(rawName)
          continue
        }
        // 名额按活跃工蜂计：已交接 / 已退休的成员不再占用名额
        if (activeMembersOf(mission).length >= mission.cap) {
          refused.push(rawName)
          continue
        }
        const name = uniqueName(rawName)
        if (!name) {
          refused.push(rawName)
          continue
        }
        try {
          await team.spawnTeammate(agent, {
            name,
            description: task.slice(0, 60),
            prompt: [textBlock(task)],
            context: 'fresh',
            provider: config.freshProvider,
            signal,
          })
          existing.add(name)
          rosterNames.add(name)
          spawned.push(name)
          // 生图任务 → 切换到图像模型；其余保持默认模型
          const policy = await applyModelPolicy(mission, agent, name, task, {
            image: item?.image,
            provider: item?.provider,
            model: item?.model,
          })
          if (policy.applied && policy.model) modelSwitches.push(`${name}→${policy.model}`)
          else if (!policy.applied && policy.reason && policy.reason !== 'default-model' && policy.reason !== 'disabled') {
            modelErrors.push(`${name}: ${policy.reason}`)
          }
        } catch (error) {
          mission.lastError = `spawn ${name} failed: ${errText(error)}`
          refused.push(rawName)
        }
      }

      persistState()
      return {
        spawned,
        skipped,
        refused,
        modelSwitches,
        modelErrors,
        workers: activeMembersOf(mission).length,
        cap: mission.cap,
      }
    },
    presentCall: (args) => ({
      card: 'generic',
      title: `Scale workers (${Array.isArray(args?.workers) ? args.workers.length : 0})`,
      kind: 'other',
      rawInput: args,
    }),
  })

  ctx.tools.register({
    name: 'mission_set_model',
    description:
      'Switch one existing teammate to another model (for example the image model) after it was spawned. ' +
      'Use it when a worker turns out to need image generation, or to move a worker back to the default model.',
    parameters: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Existing teammate name.',
        },
        provider: {
          type: 'string',
          description: 'Model provider id, e.g. "ustc". Omit to use the configured image provider.',
        },
        model: {
          type: 'string',
          description: 'Model id, e.g. "qwen-image-2.1". Omit to use the configured image model.',
        },
        revert: {
          type: 'boolean',
          description: 'Set true to switch this worker back to the session default model.',
        },
      },
      required: ['name'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          model: { type: 'string' },
          error: { type: 'string' },
        },
        required: ['ok'],
      },
      render: (_args, value) =>
        [textBlock(value.ok ? `Model now ${value.model}.` : `Model switch failed: ${value.error ?? 'unknown'}`)],
    },
    async execute(args, exec) {
      const agent = exec.agent
      if (!agent) throw new Error('mission_set_model requires an owning agent session')
      const mission = missions.get(String(agent.id))
      if (!mission) throw new Error('没有进行中的蜂巢任务，请先调用 mission_start')
      if (args.revert === true) {
        const name = String(args.name)
        const base = mission.workerBaseModels?.get(name)
        if (base) {
          // 真正切回原模型，而不只是删掉记录
          const result = await switchMemberModel(mission, agent, name, base.provider, base.model)
          if (!result.ok) return { ok: false, error: result.error }
          mission.workerBaseModels.delete(name)
          mission.workerModels?.delete(name)
          return { ok: true, model: result.selected }
        }
        // 没有记录原模型：无法保证切回，明确报错而不是假装成功
        mission.workerModels?.delete(name)
        return { ok: false, error: '没有记录该成员的原始模型，无法安全回退（可显式指定 provider/model 切回）' }
      }
      const provider = String(args.provider ?? config.imageProvider ?? '').trim()
      const model = String(args.model ?? config.imageModel ?? '').trim()
      if (!provider || !model) return { ok: false, error: '未配置图像模型（provider/model）' }
      const result = await switchMemberModel(mission, agent, args.name, provider, model)
      return result.ok
        ? { ok: true, model: result.selected }
        : { ok: false, error: result.error }
    },
    presentCall: (args) => ({
      card: 'generic',
      title: `Switch model: ${args?.name ?? ''}`,
      kind: 'other',
      rawInput: args,
    }),
  })

  ctx.tools.register({
    name: 'mission_image',
    description:
      'Generate an image with the configured image model (' +
      String(DEFAULT_CONFIG.imageModel) +
      ') and save it into the workspace. Use this instead of switching your own chat model: image models ' +
      'cannot serve normal conversation requests.',
    parameters: {
      type: 'object',
      properties: {
        prompt: {
          type: 'string',
          description: 'Detailed image description (subject, style, colors, composition).',
        },
        path: {
          type: 'string',
          description: 'Output path relative to the workspace, e.g. "images/cover.png". Defaults to a timestamped PNG.',
        },
        size: {
          type: 'string',
          description: 'Requested size, e.g. "1024x1024". Defaults to the plugin config.',
        },
        model: {
          type: 'string',
          description: 'Optional image model override. Defaults to the configured image model.',
        },
      },
      required: ['prompt'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string' },
          bytes: { type: 'integer' },
          model: { type: 'string' },
        },
        required: ['path', 'bytes', 'model'],
      },
      render: (_args, value) => [textBlock(`Image saved: ${value.path} (${value.bytes} bytes, ${value.model})`)],
    },
    async execute(args, exec) {
      const result = await generateImage(exec.agent, args)
      return result
    },
    presentCall: (args) => ({
      card: 'generic',
      title: 'Generate image',
      kind: 'other',
      rawInput: args,
    }),
  })

  ctx.tools.register({
    name: 'mission_report',
    description:
      'Report your OWN work summary to the mission dashboard, in one short human sentence each. ' +
      'Call it when you start a piece of work and when you finish one, so the cockpit shows what you are ' +
      'doing in plain language instead of raw logs. Keep each line under 30 characters.',
    parameters: {
      type: 'object',
      properties: {
        current: {
          type: 'string',
          description: 'What you are working on right now, e.g. "优化界面显示". Empty string clears it.',
        },
        completed: {
          type: 'string',
          description: 'One thing you just finished, e.g. "构建协作插件框架". Omit when nothing new.',
        },
      },
      required: [],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { ok: { type: 'boolean' } },
        required: ['ok'],
      },
      render: () => [textBlock('Work summary recorded.')],
    },
    execute(args, exec) {
      const agent = exec.agent
      if (!agent) throw new Error('mission_report requires an owning agent session')
      const key = String(agent.id)
      const prev = reports.get(key) ?? { current: '', completed: [] }
      const next = {
        current: typeof args.current === 'string' ? args.current.trim() : prev.current,
        completed: [...prev.completed],
      }
      if (typeof args.completed === 'string' && args.completed.trim()) {
        const line = args.completed.trim()
        if (!next.completed.includes(line)) next.completed.push(line)
        if (next.completed.length > 8) next.completed = next.completed.slice(-8)
      }
      reports.set(key, next)
      // 汇报内容变化后让面板快照即时刷新
      invalidateSnapshot()
      return Promise.resolve({ ok: true })
    },
    presentCall: (args) => ({
      card: 'generic',
      title: 'Report work summary',
      kind: 'other',
      rawInput: args,
    }),
  })

  ctx.tools.register({
    name: 'mission_status',
    description:
      'Read live mission progress: every teammate with its run state, context tokens as a share of the ' +
      'context window, and the tasks it currently owns. Measurement costs no model tokens.',
    parameters: { type: 'object', properties: {} },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          active: { type: 'boolean' },
          task: { type: 'string' },
          cap: { type: 'integer' },
          teammates: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                name: { type: 'string' },
                status: { type: 'string' },
                tokens: { type: 'integer' },
                contextWindow: { type: 'integer' },
                ratio: { type: 'number' },
                activeTasks: {
                  type: 'array',
                  items: { type: 'string' },
                },
              },
              required: ['name', 'status', 'tokens', 'contextWindow', 'ratio', 'activeTasks'],
            },
          },
          lastHandoff: { type: 'object' },
          lastError: { type: 'string' },
        },
        required: ['active', 'teammates'],
      },
      render: (_args, value) => {
        if (!value.active) return [textBlock('No mission declared on this session.')]
        const rows = value.teammates
          .map(
            (m) =>
              `- ${m.name} [${m.status}] ${m.tokens}/${m.contextWindow} tokens (${Math.round(
                m.ratio * 100,
              )}%)${m.activeTasks.length ? ` — ${m.activeTasks.join('; ')}` : ''}`,
          )
          .join('\n')
        return [textBlock(`Mission: ${value.task}\nCap: ${value.cap}\n${rows || '(no teammates yet)'}`)]
      },
    },
    execute(_args, exec) {
      const agent = exec.agent
      if (!agent) throw new Error('mission_status requires an owning agent session')
      const mission = missions.get(String(agent.id))
      if (!mission) {
        return Promise.resolve({ active: false, teammates: [] })
      }
      const { rows } = missionRows(mission)
      const result = {
        active: true,
        task: mission.task,
        cap: mission.cap,
        teammates: rows,
      }
      if (mission.lastHandoff) result.lastHandoff = mission.lastHandoff
      if (mission.lastError) result.lastError = mission.lastError
      return Promise.resolve(result)
    },
    presentCall: () => ({ card: 'generic', title: 'Mission status', kind: 'other' }),
  })

  ctx.tools.register({
    name: 'mission_stop',
    description:
      'End the mission on this session: stop every active teammate, archive their sessions, clean up ' +
      'temporary files, then clear the mission state. Use it instead of silently dropping the mission, ' +
      'so no worker is left running and the dashboard disappears consistently.',
    parameters: { type: 'object', properties: {} },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          interrupted: { type: 'array', items: { type: 'string' } },
          archived: { type: 'array', items: { type: 'string' } },
          removedTempFiles: { type: 'integer' },
          retiredWorkers: { type: 'integer' },
        },
        required: ['ok', 'interrupted', 'archived', 'removedTempFiles', 'retiredWorkers'],
      },
      render: (_args, value) => [
        textBlock(
          `Mission ended. Stopped ${value.interrupted.length} teammate(s), archived ` +
            `${value.archived.length}, cleaned ${value.removedTempFiles} temp file(s).`,
        ),
      ],
    },
    async execute(_args, exec) {
      const agent = exec.agent
      if (!agent) throw new Error('mission_stop requires an owning agent session')
      const sessionId = String(agent.id)
      const mission = missions.get(sessionId)
      if (!mission) {
        hiveOffNotice.add(sessionId)
        return { ok: true, interrupted: [], archived: [], removedTempFiles: 0, retiredWorkers: 0 }
      }

      const team = services.team()
      const active = activeMembersOf(mission)
      const interrupted = []
      for (const member of active) {
        if (member.status !== 'running' && member.status !== 'provisioning') continue
        try {
          team?.interrupt(agent, member.name)
          interrupted.push(member.name)
        } catch {
          // 成员可能已结束
        }
      }

      // 归档活跃成员的会话，避免留下"仍在跑但无人监控"的孤儿
      const closing = active.map((m) => ({ id: m.id, name: m.name }))
      const closed = await closeChildSessions(closing)
      const cleanup = await cleanupTempFiles(workspaceOf(agent))
      retireMembers(sessionId, active.map((m) => m.name))

      missions.delete(sessionId)
      hiveOffNotice.add(sessionId)
      persistState()

      return {
        ok: true,
        interrupted,
        archived: closed.archived,
        removedTempFiles: (cleanup.deleted ?? []).length,
        retiredWorkers: active.length,
      }
    },
    presentCall: () => ({ card: 'generic', title: 'Stop mission', kind: 'other' }),
  })

  // ── 委派守卫：蜂巢模式未开启时禁止开子会话 + 人数上限 ────────────────────
  ctx.tools.guard((exec) => {
    const agent = exec.agent
    if (!agent) return undefined
    const sessionId = String(agent.id)
    const mission = missions.get(sessionId)
    const hiveOn = Boolean(mission && mission.paused !== true)

    // 1) 团队工蜂：只有在蜂巢模式开启时才允许创建
    if (exec.name === 'spawn_teammate') {
      if (config.requireHiveModeForSpawns !== false && !hiveOn) {
        return 'mission-control: 蜂巢模式未开启，禁止创建子会话。请先在会话标题栏打开蜂巢开关。'
      }
      if (!mission) return undefined
      // 与 mission_scale / 面板同一口径：活跃工蜂（排除已交接/已退休）占名额
      const active = activeMembersOf(mission)
      if (active.length >= mission.cap) {
        return `mission-control: 本次任务的上限是 ${mission.cap} 个并发工蜂，已满，拒绝再创建`
      }
      return undefined
    }

    // 2) 平台内置委派（subagent / subagent_fork / workflow）：同样只在蜂巢模式开启时允许
    if (config.blockDelegationOutsideHive === true
      && (exec.name === 'subagent' || exec.name === 'subagent_fork' || exec.name === 'workflow')
      && !hiveOn) {
      return 'mission-control: 蜂巢模式未开启，禁止开子会话。如需并行工作，请先打开蜂巢开关。'
    }

    return undefined
  })

  // ── 驾驶舱中继：人类发话立即扇出；并捕获本次任务的真实目标 ──────────────
  ctx.on('session/event', (session, event) => {
    if (event.type !== 'user/message') return
    const mission = missions.get(String(session.id))
    if (!mission) return
    const message = event.data
    const source = message?.source
    if (source && source.kind !== 'user') return
    const text = blocksToText(message?.content)
    if (!text) return

    // 蜂巢模式且未暂停：第一条真实任务描述写入 mission.task，作为拆解与配平依据
    if (!mission.paused && !mission.taskAt && !text.startsWith('【蜂巢任务已结束】')) {
      mission.task = text.slice(0, 1000)
      mission.taskAt = Date.now()
    }

    broadcast(mission, text)
  })

  // ── 提示词：蜂巢模式的分派契约 + 工蜂汇报 ──────────────────────────────
  {
    const sysPrompt = ctx.get('systemPrompt')
    const scopeAgent = () => {
      try {
        return ctx.get('agents')?.currentInitiator?.()
      } catch {
        return undefined
      }
    }
    /** 会话当前是否真的处于"蜂巢模式开启"状态（on 才算）。 */
    const hiveActiveFor = (sessionId) => {
      const mission = missions.get(String(sessionId))
      return Boolean(mission && mission.paused !== true)
    }
    if (sysPrompt && typeof sysPrompt.section === 'function') {
      try {
        sysPrompt.section({
          name: 'mission-control:hive',
          order: 945,
          text: () => {
            const agent = scopeAgent()
            const sessionId = agent ? String(agent.id) : ''
            const mission = agent ? missions.get(sessionId) : undefined

            // 会话没有蜂巢任务：只对历史 teammate 会话给一点协作提示；其余一律不注入
            if (!mission) {
              const team = services.team()
              let role
              try {
                role = agent ? team?.membership?.(agent)?.role : undefined
              } catch {
                role = undefined
              }
              if (role !== 'teammate') {
                // 曾经是蜂巢帧、现在已回到普通模式：明确纠正历史里的旧指令
                if (sessionId && hiveOffNotice.has(sessionId)) {
                  return [
                    '## 蜂巢模式已关闭（当前为普通会话）',
                    '之前的蜂巢任务已经结束/暂停。**不要**再创建或分派子会话，也不要调用 `mission_*` 工具；',
                    '按普通对话直接完成用户的新请求即可。',
                  ].join('\n')
                }
                return ''
              }
              return [
                '## 蜂巢任务：你是子会话',
                '你只负责完成分配给自己的子任务；需要协作时用 `send_message`，',
                '并在「开始做一件事」和「做完一件事」时调用 `mission_report`：',
                '- `current`：你此刻在做的事，一句短中文（≤30 字），例如「优化界面显示」。',
                '- `completed`：你刚完成的事，一句短中文，例如「构建协作插件框架」。',
                '',
                '**需要生成图片时**：不要切换自己的对话模型（图像模型不能用于对话），',
                '直接调用 `mission_image` 工具出图并保存到工作区。',
              ].join('\n')
            }

            // 模式被关闭（暂停）：明确告知按普通会话处理，不注入任何分派契约
            if (mission.paused === true) {
              hiveOffNotice.add(sessionId)
              return [
                '## 蜂巢模式已关闭（当前为普通会话）',
                '本次蜂巢任务处于暂停/关闭状态：子会话继续工作，但你**不要再分派新任务**，',
                '也不用再调用 `mission_*` 工具。按普通对话处理用户的新请求即可。',
              ].join('\n')
            }

            // 模式开启：清除"已关闭"标记，注入分派契约
            hiveOffNotice.delete(sessionId)
            const stats = missionScale(mission)
            if (stats.gap > 0 && mission.taskAt) {
              // 已收到任务但工蜂不足：催办补开
              return [
                '## 蜂巢任务：必须补开子会话',
                `你已收到任务，但当前只有 ${stats.workers} 个子会话，按拆解结果需要 ${stats.target} 个（上限 ${stats.cap}）。`,
                `**现在必须再开 ${stats.gap} 个子会话**（调用 \`mission_scale\`，或逐个 \`spawn_teammate\`），`,
                '然后才继续协调。不要自己把剩余工作做完。',
              ].join('\n')
            }

            return [
              '## 蜂巢任务：你是主会话（Lead）',
              `当前人数上限：${stats.cap}；现有子会话：${stats.workers}；任务板待办：${stats.openTasks}。`,
              '',
              '收到任务后按以下顺序执行，**不得跳过**：',
              '1. 调用 `mission_start(task, workers)` 记录本次任务目标与人数上限；',
              '2. 把任务拆解成**若干独立子任务**，用 `team_task_create` 逐个建到共享任务板；',
              '3. 计算需要几个子会话：**目标 = min(子任务数, 人数上限)**，不超过上限；',
              '4. 用 `mission_scale` 一次性开出差额子会话（已有不足时它只补差额）；',
              '   每个子会话都必须拿到自包含的提示：具体子任务、验收标准、产出位置；',
              '5. **你自己只做协调、验收与汇总**，不要把主任务自己做掉；',
              '6. 子任务完成、任务板全部 completed 后，再输出最终汇总。',
              '',
              '判定规则：',
              '- 还没有任何子会话 → 拆解后开 min(子任务数, 上限) 个；',
              '- 已有子会话但少于目标 → **只补开差额**，不要重复开；',
              '- 子会话汇报完成 → 用 `mission_report` 之外的方式验收文件/结果。',
              '',
              '注意：团队花名册可能残留**已归档/已删除的历史条目**（平台无法移除成员），',
              '它们不算本次任务的工蜂。只以 `mission_scale` 返回的、以及面板中显示的活跃工蜂为准；',
              '不要给历史失效成员发消息。名字冲突时 `mission_scale` 会自动加后缀，以返回的名单为准。',
            ].join('\n')
          },
        })
      } catch {
        // 该 profile 没有 systemPrompt 服务时静默跳过
      }
    }
  }

  // ── 实时监控 HTTP 端点：供 Web 面板轮询，零模型 token ────────────────────
  if (ctx.webServer && typeof ctx.webServer.register === 'function') {
    ctx.effect(() => {
      let dispose
      try {
        dispose = ctx.webServer.register({
          kind: 'exact',
          path: '/mission-dashboard-v2.json',
          resource: async () =>
            new Response(JSON.stringify(await cachedDashboardSnapshot()), {
              status: 200,
              headers: { 'content-type': 'application/json; charset=utf-8' },
            }),
        })
      } catch {
        // 旧 fiber 残留的同名路由：不阻塞本次激活
        return () => {}
      }
      return () => {
        try {
          dispose()
        } catch {
          // 已随旧 fiber 注销
        }
      }
    })
  }

  /** 会话是否真实存在：live agent 或磁盘上仍有会话日志目录。 */
  async function sessionExists(sessionId) {
    if (!sessionId) return false
    try {
      if (services.agents()?.get(String(sessionId))) return true
    } catch {
      // 忽略
    }
    try {
      const index = await sessionDirIndex()
      return index.has(String(sessionId).replace(/^session-/, ''))
    } catch {
      return false
    }
  }

  /**
   * 开关蜂巢模式：开启=进入蜂巢模式（必要时建任务），关闭=暂停。
   * 暂停时子会话继续工作，但主会话消息不再下发给子会话。
   */
  async function setMissionMode(sessionId, options = {}) {
    if (!sessionId) return { ok: false, error: 'missing-session' }
    // 严格布尔：只接受 true / 'true'，其余（含字符串 "false"）都视为关闭
    const enabled = options.enabled === true || options.enabled === 'true'
    const workers = Number.isFinite(Number(options.workers))
      ? Math.min(10, Math.max(2, Math.floor(Number(options.workers))))
      : undefined
    // 会话必须真实存在（live 或磁盘上仍有日志），否则会产生"幽灵任务"
    if (enabled && !(await sessionExists(sessionId))) {
      return { ok: false, error: 'session-not-found' }
    }
    const existing = missions.get(sessionId)

    // 只改人数上限：不动启停状态，也不创建/删除任务
    if (options.workersOnly === true) {
      if (existing && workers !== undefined) {
        existing.cap = workers
        persistState()
      }
      return {
        ok: true,
        sessionId,
        enabled: existing ? existing.paused !== true : false,
        paused: existing ? existing.paused === true : false,
        cap: existing ? existing.cap : (workers ?? (Number(config.defaultCap) || 3)),
        active: Boolean(existing),
      }
    }

    if (enabled) {
      hiveOffNotice.delete(sessionId)
      if (existing) {
        existing.paused = false
        if (workers !== undefined) existing.cap = workers
      } else {
        const agent = services.agents()?.get(sessionId)
        missions.set(sessionId, {
          sessionId,
          task: '（等待任务：主会话中说明目标后由 Lead 分配）',
          cap: workers ?? (Number(config.defaultCap) || 3),
          startedAt: Date.now(),
          paused: false,
          baseline: new Set(agent ? teammatesOf(agent).map((m) => m.name) : []),
          baselineTasks: new Set(agent ? tasksOf(agent).map((t) => t.id) : []),
          handoffInFlight: new Set(),
          handoffRounds: new Map(),
          handedOff: new Set(),
        })
      }
    } else if (existing) {
      existing.paused = true
      if (workers !== undefined) existing.cap = workers
      // 关闭模式：标记该会话，让系统提示补一条"回到普通会话"的纠正指令
      hiveOffNotice.add(sessionId)
    } else {
      // 没有任务但用户特意关掉开关：同样保证后续按普通会话处理
      hiveOffNotice.add(sessionId)
    }

    const mission = missions.get(sessionId)
    persistState()
    return {
      ok: true,
      sessionId,
      enabled: mission ? mission.paused !== true : false,
      paused: mission ? mission.paused === true : false,
      cap: mission ? mission.cap : (workers ?? (Number(config.defaultCap) || 3)),
      active: Boolean(mission),
    }
  }

  // ── 结束任务：停掉所有子会话 + 保留结果 + 删除临时文件 ──────────────────
  /** 工作目录：优先取该任务 Lead 会话的目录，退回默认工作目录。 */
  function workspaceOf(agent) {
    try {
      const wd = ctx.get('workingDirectory')
      if (!wd) return process.cwd()
      if (agent) {
        const session = services.sessions()?.get(String(agent.id))
        if (session && typeof wd.get === 'function') {
          const dir = wd.get(session)
          if (typeof dir === 'string' && dir) return dir
        }
      }
      if (typeof wd.defaultDirectory === 'string' && wd.defaultDirectory) return wd.defaultDirectory
    } catch {
      // 落到进程工作目录
    }
    return process.cwd()
  }

  /** 删除工作目录下的临时文件/临时目录；匹配之外的文件一律不动。 */
  async function cleanupTempFiles(root) {
    const patterns = (Array.isArray(config.cleanupGlobs) ? config.cleanupGlobs : []).map(globToRegExp)
    const dirs = Array.isArray(config.cleanupDirs) ? config.cleanupDirs : []
    const maxFiles = Number(config.cleanupMaxFiles) || 500
    const deleted = []
    const errors = []
    const base = resolve(root)
    const insideBase = (p) => p === base || p.startsWith(base + sep)

    // 1) 整目录删除（仅配置的临时目录）
    for (const rel of dirs) {
      const target = resolve(base, rel)
      if (!insideBase(target) || target === base) continue
      try {
        await rm(target, { recursive: true, force: true })
        deleted.push(target)
      } catch (error) {
        errors.push(`${target}: ${errText(error)}`)
      }
    }

    // 2) 递归删除匹配模式的文件（跳过 node_modules / .git，防止误伤）
    const skipDirs = new Set(['node_modules', '.git'])
    const tempDirs = new Set(dirs.map((rel) => resolve(base, rel)))
    let visited = 0
    const walk = async (dir) => {
      if (deleted.length >= maxFiles) return
      let entries
      try {
        entries = await readdir(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const entry of entries) {
        if (deleted.length >= maxFiles) return
        const full = join(dir, entry.name)
        if (!insideBase(resolve(full))) continue
        if (entry.isDirectory()) {
          if (skipDirs.has(entry.name) || tempDirs.has(resolve(full))) continue
          visited += 1
          if (visited > 20000) return
          await walk(full)
          continue
        }
        if (!entry.isFile()) continue
        if (!patterns.some((re) => re.test(entry.name))) continue
        try {
          await unlink(full)
          deleted.push(full)
        } catch (error) {
          errors.push(`${full}: ${errText(error)}`)
        }
      }
    }
    await walk(base)
    return { root: base, deleted, errors }
  }

  /** 从任意 JSON 结构里递归取出疑似文件路径的字符串。 */
  function collectPathValues(value, sink, depth = 0) {
    if (depth > 4 || value == null) return
    if (typeof value === 'string') {
      sink.push(value)
      return
    }
    if (Array.isArray(value)) {
      for (const item of value) collectPathValues(item, sink, depth + 1)
      return
    }
    if (typeof value === 'object') {
      for (const [key, inner] of Object.entries(value)) {
        if (typeof inner === 'string') {
          if (/path|file|target|output|dest|name/i.test(key)) sink.push(inner)
          else if (/command|script|cmd/i.test(key)) sink.push(inner)
        } else {
          collectPathValues(inner, sink, depth + 1)
        }
      }
    }
  }

  /** 从一段自由文本里挖出看起来像文件路径的片段。 */
  function extractPathsFromText(text) {
    const found = []
    // Windows 绝对路径
    for (const match of String(text).matchAll(/[A-Za-z]:\\[^\s"'<>|*?\r\n]+/g)) found.push(match[0])
    // 带常见扩展名的引号内相对路径
    for (const match of String(text).matchAll(/["']([^"'\r\n]+\.(?:md|markdown|txt|json|jsonl|js|mjs|cjs|ts|tsx|jsx|py|log|csv|tsv|xlsx|docx|pptx|pdf|png|jpe?g|svg|html|css|ya?ml))["']/gi)) {
      found.push(match[1])
    }
    return found
  }

  /** 扫描工作目录中在任务开始后修改过的文件（兜底识别产出）。 */
  function scanRecentFiles(root, sinceMs, deletedSet) {
    const out = []
    const base = resolve(root || process.cwd())
    const skipDirs = new Set(['node_modules', '.git', '.mission-control'])
    let visited = 0
    const walk = (dir, depth) => {
      if (depth > 4 || out.length > 200 || visited > 5000) return
      let entries
      try {
        entries = readdirSync(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const entry of entries) {
        if (visited > 5000 || out.length > 200) return
        const full = join(dir, entry.name)
        if (entry.isDirectory()) {
          if (skipDirs.has(entry.name)) continue
          visited += 1
          walk(full, depth + 1)
          continue
        }
        if (!entry.isFile()) continue
        visited += 1
        const abs = resolve(full)
        if (deletedSet.has(abs)) continue
        try {
          const info = statSync(abs)
          if (info.mtimeMs >= sinceMs) out.push(abs)
        } catch {
          // 读不到就跳过
        }
      }
    }
    walk(base, 0)
    return out
  }

  /** 收集本次任务产出的结果文件（本任务成员写过、仍在磁盘上、未被清理掉）。 */
  function collectResultFiles(members, deletedSet, root) {
    const seen = new Set()
    const out = []
    const base = resolve(root || process.cwd())
    const candidate = (raw) => {
      if (typeof raw !== 'string') return
      const trimmed = raw.trim().replace(/^["']|["']$/g, '')
      if (!trimmed || trimmed.length > 400) return
      if (!/\.[A-Za-z0-9]{1,8}$/.test(trimmed)) return
      const abs = resolve(/^[A-Za-z]:\\/.test(trimmed) || trimmed.startsWith('/') ? trimmed : join(base, trimmed))
      if (abs.includes(`${sep}node_modules${sep}`) || abs.includes(`${sep}.git${sep}`)) return
      if (seen.has(abs)) return
      seen.add(abs)
      if (deletedSet.has(abs)) return
      try {
        if (!existsSync(abs)) return
        if (!statSync(abs).isFile()) return
      } catch {
        return
      }
      out.push(abs)
    }

    for (const member of members ?? []) {
      const session = services.sessions()?.get(String(member.id))
      if (!session) continue
      let events
      try {
        events = session.snapshotEvents()
      } catch {
        continue
      }
      for (const event of events) {
        if (event.type !== 'tool/call') continue
        // 只认「写类」工具：read/grep/session_* 等读操作打开过的文件不算产出
        const toolName = String(event.data?.name ?? '')
        if (!WRITE_TOOLS.has(toolName)) continue
        const rawArgs = event.data?.arguments
        let parsed
        try {
          parsed = JSON.parse(rawArgs ?? '{}')
        } catch {
          parsed = undefined
        }
        if (parsed && typeof parsed === 'object') {
          const sink = []
          collectPathValues(parsed, sink)
          for (const value of sink) {
            candidate(value)
            for (const extra of extractPathsFromText(value)) candidate(extra)
          }
        } else if (typeof rawArgs === 'string') {
          for (const extra of extractPathsFromText(rawArgs)) candidate(extra)
        }
      }
    }
    return out
  }

  /** 让主会话（Lead）输出最终结果汇总：投递一条 prompt 并唤醒它。 */
  async function askLeadToSummarize(mission, payload) {
    const controller = ctx.get('sessionController')
    if (!controller || typeof controller.prompt !== 'function') return false
    const { task, interrupted, deleted, resultFiles, boardDone, reports, closed = [] } = payload
    const lines = [
      '【蜂巢任务已结束】',
      '',
      `任务目标：${task || '（未记录）'}`,
      `已停止子会话：${interrupted.length} 个${interrupted.length ? `（${interrupted.join('、')}）` : ''}`,
      `已关闭（归档）子会话：${closed.length} 个`,
      `已清理临时文件：${deleted.length} 个`,
      '',
    ]
    if (resultFiles.length > 0) {
      lines.push('## 结果文件（全部保留）')
      for (const file of resultFiles) lines.push(`- ${file}`)
      lines.push('')
    } else {
      lines.push('## 结果文件', '（本次任务没有检测到落盘的结果文件）', '')
    }
    if (boardDone.length > 0) {
      lines.push('## 任务板已完成事项')
      for (const item of boardDone) lines.push(`- ${item}`)
      lines.push('')
    }
    if (reports.length > 0) {
      lines.push('## 各成员汇报')
      for (const r of reports) lines.push(`- ${r.name}：${r.summary}`)
      lines.push('')
    }
    lines.push(
      '请现在向用户输出本次项目的最终结果汇总：',
      '1. 用简短中文说明这次任务完成了什么；',
      '2. **必须逐个列出上面所有结果文件的完整路径**，并各用一句话说明其用途；',
      '3. 如果结果文件确实存在，请调用 `present` 工具把它们作为交付物展示给用户；',
      '4. 不要重新开工蜂，不要继续任务，只做汇总。',
    )
    const text = lines.join('\n')
    const request = {
      requestId: `mission-end-${Date.now()}`,
      sessionId: mission.sessionId,
      mode: 'queue',
      content: [{ type: 'text', text }],
    }
    try {
      await controller.prompt(request, new AbortController().signal)
      return true
    } catch {
      // 回落：直接投递到该 Agent 的收件箱
      try {
        const agent = services.agents()?.get(mission.sessionId)
        if (agent && typeof agent.inject === 'function') {
          agent.inject({ content: [{ type: 'text', text }] })
          return true
        }
      } catch {
        // 无法唤醒主会话：结果仍在 HTTP 响应里
      }
      return false
    }
  }

  /** 关闭（归档）子会话；可选删除其日志文件。 */
  async function closeChildSessions(members) {
    const registry = ctx.get('workspaceRegistry')
    const archived = []
    const failures = []
    const index = await sessionDirIndex()
    for (const member of members ?? []) {
      try {
        // 只归档磁盘上真实存在、尚未归档的会话，避免产生孤儿归档条目
        if (!index.has(String(member.id))) continue
        if (registry && typeof registry.archiveSession === 'function') {
          await registry.archiveSession(member.id, { stopActivity: true })
        }
        archived.push(member.name)
      } catch (error) {
        failures.push(`${member.name}: ${errText(error)}`)
      }
    }
    archivedCache = { at: 0, ids: new Set() }

    let removedLogs = 0
    if (config.deleteSessionLogs === true) {
      // 真实日志是 <sessions>/<workspace>/<id>/session.v4.jsonl.zstd，
      // 必须按目录删除；按文件名比对 id 永远匹配不到（旧实现因此恒为 0）
      for (const member of members ?? []) {
        const purged = await purgeSessionFiles(String(member.id))
        removedLogs += purged.logDir
        for (const error of purged.errors ?? []) failures.push(`${member.name}: ${error}`)
      }
    }

    return { archived, failures, removedLogs }
  }

  /** 读取工作区注册表里已归档的会话 id 集合（platform 没有读取接口，直接读存储文件）。 */
  let archivedCache = { at: 0, ids: new Set() }
  function archivedSessionIds() {
    const now = Date.now()
    if (now - archivedCache.at < 1500) return archivedCache.ids
    const ids = new Set()
    try {
      const home = process.env.DSH_HOME || join(process.env.USERPROFILE || '', '.dsh')
      const file = join(home, 'storages', 'workspace.json')
      if (existsSync(file)) {
        const raw = readFileSync(file, 'utf8')
        const data = JSON.parse(raw)
        const list = data?.global?.archivedSessionIds
        if (Array.isArray(list)) for (const id of list) ids.add(String(id))
      }
    } catch {
      // 读不到就按「无归档」处理
    }
    archivedCache = { at: now, ids }
    return ids
  }

  /** 会话存储根目录。 */
  function dshHome() {
    return process.env.DSH_HOME || join(process.env.USERPROFILE || '', '.dsh')
  }

  /** 扫描磁盘上实际存在的会话目录：id -> 目录路径。 */
  let sessionIndexCache = { at: 0, map: new Map() }
  async function sessionDirIndex() {
    const now = Date.now()
    if (now - sessionIndexCache.at < 1500) return sessionIndexCache.map
    const map = new Map()
    const root = join(dshHome(), 'sessions')
    let workspaces = []
    try {
      workspaces = await readdir(root, { withFileTypes: true })
    } catch {
      workspaces = []
    }
    for (const ws of workspaces) {
      if (!ws.isDirectory()) continue
      let children = []
      try {
        children = await readdir(join(root, ws.name), { withFileTypes: true })
      } catch {
        continue
      }
      for (const child of children) {
        if (!child.isDirectory()) continue
        const id = child.name.replace(/^session-/, '')
        map.set(id, join(root, ws.name, child.name))
      }
    }
    sessionIndexCache = { at: now, map }
    return map
  }

  /** 彻底删除一个会话的磁盘痕迹：日志目录 + 投影缓存。失败会记录到 errors。 */
  async function purgeSessionFiles(id) {
    const result = { logDir: 0, projCache: 0, errors: [] }
    const index = await sessionDirIndex()
    const dir = index.get(String(id))
    if (dir) {
      try {
        await rm(dir, { recursive: true, force: true })
        result.logDir = 1
      } catch (error) {
        // 不吞错：调用方据此报告失败，而不是谎报"已彻底删除"
        result.errors.push(`删除会话日志失败: ${errText(error)}`)
      }
    }
    const proj = join(dshHome(), 'storages', 'session_projcache', 'sessions', `${id}.json`)
    try {
      if (existsSync(proj)) {
        await unlink(proj)
        result.projCache = 1
      }
    } catch (error) {
      result.errors.push(`删除投影缓存失败: ${errText(error)}`)
    }
    sessionIndexCache = { at: 0, map: new Map() }
    return result
  }

  /** 列出某会话下的所有子会话（工蜂）；已彻底删除的自动隐藏。 */
  async function listChildSessions(sessionId, options = {}) {
    const agent = sessionId ? services.agents()?.get(String(sessionId)) : undefined
    if (!agent) return { ok: false, error: 'session-not-found', children: [] }
    const archivedSet = archivedSessionIds()
    const index = await sessionDirIndex()
    const all = teammatesOf(agent).map((member) => {
      const id = String(member.id)
      return {
        id,
        name: member.name,
        status: member.status,
        description: member.description ?? '',
        archived: archivedSet.has(id),
        // 磁盘上没有会话目录 = 已被彻底删除
        exists: index.has(id),
      }
    })
    // 排序：普通会话 → 归档会话 → 已删除会话；组内按名称
    const rankOf = (c) => (!c.exists ? 2 : c.archived ? 1 : 0)
    const children = all.slice().sort((a, b) => {
      const d = rankOf(a) - rankOf(b)
      return d !== 0 ? d : a.name.localeCompare(b.name)
    })
    return {
      ok: true,
      children,
      total: all.length,
      archivedCount: all.filter((c) => c.archived && c.exists).length,
      deletedCount: all.filter((c) => !c.exists).length,
      activeCount: all.filter((c) => c.exists && !c.archived).length,
    }
  }

  /**
   * 删除指定的子会话。默认「彻底删除」：
   * 停止 → 解除归档 → 删除日志目录与投影缓存。
   * hard=false 则退化为仅归档。
   */
  async function deleteChildSessions(sessionId, childIds, options = {}) {
    const agent = sessionId ? services.agents()?.get(String(sessionId)) : undefined
    if (!agent) return { ok: false, error: 'session-not-found', deleted: [], errors: [] }
    const team = services.team()
    const registry = ctx.get('workspaceRegistry')
    const wanted = new Set((childIds ?? []).map(String))
    const targets = teammatesOf(agent).filter((m) => wanted.has(String(m.id)))
    const hard = options.hard !== false

    const deleted = []
    const errors = []
    let removedLogs = 0
    let removedCaches = 0

    for (const member of targets) {
      const id = String(member.id)
      try {
        if (team && (member.status === 'running' || member.status === 'provisioning')) {
          try {
            team.interrupt(agent, member.name)
          } catch {
            // 已结束
          }
        }

        if (hard) {
          // 先解除归档，避免在归档集合里留下指向已不存在会话的条目
          if (registry && typeof registry.unarchiveSession === 'function') {
            try {
              await registry.unarchiveSession(member.id)
            } catch {
              // 未归档时忽略
            }
          }
          const purged = await purgeSessionFiles(id)
          removedLogs += purged.logDir
          removedCaches += purged.projCache
          // 真的没删掉就不能报成功
          if ((purged.errors ?? []).length > 0) {
            for (const error of purged.errors) errors.push(`${member.name}: ${error}`)
            if (purged.logDir === 0 && purged.projCache === 0) continue
          }
          deleted.push({ id, name: member.name, hard: true })
          retireMembers(sessionId, [String(member.name)])
        } else {
          if (registry && typeof registry.archiveSession === 'function') {
            await registry.archiveSession(member.id, { stopActivity: true })
          }
          deleted.push({ id, name: member.name, hard: false })
          retireMembers(sessionId, [String(member.name)])
        }
      } catch (error) {
        errors.push(`${member.name}: ${errText(error)}`)
      }
    }

    return { ok: true, deleted, errors, removedLogs, removedCaches, hard }
  }

  /** 清理指向已不存在会话的归档残留，避免归档集合无限膨胀。 */
  async function pruneOrphanArchives() {
    const registry = ctx.get('workspaceRegistry')
    if (!registry || typeof registry.unarchiveSession !== 'function') return { pruned: [] }
    const archivedSet = archivedSessionIds()
    const index = await sessionDirIndex()
    const pruned = []
    for (const id of archivedSet) {
      if (index.has(String(id))) continue
      // 只清理子会话形态的 id（裸 uuid），根会话保留
      if (/^session-/.test(String(id))) continue
      try {
        await registry.unarchiveSession(id)
        pruned.push(String(id))
      } catch {
        // 忽略
      }
    }
    if (pruned.length > 0) archivedCache = { at: 0, ids: new Set() }
    return { pruned }
  }

  /**
   * 归档指定的子会话（可逆）：停止运行中的 → 写入归档集合。
   * 归档后从工作区会话列表移走，但日志保留，可取消归档恢复。
   */
  async function archiveChildSessions(sessionId, childIds) {
    const agent = sessionId ? services.agents()?.get(String(sessionId)) : undefined
    if (!agent) return { ok: false, error: 'session-not-found', archived: [], errors: [] }
    const team = services.team()
    const registry = ctx.get('workspaceRegistry')
    const wanted = new Set((childIds ?? []).map(String))
    const targets = teammatesOf(agent).filter((m) => wanted.has(String(m.id)))

    const archived = []
    const errors = []
    const index = await sessionDirIndex()
    for (const member of targets) {
      try {
        const id = String(member.id)
        // 会话已不在磁盘（已被彻底删除）：只清理归档残留，不写悬空归档
        if (!index.has(id)) {
          if (registry && typeof registry.unarchiveSession === 'function') {
            try {
              await registry.unarchiveSession(member.id)
            } catch {
              // 未归档时忽略
            }
          }
          errors.push(`${member.name}: 会话已不存在，已清理归档残留`)
          continue
        }
        if (team && (member.status === 'running' || member.status === 'provisioning')) {
          try {
            team.interrupt(agent, member.name)
          } catch {
            // 已结束
          }
        }
        if (registry && typeof registry.archiveSession === 'function') {
          await registry.archiveSession(member.id, { stopActivity: true })
        }
        // 归档后从活跃名单退休：不再计数、不再接收广播、面板不再显示
        retireMembers(sessionId, [String(member.name)])
        archived.push({ id: String(member.id), name: member.name })
      } catch (error) {
        errors.push(`${member.name}: ${errText(error)}`)
      }
    }
    archivedCache = { at: 0, ids: new Set() }
    return { ok: true, archived, errors }
  }

  /** 取消归档，把会话放回列表。 */
  async function unarchiveChildSessions(sessionId, childIds) {
    const agent = sessionId ? services.agents()?.get(String(sessionId)) : undefined
    if (!agent) return { ok: false, error: 'session-not-found', restored: [], errors: [] }
    const registry = ctx.get('workspaceRegistry')
    const wanted = new Set((childIds ?? []).map(String))
    const targets = teammatesOf(agent).filter((m) => wanted.has(String(m.id)))
    const restored = []
    const errors = []
    for (const member of targets) {
      try {
        if (registry && typeof registry.unarchiveSession === 'function') {
          await registry.unarchiveSession(member.id)
        }
        // 取消归档后重新回到活跃名单
        const mission = missions.get(String(sessionId))
        if (mission?.retired) mission.retired.delete(String(member.name))
        restored.push({ id: String(member.id), name: member.name })
      } catch (error) {
        errors.push(`${member.name}: ${errText(error)}`)
      }
    }
    archivedCache = { at: 0, ids: new Set() }
    return { ok: true, restored, errors }
  }

  async function endMissions(sessionId, options = {}) {
    const team = services.team()
    const interrupted = []
    const stopped = []
    const finishing = []
    const closing = []
    for (const mission of [...missions.values()]) {
      if (sessionId && mission.sessionId !== sessionId) continue
      const agent = services.agents()?.get(mission.sessionId)
      const allMembers = teammatesOf(agent)
      const members = activeMembersOf(mission)
      const root = workspaceOf(agent)
      const boardDone = missionTasks(mission)
        .filter((t) => t.status === 'completed')
        .map((t) => t.subject)
      const memberReports = activeMembersOf(mission)
        .map((m) => {
          const report = reports.get(String(m.id)) ?? {}
          const done = [...(report.completed ?? [])]
          const summary = done.length > 0 ? done.join('；') : (report.current || '')
          return { name: m.name, summary }
        })
        .filter((r) => r.summary)
      if (agent && team) {
        // 「结束任务」只处理仍然活跃的工蜂：已交接/已退休/已删除的历史条目一律跳过，
        // 避免把它们重新归档成孤儿，也避免重复 interrupt
        const activeNames = new Set(activeMembersOf(mission).map((m) => m.name))
        const live = await liveMembers(agent)
        const liveNames = new Set(live.map((m) => m.name))
        for (const member of allMembers) {
          if (!liveNames.has(member.name)) continue
          if (!activeNames.has(member.name)) continue
          closing.push(member)
          if (member.status !== 'running' && member.status !== 'provisioning') continue
          try {
            team.interrupt(agent, member.name)
            interrupted.push(member.name)
          } catch {
            // 成员可能已结束
          }
        }
        retireMembers(mission.sessionId, [...activeNames])
      }
      missions.delete(mission.sessionId)
      // 任务已结束：让后续轮次明确回到普通会话，压掉历史里的旧分派契约
      hiveOffNotice.add(String(mission.sessionId))
      persistState()
      stopped.push(mission.sessionId)
      finishing.push({ mission, members, boardDone, memberReports, root })
    }

    let cleanup = { deleted: [], errors: [], root: undefined }
    if (options.cleanup !== false) {
      const firstAgent = stopped.map((id) => services.agents()?.get(id)).find(Boolean)
      cleanup = await cleanupTempFiles(workspaceOf(firstAgent))
    }

    const deletedSet = new Set((cleanup.deleted ?? []).map((p) => resolve(p)))
    // 关闭（归档）所有子会话，让侧边栏不再堆积历史工蜂
    const closed = await closeChildSessions(closing)
    // 结束任务后顺手清掉历史遗留的孤儿归档（指向已删除会话的条目）
    const archivePrune = await pruneOrphanArchives()
    const resultFiles = []
    let leadNotified = false
    for (const job of finishing) {
      const files = collectResultFiles(job.members, deletedSet, job.root)
      // 兜底：本任务开始后修改过的文件也算产出（覆盖 pwsh 等非结构化写入）
      for (const file of scanRecentFiles(job.root, job.mission.startedAt - 2000, deletedSet)) {
        if (!files.includes(file)) files.push(file)
      }
      for (const file of files) if (!resultFiles.includes(file)) resultFiles.push(file)
      const notified = await askLeadToSummarize(job.mission, {
        task: job.mission.task,
        interrupted,
        deleted: cleanup.deleted ?? [],
        resultFiles: files,
        boardDone: job.boardDone,
        reports: job.memberReports,
        closed: closed.archived ?? [],
      })
      leadNotified = leadNotified || notified
    }

    return {
      ok: true,
      stopped: stopped.length,
      sessionIds: stopped,
      interrupted,
      cleanup,
      resultFiles,
      leadNotified,
      closed,
      archivePruned: archivePrune.pruned.length,
    }
  }

  if (ctx.webServer && typeof ctx.webServer.register === 'function') {
    ctx.effect(() => {
      let dispose
      try {
        dispose = ctx.webServer.register({
          kind: 'exact',
          path: '/mission-end-v1',
          // 用 handler 而非 resource：resource 只接受 GET/HEAD，改动类操作需要 POST
          handler: (req, res) => {
            const send = (status, payload, extraHeaders) => {
              try {
                res.writeHead(status, {
                  'content-type': 'application/json; charset=utf-8',
                  ...(extraHeaders ?? {}),
                })
                res.end(JSON.stringify(payload))
              } catch {
                // 连接可能已断开
              }
            }
            if (req.method !== 'POST') {
              send(405, { ok: false, error: 'method-not-allowed' }, { allow: 'POST' })
              return
            }
            const chunks = []
            req.on('data', (chunk) => chunks.push(chunk))
            req.on('end', () => {
              let body
              try {
                const raw = Buffer.concat(chunks).toString('utf8')
                if (Buffer.byteLength(raw, 'utf8') > MAX_BODY_BYTES) {
                  send(413, { ok: false, error: 'body-too-large' })
                  return
                }
                body = raw ? JSON.parse(raw) : {}
              } catch {
                send(400, { ok: false, error: 'invalid-json' })
                return
              }
              // 必须显式指定会话：缺失时绝不退化为「结束全部」
              const sessionId = body && typeof body.sessionId === 'string' ? body.sessionId.trim() : ''
              if (!sessionId) {
                send(400, { ok: false, error: 'missing-sessionId', message: '必须指定 sessionId，不会结束全部会话' })
                return
              }
              if (!missions.has(sessionId)) {
                send(404, { ok: false, error: 'no-active-mission', sessionId })
                return
              }
              const cleanup = body && typeof body.cleanup === 'boolean' ? body.cleanup : undefined
              endMissions(sessionId, { cleanup })
                .then((result) => send(200, result))
                .catch((error) =>
                  send(500, {
                    ok: false,
                    error: String(error && error.message ? error.message : error),
                  }),
                )
            })
            req.on('error', () => {
              send(400, { ok: false, error: 'request-error' })
            })
          },
        })
      } catch {
        return () => {}
      }
      return () => {
        try {
          dispose()
        } catch {
          // 已随旧 fiber 注销
        }
      }
    })
  }

  // ── 蜂巢模式开关端点：会话头部的开关与人数选择调用 ──────────────────────
  if (ctx.webServer && typeof ctx.webServer.register === 'function') {
    ctx.effect(() => {
      let dispose
      try {
        dispose = ctx.webServer.register({
          kind: 'exact',
          path: '/mission-mode-v1',
          handler: (req, res) => {
            const send = (status, payload, extraHeaders) => {
              try {
                res.writeHead(status, {
                  'content-type': 'application/json; charset=utf-8',
                  ...(extraHeaders ?? {}),
                })
                res.end(JSON.stringify(payload))
              } catch {
                // 连接可能已断开
              }
            }
            if (req.method !== 'POST') {
              send(405, { ok: false, error: 'method-not-allowed' }, { allow: 'POST' })
              return
            }
            const chunks = []
            req.on('data', (chunk) => chunks.push(chunk))
            req.on('end', () => {
              let body
              try {
                const raw = Buffer.concat(chunks).toString('utf8')
                if (Buffer.byteLength(raw, 'utf8') > MAX_BODY_BYTES) {
                  send(413, { ok: false, error: 'body-too-large' })
                  return
                }
                body = raw ? JSON.parse(raw) : {}
              } catch {
                send(400, { ok: false, error: 'invalid-json' })
                return
              }
              if (!body || typeof body.sessionId !== 'string' || !body.sessionId.trim()) {
                send(400, { ok: false, error: 'missing-sessionId' })
                return
              }
              setMissionMode(body.sessionId.trim(), body)
                .then((result) => send(result.ok ? 200 : 404, result))
                .catch((error) => send(500, { ok: false, error: errText(error) }))
            })
            req.on('error', () => send(400, { ok: false, error: 'request-error' }))
          },
        })
      } catch {
        return () => {}
      }
      return () => {
        try {
          dispose()
        } catch {
          // 已随旧 fiber 注销
        }
      }
    })
  }

  // ── 子会话管理端点：列出 / 删除指定子会话 ───────────────────────────────
  if (ctx.webServer && typeof ctx.webServer.register === 'function') {
    const json = (res, status, payload, extra) => {
      try {
        res.writeHead(status, {
          'content-type': 'application/json; charset=utf-8',
          ...(extra ?? {}),
        })
        res.end(JSON.stringify(payload))
      } catch {
        // 连接已断开
      }
    }
    const readBody = (req, onDone) => {
      const chunks = []
      req.on('data', (chunk) => chunks.push(chunk))
      req.on('end', () => {
        try {
          const raw = Buffer.concat(chunks).toString('utf8')
          onDone(raw ? JSON.parse(raw) : {})
        } catch (error) {
          onDone({ __error: errText(error) })
        }
      })
      req.on('error', () => onDone({ __error: 'request-error' }))
    }

    ctx.effect(() => {
      const disposers = []
      try {
        disposers.push(ctx.webServer.register({
          kind: 'exact',
          path: '/mission-children-v1',
          handler: (req, res) => {
            if (req.method !== 'GET') {
              json(res, 405, { ok: false, error: 'method-not-allowed' }, { allow: 'GET' })
              return
            }
            let sessionId
            let includeArchived = false
            let includeDeleted = false
            try {
              const url = new URL(req.url ?? '/', 'http://127.0.0.1')
              sessionId = url.searchParams.get('sessionId') ?? undefined
              includeArchived = url.searchParams.get('includeArchived') === '1'
              includeDeleted = url.searchParams.get('includeDeleted') === '1'
            } catch {
              // 无查询参数
            }
            listChildSessions(sessionId, { includeArchived, includeDeleted })
              .then((result) => json(res, 200, result))
              .catch((error) => json(res, 500, { ok: false, error: errText(error) }))
          },
        }))
        disposers.push(ctx.webServer.register({
          kind: 'exact',
          path: '/mission-archive-v1',
          handler: (req, res) => {
            if (req.method !== 'POST') {
              json(res, 405, { ok: false, error: 'method-not-allowed' }, { allow: 'POST' })
              return
            }
            readBody(req, (body) => {
              if (body && body.__error) {
                json(res, 400, { ok: false, error: body.__error })
                return
              }
              // action: 'archive'（默认）| 'unarchive'
              const run = body?.action === 'unarchive'
                ? unarchiveChildSessions(body.sessionId, body.childIds)
                : archiveChildSessions(body.sessionId, body.childIds)
              run
                .then((result) => json(res, 200, result))
                .catch((error) => json(res, 500, { ok: false, error: errText(error) }))
            })
          },
        }))
        disposers.push(ctx.webServer.register({
          kind: 'exact',
          path: '/mission-delete-v1',
          handler: (req, res) => {
            if (req.method !== 'POST') {
              json(res, 405, { ok: false, error: 'method-not-allowed' }, { allow: 'POST' })
              return
            }
            readBody(req, (body) => {
              if (body && body.__error) {
                json(res, 400, { ok: false, error: body.__error })
                return
              }
              deleteChildSessions(body.sessionId, body.childIds, {
                hard: body.hard !== false,
                deleteLogs: body.deleteLogs === true,
              })
                .then((result) => json(res, 200, result))
                .catch((error) => json(res, 500, { ok: false, error: errText(error) }))
            })
          },
        }))
      } catch {
        return () => {}
      }
      return () => {
        for (const dispose of disposers) {
          try {
            dispose()
          } catch {
            // 已注销
          }
        }
      }
    })
  }

  // ── 诊断端点：确认服务可用性与成员会话可见性（只读）──────────────────────
  if (ctx.webServer && typeof ctx.webServer.register === 'function') {
    ctx.effect(() => {
      let dispose
      try {
        dispose = ctx.webServer.register({
          kind: 'exact',
          path: '/mission-diag-v1',
          resource: async (request) => {
            // 可选：?probe=<sessionId> 对指定会话跑两次增量聚合，验证增量逻辑与耗时
            let probeId
            try {
              const url = new URL(request?.url ?? '/', 'http://127.0.0.1')
              probeId = url.searchParams.get('probe') ?? undefined
            } catch {
              // 无查询参数
            }
            let probe
            if (probeId) {
              const session = services.sessions()?.get(probeId)
              if (!session) {
                probe = { sessionId: probeId, found: false }
              } else {
                sessionAgg.delete(probeId)
                const t0 = Date.now()
                const first = aggregateSession(session, probeId)
                const t1 = Date.now()
                const second = aggregateSession(session, probeId)
                const t2 = Date.now()
                probe = {
                  sessionId: probeId,
                  found: true,
                  events: first.lastSeq,
                  turns: first.turns,
                  toolCalls: first.toolCalls,
                  files: first.files.length,
                  lastActionLen: first.lastAction.length,
                  firstMs: t1 - t0,
                  secondMs: t2 - t1,
                  stable: first.turns === second.turns && first.toolCalls === second.toolCalls,
                }
              }
            }
            const payload = {
              at: Date.now(),
              probe,
              services: {
                sessions: Boolean(services.sessions()),
                agents: Boolean(services.agents()),
                meter: Boolean(services.meter()),
                team: Boolean(services.team()),
              },
              cachedSessions: sessionAgg.size,
              missions: [...missions.values()].map((mission) => ({
                sessionId: mission.sessionId,
                members: activeMembersOf(mission).map((member) => {
                  const id = String(member.id)
                  const session = services.sessions()?.get(id)
                  let events = -1
                  try {
                    events = session ? session.snapshotEvents().length : -2
                  } catch {
                    events = -3
                  }
                  return {
                    name: member.name,
                    id,
                    status: member.status,
                    sessionFound: Boolean(session),
                    events,
                    agg: sessionAgg.get(id) ?? null,
                  }
                }),
              })),
            }
            return new Response(JSON.stringify(payload), {
              status: 200,
              headers: { 'content-type': 'application/json; charset=utf-8' },
            })
          },
        })
      } catch {
        return () => {}
      }
      return () => {
        try {
          dispose()
        } catch {
          // 已随旧 fiber 注销
        }
      }
    })
  }

  // ── 上下文哨兵 ──────────────────────────────────────────────────────────────
  ctx.effect(() => {
    const timer = setInterval(() => {
      for (const mission of missions.values()) {
        const agent = services.agents()?.get(mission.sessionId)
        if (!agent) continue
        // 只对活跃工蜂做哨兵检测：已交接/已退休的成员不再触发（否则会反复 spawn 续任者）
        for (const member of activeMembersOf(mission)) {
          const usage = measureMember(member)
          if (usage.known && usage.ratio >= config.handoffRatio) {
            void handoff(mission, agent, member)
          }
        }
      }
    }, Math.max(2000, Number(config.pollIntervalMs) || 15000))
    return () => clearInterval(timer)
  })

  // ── 恢复持久化状态 + 主会话重新上线时对账 ────────────────────────────────
  void loadPersistedState()
  ctx.on('agent/created', ({ agent }) => {
    const mission = agent ? missions.get(String(agent.id)) : undefined
    if (!mission) return
    void reconcileMission(mission).then(() => persistState())
  })
}

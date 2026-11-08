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
import { existsSync, statSync, readdirSync, readFileSync } from 'node:fs'
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

  /** 切换某个子会话的模型：优先用 agent.model.select()（平台要求在 step 准备前）。 */
  async function switchMemberModel(mission, agent, name, provider, model) {
    const member = teammatesOf(agent).find((m) => String(m.name) === String(name))
    if (!member) return { ok: false, error: `找不到成员 ${name}` }
    const target = services.agents()?.get(String(member.id))
    if (!target) return { ok: false, error: `成员 ${name} 不在线` }

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
    const workers = missionMembers(mission).length
    const cap = Number(mission.cap) || 1
    const target = Math.min(Math.max(unowned.length, open.length ? 1 : 0), cap)
    const gap = Math.max(0, target - workers)
    return { workers, cap, openTasks: open.length, unownedTasks: unowned.length, target, gap }
  }

  /** 测量一个成员会话的上下文压力。 */
  function measureMember(member) {
    const sessions = services.sessions()
    const meter = services.meter()
    const session = sessions?.get(member.id)
    if (!session) return { tokens: 0, window: config.fallbackContextWindow, ratio: 0, known: false }
    let tokens = 0
    let window = config.fallbackContextWindow
    try {
      const measurement = meter?.measure(session)
      if (measurement && Number.isFinite(measurement.totalTokens)) tokens = measurement.totalTokens
      const header = session.requestContext?.()
      if (header && Number.isFinite(header.contextWindow)) window = header.contextWindow
    } catch {
      // 测量失败不影响主流程，按 0 处理
    }
    return { tokens, window, ratio: window > 0 ? tokens / window : 0, known: true }
  }

  function missionRows(mission) {
    const agent = services.agents()?.get(mission.sessionId)
    if (!agent) return { agent: undefined, rows: [] }
    const tasks = missionTasks(mission)
    const sessions = services.sessions()
    const rows = missionMembers(mission).map((member) => {
      const usage = measureMember(member)
      const owned = tasks.filter((t) => t.ownerName === member.name)
      const memberSession = sessions?.get(member.id)
      const recent = memberSession ? recentAssistantText(memberSession, 1)[0] : ''
      return {
        name: member.name,
        status: member.status,
        tokens: usage.tokens,
        contextWindow: usage.window,
        ratio: Math.round(usage.ratio * 1000) / 1000,
        // 当前任务 = 认领的进行中/待办；已完成任务 = 认领的已完结
        currentTasks: owned
          .filter((t) => t.status === 'in_progress' || t.status === 'pending')
          .map((t) => t.subject),
        completedTasks: owned.filter((t) => t.status === 'completed').map((t) => t.subject),
        activeTasks: owned.filter((t) => t.status !== 'completed').map((t) => t.subject),
        recentNote: recent ? recent.slice(0, 240) : '',
      }
    })
    return { agent, rows }
  }

  /** sessionId -> 工蜂自报的工作概括（current 一行 + completed 多行） */
  const reports = new Map()

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

    let turns = 0
    let toolCalls = 0
    let lastAction = ''
    let actualModel = ''
    const files = []

    if (session) {
      try {
        const events = session.snapshotEvents()
        for (const event of events) {
          if (event.type === 'turn/end') turns += 1
          else if (event.type === 'tool/call') {
            toolCalls += 1
            const name = event.data?.name
            if (name === 'write' || name === 'edit') {
              try {
                const args = JSON.parse(event.data?.arguments ?? '{}')
                const path = args.file_path ?? args.path
                if (typeof path === 'string' && !files.includes(path)) files.push(path)
              } catch {
                // 参数不是 JSON 就忽略
              }
            }
          }
        }
        for (let i = events.length - 1; i >= 0; i -= 1) {
          if (events[i].type !== 'assistant/message') continue
          const source = events[i].data?.message?.source
          if (source && source.provider && !actualModel) {
            actualModel = `${source.provider}/${source.model}`
          }
          const text = blocksToText(events[i].data?.message?.content)
          if (text) {
            lastAction = text
            break
          }
        }
      } catch {
        // 会话已关闭或日志不可读
      }
    }

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
      const teammates = missionMembers(mission).map((member) => {
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
    if (mission.handoffInFlight.has(member.name)) return
    mission.handoffInFlight.add(member.name)
    try {
      const team = services.team()
      const digest = buildDigest(mission, agent, member)
      try {
        team.interrupt(agent, member.name)
      } catch {
        // 可能已经处于 inactive，忽略
      }
      const round = (mission.handoffRounds.get(member.name) ?? 0) + 1
      mission.handoffRounds.set(member.name, round)
      await team.spawnTeammate(agent, {
        name: `${member.name}-r${round}`,
        description: `接替 ${member.name}（上下文交接）`,
        prompt: [textBlock(digest)],
        context: 'fresh',
        provider: config.freshProvider,
        signal: new AbortController().signal,
      })
      mission.lastHandoff = { from: member.name, to: `${member.name}-r${round}`, at: Date.now() }
    } catch (error) {
      mission.lastError = errText(error)
    } finally {
      mission.handoffInFlight.delete(member.name)
    }
  }

  function broadcast(mission, text) {
    // 暂停：子会话继续工作，但主会话的话不再下发给子会话
    if (mission.paused) return 0
    const agent = services.agents()?.get(mission.sessionId)
    const team = services.team()
    if (!agent || !team) return 0
    const members = missionMembers(mission)
    if (members.length === 0) return 0
    const signal = new AbortController().signal
    let sent = 0
    // 只发给存活会话：花名册里的已删除/已归档条目不再接收广播
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
        })
      }
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

      const existing = new Set(missionMembers(mission).map((m) => m.name))
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
        const current = missionMembers(mission)
        if (current.length >= mission.cap) {
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

      return {
        spawned,
        skipped,
        refused,
        modelSwitches,
        modelErrors,
        workers: missionMembers(mission).length,
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
        mission.workerModels?.delete(String(args.name))
        return { ok: true, model: 'default' }
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
                currentTasks: {
                  type: 'array',
                  items: { type: 'string' },
                },
                completedTasks: {
                  type: 'array',
                  items: { type: 'string' },
                },
                recentNote: { type: 'string' },
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
          .map((m) => {
            const head = `- ${m.name} [${m.status}] ${m.tokens}/${m.contextWindow} tokens (${Math.round(
              m.ratio * 100,
            )}%)`
            const cur = m.currentTasks?.length ? `当前任务: ${m.currentTasks.join('；')}` : ''
            const done = m.completedTasks?.length ? `已完成任务: ${m.completedTasks.join('；')}` : ''
            const note = m.recentNote ? `最近进展: ${m.recentNote}` : ''
            return [head, cur, done, note].filter(Boolean).join('\n  ')
          })
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
    description: 'End the mission on this session: clears the cap and stops the sentinel relay for it.',
    parameters: { type: 'object', properties: {} },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { ok: { type: 'boolean' } },
        required: ['ok'],
      },
      render: () => [textBlock('Mission ended.')],
    },
    execute(_args, exec) {
      const agent = exec.agent
      if (!agent) throw new Error('mission_stop requires an owning agent session')
      missions.delete(String(agent.id))
      return Promise.resolve({ ok: true })
    },
    presentCall: () => ({ card: 'generic', title: 'Stop mission', kind: 'other' }),
  })

  // ── 人数上限守卫 ────────────────────────────────────────────────────────────
  ctx.tools.guard((exec) => {
    if (exec.name !== 'spawn_teammate') return undefined
    const agent = exec.agent
    if (!agent) return undefined
    const mission = missions.get(String(agent.id))
    if (!mission) return undefined
    const running = missionMembers(mission).filter(
      (m) => m.status === 'running' || m.status === 'provisioning',
    )
    if (running.length >= mission.cap) {
      return `mission-control: 本次任务的上限是 ${mission.cap} 个并发工蜂，已满，拒绝再创建`
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
    const missionFor = () => {
      const agent = scopeAgent()
      return agent ? missions.get(String(agent.id)) : undefined
    }
    if (sysPrompt && typeof sysPrompt.section === 'function') {
      try {
        sysPrompt.section({
          name: 'mission-control:hive',
          order: 945,
          text: () => {
            if (missions.size === 0) return ''
            const agent = scopeAgent()
            const mission = agent ? missions.get(String(agent.id)) : undefined

            // 子会话（teammate）身份：只做分配给自己的事 + 汇报
            if (!mission) {
              const team = services.team()
              let role
              try {
                role = agent ? team?.membership?.(agent)?.role : undefined
              } catch {
                role = undefined
              }
              if (role !== 'teammate') return ''
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
            new Response(JSON.stringify(dashboardSnapshot()), {
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

  /**
   * 开关蜂巢模式：开启=进入蜂巢模式（必要时建任务），关闭=暂停。
   * 暂停时子会话继续工作，但主会话消息不再下发给子会话。
   */
  function setMissionMode(sessionId, options = {}) {
    if (!sessionId) return { ok: false, error: 'missing-session' }
    const enabled = options.enabled !== false
    const workers = Number.isFinite(Number(options.workers))
      ? Math.min(10, Math.max(2, Math.floor(Number(options.workers))))
      : undefined
    const existing = missions.get(sessionId)

    if (enabled) {
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
        })
      }
    } else if (existing) {
      existing.paused = true
      if (workers !== undefined) existing.cap = workers
    }

    const mission = missions.get(sessionId)
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
      const home = process.env.DSH_HOME || join(process.env.USERPROFILE || '', '.dsh')
      const dir = join(home, 'sessions')
      const ids = new Set((members ?? []).map((m) => String(m.id)))
      const walk = async (current, depth) => {
        if (depth > 3) return
        let entries
        try {
          entries = await readdir(current, { withFileTypes: true })
        } catch {
          return
        }
        for (const entry of entries) {
          const full = join(current, entry.name)
          if (entry.isDirectory()) {
            await walk(full, depth + 1)
            continue
          }
          const stem = entry.name.replace(/\.jsonl?$/i, '')
          if (!ids.has(stem)) continue
          try {
            await unlink(full)
            removedLogs += 1
          } catch {
            // 删不掉就保留
          }
        }
      }
      await walk(dir, 0)
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

  /** 彻底删除一个会话的磁盘痕迹：日志目录 + 投影缓存。 */
  async function purgeSessionFiles(id) {
    const result = { logDir: 0, projCache: 0 }
    const index = await sessionDirIndex()
    const dir = index.get(String(id))
    if (dir) {
      try {
        await rm(dir, { recursive: true, force: true })
        result.logDir = 1
      } catch {
        // 删不掉就保留，由调用方报告
      }
    }
    const proj = join(dshHome(), 'storages', 'session_projcache', 'sessions', `${id}.json`)
    try {
      if (existsSync(proj)) {
        await unlink(proj)
        result.projCache = 1
      }
    } catch {
      // 忽略
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
          deleted.push({ id, name: member.name, hard: true })
        } else {
          if (registry && typeof registry.archiveSession === 'function') {
            await registry.archiveSession(member.id, { stopActivity: true })
          }
          deleted.push({ id, name: member.name, hard: false })
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
      const members = missionMembers(mission)
      const root = workspaceOf(agent)
      const boardDone = missionTasks(mission)
        .filter((t) => t.status === 'completed')
        .map((t) => t.subject)
      const memberReports = members
        .map((m) => {
          const report = reports.get(String(m.id)) ?? {}
          const done = [...(report.completed ?? [])]
          const summary = done.length > 0 ? done.join('；') : (report.current || '')
          return { name: m.name, summary }
        })
        .filter((r) => r.summary)
      if (agent && team) {
        // 「结束任务」要停掉所有存活子会话，不只本任务创建的成员；
        // 已删除/已归档的历史条目一律跳过，避免把它们重新归档成孤儿
        const live = await liveMembers(agent)
        const liveNames = new Set(live.map((m) => m.name))
        for (const member of allMembers) {
          if (!liveNames.has(member.name)) continue
          closing.push(member)
          if (member.status !== 'running' && member.status !== 'provisioning') continue
          try {
            team.interrupt(agent, member.name)
            interrupted.push(member.name)
          } catch {
            // 成员可能已结束
          }
        }
      }
      missions.delete(mission.sessionId)
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
              let sessionId
              let cleanup
              try {
                const raw = Buffer.concat(chunks).toString('utf8')
                if (raw) {
                  const body = JSON.parse(raw)
                  if (body && typeof body.sessionId === 'string') sessionId = body.sessionId
                  if (body && typeof body.cleanup === 'boolean') cleanup = body.cleanup
                }
              } catch {
                // 无法解析的请求体按「结束全部」处理
              }
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
              try {
                const raw = Buffer.concat(chunks).toString('utf8')
                const body = raw ? JSON.parse(raw) : {}
                send(200, setMissionMode(body.sessionId, body))
              } catch (error) {
                send(400, {
                  ok: false,
                  error: String(error && error.message ? error.message : error),
                })
              }
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

  // ── 上下文哨兵 ──────────────────────────────────────────────────────────────
  ctx.effect(() => {
    const timer = setInterval(() => {
      for (const mission of missions.values()) {
        const agent = services.agents()?.get(mission.sessionId)
        if (!agent) continue
        for (const member of missionMembers(mission)) {
          const usage = measureMember(member)
          if (usage.known && usage.ratio >= config.handoffRatio) {
            void handoff(mission, agent, member)
          }
        }
      }
    }, Math.max(2000, Number(config.pollIntervalMs) || 15000))
    return () => clearInterval(timer)
  })
}

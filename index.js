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

import { readdir, unlink, rm } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'

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
      const teammates = missionMembers(mission).map((member) => {
        const usage = measureMember(member)
        return {
          name: member.name,
          status: member.status,
          tokens: usage.tokens,
          contextWindow: usage.window,
          ratio: Math.round(usage.ratio * 1000) / 1000,
          ...workDetail(member, tasks),
        }
      })
      out.missions.push({
        sessionId: mission.sessionId,
        task: mission.task,
        cap: mission.cap,
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
    const agent = services.agents()?.get(mission.sessionId)
    const team = services.team()
    if (!agent || !team) return 0
    const members = missionMembers(mission)
    if (members.length === 0) return 0
    const signal = new AbortController().signal
    let sent = 0
    for (const member of members) {
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
      missions.set(String(agent.id), {
        sessionId: String(agent.id),
        task: String(args.task),
        cap: Number(args.workers),
        startedAt: Date.now(),
        baseline: new Set(teammatesOf(agent).map((m) => m.name)),
        baselineTasks: new Set(tasksOf(agent).map((t) => t.id)),
        handoffInFlight: new Set(),
        handoffRounds: new Map(),
      })
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

  // ── 驾驶舱中继：人类发话立即扇出 ──────────────────────────────────────────
  ctx.on('session/event', (session, event) => {
    if (event.type !== 'user/message') return
    const mission = missions.get(String(session.id))
    if (!mission) return
    const message = event.data
    const source = message?.source
    if (source && source.kind !== 'user') return
    const text = blocksToText(message?.content)
    if (!text) return
    broadcast(mission, text)
  })

  // ── 提示词引导：让工蜂主动上报工作概括（无任务时不注入任何内容）────────────
  {
    const sysPrompt = ctx.get('systemPrompt')
    if (sysPrompt && typeof sysPrompt.section === 'function') {
      try {
        sysPrompt.section({
          name: 'mission-control:reporting',
          order: 950,
          text: () =>
            missions.size === 0
              ? ''
              : [
                  '## 蜂巢任务工作汇报',
                  '你属于一个蜂巢任务团队。驾驶舱面板会实时显示每个成员的工作概括，',
                  '所以请在「开始做一件事」和「做完一件事」时调用 `mission_report`：',
                  '- `current`：你此刻在做的事，一句短中文（≤30 字），例如「优化界面显示」。',
                  '- `completed`：你刚完成的事，一句短中文，例如「构建协作插件框架」。',
                  '保持简短、说人话，不要粘贴日志或英文原文。',
                ].join('\n'),
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

  /** 结束任务：中断该会话下所有子智能体、清除任务状态、清理临时文件。 */
  async function endMissions(sessionId, options = {}) {
    const team = services.team()
    const interrupted = []
    const stopped = []
    for (const mission of [...missions.values()]) {
      if (sessionId && mission.sessionId !== sessionId) continue
      const agent = services.agents()?.get(mission.sessionId)
      if (agent && team) {
        // 「结束任务」要停掉所有子会话，不只本任务创建的成员
        for (const member of teammatesOf(agent)) {
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
    }

    let cleanup = { deleted: [], errors: [], root: undefined }
    if (options.cleanup !== false) {
      const firstAgent = stopped.map((id) => services.agents()?.get(id)).find(Boolean)
      cleanup = await cleanupTempFiles(workspaceOf(firstAgent))
    }
    return { ok: true, stopped: stopped.length, sessionIds: stopped, interrupted, cleanup }
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

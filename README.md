# Mission Control · 任务驾驶舱

> DeepSeek Harness 的 Agent Teams 插件：任务级人数上限、上下文哨兵自动交接、驾驶舱广播、蜂巢模式开关，以及一个实时进度悬浮窗。

Mission Control 让一个 Lead 会话把多个工蜂组织成一场「任务（Mission）」：会话头部一键开启蜂巢模式并锁定人数上限，运行中持续测量每个工蜂的上下文压力并在将满时自动换人续接，人类在会话里说的话立即扇出给全体成员，所有进度集中显示在每个主会话独立、可拖动、可折叠的悬浮窗里；结束时自动收集结果文件、归档子会话并提示 Lead 汇总。所有检测都在 Host 侧完成，不消耗任何会话的模型 token。

---

## 功能特性

### 四个工具

| 工具 | 作用 |
| --- | --- |
| `mission_start` | 在本会话声明一个任务，记录任务目标与并发工蜂上限 `workers`；之后才允许 `spawn_teammate`，超出上限的创建请求会被直接拒绝。 |
| `mission_report` | 工蜂自报工作概括：`current`（此刻在做什么）与 `completed`（刚做完什么），每行一句短中文，驾驶舱面板据此显示人话进度。 |
| `mission_status` | 只读地读取任务实时状态：每个工蜂的运行状态、上下文 token 占窗口比例、当前承担的任务。 |
| `mission_stop` | 结束本会话上的任务：清除人数上限并停止上下文哨兵。 |

> 也可以不用 `mission_start`：会话头部的「蜂巢模式开关」会按 `defaultCap` 建一个占位任务（目标为「等待任务…」，待 Lead 说明后再分配）。

### 支撑机制

1. **人数上限守卫（Workers Cap）**
   `mission_start`（或头部开关）用 `workers` 设定硬上限；`ctx.tools.guard` 在每次 `spawn_teammate` 前检查当前任务中处于 `running` / `provisioning` 的成员数，超限即拒绝，避免任务失控复制会话。

2. **上下文哨兵与自动交接（Context Sentinel & Handoff）**
   哨兵按 `pollIntervalMs` 定时用 `tokenMeter` 测量每个工蜂的上下文占用（分母取会话的 `contextWindow`，取不到时退回 `fallbackContextWindow`）。比例达到 `handoffRatio` 时：
   - 中断该成员；
   - 生成一份交接摘要（任务目标、任务板现状、前任最近 4 条进展记录、续任职责）；
   - 以 `fresh` 上下文新建续任者 `<name>-rN`，接手原成员未完成的工作。

3. **驾驶舱广播（Cockpit Broadcast）**
   任务进行中，人类在本会话发出的 `user/message` 会被立即包装成 `[驾驶舱广播] ...` 扇出给当前任务的全部工蜂，不必等 Lead 跑一轮模型再转述。**暂停时不下发**，但子会话仍继续工作。

4. **蜂巢模式开关与子会话管理（Hive Mode）**
   会话头部注入一个开关（`普通 / 蜂巢 / 已暂停`）+ 人数上限选择（2–10）+ 「子会话」管理弹窗：
   - 开启：建任务（或恢复暂停），主会话消息开始下发；
   - 关闭（暂停）：子会话继续工作，但主会话消息不再下发给子会话；
   - 「子会话」弹窗：列出该会话下所有子会话（名称、状态、描述），勾选后停止并归档（从侧边栏移除），可选删除其日志。

5. **实时进度悬浮窗（Dashboard）**
   `dashboard.js` 在 Web 客户端注入悬浮层（`shell.overlay`），每 2 秒轮询 `/mission-dashboard-v2.json`，**每个主会话渲染一个独立悬浮窗**：
   - 可拖动、可折叠，位置与折叠状态按会话分别保存在 `localStorage`，多窗口默认错开不重叠；
   - 标题显示会话标题（来自 `sessionTitle` 服务，取不到则回退「会话 <id 尾号>」）；
   - 显示工蜂状态徽标、上下文占用进度条（绿 → 黄 → 红）、当前任务、已完成任务、产出文件、暂停状态；
   - 「结束任务」按钮会先确认，再 `POST /mission-end-v1` 执行完整收尾；结束后弹出可拖动、可关闭的结束提示卡片，15 秒后自动消失。

   另外，任务进行中会通过 `systemPrompt.section` 注入一段「工作汇报」引导，促使工蜂主动调用 `mission_report`；没有任务时不注入任何内容。

### 结束任务（完整收尾）

点击「结束任务」或调用 `/mission-end-v1` 后，插件会依次：

1. 中断该会话下**所有**子会话（不只本任务创建的成员）；
2. 只清理 `cleanupGlobs` 匹配的临时文件与 `cleanupDirs` 目录（结果文件不动）；
3. 归档（关闭）所有子会话，让侧边栏不再堆积历史工蜂；若 `deleteSessionLogs: true` 则同时删除其日志文件；
4. 收集本次任务产出的**结果文件**：从各成员 `write` / `edit` 工具调用的参数里提取路径，再兜底扫描任务开始后修改过的文件；
5. 向 Lead 会话投递一条「【蜂巢任务已结束】」提示，要求 Lead 输出最终结果汇总并 `present` 交付物。

---

## 安装与启用

本插件以 **profile 本地链接（link）** 方式安装，不依赖 npm 发包。

1. 克隆仓库到本地：

   ```bash
   git clone https://github.com/Psychologist-jpg/mission-control.git
   ```

2. 在 DSH profile 的 `package.json`（通常位于 `~/.dsh/profiles/<profile>/package.json`）里加入依赖与 bundle：

   ```jsonc
   {
     "dependencies": {
       "@local/mission-control": "link:C:/path/to/mission-control"
     },
     "dsh": {
       "profile": {
         "bundles": [
           // ... 其他官方 bundle，例如 @deepseek-ai/dsh-experimental-agent-team-profile
           "@local/mission-control"
         ]
       }
     }
   }
   ```

3. 让 profile 重新安装依赖并重载 DSH 客户端。启动新会话后，会话头部出现蜂巢模式开关，页面右下角出现「蜂巢任务」悬浮窗，`mission_start` / `mission_report` / `mission_status` / `mission_stop` 四个工具也在工具列表中。

> 依赖 Agent Teams：本插件在 `package.json` 的 `peerDependencies` 中**强依赖** DSH 的实验性智能体团队插件 `@deepseek-ai/dsh-experimental-agent-team`（提供 `agentTeams` 服务）。此外还读取 `agents`、`sessions`、`tokenMeter`、`systemPrompt`、`webServer`、`workingDirectory`、`workspaceRegistry`、`sessionController` 等服务，因此 profile 中需要启用 `@deepseek-ai/dsh-experimental-agent-team-profile` 聚合包（或提供同名服务的等价包）。

---

## 配置

插件通过 bundle patch 声明并在激活时传入配置，默认配置见 [`cordis.patch.yml`](./cordis.patch.yml) 与 `index.js` 顶部的 `DEFAULT_CONFIG`：

| 配置项 | 默认值 | 说明 |
| --- | --- | --- |
| `pollIntervalMs` | `15000` | 上下文哨兵轮询间隔（毫秒，最小钳制到 2000）。 |
| `warnRatio` | `0.65` | 预警阈值，用于 `mission_start` 返回文案中的提示。 |
| `handoffRatio` | `0.85` | 触发自动交接的上下文占用比例。 |
| `defaultCap` | `3` | 默认人数上限（头部开关建任务时使用；`mission_start` 以显式 `workers` 为准）。 |
| `fallbackContextWindow` | `131072` | 拿不到真实上下文窗口大小时使用的分母。 |
| `freshProvider` | `"spawn"` | 交接时创建续任者使用的 provider 参数。 |
| `deleteSessionLogs` | `false` | 结束任务 / 删除子会话时是否物理删除其日志文件（默认仅归档，不删记录）。 |
| `cleanupGlobs` | `*.tmp`、`*.temp`、`*.log`、`*.bak`、`*.orig`、`*.rej`、`*.swp`、`*.swo`、`*~`、`.DS_Store`、`Thumbs.db` | 「结束任务」时删除的临时文件模式（仅按文件名匹配）。 |
| `cleanupDirs` | `[".mission-control/tmp"]` | 「结束任务」时整个删除的临时目录（相对工作目录）。 |
| `cleanupMaxFiles` | `500` | 单次清理删除文件数的上限。 |

示例：

```yaml
- insert:
    - id: mission-control
      name: '@local/mission-control'
      config:
        pollIntervalMs: 15000
        warnRatio: 0.65
        handoffRatio: 0.85
        defaultCap: 3
        freshProvider: spawn
        deleteSessionLogs: false
```

---

## HTTP 接口

插件通过 `webServer` 注册以下端点，均不消耗模型 token：

| 方法与路径 | 用途 |
| --- | --- |
| `GET /mission-dashboard-v2.json` | 驾驶舱快照：任务目标、人数上限、暂停状态、每个工蜂的状态 / token / 窗口 / 占用比例 / 工作概括，以及任务板的 pending / in_progress / completed 计数。 |
| `POST /mission-end-v1` | 结束任务：中断所有子会话、归档、收集结果文件、清理临时文件，并提示 Lead 汇总。请求体可选 `{ "sessionId": "...", "cleanup": true }`；不传 `sessionId` 时结束全部任务。响应含 `interrupted`、`cleanup`、`resultFiles`、`closed`、`leadNotified` 等字段。 |
| `POST /mission-mode-v1` | 蜂巢模式开关：`{ "sessionId": "...", "enabled": true, "workers": 3 }`。开启时按需建任务或恢复暂停；关闭时暂停（子会话继续工作，广播停止）；`workers` 被钳制到 2–10。 |
| `GET /mission-children-v1?sessionId=...` | 列出该会话下的所有子会话（id / 名称 / 状态 / 描述），供界面勾选删除。 |
| `POST /mission-delete-v1` | 删除指定子会话：`{ "sessionId": "...", "childIds": [...], "deleteLogs": false }`，执行停止 → 归档 →（可选）删日志。 |

---

## 目录结构

```text
mission-control/
├── index.js            # Host 侧插件：工具注册、人数守卫、上下文哨兵、广播、蜂巢模式、HTTP 路由、结果收集与清理
├── dashboard.js        # Web 客户端：会话头部蜂巢开关 + 子会话管理弹窗 + 悬浮窗（DSH ModuleLoader + React）
├── cordis.patch.yml    # 插件 bundle patch（插入插件并给出默认配置）
├── locale/
│   ├── en.json         # 英文标题与描述
│   └── zh.json         # 中文标题与描述
├── icon.svg            # 插件图标
└── package.json        # 包元数据与 dsh.bundle / dsh.client 声明
```

---

## 使用流程

1. Lead 开启会话头部的蜂巢模式开关（或调用 `mission_start`），给出任务目标与并发工蜂上限。
2. 用 `spawn_teammate` 创建工蜂；超过上限会被拒绝。
3. 工蜂在共享任务板上创建 / 认领任务，并随时用 `mission_report` 汇报进度。
4. Lead 与人类可随时查看悬浮窗或调用 `mission_status`；需要让子会话安静但继续工作时，可切换为「已暂停」。
5. 工蜂上下文将满时，哨兵自动中断并创建 `<name>-rN` 续任者，继承结构化摘要继续工作。
6. 结束时调用 `mission_stop`，或在悬浮窗点击「结束任务」执行完整收尾（停子会话 + 归档 + 收集结果文件 + 清理临时文件），随后按提示向用户汇总并 `present` 交付物。

---

## 注意事项

- **清理有边界**：「结束任务」只会删除 `cleanupGlobs` 匹配的文件与 `cleanupDirs` 指定的目录，且永远跳过 `node_modules` 与 `.git`；但如果你把 `cleanupGlobs` 配得过宽，仍可能误删工作文件，请谨慎配置。
- **日志删除默认关闭**：`deleteSessionLogs` 默认 `false`，结束 / 删除子会话时只归档、不删日志；如需物理删除，显式设为 `true`。
- **暂停语义**：暂停只停止「主会话 → 子会话」的消息下发，子会话本身继续运行，哨兵仍会监控并交接。
- **续任者命名**：交接产生的续任者形如 `team-name-r1`、`team-name-r2`，任务板上原有的归属不会自动迁移，续任者需自行认领未完成任务。
- **界面文案**：悬浮窗与开关目前以中文展示状态与字段。
- **隐私**：插件只读取 Host 侧会话元数据（事件类型、token 计数、任务板内容、工具调用参数中的路径），不会把会话正文发送到外部。

---

## License

[MIT](./LICENSE)

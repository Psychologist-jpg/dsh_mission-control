# Mission Control · 任务驾驶舱

> DeepSeek Harness 的 Agent Teams 插件：任务级人数上限、上下文哨兵自动交接、驾驶舱广播、蜂巢模式开关，以及一个实时进度悬浮窗。

Mission Control 让一个 Lead 会话把多个工蜂组织成一场「任务（Mission）」：会话头部一键开启蜂巢模式并锁定人数上限，运行中持续测量每个工蜂的上下文压力并在将满时自动换人续接，人类在会话里说的话立即扇出给全体成员，所有进度集中显示在每个主会话独立、可拖动、可折叠的悬浮窗里；结束时自动收集结果文件、归档子会话并提示 Lead 汇总。所有检测都在 Host 侧完成，不消耗任何会话的模型 token。

---

## 功能特性

### 七个工具

| 工具 | 作用 |
| --- | --- |
| `mission_start` | 在本会话声明一个任务，记录任务目标与并发工蜂上限 `workers`；之后才允许创建工蜂，超出上限的创建请求会被直接拒绝。重复调用可更新任务目标与上限。 |
| `mission_scale` | 按需**只补差额**地开子会话：传入期望的子会话清单（名称 + 自包含子任务，可选 `image` / `provider` / `model`），已存在的跳过、超出上限的拒绝，一次调用完成配平；生图子任务会顺带切到图像模型。 |
| `mission_set_model` | 把已存在的某个工蜂切换到另一个模型（通常是图像模型），或 `revert: true` 切回会话默认模型。 |
| `mission_image` | 用配置的图像模型真正出图并落盘到工作区（`prompt` / `path` / `size` / `model`），返回路径与字节数。**图像模型不能承担普通对话请求**，所以出图必须走这个工具，而不是切换对话模型。 |
| `mission_report` | 工蜂自报工作概括：`current`（此刻在做什么）与 `completed`（刚做完什么），每行一句短中文，驾驶舱面板据此显示人话进度。 |
| `mission_status` | 只读地读取任务实时状态：每个工蜂的运行状态、上下文 token 占窗口比例、当前承担的任务。 |
| `mission_stop` | 结束本会话上的任务：清除人数上限并停止上下文哨兵。 |

> 也可以不用 `mission_start`：会话头部的「蜂巢模式开关」会按 `defaultCap` 建一个占位任务（目标为「等待任务…」），**首条人类消息会自动写入为该任务的真实目标**（`taskAt` 标记已设目标）。

### 支撑机制

1. **人数上限守卫（Workers Cap）**
   `mission_start`（或头部开关）用 `workers` 设定硬上限；`ctx.tools.guard` 在每次 `spawn_teammate` 前检查当前任务中处于 `running` / `provisioning` 的成员数，超限即拒绝，避免任务失控复制会话。`mission_scale` 内部同样受该上限约束。

2. **任务拆解与人数配平（Mission Scale）**
   `missionScale()` 从任务板实时推算配平统计：待办/进行中的子任务数、未认领数、现有工蜂数、上限，以及「目标人数 = min(待认领子任务数, 上限)」与缺口 `gap`。这份统计会：
   - 通过 `/mission-dashboard-v2.json` 的 `scale` 字段输出，悬浮窗标题栏显示 `${workers}/${cap} 工蜂 · 待办 N · 建议再开 M`；
   - 驱动提示词：Lead 侧注入「先 `mission_start` → 建任务板 → 算人数 → `mission_scale` 一次开齐 → 自己只做协调验收」的分派契约；若已收到任务但工蜂不足，则改为强制催办「现在必须再开 N 个」；子会话侧则注入「只做分配的活 + 汇报」的身份约束。

3. **上下文哨兵与自动交接（Context Sentinel & Handoff）**
   哨兵按 `pollIntervalMs` 定时用 `tokenMeter` 测量每个工蜂的上下文占用（分母取会话的 `contextWindow`，取不到时退回 `fallbackContextWindow`）。比例达到 `handoffRatio` 时：
   - 中断该成员；
   - 生成一份交接摘要（任务目标、任务板现状、前任最近 4 条进展记录、续任职责）；
   - 以 `fresh` 上下文新建续任者 `<name>-rN`，接手原成员未完成的工作。

4. **驾驶舱广播（Cockpit Broadcast）**
   任务进行中，人类在本会话发出的 `user/message` 会被立即包装成 `[驾驶舱广播] ...` 扇出给当前任务的全部工蜂，不必等 Lead 跑一轮模型再转述。**暂停时不下发**，但子会话仍继续工作。广播前会先过滤出**存活成员**（会话目录仍在磁盘且未被归档），已删除/已归档的历史条目不再收到消息。

5. **蜂巢模式开关与子会话管理（Hive Mode）**
   会话头部注入一个开关（`普通 / 蜂巢 / 已暂停`）+ 人数上限选择（2–10）+ 「子会话」管理弹窗：
   - 开启：建任务（或恢复暂停），主会话消息开始下发；
   - 关闭（暂停）：子会话继续工作，但主会话消息不再下发给子会话；
   - 「子会话」弹窗：按 **普通会话 / 归档会话 / 已删除会话** 三组列出全部子会话（名称、状态、描述），并给出各组计数。勾选后可以：
     - **归档**：停止并移出会话列表，日志保留，可「取消归档」恢复；
     - **彻底删除**：停止 → 解除归档 → 删除磁盘上的会话日志目录与投影缓存（不可恢复），已删除条目变灰不可再选。
   - 花名册里会长期残留历史条目（平台无移除成员 API），因此「广播 / 结束归档 / 计数」都会先经 `liveMembers()` 过滤；`mission_scale` 生成的名字也会对**整份花名册**（含历史条目）去重，冲突时自动加 `-2`、`-3` 后缀。

6. **生图模型策略（Image Model Policy）**
   图像模型不支持 chat 协议（直接切会话模型会 404），因此插件把「生图」做成工具能力而非模型切换：
   - `mission_image` 直接调用配置的图像接口（默认 `qwen-image-2.1`，OpenAI 兼容 `/images/generations`，`response_format: b64_json`），把图片落盘到工作区，路径限制在工作目录内；
   - API key 优先从 DSH 凭据库取（`imageApiKeyRef`），取不到再回退同名环境变量；
   - `mission_scale` 支持按子任务文本命中生图关键词（`imageKeywords`）或显式 `image: true` 自动切到图像模型，也可用 `provider` / `model` 覆盖；`mission_set_model` 可事后切换或 `revert` 回默认；
   - 该自动切换受 `imageModelSwitch` 开关控制，**默认关闭**（守住「图像模型不能对话」这条线，只提供 `mission_image` 工具）。

7. **实时进度悬浮窗（Dashboard）**
   `dashboard.js` 在 Web 客户端注入悬浮层（`shell.overlay`），每 2 秒轮询 `/mission-dashboard-v2.json`，**每个主会话渲染一个独立悬浮窗**：
   - 可拖动、可折叠，位置与折叠状态按会话分别保存在 `localStorage`，多窗口默认错开不重叠；
   - 标题显示会话标题（来自 `sessionTitle` 服务，取不到则回退「会话 <id 尾号>」）；
   - 显示配平统计（现有/上限工蜂、待办数、建议再开数）、工蜂状态徽标、上下文占用进度条（绿 → 黄 → 红）、当前任务、已完成任务、产出文件、**当前模型**（优先取实际使用的模型，其次策略指定值）、暂停状态；
   - 「结束任务」按钮会先确认，再 `POST /mission-end-v1` 执行完整收尾；结束后弹出可拖动、可关闭的结束提示卡片，15 秒后自动消失。

   另外，任务进行中会通过 `systemPrompt.section` 注入「分派契约 / 催办 / 汇报」三段式提示（见上文「任务拆解与人数配平」），并提示子会话「需要生图时调用 `mission_image`，不要切换自己的对话模型」；没有任务时不注入任何内容。

### 结束任务（完整收尾）

点击「结束任务」或调用 `/mission-end-v1` 后，插件会依次：

1. 中断该会话下**所有存活**子会话（不只本任务创建的成员；已删除/已归档的历史条目跳过）；
2. 只清理 `cleanupGlobs` 匹配的临时文件与 `cleanupDirs` 目录（结果文件不动）；
3. 归档（关闭）所有存活子会话，让侧边栏不再堆积历史工蜂；若 `deleteSessionLogs: true` 则同时删除其日志文件；
4. 顺手清理**孤儿归档**：归档集合里指向「磁盘上已不存在的会话」的残留条目会被移除，避免集合无限膨胀；
5. 收集本次任务产出的**结果文件**：从各成员 `write` / `edit` 工具调用的参数里提取路径，再兜底扫描任务开始后修改过的文件；
6. 向 Lead 会话投递一条「【蜂巢任务已结束】」提示，要求 Lead 输出最终结果汇总并 `present` 交付物。

---

## 安装与启用

本插件以 **profile 本地链接（link）** 方式安装，不依赖 npm 发包。它**强依赖** DSH 实验性智能体团队插件，安装前需先准备好该依赖。

### 前置依赖

本插件在 `package.json` 的 `peerDependencies` 中声明了：

- `@deepseek-ai/dsh-experimental-agent-team`（提供 `agentTeams` 服务，必需）
- `@deepseek-ai/cordis`（DSH 宿主底座）

由于采用 `link:` 安装时包管理器不会自动补装 peer 依赖，请显式把聚合包 `@deepseek-ai/dsh-experimental-agent-team-profile`（内含核心 + 工具 + 客户端 UI）加入 profile 的 `dependencies` 与 `bundles`。

### 步骤

1. 克隆仓库到本地：

   ```bash
   git clone https://github.com/Psychologist-jpg/dsh_mission-control.git
   ```

2. 在 DSH profile 的 `package.json`（通常位于 `~/.dsh/profiles/<profile>/package.json`）里加入依赖与 bundle：

   ```jsonc
   {
     "dependencies": {
       "@deepseek-ai/dsh-experimental-agent-team-profile": "0.2.2-rc.1",
       "@local/mission-control": "link:C:/path/to/mission-control"
     },
     "dsh": {
       "profile": {
         "bundles": [
           // ... 其他官方 bundle
           "@deepseek-ai/dsh-experimental-agent-team-profile",
           "@local/mission-control"
         ]
       }
     }
   }
   ```

3. 让 profile 重新安装依赖（`pnpm install` 或由 DSH 桌面端触发）并重载客户端。

4. 启动新会话后，会话头部出现蜂巢模式开关，页面右下角出现「蜂巢任务」悬浮窗，`mission_start` / `mission_scale` / `mission_report` / `mission_status` / `mission_stop` 五个工具也在工具列表中。

> 依赖 Agent Teams：本插件读取 `agentTeams`（由 `@deepseek-ai/dsh-experimental-agent-team` 提供）、`agents`、`sessions`、`tokenMeter`、`systemPrompt`、`webServer`、`workingDirectory`、`workspaceRegistry`、`sessionController` 等服务；若你的 profile 已由其他 bundle 提供同名服务，可省略上面的 profile 聚合包，但必须保证 `agentTeams` 服务可用。

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
| `imageModelSwitch` | `false` | 是否允许按生图关键词自动把子会话切到图像模型（默认关闭，仅提供 `mission_image` 工具）。 |
| `imageProvider` | `"ustc"` | 图像模型 provider id。 |
| `imageModel` | `"qwen-image-2.1"` | 图像模型 id。 |
| `imageApiBaseUrl` | `"https://api.llm.ustc.edu.cn/v1"` | 图像接口基址（OpenAI 兼容 `/images/generations`）。 |
| `imageApiKeyRef` | `"USTC_API_KEY"` | 图像接口密钥名：优先取 DSH 凭据库，其次同名环境变量。 |
| `imageApiSize` | `"1024x1024"` | `mission_image` 默认出图尺寸。 |
| `imageKeywords` | `生图`、`生成图片`、`画图`、`绘制`、`插图`、`配图`、`出图`、`海报`、`封面图`、`示意图`、`图片生成`、`文生图`、`image`、`draw`、`illustration`、`poster` | 判定「需要生图」的关键词（大小写不敏感）。 |

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
        imageModelSwitch: false
        imageProvider: ustc
        imageModel: qwen-image-2.1
        imageApiBaseUrl: https://api.llm.ustc.edu.cn/v1
        imageApiKeyRef: USTC_API_KEY
        imageApiSize: 1024x1024
```

---

## HTTP 接口

插件通过 `webServer` 注册以下端点，均不消耗模型 token：

| 方法与路径 | 用途 |
| --- | --- |
| `GET /mission-dashboard-v2.json` | 驾驶舱快照：任务目标、`taskSet`（是否已设真实目标）、`scale`（配平统计：workers / cap / openTasks / unownedTasks / target / gap）、人数上限、暂停状态、每个工蜂的状态 / token / 窗口 / 占用比例 / **模型**（`model` 为策略指定值，`actualModel` 从会话事件里读到的实际使用模型）/ 工作概括，以及任务板的 pending / in_progress / completed 计数。 |
| `POST /mission-end-v1` | 结束任务：中断所有存活子会话、归档、清理孤儿归档、收集结果文件、清理临时文件，并提示 Lead 汇总。请求体可选 `{ "sessionId": "...", "cleanup": true }`；不传 `sessionId` 时结束全部任务。响应含 `interrupted`、`cleanup`、`resultFiles`、`closed`、`leadNotified`、`archivePruned` 等字段。 |
| `POST /mission-mode-v1` | 蜂巢模式开关：`{ "sessionId": "...", "enabled": true, "workers": 3 }`。开启时按需建任务或恢复暂停；关闭时暂停（子会话继续工作，广播停止）；`workers` 被钳制到 2–10。 |
| `GET /mission-children-v1?sessionId=...` | 列出该会话下的所有子会话（id / 名称 / 状态 / 描述），并按普通 → 归档 → 已删除排序；每条带 `archived`（是否已归档）与 `exists`（磁盘上是否还有会话目录）。可选 `includeArchived=1`、`includeDeleted=1`。响应另含 `total`、`activeCount`、`archivedCount`、`deletedCount`。 |
| `POST /mission-archive-v1` | 归档 / 取消归档（可逆）：`{ "sessionId": "...", "childIds": [...], "action": "archive" \| "unarchive" }`。归档会先停止运行中的会话；对磁盘上已不存在的会话只清理归档残留并报错提示。 |
| `POST /mission-delete-v1` | 删除指定子会话：`{ "sessionId": "...", "childIds": [...], "hard": true }`。默认**彻底删除**：停止 → 解除归档 → 删除会话日志目录与投影缓存（返回 `removedLogs`、`removedCaches`）；`hard: false` 退化为仅归档。 |

---

## 目录结构

```text
mission-control/
├── index.js            # Host 侧插件：工具注册、人数守卫、上下文哨兵、广播、蜂巢模式、模型策略、HTTP 路由、结果收集与清理
├── dashboard.js        # Web 客户端：会话头部蜂巢开关 + 子会话管理弹窗 + 悬浮窗（DSH ModuleLoader + React）
├── cordis.patch.yml    # 插件 bundle patch（插入插件并给出默认配置）
├── locale/
│   ├── en.json         # 英文标题与描述
│   └── zh.json         # 中文标题与描述
├── icon.svg            # 插件图标
└── package.json        # 包元数据（含 peerDependencies 强依赖声明）与 dsh.bundle / dsh.client 声明
```

---

## 使用流程

1. Lead 开启会话头部的蜂巢模式开关（或调用 `mission_start`），给出任务目标与并发工蜂上限；蜂巢模式下首条人类消息也会自动记录为任务目标。
2. Lead 把任务拆解成独立子任务建到共享任务板，按「目标 = min(子任务数, 上限)」算好人数。
3. 用 `mission_scale` 一次性开出所需子会话（只补差额，超上限拒绝）；之后仍可逐个 `spawn_teammate`。
4. 工蜂在共享任务板上认领任务，并随时用 `mission_report` 汇报进度；需要生成图片时调用 `mission_image` 出图（不要切换自己的对话模型）。
5. Lead 与人类可随时查看悬浮窗或调用 `mission_status`；需要让子会话安静但继续工作时，可切换为「已暂停」。
6. 工蜂上下文将满时，哨兵自动中断并创建 `<name>-rN` 续任者，继承结构化摘要继续工作。
7. 结束时调用 `mission_stop`，或在悬浮窗点击「结束任务」执行完整收尾（停子会话 + 归档 + 收集结果文件 + 清理临时文件），随后按提示向用户汇总并 `present` 交付物。

---

## 注意事项

- **清理有边界**：「结束任务」只会删除 `cleanupGlobs` 匹配的文件与 `cleanupDirs` 指定的目录，且永远跳过 `node_modules` 与 `.git`；但如果你把 `cleanupGlobs` 配得过宽，仍可能误删工作文件，请谨慎配置。
- **归档 vs 彻底删除**：归档可逆（日志保留，可「取消归档」恢复）；「彻底删除」会一并删除会话日志目录与投影缓存，**不可恢复**，请谨慎操作。
- **日志删除默认关闭**：`deleteSessionLogs` 默认 `false`，结束任务时只归档、不删日志；如需在收尾时物理删除，显式设为 `true`（子会话管理弹窗里的「彻底删除」不受此开关影响）。
- **历史条目不会自动消失**：平台没有移除成员的 API，花名册会长期保留已删除/已归档的子会话名；插件已在广播、结束归档、计数、命名去重处过滤/规避这些条目。
- **暂停语义**：暂停只停止「主会话 → 子会话」的消息下发，子会话本身继续运行，哨兵仍会监控并交接。
- **图像模型不能对话**：切换到图像模型的会话只适合出图，不能承担普通对话请求（会 404）。默认 `imageModelSwitch: false`，生图统一走 `mission_image`；确需自动切换时再开启。
- **生图凭据与出图范围**：`mission_image` 需要 `imageApiKeyRef` 指向的密钥（DSH 凭据库或同名环境变量），未配置会直接报错；输出路径被限制在工作目录内，越界会被拒绝。
- **续任者命名**：交接产生的续任者形如 `team-name-r1`、`team-name-r2`，任务板上原有的归属不会自动迁移，续任者需自行认领未完成任务。
- **界面文案**：悬浮窗与开关目前以中文展示状态与字段。
- **读取本地存储**：为识别归档与已删除会话，插件会读取 `$DSH_HOME/storages/workspace.json` 的归档集合，并扫描 `$DSH_HOME/sessions/` 下的会话目录（只读目录名，不读会话内容）。
- **网络请求**：除 `mission_image` 会向配置的图像接口发起 HTTPS 请求外，插件不发起任何外部网络调用；出图时会把 prompt 发送给该接口。
- **隐私**：插件只读取 Host 侧会话元数据（事件类型、token 计数、任务板内容、工具调用参数中的路径），不会把会话正文发送到外部。

---

## License

[MIT](./LICENSE)

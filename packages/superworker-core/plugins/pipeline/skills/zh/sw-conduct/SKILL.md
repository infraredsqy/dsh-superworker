---
name: sw-conduct
description: 指挥一个 DAG 节点从准备跑到收尾：派 Execute、独立复审、按需修复，最后关节点并决定派发还是停手。
disable-model-invocation: true
---

# sw-conduct

> 触发方：用户（`/sw-conduct <节点 id 或关键词>`）或管线派发（调用行带 `[pipeline]`）
> 职责：把单个 DAG 节点从准备带到收尾（准备 → 执行 → 复审 → 修复 → 收尾），再决定派发下一棒或停手
> Subagent 权限：派一层（Execute / Review / Fix / Doc-sync）；被派来的执行者读到本文件时应停手回报

你是当前节点的**指挥者**：代码修改与验证由 subagent 完成（`light` 节点除外），你负责统筹、记录与决策。一条 cycle 可按 `parallel` 策略同时运行多个节点，每个节点拥有独立会话与独立收尾。

### 四条红线

1. **不造节点、不动图**：需要拆节点或改图时停手，回到 `sw-route`。
2. **不改 `intention.md`，不篡改 `spec.md` 范围**：`intention.md` 严格只读（仅用户可改）；`spec.md` 作为契约不改目标与范围，仅当代码库演进导致其中现状数字/清单过期时刷新现值（老节点无 `intention.md` 时，`spec.md` 视同 `intention.md` 严格只读）。若发现需求本身站不住，停手交用户。
3. **不亲自读/改工程代码**：了解代码时派 subagent 并写清路径和问题。**`light` 节点例外**（见「重量」）。
4. **只派一层 subagent**：你派出的 Execute / Review / Fix 严禁继续往下派。管线接力通过宿主开启新会话完成——计划返回 `dispatch` 时你交票即止，由宿主开启下一棒。

## 配置项总览

`.superworker/` 档在准备第 0 步判定；其余在准备第 2 步一次读齐并记入 `run.md` 的「已核事实」。

| 配置项 | 取值 | 来源 | 影响范围 |
|---|---|---|---|
| `.superworker/` 档 | 提交档 / 本地档 | `git ls-files .superworker` | 同步、合回与收尾提交（见 [`docs/git-and-worktree.md`](docs/git-and-worktree.md)） |
| 模式（`mode`） | `manual` / `checkpoint` / `auto` | `dag info` | 是否停手、是否可向用户提问 |
| 重量（`weight`） | `light` / 缺省（`standard`） | `dag info` | 执行与修复谁动手 |
| 方法（`method`） | `spec.md` 中的 `method: <技能名>` | 读 `spec.md` | 节点按指定技能执行，优先级高于 `weight` |
| 测试档（`test_tier`） | `full` / `minimal`（默认 `full`） | `config get test_tier` | 写不写测试、每轮与收尾验什么 |
| worktree 档 | `off` / `fork`（默认）/ `reuse` | `config get worktree_mode` | 准备 fork 与收尾合回（见 [`docs/git-and-worktree.md`](docs/git-and-worktree.md)） |
| 子 agent 上限 | 正整数 | `config get max_agents` | 并行派发上限（见 [`shared/superworker/subagents.md`](shared/superworker/subagents.md)） |
| 并行策略（`parallel`） | 正整数 | `cycle current` 的 `Policy:` 行 | 当前线同时持有几个节点 |
| 节点 tag | `writing` / `coding` / `art` 等 | 图上（只读） | cycle 选材过滤（见 [`docs/conduct-node-tags.md`](docs/conduct-node-tags.md)） |

### 模式（`mode`）

| `mode` | 执行循环 | 行为 |
|---|---|---|
| `manual` | **不跑** execute→review→fix | 全程与用户对话推进；用户说「标成完成，继续」后按 `completed` 收尾并继续 |
| `checkpoint` | 跑 | 跑完循环与收尾后停下，等用户一句「继续」（见 [`docs/close-and-handoff.md`](docs/close-and-handoff.md)） |
| `auto` | 跑 | 自动接力，交票即止；仅卡死或需求冲突时上报用户 |

- **`checkpoint` / `auto` 节点全程禁止调用 `ask_user_question`**：遇拿不准处按最贴近意图的选项自主决策，并将选择与理由记入 `run.md` 的「自主决策清单」。`manual` 不受此限。
- 三档确认点及 `stop_after_nodes` / `inactive` 机制详见 [`docs/conduct-state.md`](docs/conduct-state.md)。

### 重量（`weight`）

- **`standard`（缺省）**：派 Execute subagent 写码与修复。
- **`light`**：**你亲自完成**读码、改码、跑快档、写 `report.md` 及修复轮（`fix-{N}.md`）；其余环节（独立 Review、每轮快档、收尾全量、完整报告集）一字不减。
  - `light` 节点上复审的 critical 由复审说了算：有争议就重跑一次复审，仍判不出来交用户。
  - 准备阶段若发现工作量撑不下 `light`（需读文件多、涉及接口设计），可升格按 `standard` 派 Execute 并记入「自主决策清单」；**不允许反向把 `standard` 降为 `light`**。`manual` 节点不跑循环，`light` 对它无额外含义。

### 方法（`method`）

当 `spec.md` 包含 `method: <技能名>` 时，读取 `~/.dsh/skills/<技能名>/SKILL.md`（若环境变量 `DSH_HOME` 已设则用 `$DSH_HOME/skills/<技能名>/SKILL.md`；传给 subagent 时必须展开为绝对路径）。

- **优先级：`method` 压过 `weight`**。清债/维护节点通常无 `weight`，不走「`standard` 派 Execute」路径。
- **层级自声明**：方法技能开头写明会派 subagent 的，由**你亲自按该技能执行**，不要塞给 Execute；写明不派的，按 `weight` 规则执行。方法技能派出的 subagent 仍不得再往下派。
- 由技能名推导路径的规则**仅适用于 `method:` 行**；工作区路径一律由工具返回，角色卡一律取 `<本 skill 目录>/...`。

### 测试档与验证

准备第 2 步读取 `config get test_tier`，随补充信息传给 Execute / Review / Fix（`light` 节点自己遵守）。这是项目级配置，不写进 spec。

| 维度 | `full`（完整套装） | `minimal`（一切从简） |
|---|---|---|
| 是否写测试 | 新增逻辑补测试，**只锁不变量**（不锁公式、快照或实现细节） | **默认不写**；仅当「不验就会静默出错」时补，并说明拦截哪种静默错 |
| 保留什么 | 全套；超标时由维护通道插入维护节点 | 仅保留数值/精度对拍、跨源结构一致性、极难触发的路径 |
| 每轮验证 | 快档（改动文件对应的用例） | 项目约定的检查项 / 探针 / 跑一局 |
| 复审看缺测试 | 该补未补 → 记问题 | 缺普通测试放过；缺防静默错验证 → 记问题 |

- **验证分档**：每轮跑快档，收尾跑一次全量（均以项目文档为准；`minimal` 档不造测试套件）。快档慢得忍不了时走测试体检插件（`doctor` 查看对应插件与方法），不要靠多跑或少跑全量来绕。报告必须附实际命令与计数，`full` 档还需附**全量套件实测耗时秒数**，无证据视同未跑。
- 若 spec 与项目文档均未写验证命令，停手请用户回 `sw-route` 补齐。
- 若项目为 `minimal` 档而 cycle 配了依赖全量套件耗时的读数，上报矛盾并附上关闭命令：`cycle policy <cycle> <旋钮名> off`（旋钮名从 `doctor` 的插件清单查，填读数槽名会被拒）。

### 并发三层上限

1. **图依赖边**：决定哪些节点**可以**并行。
2. **cycle 的 `parallel`**：决定该线同时**持有**几个节点。
3. **`config get max_agents`**：最外层硬顶，限制本会话同时**运行中**的 subagent 数（每次派发前按 [`shared/superworker/subagents.md`](shared/superworker/subagents.md) 计数）。

## 开局入口

管线命令统一经 `superworker` 工具调用（`word`、`args`、`help: true`），互不依赖的调用可在同一消息批量发出。

| 入口方式 | 下一步 |
|---|---|
| **管线派发**（调用行带 `[pipeline]` 与 `<节点 id>`） | 直接进入下方「准备」，收尾走完整管线收尾链 |
| **用户指定节点**（`/sw-conduct <节点 id 或关键词>`，无 `[pipeline]`） | 若给关键词先 `dag search` 定位（多命中让用户选）；进入「准备」，收尾只报结果并提交推送，**不跑 `handoff`/`settle`/`advance`** |
| **无参数 / `status` / 手动开机**（`/sw-conduct` 或 `/sw-conduct status`） | 先读 [`docs/startup.md`](docs/startup.md) 处理开局、选线或开机 |

## 准备

先确认当前工作区在项目根（`.superworker/` 的父目录）；若 `.superworker/` 尚未初始化（缺 `.gitignore` 与 `.gitattributes`），先执行一次 `init`。

### 0. 同步

检查 `git ls-files .superworker` 判断 `.superworker/` 是**提交档**（有输出）还是**本地档**（无输出）：
- 提交档且有 remote：在项目根执行 `git pull --rebase`。
- 本地档、无 remote、或遇到 rebase / 合并驱动冲突时：**读 [`docs/git-and-worktree.md`](docs/git-and-worktree.md) 按规程处理**。

### 1. 约束与策略

全局及当前 cycle 的指令已随上下文注入，需要核对时执行 `instruction list --project <项目根绝对路径>`。
- 新增指令只能走 `/sw-instruct`，归档/恢复只能由用户操作，`scope: global` 指令长期有效无需核销。
- 本线策略（`when_shelved`、`parallel`、`stop_after_nodes`、`model`、维护阈值）在 `cycle current` 的 `Policy:` 行查看，用 `cycle policy <cycle> <键> <值>` 修改（数值型用 `off` 取消）。

### 2. 一次读齐

1. `dag --help` 确认命令集。
2. `dag info <id> --verbose` 看节点详情与直接依赖，`dag context <id>` 看完整上下游。
3. `dag open <id>` 获取 `spec.md` 路径并读取；文件不存在则停手请用户回 `sw-route` 补写 spec。
4. 读取同目录 `intention.md`（若存在，严格只读；不存在则把 `spec.md` 视同 `intention.md` 只读）。
5. 若 `spec.md` 有 `method: <技能名>`，读对应技能的 `SKILL.md` 并按「方法」定执行方式。
6. 读 `spec.md` 引用的参考文件及项目 `CLAUDE.md` / 相关 `docs/`。
7. 读 `config get test_tier`、`config get worktree_mode`、`config get max_agents` 与 `cycle current`，记入 `run.md` 的「已核事实」。

### 3. 核验 spec（未通过不开工）

- **未决项**：对 spec 中真正的「或」「待确认」歧义逐条定归属（本节点做 / 不做 / 归别的节点），记入 `run.md` 的「自主决策清单」，不改 spec 原文（`manual` 节点当场问用户）。注意区分正常枚举或功能专名中的字眼。
- **硬约束标出处**：为「必须」「不许」「上限」类约束标明出处——用户原话 / 项目目标文档（`*goals*`）/ 前序推导值（预算、配额、并行数等）。只有前两类代表真实需求边界。
- **核对现状快照**：若 `spec.md` 中的模块数、文件名单、枚举已因代码演进过期，直接更新 `spec.md` 现值并在「自主决策清单」记一行（**不动 `intention.md`**，不写历史变更说明）。拿不准是否覆盖意图时，停手把 `intention.md` 与新现状摆给用户。
- **确认可执行完成判定**：无可执行判定（或全是「设计一下/调一调」）→ 停手请用户回 `sw-route` 补齐。

执行中撞见不属于本节点的既有问题，派一个 subagent 按已安装插件（`doctor` 查看）的口径记入对应记录即可，不扩大本节点范围。

### 4. 尺寸检查与 Worktree

- 若评估单个会话无法完成（含准备与复审），停手请用户回 `sw-route` 拆节点（做到一半发现撑不下同样停手）。
- 若 `worktree_mode` 为 `fork` 或 `reuse`：**读 [`docs/git-and-worktree.md`](docs/git-and-worktree.md) 完成前置检查与 worktree 创建**（`off` 档直接在主树执行，跳过 fork 与合回）。
- **绝不手动标 DAG 完成**——节点完成状态由收尾命令落笔。

## 执行循环

派发 subagent 后**不要轮询等待**，运行时会在完成后唤醒你；同批互不依赖的 subagent 放同一条消息。每次派发前按 [`shared/superworker/subagents.md`](shared/superworker/subagents.md) 检查并发上限。

### Execute

- **`standard` 节点**：派 Execute subagent（可读写、可跑命令），prompt 固定三项：
  1. 读 `<本 skill 目录>/subagent-prompts/execute.md` 并照做
  2. 节点 spec：`<spec.md 绝对路径>`
  3. 补充：`run.md`「已核事实」（测试档、worktree 路径、子 agent 上限、项目约定）、本节点注意事项及必读文档
- **`light` 节点**：你自己完成读码、改码、跑快档与写 `report.md`。
- **多文件并行**：操作一致时可并行派多个 subagent（受 `max_agents` 限制），它们**只改文件，不编译、不测试、不提交**；全数返回后再串行派一个集成验证 subagent 负责构建、修编译错误、跑测试并出报告。
- 收到 `report.md` 后核对四项是否齐全，含糊则要求补交。

### Review

- 派**一个只读 subagent**，prompt 固定三项：读 `<本 skill 目录>/subagent-prompts/review.md` / `spec.md` 绝对路径 / 本轮补充（判尺、注意事项与本轮报告名 `review-{N}.md`）。
- **两级结论**：
  - `critical`：阻塞交付的问题（目标未达、错误、违背 spec）——清零前不算通过。
  - `minor`：不值得再开一轮复审的细节问题——记录后修掉即可，**只有 minor 的轮次修完不再回审**。
- **争议裁决**：不认同某条 `critical` 时**严禁自行判误报**，把争议写成验证 prompt 重跑一次复审；仍无定论交用户。
- **中立原则（禁止泄漏上一轮）**：每轮复审 prompt 严禁包含上一轮问题原文、修复方做了什么或你的评价（直接沿用首轮补充即可）。仅当通用边界本身改变时（如用户调整范围），更新边界描述，不针对单条旧发现下禁令。

### Fix

不设轮数上限：

- **`critical > 0`**：派**新的** Fix subagent（角色卡 `<本 skill 目录>/subagent-prompts/fix.md`），修完回 Review。prompt 只给三项：
  1. `review-{N}.md` 路径（不要把问题原文抄进 prompt）
  2. 你已裁定的补充结论（每条一句话，仅写清单里没有的决策）
  3. 本轮报告路径（`fix-{N}.md`）
- **`critical = 0, minor > 0`**：派修复但不回 Review；由修复方跑快档并逐条核对自证。修不动的记入本轮报告与 `run.md` 的「已知未解决项」（在本节点收口，不传给下一节点）。
  - **可与收尾第 1 步 Doc-sync 并行派发**（修复只碰代码，清单中涉及 `docs/` 的条目交给 Doc-sync）。若本轮会改公共名称或接口，则先修完再派 Doc-sync。
- **`light` 节点**：由你亲自按 `subagent-prompts/fix.md` 的纪律修复并写 `fix-{N}.md`。
- **卡死识别**：同一问题反复修不动，或连续两轮复审的同一性标记落在同一批位置时，停下核对 spec 与项目目标文档：
  - 若冲突源于你自己推导出的约束（预算、配额、上限等）：直接修改或删掉该推导约束，记入「自主决策清单」后继续。
  - 若对照 spec 与目标文档仍无法裁决：停手上报用户，标为「已知未解决」，附证据与已尝试方案。

### 报告规范

报告统一放在 `.superworker/nodes/<节点 uuid>/` 根下（不建阶段子目录）：首轮执行 `report.md`、第 N 轮复审 `review-{N}.md`、对应修复 `fix-{N}.md`、节点总回执 `run.md`。原始输出、长引用与探针数据放同目录 `temp/`，报告只写路径。

- `report.md` / `fix-{N}.md` 是回执（几十行）：做了什么、改了哪、验证读数，一行一条；一个节点只留一份 `report.md`。
- `review-{N}.md` 是判断载体：写清到修复方可直接动手的程度，不以行数卡死。
- 只写读者手上没有的信息；过期读数直接覆盖或删除，不留旧指针。
- 面向用户的汇报（收尾、停手、checkpoint）遵守 [`shared/superworker/talking.md`](shared/superworker/talking.md)。

## 收尾

按顺序执行以下 9 步（仅第 1、2 步并行）：

| 步骤 | 动作 |
|---|---|
| 1. 文档同步 | 派 Doc-sync subagent（`subagent-prompts/doc-sync.md`），只写已实现内容，**在工作树上跑**（`fork` 在 worktree，`off` 在主树） |
| 2. 写 `run.md` | 趁 Doc-sync 运行期间写 `.superworker/nodes/<uuid>/run.md`（四节：做了什么、自主决策清单、已知未解决项、已核事实 + 改动清单与报告路径；Doc-sync 返回后补上同步出的文档）。提交档落工作树，本地档落主树 |
| 3. 合回 | 若走 `worktree_mode=fork`，按 [`docs/git-and-worktree.md`](docs/git-and-worktree.md) 提交节点并 squash 合回主树（`off` 档直接提交本节点 `feat:`） |
| 4. 全量验证 | 在主树跑一次全量（`full` 档含慢档并**记录实测耗时秒数**；`minimal` 档跑项目约定检查项），失败当场修；合回后若他线又合入新提交需重跑再报数。`fork` 档全量通过后清理 worktree 与分支（见 [`docs/git-and-worktree.md`](docs/git-and-worktree.md)） |
| 5. 自查 | 核对指令清单无遗漏；交付物、报告集、`.superworker/nodes/<uuid>/temp/` 各归其位（`temp/` 永不进版本库） |
| 6. 关节点 | 仅 `[pipeline]` 派发执行：`handoff --form` → `handoff` → `settle`（详规见 [`docs/close-and-handoff.md`](docs/close-and-handoff.md)） |
| 7. 提交记录 | 提交关节点产生的图、cycle 与交接单（提交档 vs 本地档命令见 [`docs/git-and-worktree.md`](docs/git-and-worktree.md)） |
| 8. Push | 推送所有应推的提交，遇拒先 `git pull --rebase` 再推，冲突交用户；**全部推成功后才进入第 9 步** |
| 9. 推进 | 执行 `advance --cycle <cycle> --json` 并按返回的 `action` 收手或提示（详规见 [`docs/close-and-handoff.md`](docs/close-and-handoff.md)） |

- **进入第 6 步前，读 [`docs/close-and-handoff.md`](docs/close-and-handoff.md)**，获取 `handoff -o` 读数口径、`checkpoint` / 维护节点 / `failed` & `stopped` 及 `advance` 动作处理。
- **手动触发（无 `[pipeline]`）**：跳过第 6、9 步，完成提交推送并向用户汇报产物位置即可。

## 参照与反模式

所有相对路径均以本 skill 目录为基准（可用 `cd ~/.dsh/skills/sw-conduct/ && pwd` 获取绝对路径；若设了 `DSH_HOME` 则用 `$DSH_HOME/skills/sw-conduct/`；传给 subagent 必须用绝对路径）：

- 契约、状态机与不变量：[`docs/conduct-state.md`](docs/conduct-state.md)
- 手动开局与选线：[`docs/startup.md`](docs/startup.md)
- 同步、双档提交与 worktree 手册：[`docs/git-and-worktree.md`](docs/git-and-worktree.md)
- 收尾命令、交接单读数与 `advance` 动作：[`docs/close-and-handoff.md`](docs/close-and-handoff.md)
- 节点 tag 过滤语义：[`docs/conduct-node-tags.md`](docs/conduct-node-tags.md)
- 派发通路与宿主接力机制：[`docs/conduct-dsh-dispatch.md`](docs/conduct-dsh-dispatch.md)
- 角色卡：`subagent-prompts/`（`execute.md` / `review.md` / `fix.md` / `doc-sync.md`）
- 插件清单与旋钮名：运行 `doctor`
- **反模式**：开工前读 [`./anti-patterns.md`](./anti-patterns.md) 对照自查。

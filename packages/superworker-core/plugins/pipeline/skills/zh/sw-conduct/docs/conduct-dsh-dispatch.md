# DSH 派发链（conduct 管线）

> 面向会话的操作指引见 [`close-and-handoff.md`](close-and-handoff.md)（收尾与 `advance` 动作）和 [`startup.md`](startup.md)（手动开局）。
> 本文件记录**设计原因**与**故障排查**，供定位派发问题时对照。整条派发链仅涉及三个模块：面板接力（`src/host/relay.ts`）、原生会话启动器（`src/host/executor.ts`）与引擎派发入口（`packages/superworker-core/src/conductor.ts`）。不存在外部 spawner 脚本，也没有任何步骤拼接 CLI `argv`。

## 1. 会话由谁启动

**两种触发方式均由宿主自身执行，走同一条代码路径：**

- **面板手动派发**：`dispatchCell`（`relay.ts`）在单次调用内完成三步——引擎 `conductor.dispatch` 按需落盘派发材料（仅在 prompt 尚未落盘时）、调用执行器接缝启动会话、确认会话成功创建后再写入 `started` 认领标记。
- **自动接力**：由 `turn/end` 事件触发，同样调用 `dispatchCell`。接力仅监听**本宿主自身创建的会话**（`dispatch` 返回时记入 `tracked` 表）。每轮结束后，宿主自动执行 `advance`：计划为 `dispatch` 时启动下一批会话，计划为 `wait` 时严格停止、不越权推进。`autoRelay` 开关（默认开启）仅控制自动触发，关闭后不影响面板按钮手动派发。

**唯一接缝是 `Executor`**：引擎只调用 `dispatch(request)`，自身从不直接创建会话。宿主将 `openNodeSession`（`executor.ts`）挂载到该接缝上，单次启动分五步：
1. 检测宿主是否提供 `agents` 服务（缺失则报错拒绝，明确指出缺失组件）。
2. 从记录目录读取该节点的 prompt（`<record>/meta/launch/<cycle>/<node>/prompt.txt`）。
3. 在对应工作区下创建 agent 与会话并关联到该工作区（仅传 `cwd` 创建的会话不会归入任何分组，会在面板中散落到「未分组」）。
4. 先注册本轮结束监听器，再将 prompt 作为首条指令送入会话。
5. 为该节点写入一条 `run` 备忘。会话 ID 由宿主生成（`session-<uuid>`），仅作面板导航寻址用，不对用户暴露。

**prompt 仅包含单行调用命令**（`prepare.ts` 中的 `promptTextOf`：`/sw-conduct <node-id> [pipeline]`），不含其他冗余信息。节点标题、spec 路径与收尾命令均由会话按需自查；用户指令也不拼进 prompt，而是由宿主随每轮上下文动态注入（无可见指令或关闭 `injectInstructions` 时不注入）。把动态信息拼进静态 prompt 只会制造过期副本。

## 2. 引擎与磁盘写入顺序

```
读取 started 认领 -> 插件派发闸 -> 落盘材料（仅 prompt 缺失时） -> executor.dispatch -> 写入 started
```

- **先读认领**：`conductor.dispatch` 首先检查该节点的 `started` 标记是否已落盘；若已存在，直接返回 `already_open`，不写任何文件，也不调用 executor。
- **后落材料**：若 prompt 已在盘上则跳过准备；否则由 `prepareDispatch` 写入 prompt 与本轮 `run.md`（`run.md` 独占创建，已存在则保持不动）。标准流程中，`hold` 只写认领，材料统一在 `dispatch` 阶段落盘。
- **最后写认领**：仅在会话确认创建成功后才写入 `started`。若此时写盘失败，按严重事故处理：会话已启动但磁盘无记录，调用直接抛错并附带会话 ID，提示「再次派发将启动重复会话」。
- **派发闸前置**：插件可在派发时机拒绝启动，理由逐条记入 `dispatch_blocked`。被拦截时不落盘 prompt、不开会话，上一步已钉住（`hold`）的节点保持原状，仍留在该 cycle 手里。
- **顺序代价**：一旦 `started` 落盘，`plan` 即视该节点为运行中，永不重复派发。因此「先确认可开、再落认领」必须由启动侧保证；无 opener 进程的行为见下一节。

## 3. 无 opener 进程：零写入原则

引擎命令层（`answer()`）中涉及拉起会话的命令都会先检查**当前进程是否具备启动会话的能力**（`io.openerAvailable`，由调用方通过 `sessionOpenerAvailable()` 传入，排练模式下恒为真）。`settle` 不启动会话，不受此检查影响。

- **`dispatch <cycle>`**：先逐节点读取磁盘上的 `started` 标记，已存在则记为「已启动」；仅对尚未启动的节点继续。若确认当前进程无 opener，**在进入引擎前直接拒绝**：返回退出码 `2`，不写任何字节，并在提示中说明应通过面板（超级工坊）派发、prompt 预期落盘位置以及面板派发时会负责落盘材料，同时给出人工补救的两条路径（在面板点击派发，或新开会话粘贴调用行）。若无可派发节点，则提示已启动的节点不会重复派发。
- **`advance`**：正常输出计划并钉住节点，但不落盘材料（材料归派发步骤），启动阶段仅在结果中写入 `spawn_error`，不认领任何节点、不进入引擎。这样可避免占位 opener 在写完认领后才报错，留下「已标记运行、实际无会话」的僵死状态。
- **`settle <node>`**：仅记录步骤、更新节点状态并执行收尾插件接缝，不写 prompt、不开会话。这正是技能将收尾拆为 `settle` 与 `advance` 两条命令的原因：前者落账，后者负责钉住、落材料与派发。

**排练模式（Dry Run）**：当环境变量 `DSH_CONDUCT_SPAWN_DRY_RUN` 不为空且不为 `0` / `false` / `False` 时，`engine.mjs` 会向引擎注入 `SimulatedExecutor`：走完完整调用链并返回模拟会话 ID `sess-N`，但不真实创建会话，也不落盘 `started`。排练不会在磁盘留下需清理的痕迹，演练完成后可直接执行真实派发。

**宿主侧同样遵循该开关**：排练模式下原生 opener 不创建 agent，返回 `host: "drill"` 且不含会话 ID（接力因此不会将其纳入追踪），同样不写认领，无需任何回滚。

## 4. 派发链的失败模式与排查

- **启动被拒**：`openNodeSession` 的每次拒绝都返回错误码与说明（如 `no-session-service`、`prompt-missing`、`open-failed`）。executor 抛错时，引擎不写 `started`（材料可能已落盘）、不改记录，错误原样透传：面板按钮直接展示给用户，自动接力仅记一行 warn 日志而不向事件总线抛异常。
- **会话已开但认领未落盘**：引擎抛错并给出会话 ID，提示先补写认领。此时盘上有 prompt 但无 `started`，下一次派发会重复拉起会话——应按错误提示补写认领，或撤销后重来。
- **会话已死但认领仍在**：`started` 是唯一的「已启动」依据，`plan` 不会再次派发。唯一恢复路径：执行 `cycle retry <cycle> <node> --drop`（同时撤销认领与旧交接票），再 `hold <node> --cycle <cycle>`，最后 `dispatch <cycle>`。
- **双线并行撞锁**：另一条运行中的 cycle 可能正在同一工作树上执行 git，写操作遇到 `index.lock` 属于瞬时冲突。等待数秒后重试同一命令，若重试两三次仍未释放，立即停手交由用户处理——锁文件属于存活进程，严禁手动删除。
- **排查顺序**：面板看不到会话 → 检查会话挂载的工作区；按钮派发被拒 → 阅读返回的 `detail` 字段；因缺少 opener 被拒 → 说明当前进程本身不具备拉起会话的能力，与配置无关。

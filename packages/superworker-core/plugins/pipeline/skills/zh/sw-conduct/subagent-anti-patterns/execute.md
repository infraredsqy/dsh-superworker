# Execute / Fix Subagent 常见反模式

执行 spec 前先对照检查。完整判据见 [`../subagent-prompts/execute.md`](../subagent-prompts/execute.md)，本文件仅列出症状与纠正信号。

## `conduct-execute-modifies-spec` · 执行侧修改 `spec.md`

**症状**：认为 spec 中某条不合理便按自身理解修改，或把某个「待确认」项凭猜测敲定。

**纠正信号**：报告中出现 spec 之外的目标，且 `spec.md` 的修改时间晚于开工时刻。

## `conduct-execute-adds-out-of-scope-work` · 抢做他节点职责或违背明确排除项

**症状**：跨出本节点目标去实现下游或并行节点明确认领的功能，或偷偷做了「不做的事」里已否决的方案（为达成 `intention.md` 而连带清理同域旧骨架、旧样式不属此类）。

**纠正信号**：改动清单触及他节点认领的独立功能，或违背 `intention.md`／`spec.md` 的明确排除项。

## `conduct-execute-parallel-edits-other-file-group` · 并行执行期间改动他组文件

**症状**：并行执行时修改了不属于自己文件组的文件，与其他 agent 产生写冲突。

**纠正信号**：改动清单中出现了未分配给你的文件。

## `conduct-execute-does-not-stop-on-blocker` · 遇阻或正面冲突未停手上报

**症状**：测试反复失败仍不断重试；发现旧骨架/旧样式与 `intention.md` 或参照物正面冲突却用局部补丁硬盖、并以「spec 条款已过，属结构取舍」交差；或对拿不准的操作盲目试探。

**纠正信号**：报告里通篇是「再试一次」，或用「属结构取舍」解释成品与意图/参照物的明显割裂，却没有上报 `FAIL`。

## `conduct-execute-runs-irreversible-operations` · 执行不可逆操作

**症状**：以「修复问题」为由执行破坏性操作——批量删除文件或目录、`git reset --hard`、大范围覆盖或删除 `.git`。

**纠正信号**：动手前答不出「这一步如何回退」。

## `conduct-execute-continues-past-failing-tests` · 测试失败仍继续推进

**症状**：报告某项测试失败，却补一句「不影响后续逻辑」直接跳过。

**纠正信号**：报告中的测试通过记录与本轮修改的文件范围对不上。

## `conduct-execute-assumes-failure-preexisting` · 自行认定失败为既有问题

**症状**：看到测试失败便直接归因为「之前就坏了」，随即跳过。

**纠正信号**：报告里只有结论，没有具体测试名、执行命令和失败输出。

## `conduct-execute-vague-deviation-report` · 偏差报告未逐条写清

**症状**：实际执行与 spec 存在出入，报告里只用「做了些小调整」一笔带过。

**纠正信号**：偏差栏只有模糊形容词，看不出具体在哪一处偏离、实际如何处理。

## `conduct-execute-pastes-evidence-into-report` · 将大段证据材料贴入报告正文

**症状**：把命令原始输出、合成样本、哈希值或长段引用整块贴进 `report.md`，导致一份交付文件配出上千行说明。

**纠正信号**：报告冗长到下游环节难以读完，且大半内容是读者手上已有的材料。

## `conduct-execute-appends-stale-readings` · 过期读数只追加不更正

**症状**：正文数据更新后，不直接修正旧值，而是在旁边追加「**历史读数**：……」，导致报告从几百行膨胀到两千多行（示例：某节点正稿 429 行，`report.md` 达 2017 行）。

**纠正信号**：同一份报告中同一指标出现多个数值，且旧值标注为「历史」。

## `conduct-execute-dispatches-on-conductor-instructions` · 依指挥者说明继续派发 subagent

**症状**：看到 spec 或方法技能中写着「按改动域分批，每批派 Fix / Review，通过即提交」，便在执行侧自行派发 subagent，造成多层嵌套派发。

**纠正信号**：执行步骤中出现了派发动作，而你的 prompt 并未授予该职责。

## `conduct-execute-defers-as-delivery` · 以「已知未解决」替代实际交付

**症状**：spec 中某项当前无法完成，直接标为「已知未解决」即宣告交差。

**纠正信号**：报告以「已知未解决」收尾，却未说明缺什么条件、由谁解决以及影响哪些验收项。

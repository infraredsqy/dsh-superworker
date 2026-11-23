---
name: sw-issue-repair
description: 修复 issue 池中可执行的债直至达标：按改动域分批，每批 Fix → Review，复审通过即提交。
disable-model-invocation: true
---

# sw-issue-repair

> 所属插件：`issue`（随插件安装/卸载）。
> 调用方：指挥者（管线节点指挥者或用户会话）。
> 职责：将 issue 池中可修条目修至目标达标（按调用方指定的度量阈值或批次范围）。
> 是否派发 subagent：是，仅一层（Fix / Review）；被派发的执行者若读到此文件，停手回报。

所有条目均来自 issue 池，工具与口径见 [`./pool.md`](./pool.md)。**修复范围由调用方决定**（管线节点 `spec.md`、插入说明或用户指令），不得自行扩大到全库；完成判定达成即停手。

所有管线命令均通过 `superworker` 工具调用（传 `word` 与 `args`，加 `help` 查看用法）。

## 处置原则

每条债如何处置，唯一判据是**是否已有明确裁定**，不得按「涉及哪一层」「体量大小」「属于哪个 cycle」做判断：

| 状态 | 特征 | 处置 |
|---|---|---|
| **已有裁定** | `reason` / `suggestion` 已写清修法与规则，或挂有 `plan_path`（即 `decision=autofix`） | **直接修复**，完成后 `resolve` |
| **仍待裁定** | 尚无定案且只能由用户权衡；或按既有方案实施时发现行不通 | `update --decision external`，`--reason` 写清两个选项与各自代价 |
| **不是债** | 核查后问题不成立 | `reject`，`--reason` 写清不修原因 |

出口仅此三个：`acknowledge`（暂缓）由 `/sw-issue-discuss` 处理，本技能不使用。

两条硬约束：

- **本轮排不下的条目保持原样**：权重照常计入，在汇报中点名说明。
- **读数如实汇报**：未降至阈值以下就如实报告并点名阻塞项；在管线节点中运行时，未达标必须将节点记为 `failed` 并在 `-s` 中写明实测读数，禁止记为 `completed`。

## 取材与分诊

1. **确认完成标准**：读取调用方要求——是某项度量达标（如 `issue weight -v` 降至阈值以下），还是指定批次全部进入终态。
2. **拉取待处理条目**：取 **actionable**（`open` / `acknowledged` / `resolving`，口径见 [`./pool.md`](./pool.md)；仅滤 `--status open` 会漏掉 `acknowledged`）且 `decision=autofix` 的条目，按严重度排序（按需加 `--severity` / `--module` 收窄范围）。
3. **现场分诊 `unknown`**：对 `decision=unknown` 的条目当场按处置原则定案——可修的改判 `autofix` 并排入本轮，需用户权衡的改判 `external`。`decision=external` 不修。
4. **遵循既有方案**：`reason` / `suggestion` 已写清修法的直接照办，不重新讨论；挂有 `plan_path` 的先读取设计文档。

## 执行循环

主循环与指挥者职责边界沿用 `/sw-conduct`，本技能仅补充三条：

- **按改动域分批，受并发上限约束**：同一模块的条目归为一批；确需跨模块的改动族整批显式声明，确保单批改动可被同一次验证覆盖。每批 Fix + Review 占 2 个并发名额，多批并行前先核对 `config get max_agents`。
- **每批执行 Fix → Review**：Fix 与 Review 分别读取本技能目录下的 `subagent-prompts/fix.md` 与 `subagent-prompts/review.md`（Review 只读）。这两份文件是 `sw-conduct/subagent-prompts/` 同名角色卡的副本（见 `subagent-prompts/README.md`），保证单独安装 `issue` 插件时同样可读。派发 prompt 至少写明三项：本批负责的条目清单、验证命令、报告输出路径（若同时安装了 `sw-conduct`，遵循其「Fix」一节）。
- **批过即 commit**：整批 Review 无阻塞问题后立即提交。脱离管线独立运行时没有节点收尾阶段，提交就落在这里。

Review 结果处理：`critical > 0` → 派新一轮 Fix，修完重回 Review；明确无害的 `minor` → 记为新条目留给后续同域批次，其余照修。

修复过程中新发现的债照常 `add` 入池（口径见 [`./pool.md`](./pool.md)），并**当场处置**：同批同域能收的顺手收掉，收不动的按处置原则落定。新条目照实计入当前读数，不得以「刚发现」为由排除。

## 落定

所有条目必须明确落定，不留中间态：

```pwsh
issue resolve <id…> --reason "<修改位置与验证读数>"
issue update  <id…> --decision external --reason "<两个方案与各自代价>"
issue reject  <id…> --reason "<不修原因>"
```

同一发提交、同一验证读数关闭的一批条目，用 `<id…>` 一次写完；每条 `reason` 不同的改判走 `update --from-file <行文件>`。

**只能由用户拍板的条目一条也不许代定**：逐条写入汇报的「留给人」一节，附上两个方案与各自代价。

## 汇报

- **批次构成**：每批包含哪些条目、所属改动域、对应 commit
- **落定表**：`resolve` / `external` / `reject` 各自条数，逐条一行
- **标准读数**：目标指标当前实测值（如 `issue weight -v`）
- **留给人**：逐条写清取舍点与各方案代价
- **已知未解决项**：本轮未处理的条目逐条列出（ID、未处理原因、下一轮接手条件），无则写「无」

## 反模式

开始前对照 [`./anti-patterns.md`](./anti-patterns.md) 自查。

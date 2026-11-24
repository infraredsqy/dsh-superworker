---
name: sw-issue-scan
description: 扫描项目代码发现尚未入池的质量债并入库，同时核对已有条目是否仍然存在。
disable-model-invocation: true
---

# sw-issue-scan

> 所属插件：`issue`（随插件安装/卸载）。
> 调用方：用户（`/sw-issue-scan`）或指挥者（管线节点 `spec.md` 的 `method: ` 行点名）。
> 职责：扫描新债并入池，同时核对在位条目是否存活。
> 是否派发 subagent：是，仅一层（scan）；被派发的执行者若读到此文件，停手回报。

扫描阶段**不修代码、不与用户讨论、不裁定 `decision`**——新条目一律保持默认 `unknown`，裁定留给后续 `/sw-issue-discuss`（扫描时做的裁定等到动手时容易过期）。

池子工具与口径见 [`../sw-issue-repair/pool.md`](../sw-issue-repair/pool.md)。所有管线命令均通过 `superworker` 工具调用（传 `word` 与 `args`，加 `help` 查看用法）。

## 派发前输入

派发 scan subagent 前，先理清项目模块划分、架构约定与代码范围，并通过 `issue status` 拿计数、`issue list` 拿**在位条目清单**（默认只列未结的），供本轮存活核对使用。

## 派发扫描

按 **模块 × 维度** 拆分扫描面（使用带写工具的 subagent，发现需落盘），每个扫描面只覆盖一份目标。维度为：重复代码、职责越界、结构问题；模块仅有一两个时可自行合并维度。

按 `config get max_agents` 的并发上限控制批次：**单个 subagent 可承担多个扫描面**，据此决定合并与分批。

每个 prompt 必须包含：

- 角色卡绝对路径：`<本技能目录>/scan.md`（角色、输出格式与禁令均在其中）
- 项目架构约定与分配的文件清单（承担几份就列几份）
- 在位条目清单（用于存活核对）
- 输出路径：`.superworker/meta/scan/<module-slug>.json`（承担几份就写几个文件，每份对应一个文件）

等整批 subagent 全部返回后再进入合并。

## 合并入库

1. 读取所有 `.superworker/meta/scan/*.json`
2. **去重合并**：若两条发现的 `files` 有交集，且（`functions` 有交集或 `description` 语义相近），合并为一条——保留描述更详细的一份，吸收另一份的 `files` 与 `functions`
3. **批量入池**：执行 `add --from-file <合并后的>.json --auto-id`（行格式见 [`../sw-issue-repair/pool.md`](../sw-issue-repair/pool.md)「批量操作」一节，禁止逐条 `add`）；跨多文件且需设计新组件的条目另挂 `--plan-path .superworker/issues/specs/<id>.md`
4. **存活核对**：汇总各 scan 返回的 `alive_ids` → 执行 `mark <ids>`（仅累加 `check_count` 并报告 `candidates`，**绝不改状态**）。关闭条目只能逐条 `resolve <id> --reason`，且仅在该条目有 scan 明确的「三层定位均找不到」报告时执行；刚入库的新条目不在名单中属正常现象
5. 清理 `.superworker/meta/scan/` 下的临时文件
6. 汇报：新增 N 条（按严重度分布）、存活核对结果、`candidates` 名单

## 边界

- **仅用户或指挥者可运行**：本技能会派发 subagent
- 不修代码、不改 spec、不建 DAG 节点——任务排序属于 DAG
- 遇到「应进图的新功能」在汇报中记一句提示用户，由 `/sw-route` 建节点
- 大规模重构信号单独立条，阈值与口径见 [`../sw-issue-repair/pool.md`](../sw-issue-repair/pool.md)

## 反模式

开始前对照 [`./anti-patterns.md`](./anti-patterns.md) 自查。

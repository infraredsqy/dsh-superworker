---
name: sw-issue-discuss
description: issue 池的人机交互入口：记录新条目、查看现状、复核并逐批裁定 external 条目。
disable-model-invocation: true
---

# sw-issue-discuss

> 所属插件：`issue`（随插件安装/卸载）。
> 调用方：用户（`/sw-issue-discuss`）。
> 职责：读写 issue 池并做裁定——录入条目、报告现状、复核并逐批敲定 `autofix` / `external`。
> 是否派发 subagent：否。批量修复走 `/sw-issue-repair`，代码扫描走 `/sw-issue-scan`。

池子的工具用法与字段口径见 [`../sw-issue-repair/pool.md`](../sw-issue-repair/pool.md)。所有管线命令均通过 `superworker` 工具调用（传 `word` 与 `args`，加 `help` 查看用法）。

## 识别用户意图

| 用户输入示例 | 处理方式 |
|---|---|
| 「hover 时高亮盖住了展开箭头」 | **记录**：生成 kebab-case id，执行 `add --severity P3 --decision unknown --source manual --title "<原话>"`，回复「已记：`<id>`」 |
| 「池子里现在有多少」 | **看现状**：执行 `status` + `top --limit 10`，报告总数及按严重度、`source` 的分布 |
| 「那条修好了」 | **关闭**：用 `search` 定位后执行 `resolve <id>`；存在歧义时列出候选项请用户确认 |
| 「陪我过一遍 external」 | **裁定**：先复核过滤，再逐批讨论 |
| 「把这条 bug 修了」 | 单条调试在当前会话直接处理；同域批量清债转 `/sw-issue-repair` |

记录新条目时不追问，一句话即可入库；若用户顺带提到了文件或模块，一并填入 `--module` / `--files` / `--description`。

## 裁定流程

### 1. 先复核，过滤伪 `external`

逐条检查 `decision=external` 的条目：若 `suggestion` 已明确到无需人工权衡，直接将改判结果写入批量行文件（`id` + `decision` + `reason`），通过一次 `update --from-file` 收掉。只把真正需要用户拍板的条目留到下一步。

### 2. 逐批讨论（每批 ≤4 个决策）

超出 4 个决策会消耗判断力，其余留到下一批。

- **呈现方式**：遵循 [`./shared/superworker/talking.md`](./shared/superworker/talking.md)——一次只呈现一个取舍点、四行齐全、概念命名按 `config get answer` 档位输出。函数名、变量名、行号、调用链留在条目本身供执行者读取，不直接堆给用户。
- **落定方式**：用户定案后逐条落定；同批共享同一 `reason` 的用 `update <id…>` / `reject <id…>` 一次提交，每条 `reason` 不同的走 `update --from-file`：
  - **简单问题**（单一函数提取、常量替换，约 5 行改动）→ `update <id> --decision autofix --status open --reason "<用户裁定结论>"`
  - **复杂问题**（跨多文件、需设计新接口）→ 先将设计写入 `.superworker/issues/specs/<id>.md`，再执行 `update <id> --decision autofix --status open --plan-path <path> --reason "<用户裁定结论>"`
  - **不修** → `reject <id> --reason "<原因>"`
  - **暂缓** → `acknowledge <id> --reason "<等待条件>"`
- **`--reason` 必须写清结论本身**（如「统一报错」），禁止只写「已讨论」——后续执行者只能看到这一句。
- 每批结束时报告剩余 `external` 条数。

## 边界

| 场景 | 处理方式 |
|---|---|
| 深入讨论单条实现细节 | 建议转 `/sw-conduct`（在准备阶段对齐需求与代码） |
| 大规模重构信号 | 单独立条（阈值与口径见 [`../sw-issue-repair/pool.md`](../sw-issue-repair/pool.md)），建议转 `/sw-route` 建节点进图 |
| 批量修复 | `/sw-issue-repair` |
| 刷新 issue 池 | `/sw-issue-scan` |
| 需要进图的新功能 | `/sw-route` |

## 反模式

开始前对照 [`./anti-patterns.md`](./anti-patterns.md) 自查。

# sw-issue-repair 反模式

开始前对照自查。规则正文见 [`./SKILL.md`](./SKILL.md) 与 `/sw-conduct`，本页仅保留症状与纠正信号。

## `issue-repair-skips-review-for-throughput` · 为追求吞吐跳过复审

**症状**：条目多时觉得「这条太小不用审」，Fix 完直接 commit——实际上无法可靠判断哪些改动「不需要审」。

**实例**：一处看似只是将 RAII guard 提取到共享头文件的改动漏了 `#include`，编译失败，直到复审阶段才发现。

**纠正信号**：该批次只有 Fix 报告，缺少 Review 报告。

## `issue-repair-mixes-change-domains-in-one-batch` · 将不同改动域混在同一批

**症状**：把无法被同一次验证覆盖的不同模块条目打包给同一个 Fix；或修批内条目时顺手改了批外代码，污染批次边界导致复审无法追溯。

**纠正信号**：同一批条目跨了两个及以上模块，却只跑了一次验证。

## `issue-repair-batch-composition-unreported` · 汇报未列出批次构成

**症状**：收尾汇报不说明如何分批以及每批包含哪些条目。

**纠正信号**：汇报里有读数和落定表，但无法对应出每批改了哪些条目及落在了哪个 commit。

## `issue-repair-acknowledge-or-external-as-exit` · 误用 `acknowledge` 或 `external` 充当退出路径

**症状**：修不动就标 `acknowledge`；或把已有可行解法的条目改判为 `external`。

**纠正信号**：落定表里出现 `acknowledge`，或已有明确解法的条目被转成 `external`。

## `issue-repair-batch-uncommitted` · 批次通过复审后未提交

**症状**：一批改完且复审通过，不 commit 就直接开下一批。

**纠正信号**：下一批改动与前一批混在同一份未提交工作区中。

## `issue-repair-widens-scope` · 超出调用方范围扩大修复面

**症状**：spec 只要求将某一项指标拉回阈值以下，却顺手把池子里其他域的条目也一并清理了。

**纠正信号**：本轮 `resolve` 的条目中，包含不在调用方目标范围内的指标或模块。

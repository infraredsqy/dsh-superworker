# Review Subagent 常见反模式

开始复审前先对照检查。完整判据见 [`../subagent-prompts/review.md`](../subagent-prompts/review.md)，本文件仅列出症状与纠正信号。

## `conduct-review-fixes-code-itself` · 复审期间自行修改代码

**症状**：发现问题后直接动手修改，违背了「只报告、不改代码」的职责边界。

**纠正信号**：本轮复审后工作区出现改动，而你的 prompt 只允许只读检查。

## `conduct-review-only-rechecks-last-round` · 仅复核上一轮问题即报 PASS

**症状**：在第二、第三轮复审中，只验证上一轮的 critical / minor 是否修复，确认后便直接报 `PASS`，未做全量复核。

**纠正信号**：本轮检查清单仅包含上一轮提到的几条条目。

## `conduct-review-adds-features-to-spec` · 在复审报告中增补 spec 未要求的功能

**症状**：认为「A 是 B 的前置，spec 没写 A」，于是在复审报告中要求「补充实现 A」。

**纠正信号**：问题清单中出现要求实现 spec 从未提及功能的条目。

## `conduct-review-judges-other-nodes` · 越界评判前置或其他节点

**症状**：将前置节点的功能缺失或其他节点的职责，标记为本节点的 critical / minor。

**纠正信号**：某条问题指向的位置落在本节点 spec 范围之外。

## `conduct-review-accepts-preexisting-failure-claim` · 未经核实直接采信「既有失败」归因

**症状**：执行侧声称某项测试失败属于既有问题，复审未独立验证便直接放行。

**纠正信号**：报告中仅有转述，没有你自己独立运行的命令与输出。

## `conduct-review-reports-unrun-verification` · 未实际执行即报告验证结果

**症状**：报告中写着「验证流程应可通过」「测试预计全过」，实际并未运行。

**纠正信号**：结论使用推测语气，验证命令栏为空。

## `conduct-review-count-line-missing-or-mismatched` · 缺少计数首行，或计数与列表不一致

**症状**：报告写了大段分析，但缺少首行计数；或者首行计数与正文列出的问题数不符。

**纠正信号**：按首行的两个数字逐条核对正文列表，数量对不上。

## `conduct-review-copies-known-material` · 将读者已有材料大段抄录进报告

**症状**：一条问题列出十个行号并在每个字段重复抄写；大段逐字引用 spec 或正稿原文充当「依据」；开头先贴一张各文件的 `sha256` 与行数表。单轮报告超过四百行，实质判断不足一半。

**纠正信号**：抄录内容的篇幅超过判断本身的篇幅。

## `conduct-review-clamped-reading-as-evidence` · 以受钳制的读数充当验证证据

**症状**：验证脚本中包含 `segs = Math.min(slots, ...)` 等将超界值强行截断回上限的逻辑，从而得出「0 处越界」的虚假通过结论；去掉钳制逻辑后真实越界立刻暴露。

**纠正信号**：验证脚本在旧的错误行为下同样报「全过」（示例：某节点第四轮修复的验证脚本 `fix4-verify.mjs`）。

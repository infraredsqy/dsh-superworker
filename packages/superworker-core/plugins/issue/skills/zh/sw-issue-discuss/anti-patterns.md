# sw-issue-discuss 反模式

开始前对照自查。规则正文见 [`./SKILL.md`](./SKILL.md)，本页仅保留症状与纠正信号。

## `issue-discuss-batch-over-decision-quota` · 单批讨论超出 4 个决策上限

**症状**：一次端出十几条 `external`，逐条追问「改不改、选 A 还是 B」。

**纠正信号**：用户开始回复「你看着办」，或单批呈现了 5 条及以上。

## `issue-discuss-submits-unreviewed-externals` · 未经复核即提交 `external` 条目

**症状**：池子里标了 `external` 就原样端给用户——例如 20 条里 12 条的 `suggestion` 已经写明了具体修法。

**纠正信号**：摆给用户的第一条，自己尚未评估能否直接给出明确修法。

## `issue-discuss-details-instead-of-tradeoffs` · 向用户输出实现细节而非取舍

**症状**：把函数名、变量名、行号、调用链直接丢给用户，让用户在代码细节里自己找决策点。

**纠正信号**：用户追问「所以我需要定什么」。

## `issue-discuss-reason-records-discussed-only` · `--reason` 只记「已讨论」，未落结论本身

**症状**：用户定案为「统一报错」，`--reason` 里却只写了「已讨论」。

**纠正信号**：后续执行者看这条 `--reason`，读不出用户到底定了什么方案。

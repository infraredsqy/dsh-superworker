# sw-test-audit 反模式

开始前对照自查。规则正文见 [`./SKILL.md`](./SKILL.md)、[`./garbage-patterns.md`](./garbage-patterns.md) 与 [`./compression-criteria.md`](./compression-criteria.md)，本页仅保留症状与纠正信号。

## `test-audit-conductor-reads-code` · 指挥者直接读测试源码

**症状**：指挥者直接用 Read 翻看测试源文件。

**纠正信号**：subagent 汇报的内容，指挥者事先已经读过源码。

## `test-audit-ships-without-verifying` · 改动后不验证即收尾

**症状**：改完测试代码后不编译、不运行剩余测试。

**纠正信号**：收尾报告里缺少编译与测试的实测读数。

## `test-audit-deletes-a-whole-mixed-case` · 混合用例整段删除

**症状**：一个 `TEST_CASE` 里只有部分断言是垃圾，却把整个用例删掉。

**纠正信号**：按整段删除了用例，但其中仍包含验证真实业务的断言。

## `test-audit-empties-a-file-without-the-build` · 清空文件后未同步构建系统

**症状**：删光内容的测试文件留在原处，构建系统仍在编译它。

**纠正信号**：测试文件已空，但 `CMakeLists.txt` / `Cargo.toml` / `package.json` 中仍列着它。

## `test-audit-splits-for-the-count` · 为凑数机械拆分 subagent

**症状**：文件数量不多，却按模块机械拆出四五个 scan subagent。

**纠正信号**：单个 subagent 本可覆盖整份清单，却被拆成多个。

## `test-audit-trades-coverage-for-time` · 用删除换取耗时压缩

**症状**：为了压低快档实测耗时，直接删掉慢但验证真实业务的测试。

**纠正信号**：待删条目只命中压缩判据，质量判据一栏为空或 `none`。

## `test-audit-moves-one-lane-only` · 只改快档、不同步慢档

**症状**：把测试移出快档，但未同步慢档命令、标记或收集清单；或移完未实际跑过一遍。

**纠正信号**：被移出的用例在快慢两档中均消失，或报告里缺少移档后的实测读数。

## `test-audit-scanner-decides` · scan 返回自带「建议删除」

**症状**：scan subagent 在返回结果里写「建议删除」「可以删掉」。

**纠正信号**：结构化返回中混入动作裁定，却缺少两条判据的命中事实。

## `test-audit-asks-the-human` · 将裁定推回用户

**症状**：报告里写「请勾选要删哪些」「等你确认后再动手」。

**纠正信号**：本应端到端跑完的审计报告里出现待用户确认的问句。

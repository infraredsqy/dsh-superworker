# sw-issue-scan 反模式

开始前对照自查。规则正文见 [`./SKILL.md`](./SKILL.md)、[`./scan.md`](./scan.md) 与 [`../sw-issue-repair/pool.md`](../sw-issue-repair/pool.md)，本页仅保留症状与纠正信号。

## `issue-scan-full-corpus-in-one-agent` · 单个 subagent 覆盖全量扫描

**症状**：只派一个 subagent 扫全部模块，返回结果把重复代码、职责越界和结构问题混作一团。

**纠正信号**：按模块与维度拆出的扫描面过多地堆在单个 subagent 上。

## `issue-scan-explores-without-reading-docs` · 未掌握项目架构即开始扫描

**症状**：尚未了解模块划分与架构约定就直接派发 scan。

**纠正信号**：拆分扫描面或编写 prompt 时，说不清项目的模块边界。

## `issue-scan-finding-not-locatable` · 入库发现缺少可定位信息

**症状**：只写「`game_ui.js` 里有重复代码」，既无函数名也无语义定位。

**纠正信号**：拿着这条发现回查代码，落不到具体函数或语义段上。

## `issue-scan-rescans-without-pool-dedup` · 重复扫描未与池子去重

**症状**：每次全量扫描都把池子里已有的条目再加一遍。

**纠正信号**：新增条目与池中旧条目同址同症。

## `issue-scan-absence-read-as-resolved` · 以缺席推定条目已解决

**症状**：批量 `resolve` 未出现在 `alive_ids` 中的条目；或 scan 没找到代码就判已修（实际只是挪了位置）；或刚入池就跑核对，把新条目误判为不存在并清理。

**纠正信号**：单次核对中，有条目未经逐条确认即被关闭。

## `issue-scan-refactor-as-small-item` · 将结构性重构记为小额条目

**症状**：某模块结构严重失衡，却被记成一条 `autofix` 小条目丢进池子。

**纠正信号**：问题涉及三个及以上模块，条目描述却像随手可改的小修。

## `issue-scan-decides-for-the-user` · 扫描阶段代用户裁定 `decision`

**症状**：拿不准的条目一律标成「需用户拍板」，一次扫出二十条 `external`。

**纠正信号**：`description` 或 `suggestion` 中写着「需拍板」，却说不清到底缺什么信息或存在哪两个方案取舍。

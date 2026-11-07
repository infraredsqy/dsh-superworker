# issue/ — 问题池插件：收尾时认池子的加权读数，越过声明的线就插一条维护节点

> 本文件是路牌，上限 15 行：一行一条——只说这一层有什么、什么时候看。

- `plugin.json` — 声明：旋钮、读数、度量、命令面与自带的文件。唯一权威，先读它
- `impl.mjs` — 实现入口：收尾那一步读池子、判越线、交一条插入 offer
- `tools/` — `issue` 的命令面与池子存储（`.superworker/issues/issues.json`）
- `skills/` — 随插件装与卸的技能，zh / en 各一套：scan 扫、discuss 和用户裁定、repair 修到线下
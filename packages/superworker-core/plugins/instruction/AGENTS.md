# instruction/ — 指令插件：`instruction` 这个词、这条记录、这把锁和 sw-instruct 都随它装与卸

> 本文件是路牌，上限 15 行：一行一条——只说这一层有什么、什么时候看。

- `plugin.json` — 声明：认领的命令词与自带的文件。唯一权威，先读它
- `impl.mjs` — 实现入口：命令面转发到 `tools/`；声明只有命令、不占时机格（declare.ts 的 spared 分支明文支持）
- `tools/` — `instruction` 的命令面（五个动词：词与应答归它，解析、帮助页与写动词的锁按它的表由接缝跑）与清单存储（`.superworker/instructions.json`、它自己的锁 `meta/instructions.lock`；字节格式与锁协议取 `ctx.base`，`--project` 认哪棵树取 `ctx.projectRootOf`）。改动词应答、改字段读写时看
- `skills/` — 随插件装与卸的技能，zh / en 各一套：sw-instruct 把用户原话记一条约束进清单
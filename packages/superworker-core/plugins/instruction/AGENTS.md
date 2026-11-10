# instruction/ — 指令插件：`instruction` 这个词、这条记录、这把锁和 sw-instruct 都随它装与卸

> 本文件是路牌，上限 15 行：一行一条——只说这一层有什么、什么时候看。

- `plugin.json` — 声明：认领的命令词、占的那一格时机，与自带的文件。唯一权威，先读它
- `impl.mjs` — 实现入口：命令面转发到 `tools/`；收尾那一格永远答「没有要插的东西」（引擎的声明语法没有「只有命令」的形状，占它是为过声明校验）
- `tools/` — `instruction` 的命令面（五个动词与自己的帮助页）与清单存储（`.superworker/instructions.json`、它自己的锁 `meta/instructions.lock`）。改动词应答、改写入字节时看
- `skills/` — 随插件装与卸的技能，zh / en 各一套：sw-instruct 把用户原话记一条约束进清单
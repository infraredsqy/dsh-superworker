# pf 工具使用技巧

> 本文件描述 DAG 管理工具的高效使用方法。与 `philosophy.md`（WHY）互补，本文件聚焦 HOW。

## 根原则

**先 `--help`，再动手。** 调 `dag` 之前，先看 `--help` 了解所有命令和选项，不凭感觉或记忆操作。命令全集就是 `dag --help` 印出来的那些；下面只写帮助页教不了的习惯。

## 效率规则

### 合并同类查询

`dag search` 支持正则表达式，相关关键词用 `|` 一次查完：

```
# 坏：5 次调用
dag search 合并
dag search 集成
dag search 迁移
dag search 整合
dag search 主项目

# 好：1 次调用
dag search '合并|集成|迁移|整合|主项目'
```

同理，`dag info` / `dag open` / `dag context` 不能并成一行，但互不依赖的几行可以放进**同一条消息**——工具按你给的顺序一条条跑，结果一起回来。一次只发一行、等结果再发下一行，才是多出来的往返。

### 同一动作套 N 条：用词自己的批量形状

同一个词套在 N 条记录上，一条一条发就是把一次写拆成 N 次。词面自己带了批量形状，能用就用：

- 建节点：`dag add --from-file <行文件>`——每行一个节点，可带 `ref`，同批的 `depends_on` 用 `ref` 指名；整批一次图写入。
- 连边：`dag depend <node> --on a,b,c`，一次写。
- 入池：`issue add --from-file <行文件>`。
- 改池：`issue update --from-file <行文件>`——每行 `id` 加要改的字段。
- 结池：`issue resolve <id…> --reason "<同一句验证读数>"`，`reject` / `acknowledge` / `remove` 同理。

行文件放 `.pf/meta/batch/`（`meta/` 不进版本库），跑完删掉。这些词整批一次写：坏行（不认得的字段、缺 id、坏值）拒整批，一个字节不写；`resolve` 这一列里有一个 id 不在，也拒整批。

### 优先定向查询，list 是最后手段

`dag list` 输出全量节点 JSON，DAG 大时信息冗余且消耗上下文。定向查询始终优先：

- 搜节点 → `dag search <regex>`
- 看详情 → `dag info <id>`
- 看拓扑 → `dag context <id>`

只有需要全图排序（如推荐下一步）时才用 `dag list`，且加 `--limit N` 控制条数。**不要用 `dag list | grep` 做定向搜索——那是 `dag search` 的事。**

### pattern 引号

所有 pattern 参数（`dag search` 的 regex、`dag add` 的 title/description）用双引号包起来，防止 shell 解析特殊字符。

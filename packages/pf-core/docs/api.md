# pf-core 接口面

这份文件是本包接口面的唯一参考。名字与签名已经冻结，不另行改名；改动要先过指挥者。

- `open(root, options?)` 交回一个 `pf` 句柄，里面是 `ledger` / `conductor` / `config` /
  `sessions` 四个命名空间；`options` 的形状是 `PfOpenOptions`。
- `PfOpenOptions { executor?: Executor; homeDir?: string; pluginsDir?: string }` —— `executor` 是执行的唯一注入点；不传执行者时，`conductor.dispatch`
  直接抛错，记录一个字节都不动。git 不走这里：`ledger.init`、`ledger.register` 与 `conductor.doctor`
  每次调用自带一个 `git`（形状就是 `src/git.ts` 里的 `GitRunner`），句柄上不存 git；哪一次调用不传，
  那一次问 git 的部分就不问（doctor 的合并驱动一格只说没问，不判红）。`homeDir` 是机器层设置的 home
  （`<home>/.pf/config.json`）：句柄把它交给每一个读这一层的命名空间——`config` 的 global 层，以及
  `conductor` 的派发准备与插件上下文；同一个句柄只有一套机器层。不传时按 `PF_HOME_DIR`，再缺省到本机
  home。`pluginsDir` 是这个句柄扫描的插件目录
  （设置声明的并入、插件命令、doctor 与两道时机门读的都是它）：点名优先于 `PF_PLUGINS_DIR`，两者都压过
  缺省的 `<root>/plugins`；不点名时读法照旧。
- `Pf { root: string; ledger; conductor; config; sessions }` —— `root` 是打开时给的项目根，原样保存。
- `pf.ledger.dag` 十六动词、`pf.ledger.cycles` 十三动词、`pf.ledger.instructions` 五动词、
  `pf.config` 五动词、`ledger.init` / `ledger.register` / `ledger.cleanTemp`、`pf.sessions` 三动词与
  `conductor.next` / `conductor.close` / `conductor.advance` / `conductor.settle` / `conductor.settlePreview` /
  `conductor.dispatch` / `conductor.dispatchPreview` / `conductor.doctor` / `conductor.handoff` /
  `conductor.handoffForm` / `conductor.pluginCommand` / `conductor.pluginCommands` / `conductor.prepare`
  都在句柄上，全是真实现；没有一个桩。
- 动作路径即 API 路径：`ledger.dag.add` 这样的动作路径，同时就是将来 API 的命名空间路径——
  按这个拼写找方法，从句柄一路点下去就能到。

## 运行时导出

```text
COMMANDS
GROUPS
INSTRUCTION_SCOPES
LONG_RESULT_LIMIT
PLUGIN_SKILL_FILE
SimulatedExecutor
answer
describe
helpText
instructionAddLine
instructionArchiveLine
instructionRemoveLine
instructionReviveLine
loadPlugins
longResultPointerOf
open
parse
skillFolders
skillProblems
specOf
topHelp
usageError
```

`PLUGIN_SKILL_FILE` 是技能文件名（`SKILL.md`）；`SimulatedExecutor` 是执行者接缝；`open` 是句柄入口；`INSTRUCTION_SCOPES` 是指令能绑的 scope 词表（命令表里 `--scope` 的选项读的就是这一份），`instruction*Line` 是面板那几个动作到词面那一行的构造（`archive` 就是 `instruction resolve --state withdrawn`）。
`loadPlugins` / `skillFolders` / `skillProblems` 读的是插件自带技能——`loadPlugins` 装载插件目录，
`skillFolders` 交出一个插件带的技能目录，`skillProblems` 说出它与声明对不上的两种情形（度量点名的
方法没有技能、一个技能名被两个插件交出）。读的是同一个插件目录，判什么由调用方定：引擎只交结论，
装与卸归装它的那一侧。

`answer(argv, io)` 是词面（words layer）的唯一应答口：一行命令进来，交回
`{ code, stdout, stderr }`——两个流已是命令面会写出的字节（非空、以换行收尾）。`io` 是本次调用的
接缝（`WordsIO { root; executor?; git?; homeDir?; pluginsDir?; openerAvailable?; readInput? }`）：`root`
替代「进程当前目录」这个隐含依赖（不接受 `--project` 的词读的就是它），`executor` /
`git` 注入，`openerAvailable` 说出本调用能否真开会话（`dispatch` / `advance` 据此照实回答：开不出
会话的进程里 `dispatch` 一个字节都不写就拒，`advance` 只钉节点、不落材料、不认领会话，两边都把
面板（寻路中心）与那几份 prompt 的位置念出来），`readInput` 是「取输入」的那条接缝：`handoff -o -`
的字节从它来（调用方自己的流，词面不碰本进程），没给的调用按名字拒绝 `-` 并指向 `@path`。本进程自己的三个词（checkout 的 doctor、version、合并驱动的进程交接）归命令面
的适配器答，词面不路由。`describe()` 交出词表的静态索引数据（`WordsIndex`：形状说明、三个
自述词、动词与组的行、版式常数），顶层清单与 agent 面的帮助页渲染同一份；`topHelp(io)` 交出拼好的
顶层清单文本（插件词按 `io` 现读）。`COMMANDS` / `GROUPS` / `specOf` / `helpText` / `parse` /
`usageError` 是那张词表与它的桥、打印器、解析器与用法错误——一张表喂解析、打印与路由，谁需要表
从引擎拿。`LONG_RESULT_LIMIT`（4000，按 UTF-8 字节计——与 `Buffer.byteLength` 同一把尺子，不是字符数）与
`longResultPointerOf(stdout, word)` 是长结果的上限与指针，只在这一处定义：`dag list` / `dag search` /
`session list` 三个词的应答超过上限时，投影层在尾部补指针问的下一句词，绝不静默截断；词面的打印
不走它（印出的字节是它自己的契约）。

包另有一个进程入口 `pf-merge-ledger`（`package.json` 的 `bin` 里只有这一条，
产物是 `dist/merge-ledger.mjs`）：git 的合并驱动只能靠进程叫，它是边界上唯一那个例外，做的是
argv 与退出码的搬运，一条合并规则都不在它里面。

类型出口在 `src/index.ts` 里按命名空间逐项列出——记录类型、各命名空间的输入 / 选项 / 返回形状，
外部调用方按名字 `import type` 就能拿到：`DagInfo`、`DagInfoEdge`、`DagInfoOptions`、
`InstructionReaderRow`、`ConductorDispatchInput`、`SessionShow` 都在这张清单上。

## pf.ledger

记录目录（`.pf/`）的读写入口。

| 动作 | 签名 | 一句话语义 |
| --- | --- | --- |
| `ledger.init` | `init(options?)` | 为项目立起 `.pf/` 记录目录，交回这一次做了什么的读数 |
| `ledger.register` | `register(options?)` | 把合并驱动的两个 git config 键写进本项目（`[merge "pf"]` 一节）；这台机器已经答得上的注册原样留着，交回此刻生效的命令串；不是 git checkout、或没给 git 时静默跳过，交回 `null` |
| `ledger.cleanTemp` | `cleanTemp(options?)` | 列（给 `remove` 就删）每个节点自己的 `temp/`：一处清扫，只整目录 |

### pf.ledger.init 与 pf.ledger.register

`init(options?)` 的选项是 `LedgerInitOptions { force?; layout?; ownRepo?; git? }`。

**两档布局，只有两档。** `layout` 缺省 `'own-repo'`：`.pf` 不在项目仓库里，项目仓库的
`info/exclude` 里有一行把它挡在外面；`'in-repo'`：`.pf` 随项目仓库走，那一行被抽掉。`.pf`
自己的仓库只有 `ownRepo` 要的时候才给（缺省要，且只在 `'own-repo'` 那一档）：`.pf/.git` 不在
时，经调用方插进来的 `GitRunner` 跑一次 `git init --quiet`；`.git` 已经在场时一个字节不碰，
`'in-repo'` 档永远不建。引擎只给不收：`.pf/.git` 一旦在场就留在原处，删它等于删历史，这个
决定留给人。两档各自幂等，来回切也幂等。

**底线先落，附加件后做。** 四份布局文件（`.gitignore`、`.gitattributes`、`AGENTS.md`、
`config.json`；`config.json` 只在缺席或 `force` 时写）在任何环境里都落——没有 git、不是
checkout，都一样；字节不同就从常量重写，一样就一个字节不碰。自有仓库的读数、`info/exclude`
那一行、合并驱动的两个键是三件附加件：做不成就往 `warnings` 里点名，不抛、不回滚。

**交回 `InitReport`**，字段与取值就是下面这些：

| 字段 | 取值 |
| --- | --- |
| `layout` | `'own-repo' \| 'in-repo'` |
| `written` | 这次真写了的布局文件名 |
| `ownRepo` | `'created' \| 'present' \| 'skipped' \| 'skipped-no-git'` |
| `exclude` | `'written' \| 'removed' \| 'skipped-not-a-checkout' \| 'skipped-not-own-repo' \| 'failed'` |
| `mergeDriver` | `'written' \| 'kept' \| 'skipped-no-config'` |
| `mergeDriverCommand` | 这一轮之后 `merge.pf.driver` 里的那个命令串（这一轮写的，或留着没动的）；什么都没注册成时 `null` |
| `warnings` | 每一件没做成的附加件一条人话：没做什么、为什么、`.pf` 现在是什么状态 |

`exclude` 的落点问 git 要：`git rev-parse --git-path info/exclude`（引擎不自己拼 git 的目录布局）；
行本身是 `/<项目根相对仓库根的路径>/.pf/`，那个前缀从 `git rev-parse --show-prefix` 来，所以同一个
仓库里的几份 `.pf` 各写各的行，别家的行一个字节都不动。

`register(options?)` 只做那两个键：`merge.pf.name`（git 给驱动看的标签）与 `merge.pf.driver`，
都经 `git config --local` 写（config 文件的锁与原子性归 git）。命令串在写的时候现算；不是
checkout、没给 `git` 或者 git 拒绝时静默跳过，不抛。

**已经答得上的注册原样留着。** `init` 与 `register` 都先读一遍 `merge.pf.driver`：这个命令串要是
本机此刻真答得上的一种形式，那就一个字节都不改写，读数记 `kept`，命令串照交回——重跑 `init` 不会
把人选好的、能用的驱动悄悄换掉。没有注册、或注册已经答不上时，才按写的时候现算的那一档重写。
哪几种形式算答得上、现算的是哪一档，见 [merge.md](merge.md)。

**`cleanTemp(options?)` 是那一处清扫**：扫的是这个项目自己的节点目录，一个节点最多一个
`nodes/<id>/temp/`。选项是 `CleanTempOptions { node?; remove?; force? }`：`node` 收全 id 或前缀，
`remove` 才是真删（不给只列、一个字节不动），`force` 连一条线此刻握着的节点也清（它的会话已经没了、
认领还没放下时的那一档）。交回 `CleanTempReport { targets; running; removed }`，三格都是
`CleanTempEntry { name; node; worktree; dir; files; bytes }`：`targets` 是这一轮要删（或列出来）的，
`running` 是被线握着跳过的那几个，`removed` 只在 `remove` 下填，记的是真删掉的（删不掉的不算）。
工作树那一块不进：目录名是用户数据，出处无从证明。

### pf.ledger.dag

图：节点与边的读写，十六个动词。

| 动作 | 签名 | 一句话语义 |
| --- | --- | --- |
| `ledger.dag.add` | `add(input)` | 登记一个节点：标题必填，依赖、标签、模式、重量可选 |
| `ledger.dag.addMany` | `addMany(rows)` | 一批登记为一次图的写：行可带 `ref`，坏行 / 悬空依赖 / 成环拒整批，一个字节不落 |
| `ledger.dag.remove` | `remove(id, options?)` | 把节点取下图，它的会话档一并删掉；还有依赖者时拒绝，除非 `force` |
| `ledger.dag.update` | `update(id, patch)` | 改节点的标题 / 描述 / 模式 / 标签 / 重量 |
| `ledger.dag.link` | `link(id, dependsOn \| dependsOn[])` | 加依赖边；自查环，成环即拒绝；交数组时是一批、一次写入，全部落或一条都不落 |
| `ledger.dag.unlink` | `unlink(id, dependency)` | 摘一条依赖边 |
| `ledger.dag.setStatus` | `setStatus(id, status)` | 改状态；落 completed 时写完成时刻，离开即摘除 |
| `ledger.dag.approve` | `approve(id, at?)` | 记人对本次交付的认可；时刻不得早于完成时刻 |
| `ledger.dag.revive` | `revive(id)` | 把 shelved 的节点放回 todo |
| `ledger.dag.get` | `get(id)` | 读一个节点的记录；不在图上时为 `null` |
| `ledger.dag.info` | `info(id, options?)` | 读一个节点的详情：记录 + 两个方向的边、就绪、两个读数与会话名单 |
| `ledger.dag.context` | `context(id)` | 读上下游传递闭包 |
| `ledger.dag.search` | `search(query, options?)` | 按正则搜标题与描述，标题命中排前 |
| `ledger.dag.list` | `list(filter?)` | 按状态 / 就绪 / 标签列出，重要与紧急排序 |
| `ledger.dag.specPath` | `specPath(id)` | 节点 spec.md 的落点路径 |
| `ledger.dag.validate` | `validate()` | 查环、悬空引用与重复边；孤立点点名不翻红 |

**`addMany(rows)` 是一批的一次写入。** 每一行与 `add` 同形，多一格 `ref`：这一批自己的
`depends_on` 先点 `ref`，点不到才按图上的 id 解析；交回按行的次序，带 `id` 与行上有过的 `ref`。
整批先校验每一行、先在内存里连边，最后才立节点目录、写一次图——坏行（不认得的字段、空标题、
认不得的 `mode` / `weight`、不是字符串数组的 `tags` / `depends_on`、重复或撞上已有 id 的 `ref`）、
点不到的依赖、成环，三者任一都拒整批，一个字节都不落。`link` 交一个数组时是同一把尺子：每一条
依赖先解析完再逐条连边，一次写入，全部落或一条都不落。

**`info(id, options?)` 是节点详情。** `get` 原样交回记录；`info` 多给只有图能回答的那几格。它的选项是 `DagInfoOptions { verbose?: boolean }`，交回 `DagInfo`，键序固定：

| 字段 | 取值 |
| --- | --- |
| `id` / `title` / `status` / `mode` / `description` | 记录里的词；标题、描述缺席读空串，状态缺席读 `todo`，模式缺席读 `auto` |
| `depends_on` | 本节点记录里的依赖，按记录的次序；每项 `{ id, title }`，图上已经没有的那个读 `(unknown)` |
| `depended_by` | 图上每条记录里写了本节点的那些节点，按节点表的次序；`{ id, title }`，标题缺席读空串 |
| `ready` | 与 `list` 的 `ready` 同一把尺 |
| `urgency_level` / `importance_score` | 与 `list` 同一份算法（未完的子图上算）；`shelved` 的节点不入排序，两个都读 0 |
| `weight` | 只在 `light` 时有这一格 |
| `created_at` / `updated_at` | 只在 `verbose` 时有 |
| `sessions` | 会话档的两个名单；两个都空时整格缺席 |
| `completed_at` / `approved_at` | 有那个时刻才给 |

`verbose` 时两个方向的每一项多一个 `status`：依赖那侧缺席读 `(unknown)`（与它的标题同一格），被依赖那侧缺席读空串。`info` 与 `get` 一样是读动词：不持锁、不问 init 门槛；图上没有这个 id 时当场停下。

`sessions` 格走本机会话档，读的是记录自己：本引擎只开 dsh 会话，宿主那一格一律读作 `dsh`，档里写的是哪个词都不改变读数、也不算错误（另一个实现仍在往这些记录里写它自己的词，那是数据）。`DagInfoOptions` 只有 `verbose` 一格。

### pf.ledger.cycles

线：一条工作线的立、跑、停、收，十三个动词。

| 动作 | 签名 | 一句话语义 |
| --- | --- | --- |
| `ledger.cycles.create` | `create(input)` | 立一条线；拾取范围（`tags`）必须声明 |
| `ledger.cycles.start` | `start(input)` | 立线并按规则钉住开线的节点 |
| `ledger.cycles.rename` | `rename(id, title)` | 改线的标题 |
| `ledger.cycles.setStatus` | `setStatus(id, status)` | `active` 该往前推 / `inactive` 不推 |
| `ledger.cycles.setPolicy` | `setPolicy(id, key, value)` | 写线自己的策略，交回整个有效集 |
| `ledger.cycles.list` | `list()` | 全部的线 |
| `ledger.cycles.current` | `current()` | 现在该干活的线；多条在服务时拒绝点名；没有时为 `null` |
| `ledger.cycles.show` | `show(id)` | 一条线的完整记录 |
| `ledger.cycles.policies` | `policies(id)` | 这条线的有效策略集：缺省在前，线自己写了的盖上去 |
| `ledger.cycles.standing` | `standing(id, node)` | 一个节点在这条线里的站况：`holding` / `walked` / `nothing`，外加磁盘上那张票 |
| `ledger.cycles.hold` | `hold(id, nodes)` | 认领一个节点（或一批）进这条线的在册名单：一个节点只属于一条线，一批是一次写入、要么整批落、要么一个字节都不落 |
| `ledger.cycles.close` | `close(id, input)` | 结算一步：判决进 path，认领放下 |
| `ledger.cycles.retry` | `retry(id, node?, options?)` | 撤旧票、改写 pending，线册不动；`{ drop: true }` 连认领一起摘掉，会话已经死掉时重来要的是这一档；`{ summary: '…' }` 是改写后那张票上的那句话，没给时用固定的那句 |

**`standing` 交回 `CycleStanding { cycle; node; standing; since?; step?; signal }`**：`holding`
时 `since` 是认领时刻；`walked` 时 `step` 是 path 里最近一条点名它的步（判决与起止时刻）；
`signal` 是 `signals/<线>/<节点>.json` 那张票读出来的 `{ status; summary; outputs }`，没票时为
`null`。读动词：不拿锁、不碰门槛、一个字节都不写。

线自己的策略键：`when_shelved`（节点没交付被放下时停线还是继续）、`parallel`
（同时认领几个节点，缺省 1）、`model`（这条线开的会话用哪条模型路由，一个
`provider/model` 的词）；其余是插件声明的旋钮。线记录里残留别的键（别的实现写下的旧词那种）
当未知键跳过：不抛、不拒读整条线，也不进入有效集。

### pf.ledger.instructions

指令：用户指令通道，五个动词。

| 动作 | 签名 | 一句话语义 |
| --- | --- | --- |
| `ledger.instructions.add` | `add(input)` | 登记一条指令；正文与范围必填，绑定随范围走 |
| `ledger.instructions.list` | `list(filter?)` | 缺省读法给读者面；`all` / `live` / `scope` 给原始记录 |
| `ledger.instructions.resolve` | `resolve(id, options?)` | 结清一条指令（落结清时刻；`{ note }` 给了就一并落在档案里） |
| `ledger.instructions.revive` | `revive(id)` | 把已归档的指令重新生效 |
| `ledger.instructions.remove` | `remove(id)` | 把指令摘走，留 id 与时刻的痕迹 |

**`list` 有两种读法，一个动词。** 两种都按记录里的次序给，不排序：

- **缺省读法（读者面）**：还在生效、且从读者当前位置能看见的那些，每行折成
  `InstructionReaderRow`。`scope` 是读出来的范围词（认不得的词读 `global`）；`target` 是记录里的
  词，记录没写时是 `null`；`reach` 是投递通道补上缺省后的那个词，只有 `stage` / `boundary` 两个。
  引擎给词，不给句子——一句话怎么读是展现层的事。
- **原始记录**：原样的记录行。`all` 连归档的一起给；`live` 只留还在生效的；`scope` 把清单收窄到
  一个范围（`global` / `cycle` / `node`）。三者可以并给。
- `node` 不是清单开关：它是「读者站在哪个节点」的定位词，缺省读法用它算可见性（两条线并排时它
  同时钉住线）。

`InstructionListFilter { all?; live?; scope?; node? }`。`resolve` 的选项是
`InstructionResolveOptions { note? }`：给了这句就写在结清时刻旁边，没给时档案里原有的注释
留原样。

## pf.config

设置：一条解析链上的读写，五个动词。链上窄的盖宽的：node（`<root>/.pf/nodes/<节点>/config.json`）
→ cycle（线记录的 `policies` 槽）→ project（`.pf/config.json`）→ global（`<home>/.pf/config.json`），
最底下是旋钮声明里的出厂缺省。

`ConfigLayer` 一次点一层，四种拼法：`{ project: true }`、`{ global: true }`、`{ cycle: '<线 id>' }`、
`{ node: '<节点 id>' }`。`set` / `unset` 必须点名那一层——没有缺省层（一次点名零层或两层当场
`TypeError`）；点名的线 / 节点不在记录上也当场拒绝，绝不为调用方造层。

| 动作 | 签名 | 一句话语义 |
| --- | --- | --- |
| `config.get` | `get(key, at?, dir?)` | 读一个设置项、到点名那一层为止的生效值 |
| `config.set` | `set(key, value, at, dir?)` | 往点名的那一层写一个设置项 |
| `config.unset` | `unset(key, at, dir?)` | 撤掉点名那一层的设置项，露出下一层 |
| `config.list` | `list(at?, dir?)` | 到点名那一层为止的全部设置，每一项都是 `{ value, source }` |
| `config.keys` | `keys(dir?)` | 这几个设置动词此刻认得的旋钮名，排序后的字符串数组 |

`get` 与 `list` 都交回 `ConfigReading { value: ConfigValue | null; source: ConfigSource }`；
`source` 是五个词之一：`node` / `cycle` / `project` / `global`，或 `builtin`——链上没人说话，
生效的是声明里的出厂缺省。`get` 交回一条读数，`list` 交回 `Record<string, ConfigReading>`；
`get` 没有值可交时 `value` 是 `null`（只有插件声明的旋钮可能这样），`source` 照样说清是哪一层。
不点名 `at` 时读两层宽层（global → project）。`list` 没有键可拒，就照那一层往上给：旋钮不收那一层的，
读数来自它下面那层。

`keys(dir?)` 交回此刻这份清单上的名字，排序后的字符串数组：引擎自己的设置加上已装插件声明的旋钮，
只留收 project 层的那些；收窄到 global 一层的旋钮不在里面——它不是一次 project 读写的对象。调用方要印
「这几个动词收哪些名字」时印的就是这一份，插件装上或摘掉，下一次调用就换。

五个动词都带一个可选目录 `dir`：缺席时用句柄自己的项目根。无论哪种，那个目录都得自己有一份
`.pf`——没有就是 `not_a_project`，不会往上找更宽的目录。句柄自己的根也不豁免：fork 档的节点在
自己的 worktree 里干活；own-repo 档下那份 worktree 里没有 `.pf`，在那里问设置得到的是「这不是
pf 项目」，主树的设置一个字都漏不出来（in-repo 档记录随检出走，问的是那个 worktree 自己的记录）。
相对路径按进程当前目录解。

值的种类四种：`number`（正的数值）、`integer`（正整数）、`word`（词汇表里的词）、`switch`（`on` / `off`
两个词），读写两侧过同一道校验门。写侧不合种类当场拒绝（`invalid_value`），什么都没写；线层骑在线
记录上，认不出的值当没说。

旋钮名得在清单上，否则 `unknown_key`（拒绝里把可配的名全列出来）。核心内置三个：

- `max_agents`（`integer`，缺省 3）：一个会话同时在飞的子代理上限。
- `test_tier`（`word`，`full` / `minimal`，缺省 `full`）：验证档位——full 跑全套，minimal 只跑点名的检查。
- `worktree_mode`（`word`，`off` / `fork` / `reuse`，缺省按项目算：git 项目 `fork`，其余 `off`）：
  节点要不要自己的 worktree。`reuse` 在词汇表里，但这台引擎只在 `off` / `fork` 两档里干活，
  按模式读它、读到 `reuse` 就拒绝（`worktree_mode_unsupported`）。

三个都只收 project / global 两层（`layer_not_allowed` 的拒绝里点名它收哪几层）。其余旋钮由插件声明，
顺着整条链收。

出厂缺省的规矩，只管引擎自己的声明：每一项都带一个缺省（字面量，或按项目根现算的函数）——缺了它、
写成 `null`、或字面量与自己的种类不合，合并清单的那一刻就拒绝并点名那一项（那是声明问题，抛
`TypeError`），所以核心设置不会读到「没配」，那个缺省的 `source` 就是 `builtin`。插件声明的格子不走这道门，
但 `default` 一样必填：写 `null` 才是「没有出厂值」，字段缺席是声明问题。

读侧被拦住的就是这几处，再没有别的：那个目录自己没有 `.pf`（`not_a_project`，五个动词都先查
它）、`get` 点了一个不在清单上的名（`unknown_key`）、旋钮不收那一层（`layer_not_allowed`）、
点名的线不在 `state.json` 里（`cycle_not_found`）、点名的节点不在图上（`node_not_found`）、一个节点
被两条线同时认领（`ambiguous_holder`），以及一层文件读不动或解析不了（`invalid_utf8` /
`parse_failure` / `invalid_config_file`）。其余关于文件的情形一律沉默，因为它们不改变任何读数：文件
里出现认不得的名字（插件被摘掉了、键改过名）、名字落在不收它的层里、值不合种类，三者都跳过——
生效的是下一层，或声明的出厂缺省。这些错写侧才是逮它们的地方：`set` 当场拒绝收不下的层、不认识的
名、不合种类的值。点名层本身写错（零层、两层）不属于上面这些，是 `TypeError`。

节点层的读数落在那条认领该节点的线上：没有线认领就跳过线层，两条线同时认领就是 `ambiguous_holder`
（一个节点一次只归一条线，不猜是哪条）。写节点层前会再查一次节点还在不在图上：检查与落盘之间夹着
一次 `dag.remove` 时，不会把那个目录又造回来。

## pf.sessions

会话档的入口，三个动词：两个读、一个写。

| 动作 | 签名 | 一句话语义 |
| --- | --- | --- |
| `sessions.list` | `list()` | 全部会话档，按节点给，每条带节点 id、标题与档本身 |
| `sessions.show` | `show(node)` | 一个节点的会话档；没写过时两个名单都是空的 |
| `sessions.note` | `note(node, role, session)` | 往这个节点的会话档里记一条会话：新写交回 `true`，同一会话已经在那一档里就交回 `false` |

`show` 交回 `SessionShow { node, title, v, discussion, run }`：节点 id 与图上的标题都在，标题从
`ideas.json` 现读（记录没写标题时读空串）。`list` 每条是
`SessionNoteSummary { node, title, note }`，按节点 id 排；节点已经不在节点表上时标题读空串，那一页照给。

会话档住 `.pf/meta/sessions/<节点>.json`（会话 id 是本机的东西，不进记录）。读侧一律容忍：
文件缺席、读不动、版本认不得，三者都读作「没写过」，两个名单都是空表；条目里没有会话 id 的
丢掉，时刻认不得就是 `null`。宿主那一格：本引擎只开 dsh 会话，读取与展示一律读作 `dsh` ——
档里写的是哪个词都不算错误（别的实现仍在往这些记录里写它自己的词，那是数据），也不拿会话 id
的形状去猜。`list` 只给说得出一句的档（两个名单都空的不进清单），按节点 id 排；一个档读不动或
认不得，只丢它自己，别的条目照常给出。
`show` 认全 id 与唯一前缀：前缀认出多个节点、或一个都认不出，都当场拒绝，不替调用方猜。

`note` 是这一层唯一的写口：一条会话记进 `discussion` / `run` 之一（`role` 只收这两个词，别的当场
拒绝）。读写是一次动作、全程持这个项目的记录锁，所以同一个节点上的两个写者——开它会话的宿主，以及
引擎自己在登记节点时记 discussion 的那条路——不会互相丢掉条目。同一个会话 id 已经在那一档里时不再
写，交回 `false`（部分失败后的重试不该把同一个 run 记两遍）。文件按规范形状整份重写：两个名单、
`{v, discussion, run}`，原有条目过写者自己的清理，别的什么都不动：条目里写下的宿主原样写回、一个
字节不改，新写的条目落 `host: 'dsh'`。`node` 收全 id：前缀是给人读的
id，写口认的是节点已有的那个目录。

## pf.conductor

流水线：推线走的一组动作，十一个动词。

| 动作 | 签名 | 一句话语义 |
| --- | --- | --- |
| `conductor.next` | `next(input?)` | 读一份只读规划：下一步该干什么，不执行、不写记录；`after` 问的是收尾预演 |
| `conductor.settle` | `settle(input?)` | 收这一单：判决进 path、认领放下、图落 `completed` / `shelved`、收尾插件缝跑完；不补槽、不停线、不落材料、不开会话 |
| `conductor.settlePreview` | `settlePreview(input?)` | 收这一单的预演：同一对门槛、同一份收尾判据、收尾缝问各家自己的预演，写零字节；交回 `SettlePreview { action; dry_run; cycle; node_id; result; delivered; graph; target; filled; park_line; seam; warnings; plan }` |
| `conductor.close` | `close(input?)` | `settle` 加应用步而不开会话：补满空槽，没得做了且手是空的就把线转 `inactive` |
| `conductor.advance` | `advance(input?)` | 把线推一格：补满空槽（钉）→ 落每格的材料 → 一格开一个会话；停了的线转 `inactive`；交回 `AdvanceReceipt { cycle; pinned; dispatches; parked; plan }` |
| `conductor.prepare` | `prepare(input?)` | 把一次派发的材料落下来、不开会话：提示词落到它的位置、运行稿立在节点目录、交接单模板随材料交回 `PreparedDispatch { cycle; nodes }`；只有规划交回 `dispatch` 时才有材料可落，别的计划当场拒绝、一个字节不写 |
| `conductor.dispatch` | `dispatch(input?)` | 把一格交给一个会话，交回收据 `DispatchReceipt { action; cycle; node_id; node_title; prompt; prompt_text; session? }`；`action` 只有 `opened` / `already_open` 两个词 |
| `conductor.dispatchPreview` | `dispatchPreview(input?)` | 派发的预演：这格会收到的请求（材料落点与是否已在盘上、`model`），拦下缝问各家自己的预演、理由当数据交回 `blocked`；不落材料、不落记号、不开会话 |
| `conductor.handoff` | `handoff(input)` | 写一张交接单，落在 signals 下的「线 id / 节点 id」 |
| `conductor.handoffForm` | `handoffForm(input?)` | 这条线要的交接单形状：它问哪几个读数格（不写一个字节） |
| `conductor.pluginCommand` | `pluginCommand(input)` | 把一个词连同它的行交给声明这个词的插件，在本进程里跑，交回 `PluginCommandAnswer { word; plugin; ran; text; code; error }` |
| `conductor.pluginCommands` | `pluginCommands()` | 装上的插件声明的命令词，按文件夹次序，带路由表认的那个名字 |
| `conductor.doctor` | `doctor(options?)` | 体检：记录齐全、引用不悬空、没有成环 |

推线几步的口径：`next` 是只读规划；`settle` 只做「这一个节点结束了」一件事——两个门先过（节点
不在认领名单是 `not_holding`，交接单缺席或还是 `pending` 是 `nothing_to_settle`，都一个字节不动），
插件的收尾半在拿锁之前问完（扫描、载入、逐个询问都在同一份现场上做，插件答多久都不占着锁），进锁
后线与交接单各重读一次、结算按重读的这份算，动过的记录先留字节快照、中途失败按快照放回去。落地的
是：判决进 `path`、认领放下、图落 `completed` / `shelved`，随后收尾插入缝把插件要的节点落图——
插进来的节点挂在**这一单本该开的下一个节点之前**（结算判据挑中的那个是插入的目标，它被重挂到新
节点之下），于是它按排序排在那件活的前面；结算自己不补槽、不停线、不落材料、不开会话。

`close` 与 `advance` 是同一个应用步的两种收尾：先补满空槽（线自己的 `parallel` 减手里的节点数，
按图上的次序取，受这条线的选材范围与别的线的持有约束），再读一次计划——交回 `dispatch` 就把手里
还没开过会话的格子交给执行者（每格一个赛跑着开，一格里一个会话），交回 `stop_pipeline` 且手是空
的就把线转 `inactive`。`close` 不交执行者（工具在 `PfOpenOptions.executor` 缺席时的那个档），
`advance` 交；两者都不结算——节点结束这件事归 `settle`。线的决定不从这里进：想停线是
`ledger.cycles.setStatus(<线>, 'inactive')`，想点名下一个节点是 `ledger.cycles.hold`，判定用的策略
住在线自己的记录里（节点的 `mode`、线的 `when_shelved`、边界指令的 `stop_after_nodes`），结算只读
它们。

`prepare` 是派发准备的写侧、单独一个入口——它读同一份规划、只接受交回 `dispatch` 的那一份，把
提示词与运行稿按同样的落点落下（交接单模板随材料交回；线配了 `source: ticket` 的读数且门上有
生效值时，模板多带一格 `reading`），不开会话、不碰执行者；`dispatch` 是整段派发——先读这一格
（线、节点）的 `started` 记号：它已经在盘上就直接答 `already_open`（不碰执行者、不写一个字节；
`session` 缺席，那张收据属于当初开出它的那次调用），否则先过插件的拦下缝（任何一家拦就是拦，
错误码 `dispatch_blocked`，理由逐条列在错误文案里），再做派发准备（与 `prepare` 同一份材料）。
这一格（线、节点）的提示词**已经在盘上**时，准备这一步整个跳过：那份提示词是应用步落的，
而「提示词在盘上、`started` 记号不在」这一对盘上事实本身就是一次派发，哪怕规划此刻还在等交接单
——跳过时不落第二份材料，只落 `started` 记号。绿灯才把请求交给注入的执行者，请求带着这一格解析
出来的 `model`（本次调用点名 > 线的策略 > 机器的开关）。交回的只是收据：`opened`
带 `session`，说的是会话已经开着；节点的收场由 worker 写交接单、再由 `settle` 结算。记号随之落盘，
规划从此把这一格算作在飞，不再派第二遍；执行者缺席或抛出时，记号不落、记录一个字节都不动。记号
写不下去当场抛出：会话已经出去了而盘上没有凭证，文案带会话 id，并说清再派一次会开出第二个会话；
凭证落盘之后才回成功。演练档（`DSH_CONDUCT_SPAWN_DRY_RUN`）下会话不开、记号也不落，格子仍然是
可派的，演练从来不需要拆。`handoff` 把交接单落盘：线要在册、节点要在认领名单里（否则 `not_holding`，
什么都没写就拒绝），判决词只收 `completed` / `failed` / `stopped`（`pending` 是重跑的记号），
票据落在 `signals/<线>/<节点>.json`，同一节点的第二张票整文件顶上。

**预演是同一个动作减去效果。** `settlePreview` / `dispatchPreview` 是上面两个写动作的读版：同样的
门槛（`settle` 那对数、`heldNodeId`、`started` 记号的存在）、同一份判据（`settleClose`）、同一条
解析链（`modelOf`），插件缝问的是各家自己的预演（`offer_preview` / `check_preview`），
上下文带 `preview: true`、`run` 拒跑。`dispatchPreview` 把拦下的理由当数据交回（`blocked`），不抛；
`settlePreview` 的 `target` 就是插入缝的落点——这一单本该开的下一个节点，`seam` 是各家预演交回的
节点（还没有 uuid，所以没有正文），`plan` 是这条线收完之后读到的计划。两个预演都写零字节：材料不落、
记号不落、认领不落、图不动，进程里没有执行者也能答。命令面用 `--dry-run` 叫它们（`settle --dry-run`、
`dispatch --dry-run`）；记录内的动作没有这个旗标——它们的预演是 `next`（收尾那半边是 `next` 的
`after`）。
`doctor` 两半都接：插件面是严格面——装上的插件先逐插件列一条（名字、摘要、旋钮、标签、
方法、来源与命令，全从声明读出），再逐条列坏点；记录面四格——`init` 的四份布局
齐不齐、图有没有环与悬空引用、线手里的节点还在不在图上，以及合并驱动的两个键在不在本项目
的 git 配置里（这一格要一台 git：`doctor(options?)` 的 `options` 是
`ConductorDoctorOptions { git?: GitRunner }`，与 `ledger.init` / `ledger.register` 一个形状；
这一次调用没给 git、或这里不是 checkout，那一格只说没问、不判红；丢给 git 的每一问都带一个
上限，到点没答这一格判红——问的是哪条 git 命令、上限多少、实等多久都点出来，没读到的注册
不当作在场，下一步该怎么办也一并说清，其余格子照常算完，不被这一格拖住）。
没有 `.pf/` 的新项目不算红，那一格只说该跑一次 `ledger.init`。

**`close` 是 `settle` 加应用步，不开会话。** 用同一套收尾判据，落地多走一步：补满空槽，停了且
手空的线转 `inactive`。开不开会话是 `close` 与 `advance` 的唯一区别；线接不接着走、下一个点谁，
不在这里答——那是线的状态（`ledger.cycles.setStatus`）与认领（`ledger.cycles.hold`）的事。

**`handoffForm` 交回 `HandoffForm { cycle; readings }`**：`readings` 是这条线要 worker 上报的读数格
（`source: ticket` 的声明，且它的 `when_knob` 在链上有生效值），按声明次序，一格一个
`{ key; ask }`。它读线、读设置链，一个字节都不写；这条线不在记录里时拒绝。

**插件的命令词走 `pluginCommand`。** 路由表里没有这个词时答 `{ plugin: null, ran: false }`——调用方
据此说「没有这条命令」；有的话就在本进程里按插件契约跑（`main(argv, ctx)`），跑完算 `ran: true`，
它答了文字就填 `text`（只做动作、不答文字的命令照样算跑过），`main` 交回一个数字就把这个数字填进
`code`——那是这个插件要调用方留下的退出码，交回别的（或什么都不交）时 `code` 是 `null`；抛出则
`ran: false` 并把那句话放进 `error`。插件自己的 stdout / stderr 是它在本进程里直接写的，调用方
不必、也不能替它重印一遍。调用方拿到 `code` 就原样交回。

### 只读规划（`conductor.next`）

`next` 读图、线、指令、交接单与派发记号，算出「下一步该干什么」，一个字节都不写：它不持锁、
不认领、不写 prompt、不碰执行者。写侧是各自只做一件事的动作：`conductor.settle` 收这一单
（判决进 path、认领放下、图落态、收尾插件缝跑完），`conductor.dispatch` 开一格自己的会话，
`conductor.advance` 把认领、材料、会话按次序串成一步（宿主自己推线时用）。回答本身就是一份计划：
挑中谁、为什么是它、被谁挡在外面、这一步之后停在哪儿。

动作是六个词之一：`dispatch`（节点已被认领：交给执行者；它这一格的材料还没落时 `dispatch` 顺手
补上）、`open_node`（线手上还没有节点、或收尾空出了槽，该把排序挑出来的那几个钉下来）、
`stop_pipeline`（没得做了 / 有人叫停 / 这条线不在服务中）、`wait`（时候没到：交接单还没结果或
还是 `pending`、会话已经开出去了）、`ask_user`（状态自己说不清）、`no_cycle`（一条线都还没有，
开线是人的意思）。

- **ready 与 running 是读出来的标签**：ready = 自己是 todo、依赖都交付（悬空依赖视同交付）、
  且没有别的线拿着；running = 某条线此刻拿着的 todo。盘上只有三态与线的 `holding`，两个标签
  互斥、读的时候算，谁也不解释谁。
- **挑点只有一份排序**：紧急乘重要的全量次序从 `ledger.dag.list` 拿，规划只按就绪、这条线
  自己的选材范围（`tags`）与别的线的持有删行；一条线一次挑到 `parallel` 所容的槽位，被挡在
  外面的分开说明原因（标签藏了 / 别的线拿着），并列按图上已有的稳定次序。
- **停手只有一处**：停手位由节点自己的 `mode` 定（`checkpoint` 收尾即停、`manual` 的闸在会话
  里、`auto` 收尾就开下一个），边界指令的 `stop_after_nodes` 只能把停的规则收紧、不能放宽；
  线自己的 `when_shelved` 决定节点没交付之后这条线走不走。
- **计划交动作，不交写侧的命令**：收节点、落 prompt、钉下一个这些机械步留在动作身后，计划
  只把「还没跑」这件事说成 `settling`。

问法（`NextQuery` 的可选字段，都可不给）：`cycle` 点名一条线；`after` 点名一个已经交回交接单
的节点，问「按它收，这条线会走到哪」（收尾预演，只算不写）。

命令面一眼对应：`plan` 读这份计划，`settle <node>` 收一单（预演是 `settle --dry-run`），`hold <node>`
钉住计划点的那个，`dispatch <cycle>` 开它的会话（预演是 `dispatch --dry-run`）；`advance` 是钉、材料、
会话三步的合成词，标准流程不必经过它。

## 插件

插件让引擎在固定的时机做固定的事；引擎不实现任何具体插件。一个插件是插件目录（缺省
`<root>/plugins`，一个插件一个文件夹）里的一个文件夹：一份纯数据的声明 `plugin.json`、一个
实现入口 `impl.mjs`，自带技能（`skills/<语言>/<方法>/SKILL.md`）也住在文件夹里、随插件装与
卸。装载只读声明、绝不执行它，时机的门才调用实现；实现装进本进程，插件命令也在本进程内
跑，不联网、不启动外部进程。

- **闭集校验**：声明的顶层键与每格的键都过闭集，未知键拒绝；声明可以列旋钮、读数、度量、
  来源、文件与命令。旋钮格必带 `kind` 与 `default`：`default` 写 `null` 表示这一格没有出厂值，
  写具体值就按它当出厂值（种类不合同样是声明问题）；字段缺席也是声明问题，整个插件不可用——
  不只是这一格落空。时机只有两个（close 收尾 / dispatch 派发），与动作（insert 插入 /
  block 拦下）合成一格才算数——close 只能插入，dispatch 只能拦下，声明出表外的格子、
  或只写时机不写动作，都是声明问题。
- **两道门**：收尾插入——插件交一份 offer（节点标题、标签、正文），经核心机制落图，
  节点、spec.md、依赖边都成为图的一部分；派发拦下——各家各交一句理由，任何一家拦就是拦
  （错误码 `dispatch_blocked`，理由逐条列在错误文案里）。插入只发生在收尾这一步——`settle`，以及
  把结算串起来的 `close` / `advance`；`next` 是只读规划，不写记录、不插节点。
- **每个时机欠一份预演**：实现入口在 `offer` / `check` 旁边交出 `offer_preview` / `check_preview`，
  同一条判据、同一套上下文——预演的上下文能读（`knob` / `reading` / `capture`），`run` 拒跑并留
  一句 WARNING（效果归真时机）。没有预演的插件照常在真时机里生效；预演时它被跳过、留一条点名的
  WARNING，`doctor` 把这条缺口当提示列在插件面里（不是声明问题、不判红）。
- **运行时容忍、doctor 严格**：坏插件在运行时折成一句 WARNING、这一轮不出力，主流程照常；
  doctor 把坏点逐条列出——声明、实现装载、自带技能、认领的来源，外加对着替身项目把实现
  真实问一遍（声明配了门而实现缺入口、答非所问都算坏点）——另报两张撞名表：插件旋钮撞
  内置设置名、插件命令撞核心动词，都是核心赢并报告。
- **宿主上下文**：插件在一个时机看到的是调用方已读好的现场（线记录、手里的节点、交接单、
  图快照）加几样能力：按名字取旋钮（走 `pf.config` 的整条解析链，插件声明的旋钮并入同一张
  清单）、取读数、按标签取节点、在本进程内跑一个插件命令（交回它是否真的跑起来了：词没人
  认领、实现没有入口、命令抛错都是没跑起来；跑完而没答文本仍算跑起来了）、节点 spec.md
  的落点。预演时上下文多一格 `preview: true`，`run` 拒跑。插件可用 `enable_knob` 挂自己的
  开关，开关解析出 off 就整轮跳过。
- **出口**：插件契约的类型经 `src/index.ts` 按类型出口。

## 执行者接缝

- `interface Executor { dispatch(request: DispatchRequest): Promise<OpenedSession> }` ——
  引擎之外的执行只从这里交进来；接口上没有拉起进程、打开会话的入口。派发把节点交给一个会话，
  promise 在会话**开着**的那一刻结束：节点的结果由 worker 写成交接单、再由 `close` 结算。
- `class SimulatedExecutor implements Executor` —— 模拟开出一个会话：按次序交回 `sess-1` /
  `sess-2` …，并把收到的每次派发请求记在 `dispatched` 里；脚本是 `'open'`（缺省）、`'throw'`
  （开不出会话就抛）或 `'hang'`（永不落定），给函数就按请求与序号逐次现算。
- `DispatchRequest { cycle?; node?; role?; prompt; model?; dryRun? }`，
  `OpenedSession { sessionId?; host? }`。后几格都由派发这一次调用现读：
  - `model`：这场会话用哪条模型路由，一个 `provider/model` 的词、整格交给执行者。次序是本次
    调用点名的 `model` > 线的 `model` 策略 > 机器的 `DSH_CONDUCT_MODEL`；都没说时缺席，执行者
    自己的缺省说了算。
  - `dryRun`：演练档开着时是 `true`（缺席即关）。调用照做、回执照给，但执行者不许真的开一场会话。

## 运行时开关

环境变量，读在**每次调用**上，不在 import 时缓存。显式选项永远压过它，它压过出厂缺省；一个都
没设时，行为与没有这些开关时一字不差。

| 开关 | 读在哪 | 语义 |
| --- | --- | --- |
| `PF_HOME_DIR` | 机器层设置的 home | `<home>/.pf/config.json` 的 home；沙盒靠它把机器层关进临时目录，不碰真的 `~/.pf` |
| `PF_PLUGINS_DIR` | 插件目录 | 一个插件一个子目录的那个目录；去掉首尾空白，空值读出厂缺省 `<root>/plugins`；以 `~` 开头的路径按本机 home 展开（光杆 `~` 就是 home 本身） |
| `DSH_CONDUCT_SPAWN_DRY_RUN` | `conductor.dispatch` | 演练档：值不是 `''` / `0` / `false` / `False` 就是开，请求多带 `dryRun: true` |
| `DSH_CONDUCT_MODEL` | `conductor.dispatch` | 下一场会话用哪条模型路由（`provider/model`，整格交给执行者）。本次调用点名与线的 `model` 策略都压过它；都没说时这一格缺席，执行者的缺省说了算 |
| `DSH_SESSION_ID` | `ledger.dag.add` | 本进程自己的会话 id：登记节点时作为这个节点的 discussion 会话记进它的会话档。尽力而为，写不进去也不回滚已登记的节点。本引擎只在这一处读它 |

除演练档外，其余开关都把值去掉首尾空白之后再用，空值当没说；路径形的值里只有 `PF_PLUGINS_DIR` 认
`~`（展开到本机 home），其余开关按写下的字面读。演练档是例外：它原样读、不去空白，值只在 `''` / `0` /
`false` / `False` 四个词上是关——`' 0 '`、`'   '` 都算开。

## 可判定错误码

错误码就是契约，文案由调用方自己写。`PfError` 带 `code`（下面这些词）、`path`（出错时面对的那份
记录或那把锁）与 `message`；`isPfError(value, code?)` 只读 `code`，不碰文案。

| 层 | 错误码 | 什么时候 |
| --- | --- | --- |
| 底座 | `invalid_utf8` | 读到的字节不是 UTF-8 |
| 底座 | `parse_failure` | 字节是 UTF-8，但 JSON 解不动 |
| 底座 | `lock_timeout` | 等锁到上限都没拿到，什么都没改 |
| 设置 | `unknown_key` | 旋钮名不在清单上（拒绝里把可配的名全列出来） |
| 设置 | `invalid_value` | 值不合种类：写侧拒绝，什么都没写 |
| 设置 | `layer_not_allowed` | 这个旋钮不收要写 / 要读到的那一层（拒绝里点名它收哪几层） |
| 设置 | `cycle_not_found` | 点名的线不在这个 `state.json` 里 |
| 设置 | `node_not_found` | 点名的节点不在图上，或它的拼法当不成一个节点目录名（分隔符、`.` / `..` 都当不成路径）；空 id 不归这个码——它在更早的层参数校验里就是 `TypeError` |
| 设置 | `ambiguous_holder` | 一个节点被两条线同时认领，节点读数落不到线层：不猜是哪条，线层不读 |
| 设置 | `not_a_project` | 交给设置动词的那个目录自己没有 `.pf`（不往上猜） |
| 设置 | `invalid_config_file` | 那一层文件的 JSON 顶层得是一个对象（键 -> 值），别的形状报这个码 |
| 设置 | `worktree_mode_unsupported` | 按模式读 `worktree_mode` 读到的不是 `off` / `fork`（`reuse` 一读到就拒绝）；模式原样交回，什么都没改 |
| 流水线 | `dispatch_blocked` | 派发被插件的门拦下（理由逐条在文案里，什么都没改） |
| 流水线 | `nothing_to_settle` | 收线结算被拒：这个节点的交接单缺席或还是 `pending`，没有判决可结算 |
| 流水线 | `not_holding` | 点名的节点不在这条线的认领名单上：票没处写、这条线没东西可结算 |

其它磁盘失败（权限、路径越界……）按 Node 自己的错误抛：那些本来就带可判定的 `code`，底座不再
叠一层词汇。

## 冻结的记录类型

六种记录的形状（类型、键名、取值词汇）在 `src/types.ts`，落点如下：

| 记录 | 落点 |
| --- | --- |
| 节点 | ideas.json 的 `nodes` 表值 |
| 线 | state.json 的 `cycles` 表项 |
| 指令 | instructions.json 的 `instructions` 表项 |
| 问题 | issues.json 的 `issues` 表值 |
| 交接单 | signals/&lt;线&gt;/&lt;节点&gt;.json（整个文件就是一条记录） |
| 会话档 | meta/sessions/&lt;节点&gt;.json |

时刻有两种拼写，都是 UTC 加字面 `Z`：微秒形用于节点与问题的时刻；秒形用于线、交接单、
指令与会话档。

# dsh-superworker

[English](README.md) | 中文

`dsh-superworker` 是一个 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 插件：把
`.superworker/` 那份管线记录画成 DSH Web UI 里的一块面板。

宿主半身按当前会话的工作区读那份记录（`.superworker/`），经网关交出去；浏览器半身把它画成侧栏里的「超级工坊」。
屏上的一切——指令、节点明细、谁欠谁的那张地图、问题池——都从那份记录上来，面板里的写回也进同一条路。

会话里管线还可以走 agent 面的 `superworker` 工具：它在本会话就地应答管线的那套词。这个工具整个 host 只注册一次，
每一步由注册表问同一个条件：工作区里有 `.superworker/` 记录的会话，第一个请求就带它，并且每一步都把当前生效的指令
带进上下文——与在那个工作区跑一次 `instruction list` 逐字相同（git worktree 里开的会话，那份清单按它主树来）；
一份记录都没有的地方，工具在一条 `sw-*` 技能被加载、或用户敲下 `/sw-*` 时出现——`/sw-*` 在那一步发出请求之前就被看到，
所以带技能正文的那个请求同时也带着工具。在那之前，这个会话的请求头与没装本插件时一字不差。那份记录每步都重新读一次：
会话中途出现了记录，下一步就带上这个工具；走出那个工作区，下一步就不带了。

## 状态

早期，跟着 DSH 的开发者预览走。包面用 `engines.dsh` 声明了一段兼容范围，落在范围外时 DSH 会拒装、拒起
（报 `incompatible-version`，并给出豁免的命令）。范围按 DSH 的破坏边界画，并且从这一行自己那条机制开始：
**0.2.2** 是第一个会向注册问「这一步要不要它」的 DSH，工具的可见性正是由那个答案决定，没有管线的会话才
看不到它。更早的宿主不问这个条件，那儿的工具也就永远不会出现，所以那些实例被拒在范围外。0.2.x 之内后面
出多少个 rc 都放行，0.3 换线时才动。

它画的那份 `.superworker/` 记录同样还在成形：还要继续改进和打磨，形状会随着设计落定逐渐稳定。改动跟着真管线上跑出来的经验走，
形状因此朝一条管线真正需要的样子收敛；那条真管线上的反馈，就是下一次改动的方向。

## 安装

前提：装了 `dsh`，手里有一个装得进插件的 profile；要看的工作区里有一份 `.superworker/` 管线记录。面板的写入由宿主半身在原地作答（走引擎自己的词面），因此这个包不装命令，PATH 上也不需要安排条目。
面板按「当前选中的会话」定工作区——没选中会话时它自己会说明。

从本仓的 [Releases](https://github.com/infraredsqy/dsh-superworker/releases) 下载那个 `.tgz`，把 DSH
指到这个文件：

```sh
dsh plugin --profile <名字> add ./dsh-superworker-<版本>.tgz
dsh plugin --profile <名字> add dsh-superworker               # 同一份产物，按名字装（npm）
```

包里是预构建产物，装的时候不跑任何构建。装完 pnpm 若列出几条 `missing peer` 警告：那几个包由 DSH
本体提供、运行时解析得到，警告可以无视。第三条路（从 git 装）与版本兼容的口径见
[docs/publish.md](docs/publish.md)。

## 装完有什么

- 侧栏多出「超级工坊」一项：地图、明细、指令、问题池，以及面板自己的设置
- DSH 设置里多出「工坊配置」一节：指令显不显已归档、问题显不显未解决之外的、一条线收尾后要不要自己开下一棒，以及当前生效的指令要不要带进会话上下文
- 核一下装没装上：`dsh --profile <名字> --dump-config`，找 `# == dsh-superworker` 那一节

## 开发

```sh
pnpm install --frozen-lockfile
npm test                  # 单测：先把两份产物构建出来，再跑两套测试
node tools/css-check.mjs  # 样式层的规矩
npm pack                  # 打出分发件
```

`npm test` 先把两份产物构建出来，再跑两套测试（本插件与引擎包各一套）。每个文件锁什么、什么只能手走，
在 [tests/AGENTS.md](tests/AGENTS.md)；手动单子与 `tools/testbed/` 在 [docs/publish.md](docs/publish.md)。

仓库的路牌与规矩在 [AGENTS.md](AGENTS.md)。改界面前先读
[docs/design-principles.md](docs/design-principles.md)，发一版前看
[docs/publish.md](docs/publish.md)。

## 联系

在你自己那条流水线上用它的技术支持、用后想说的话、以及商务上的问题，发到
[infraredsaw@gmail.com](mailto:infraredsaw@gmail.com)。缺陷与功能请求更适合开一条
[issue](https://github.com/infraredsqy/dsh-superworker/issues)：下一个人撞上同一堵墙时找得到它。

## License

[MIT](LICENSE)

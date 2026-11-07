# dsh-superworker

[English](README.md) | 中文

`dsh-superworker` 是一个 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 插件：把
`.superworker/` 那份管线记录画成 DSH Web UI 里的一块面板。

宿主半身按当前会话的工作区读那份记录（`.superworker/`），经网关交出去；浏览器半身把它画成侧栏里的「超级工坊」。
屏上的一切——指令、节点明细、谁欠谁的那张地图、问题池——都从那份记录上来，面板里的写回也进同一条路。

会话里管线还可以走 agent 面的 `superworker` 工具：它在本会话就地应答管线的那套词。工作区里有 `.superworker/` 记录的会话，
第一步就能看到这个工具；别处要等一条 `superworker-*` 技能被加载——在那之前，这个会话的请求头与没装本插件时一字不差。

## 状态

早期，跟着 DSH 的开发者预览走。包面用 `engines.dsh` 声明了一段兼容范围，落在范围外时 DSH 会拒装、拒起
（报 `incompatible-version`，并给出豁免的命令）。范围按 DSH 的破坏边界画：0.2.x 之内出多少个 rc 都放行，
0.3 换线时才动。

它画的那份 `.superworker/` 记录同样早、动得同样快：记录的形状也会有破坏性变更。

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
- DSH 设置里多出「工坊配置」一节：指令显不显已归档、问题显不显未解决之外的
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

## License

[MIT](LICENSE)

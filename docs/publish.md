# 发布与安装

> 这页只写**做法**与**已知限制**：这个包怎么发出去、别人怎么装进来、装完怎么核。
> 它写的是**通用口径**，每次发版本都适用；某一次发布里的临时问题、清理残留的事项不进这页。
> **这页不写版本号**：插件自己的号与 DSH 的号都不进这页。
> 包名与仓名都是 `dsh-pathfinder`，侧栏那一格叫「寻路中心」，DSH 设置里那一节叫「寻路配置」。

## 交付形态：预构建产物随包走

用户端不跑构建。四份产物在本仓构建一次，构建链的正本就是 `package.json` 的 `prepack`（引擎排头，types 与
两份 bundle 跟后）——本页不抄第二份；`npm pack` 与 `npm publish` 会自己把它跑一遍。

`package.json` 的 `files` 只收这几样：两个运行时入口、`lib/types/**/*.d.ts`、`locale/*.json`、
`cordis.patch.yml`、`packages/pf-core/dist/**/*`（引擎的产物：并入宿主半身的那份代码，加上 git 合并驱动要跑的入口），
以及 `packages/pf-core/plugins/**/*`——插件目录整个进包，随插件装与卸的那几套技能
就在里面（一个技能指向同目录的兄弟文件，半个文件夹装出去就是引用的文件不在），技能文本与引擎因此落在
同一份发布件里。于是 `npm pack` 出的那一个 `.tgz` 就是分发件本身（`lib/client-body.js` 是浏览器
那一步的中间件，构建脚本用完当场删掉，不进包）。三个运行时口子：

| 口子 | 落点 | 谁用 |
|---|---|---|
| `.`（`main`） | `lib/host/index.js` | 宿主半身：装成 `ctx.pathfinder`，那几手端点经网关交出去 |
| `./client` | `lib/client.js` | 浏览器半身：`dsh.client.platform` 是 `web`，外壳按启动名册去拉这一份 |
| `./locale/*.json` | `locale/{zh,en}.json` | DSH 的插件清单读它来印这一行的名字与说明；与面板自己的对照表是两处（那份在浏览器包里，说面板上的词） |

`dsh.bundle.patch` 指着 `./cordis.patch.yml`（一条 `insert`，行 id `pathfinder`）。装进一个 profile 时
`dsh plugin add` 会把这一层并进那个 profile 的 `dsh.profile.bundles`，profile 自己的
`cordis.patch.yml` 照旧可以按 id 把这一行关掉。

`./client` 那一条还带两行加载依赖：

```json
"dsh": { "client": { "platform": "web", "inject": ["@deepseek-ai/dsh-client-connection", "@deepseek-ai/dsh-client-locale"] } }
```

**这两行都不能摘**：外壳照启动名册先送达 `connection` 那条客户端插件，再应用本包的面板，浏览器半身
那条取数口子才接得上。摘掉之后面板应用得早，中央栏那一格正文里没有记录的数，摆的是「该部署未连接
寻路记录服务，无法读取记录。」（宿主那一侧的端点 `pathfinder/read` 照旧是好的）。
`locale` 那条管的是语言：不声明它，面板照样画得出来（语言端口会退回包里那份中文对照表），但跟随 DSH
设置切换语言这一条就接不上了。

`engines.dsh` 那段范围的出处是 `package.json`：宿主半身有一处**运行时的**外部依赖
`@deepseek-ai/dsh-typert-protocol`（与 DSH 本体锁步同版本发布），只有换线才可能动它。所以线画在 DSH 的
破坏边界上，不画在某个 rc 上——`>=0.2.1-rc.2 <0.3.0-0`：0.2.x 之内出到第几个 rc、第几个补丁号都放行，
0.3 那条线连同它的 alpha 一起挡在外面。末尾那个 `-0` 不是笔误：DSH 判范围用的是
`semver.satisfies(runtime, range, { includePrerelease: true })`，写成 `<0.3.0` 时 `0.3.0-alpha.1` 排在
`0.3.0` 前面，照样会放进来。

包面那几条前提由 `tests/package-surface.test.mjs` 看着（`npm test` 跑）。改包面之后跑一遍。

## 打一个包

```sh
npm pack --pack-destination .tmp/pack
```

`npm pack` 不需要登录、不改仓；`.tmp/` 不进版本库。产物清单从 `.tgz` 自己列：`tar -tzf <路径>` 就
够（在 `.tmp/pack` 里用叶子名也行）——Windows 上若跑的是 Git 带的那套 GNU tar，绝对路径要写成
`tar --force-local -tzf <路径>`，且 `--force-local` 必须排在短选项前面。

同一份内容打出来的 `.tgz`，sha256 是稳定的（`npm pack` 把归档里每个成员的 mtime 归一，产物因此
可复现）；要核对手上那份出自哪份源码，跑 `Get-FileHash -Algorithm SHA256 <那份 .tgz>`，拿它与源码
那一侧打出来的那份比。

## 发一个版本

> **发版本要人明确同意**：机制上办得到不等于该发，也不许为验证什么（比如刚配好的可信发布配置）专门发一版；
> 验证只在下一次真发版时顺带完成。不进包的东西改了（`docs/`、注释、测试、CI 配置）不构成发版理由。

作者侧走 **OIDC 可信发布**（npm 的 trusted publishing）：令牌只在发布那一刻由 CI 现换，**本仓与本机都不
留任何长期秘密**。没有 token 可丢、可轮换，也不需要有人守着一次 2FA 提示。

发布者是 `.github/workflows/publish.yml`，触发面只有两处：推 `v*` 标签，或手动 `gh workflow run publish.yml`。
它的权限只有 `id-token: write` 与 `contents: read`——**不要往这个 workflow 里加任何 secret**，加了就把这套
设计的意义抹掉了。

### 一次性前置（只有包从没有到有的时候需要）

1. **包得先在 registry 上存在**：可信发布是配在「包的设置页」上的，没有包就没有地方配。所以**首次必须由人
   手动发一次**，两条走法（都得显式带官方 registry，见「已知限制」里镜像站那条）：
   - `npm stage publish`：**这一步不要 2FA**，发完到 npmjs.com 的 Staged Packages 标签里批准（批准那一下要 2FA）。
   - `npm publish`：当场要一次交互式 2FA，而**它必须在有终端的窗口里跑**——没有终端时 npm 只印 `***`、也不拉
     浏览器，由自动化进程代跑只会拿到一条用不了的错误；有终端时它印出
     `https://www.npmjs.com/auth/cli/<uuid>`，把那串拿到**配了 2FA 的那台设备**上完成即可。
2. 在包设置页加 **Trusted Publisher**，并**同时允许 `npm publish`**（默认只给 `npm stage publish`，两个权限
   相互独立）。**那几个字段的值不抄在这页**：owner/repo 照 `package.json` 的 `repository.url`，workflow 文件名
   照 `.github/workflows/` 下现存的那些文件，逐字一致（大小写与 `.yml` 后缀都算）。
3. **这个配置有寿命**：建好后 **2 天内**得有一次成功的 OIDC 发布，否则配置过期、不可编辑，只能删掉重建。

### 日常发版（照这个顺序做）

```sh
# 1. 改 package.json 里的 version
# 2. 提交
git add -A && git commit -m "<type>: <description>"
# 3. 打标签（本仓的标签习惯是 v<version>）
git tag v<version>
# 4. 推分支与标签——推标签就是触发发布
git push origin <分支> && git push origin v<version>
# 5. 盯这次 run，别只看 push 成功
gh run list --workflow publish.yml
gh run watch
# 6. 核 registry 上那个号，不是 exit code
npm view dsh-pathfinder version --registry=https://registry.npmjs.org
```

`prepack` 也在 CI 上现跑一遍（构建链的正本见 `package.json`），所以装出去的就是这份预构建产物。
`tools/testbed/` 那条要一个真实 DSH 实例，留在本机手动跑。

新包名第一次发布会先落一个**公开的占位版本** `0.0.0-stage`：它一直留在 `versions` 列表里，真版本随后就公开；
它只是这个新名字落地时的一枚印记，`npm stage list` 列不到它属正常。`publishConfig.tag` 在的话 `latest` 会自己
指到真版本。

### 发完要核（每一次）

这条路上有几件事只有真跑一次才作数，别只看 `npm publish` 与 `git push` 的返回码：

1. **workflow 真被触发了**：`gh run list --workflow publish.yml` 里有一条对得上这个标签的 run，再用
   `gh run watch` 看它跑完。
2. **runner 上的两道闸过了**：CI 里的 `npm test` 与 `node tools/css-check.mjs` 都绿。本地绿不等于那边绿——
   runner 是 linux，node 与 pnpm 的版本照 `.github/workflows/publish.yml` 里那套。
3. **OIDC 认得上**：这是可信发布配置**唯一的验证时机**（它只有跟着一次真发布才算验过）。报 `ENEEDAUTH` 就是
   那三个字段与实情对不上；配置建好后 2 天不跑一次就过期，所以"建配置"与"发那一次"要挨着做。
4. **registry 上真换了**：版本号、`dist-tags` 的 `latest`、`dist.shasum` 三项都对，才算发出去的是同一份产物。
5. **provenance 在**：OIDC 发出去的那一版会在包页面带上 attestation（public 仓 + public 包才会生成）；看不到
   它，说明这一趟没走 OIDC。
6. **本机不留长期秘密**：首次手动发布留下的那条登录 token 与 `_authToken` 行，等 CI 这条路跑通之后按需撤掉。

## 三条安装路子

三条都走 DSH 自己那一条入口 `dsh plugin --profile <名字> add <目标>`（它自己跑 pnpm）。

### 1. 从 npm 装（给所有人装的那一条）

```sh
dsh plugin --profile <名字> add dsh-pathfinder      # 用户侧
```
作者侧怎么把这一版推上去，见「发一个版本」——那一条走 CI，这页不写登录与凭据。

`package.json` 的 `publishConfig.tag` 写着 `latest`：这个号是预发布（`-rc.`），npm 对预发布号不带 `--tag`
会直接拒发，声明了这一条才算显式指定。用户侧那条裸名解析的就是 `latest`，所以这一条在，上面那行命令才
成立。将来发正式版本时，`latest` 会自己移过去。

### 2. 从 GitHub Release 的 `.tgz` 装（兜底的那一条）

作者侧把 `npm pack` 出的那一个 `.tgz` 传成 Release 的附件；用户侧下载附件，然后

```sh
dsh plugin --profile <名字> add ./dsh-pathfinder-<版本>.tgz
```

这条路与 npm 那一条装的是同一份预构建产物，不跑任何构建脚本。

### 3. 从 git 装（开发者自用）

```sh
dsh plugin --profile <名字> add github:<owner>/<repo>
```

拿到的是**源码**：构建产物不在里面，而 pnpm ≥10 拒绝跑依赖包的构建脚本——第一次 `add` 会失败并印出
要授权的那把键，照它印的写进那个 profile 的 `pnpm-workspace.yaml`：

```yaml
allowBuilds:
  dsh-pathfinder: true
```

再装一次。那条授权等于允许这个包在装的时候在你机器上执行代码 —— 只对可信来源这么做，并钉一个
commit。本仓有的是 `prepack`，它管不到这条路（pnpm 为 git 依赖跑的是 `prepare`，而构建脚本还要
用户先放行）：这条路要先把产物构建好，或者补一条自足的 `prepare`。

## 装完怎么核

```sh
dsh --profile <名字> --dump-config                     # 打印合成后的配置树，不起服务
dsh plugin --profile <名字> remove dsh-pathfinder      # 撤销：依赖与那一层一起摘掉
```

在 `--dump-config` 的输出里找 `# == dsh-pathfinder` 那一节，它下面的头一个顶层行就是这一行
（`- id: pathfinder`）；行里的 `name:` 指的就是这个包，宿主入口与浏览器半身两份都得在盘上。

层顺序是 profile 的 `dsh.profile.bundles`（按清单次序）→ profile 自己的 `cordis.patch.yml` →
`$DSH_HOME/cordis.patch.yml` → 命令行上每个 `--patch`，后一层按行 id 覆盖前一层；一条 patch 落到
目标行上时，那一行的整个 `config` 一起换掉，逐键合并的写法在这里读不到。

技能不在合成配置里，它落在 DSH 读技能的那个根：这一行装载时，插件文件夹里那几套技能被写进
`$DSH_HOME/skills/<技能名>/SKILL.md`（缺省跟 DSH 那一家 provider 一样：`DSH_HOME`，否则 `~/.dsh`），
清单记在 `$DSH_HOME/pathfinder/skills.json`（升级时先按上一次的清单摘掉旧的一份，再写新的）；这一行
被卸下来时按那份清单摘净，别人的技能一个不碰。那个根里已经有别人的同名副本时，这一行的技能就不装
（面板照常起来），拒绝里点名两处——这一行的那份与占名的那份——一个字节都不写。

## 发布件里没有命令，只有一个可执行入口

装插件装的是面板。这个包里没有一条要给人在 shell 里敲的命令：每个词都在进程内作答——会话里是
`pathfinder` 工具，面板里是那几手端点，两边走同一份 `answer()`。字段上也看得出来：`package.json`
没有 `bin`，`files` 里没有 `bin/`。

唯一会被别的进程启动的文件是 git 的合并驱动，它在引擎产物里：

- `<装机目录>/packages/pf-core/dist/merge-ledger.mjs`。git 按 `merge.pf.driver` 这条字符串起进程，
  参数是 `%O %A %B %P`；登记在承载记录的那个仓库的 git config 里，`init` 顺带写、`register` 重写。
- 登记有三种写法：PATH 上有 `pf` 时写 `pf merge-ledger %O %A %B %P`（旧装机的命令还能用），只有
  `pf-merge-ledger` 时写那一条，两条都没有时写绝对形——两个带引号的路径，解释器加这个文件。
  绝对形只指向发布件里自己的文件，不回到仓、也不要 `node_modules`，所以装到哪儿都答得起来。
- `doctor` 的 `merge-driver` 那一格认这三种写法，并判断它在这台机器上真的跑不跑得起来。

卸掉插件：

```sh
dsh plugin --profile <名> remove dsh-pathfinder
```

面板那一行从 profile 的 `dsh.profile.bundles` 里消失；再装上同一个 `.tgz` 就回到新的这份。技能那一半也由发布件供给：`issue` 与 `test-audit` 两个插件带的四条
（`pf-issue-scan` / `pf-issue-repair` / `pf-issue-discuss` / `pf-test-audit`），加上 `pipeline` 插件带的三条核心技能
（`pf-conduct` / `pf-route` / `pf-instruct`，每份把它正文指向的 `shared/pf/` 单页带在自己目录里）。
都落在 `$DSH_HOME/skills`（真目录，`SKILL.md` 与该产物里的同哈希，根序 rank 400）。派发的第一行
`/pf-conduct <节点 id>` 因此在干净机器上也读得到；DSH 自己的 `~\.agents\skills` 是 rank 500 的那一根，
同一个名字在它面前读的是 `$DSH_HOME/skills` 这一份。

### 盘上留着一个常驻 `ledger.lock` 时

`.pf/meta/ledger.lock` 在引擎这一侧是**文件存在即互斥**：以排他方式建文件，建不上就等，等满 10 秒报 busy，
记录一个字不改。写完就删，所以它不是常驻文件。

别的读法把锁当成常驻文件（文件一直在盘上，锁的是文件内容），于是在盘上留下一个 0 字节的 `ledger.lock`：

- 留着它 → 引擎的任何写命令等满 10 秒后报 busy；
- 先把它备份到别处再删掉，引擎的写就正常了；
- 引擎自己不建常驻锁文件（写完就删），所以删过之后不会再出现；若它又出现，照上面再删一次。

引擎侧一个字不改（那是它的协议）。这条互操作记在问题池 `engine-lock-file-interop`。

## 发版前走一遍

自动的那三样，各跑一次：

- `npm test` —— 本插件与引擎包两套单测都过；浏览器半身把那几态挂到内存记录上逐格画一遍，控制台里出现
  一条 error 就算失败。面板**说什么**故意不在这里量。
- `node tools/css-check.mjs` —— 样式层的规矩。
- `tools/testbed/testbed.ps1 up|check|down` —— 真实例：这一行装得上、启动清单里列了它、宿主半身答得上话。

**验的是打包出来的那一份。** `npm pack --pack-destination .tmp/pack` 打出 `.tgz`，再用
`tools/testbed/testbed.ps1 up -Plugin <.tgz>` 装它：`prepack` 会把四份产物现构建一次，装到的才是发出去的
内容。隔离实例不带 `-Plugin` 时装的是本仓目录（pnpm 的 `link:`），读到的是盘上现成的那两份——而 `npm test`
只重建浏览器半身，宿主半身那份可能是旧的。

下面这些只有手动看。合成的隔离工作区里没有 `.pf`，正好是「没有记录」那一态；要看真记录下的读数，就把这一
行装进你自己那个 profile，在一个有 `.pf` 的工作区里开面板——本仓自己就有一份：

- 一份真记录：五格都画得出来——地图上的卡与线、问题池的读数、指令那一栏的三种作用域；
- 一个没有 `.pf` 的工作区：面板说这个工作区没有记录，五格不画；
- 一个 `.pf` 在、四份文件读不动的工作区：面板说记录读不动；
- 只有问题池、或只有管线的工作区：相应那两格各退化成一行话；
- 手上的动作：拖明细分隔条、切五个标签、切语言、加一条指令再归档再删掉、改一个配置值看它落盘。

没有记录、四份文件读不动、四个读数都空这几态在宿主层与模型层各有用例；**画出来那一层没有**——文案与布局
改得勤，钉进测试就是每次改词交两份代码，所以留在这里当单子。

## 已知限制

- **发布要显式打到官方 registry**：本机 `~/.npmrc` 的 `registry` 指向一个镜像站，镜像站只收下载、不收
  发布——登录与发布两处都得带 `--registry=https://registry.npmjs.org`。
- **别把自动化建在 bypass-2FA token 上**：这类令牌的**直接发布**在 2027-01 取消（身份与治理类动作 2026-08
  已经取消），之后它只剩"读私有包 + stage 一次发布、由 maintainer 用 2FA 批准"这一面。自动化一律走 OIDC。
- **CI 里不许用缓存**：发布构建不用依赖缓存（官方口径），`publish.yml` 里写死 `package-manager-cache: false`。
- **GitHub Release 那条腿多一步手工**：把 `npm pack` 出的那一个 `.tgz` 传成 Release 的附件；远端与那个
  release 都得先有。
- **`engines.dsh` 按 DSH 的破坏边界划，不按某一个 rc 划**：0.2.x 之内 DSH 换 rc 不需要本包跟一版；0.3
  换线时重量一遍再改这一行。被范围挡下是预期行为——DSH 报 `incompatible-version` 并印出 `allow-version`
  那条命令，豁免记在 profile 的 `compatibility.json` 里，插件升版与 DSH 升版都不继承。
- **git 那条路要用户在 profile 里授权跑构建脚本**（就是让这个包在装的时候执行代码）；预构建产物
  （npm 与 `.tgz` 两条）绕开这件事，所以那两条是主路径。
- **项目根的技能副本压过插件这份**：`<项目>/.dsh/skills` 与 `<项目>/.agents/skills` 是 DSH 自己的
  per-workspace 覆盖，比插件写进的 `$DSH_HOME/skills` 更近；同一个名字在那个工作区里读的是项目里
  那份，宿主只在日志里留一行诊断，不改盘。
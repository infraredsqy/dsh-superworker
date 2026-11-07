# 0.2.2 迁移笔记：把「事实唤醒」换成上游的每步门

> **这是一次性文件。**DSH 升到 0.2.2、`src/host/tool.ts` 的条件迁进 `when`、测试跟着改完之后，
> **把本文件与 `docs/AGENTS.md` 里指向它的那一行一并删掉。**它还在这儿，就说明迁移还没做完。

## 今天（0.2.1）是怎么做的

`src/host/tool.ts` 里三条触发共用一个唤醒，注册是「一次、per agent、粘住」：

- `wakeIfPipeline`：会话的 `agent/pre-step` 里看一眼工作区有没有 `.superworker/`，或一份认得出的旧记录目录，有就注册；
- `skill` 工具成功装载一条技能（事后）；
- 用户 `/sw-*` 的消息（pre-step 里扫消息来源）。

宿主没有「这一步到底给不给模型看」的概念：注册了就一直可见，所以可见性靠「什么时候注册」表达。

## 0.2.2 给了什么

- `ctx.tools.register(definition, { when })`：`when({ agent, modelSelection, signal })` 每个模型步求值一次，
  返回假 = 这一步的请求里既没有它的声明、也不能派发它；返回真 = 照常。
- 条件抛错会让整步准备失败（`ToolActivationError`），所以条件必须是**总的**：拿不到 cwd、`existsSync` 抛错，
  都回答「没有」。
- 能力探测：`typeof ctx.tools.resolve === 'function'`。0.2.1 的 `register(definition)` 只有一个参数，
  多余实参被 JS 静默忽略——「今天传了也白传」是迁移期可以依赖的事实。

## 升级时按这个顺序做

1. 升 DSH，按 `package.json` 的规矩动 `engines.dsh`（若从此只认 0.2.2，把下界挪过去）。
2. 把「什么时候注册」换成「注册一次 + 用 `when` 说话」：
   - `awake` 拆成两个记号：`armed`（`skill` 装载 / `/sw-*` 置位）与 `registered`（注册幂等）；
   - `registry.register(defineSuperworkerTool(host), { when })`，条件 =
     `armed.has(agent) || hasPipelineRecord(workspaceOf(ctx, agent.id))`；
   - **条件里不能读 `registered`**——注册过的 agent 永远为真，门就形同虚设。
3. 撤掉 pre-step 里的 `wakeIfPipeline`（判断搬进 `when` 之后它没有第二处需要）。
   两条技能触发留着，它们从此只置 `armed`，不再直接注册。
4. 只要 `engines` 还放行 0.2.1，就保留今天的行为作回落：`canGate = typeof ctx.tools.resolve === 'function'`，
   有测到能力才传 `{ when }`；没有就照旧按上面的三条触发注册（今天这一套）。
5. 测试：假 registry 的 `register(definition, options)` 记住 `when`；两条「事实唤醒」用例改成直接断言这个条件的真假
   （把条件导成一个纯函数最省事）；补一条「条件为假时，这一步的请求里没有它」。
6. 行为差异（可接受，但要写进 commit body）：`when` 每步求值——cwd 移出 `.superworker/` 工作区时工具会消失（今天粘住），
   `.superworker/` 中途出现时下一步就有（今天要等下一次技能触发）。
7. 清理：删本文件与 `docs/AGENTS.md` 的那一行；把 README 里「第一步就能看到这个工具」按新机制核一遍。

## 两个不变量，迁移时别破坏

- **无关会话的请求头一个字节都不多。**今天靠「`.superworker/` 在场，或一份认得出的旧记录目录在场」这个
  事实——后一个「或」正是没迁的工作区还调得到 `migrate` 的原因——迁移后靠同一个事实，只是改由 `when` 说。
- **空仓库里的 `superworker init` 仍有门。**没有 `.superworker/`、也没有认得出的旧目录时工具不出现，靠一条 `/sw-*` 把 `armed` 置起来。迁移不改变这一点；
  想去掉这个动作，再单独补一个只给模型看的技能或 `/superworker init` 用户命令。

不迁也可以：今天的实现不读 `when`，0.2.1 与 0.2.2 上都能跑。但双轨留得越久越难解释，所以这条笔记存在的前提就是「会迁」。
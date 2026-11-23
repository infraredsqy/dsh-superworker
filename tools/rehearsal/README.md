# rehearsal — 总览面板排练线（最简形态母本）

在仓外场地上真实跑一条极小的流水线，让总览面板的每一类视觉状态都有东西可看：
开场起步 → 并行双格（一快一慢）→ checkpoint 人闸 → 收尾总单。本目录固化的是这条线的
**管线骨架**——图的种子、五份 spec 模板、复跑重置脚本与启动流程；**剧情**（演员小传、
小抄与总单的具体文案）是一次性的，复跑时随场地重置，不必也不应搬进仓库。

## 文件

- `graph.json` — `dag add --from-file` 的五节点种子：r1 场记 → r2 快工 ∥ r3 慢工 → r4 闸口（checkpoint）→ r5 收尾
- `specs/` — 五份节点 spec 母本（目标／落点／内容要求／完成判定，判定块为可整块执行的 pwsh）
- `reset.mjs` — 把场地重置回「图在、节点全 todo、零会话」：三重守卫 + 清场 + 两只 git 基提交

## 一、场地准备（仓外目录，绝不立在本仓库里）

```pwsh
mkdir C:\Users\inf_NAS\dsh-rehearsal
git -C C:\Users\inf_NAS\dsh-rehearsal init
```

- 场地必须 `git init`：各 spec 判定块的 `git status --porcelain` 才能字面通过（否则 exit 128，只能按意图核）。
- 场地是裸台子，无任何代码；`.superworker/` 由下一步的 `init` 生成。

## 二、立线立图（cwd=场地）

> **词面以现场为准**：先 `superworker doctor`，再用各词的现场 help 核对拼法；下面的命令只当示意，接口会微妙地变。

```pwsh
superworker init
superworker cycle create rehearsal --tags writing
superworker cycle start rehearsal --tags writing      # create/start 都强制 --tags
superworker cycle policy rehearsal parallel 2         # 并行旋钮现名 parallel
superworker dag add --from-file <仓库>\tools\rehearsal\graph.json   # 不带 --project，在场地 cwd 下执行
```

- 登记前抹掉 `DSH_SESSION_ID` 再执行 `dag add`：否则注册者会话会被记成节点出生条目，杀死 t0 空态。
- 立完自查：`plan` 应报 open_node 挑 r1、五节点 todo、仅 r1 ready。
- **spec 落盘**：立线后把 `specs/r1..r5` 对应模板抄进 `.superworker/nodes/<uuid>/spec.md`
  （或由指挥者 prepare 时按模板扩写）——判定块里的 `<本节点>` 占位在落盘时换成实战 uuid。

## 三、种子（让场地出现在面板工作区清单）

开一个 cwd=场地的会话，提示词只让它回一句「ok，待命」即停——种子会话不干活。
面板顶部工作区选择器的清单来自实例里会话的 cwd；没有种子会话就选不到场地。

## 四、发令（第二拍开跑，发给种子会话）

```text
开跑。你是这条「总览面板排练线」的指挥者，项目就在你当前目录（<场地>），
线名 rehearsal，并行度 2，五张节点都在图上（仅「排练场记：开场记录」此刻 ready）。

按你现场能装到的管线技能来跑这条线（技能名与用法以现场目录为准，不要凭记忆拼参数），
从第一个 ready 节点开始：hold、准备、派发、按节点 mode 收束（checkpoint 的「闸口：等一声批准」
会在人闸停下，等真人批准后再继续），一路把线走到终点。

约束：一切工作只发生在你当前目录以内；节点都是几分钟内能完成的小活，如实做、快速收；
线停下（人闸或终点）就汇报并停，不自行越闸。
```

- 子窗会话收到的启动 prompt 形如 `/sw-conduct <uuid> [pipeline]`（面板按钮同款端点代发）。
- 跨根注意：`hold`/`plan`/`settle` 支持 `--project` 外指场地；`dispatch`/`advance` 不行——
  词工具的 opener 永远用调用会话自己的根，跨根必 `prompt-missing`，续腿交给 relay。

## 五、驱动与观看

- **驱动原则：只按面板自己的按钮**（明细 tab 每格的「打开」），不从页面外直调 gateway——
  会话必须是宿主亲开的，relay 的 turn/end 续腿与 run note 才成立，面板上的线才动得可见可解释。
- 看总览 tab：r1 子窗与连接线 → r2+r3 并行双窗（慢工刻意分三笔、比快工慢）→
  r4 主窗琥珀呼吸停人闸 → 批准后 r5 收线（veil + 大勾）。
- r4 停下时由**真人**批准——这正是 checkpoint 的人闸语义；看到视觉问题随时打断、跑完统一修。

## 六、收线与复跑

- 收尾格把四格产物概括成 `finale.md` 总单，线到终点；确认面板各状态后清点交付。
- 复跑：先重置，再从第四节发令重新跑一遍——

```pwsh
node tools\rehearsal\reset.mjs --root C:\Users\inf_NAS\dsh-rehearsal
```

- `reset.mjs` 三重守卫（任一不过即 exit 2 拒跑）：`--root` 必须显式给出、根下有 `package.json`
  的目录按真实 checkout 拒跑；场地必须已有 `.superworker/ideas.json` + `nodes/`，且每个节点
  带 `spec.md`；节点清单从 ideas.json 动态枚举，零节点的场地拒跑。重置把工作树清到只剩
  `.superworker/`，ideas.json 全回 todo、state.json 清 path，重立两只 git 基提交。

## 已裁定事实（2026-11 备场实测，仍以现场为准）

- 面板读哪份记录跟着会话 cwd 走；同实例换工作区根安全（`projectRootOf` 不向上爬），仓根记录零风险。
- 空态分三句：无节点／节点在但没会话跑过／有会话但不运行；t0 应显示第二句 + 「接入这条管道」链接。
- 备选 B 路线：完全隔离的第二实例（`tools/testbed/`），单工作区确定性最高，代价是复制模型凭据进隔离 home。

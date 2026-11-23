# 收尾关节点、交接单与 `advance` 动作

> 何时读本文件：`[pipeline]` 派发会话进入收尾第 6 步时。手动触发（无 `[pipeline]`）无需读本文件。

## 一、关节点三步（收尾第 6 步）

`<cycle>` 从 `cycle current` 的 `Node:` 行按节点 id 识别；`<node>` 为调用行上的节点 id。

```pwsh
handoff --form <cycle>
handoff <cycle> <node> completed -s "<一行总结>" -o '<按 --form 形状填写的 JSON>'
settle <node> --json
```

- `handoff --form` 只印形状，不动状态；`handoff ... -o` 只写交接单，不关节点；`settle` 读取交接单判决，更新图状态为 `completed` / `shelved` 并运行收尾插件接缝（可能插入维护节点），但不钉新节点、不开会话、不停线。
- 想只读预演收尾去向，可跑 `plan --after <node> --json`。
- **异常结单**：需求做不到或 spec 自相矛盾时将 `completed` 换为 `failed`；主动中止换为 `stopped`，并在 `-s` 写清原因。`settle` 会自动将节点标为 `shelved`（出局等人），无需手动标。

### 交接单（`-o` JSON）与读数规则

- **字段形状以 `handoff --form <cycle>` 实时输出为准**。常见键为 `deliverable`、`acceptance`、`touched`，配了读数的线多出 `reading`。路径使用正斜杠（避免 PowerShell 单引号内转义问题）。
- 工具原样存储、不校验缺键，完整度由你自查。`acceptance` 写 1~3 条，说明「少了这个节点项目会缺什么」。
- **`reading` 填报**：仅在 `--form` 印出该槽时填报（例如套件耗时填第 4 步全量实测秒数）。**未测到的读数键必须整键删除——绝不填 0**（缺键代表未知，填 0 会误判债务已清）。由外部来源自动计算的读数不会出现在 `--form` 中，无需填报（插件与读数来源见 `doctor`）。

## 二、推进与 `advance` 动作（收尾第 9 步）

完成第 7 步提交与第 8 步 push 后，执行 `advance --cycle <cycle> --json`（若宿主开启自动接力，宿主会在会话结束时自动运行它）。按返回的 `action` 处理：

| `action` / 情形 | 处理方式 |
|---|---|
| `dispatch` | **交票即止**：交接单已落盘、节点已 `settle`，下一棒由宿主自动接力开出，本会话直接结束，不再跑派发命令。仅当接力关闭或下一棒未开出时，才由人补跑 `advance --cycle <cycle>` |
| 插入了维护节点 | `settle` 返回新插入的维护节点及 spec 路径（挂在下一待跑节点之前，不占当前持有，且**可能不止一个**）。照常提交推送后跑 `advance --cycle <cycle> --json`，它们会按正常排名被挑出派发。每个维护节点 spec 自带 `method:` 行，接手会话按该技能执行并严守 spec 范围 |
| `stop_pipeline` | 原样向用户转述 `reason`（若有 `attention` 一并念出）并停手。`advance` 已自动将线置为 `inactive`（线内仍有其他节点运行中时除外）。恢复命令：`cycle status <cycle> active` 后 `advance --cycle <cycle>` |
| `wait` | 按返回的 `note` / `close_with` 执行（收格命令即 `settle <node>`），**绝不轮询** |
| `spawn_error` | 当前进程无原生 opener，不认领节点，输出会提示面板与 prompt 路径；照实汇报并将 prompt 路径与调用行交给用户 |

- `attention` 出现 `node_shelved` 表示节点未交付已出局（下游暂停），重做需先 `dag revive <node_id>`。
- `handoff` 输出无需读取；`settle` 只读插入的维护节点与 `note`；`plan` / `advance` 只读 `action`、`note`、`close_with`、`reason`、`attention`。除此以外不跑多余命令、不手写状态文件。
- 宿主派发、防双派发（遇拒绝先查该节点是否已有会话在跑，不要硬闯）与演练（`DSH_CONDUCT_SPAWN_DRY_RUN=1`）细节见 [`conduct-dsh-dispatch.md`](conduct-dsh-dispatch.md)。

## 三、`checkpoint` 节点停手与续跑

`checkpoint` 节点在 `settle` 与 push 后，`advance` 会返回 `stop_pipeline` 并将线置为 `inactive`。向用户汇报本轮交付与记录路径，等待确认。用户回复「继续」后按顺序执行：

```pwsh
cycle status <cycle> active
advance --cycle <cycle> --json
```

本会话至此结束（即使中途换了新会话，记录已在盘上，命令不变）。

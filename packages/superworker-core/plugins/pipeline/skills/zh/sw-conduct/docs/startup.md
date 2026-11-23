# 手动开局与选线

> 何时读本文件：用户手动输入 `/sw-conduct`（无节点参数）、`/sw-conduct status` 或直接描述需求开跑，且**不是** `[pipeline]` 管线派发时。

先执行 `cycle list` 查看现有线，再按输入分流：

| 输入与当前状态 | 执行动作 |
|---|---|
| `/sw-conduct status` | 执行 `cycle list` + `cycle current`，只读汇报，不推进 |
| `/sw-conduct`，恰好 1 条 `active` 线 | 执行 `advance --json` 继续推进 |
| `/sw-conduct`，多条 `active` 线 | 裸 `advance` 会被拒并列出候选；把候选报给用户，按用户点名执行 `advance --cycle <cycle_id> --json` |
| `/sw-conduct`，仅有非 `active` 线 | 列出候选由用户点名（不要替用户选），确认后先 `cycle status <id> active` 再 `advance --cycle <id> --json`。注意：非活跃线无法直接 `advance`（会返回 `ask_user`），但手里握着的节点仍可 `settle`（只登记不派发）；要重做 `shelved` 节点先 `dag revive <node_id>` |
| `/sw-conduct`，尚无任何 cycle | 走下方「开机」 |
| 用户直接说要做的事，尚无 cycle | 走下方「开机」，`--title` 填用户原话 |

## 开机（无 cycle 时）

前提：图里必须已有就绪节点；空图直接刹车，提示用户先去 `/sw-route` 建图。

```pwsh
cycle start <slug> --title "<用户原话>" --tags coding,writing
advance --json
```

- 已有 `active` 线时 `cycle start` 会被拒，需 `--force` 放行（先确认确实需要双线并行）。
- `--tags` **必填**，即使只有一条线也必须传入；`--title` 只填用户原话，仅用作 cycle 名称，不进入任何 prompt。

## `advance` 之后的收手规则

`advance` 会按图排名钉住可用槽位（最多 `parallel` 个）、落地 prompt 与本轮 run 文档，并交给执行器开出会话：
- **有宿主 opener**：宿主当场开出新会话，本会话到此结束，**不要等待**。
- **无 opener**：返回 `spawn_error` 且不认领任何节点，点名面板；把 prompt 路径与调用行（带 `[pipeline]`）交给用户后收手。

收手前告知用户本轮会推进到哪里；全自动模式可说明：「已进入全自动，会持续推进到图里没有就绪节点，或达到本线的 `stop_after_nodes` 上限。」

> 推进边界由节点 `mode` 与 `stop_after_nodes` 共同决定：到达停点且手里无节点时，`advance` 会自动把线置为 `inactive`，后续需由人执行 `cycle status <cycle> active` 恢复（原理见 [`conduct-state.md`](conduct-state.md)）。

---
name: sw-instruct
description: 往项目指令清单里记一条约束，让以后干活的 agent 都照办（管线会话内用）
disable-model-invocation: true
---

# sw-instruct

> 谁跑我：用户，只在 sw-route / sw-conduct 的会话里——只有它们读这份清单
> 我解决什么：把用户的一句话原话记进项目指令清单
> 我派不派 subagent：不派

别处敲了就是敲错地方，回一句，别往清单里记。

管线这些词是一张表一个入口：走 `superworker` 工具——给它 `word`、该词的 `args`，`help` 取它那一页。

把调用行里那句话**原话照抄**进清单，`--scope` 必须点名，它决定谁能看见这条：

```pwsh
# global：往后每个读清单的会话都看见，一直生效
instruction add --text "<用户原话>" --scope global

# cycle：这个 cycle 里的会话看见，cycle 结束就没
instruction add --text "<用户原话>" --scope cycle --cycle <id>

# node：只管记它的那个节点，节点收尾就没
instruction add --text "<用户原话>" --scope node --node <id>
```

- 两条线并排时 `--cycle <id>` / `--node <id>` 要点名，绑不上工具会拒收
- 记完就生效，读它的那一趟会自己看见。
- 「跑多远、何时停」的话（跑够三个就停）不归清单管：那是线自己的策略键，用 `cycle policy <cycle> stop_after_nodes 3` 写进这条线。它只能在线上加一个停点，节点自己的 `mode` 照旧先说话（`checkpoint` 该停还是停）；`off` 取消这个停点。清单里的条目不再参与停机，记在这儿也不会让它停
- 记完把条目 id 和 scope 念给用户

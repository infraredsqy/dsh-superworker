---
name: sw-instruct
description: 向项目指令清单追加一条约束，供后续管线会话遵循（仅限管线会话内使用）。
disable-model-invocation: true
---

# sw-instruct

> 适用对象：用户，仅限 `sw-route` / `sw-conduct` 会话内（宿主每轮自动注入指令清单；关闭 `injectInstructions` 时不注入）。
> 职责：将用户的一句话**原话**记入项目指令清单。
> 是否派发 subagent：否。

若在非管线会话中调用，直接提示调用位置不对，不写入清单。

所有管线命令均通过 `superworker` 工具调用（传 `word` 与 `args`，加 `help` 查看该词用法）。

将调用行中的约束**原话照抄**写入清单，`--scope` 为必填项，决定该条指令的可见范围：

```pwsh
# global：后续所有读取清单的会话均可见，持续生效
instruction add --text "<用户原话>" --scope global

# cycle：仅当前 cycle 内的会话可见，cycle 结束后失效
instruction add --text "<用户原话>" --scope cycle --cycle <id>
```

- **仅两级作用域**：`global` 与 `cycle`。只针对单个节点的约束不入清单，写入该节点的 `spec.md`。
- **多 cycle 并行**：必须显式指定 `--cycle <id>`，无法绑定时工具会拒绝写入。
- **即时生效**：写入后立即生效，后续读取清单的轮次会自动看到。
- **停机条件不入清单**：类似「跑够 3 个节点就停」的运行边界属于线层策略，用 `config set stop_after_nodes 3 --cycle <cycle>` 设置（`config unset stop_after_nodes --cycle <cycle>` 取消）。该策略仅附加 cycle 级停点，节点自身的 `mode` 仍优先（`checkpoint` 照常停）；指令清单条目不控制停机。
- **回执**：写入完成后，向用户报出条目的 `id` 与 `scope`。

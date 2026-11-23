# Manual Startup and Cycle Selection

> When to read this: when invoked manually as `/sw-conduct` (no node argument), `/sw-conduct status`, or with a direct user request—not via `[pipeline]` dispatch.

Run `cycle list` first, then route by input and state:

| Input & State | Action |
|---|---|
| `/sw-conduct status` | Run `cycle list` + `cycle current`; report status only, do not advance |
| `/sw-conduct`, exactly 1 `active` cycle | Run `advance --json` to continue |
| `/sw-conduct`, multiple `active` cycles | Bare `advance` is refused with a candidate list; present candidates to the user and run `advance --cycle <cycle_id> --json` for their choice |
| `/sw-conduct`, cycles exist but none `active` | List candidates for the user to choose (never pick for them), then run `cycle status <id> active` followed by `advance --cycle <id> --json`. Note: an inactive cycle cannot be driven with `advance` (returns `ask_user`), though a node it holds can still be settled (records only, no dispatch); to redo a `shelved` node, run `dag revive <node_id>` first |
| `/sw-conduct`, no cycle yet | Follow "Start-up" below |
| User states a task directly, no cycle yet | Follow "Start-up" below with `--title` set to the user's exact words |

## Start-up (No Cycle Yet)

Prerequisite: the graph must have at least one ready node. If the graph is empty, stop and ask the user to design the graph via `/sw-route` first.

```pwsh
cycle start <slug> --title "<user's exact words>" --tags coding,writing
advance --json
```

- If an active cycle already exists, `cycle start` is refused unless `--force` is passed (confirm parallel cycles are intended first).
- `--tags` is **required** even when the graph has only one line. `--title` takes only the user's exact words (used as the cycle name, never injected into prompts).

## Stopping After `advance`

`advance` pins top-ranked ready nodes up to `parallel`, writes their prompts and run docs, and hands them to the executor:
- **Host opener present**: the host opens new sessions immediately; end this session here—**do not wait**.
- **No opener**: returns `spawn_error` without claiming any node and points to the panel; hand the user the prompt paths and `[pipeline]` call lines, then stop.

Before stopping, tell the user how far the cycle will run (for full auto: "Full auto is active; this cycle will keep running until no ready nodes remain or `stop_after_nodes` is reached.").

> Stop boundaries are governed by node `mode` and `stop_after_nodes`. When a stop point is reached with no nodes held, `advance` marks the cycle `inactive`; a human must run `cycle status <cycle> active` to resume (see [`conduct-state.md`](conduct-state.md)).

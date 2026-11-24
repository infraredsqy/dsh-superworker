# Manual Startup and Cycle Selection

> When to read this: when invoked manually as `/sw-conduct` (no node argument), `/sw-conduct status`, or with a direct user request—not via `[pipeline]` dispatch.

Run `cycle list` first, then route by input and state:

| Input & State | Action |
|---|---|
| `/sw-conduct status` | Run `cycle list` + `cycle current`; report status only, do not advance |
| `/sw-conduct`, exactly 1 `running` cycle | Run `advance --json` to continue |
| `/sw-conduct`, multiple `running` cycles | Bare `advance` is refused with a candidate list; present candidates to the user and run `advance --cycle <cycle_id> --json` for their choice |
| `/sw-conduct`, cycles exist but none `running` | List candidates for the user to choose (never pick for them), then run `advance --cycle <id> --json` directly (if stopped at a checkpoint, run `dag approve <node_id>` first; to redo a `shelved` node, run `dag revive <node_id>` first) |
| `/sw-conduct`, no cycle yet | Follow "Start-up" below |
| User states a task directly, no cycle yet | Follow "Start-up" below with `--title` set to the user's exact words |

## Start-up (No Cycle Yet)

Prerequisite: the graph must have at least one ready node. If the graph is empty, stop and ask the user to design the graph via `/sw-route` first.

```pwsh
cycle start <slug> --title "<user's exact words>" --tags coding,writing
advance --json
```

- Multiple cycles can be created concurrently without any status lock; bare `advance` requires `--cycle <id>` when more than one cycle is running.
- `--tags` is **required** even when the graph has only one line. `--title` takes only the user's exact words (used as the cycle name, never injected into prompts).

## Stopping After `advance`

`advance` pins top-ranked ready nodes up to `parallel`, writes their prompts and run docs, and hands them to the executor:
- **Host opener present**: the host opens new sessions immediately; end this session here—**do not wait**.
- **No opener**: returns `spawn_error` without claiming any node and points to the panel; hand the user the prompt paths and `[pipeline]` call lines, then stop.

Before stopping, tell the user how far the cycle will run (for full auto: "Full auto is active; this cycle will keep running until no ready nodes remain or `stop_after_nodes` is reached.").

> Stop boundaries are derived live from node `mode` (e.g., `checkpoint`), `when_shelved`, and `stop_after_nodes`. When a stop gate applies, `advance` returns `stop_pipeline` without pinning new nodes; clear the gate and run `advance --cycle <cycle>` to resume (see [`conduct-state.md`](conduct-state.md)).

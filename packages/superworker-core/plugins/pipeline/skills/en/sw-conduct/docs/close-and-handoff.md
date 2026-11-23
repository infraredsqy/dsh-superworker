# Node Close, Handoff Readings, and `advance` Actions

> When to read this: when a `[pipeline]` session reaches Close Step 6. Manual invocations (without `[pipeline]`) skip this file.

## 1. Closing the Node (Close Step 6)

Identify `<cycle>` by matching the node ID in `cycle current`'s `Node:` lines; `<node>` is the ID on the call line.

```pwsh
handoff --form <cycle>
handoff <cycle> <node> completed -s "<one-line summary>" -o '<JSON matching --form>'
settle <node> --json
```

- `handoff --form` only prints the schema; `handoff ... -o` only writes the handoff slip; `settle` reads the slip, marks the node `completed` / `shelved`, and runs the close-time plugin seam (which may insert maintenance nodes)—it does not pin new nodes, open sessions, or park the cycle.
- For a read-only preview of where the cycle would go next, run `plan --after <node> --json`.
- **Non-completed outcomes**: if requirements are impossible or `spec.md` is self-contradictory, use `failed`; if you chose to stop, use `stopped`, explaining why in `-s`. `settle` automatically marks the node `shelved` (no manual status edit needed).

### Handoff JSON (`-o`) and Readings

- **Follow the exact shape printed by `handoff --form <cycle>`**. Standard keys are `deliverable`, `acceptance`, `touched`, plus `reading` when configured. Use forward slashes in paths (avoids backslash escaping inside PowerShell single quotes).
- The tool stores the JSON as-is without validating missing keys—verify completeness yourself. Write 1–3 `acceptance` items at the level of "what would be missing if this node had not run."
- **`reading` fields**: report only slots printed by `--form` (e.g., measured full-suite seconds from Close Step 4). **Delete any unmeasured reading key entirely—never fill `0`** (missing = unknown; `0` falsely reports debt as cleared). Readings computed from external sources never appear on `--form` (check `doctor` for plugins and reading sources).

## 2. Advancing the Pipeline (Close Step 9)

After Close Step 7 (commit) and Step 8 (push) succeed, run `advance --cycle <cycle> --json` (when host auto-relay is enabled, the host runs this automatically at turn end). Handle the returned `action`:

| `action` / Case | Handling |
|---|---|
| `dispatch` | **Hand off and stop**: the slip is written and settled, and the host opens the next session automatically. End this session without running extra dispatch commands. Only if auto-relay is off or the next session never opens should someone run `advance --cycle <cycle>` manually |
| Maintenance nodes inserted | `settle` lists newly inserted maintenance nodes and their spec paths (placed ahead of the next queued node, without changing current holdings; **may insert more than one**). Commit and push as usual, then run `advance --cycle <cycle> --json` so normal ranking dispatches them. Each carries a `method:` line—the next session runs that skill strictly within the inserted spec's scope |
| `stop_pipeline` | Report `reason` verbatim to the user (plus `attention` if non-empty) and stop. `advance` has already set the cycle `inactive` (unless other nodes are still in flight). To resume: `cycle status <cycle> active`, then `advance --cycle <cycle>` |
| `wait` | Follow `note` / `close_with` (closing command is `settle <node>`); **never poll** |
| `spawn_error` | This process has no native opener; nothing was claimed. Report honestly and hand the user the panel notice, prompt paths, and call lines |

- `node_shelved` in `attention` means the node did not deliver and its downstream is paused; to redo it, run `dag revive <node_id>`.
- No need to inspect `handoff` output; from `settle` read only inserted nodes and `note`; from `plan` / `advance` read `action`, `note`, `close_with`, `reason`, `attention`. Never run extraneous commands or hand-edit state files.
- Host dispatch, double-dispatch guards (on refusal, check whether a session is already running for that node—never force), and dry-run (`DSH_CONDUCT_SPAWN_DRY_RUN=1`) details: [`conduct-dsh-dispatch.md`](conduct-dsh-dispatch.md).

## 3. `checkpoint` Pause and Resume

After `settle` and push on a `checkpoint` node, `advance` returns `stop_pipeline` and marks the cycle `inactive`. Report the deliverables and record paths to the user and wait. When the user replies "continue", run in order:

```pwsh
cycle status <cycle> active
advance --cycle <cycle> --json
```

Then end this session (records persist on disk even across sessions).

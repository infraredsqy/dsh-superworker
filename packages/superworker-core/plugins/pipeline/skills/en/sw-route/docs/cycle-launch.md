# Landing a Cycle, Verification, and Launch

> When to read this: during Step 5 close-out when the user wants to **run immediately** (default unless they say "not yet"). Skip if only building/editing/querying the graph.

Landing and launching are two distinct steps: **landing writes records without opening sessions; launching opens the `/sw-conduct` sessions**. Any decision to reuse an existing cycle or create a new one must already be approved by the user in Step 3—here you only execute it.

## 1. Land the Cycle

- **Reuse an existing cycle**: no reactivation command is needed—keep the cycle id and advance or hold directly in Step 4 (`advance --cycle <line>` or `hold <node> --cycle <line>` + `dispatch <line>`; if stopped on a checkpoint or shelved node, run `dag approve <node>` or `dag revive <node>` first).
- **Open a new cycle (standard, auto-picking by rank)**:
  ```pwsh
  cycle start <slug> --title "<user's exact words>" --tags <tags>
  ```
  Creates the cycle and pins the top-ranked ready node(s) (`--parallel` defaults to 1).
- **Open a new cycle (user explicitly named one node to start)**:
  ```pwsh
  cycle create <slug> --title "<user's exact words>" --tags <tags>
  ```
  Creates the cycle without pinning any node, leaving Step 4's `hold` to pin the named node.

`--tags` is required and must match the new nodes' tags. The `Node:` lines in `cycle current` and `STARTED:` from `cycle start` record which nodes the cycle holds; sessions do not open until Step 4.

## 2. Commit Records

Complete the commits from Step 5 of `SKILL.md` (graph/specs/cycle records, plus any "do it now" outputs) before launching.

## 3. Verify Readiness

Run:
```pwsh
plan --cycle <line> --json
```
(Omit `--cycle` when only one cycle is currently running.)

- The output must point to a dispatchable node.
- If no node is ready, go back and fix the graph; if blocked by tags or a gate, report the `reason` verbatim—**never hand over a command that cannot run**.
- If the user named a specific node, also check `dag info <node_id>`: it must be `todo` with every dependency `completed`. Otherwise report its current state and wait until it is ready.

## 4. Launch

- **No specific node named (default)**:
  ```pwsh
  advance --json
  ```
  Pins nodes for open slots, writes their prompts (`/sw-conduct <node_id> [pipeline]`), and hands them to the executor to open sessions.
- **User named a specific node** ("start this node", "run it now"):
  ```pwsh
  hold <node_id> --cycle <line>
  dispatch <line>
  ```
  Pins and dispatches that exact node without ranking selection.
- **Cycle already holds another node** (`Node:` in `cycle current` is non-empty): **do not `hold` a second node** (`dispatch` launches every held node together). Present this to the user and let them choose which runs first.
- **`spawn_error` in output**: this process has no native opener, so no session opened and the node remains waiting. Fall back to Step 5 and report it as waiting.

## 5. Hand Over Keys (Only When Step 4 Opened No Session)

End your report with a single copy-pasteable command:
- For a specific node: `/sw-conduct <node_id> [pipeline]`
- When the running cycle auto-picks next nodes: `/sw-conduct`

**Never omit `[pipeline]`**—without it, the session runs only that single node and stops without close-out, commit/push, or advancing to the next node. If the cycle is waiting on a checkpoint or no ready node exists, do not give a launch command; state the current status instead.

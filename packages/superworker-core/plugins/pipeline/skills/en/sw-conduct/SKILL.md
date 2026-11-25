---
name: sw-conduct
description: Conduct a single DAG node from prepare to close: dispatch Execute, run independent Review, Fix as needed, then close the node and decide whether to dispatch or stop.
disable-model-invocation: true
---

# sw-conduct

> Triggered by: the user (`/sw-conduct <node id or keyword>`) or pipeline dispatch (call line carries `[pipeline]`)
> Purpose: drive one DAG node from prepare to close (prepare → execute → review → fix → close), then dispatch the next node or stop
> Subagents: yes, one layer (Execute / Review / Fix / Doc-sync); an executor reading this file stops and reports

You are the **conductor** for this node: code edits and verification are handled by subagents (except on `light` nodes), while you own coordination, records, and decisions. A cycle may hold multiple nodes concurrently under its `parallel` policy; each node runs in its own session with its own close-out.

### Four Hard Boundaries

1. **Do not create nodes or modify the graph**: if a node needs splitting or graph edits, stop and return to `sw-route`.
2. **Never edit `intention.md`; never alter `spec.md` scope**: `intention.md` is strictly read-only (user-only). `spec.md` is the execution contract—never change its goals or scope; only refresh stale snapshot numbers/lists when the codebase has evolved (for legacy nodes without `intention.md`, treat `spec.md` as strictly read-only `intention.md`). If requirements themselves fail to hold up, stop and escalate to the user.
3. **Do not read or edit project code directly**: dispatch a subagent with paths and questions when you need code context. **Exception: `light` nodes** (see "Weight").
4. **One layer of subagents only**: Execute / Review / Fix subagents must never dispatch further subagents. Pipeline continuation happens via new sessions opened by the host—when the plan returns `dispatch`, hand off and stop.

## Settings Overview

The `.superworker/` ledger mode is determined at Prepare step 0; read all other settings at Prepare step 2 and record them under "Facts checked" in `run.md`.

| Setting | Values | Source | Affects |
|---|---|---|---|
| `.superworker/` mode | commit / local | `git ls-files .superworker` | Sync, merge-back, and close commits (see [`docs/git-and-worktree.md`](docs/git-and-worktree.md)) |
| Mode (`mode`) | `manual` / `checkpoint` / `auto` | `dag info` | Stopping points and whether user questions are allowed |
| Weight (`weight`) | `light` / omitted (`standard`) | `dag info` | Who performs Execute and Fix |
| Method (`method`) | `method: <skill name>` in `spec.md` | Read `spec.md` | Runs the node via a named skill; overrides `weight` |
| Test tier (`test_tier`) | `full` / `minimal` (default `full`) | `config get test_tier` | Test authoring and per-round/close verification |
| Worktree mode | `off` / `fork` (default) / `reuse` | `config get worktree_mode` | Prepare fork and close merge-back (see [`docs/git-and-worktree.md`](docs/git-and-worktree.md)) |
| Subagent cap | Positive integer | `config get max_agents` | Concurrent subagent limit (see [`shared/superworker/subagents.md`](shared/superworker/subagents.md)) |
| Parallelism (`parallel`) | Positive integer | `Policy:` line of `cycle current` | Max nodes held concurrently by this cycle |
| Node tags | `writing` / `coding` / `art`, etc. | On graph (read-only) | Cycle selection filter (see [`docs/conduct-node-tags.md`](docs/conduct-node-tags.md)) |

### Mode (`mode`)

| `mode` | Loop | Behavior |
|---|---|---|
| `manual` | **Skips** execute→review→fix | Conducted interactively with the user; once the user says "mark complete, continue", close with `completed` and proceed |
| `checkpoint` | Runs | Completes the loop and close-out, then stops for user's "continue" (see [`docs/close-and-handoff.md`](docs/close-and-handoff.md)) |
| `auto` | Runs | Relays automatically; stop after settling and let the host open the next session. Escalate only on stuck loops or conflicting requirements |

- **`checkpoint` and `auto` nodes must never call `ask_user_question`**: when uncertain, pick the option closest to intent and log the choice and rationale under "Autonomous decisions" in `run.md`. `manual` nodes have no such restriction.
- See [`docs/conduct-state.md`](docs/conduct-state.md) for confirmation points, `stop_after_nodes`, and derived stop gates.

### Weight (`weight`)

- **`standard` (default)**: dispatch Execute/Fix subagents for implementation and fixes.
- **`light`**: **you directly** read code, edit code, run the fast lane, write `report.md`, and handle fix rounds (`fix-{N}.md`). Everything else—independent Review, per-round fast lane, close-out full run, and full report set—remains unchanged.
  - On `light` nodes, Review owns critical rulings: on dispute, re-run Review once; if still unresolved, escalate to the user.
  - If Prepare reveals the task is too large for `light` (many files, interface design), promote to `standard` (dispatch Execute) and log under "Autonomous decisions." **Never downgrade `standard` to `light`.** `light` has no extra effect on `manual` nodes.

### Method (`method`)

When `spec.md` contains `method: <skill name>`, read `~/.dsh/skills/<skill name>/SKILL.md` (if `DSH_HOME` is set, use `$DSH_HOME/skills/<skill name>/SKILL.md`; expand to an absolute path before passing to any subagent).

- **Precedence: `method` overrides `weight`.** Maintenance/debt-clearing nodes carry no `weight` and do not follow the `standard` → Execute path.
- **Self-declared layer**: if the method skill states it dispatches subagents, **you run it directly** rather than delegating it to Execute; if it does not dispatch, follow `weight`. Subagents dispatched by a method skill still may not dispatch further.
- Resolving a skill name to a path applies **only** to `method:`. Workspace paths come from tools; role cards come from `<this skill dir>/...`.

### Test Tier and Verification

Read `config get test_tier` at Prepare step 2 and pass it in dispatch supplements to Execute / Review / Fix (follow it yourself on `light` nodes). This is a project-level setting and does not belong in `spec.md`.

| Aspect | `full` | `minimal` |
|---|---|---|
| Writing tests | Add tests for new logic, **locking invariants only** (never formulas, snapshots, or implementation details) | **None by default**; add only to block silent failures, stating which silent failure it guards |
| What stays | Full suite; excess duration triggers maintenance nodes | Numeric/precision cross-checks, cross-source structural consistency, rare paths |
| Per-round check | Fast lane (tests covering touched files) | Project-defined checks / probes / smoke run |
| Review on missing tests | Missing required test → finding | Missing ordinary test ignored; missing silent-failure guard → finding |

- **Two lanes**: fast lane every round, full run at close (defined by project docs; never build a test suite for `minimal`). If the fast lane becomes unbearably slow, address it via the test-hygiene plugin (`doctor` lists the plugin and method) rather than skipping or over-running the full suite. Reports must include exact commands and counts, and `full` tier must include **actual measured wall-clock seconds**—without evidence, treat as unrun.
- If neither `spec.md` nor project docs specify verification commands, stop and ask the user to add them via `sw-route`.
- If the project is `minimal` while the cycle configures a reading requiring full-suite timing, report the conflict with the disable command: `config unset <knob_name> --cycle <cycle>` (get `<knob_name>` from `doctor`'s plugin list; slot names are rejected).

### Three-Layer Concurrency Cap

1. **Graph dependency edges**: determine which nodes **can** run in parallel.
2. **Cycle `parallel`**: limits how many nodes the cycle **holds** concurrently.
3. **`config get max_agents`**: outermost hard cap on **in-flight** subagents in this session (check [`shared/superworker/subagents.md`](shared/superworker/subagents.md) before every dispatch).

## Entry Routing

All pipeline commands go through the `superworker` tool (`word`, `args`, `help: true`). Independent calls can be batched in a single message.

| Entry | Next Step |
|---|---|
| **Pipeline dispatch** (call line has `[pipeline]` and `<node id>`) | Go straight to **Prepare**; run the full pipeline close chain |
| **User-specified node** (`/sw-conduct <node id or keyword>`, no `[pipeline]`) | If given a keyword, locate with `dag search` (ask user if multiple match); go to **Prepare**; at close, commit/push and report to user, **skipping `handoff`/`settle`/`advance`** |
| **No args / `status` / manual start** (`/sw-conduct` or `/sw-conduct status`) | Read [`docs/startup.md`](docs/startup.md) to inspect status, pick a cycle, or start a new one |

## Prepare

Confirm the workspace is at the project root (parent of `.superworker/`). If `.superworker/` is uninitialized (missing `.gitignore` and `.gitattributes`), run `init` once first.

### 0. Sync

Check `git ls-files .superworker` to determine **commit mode** (output present) vs **local mode** (no output):
- Commit mode with a remote: run `git pull --rebase` from the project root.
- Local mode, no remote, or any rebase / merge-driver conflict: **read [`docs/git-and-worktree.md`](docs/git-and-worktree.md)**.

### 1. Instructions and Policies

Active global and cycle instructions are injected into context; verify with `instruction list --project <abs project root>` if needed.
- Instructions are added only via `/sw-instruct` and archived/restored only by the user; `scope: global` instructions remain active and need no sign-off.
- Cycle policies (`when_shelved`, `parallel`, `stop_after_nodes`, `model`, maintenance thresholds) appear on the `Policy:` line of `cycle current` and are set via `config set <key> <value> --cycle <cycle>` (`config unset <key> --cycle <cycle>` clears numeric policies).

### 2. Read Everything Up Front

1. `dag --help` to confirm commands.
2. `dag info <id> --verbose` for details/direct dependencies; `dag context <id>` for full up/downstream.
3. `dag open <id>` for `spec.md` path and read it; if missing, stop and ask the user to write it via `sw-route`.
4. Read sibling `intention.md` if present (strictly read-only); if absent, treat `spec.md` as read-only `intention.md`.
5. If `spec.md` contains `method: <skill name>`, read that skill's `SKILL.md` and follow "Method."
6. Read reference files cited in `spec.md`, plus project `CLAUDE.md` and relevant `docs/`.
7. Read `config get test_tier`, `config get worktree_mode`, `config get max_agents`, and `cycle current`; record them in `run.md` under "Facts checked."

### 3. Validate the Spec (Gate Before Work)

- **Open items**: resolve genuine "or" / "TBD" ambiguities (in scope / out of scope / another node) and log under "Autonomous decisions" without editing `spec.md` (`manual` nodes ask the user immediately). Ignore normal enumerations or literal feature names.
- **Source hard constraints**: tag every "must" / "must not" / cap with its source—user's words, project goal docs (`*goals*`), or derived earlier (budgets, quotas, caps). Only the first two represent true requirement boundaries.
- **Check snapshot freshness**: if module counts, file lists, or enumerations in `spec.md` are stale due to codebase evolution, update the current values directly in `spec.md` and log one line in "Autonomous decisions" (**never touch `intention.md`**; write no history notes). If unsure whether the intent is still covered, stop and present `intention.md` alongside the new state to the user.
- **Verify executable acceptance**: if there is no executable completion check (or only vague goals like "design/tune it"), stop and ask the user to complete it via `sw-route`.
- **Verify intent, references, and criterion alignment**: read `spec.md` alongside `intention.md`—if the intent clearly depends on a read-only reference artifact or an upstream shared contract that `spec.md` omits, or if the done criteria are purely mechanical proxies that miss the core intent, **do not guess through it via "autonomous decisions."** When the unique reference can be confirmed from the repo or an upstream node, pass it in the dispatch supplement and record it in `run.md`; if ambiguous or materially misaligned, stop and ask the user to complete it via `sw-route`.

Unrelated pre-existing issues encountered during work: dispatch one subagent to record them according to the installed plugin's skill (`doctor` lists plugins); do not expand this node's scope.

### 4. Size Check and Worktree

- Stop and ask the user to split via `sw-route` only when a single Execute clearly cannot fit the bulk of the work without overflowing the session (same if discovered mid-run); do not over-split a cohesive deliverable unit merely because it touches many files.
- If `worktree_mode` is `fork` or `reuse`: **read [`docs/git-and-worktree.md`](docs/git-and-worktree.md) for pre-flight checks and worktree creation** (`off` works directly in the main tree).
- **Never mark the DAG node complete manually**—completion is recorded by the close command.

## Execution Loop

After dispatching subagents, **do not poll**—the runtime wakes you when they finish. Batch independent dispatches in one message, checking [`shared/superworker/subagents.md`](shared/superworker/subagents.md) before every dispatch.

### Execute

- **`standard` nodes**: dispatch an Execute subagent (read/write + commands) with three prompt items:
  1. Read `<this skill dir>/subagent-prompts/execute.md` and follow it
  2. Node docs: `<abs path to intention.md>` (omit if absent) and `<abs path to spec.md>`
  3. Supplement: `run.md` "Facts checked" (test tier, worktree path, subagent cap, project conventions), read-only reference paths (if any), node-specific cautions, and required docs
- **`light` nodes**: read code, edit code, run fast lane, and write `report.md` yourself.
- **Parallel file groups**: when applying uniform edits across multiple file groups, you may dispatch parallel subagents (within `max_agents`) that **only edit files** (no compile, test, or commit). Once all finish, run a single serial integration subagent to build, fix compile errors, run tests, and report.
- Verify all four required sections are present in `report.md`; request completion if vague.

### Review

- Dispatch **one read-only subagent** with three items: `<this skill dir>/subagent-prompts/review.md` / node `<abs path to intention.md>` (omit if absent) and `<abs path to spec.md>` / supplement (criteria, read-only reference paths, cautions, and output filename `review-{N}.md`).
- **Two severities**:
  - `critical`: blocks delivery (unmet goal, bug, spec violation)—must reach zero.
  - `minor`: polish/edge/wording not worth another review round—fix and close without re-review.
- **Disputes**: **never dismiss a `critical` as a false positive yourself**; re-run Review once with a fresh verification prompt framing the dispute, and escalate to the user if still unresolved.
- **Neutrality (no leakage)**: never include prior findings, what Fix changed, or your evaluation in the Review prompt (reuse the Round 1 supplement verbatim). Only update the supplement if a general project boundary itself changed—never add rules targeting a specific prior finding.

### Fix

No round cap:

- **`critical > 0`**: dispatch a **new** Fix subagent (`<this skill dir>/subagent-prompts/fix.md`), then return to Review. Give only three items:
  1. Path to `review-{N}.md` (never copy findings text into the prompt)
  2. Decisions already settled by you (one sentence each—only what is not in the review file)
  3. Output report path (`fix-{N}.md`)
- **`critical = 0, minor > 0`**: dispatch Fix **without returning to Review**; Fix verifies via fast lane and checklist. Unfixable items go into the report and `run.md`'s "Known unresolved" (closed within this node, never carried to the next).
  - **May run in parallel with Close Step 1 (Doc-sync)**: Fix edits code only; route `docs/` findings to Doc-sync. If Fix changes public names or interfaces, finish Fix before dispatching Doc-sync.
- **`light` nodes**: fix directly following `subagent-prompts/fix.md` discipline and write `fix-{N}.md`.
- **Stuck-loop detection**: if the same issue resists repeated fixes, or two consecutive reviews flag the same locations, pause and check `spec.md` against project goal docs:
  - If the conflict comes from a constraint you derived yourself (budget, quota, cap): modify or drop it, log under "Autonomous decisions," and proceed.
  - If still unresolved against spec and goal docs: stop, mark "Known unresolved" with evidence and attempts, and escalate to the user.

### Report Conventions

Store reports directly in `.superworker/nodes/<node uuid>/` (no stage subdirectories): `report.md` (Round 1), `review-{N}.md`, matching `fix-{N}.md`, and `run.md`. Put raw logs, long quotes, and probes in `temp/` under the same node directory and link by path.

- `report.md` / `fix-{N}.md` are concise receipts (~dozens of lines): what changed, where, verification readings; one `report.md` per node.
- `review-{N}.md` carries actionable judgments: be as detailed as needed for Fix to act immediately.
- Omit what the reader already has; overwrite or delete stale readings rather than appending pointers.
- User-facing updates (close, stop, checkpoint) follow [`shared/superworker/talking.md`](shared/superworker/talking.md).

## Close Out

Execute these 9 steps in order (only Steps 1 and 2 run in parallel):

| Step | Action |
|---|---|
| 1. Doc-sync | Dispatch Doc-sync (`subagent-prompts/doc-sync.md`), documenting only implemented ground truth, **in the working tree** (worktree for `fork`, main tree for `off`) |
| 2. Write `run.md` | While Doc-sync runs, write `.superworker/nodes/<uuid>/run.md` (four sections: What I did, Autonomous decisions, Known unresolved, Facts checked + change list and report paths; append synced docs once Doc-sync returns). Commit mode → working tree; local mode → main tree |
| 3. Merge back | For `worktree_mode=fork`, commit and squash-merge back to main tree per [`docs/git-and-worktree.md`](docs/git-and-worktree.md) (`off` mode commits `feat:` directly) |
| 4. Full run | Run full verification on the main tree (`full` tier including slow lane + **record measured seconds**; `minimal` tier runs project checks); fix failures here. Re-run if another cycle merged commits after your merge-back. In `fork` mode, remove the worktree and branch once passing (see [`docs/git-and-worktree.md`](docs/git-and-worktree.md)) |
| 5. Self-check | Verify all active instructions were followed; confirm deliverables, reports, and `temp/` are in place (`temp/` is never versioned) |
| 6. Close node | Pipeline (`[pipeline]`) only: `handoff --form` → `handoff` → `settle` (see [`docs/close-and-handoff.md`](docs/close-and-handoff.md)) |
| 7. Commit records | Commit close-generated graph, cycle, and handoff records (commit vs local commands in [`docs/git-and-worktree.md`](docs/git-and-worktree.md)) |
| 8. Push | Push all pending commits (on rejection, `git pull --rebase` and retry; escalate conflicts); **all pushes must succeed before Step 9** |
| 9. Advance | Run `advance --cycle <cycle> --json` and follow its `action` (see [`docs/close-and-handoff.md`](docs/close-and-handoff.md)) |

- **Before Step 6, read [`docs/close-and-handoff.md`](docs/close-and-handoff.md)** for `handoff -o` readings, `checkpoint`, maintenance nodes, `failed`/`stopped`, and `advance` handling.
- **Manual invocation (no `[pipeline]`)**: skip Steps 6 and 9; commit/push and report deliverable locations to the user.

## References & Anti-patterns

All relative paths below are rooted at this skill's directory (`cd ~/.dsh/skills/sw-conduct/ && pwd` for absolute paths, or `$DSH_HOME/skills/sw-conduct/` if `DSH_HOME` is set; always pass absolute paths to subagents):

- State machine contract & invariants: [`docs/conduct-state.md`](docs/conduct-state.md)
- Manual startup & cycle selection: [`docs/startup.md`](docs/startup.md)
- Git sync, ledger commits & worktree runbook: [`docs/git-and-worktree.md`](docs/git-and-worktree.md)
- Node close, handoff readings & `advance` actions: [`docs/close-and-handoff.md`](docs/close-and-handoff.md)
- Node tag filter semantics: [`docs/conduct-node-tags.md`](docs/conduct-node-tags.md)
- Host dispatch & relay internals: [`docs/conduct-dsh-dispatch.md`](docs/conduct-dsh-dispatch.md)
- Role cards: `subagent-prompts/` (`execute.md` / `review.md` / `fix.md` / `doc-sync.md`)
- Installed plugins & policy knobs: run `doctor`
- **Anti-patterns**: read [`./anti-patterns.md`](./anti-patterns.md) before starting.

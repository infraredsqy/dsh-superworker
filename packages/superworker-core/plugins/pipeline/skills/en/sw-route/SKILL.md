---
name: sw-route
description: Maintain the dependency graph manually: align on requirements, split into nodes, edit nodes and edges, and query graph state.
disable-model-invocation: true
---

# sw-route

> Triggered by: the user (`/sw-route`)
> Purpose: converge requirements into DAG nodes, maintain the dependency graph, and query graph state
> Subagents: yes, one layer (reading code, running probes, checking docs, non-behavioral small edits); an executor reading this file stops and reports

## Role

You act as a **product manager / designer**: align on what is actually needed, keep the dependency graph accurate, and leave implementation details to downstream (`sw-conduct`).

- **Requirement routing**: step back to align on the real goal, analyze value, scope, and dependencies, then write confirmed nodes into the graph
- **Graph maintenance**: add/remove nodes, update titles/mode/weight/tags, connect/disconnect edges, adjust statuses
- **Graph queries**: inspect graph structure, ready nodes, and individual node states

## Node Quality Standards

Every node is consumed downstream by `sw-conduct` (prepare → execute → review → fix → close). Each node must satisfy five criteria (**read [`docs/node-spec.md`](docs/node-spec.md) before drafting node files or `method:` debt-clearing nodes**):

1. **Clear intent and landing point**: state what is in scope, what is out of scope, and where the change lands using the project's own vocabulary, along with any **read-only reference baseline** (mock, design file, sample, specification, or upstream shared contract). **Folders and file names are allowed** (distinguishing change targets from read-only references to prevent guesswork), while **function names, call order, and implementation steps are forbidden**.
2. **Two-file split**: each node has `intention.md` (goals and "why", **strictly read-only, user-only**) and `spec.md` (landing point, boundaries, and completion criteria; downstream never alters scope/goals, only refreshes stale snapshot numbers/lists when the codebase evolves). For legacy nodes without `intention.md`, treat `spec.md` as read-only `intention.md`.
3. **Unique scope**: every landing point named in `spec.md` must have exactly one referent in the project. Resolve ambiguity before writing the node.
4. **Sized to a cohesive deliverable unit**: use "can be verified as a whole" as the lower bound and "one Execute pass completes the bulk of the work, leaving minor edges for Review–Fix" as the upper bound—prefer a slightly fuller cohesive unit (e.g., a full-page redesign or complete end-to-end flow) over slicing one whole into fragments just to stay small. Split only when a single Execute truly cannot hold it, and ensure each piece still has an independent verification boundary. Work too small for an executor (one file, a few dozen lines, 1–2 verification commands) is marked `light`. Debt-clearing nodes carrying `method:` are sized to one debt-clearing round and manage their own batching.
5. **Verifiable and matched to how it is judged**: `spec.md` completion criteria must match real acceptance—commands, scripts, or probes yielding pass/fail for behavior and invariants; **when a read-only reference exists (mock, design, sample, spec), require side-by-side comparison of the real output against the reference under matching conditions**, listing intentional exclusions (such as dummy data) and forbidding mechanical proxy checks (font size, no overflow, element presence) in place of visual/structural fidelity (`minimal` tier uses the project's defined checks). Unverifiable phrases like "design it" or "tune it" will be rejected downstream.

Write in a crisp, professional specification register rather than prose. Choose how to split based on the shape of the work; the only hard constraints are an independent verification boundary per node (never slicing a single cohesive artifact so that nobody owns the whole) and a read-only `intention.md`.

## Flow

### Step 1: Read Context

1. Read `shared/superworker/philosophy.md`; communicate with the user following `shared/superworker/talking.md` (one question at a time, all four elements, terminology matched to `config get answer`).
2. Read the project's `docs/` and relevant specifications.
3. **When creating or modifying the graph** (skip for pure queries), check `config get test_tier` (`full` / `minimal`, default `full`). If unset on this project and this run needs `minimal`, ask once with a recommendation (demo/prototype → `minimal`; long-term product → `full`), then write the user's decision with `config set test_tier minimal` into `.superworker/config.json`. See "Test Tier and Verification" in [`../sw-conduct/SKILL.md`](../sw-conduct/SKILL.md). **Never write settings into root `AGENTS.md` or `CLAUDE.md`**; `worktree_mode` works the same way via `config set worktree_mode`.
4. Read the DAG and cycles: run `dag --help` to confirm commands, then `dag list` for the skeleton (or `dag search` with a merged regex like `a|b|c` for a specific feature). For matching nodes, inspect `dag info` and direct dependencies, and read `spec.md` by path if needed. Run `cycle list` and `cycle current` to see running/waiting cycles and their `tags` coverage.

Active global/cycle constraints are already injected into context; follow them directly rather than guessing.

### Step 2: Step Back and Align

The user's first message is raw input—often a proposed solution ("add multi-window" might actually mean comparing two documents side by side). Step back to the underlying goal first, then work backward to what must be done.

Present three things together for confirmation:
- **Target outcome**: synthesized from the user's request, project goal docs, existing DAG nodes, and current state
- **Decisions to settle now**: scope, trade-offs, boundaries, and relationship to existing nodes
- **Explicit non-goals**: what this pass intentionally excludes (unstated exclusions look like omissions)

**Do not write nodes until alignment is reached**, especially on the first turn. Leave unsettled details open rather than guessing.

### Step 3: Split Work, Pick Paths, and Assign a Cycle

Once aligned, break the request into concrete items and present the full proposal—along with the pre-write compression results—for one-shot confirmation (value, merges/splits, dependencies, execution path, cycle assignment, `mode`, and `weight`). Offer explicit options (e.g., Draft A/B) rather than stating them as fait accompli. If the user interrupts, treat the discussion as still open and re-confirm.

Check four things while splitting:
- **Value**: whether the item is necessary and delivers the target experience.
- **Relation to existing nodes**: check whether it shares a feature, has an ordering, shares a prerequisite, or is truly independent ("independent" requires verification).
- **Dependencies**: infer prerequisites from the graph, docs, and code. **Two nodes that modify the same set of files must have a precedence edge** (parallel nodes run in separate worktrees; missing edges cause merge collisions). Judge overlap from actual implementation files (dispatch a subagent to inspect if unsure), not from impressions of the spec. **Edge vs `parallel` rule**: resolve file collisions with edges, never by lowering `parallel`; if pairwise collisions form a cycle, merge those nodes into one.
- **Cycle assignment**: assign to a running cycle whose `tags` cover the new nodes. If none fits, offer the user two choices: reuse an existing cycle (run `advance --cycle <line>` or `hold <node> --cycle <line>` directly—no reactivation needed) or open a new cycle (`cycle start` / `cycle create`, see [`docs/cycle-launch.md`](docs/cycle-launch.md)). **Only the user can decide to reuse an existing cycle.**

#### Choosing a Path per Item

| Path | Criteria |
|---|---|
| **Do it now** (dispatch subagent, no graph entry) | Nothing waits on it, verifiable at a glance, no cross-session needed — all three hold |
| **`light` node** (graph entry, `weight: light`) | Must queue or has dependencies, but small (one file, ~dozens of lines) and lightly verified; executed directly by the conductor |
| **`standard` node** (graph entry, omit `weight`) | Must queue and requires a full independent Execute / Review / Fix loop or may span sessions |

- **All behavioral code changes must enter the graph.** Only zero-runtime-impact edits (comments, docstrings, formatting, pure docs) qualify for "do it now."
- Docs that depend on a node finishing belong to that node's close-out Doc-sync, not "do it now."
- If "do it now" items are prerequisites for new nodes (e.g., feasibility probes, catching docs up to current state), finish them before writing specs.
- Work the conductor decides to finish in this session with subagents **must not enter the graph**, to avoid state drift; place temporary artifacts in `.tmp/` or `.superworker/nodes/<uuid>/temp/` (both gitignored).

#### Pre-Write Compression

1. **Merge**: combine items touching the same files with the same completion rule and verification round (if still one-session sized).
2. **Downgrade**: drop `standard` nodes that are actually one file / a few dozen lines / 1–2 commands to `light`.
3. **Skip discussion nodes**: this session is already the discussion. Exception: standalone design topics requiring a dedicated write-up (e.g., story architecture, gameplay trade-offs) may be added as `manual` nodes whose deliverable is that document.
4. **Skip human-only final-acceptance nodes**: subjective feel/experience checks after all work completes yield no automated reading and belong to the user. Automated integration checks that yield pass/fail readings are added normally.

#### Node Mode (`mode`)

Default to `auto`; escalate only when acceptance requires input only the user can provide:

| What acceptance requires | `mode` |
|---|---|
| Agent can run and verify autonomously without oversight | `auto` |
| Agent can verify autonomously, but pauses at close for user's "continue" | `checkpoint` |
| Live meeting, UI interaction, subjective feel/audio judgment | `manual` |

See "conclusions and stopping" in [`../sw-conduct/docs/conduct-state.md`](../sw-conduct/docs/conduct-state.md) for confirmation points. Tasks whose deliverable is the artifact itself (inventories, tech choices, design docs) run normally with acceptance "the artifact is the delivery." Human-only judgments must be `manual` or `checkpoint` rather than mocked.

### Step 4: Land Changes

All pipeline commands go through the `superworker` tool (`word`, `args`, and `help: true` for documentation). Independent calls can be batched in a single message and run in order. Follow `dag --help` for exact flags.

**For "do it now" items:**
Check the concurrency cap in [`shared/superworker/subagents.md`](shared/superworker/subagents.md) before dispatching. **Subagents only edit files and never commit**; all commits happen in Step 5. Common tasks: syncing docs to current ground truth (using [`../sw-conduct/subagent-prompts/doc-sync.md`](../sw-conduct/subagent-prompts/doc-sync.md)), non-behavioral small edits, one-off feasibility probes, state inventories/repros, repo hygiene, `config set`, recording discovered debt, or tech comparisons fed back into specs.

**Adding nodes (read [`docs/node-spec.md`](docs/node-spec.md) first):**
1. **Self-describing titles**: clear without external context; avoid internal numbering like "Direction X" or "Part X."
2. **Set attributes**: include the confirmed `mode`, `weight`, and `tags`.
3. **Connect edges**: check both upstream prerequisites and downstream dependents; verify topology to avoid unintended orphans. Intra-batch edges go in `depends_on` via `ref`; edges to existing nodes use `dag depend <node> --on a,b,c`.
4. **Batch create and write files**: create the batch with one `dag add --from-file` call to get node IDs and paths, then directly write `intention.md` and `spec.md` for each ID (do not read nonexistent files first; batch independent writes).
5. **Origin session**: recorded automatically (`sessions.discussion` / `session show <node>`, meaningful on this machine only); do not write it manually.
6. **Report topology**: report the new nodes and their upstream/downstream links to the user.

**Modifying the graph:**
- Title, `mode`, `weight`, and `tags` can all be updated.
- **Before connecting/disconnecting edges or deleting nodes**: inspect upstream and downstream, show affected links to the user, and re-verify topology afterward.
- **Deleting a node** also removes its spec. If other nodes depend on it, the tool refuses and lists dependents; bypass only with explicit user approval to break those edges.
- **Status changes**: a node's own status is only `todo` / `shelved` / `completed` (running state is derived from cycles). Use `shelved` to defer and `todo` to redo; never manually mark `completed` on `sw-conduct`'s behalf.

### Step 5: Close Out

Check first whether to run immediately (default unless the user says "not yet"):
- **Run immediately (default)**: **read [`docs/cycle-launch.md`](docs/cycle-launch.md)** and follow its exact order—land cycle → commit (the two commits below) → verify `plan` → start / hand over keys—so the `state.json` updated by landing the cycle is included in the commit.
- **Not running now**: skip landing and launching; make the commits below and report both SHAs and the topology.

Commits (up to two, as applicable):
- **Graph, specs, and cycle records** (`docs:`, naming added/changed nodes): `.superworker/ideas.json`, `.superworker/state.json`, and `intention.md` / `spec.md` under `.superworker/nodes/<uuid>/`.
- **"Do it now" outputs** (`docs:` / `style:` / `chore:` as appropriate).

## Query Mode

Use `dag` query commands (`dag list` sorts by urgency×importance with `completed` at the bottom; prefer `dag search` to locate nodes, `dag info` for details, and read `spec.md` when judging content). Summarize key findings; never dump raw JSON.

## Boundaries

- **sw-route (you)**: own the graph, node `intention.md` / `spec.md`, project settings (`config set`), and user-approved cycle landing/launch (only opening `/sw-conduct` sessions). Never execute nodes or edit project code yourself; delegate "do it now" tasks to subagents.
- **sw-conduct**: execute nodes end-to-end (prepare → execute → review → fix → close). Never creates nodes or opens cycles on its own (except as a fallback when invoked directly without `sw-route`).
- **Debt-recording plugins**: scanning debt, ruling on external items, and clearing debt are governed by each plugin's own skills. To schedule a debt-clearing pass on the graph, create a node with `method: <method_name>` (see [`docs/node-spec.md`](docs/node-spec.md)).
- Deep implementation discussions → suggest moving to `/sw-conduct` (prepare aligns requirements with code).

## Anti-patterns

Before starting, read [`./anti-patterns.md`](./anti-patterns.md) and check yourself against it.

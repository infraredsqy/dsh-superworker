# Git Sync, Ledger Commits, and Worktree Runbook

> When to read this: Prepare step 0 (local mode or conflicts), Prepare step 4 (creating a worktree), or Close steps 3 & 7 (merge-back and record commits).

## 1. `.superworker/` Sync and Conflict Handling

Determine the ledger mode via `git ls-files .superworker` (output = **commit mode**, empty = **local mode**; follow disk state, never move `.superworker/` manually):
- Local-mode records live on this machine only (lost on machine switch, re-clone, or `git clean -xdf`) unless `.superworker/` is its own git repo (`.superworker/.git` exists).

### Prepare Step 0: Pull Sync

**Always run both commands from the project root** (never run `git -C .superworker` from inside a worktree):
- **Commit mode**: `git pull --rebase`
- **Local mode**: `git pull --rebase` for code; if `.superworker/.git` exists and has a remote, also run `git -C .superworker pull --rebase`.
- Skip pull/push for any repository with no `git remote`.

### Conflict Handling

- Record JSONs under `.superworker/` use the custom merge driver (graph, cycle, instructions, and handoff slips merge by domain rules; other collection JSONs with per-entry `id` fields such as `.superworker/issues/issues.json` union by entry).
- `config.json` opts out of the merge driver; concurrent edits conflict and keep local bytes for human resolution.
- **On merge-driver failure or code conflict**: never hand-merge. If mid-rebase, run `git rebase --abort` (or `git -C .superworker rebase --abort` for the ledger repo) to restore clean state, then escalate to the user.
- If blocked by uncommitted local changes (often a previous session's unlanded commit), retry once; if it still fails, stop and ask the user.

### Close Step 7: Commit Close Records

Node code and docs were already committed as `feat:` in Step 3. Step 7 commits only the graph, cycle, and handoff records written by Step 6 (shared across the workspace; a parallel node may have already committed them):

- **Commit mode**:
  ```pwsh
  git status                      # only graph, cycle, and handoff records
  git diff
  git commit -m "chore: record node <node id> close (slip, cycle state)"
  git push
  ```
- **Local mode (with `.superworker/.git`)**: commit alongside this node's `run.md` and report set into the ledger repo:
  ```pwsh
  git -C .superworker status
  git -C .superworker add -A
  git -C .superworker commit -m "chore: record node <node id> close (slip, cycle state)"
  git -C .superworker push        # only if this repo has a remote
  ```
- **Local mode (no `.superworker/.git`)**: skip this step; records stay on disk.

If `git push` is rejected, run `git pull --rebase` and push again; escalate conflicts to the user. If push remains blocked, stop and tell the user that once push is fixed they can resume with `advance --cycle <cycle>` (the node is already settled).

---

## 2. `worktree_mode` and Fork / Merge-Back Runbook

`config get worktree_mode` options (update via `config set worktree_mode <value>`):

| Mode | Behavior |
|---|---|
| `off` | Work directly in the main tree; no fork or merge-back. No isolation—avoid with multiple cycles or `parallel > 1` |
| `fork` (default) | Fresh worktree per node, squash-merged back and removed at close |
| `reuse` | Not yet supported by the tool: stop and ask the user to change the mode; **never improvise with `git worktree add`** |

The steps below apply to **`fork` mode**.

### 1. Fork (Prepare Step 4)

Run all three checks (**never skip them**) before creating the worktree and branch:

```pwsh
# 1. Check main tree for uncommitted tracked changes (untracked files ignored)
git status --porcelain --untracked-files=no
# 2. Check checkout directory is free
Test-Path .superworker/worktrees/<node short id>
# 3. Check branch name is free
git rev-parse --verify --quiet refs/heads/sw/<node short id>
# 4. Create worktree and branch only if all three pass
git worktree add .superworker/worktrees/<node short id> -b sw/<node short id>
```

- **Check 1 non-empty (dirty main tree)**: stop and output verbatim, then wait a few minutes and re-check `git status` before forking:
  > the main tree has uncommitted tracked changes -- another line may be mid-merge-back (the docs sync and the ledger commit leave a dirty window of minutes). Wait a few minutes and re-check `git status` before forking:
- **Check 2 or 3 taken**: create nothing, stop, escalate to the user, and output the matching message verbatim:
  > .superworker/worktrees/<node short id> already exists -- the short id '<node short id>' is taken (by node <node id> itself, or the last fork was never cleaned up). Nothing was forked.
  >
  > branch sw/<node short id> already exists -- the short id '<node short id>' is taken. Nothing was forked.

Record the main tree's current branch (`git rev-parse --abbrev-ref HEAD`) as the **exit branch** under "Facts checked" in `run.md`.

### 2. Working Inside the Worktree

- Point all Execute / Review / Fix / Doc-sync code and doc paths at the worktree's absolute path (same workdir for `light` nodes and fast-lane runs).
- **`run.md` and report set**: in commit mode, write inside the worktree's `.superworker/nodes/<uuid>/` (merged back with the node); in local mode, write in the **main tree's** `.superworker/nodes/<uuid>/` (ignored `.superworker/` is absent in worktrees).
- **`temp/` (probes and raw outputs)**: always write in the **main tree's** `.superworker/nodes/<uuid>/temp/` under both modes.
- Pipeline commands work from inside the worktree cwd automatically—the tool resolves the main tree.
- Multiple parallel subagents within one node share the same worktree and merge back once at close.
- If concurrent git writes on the main tree hit `index.lock`, wait a few seconds and retry (escalate after 2–3 failures); **never delete lock files manually**.

### 3. Merge-Back and Cleanup (Close Steps 3–4)

Prerequisite: both Doc-sync and `run.md` have landed. **Run all commands below from the main tree root**:

1. **Commit inside the worktree and merge latest main tree**:
   ```pwsh
   git -C .superworker/worktrees/<node short id> add -A
   git -C .superworker/worktrees/<node short id> commit -m "feat: <what this node did>"
   git -C .superworker/worktrees/<node short id> merge <exit branch>
   ```
   Resolve any conflict inside the worktree and re-run the fast lane.
2. **Squash-merge into the main tree as one commit**:
   ```pwsh
   git merge --squash sw/<node short id>
   git commit -m "feat: <same message>"
   ```
   If the main tree is not on the exit branch or squash still conflicts (another cycle merged meanwhile), stop and escalate to the user.
3. **Run full verification on the main tree and clean up**:
   - Run full verification on the main tree; before reporting numbers, check `git log` to ensure no other cycle merged after your merge-back (if so, re-run full verification).
   - Once passing, remove the worktree and branch immediately before proceeding to Step 5 (self-check):
     ```pwsh
     git worktree remove .superworker/worktrees/<node short id>
     git branch -D sw/<node short id>
     ```

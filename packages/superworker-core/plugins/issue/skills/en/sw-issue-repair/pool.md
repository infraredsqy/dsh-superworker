# Issue Pool (Shared Conventions)

> Shared by `sw-issue-scan`, `sw-issue-discuss`, and `sw-issue-repair`. Refer to `--help` for CLI flags; this page defines conventions only.

The issue pool lives in `.superworker/issues/` as a unified quality-debt backlog. `source` records origin only: `scan` (code scan), `manual` (user-logged), or `conduct` (discovered during execution).

## Tool access only

Check `issue --help` via the `superworker` tool (pass `word` and `args`; pass `help` for usage) before operating on the pool.

- **All reads and writes must go through the `issue` command**. **Never read `.superworker/issues/issues.json` directly**—it is large, wastes context, and bypasses the tool's counting conventions.
- **Ask the verb that answers the question**: `issue status` for counts (it prints no rows), `issue by-module` for how the owed rows and their weight fall across modules, `issue top` for what to pick up next. `issue list` is the row-by-row read—it opens on unsettled entries, settled ones stay in the pool as dedup memory, and `--all` prints them all.

## Batching

When applying the same operation to multiple entries, use the command's batch form rather than invoking it one entry at a time:

- **Batch insert**: `add --from-file <rows file>` (one entry per row; `--auto-id` omits explicit IDs)
- **Batch update**: `update --from-file <rows file>` (`id` plus changed fields per row; use when each entry needs a distinct `reason`)
- **Batch close**: `resolve <id…> --reason "<shared verification reading>"`; same for `reject` / `acknowledge` / `remove`, and `mark <id…>` is natively batched

Place batch rows files in `.superworker/meta/batch/` and delete them once done. Any malformed row (unknown field, missing `id`, invalid value) rejects the entire batch atomically without writing; missing IDs in `update` / `resolve` / `reject` / `acknowledge` / `remove` also reject the entire batch. Duplicate IDs in `add` and unknown IDs in `mark` are reported per row rather than rejected as malformed. `N=1` behaves identically to single-entry calls.

## Field and metric conventions

- **Status**: `open`, `acknowledged`, and `resolving` are **actionable**; `resolved` and `rejected` are not.
- **`decision`**:
  - `autofix`: ready for autonomous repair. **Any entry whose decision is already settled with a written solution is `autofix`**, even if it belongs to another node or cycle.
  - `external`: requires a user trade-off decision.
  - `unknown`: not yet triaged (default on insert).
- **Weighted sum**: computed by `issue weight` over actionable entries where `decision != external`, weighted by severity. **Authoritative weights live solely in `SEVERITY_WEIGHTS` (`tools/storage.mjs`)** and are not duplicated here. Both `unknown` and `autofix` count toward the weight; reclassifying to `external` excludes the entry.
- **Severity**:
  - **P0**: duplicated logic carrying bug risk, or defects on a business-critical path.
  - **P1**: boundary/responsibility violations blocking iteration (business logic in UI, logic layer touching DOM, cross-layer coupling).
  - **P2**: structural improvements boosting velocity (extractable repeated patterns, scattered config, single feature requiring 3+ files).
  - **P3**: hygiene (naming, stale comments, dead code, formatting).
- **Large refactors as standalone entries**: refactor signals touching ≥3 files and changing inter-module dependencies get their own entry, with a recommendation to schedule them as a DAG node via `/sw-route`. Keep only the debt and criteria in the pool—do not expand the refactor plan here.
- **Deduplicate before inserting**: search the pool with related keywords before adding a new finding, and merge duplicates so the same debt is never tracked twice.

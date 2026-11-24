---
name: sw-issue-scan
description: Scan project code for untracked quality debt, record findings in the issue pool, and verify whether existing entries still exist.
disable-model-invocation: true
---

# sw-issue-scan

> Plugin: `issue` (installed and removed with the plugin).
> Caller: the user (`/sw-issue-scan`) or a conductor (named by a pipeline node spec's `method: ` line).
> Responsibility: scan code for new debt and check liveness of existing entries; pool updates only.
> Dispatches subagents: yes, one layer (scan); if a dispatched executor reads this file, stop and report back.

Scanning **fixes no code, holds no user discussion, and makes no `decision` rulings**—new entries always stay `unknown` for `/sw-issue-discuss` to triage later (decisions made at scan time go stale before repair).

Pool commands and conventions live in [`../sw-issue-repair/pool.md`](../sw-issue-repair/pool.md). All pipeline commands go through the `superworker` tool (pass `word` and `args`; pass `help` for usage).

## Inputs before dispatch

Before dispatching scan subagents, establish the project's module boundaries, architecture conventions, and code scope, and run `issue status` for the counts plus `issue list` for the **active entry list** (unsettled entries only), for liveness checks.

## Dispatch scans

Partition the scan by **module × dimension** (using subagents with write tools, since findings are written to disk), with each scan slice covering one target. Dimensions: duplicated code, boundary/responsibility violations, and structural issues. When there are only one or two modules, merge dimensions at your discretion.

Cap concurrent subagents at `config get max_agents`: **a single subagent may carry multiple scan slices**, so combine or batch slices accordingly.

Every prompt must provide:

- Absolute path to the role card: `<this skill's directory>/scan.md` (defines role, output schema, and prohibitions)
- Project architecture conventions and assigned file list (covering all slices assigned to that subagent)
- Active entry list (for liveness verification)
- Output path: `.superworker/meta/scan/<module-slug>.json` (one file per slice if a subagent carries multiple slices)

Wait until the full batch finishes before merging.

## Merge into the pool

1. Read all `.superworker/meta/scan/*.json` files.
2. **Deduplicate and merge**: if two findings share overlapping `files` **and** (overlapping `functions` or semantically equivalent `description`), merge them into one—keep the more detailed description and union their `files` and `functions`.
3. **Batch insert**: run `add --from-file <merged>.json --auto-id` (row format in [`../sw-issue-repair/pool.md`](../sw-issue-repair/pool.md) under "Batching"; do not call `add` one by one). For multi-file issues requiring new component design, also set `--plan-path .superworker/issues/specs/<id>.md`.
4. **Liveness check**: aggregate `alive_ids` from all scan summaries → run `mark <ids>` (increments `check_count` and reports `candidates`; **never changes status**). Only resolve an entry individually via `resolve <id> --reason` when a scan explicitly reports it could not be located across all three location layers; newly added entries missing from `alive_ids` is expected.
5. Delete temporary files under `.superworker/meta/scan/`.
6. Report: N new entries (broken down by severity), liveness check results, and the `candidates` list.

## Boundaries

- **User or conductor only**: this skill dispatches subagents.
- No code fixes, no spec edits, and no DAG node creation—prioritization belongs to the DAG.
- If you encounter a new feature that belongs in the DAG, note it in the report for the user; let `/sw-route` create the node.
- Log large-scale refactor signals as separate entries per the threshold in [`../sw-issue-repair/pool.md`](../sw-issue-repair/pool.md).

## Anti-patterns

Check [`./anti-patterns.md`](./anti-patterns.md) before starting.

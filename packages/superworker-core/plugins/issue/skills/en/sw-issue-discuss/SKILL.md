---
name: sw-issue-discuss
description: Human interface for the issue pool: record entries, inspect status, filter false externals, and settle external decisions in batches.
disable-model-invocation: true
---

# sw-issue-discuss

> Plugin: `issue` (installed and removed with the plugin).
> Caller: the user (`/sw-issue-discuss`).
> Responsibility: read, write, and triage the issue pool—record new entries, report status, filter false `external` entries, and settle true decisions with the user.
> Dispatches subagents: no. Use `/sw-issue-repair` for batch repair and `/sw-issue-scan` for code scanning.

Pool commands and conventions live in [`../sw-issue-repair/pool.md`](../sw-issue-repair/pool.md). All pipeline commands go through the `superworker` tool (pass `word` and `args`; pass `help` for usage).

## Intent routing

| User input example | Action |
|---|---|
| "the highlight covers the expand arrow on hover" | **Record**: generate a kebab-case id, run `add --severity P3 --decision unknown --source manual --title "<user's words>"`, and reply `recorded: <id>` |
| "how many issues are in the pool" | **Inspect status**: run `status` + `top --limit 10`, reporting the total and breakdowns by severity and `source` |
| "that one is fixed" | **Resolve**: locate via `search` → `resolve <id>`; if ambiguous, list candidates for the user to pick |
| "walk me through the external issues" | **Triage**: review and filter first, then discuss in batches |
| "fix this bug" | Handle a single bug debug directly in this session; route same-domain batch debt to `/sw-issue-repair` |

Do not interrogate the user when recording—one sentence is enough. If the user mentions files or a module, populate `--module` / `--files` / `--description` in passing.

## Triage workflow

### 1. Filter out false `external` entries first

Review entries marked `decision=external`: if an entry's `suggestion` is already concrete with no genuine trade-off, reclassify it via a batch rows file (`id` + `decision` + `reason`) and apply in one `update --from-file` call. Present only genuine user decisions next.

### 2. Discuss in batches (≤4 decisions per batch)

More than 4 decisions per batch degrades decision quality; defer the rest to the next batch.

- **Presentation**: follow [`./shared/superworker/talking.md`](./shared/superworker/talking.md)—one trade-off at a time, all four lines present, terminology calibrated to `config get answer`. Keep function names, variable names, line numbers, and call chains inside the issue entry for the implementer rather than dumping them on the user.
- **Recording decisions**: settle entries once decided. Entries sharing one reason can be updated in one `update <id…>` / `reject <id…>` call; entries with distinct reasons go through `update --from-file`:
  - **Simple fix** (single helper extraction, constant replacement, ~5 lines) → `update <id> --decision autofix --status open --reason "<settled decision>"`
  - **Complex fix** (multi-file change, new interface design) → write the design to `.superworker/issues/specs/<id>.md`, then run `update <id> --decision autofix --status open --plan-path <path> --reason "<settled decision>"`
  - **Won't fix** → `reject <id> --reason "<why>"`
  - **Defer** → `acknowledge <id> --reason "<waiting on what>"`
- **`--reason` must state the decision itself** (e.g., "report errors uniformly"), never just "discussed"—downstream executors only see that line.
- End each batch by stating how many `external` entries remain.

## Boundaries

| Situation | Handling |
|---|---|
| Deep dive into one entry's implementation details | Suggest `/sw-conduct` (aligns requirements with code during preparation) |
| Large-scale refactor signal | Log as its own entry (thresholds in [`../sw-issue-repair/pool.md`](../sw-issue-repair/pool.md)) and suggest `/sw-route` to schedule it as a DAG node |
| Batch repair | `/sw-issue-repair` |
| Refresh the pool | `/sw-issue-scan` |
| New feature for the DAG | `/sw-route` |

## Anti-patterns

Check [`./anti-patterns.md`](./anti-patterns.md) before starting.

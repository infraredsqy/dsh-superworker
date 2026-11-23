---
name: sw-issue-repair
description: Repair actionable debt in the issue pool until the target criterion is met: batch by change domain, run Fix → Review per batch, and commit on pass.
disable-model-invocation: true
---

# sw-issue-repair

> Plugin: `issue` (installed and removed with the plugin).
> Caller: a conductor (a pipeline node conductor or the user's session).
> Responsibility: repair eligible pool entries until the caller's target criterion (metric threshold or batch completion) is met.
> Dispatches subagents: yes, one layer (Fix / Review); if a dispatched executor reads this file, stop and report back.

All entries come from the issue pool; tools and conventions live in [`./pool.md`](./pool.md). **The caller defines the scope** (pipeline node `spec.md`, insertion note, or user instruction)—never expand scope to the whole repository, and stop as soon as the criterion is met.

All pipeline commands go through the `superworker` tool (pass `word` and `args`; pass `help` for usage).

## Disposal criteria

Each entry's disposal depends on one question only: **whether a decision is still open**. Do not decide based on layer touched, change size, or which cycle it belongs to:

| State | Criteria | Disposal |
|---|---|---|
| **Decided** | `reason` / `suggestion` spells out the fix and rules, or a `plan_path` is attached (`decision=autofix`) | **Fix it**, then `resolve` |
| **Still open** | No decision made and only the user can weigh the trade-off; or implementing the stated fix proves unviable | `update --decision external` with both options and their costs in `--reason` |
| **Not debt** | Investigation shows the issue does not hold | `reject` with why it is not fixed in `--reason` |

These are the only three exits: `acknowledge` (defer) belongs to `/sw-issue-discuss` and is never used here.

Two hard rules:

- **Leave unschedulable entries untouched**: their weight still counts, and they must be named in the report.
- **Report readings verbatim**: if the metric is still above the threshold, report that honestly and name the blockers. Inside a pipeline node, an unmet threshold must be recorded as `failed` with the measured reading in `-s`—never `completed`.

## Intake and triage

1. **Read the completion standard**: confirm whether the caller requires a metric threshold (e.g., `issue weight -v` below target) or terminal status for a specific batch.
2. **Fetch candidate entries**: pull **actionable** (`open` / `acknowledged` / `resolving`, per [`./pool.md`](./pool.md); filtering only `--status open` misses `acknowledged`) entries with `decision=autofix`, ordered by severity (narrow with `--severity` / `--module` if scoped).
3. **Triage `unknown` on the spot**: classify `decision=unknown` entries immediately—reclassify fixable ones to `autofix` and schedule them; reclassify genuine trade-offs to `external`. Never fix `decision=external` entries.
4. **Follow existing plans**: execute entries whose `reason` / `suggestion` already specifies the fix without re-litigating; read `plan_path` first if attached.

## Execution loop

Core loop mechanics and conductor boundaries follow `/sw-conduct`. This skill adds three rules:

- **Batch by change domain within the concurrency cap**: group entries from the same module into one batch; declare any genuinely cross-module change family explicitly as a single batch so one verification run covers it. Each batch's Fix + Review occupies 2 concurrent slots—check `config get max_agents` before launching parallel batches.
- **Run Fix → Review per batch**: Fix and Review read this skill's `subagent-prompts/fix.md` and `subagent-prompts/review.md` (Review is read-only). These are byte-identical copies of `sw-conduct/subagent-prompts/` (see `subagent-prompts/README.md`) so the `issue` plugin works standalone. Each prompt must state at least three things: the batch's entries, the verification command, and the report output path (if `sw-conduct` is installed, follow its "Fix" section).
- **Commit on batch pass**: commit immediately once a batch passes Review with no blocking issues. Outside a pipeline there is no node-close step, so commits happen here.

Handling Review findings: `critical > 0` → dispatch a new Fix round and re-Review; clearly harmless `minor` findings → log as new pool entries for a later same-domain batch; fix all other findings.

Log any new debt discovered during repair via `issue add` (per [`./pool.md`](./pool.md)) and **dispose of it immediately**: absorb it into the current batch if it fits the same domain, or settle it according to the disposal criteria. Newly logged entries count toward current readings—being newly discovered does not exclude them.

## Settling

Close out every touched entry cleanly:

```pwsh
issue resolve <id…> --reason "<fix location and verification reading>"
issue update  <id…> --decision external --reason "<two options and their costs>"
issue reject  <id…> --reason "<why it is not fixed>"
```

Use `<id…>` in a single call for entries closed by the same commit and verification reading; use `update --from-file <rows file>` when each entry requires a distinct `reason`.

**Never decide a user-only trade-off yourself**: list each one in the report's "Left for a human" section with both options and their costs.

## Report

- **Batch composition**: entries per batch, change domain, and commit hash
- **Disposal table**: counts of `resolve` / `external` / `reject`, one line per entry
- **Standard reading**: current measured value of the target metric (e.g., `issue weight -v`)
- **Left for a human**: each trade-off with its options and costs
- **Known unresolved**: entries not completed in this run (ID, reason, and what the next round needs), or `none`

## Anti-patterns

Check [`./anti-patterns.md`](./anti-patterns.md) before starting.

# sw-conduct Anti-Patterns

Review this checklist before starting. This file covers only pitfalls that **no tool will block on the spot, yet are easy to slip into unintentionally**. Authoritative rules live in [`./SKILL.md`](./SKILL.md).

## `conduct-treats-critical-as-false-positive` — Ruling a review finding a false positive yourself

**Symptom**: You disagree with a review finding, declare it a "false positive" on your own authority, and move on.

**Correction signal**: The report claims an item is a false positive without a follow-up review ever confirming it.

## `conduct-polls-for-subagent-completion` — Polling to wait for a subagent

**Symptom**: After dispatching a subagent, you poll for its output using `Start-Sleep` + `Test-Path`, or repeatedly call `list_agents`. Arbitrary sleep durations (90s, 240s) waste wall-clock time and clutter logs with fake "progress."

**Example**: A single node session accumulated 22 polling loops, each annotated `# wait-guard: necessary wait - waiting for subagent to write report.md`.

**Correction signal**: `Start-Sleep` and `Test-Path` appear together in logs. Reserve `# wait-guard:` strictly for time-based waits such as backoff retries or rate-limit windows.

## `conduct-flat-count-read-as-convergence` — Mistaking a flat review count for convergence

**Symptom**: Review reports `critical=0, minor=10` round after round, and the conductor keeps dispatching fixes because the count did not increase; or the same area is rewritten three or four times while new criticals pop up elsewhere each round.

**Correction signal**: The first-line identity markers in review reports hit the same set of locations two rounds in a row.

## `conduct-constraints-without-provenance` — Treating derived constraints as hard user requirements

**Symptom**: A node session invents a budget or cap and documents it using the same mandatory phrasing as user requirements. Downstream nodes copy it verbatim until it calcifies into an untouchable hard constraint.

**Example**: A project's `goals.md` contained only experience-level constraints and never mentioned chapters or segments. One session (`layout-budget.md`) derived "at most 3 segments per chapter," which `section-spec`, `render`, `diff-check`, and `outline` copied downward until it deadlocked against another self-imposed rule ("a featured diagram fills its opening chapter"), wasting five rounds across two nodes.

**Correction signal**: A rule phrased with "must / must not / always / cap is" cannot be traced back to the user's words or the goal docs.

## `conduct-freezes-criteria-with-findings` — Freezing stale review criteria after scope changes

**Symptom**: Interpreting "keep criteria consistent" as "never update supplement text." Even after a boundary changes (unfreezing a line, narrowing scope, or applying a new user ruling), the next review prompt reuses the old criterion verbatim. The review flags a defect in the stale rule, and the conductor treats it as a delivery defect.

**Example**: Round 2 ruled "remove the stale name comment in that directory, keep the rest frozen" and dispatched a fix. Round 3's review supplement still stated "any change under that directory is critical," triggering a critical finding on a 1-line comment edit with zero runtime impact—which the user later overruled.

**Correction signal**: A criterion in the current review prompt directly contradicts the ruling given to the fix subagent in the previous round.

## `conduct-hand-edits-ledger-or-resolves-conflicts` — Hand-editing `.superworker/` records or splicing JSON conflicts

**Symptom**: Reading and editing `.superworker/` record files directly to reconcile state, or manually splicing two conflicting JSON files line by line after a failed pull.

**Correction signal**: Manually edited record files in `.superworker/`, or hand-spliced JSON in the working tree.

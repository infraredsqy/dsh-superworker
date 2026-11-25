# Execute / Fix Subagent Anti-Patterns

Review this checklist before executing a spec. The authoritative rules live in [`../subagent-prompts/execute.md`](../subagent-prompts/execute.md); this file records symptoms and correction signals only.

## `conduct-execute-modifies-spec` — Modifying `spec.md` during execution

**Symptom**: Judging a spec item unreasonable and altering it on your own, or guessing the answer to a "to be confirmed" item.

**Correction signal**: The report introduces goals absent from the spec, and `spec.md` was modified after work began.

## `conduct-execute-adds-out-of-scope-work` — Taking another node's work or violating explicit exclusions

**Symptom**: Stepping outside this node's goal to implement features explicitly owned by downstream or sibling nodes, or sneaking in approaches rejected under "Out of Scope" (cleaning up legacy skeletons or styles in the same domain to realize `intention.md` is not this).

**Correction signal**: Changes implement independent functionality owned by another node or violate explicit exclusions in `intention.md` or `spec.md`.

## `conduct-execute-parallel-edits-other-file-group` — Editing files outside your assigned group in parallel

**Symptom**: During parallel execution, editing a file outside your assigned file group and colliding with another agent.

**Correction signal**: The change list includes a file not assigned to you.

## `conduct-execute-does-not-stop-on-blocker` — Failing to stop and report on a blocker or direct conflict

**Symptom**: Repeatedly retrying failing tests; hiding a direct conflict between legacy skeletons/styles and `intention.md` or a reference behind a local patch while claiming "spec clauses passed, structural trade-off"; or guessing through uncertain operations.

**Correction signal**: The report is a chain of retry attempts, or rationalizes an obvious mismatch against intent/reference as a "structural trade-off," without a clear `FAIL` escalation.

## `conduct-execute-runs-irreversible-operations` — Running irreversible operations

**Symptom**: Performing destructive actions under the guise of fixing an issue—bulk-deleting files or directories, running `git reset --hard`, broad overwrites, or deleting `.git`.

**Correction signal**: Before acting, you cannot explain how to roll the step back.

## `conduct-execute-continues-past-failing-tests` — Continuing past failing tests

**Symptom**: Reporting a test failure with "does not affect downstream behavior" and moving on.

**Correction signal**: The passing test results in the report do not cover the files touched in this round.

## `conduct-execute-assumes-failure-preexisting` — Assuming a failure is pre-existing

**Symptom**: Dismissing a failure as "already broken before" and skipping it.

**Correction signal**: The report states a conclusion without citing the failing test, command, or output.

## `conduct-execute-vague-deviation-report` — Writing a vague deviation report

**Symptom**: Summarizing departures from the spec as "a few minor adjustments."

**Correction signal**: The deviation section contains only vague qualifiers, without identifying what diverged or what was done instead.

## `conduct-execute-pastes-evidence-into-report` — Pasting raw evidence into the report body

**Symptom**: Dumping raw command output, synthetic samples, hashes, or long verbatim excerpts into `report.md`, inflating a single deliverable into a thousand-line report.

**Correction signal**: The report is too bloated for downstream readers, and most of it duplicates material already on disk.

## `conduct-execute-appends-stale-readings` — Appending stale readings instead of replacing them

**Symptom**: When numbers change, leaving old values in place and appending "**Historical reading**: …" next to them, bloating the report from hundreds to thousands of lines (e.g., a 429-line deliverable accompanied by a 2,017-line `report.md`).

**Correction signal**: The same metric appears multiple times in one report with earlier values labeled "historical."

## `conduct-execute-dispatches-on-conductor-instructions` — Dispatching subagents based on conductor-level notes

**Symptom**: Seeing conductor-level guidance in a spec or method skill (e.g., "batch by domain, dispatch Fix/Review per batch, commit on pass") and spawning nested subagents yourself.

**Correction signal**: Your execution performs subagent dispatches that your prompt did not authorize.

## `conduct-execute-defers-as-delivery` — Substituting "known unresolved" for delivery

**Symptom**: Marking an uncompleted spec requirement as "known unresolved" and treating the task as delivered.

**Correction signal**: The report closes with "known unresolved" without specifying what is missing, who can resolve it, or which acceptance criteria are impacted.

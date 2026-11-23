# Review Subagent Anti-Patterns

Review this checklist before starting a review task. The authoritative rules live in [`../subagent-prompts/review.md`](../subagent-prompts/review.md); this file records symptoms and correction signals only.

## `conduct-review-fixes-code-itself` — Editing code during a review

**Symptom**: Fixing an issue directly upon finding it instead of sticking to read-only reporting.

**Correction signal**: The working tree has modifications after the review round even though your prompt granted read-only scope.

## `conduct-review-only-rechecks-last-round` — Rechecking only the previous round's items before reporting PASS

**Symptom**: On round 2 or 3, checking only whether the prior round's critical/minor items were fixed and reporting `PASS` without a full review.

**Correction signal**: The review checklist covers only the items raised in the previous round.

## `conduct-review-adds-features-to-spec` — Demanding features not in the spec

**Symptom**: Concluding "A is a prerequisite for B, and the spec omitted A," then flagging "must implement A" in the review report.

**Correction signal**: A finding requires functionality the spec never asked for.

## `conduct-review-judges-other-nodes` — Flagging issues belonging to other nodes

**Symptom**: Marking missing work from a prerequisite node or another node's scope as a critical/minor finding on this node.

**Correction signal**: A finding's target location falls outside this node's spec scope.

## `conduct-review-accepts-preexisting-failure-claim` — Accepting a "pre-existing failure" claim without verification

**Symptom**: Taking the executing side's claim that a test failure is pre-existing at face value and passing the review.

**Correction signal**: The report merely repeats the claim with no independently run command or output.

## `conduct-review-reports-unrun-verification` — Reporting verification results without running them

**Symptom**: Writing "verification should pass" or "tests are expected to pass" without actually executing them.

**Correction signal**: Conclusions are phrased speculatively and the command evidence is missing.

## `conduct-review-count-line-missing-or-mismatched` — Missing or mismatched count header

**Symptom**: Writing lengthy analysis without the required first-line count summary, or reporting counts that do not match the listed findings.

**Correction signal**: The two numbers on the first line do not match the actual count of items below.

## `conduct-review-copies-known-material` — Copying material the reader already has

**Symptom**: Repeating ten line numbers across every field of a finding, quoting large blocks of the spec or deliverable verbatim as "evidence," or opening with a table of file `sha256` hashes and line counts—producing a 400+ line report where actual judgment is less than half.

**Correction signal**: Copied content outweighs actual findings and analysis.

## `conduct-review-clamped-reading-as-evidence` — Using clamped readings as passing evidence

**Symptom**: A verification script clamps out-of-range values back within bounds (e.g., `segs = Math.min(slots, ...)`), producing a false "0 breaches" pass; removing the clamp immediately exposes the real overflow.

**Correction signal**: The verification script still reports "all pass" against the old buggy behavior (e.g., a fourth-round fix verification script `fix4-verify.mjs`).

# sw-issue-repair Anti-patterns

Check before starting. The full rules live in [`./SKILL.md`](./SKILL.md) and `/sw-conduct`; this page lists symptoms and correction signals only.

## `issue-repair-skips-review-for-throughput` — Skipping review for throughput

**Symptom**: Deciding an entry is "too small to review" and committing straight after Fix—there is no reliable way to judge what needs no review.

**Example**: A change that "merely lifted an RAII guard into a shared header" missed an `#include`, broke compilation, and was only caught in review.

**Correction signal**: A batch has a Fix report without a corresponding Review report.

## `issue-repair-mixes-change-domains-in-one-batch` — Mixing change domains in one batch

**Symptom**: Bundling entries from unrelated modules that cannot share one verification pass into one Fix; or editing unrelated code outside the batch, polluting batch boundaries and breaking review traceability.

**Correction signal**: Entries in one batch span two or more modules under a single verification run.

## `issue-repair-batch-composition-unreported` — Omitting batch composition from the report

**Symptom**: The final report omits how batches were partitioned and which entries each batch contained.

**Correction signal**: The report lists readings and a disposal table, but a reader cannot map entries to batches and commits.

## `issue-repair-acknowledge-or-external-as-exit` — Using `acknowledge` or `external` as an escape hatch

**Symptom**: Marking hard entries as `acknowledge`, or reclassifying entries with valid written solutions as `external`.

**Correction signal**: `acknowledge` appears in the disposal table, or an entry with a viable solution is flipped to `external`.

## `issue-repair-batch-uncommitted` — Leaving a passed batch uncommitted

**Symptom**: Starting the next batch without committing a batch that has already passed review.

**Correction signal**: Changes from the next batch are mixed with uncommitted changes from the previous batch.

## `issue-repair-widens-scope` — Widening scope beyond the caller's target

**Symptom**: The spec asks to bring one metric below threshold, but you also clean up unrelated domains in the pool.

**Correction signal**: Resolved entries include domains or metrics outside the caller's specified scope.

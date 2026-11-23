# sw-issue-scan Anti-patterns

Check before starting. The full rules live in [`./SKILL.md`](./SKILL.md), [`./scan.md`](./scan.md), and [`../sw-issue-repair/pool.md`](../sw-issue-repair/pool.md); this page lists symptoms and correction signals only.

## `issue-scan-full-corpus-in-one-agent` — Covering the entire corpus with one subagent

**Symptom**: One subagent scans every module and returns duplicated code, boundary violations, and structural issues jumbled together.

**Correction signal**: Multiple module/dimension slices are piled onto one agent unnecessarily.

## `issue-scan-explores-without-reading-docs` — Dispatching scans without understanding project architecture

**Symptom**: Scan subagents are dispatched before establishing module boundaries and architecture conventions.

**Correction signal**: While slicing scans or writing prompts, you cannot articulate how the project's modules are divided.

## `issue-scan-finding-not-locatable` — Recording findings that cannot be located

**Symptom**: Writing "duplicated code in `game_ui.js`" with no function name or semantic anchor.

**Correction signal**: Trying to trace the finding back to code lands on no concrete function or logic block.

## `issue-scan-rescans-without-pool-dedup` — Rescanning without deduplicating against the pool

**Symptom**: Every full scan re-inserts entries that already exist in the pool.

**Correction signal**: Newly added entries share the same site and symptom as existing pool entries.

## `issue-scan-absence-read-as-resolved` — Treating absence as resolved

**Symptom**: Bulk-resolving entries absent from `alive_ids`; assuming an unlocated entry is fixed when the code merely moved; or running a liveness check right after inserting new entries and clearing them because they are not in `alive_ids`.

**Correction signal**: Any entry is closed during a liveness check without entry-by-entry confirmation.

## `issue-scan-refactor-as-small-item` — Logging a structural refactor as a small item

**Symptom**: A badly structured module is logged as a small `autofix` entry in the pool.

**Correction signal**: The debt spans three or more modules, yet the entry frames it as a quick tweak.

## `issue-scan-decides-for-the-user` — Ruling `decision` during the scan stage

**Symptom**: Marking every uncertain finding as "needs user decision", flooding the pool with twenty `external` entries.

**Correction signal**: `description` or `suggestion` says "needs decision" without naming what context is missing or what trade-off exists.

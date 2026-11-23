# sw-test-audit Anti-patterns

Check before starting. The full rules live in [`./SKILL.md`](./SKILL.md), [`./garbage-patterns.md`](./garbage-patterns.md), and [`./compression-criteria.md`](./compression-criteria.md); this page lists symptoms and correction signals only.

## `test-audit-conductor-reads-code` — Conductor reads test source directly

**Symptom**: The conductor opens and reads test source files directly.

**Correction signal**: The conductor has already read the raw source that the subagent is reporting on.

## `test-audit-ships-without-verifying` — Closing without verification

**Symptom**: Finishing without compiling or running the remaining tests after edits.

**Correction signal**: The final report lacks compile and test readings.

## `test-audit-deletes-a-whole-mixed-case` — Deleting a whole mixed test case

**Symptom**: Deleting an entire `TEST_CASE` when only some of its assertions are garbage.

**Correction signal**: Deletion is applied at the whole-case level while valid business assertions remain inside it.

## `test-audit-empties-a-file-without-the-build` — Emptying a file without updating the build system

**Symptom**: Leaving an emptied test file on disk while the build system still compiles it.

**Correction signal**: The file is empty, yet `CMakeLists.txt` / `Cargo.toml` / `package.json` still references it.

## `test-audit-splits-for-the-count` — Splitting subagents unnecessarily

**Symptom**: Mechanically spawning four or five scan subagents by module when there are few test files.

**Correction signal**: One subagent could easily cover the entire list, yet it was split into several.

## `test-audit-trades-coverage-for-time` — Trading coverage for speed

**Symptom**: Deleting slow tests that verify real business logic just to reduce fast-lane duration.

**Correction signal**: Entries marked for deletion match only the compression criterion, with quality empty or `none`.

## `test-audit-moves-one-lane-only` — Updating only the fast lane without the slow lane

**Symptom**: Moving tests out of the fast lane without updating the slow-lane command, marker, or collection list—or without running verification afterward.

**Correction signal**: Moved tests disappear from both lanes, or the report lacks post-move measured readings.

## `test-audit-scanner-decides` — Scan subagent outputs "suggest deleting"

**Symptom**: A scan subagent writes "suggest deleting" or "safe to delete" in its output.

**Correction signal**: Structured output contains action verdicts instead of raw hit facts for both criteria.

## `test-audit-asks-the-human` — Pushing decisions back to the user

**Symptom**: The report asks "please check which ones to delete" or "waiting for your confirmation before editing".

**Correction signal**: A report meant to run end-to-end ends with confirmation questions.

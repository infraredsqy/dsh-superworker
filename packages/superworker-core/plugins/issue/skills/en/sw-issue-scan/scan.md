# Scan Role Card

> Role: executor (dispatched by the conductor). Scan only the files assigned to you and **never dispatch further subagents**.

## Responsibility

Scan the assigned module code across the specified dimensions, write structured quality-debt findings as JSON for the conductor to merge, and verify whether assigned existing entries are still present.

## Workflow

1. Read all assigned files to understand caller/callee context.
2. Analyze across the assigned dimensions: duplicated code, boundary/responsibility violations, and structural issues.
3. Generate structured fields and a unique ID for each finding.
4. Write all findings at once to `.superworker/meta/scan/<module-slug>.json`.
5. Check the existing entry list using three-layer location.
6. Return the structured summary.

## ID rules

`<module-slug>-<short-slug>`, kebab-case (lowercase + hyphens), ≤64 characters.

- Valid: `export-job-close-no-event`, `ui-direct-cache-writes`
- Invalid: `export_job_close` (underscores), `issue 1` (space), `fix-grid` (vague)

## Output file format

Write a JSON array to `.superworker/meta/scan/<module-slug>.json` (e.g., `export.json`, `ui.json`). Required fields per entry:

| Field | Type | Description |
|---|---|---|
| `id` | string | Unique ID |
| `severity` | string | `P0` / `P1` / `P2` / `P3` (criteria in [`../sw-issue-repair/pool.md`](../sw-issue-repair/pool.md)) |
| `module` | string | Module name (e.g., `core/export`, `export`, `ui`) |
| `title` | string | Short title (≤30 characters) |
| `description` | string | One-sentence description of the issue |
| `suggestion` | string | One-sentence suggested fix |
| `files` | string[] | Involved files (relative paths) |
| `functions` | string[] | Involved function names |

**Omit `decision`**: deciding `autofix` vs. `external` is outside scan scope; new entries default to `unknown`.

Example:

```json
[
  {
    "id": "export-job-close-no-event",
    "severity": "P0",
    "module": "export",
    "title": "export_job_close missing JobClosed event",
    "description": "export_job_close neither emits JobClosed nor clears cache references, whereas export_image_close does both.",
    "suggestion": "Extract a shared internal close-job helper called by both bridge functions.",
    "files": ["src/export/bridge_image.cpp", "src/export/bridge_csv.cpp"],
    "functions": ["export_job_close", "export_image_close"]
  }
]
```

## Return summary

Append this structured summary at the end of your reply for the conductor to aggregate:

```
SCAN_RESULT:
  wrote: 8
  alive_ids: ["existing-id-1", "existing-id-2"]
  scan_file: ".superworker/meta/scan/export.json"
```

- `wrote`: number of findings written
- `alive_ids`: existing entry IDs confirmed still present (omit unconfirmed ones)

## Rules

- **Read all assigned files first, then write the JSON in one pass**—do not write entry by entry.
- **Use three-layer location**: function/class name → semantic description → file path (omit volatile line numbers). Apply the same three layers when checking existing entries; exclude an entry from `alive_ids` only if none of the three layers locate it.
- **Be explicit when uncertain**: if the fix is unclear, state in `suggestion` what context or design decision is missing rather than punting to the user.
- **Report only files you read**: never list a file in `files` that you did not open.

## Anti-patterns

Check [`./anti-patterns.md`](./anti-patterns.md) before starting.

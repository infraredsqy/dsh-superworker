# Compression Criteria

> For scan subagents to read alongside [`./garbage-patterns.md`](./garbage-patterns.md). This criterion looks at one thing only: **how much a test adds to the fast lane's measured duration**. Whether a test verifies real behavior belongs to `garbage-patterns.md`.

## What counts as slowing the fast lane

A test slows the fast lane if any of the following holds:

1. **In the fast lane and expensive**: spawns real subprocesses, accesses external resources, waits on wall-clock time, loads models, binds ports, or performs network I/O.
2. **In the fast lane and matches the project's slow-lane criteria** (e.g., real service subprocesses, wall-clock waits, slow model injection, or exceeding a per-test duration threshold).
3. **No fast/slow split exists yet**, and the test noticeably dominates total suite duration.

Follow **the project's own criteria**. If the project sets a threshold (e.g., "fast lane ≤10s"), evaluate against it; otherwise report facts (per-test duration and share of suite runtime).

## Splitting rules

A single test often mixes two kinds of assertions:

- **Pure-logic / pure-structure assertions**: millisecond-level, no subprocesses, clocks, or models → **extract into the fast lane**.
- **Environment-dependent parts**: keep in the slow lane.

Extracted fast-lane tests must be **self-contained**: no reliance on slow-lane state or shared fixture side effects, runnable standalone in the fast lane.

> **Splitting beats moving whole tests**: splitting preserves fast feedback while cutting runtime. Always check whether a test can be split before moving it whole.

## Moving a test out of the fast lane

Match the project's convention:

- **Markers** (e.g., `slow` tag): tag the slow test or file so the fast-lane command excludes it automatically.
- **Separate entry points** (e.g., separate commands or directories such as `tests/` and `bench/`): move the test to the slow entry and update build/collection lists in step.

**If the project has no fast/slow split, create one**: separate the irreducible heavy tests (real subprocesses, wall-clock waits, model loading, port binding) into a slow lane via a marker or dedicated entry, update build/collection lists, run both lanes once, and report measured timings.

## Prohibitions

- **Never trade deletion for speed**: slow tests that verify real behavior must be moved or split—deleting them drops coverage.
- **Never pull slow assertions into the fast lane**: only millisecond-level pure-logic assertions belong in the fast lane.

## Merged return format

Combined with `garbage-patterns.md` into one JSON object, with both `quality` and `compression` per finding:

```json
{
  "file": "tests/test_example.mjs",
  "findings": [
    {
      "test_name": "listens on 127.0.0.1 only",
      "quality": { "type": "hardcoded-count", "line_start": 15, "line_end": 22, "judgment": "partial" },
      "compression": {
        "slows_fast_lane": true,
        "reason": "spawns real service subprocess + waits on wall-clock time",
        "splittable": [
          { "what": "pure-logic assertions for port parser", "lines": "31-38" }
        ],
        "action": "split"
      }
    }
  ]
}
```

- `quality.judgment`: `entire` (whole block is garbage) / `partial` (mixed; remove garbage lines only) / `none` (verifies real behavior)
- `compression.action`: `move` (move out of fast lane) / `split` (splittable; list fast assertions in `splittable`) / `none`
- **The conductor decides deletion via the action table**: deletion applies only when `quality.judgment` is `entire` or `partial` **and** the coverage gate passes. Scan subagents report facts only—never write "suggest deleting".

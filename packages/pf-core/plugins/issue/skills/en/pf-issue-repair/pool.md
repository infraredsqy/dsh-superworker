# The pool (the issue store)

> The pool's scanning, ruling and repairing skills share this one. For command detail go by
> `--help`; this writes the conventions only.

The pool lives in the project's `.pf/issues/` and is one unified to-do list. `source` only says
how the entry came about: `scan` (scanned into the pool), `manual` (written down by the user in
passing), `conduct` (run into by a working session).

## Go through the tool only

Before touching the pool, ask the word itself: `issue --help` gives its page, and the
door is the `pathfinder` tool — a `word` plus its `args` to run one, and `help` for that word's
page.

- **Every** read and write of the pool goes through the `issue` word only. **Reading
  `.pf/issues/issues.json` directly is forbidden**: a giant JSON, it burns context and it bypasses
  the tool's own counting conventions too.

## Batching

When one action applies to N records, use the word's own batch shape instead of sending it once
per record:

- into the pool: `add --from-file <rows file>` — one entry per row, `--auto-id` saves the ids.
- changing the pool: `update --from-file <rows file>` — one `id` per row plus the fields it
  changes; rulings whose reason differs per entry go this way.
- closing the pool: `resolve <id…> --reason "<one verification reading>"`; likewise `reject` /
  `acknowledge` / `remove`, and `mark <id…>` was already batched.

Rows files go in `.pf/meta/batch/` and are deleted once the batch has run. A bad row (an unknown
field, a missing id, a bad value) refuses the whole batch and not a byte is written; an id that is
not in the pool refuses `update` / `resolve` / `reject` / `acknowledge` / `remove` the same way. A
duplicate id in `add` or an unknown id in `mark` is a known fact named per row, not a bad row. N=1
behaves exactly like the single form.

## The conventions

- Status: `open` / `acknowledged` / `resolving` are the three that count as actionable; `resolved`
  / `rejected` do not.
- `decision`: `autofix` (it can be fixed by ourselves) / `external` (the trade-off is still open
  in the user's hands) / `unknown` (not ruled yet, the default on the way into the pool). **An
  entry whose call has already been made, with the solution written inside it, is `autofix`
  without exception** — landing on another node or another line counts too.
- **The weighted sum** = P3/P2/P1/P0 = 1/2/4/8, counting only entries that are actionable and
  whose `decision` is not `external`. `unknown` presses on the line just as `autofix` does; ruled
  `external` and it drops out of the count.
- Severity (judge by this when writing each entry): **P0** duplicated and carrying a bug risk, or
  standing on a business-critical path; **P1** a responsibility crossing its line and holding
  iteration back (business logic inside the UI, the logic layer touching the DOM, a dependency
  across layers); **P2** a structural improvement that raises efficiency (an extractable repeated
  pattern, scattered configuration, a feature that takes 3+ files to change); **P3** tidiness
  (naming, stale comments, dead code, formatting).
- **A large change gets an entry of its own**: a refactor signal of ≥3 files that also changes
  inter-module dependencies gets an entry of its own, and moving to `/pf-route` (the refactor enters
  the graph as a node) is suggested.
  The pool keeps that piece of debt and its criterion only; the refactor plan is not unfolded
  here.
- **Search for the same entry before pooling**: before a new finding enters the pool, search the
  pool once with like words; dedup and merge on the way in — the same piece of debt in two records
  leaves the reader to recognise its own kin.

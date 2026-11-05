# bin/ — The transport adapter in front of the engine's words layer: the process facts, two streams, one exit code

> This file is a signpost, capped at 15 lines: one line per entry — only what this layer holds and when to read it.

- `pf.mjs` — The entry: one Node script (`#!/usr/bin/env node`), no platform branch, no shell-specific host. It hands the rest of the line to `lib/cli.mjs`
- `lib/cli.mjs` — The adapter: the three words that are answers about **this process** — the checkout's `doctor`, its `version`, and `merge-ledger`'s process hand-off to the engine's one entry — then everything else goes to the engine's `answer()` on this process's own seams
- `lib/engine.mjs` — This process's own seams: the engine module load (its product by package name, else the copy beside `bin/`), the checkout facts (`version`, `BIN_DIR`, `REPO_ROOT`), the bundled plugins folder the handles scan unless `PF_PLUGINS_DIR` names one, git, the drill switch and the session opener
- The words themselves — the table, the parser and printer, the verbs, the routing and the help — live in the engine package (`packages/pf-core/src/words/`); the one table is read from there, never copied here. A change under `src/` shows up here only after the package is built (`npm test` builds it first)

Read this layer when a word has to be added (it is added in the engine), a flag changes meaning, or a printed line has to move.

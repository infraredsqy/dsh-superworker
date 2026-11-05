# bin/ — The `pf` command in front of the engine: one entry, one table, the printer and the verbs

> This file is a signpost, capped at 15 lines: one line per entry — only what this layer holds and when to read it.

- `pf.mjs` — The entry: one Node script (`#!/usr/bin/env node`), no platform branch, no shell-specific host. It hands the rest of the line to `lib/cli.mjs`
- `lib/table.mjs` — The command table: one row per word, every cell stating that word's shape (usage shapes, section listings, option invocations and senses). The parser, the printer and the router all read it
- `lib/spec.mjs` — The bridge: a row becomes the action list the printer and the parser walk, plus the positional names a refusal prints
- `lib/argparse.mjs` — The parser and the help printer: the 78-column body, the word column, the sense column, the usage wrapping, the two-section listing
- `lib/engine.mjs` — The handle, the working project, the plugin folder the engine scans (this runtime's own bundled set unless `PF_PLUGINS_DIR` names one), and this process's two outward seams (git, the session executor)
- `lib/verbs.mjs` `lib/next.mjs` — The verbs: one function per word, each a reading of engine answers; `next` composes the settle, the pin, the material and the dispatch
- `lib/out.mjs` `lib/pyjson.mjs` — The shared cells every line is built from: the short id, the path spelling, the record JSON spellings
- `lib/cli.mjs` — The router: the top-level listing, the help words, the plugin words, `merge-ledger`'s process hand-off
- The engine's way in — its product (`packages/pf-core/dist`), never its source: by package name where that resolves, by the copy beside `bin/` where it does not — the artifact ships both, so an install needs no checkout. A change under `src/` shows up here only after the package is built (`npm test` builds it first)

Read this layer when a word has to be added, a flag changes meaning, or a printed line has to move.
# dsh-pathfinder — the `.pf/` pipeline record as a work panel in the DSH Web UI

> This file is a signpost, capped at 15 lines: one line per entry — only what this layer holds and when to read it.

**Read [docs/design-principles.md](docs/design-principles.md) before changing the UI** — that is this repo's law.

- `src/` — Host half, model layer, and browser half: how records are read in, how readings are computed, how the panel is drawn, how a node's session is opened (see `src/AGENTS.md`). Read when changing data fetching, the session opener, or the UI
- `bin/` — The `pf` command in front of the engine: the command table, the help surface, the plugin word routing (see `bin/AGENTS.md`). Read when changing the command surface
- `tests/` — Unit tests; `npm test` runs them and the engine package's own suite in one command (see `tests/AGENTS.md`)
- `tools/` — Where records come from, how artifacts are built, how the testbed starts (see `tools/AGENTS.md`)
- `docs/` — This repo's law and publishing practice (see `docs/AGENTS.md`). Read before changing the UI or shipping a version
- `packages/pf-core/` — The engine package: the records, the word table, the plugins and their skills; both the `pf` command and the host half read it (see `packages/pf-core/AGENTS.md`)
- `.pf/` — This checkout's own pipeline record (gitignored, local to the machine); read when a change has to follow the record's shape
- Package and build surface — `package.json`, `pnpm-workspace.yaml`, `tsconfig.json`, `tsconfig.host.json`, `tsdown.config.ts`, `cordis.patch.yml`: how the two entries are emitted, how the engine package is reached (inlined into the host bundle, and shipped as the product the `pf` command reads beside `bin/`), how this line gets hooked into the profile, what the git install route needs authorized. Read when changing the publishing surface

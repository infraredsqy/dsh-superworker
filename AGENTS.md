# dsh-superworker — the `.superworker/` pipeline record as a work panel in the DSH Web UI

> This file is a signpost, capped at 15 lines: one line per entry — what this layer holds and when to read it, one idea per line. File lists, function lists and readings belong in the code.

**Read [docs/design-principles.md](docs/design-principles.md) before changing the UI** — that is this repo's law.

- `src/` — Host half, model layer and browser half (see `src/AGENTS.md`). Read when changing data fetching, the session opener, or the UI
- `tests/` — Unit tests; `npm test` runs both suites (see `tests/AGENTS.md`)
- `tools/` — Build artifacts, the style check and an isolated testbed (see `tools/AGENTS.md`)
- `docs/` — This repo's law and publishing practice (see `docs/AGENTS.md`). Read before changing the UI or shipping a version
- `packages/superworker-core/` — The engine package: the records, the word table, the plugins and their skills (see `packages/superworker-core/AGENTS.md`)
- `.superworker/` — This checkout's own pipeline record (gitignored, local to the machine); read when a change has to follow the record's shape
- `package.json`, `tsconfig*.json`, `tsdown.config.ts` — How the two entries are emitted and how the engine package gets inlined. Read when changing the build or the publishing surface
- `cordis.patch.yml` — The line this package mounts into a profile. Read when changing how the panel gets hooked in

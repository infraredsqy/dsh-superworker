# dsh-pathfinder — the `.pf/` pipeline record as a work panel in the DSH Web UI

> This file is a signpost, capped at 15 lines: one line per entry — only what this layer holds and when to read it.

**Read [docs/design-principles.md](docs/design-principles.md) before changing the UI** — that is this repo's law.

- `src/client/styles/` — The panel's own sheets, in the shape they ship in: every selector already carries its layer class. The single source of the panel's look; read before changing the layout
- `design/` — Gitignored local snapshot of the design blueprint: page-shaped sheets, the four pages, their data, and the two generators that refresh it (`design/tools/`). Its pages link `tools/theme.css`. Read when redrawing the look by hand
- `src/` — Host half, model layer, and browser half: how records are read in, how readings are computed, how the panel is drawn, how a node's session is opened (see `src/AGENTS.md`). Read when changing data fetching, the session opener, or the UI
- `tests/` — Unit tests; `npm test` runs them and the engine package's own suite in one command (see `tests/AGENTS.md`)
- `bin/` — The `pf` command in front of the engine: the command table, the help surface, the plugin word routing (see `bin/AGENTS.md`). Read when changing the command surface
- `tools/` — Where records come from, how artifacts are built, how the testbed starts (see `tools/AGENTS.md`)
- `docs/` — This repo's law (read before touching the UI) and publishing practice (see `docs/AGENTS.md`)
- `docs/publish.md` — 发版口径：**发版本要先经人明确同意**，也不为验证配置专门发一版（验证只在下一次真发版时顺带完成）
- Package and build surface — `package.json`, `pnpm-workspace.yaml`, `packages/pf-core/` (the engine package), `tsconfig.json`, `tsconfig.host.json`, `tsdown.config.ts`, `cordis.patch.yml`: how the two entries are emitted, how the engine package is reached (inlined into the host bundle, and shipped as the product the `pf` command reads beside `bin/`), how this line gets hooked into the profile, what the git install route needs authorized. Read when changing the publishing surface

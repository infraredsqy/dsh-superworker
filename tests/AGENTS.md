# tests/ — The unit suite: what a test may pin, and what is walked by hand

> This file is a signpost, capped at 15 lines: one line per entry — what this layer holds and when to read it, one idea per line. Per-case lists are the files' own business.

**Pin behaviour and identity, leave the panel's wording alone.** The copy, the layout and the readings that need a real record move too often to hold; those are on the hand pass in [../docs/publish.md](../docs/publish.md).

- `client-*.test.mjs` — The browser half: the panel's own modules under Node, and the built `lib/client.js` booted under a mounted shell. Read when changing what a client module does
- `host-*.test.mjs` — The host half: record endpoints and writes, the session opener, the dispatch relay, the plugin line and skills, the instruction injection, the watch stream, the weight table, and the one workspace root. Read when changing the host half
- `model-*.test.mjs` — The model layer: readings computed from the four records, one instant at a time
- `helpers/` — The stand-ins the files share: real worktrees laid down by a git runner, the host context, agents and settings, the skill catalog, the built panel's boot
- `package-surface.test.mjs` — The package face publishing depends on: both halves, the engine product and the data in the artifact
- `engine-inline.test.mjs` — The engine's way in: bundled as code, never as a package reference

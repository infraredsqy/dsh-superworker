# tests/ — The unit suite: what a test may pin, and what is walked by hand

> This file is a signpost, capped at 15 lines: one line per entry — only what this layer holds and when to read it.

**Pin behaviour and identity, leave the panel's wording alone.** The copy, the layout and the readings that need a real record move too often to hold; those are on the hand pass in [../docs/publish.md](../docs/publish.md).

- `client-render.test.mjs` — The built `lib/client.js` over the in-memory port: the shell gets its spec, the panel mounts, every pane its tabs point at opens, the console stays clean. Skips itself with the reason when the bundle is not built; `npm test` builds it first
- `client-mount.test.mjs` — The two seats and the settings section: registration, the label function, unmount discipline, the language port
- `host-*.test.mjs` — The host half: the four sources, paging refusals, what each write lands in the record (and the engine's own sentence coming back), the session opener's flow, the dispatch relay — the claim a dispatch lands, the serial chain, the trigger behind the switch, and the button walking the same path (`host-relay`) — the package's plugin line, and the plugin skills placed into the DSH skill root, confirmed in a session's own catalog view, and taken back out (`host-skills`), and the skills' own wording: description length, no fenced command menus, no restating `shared/` (`host-skill-wording`), and the whole flow from a release-shaped package with no `bin/` and no `pf` on PATH, in a project with no `.pf/` (`host-no-cli`)
- `model-*.test.mjs` — The model layer: readings computed from the four records, one instant at a time, pure functions
- `helpers/` — The stand-ins the files share: the workspace-files port, the settings document, the locale service, the slot roster, the skill catalog's two views (root ranks and the layer merge, over real directories). One copy each; a file needing a narrower face builds it on top
- `package-surface.test.mjs` — The package face (`files`, exports, no command entry, `engines`, the patch line, the `prepack` chain) that publishing depends on: the artifact carries the two halves, the engine product and the data, and nothing to type at a shell
- `engine-inline.test.mjs` — The engine package's way in: it is a workspace package of this repo, no build external names it, and an entry importing it lands in the bundle as code rather than as a package reference. Skips the two legs that need `packages/pf-core/dist` with the reason when it is not built; `npm test` builds it first


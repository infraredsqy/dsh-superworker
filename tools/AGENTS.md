# tools/ — Build artifacts, the style check, and an isolated DSH testbed

> This file is a signpost, capped at 15 lines: one line per entry — what this layer holds and when to read it, one idea per line. Knobs belong in each script's own header.

- `css-check.mjs` — Style-layer self-check: colors only through aliases, exit 0 with zero violations. Run it after changing styles
- `build-client.mjs` — Build entry for the browser half: joins the sheets in cascade order, checks that no selector escaped its layer, then bundles `lib/client.js`
- `test-all.mjs` — The one command that runs both suites, each in its own process, and keeps the raw output in `.tmp/test-all/`
- `testbed/` — A DSH testbed isolated from the main environment: its own home, profile and synthetic workspaces, driven as `up` / `check` / `down`; `inject-probe.ps1` stages the injection and reads the runtime-context snapshots. Read when hand-reproducing what the panel reads
- `cdp-shot.mjs` — One screenshot of any page through headless Chrome over bare CDP; local-GUI auth is automatic, `--dismiss-boot` for DSH pages. Run it instead of hand-rolling a capture script
- `cdp-rec.mjs` — Screencast or fixed-cadence recorder to one mp4 with wall-clock-honest timing; `--raw-frames` for pages screencast sees as still. The `lib/cdp*.mjs` headers hold the traps
- `dev-restart.ps1` — Detached stop → reinstall → relaunch cycle for the local DSH web instance. Read its SAFETY header first: it must never run inside a live session
- `rehearsal/` — The pipeline rehearsal kit: graph seed, five spec templates, reset script; `README.md` drives a full run on a scratch workspace. Use after major function changes

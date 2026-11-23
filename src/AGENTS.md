# src/ — Host half, model layer, and browser half: records read in, readings computed, panel drawn

> This file is a signpost, capped at 15 lines: one line per entry — what this layer holds and when to read it, one idea per line. File lists, function lists and readings belong in the code.

- `host/` — Host half: the plugin entry, record endpoints, the session opener and dispatch relay, the skills this package places, the agent-facing tool and its wake, the instruction injection, the watch stream, and the one workspace root every door reads. Read when changing data fetching, the session opener, or the relay
- `model/` — Model layer: the four records, the session-note shape, one instant's reading, and the verdicts packet keyed by cell. Pure functions; no data fetching, no DOM. Read when changing how readings or a cell's verdicts are computed
- `client/` — Browser half: the panel, its settings, its language layer and overview windows, the data seam and the contribution that mounts it, and the weight gauge's judgment. Read when changing the UI, adding a language, or touching how the panel reaches the host

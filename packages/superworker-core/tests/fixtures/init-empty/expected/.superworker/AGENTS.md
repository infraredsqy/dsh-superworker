# .superworker usage note

> This file (`.superworker/AGENTS.md`) must not exceed 100 lines.
> This file is written and maintained by this tool at `init` time. **To change it, ask the user first** -- once they have said "go ahead", then touch it.

This directory is the superworker pipeline's ledger: `ideas.json`, `state.json`, `instructions.json` and
`signals/` are the pipeline's records, and `nodes/<uuid>/` holds the spec and the deliverable of
each slot (DAG node).

- Records are read and written only through the pipeline's words (`dag …`, `plan`); hand-editing the JSON is forbidden, and so is reading `ideas.json` raw -- use the tool's list / plan output.
- Process artifacts belonging to one slot (probes, raw output, self-check scripts) go in `.superworker/nodes/<uuid>/temp/`, which is temporary and not committed: do not submit them as deliverables.
- Everything else temporary goes in `.tmp/` at the workspace root.
- `meta/`, `worktrees/` and `nodes/<id>/temp/` are kept out of the repository by `.gitignore`; do not move anything from inside them out by hand and commit it.

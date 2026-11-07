# prepare: turn one round's run doc, prompt and handoff sheet into engine behaviour

method: pf-execute

## Done when

- `pnpm test` all green; the corpus compares byte for byte; repeated preparation is idempotent; nothing lands outside the node directory.

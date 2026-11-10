---
name: sw-instruct
description: Record one constraint in the project's instruction list so that later agents follow it; used inside a pipeline session.
disable-model-invocation: true
---

# sw-instruct

> Who runs me: the user, only inside a sw-route / sw-conduct session — those are the only ones that read this list
> What I am for: record one sentence of the user's own words into the project instruction list
> Do I dispatch subagents: no

Typed anywhere else, it is typed in the wrong place: say so, and record nothing in the list.

The pipeline's words are one table with one door: call the `superworker` tool — a `word`, its
`args`, and `help` for that word's page.

Copy that sentence from the call line into the list **word for word**; `--scope` is required, and
it decides who can see the entry:

```pwsh
# global: every session that reads the list from now on sees it, and it stays in force
instruction add --text "<the user's own words>" --scope global

# cycle: the sessions in this cycle see it, and it is gone when the cycle ends
instruction add --text "<the user's own words>" --scope cycle --cycle <id>

# node: it governs only the node it was recorded on, and it is gone when that node closes
instruction add --text "<the user's own words>" --scope node --node <id>
```

- With two lines side by side, `--cycle <id>` / `--node <id>` has to be named; when it cannot
  bind, the tool refuses the call
- It takes effect as soon as it is recorded; the run that reads it sees it.
- Words about "how far it runs, when it stops" (stop after three) do not belong to this list:
  they are the line's own policy key, written with `cycle policy <line> stop_after_nodes 3`. It can
  only add a stop point to that line — the node's own `mode` still speaks first (`checkpoint` stops
  just the same) — and `off` takes the count away. Entries in this list no longer take part in
  stopping, and recording one here will not stop anything
- Once it is recorded, read the entry's id and scope back to the user

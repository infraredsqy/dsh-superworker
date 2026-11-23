---
name: sw-instruct
description: Append a constraint to the project's instruction list for subsequent pipeline sessions (pipeline sessions only).
disable-model-invocation: true
---

# sw-instruct

> Caller: the user, inside `sw-route` / `sw-conduct` sessions only (the host injects this list into each round's context unless `injectInstructions` is disabled).
> Responsibility: record one user constraint **verbatim** in the project instruction list.
> Dispatches subagents: no.

If invoked outside a pipeline session, inform the user and do not write to the list.

All pipeline commands go through the `superworker` tool (pass `word` and `args`; pass `help` for that command's usage).

Copy the user's constraint **verbatim** into the list. `--scope` is required and controls who sees the entry:

```pwsh
# global: visible to all future sessions that read the list, until removed
instruction add --text "<user's verbatim text>" --scope global

# cycle: visible only to sessions in this cycle; expires when the cycle ends
instruction add --text "<user's verbatim text>" --scope cycle --cycle <id>
```

- **Two scopes only**: `global` and `cycle`. Constraints that apply to a single node belong in that node's `spec.md`, not here.
- **Concurrent cycles**: specify `--cycle <id>` explicitly; if the cycle cannot be resolved, the tool rejects the call.
- **Immediate effect**: takes effect as soon as it is written; subsequent rounds reading the list pick it up automatically.
- **Stop conditions do not belong here**: run-length limits (e.g., "stop after 3 nodes") are cycle policies set via `cycle policy <cycle> stop_after_nodes 3` (`off` clears the limit). This only adds a cycle-level stop point—each node's `mode` still takes precedence (`checkpoint` still stops). Instruction entries never trigger stops.
- **Confirmation**: once recorded, report the entry's `id` and `scope` back to the user.

# Subagent concurrency control

> The limit itself is not stored here. Before dispatching work, run `config get max_agents` to read the active value (resolved from built-in default → global `~/.superworker/config.json` → project `<project>/.superworker/config.json`; `config list` prints each value alongside its source layer). This document covers only how to apply the cap.

**This cap is a per-session estimate**: it does not query the host runtime, nor does it synchronize live counts across separate sessions via shared lock files. Each session budgets its own dispatches against this limit independently.

## How to apply it

Before dispatching, count currently active subagents and keep `in_flight + new_dispatches ≤ cap`. If a batch would exceed the cap, fall back in this order:

1. **Merge**: combine multiple related or lightweight subtasks into a single subagent prompt.
2. **Batch**: if merging still exceeds the cap, wait for the current batch to return before dispatching the next.

When merging tasks into one subagent, keep each subtask's output in its own distinct section of the report rather than blending them together, so downstream aggregation and deduplication stay clean.

## Why leave headroom

Hitting the runtime concurrency ceiling can cause an entire batch to fail together. Other active sessions may also be consuming slots at the same time, so budget conservatively rather than running right at the cap.

---
name: sw-test-audit
description: Audit a test suite for two verdicts in one pass—tests that verify nothing real (delete) and tests that slow the fast lane (move or split)—then execute and verify timings.
disable-model-invocation: true
---

# sw-test-audit

> Plugin: `test-audit` (installed and removed with the plugin).
> Caller: the user (`/sw-test-audit`, runs end-to-end) or a conductor (named by a node spec's `method: ` line for maintenance-channel nodes).
> Responsibility: audit the test suite—delete tests that verify nothing real, move or split tests that slow the fast lane, and create a slow lane when none exists.
> Dispatches subagents: yes, one layer (scan / removal); if a dispatched executor reads this file, stop and report back.

> **Hard constraints (violating any one = task failure)**
> 1. **Conductor does not read test source**: delegate scanning to subagents; the conductor works only from high-level context and structured scan results.
> 2. **Decide autonomously**: never produce a to-be-confirmed checklist or pause to ask the user (if the caller passed explicit scope limits, narrow scope accordingly).
> 3. **Verify after every change**: compile + run remaining tests and report measured timings.

## Two criteria, one action table

Both criteria inspect the same files and are evaluated in a single scan pass:

- **Quality**: does the test verify real behavior? Criteria in [`./garbage-patterns.md`](./garbage-patterns.md) (garbage patterns, coverage gate, and safety exceptions).
- **Compression**: does it slow the fast lane? Criteria in [`./compression-criteria.md`](./compression-criteria.md) (slowness criteria, splitting, and moving).

Actions follow from both verdicts:

| | Valuable | Worthless |
|---|---|---|
| **Slows fast lane** | Move out of fast lane; split fast assertions into fast lane if possible | Delete |
| **Does not slow fast lane** | Keep | Delete |

- **Deletion requires the coverage gate**: a test may be deleted only if it matches a garbage pattern **and** the business behavior it touches is covered elsewhere. Deleting purely for speed drops coverage.

## Entry points and scope

| Caller | Scope |
|---|---|
| User invoking `/sw-test-audit` | Caller's trailing instruction; otherwise the entire test suite |
| Pipeline node (`method: ` line in `spec.md`) | Scope specified in `spec.md`—never widen to the full repository |

Node `mode` (whether to pause or ask a human) is owned by `sw-conduct`.

## Workflow

All pipeline commands go through the `superworker` tool (pass `word` and `args`; pass `help` for usage).

### 1. Understand the test setup

Before dispatching scans, establish the project's test layout, framework (Catch2 / Jest / pytest / node:test, etc.), build and verification commands, and fast/slow lane setup (`slow` markers, separate entry points, or parallelism flags). If details are unclear, dispatch a subagent to inspect—do not read test source files yourself.

### 2. Dispatch scans

Scale scan subagents to file count: default to 1 covering everything, splitting only when one list is too large. Check `config get max_agents` before dispatching, and merge or batch to stay within the cap.

Every scan prompt must include:

- **Absolute paths** to [`./garbage-patterns.md`](./garbage-patterns.md) and [`./compression-criteria.md`](./compression-criteria.md)
- Generic pattern examples translated into the project's test framework syntax
- List of files to scan
- The merged two-criteria return format

Launch scan subagents in parallel and wait for completion notifications—do not poll.

### 3. Aggregate and decide

Group findings by file, record both verdicts (quality and compression), and assign actions per the action table. Organize results by `entire` / `partial` / `move` / `split` with per-item actions and rationale.

### 4. Execute and verify

Dispatch a removal subagent (default 1; split only for very large change surfaces):

- **Delete**: remove targeted test cases or garbage assertion lines; remove emptied files from the build system.
- **Move**: move slow tests out of the fast lane per the criteria; if no fast/slow split exists and heavy tests cannot be sped up, create a slow lane.
- **Split**: extract pure-logic fast assertions into the fast lane and keep environment-dependent parts in the slow lane.

**Verification required**: compilation passes and remaining tests pass (or at least no new failures). Follow `sw-conduct/SKILL.md` ("Test tier and verification") for commands and tier; when `test-audit` is installed standalone, read the tier via `config get test_tier` and run the project's verification commands. **Measured timings are mandatory**: always report the fast-lane duration (acceptance for compression); in pipeline-node mode, also report the full-suite duration (read by the maintenance-channel completion check). Missing timings means incomplete work.

### 5. Close out

Report: deletion counts (`N` whole cases / `M` partial spots), moved count, split count, empty files removed, compile/test results, measured fast-lane (and node full-suite) timings, and unhandled items (including entries retained by the coverage gate).

- **Standalone run**: commit only the files modified in this run; leave unrelated uncommitted changes untouched.
- **Pipeline-node run**: do not commit—hand the report back to `sw-conduct` for node closure, committing, pushing, and dispatch.

## Boundaries

| Situation | Handling |
|---|---|
| Caller specifies "audit only, no edits" or other limits | Narrow scope accordingly (e.g., scan and report only) |
| Verification fails | Report failure details and stop—do not guess, roll back, or force it |
| Large-scale test refactor needed | Suggest `/sw-route` to schedule it as a DAG node |
| Project has no tests | Report "no test files found" and exit |

**Report-only output**: scan conclusions are not persisted to any store; place raw verification artifacts in the standard temp directory (`.superworker/nodes/<node uuid>/temp/` inside a node, `.tmp/` otherwise).

## Anti-patterns

Check [`./anti-patterns.md`](./anti-patterns.md) before starting.

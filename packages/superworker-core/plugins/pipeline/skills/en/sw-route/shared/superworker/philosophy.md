# Superworker's design philosophy

> This file describes Superworker's core design intent and underlying principles; `sw-route` cites
> it and does not retell operational rules here.

## The core problem

Real engineering work rarely finishes in a single turn or a single session. Once a task stretches
into a multi-step chain with dependencies (4, 8, 10, or more steps), standard workflows run into a
dilemma:

- **Manual session splitting**: Every completed step requires the user to return, inspect the
  output, and prompt the next step, turning the user into a full-time supervisor.
- **Single-session orchestration**: Even with subagents, as a chain grows longer, the main context
  drifts, accumulates redundant history, and loses coherence. Incidental findings—such as
  pre-existing codebase issues uncovered mid-run—have nowhere to go and are either dropped or
  derail the active task.

## The core design: a persistent, shared orchestration surface

Superworker centers on one idea: turning orchestration logic that would otherwise live in throwaway
workflow scripts or ephemeral chat history into a **persistent, project-native interface that
agents call directly, paired with a live visual panel for the user**.

Human and agent share the exact same structured state on disk (`.superworker/`):

- **Planning decoupled from execution**: Goals, boundaries, and acceptance criteria are settled
  into discrete nodes before execution starts. Human effort focuses on upfront alignment, explicit
  checkpoints, and final acceptance.
- **Cross-session continuity**: Each node runs in a fresh session with clean context. Because state
  is persisted on disk, progress remains observable, interruptible, and resumable from any node.

## Why a DAG

Work items carry natural dependency relationships (B requires A; parallel branches converge at C).
A linear list loses that structure, and hand-maintained priorities quickly go stale.

Graph topology automatically derives two core metrics for **unfinished** nodes and updates them
dynamically as upstream nodes complete, with no manual re-ranking:

| Metric | Meaning | Graph algorithm |
|--------|---------|-----------------|
| **urgency** | Can it start now | Closer to the front of the topology = prerequisites met = higher urgency |
| **importance** | How much depends on it | Larger reverse-reachable set = more downstream dependents = higher importance |

Together they determine default ordering (`urgency × importance`): ready foundational nodes with
broad downstream impact surface first, while blocked high-impact nodes pull attention to their
prerequisites. Dependency edges also define explicit ordering boundaries so independent nodes can
advance in parallel safely.

Two record-keeping principles follow from this structure:

- **Preserve history rather than deleting**: Finished (`completed`) and paused (`shelved`) nodes
  stay in place to preserve execution history and dependency references. Nodes are deleted only
  when the idea itself is scrapped.
- **Keep ground truth clean**: Future plans and execution records live in `.superworker/`, leaving
  project documentation (`docs/`) strictly for implemented state so agents never confuse plans with
  current reality.

## Two complementary mechanisms

### Independent review as a long-chain fail-safe

Over multi-step engineering execution, any executor can introduce local blind spots. Without an
independent check, small defects compound as downstream nodes build on top of them.

The pipeline therefore places an independent review-and-fix loop at node close-out as a
**fail-safe** for unattended long-chain runs. It is a reliability layer rather than a rigid
prerequisite—fast-paced workflows can lighten or skip review when speed matters more, with a
corresponding trade-off in stability.

### Externalized backlog ("external brain")

Because plans and discoveries share a persistent structured home, the graph also serves as an
**external brain**: ideas B / C / D that surface while working on A, or pre-existing codebase
defects uncovered mid-execution, can be captured as linked nodes or logged in the issue pool
without breaking current focus or getting lost across session boundaries. This is especially
valuable for engineers juggling parallel threads on complex projects.

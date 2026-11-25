# sw-route Anti-Patterns

Review this checklist before acting. The authoritative rules live in [`./SKILL.md`](./SKILL.md); this file records symptoms, correction signals, and examples only.

## `route-edits-project-files-directly` — Editing project files directly outside the pipeline

**Symptom**: During discussion, the agent edits or writes application code or project documentation directly.

**Correction signal**: The user says "I didn't ask you to change the code."

## `route-advances-without-reading-graph-or-docs` — Advancing without reading the graph or project docs

**Symptom**: Given an idea, the agent skips both the DAG and project docs, jumping straight into discussion and node creation.

**Correction signal**: The user says "this node already exists" or "this conflicts with an earlier design."

## `route-dumps-raw-data-at-user` — Dumping raw, unrefined data at the user

**Symptom**: When asked what is in the graph, the agent dumps raw node JSON directly.

**Correction signal**: The user says "too much noise" or "get to the point."

## `route-node-name-depends-on-source-context` — Node names that depend on external doc context

**Symptom**: The node title uses an internal numbering or section reference from a source document, such as "Direction 5" or "Direction 1."

**Correction signal**: The user says "this name doesn't make sense" or "names should be self-describing."

## `route-creates-orphan-node` — Creating an orphan node with no downstream dependency

**Symptom**: A new node declares only upstream dependencies (what it depends on) and no downstream dependents (what depends on it). An orphan sits outside every recommended path with urgency and importance of 0, effectively excluded from the pipeline.

**Correction signal**: Listing the graph shows the node missing from all recommended paths.

## `route-deletes-node-or-edge-without-impact-check` — Deleting a node or edge without an impact check

**Symptom**: The agent force-deletes a node on request, or removes an edge without inspecting upstream and downstream neighbors. A prerequisite vanishes silently, causing downstream nodes to run on broken assumptions with no trace in the graph.

**Correction signal**: The user says "why did you cut that edge?" or "who told you to delete that?"

## `route-splits-without-verification-boundary` — Splitting nodes without independent verification boundaries

**Symptom**: The proposed split has no clean verification boundary—either multiple nodes share a single verification step (too granular), or one node mixes distinct verification methods (too coarse).

**Correction signal**: The user says "these two belong together" or "why split this so finely?"

## `route-spec-has-implementation-detail-or-no-done-check` — Implementation details in spec, or missing done criterion

**Symptom**: The spec includes function names, line numbers, call sequences, or step-by-step implementation instructions (directory and file names as landing points or read-only references are allowed); or it consists only of vague goals like "design X" or "tune Y" with no runnable pass/fail acceptance check.

**Correction signal**: `sw-conduct` aborts during preparation, reporting that the done criterion cannot be executed or that the spec's code assumptions do not hold.

## `route-spec-abstracts-reference-into-proxy-checks` — Dropping a reference baseline and substituting mechanical proxy checks

**Symptom**: A mock, design, sample, or specification already exists in the repo, yet `spec.md` omits its read-only path, paraphrases its shape into a few abstract bullets, and fills completion criteria with mechanical probe assertions (font size, no overflow, element presence); or slices one cohesive artifact by mechanism so every node locks local legacy behavior and nobody owns the whole.

**Correction signal**: Every probe and review check passes 100%, yet placing the deliverable side by side with `intention.md` or the reference shows they are obviously not the same thing.

## `route-spec-scope-unpinned` — Unpinned spec scope

**Symptom**: The spec states what to do without naming where the change lands, or uses wording that matches more than one location in the codebase.

**Correction signal**: Asking "where does this change land?" against the spec yields more than one answer.

**Example**:

    This command's output is messy—clean it up without breaking anything else.

This specifies neither the target location nor a verifiable outcome. Proper form:

    Goal: Align column widths for the command's three-column output.
    Scope: The command's own entry point only, excluding downstream subcommands.
    Criterion: Running the command once aligns all three columns to the widest entry; argument parsing and exit codes remain unchanged.

## `route-lowers-parallel-instead-of-adding-edges` — Lowering `parallel` instead of adding dependency edges

**Symptom**: When two or more nodes touch the same files, the agent reduces the cycle's `parallel` setting (often to 1), citing "safety" or "avoiding conflicts."

**Correction signal**: The user says "add a dependency edge for conflicts, don't lower parallelism."

## `route-writes-node-before-requirements-settle` — Creating nodes before requirements settle

**Symptom**: While the user is still exploring design trade-offs, the agent prematurely compresses the discussion into nodes and specs without first presenting a proposal for confirmation.

**Correction signal**: The user says "you jumped ahead," "slow down and align first," or "delete the nodes you just added."

## `route-creates-discussion-or-acceptance-node` — Modeling discussions or final manual acceptance as DAG nodes

**Symptom**: Nodes such as "Discuss design of X with user" or "End-to-end manual testing / acceptance after all nodes complete" appear in the graph.

**Correction signal**: The user says "don't create a node for that" or "I'll test that myself."

## `route-reads-a-landed-line-as-a-started-node` — Treating a landed cycle as an actively running node

**Symptom**: After running `cycle start` or `hold`, the agent reports "the cycle is running" or "the first node is ready," misreading the `Node:` line in `cycle current` as active execution. No execution session was actually launched, leaving the user's request to start work half-done.

**Correction signal**: The user asks "is it actually running?" or "which session is running it?"

## `route-hands-over-a-command-without-pipeline` — Dropping `[pipeline]` from the handoff command

**Symptom**: The handoff command is given as `/sw-conduct <node-id>` without `[pipeline]`. The user runs it, only that single node completes, and no close, commit/push, or next-node advancement occurs—leaving the cycle stalled.

**Correction signal**: The session exits after one node while `cycle current` remains unchanged.

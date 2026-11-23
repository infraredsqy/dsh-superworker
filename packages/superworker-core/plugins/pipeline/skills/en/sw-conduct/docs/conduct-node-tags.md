# Conduct: Node Tags and Cycle Routing

> Design reference for **node tags and cycle routing**: vocabulary, filter criterion, and why filtering applies exclusively to node selection.
> For state and advancement contracts, see [`./conduct-state.md`](./conduct-state.md); for dispatch, see [`./conduct-dsh-dispatch.md`](./conduct-dsh-dispatch.md); for instruction scope visibility across concurrent active cycles, see the context-injection section in `conduct-state.md` (instructions exist at two levels only: `global` and `cycle`).
>
> Core rule in one sentence: **A node may have no tags; a cycle's `tags` define its permanent selection scope for its entire lifetime; filtering applies only when picking the next node.**

## 0. Motivation

When a single DAG holds copywriting, code, and art tasks together, there is no way without filtering to express "run a line for copy only" or "restrict this line to code changes."

Tags express that boundary: nodes declare their work category via tags, and cycles declare their selection scope via a filter set. A cycle started with `--tags coding` uses that same filter set from its first node to its last, selecting code work exclusively.

## 1. Recommended Vocabulary

Three standard tags are defined: `writing`, `coding`, and `art`.

This vocabulary is a **human convention**, not a hard engine restriction. Tags outside the list emit a one-line warning and are accepted as-is—if a project needs a fourth category, it works immediately while the warning flags the non-standard name. Filtering always performs exact string matching.

## 2. Storage and Intentional Asymmetry

- **Node tags live in the DAG**: work category is a graph property alongside dependencies and node status.
- **Cycle filter sets live on the cycle record**: scope is a durable property of the execution line, not of an individual pick. The start command passes the filter set to both the initial pick and the cycle record simultaneously—picking occurs before the cycle exists, so writing only to the record would let the first pick grab unrelated work. Every subsequent pick reuses the stored filter set, preventing mid-cycle drift.
- **Asymmetry is intentional**: Node tags are optional; when omitted, the key is absent from the graph (preserving backward compatibility). **Cycle `tags` are required**: beyond filtering picks, they also define which maintenance channel domains apply to the cycle—omitting them would leave maintenance routing ambiguous.
- **Weights are computed once**: Scores are still computed over the entire unfinished subgraph; filtering only drops non-matching rows without altering scores. The top node within a filter set therefore follows the exact same ranking as the full graph.

## 3. Filter Criterion

> A node is within a cycle's selection scope ⇔ it has **no tags**, or its tags **intersect** the cycle's filter set.

- A node may carry multiple tags (e.g., `art,writing`), making it eligible for both lines; whichever picks it first claims it.
- **Untagged nodes match every filter set**: This is the conservative default. Failing to filter out a node costs at most one extra run, whereas wrongly hiding a node can strand work indefinitely until someone notices. "No tag" therefore always means "unrestricted."
- If a legacy cycle record has no filter set, the entire graph is in scope.

## 4. Why Filtering Applies Only to "Pick the Next Node"

Filtering is strictly a **selection rule**; extending it elsewhere creates state conflicts:

- **In-flight nodes are unaffected**: Once a cycle claims a node, it tracks that claim directly. Even if the filter set no longer matches, the held node finishes and closes normally—overturning a claim mid-flight would break state consistency.
- **Dependencies are untouched**: Being filtered out is distinct from having unmet dependencies. Filtered nodes do not change status, are not marked `shelved`, and retain all dependency edges—they are simply not selected in this round.

## 5. Pausing When Only Other Lines Have Ready Work

If the current cycle's filter set has ready nodes, it picks the top-ranked one; if the entire graph has no ready nodes, it stops. **If this cycle has no ready nodes, while other ready nodes exist in the graph but are excluded by tags—it also stops.**

Stopping returns the decision to the user: this line's work is done, and whether or when to launch another line is a human decision. The engine can determine that work exists elsewhere, not whether starting a second line right now is appropriate.

On pause, the engine emits a human-readable `reason` naming which ready nodes were excluded by which tags, along with a ready-to-copy command to start a new cycle. The current cycle transitions to `inactive`; excluded nodes remain untouched in the graph with no locks or error flags.

## 6. Explicit `--node` Selection

A node explicitly named via `--node` follows existing semantics: if ready, it runs; if not ready, it is rejected with an explanation. The filter set governs automatic selection and must not silently discard an ID the user explicitly typed. In either outcome, if the node falls outside the cycle's filter set, the message must state so explicitly rather than only saying "cannot start now" (which suggests unmet dependencies).

## 7. Empty Filter Set (Backward-Compatibility Floor)

All write paths require `--tags`, so the empty-filter branch exists solely for **legacy cycle records** created without tags:

- Empty filter set ⇒ the entire graph is in scope; selection, recorded paths, and record structure remain byte-for-byte identical to pre-tag behavior.
- Untagged node ⇒ eligible under any filter set, with no extra key added to the graph.

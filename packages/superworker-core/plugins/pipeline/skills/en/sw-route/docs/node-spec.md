# Node Specification Guide (`intention.md` / `spec.md` / `method:`)

> When to read this: before writing a node's `intention.md` and `spec.md`, or when creating a `method:` debt-clearing node.

## `intention.md` vs `spec.md`

Separating goals/principles from point-in-time criteria prevents agents from collapsing both layers and silently following stale criteria.

| Aspect | `intention.md` | `spec.md` |
|---|---|---|
| Answers | What is wanted, what is not, and **why** | Where changes land, boundaries, and what counts as done |
| Who may edit | **The user only** | Downstream may only refresh stale snapshot counts/lists |
| When the codebase evolves | **Stays fixed** | Counts/lists may go stale and should be updated |
| Litmus test | Still holds after new modules, pages, or data files appear? | Depends on the state on disk when written |

### Writing `intention.md`

- State the goals and principles this node protects (e.g., "all state transitions are event-driven", "applies only to the real editor; the mock page stays untouched as a control").
- Describe the desired end state, not the current state on disk.
- Prose or bullets are both fine. The only hard requirement: **a reader can answer "why," not merely "what."**
- Self-check: if a sentence describes how things currently look on disk, move it to `spec.md`.
- **Why agents must never edit `intention.md`**: it is the user-approved baseline. Editing it replaces the user's requirement with the agent's own interpretation, corrupting every downstream review and acceptance check. If the codebase has shifted, criteria no longer cover the intent, or the intent itself has a contradiction, stop and present the new state alongside `intention.md` to the user.

### Writing `spec.md`

- Specify the landing point (in project vocabulary; **folders and file names are allowed, while function names, call order, and implementation steps are forbidden**), read-only reference baselines, scope boundaries, and completion criteria matched to how the work is actually judged.
- **Point to references instead of paraphrasing**: when the repo already holds a reference artifact (mock page, design, sample, external spec), name its path directly and state what is excluded (e.g., dummy data or demo code)—**do not compress a rich reference into a few abstract bullets**. A project rule saying "application code must not import/reference directory X" governs runtime code, not `spec.md` pointing to X as a read-only reference.
- **State replace vs. preserve explicitly**: if an old skeleton, stylesheet, or structure should be replaced wholesale, say so directly rather than writing vague "keep as-is" clauses that trap the new work inside the old shell. When an upstream node establishes a shared contract (such as shared visual tokens or a protocol), downstream nodes must explicitly require consuming it and retiring old private definitions.
- `spec.md` inevitably captures point-in-time snapshots (module counts, file lists, current readings). Whenever writing numbers, lists, or enumerations, phrase them so downstream can tell whether they have gone stale.
- **Refresh without bloating**: if downstream discovers that snapshot counts/lists are stale, it updates the current values directly (visible in the node's `git diff`) without writing history notes (no "was A, now B because…").
- **A green spec does not equal met intention**: if criteria no longer cover `intention.md`, the missing piece is still a delivery defect.
- **Legacy nodes**: for older nodes without `intention.md`, treat the entire `spec.md` as read-only `intention.md`.

## Optional Section: "Out of Scope / Rejected Approaches"

Include this section **only** when the discussion genuinely rejected a specific approach: one line per item — rejected approach, brief reason, and source (user decision / existing code / hard constraint).

- Do not invent entries to fill a quota, and do not list work belonging to future nodes.
- Decisions often happen by exclusion, and exclusions are the easiest details to lose across sessions; if an approach was actually ruled out, record it.

## Debt-Clearing Nodes (`method:`)

When a node clears a batch of tracked debt, **do not hand-write debt-clearing steps**:

1. Run `doctor` to see installed plugins and the **dedupe tag** and **method name** each plugin declares.
2. Add a single line `method: <method_name>` in `spec.md` (exact string from `doctor`). This tells the conductor to run that skill directly, taking precedence over `weight` (see "Method" in [`../../sw-conduct/SKILL.md`](../../sw-conduct/SKILL.md)).
3. Tag the node with **both** the metric's dedupe tag and the cycle's tag so the cycle can pick it.
4. State the scope (one metric or one batch of same-domain debt) and completion criterion (reading back under threshold, or all entries in the batch reaching a terminal state).
5. If `doctor` lists no plugin covering this debt (or the plugin is not installed), write a normal node—**never invent a method name**. Plain nodes carry no `method:` line.

## Pre-Write Checklist

- **Handoff test**: hand `intention.md` and `spec.md` to someone who was not in this conversation, with only the repo—can they produce what you would judge as "pass" without guessing? Anything they must guess (reference paths, target form, replace vs. preserve) is missing from `spec.md`; anything they can look up in the code (function names, line numbers, implementation steps) stays out.
- **Criterion alignment test**: if every done criterion in `spec.md` turns green, could the deliverable still obviously fail at a glance? If yes, the criteria are mechanical proxies—add the real comparison or check that matches how you actually judge it.
- **Basics**: `intention.md` states goals and principles, answers "why," and contains no current-state snapshots; `spec.md` has a unique landing point, no function names or implementation steps, and is sized to a cohesive deliverable unit; includes "Out of Scope / Rejected Approaches" only if approaches were rejected; includes `method:` and scope for debt-clearing nodes.

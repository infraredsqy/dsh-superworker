# conduct: node tags and cycle routing

> This is the design source for **node tags and cycle routing**: the vocabulary, the criterion of the filter, and why the filter acts on the picking step alone.
> The rest of state and advancing is in [`./conduct-state.md`](./conduct-state.md); dispatch and authentication are in
> [`./conduct-dsh-dispatch.md`](./conduct-dsh-dispatch.md); the visibility of an instruction's scope when two active
> cycles sit side by side belongs to the dispatch section of the state and advancing contract.
>
> The rule in one sentence: **a node may carry no tag at all; a cycle's `tags` are that line's pick set (used by every
> pick in its whole life); the filter acts on "pick the next node" alone.**

## 0. Why it exists

Once the graph carries copy, code and image work at the same time, "what this line is doing" is scattered across each round's pick — a person who wants a line doing copy only, or a line touching code only, has no way to say it.

A tag is that sentence: give the nodes a tag (which kind of work this is), give the cycle a filter set (which nodes this line picks among). Start a line with `--tags coding`, and from then on it picks code work only — from the first node to the last, on the same filter set.

## 1. The vocabulary

Three words, fixed: `writing` (copy), `coding` (code), `art` (image).

The vocabulary is **a convention for people to read**; the engine does not take it as a hard rule: a tag outside the vocabulary warns one line and is taken as it is — when a fourth kind of work really appears, writing it in is enough, and the warning only tells a person they are standing outside the vocabulary. The filter always compares by the letter.

## 2. Why it lands on those two places

- **A node's tag lands in the graph**, because it is part of the graph: which kind of work it belongs to is said by the graph itself, exactly like whom it depends on and what status it is in.
- **The cycle's filter set lands on that line's own record**, because it is **this line's** property: a line picking one kind of work is a fact that travels with the line, not with one pick. The start-up command hands the filter set to the picking and to the record **at the same time** — picking happens before the cycle exists, so writing the record alone would be too late and the first node would already be picked from another line's work; every pick after that reads it back from there and reuses it, so "the second pick caught something of another line" has nowhere to happen.
- **The two sides are not symmetrical.** A node's tag is optional — with none, the key does not appear in the graph at all (that is part of the regression floor). **On the line, `tags` is required**: it is more than the filter set for picking, the maintenance channel's scope is expressed through it too, and a line without it would give "who may react to a maintenance metric" a second answer.
- **The weight is computed once.** The score is still computed over the whole unfinished subgraph, and the filter set drops rows without touching the score — so "the first of the filter set" and "the first of the whole graph" use the same ranking.

## 3. The criterion of the filter

> A node is inside this cycle's pick set ⇔ it carries **no tag at all**, or its tags **intersect** the cycle's filter set.

- A node may carry several tags: a node tagged `art,writing` belongs to two lines at once, and whichever line picks it first counts.
- **A node with no tag stays inside every set.** This is the conservative direction: missing a block costs one extra node run, while blocking wrongly costs a line's work never being done — and the second cost hangs there until somebody notices. So "no tag" always means "no limit".
- When a cycle sets no filter set (only records of an older shape have such a row), the whole graph is its set.

## 4. Why the filter lands on "pick the next node" alone

The filter is a **picking rule**, and pushing it anywhere else grows its own trouble:

- **The node being run is not its business.** A cycle records it on its claim when it takes a node, and reports the node on the claim record. Even when the filter set does not match it, it runs to its end and closes as usual — changing a node already running halfway is overturning the decision made when it was claimed.
- **Dependencies change by not one word.** Being blocked and having an unmet dependency are two different things: a blocked node neither changes status nor is marked `shelved`, its dependency edges stay as they are, it is "not picked this round", and "something is wrong with it" is several steps away.

## 5. The pause when another line has ready work

While this line's filter set still has a ready node, the first one is picked as always; when the whole graph has no ready node, it stops as always; **when this line has none and the graph has ready ones that the tags merely block — it stops.**

Stopping here hands the choice back to the user: this line's work is done, and whether the other line starts and when is his to say. What the machine can compute is "this line has no work, another one has"; what it cannot compute is "whether opening the second line now is right" — that is a human sentence, and it should come from a human.

The moment it stops it gives a one-line `reason`, written for a person: it names which nodes are ready, which tags block them, and hands over a command that can be copied straight into a new cycle. Stopping turns this line `inactive` as always; the other line's work stays on the graph as it was, nothing is locked, and no node is marked dead.

## 6. The node `--node` names

A node the user names by hand follows the existing semantics: a ready one goes, a not-ready one is refused with an explanation. The filter set governs "who is picked when nobody names one", and cannot reach an id typed by hand — silently eating a name just typed hides a decision the user just made. Both roads have to say "it is not inside this line's set"; saying only "it cannot start now" makes a person think of an unmet dependency.

## 7. The empty filter set (the regression floor)

The writing side always gives `--tags`, so the empty filter set is a branch left for **records already on disk** whose cycle carries no tag:

- The filter set is empty ⇒ the whole graph is its set, and the pick, the recorded path and the shape of the record are byte for byte what they are without this feature.
- A node carries no tag ⇒ it stays inside the pick set under any filter set, and the graph gains no key.

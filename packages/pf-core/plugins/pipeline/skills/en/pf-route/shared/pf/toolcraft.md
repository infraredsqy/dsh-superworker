# pf toolcraft

> This file describes how to use the DAG management tool efficiently. Complementary to
> `philosophy.md` (the WHY), this file focuses on the HOW.

## The root principle

**`--help` first, then act.** Before calling `dag`, look at `--help` to learn every command and
option; do not work from feel or memory. The full set of commands is what `dag --help` prints;
what follows here are only the habits a help page cannot teach.

## The efficiency rules

### Merge like queries

`search` takes a regular expression, so related keywords go in one pass with `|`:

```
# bad: 5 calls
search merge
search integration
search migration
search consolidate
search main-project

# good: 1 call
search 'merge|integration|migration|consolidate|main-project'
```

In the same way, `info` / `open` / `context` cannot share one line, but lines that do not depend on
each other can go in **one message** — the tool runs them in the order you gave, one after another,
and the answers come back together. One line, then waiting for its answer before sending the next,
is where the extra round trips come from.

### One action over N records: use the word's own batch shape

Sending the same word once per record turns one write into N writes. The word surface already
carries the batch shapes; use them when they fit:

- creating nodes: `dag add --from-file <rows file>` — one node per row, a row may carry a `ref` that
  another row's `depends_on` names; the whole batch is one graph write.
- edges: `dag depend <node> --on a,b,c`, one write.
- into the pool: `issue add --from-file <rows file>`.
- changing the pool: `issue update --from-file <rows file>` — one `id` per row plus the fields it
  changes.
- closing the pool: `issue resolve <id…> --reason "<one verification reading>"`, and likewise
  `reject` / `acknowledge` / `remove`.

Rows files go in `.pf/meta/batch/` (`meta/` is kept out of the repository); delete them once the
batch has run. These words write the whole batch at once: one bad row (an unknown field, a missing
id, a bad value) refuses all of it and not a byte is written; in the `resolve` column one id that is
not in the pool refuses it the same way.

### Prefer a targeted query; list is the last resort

`list` prints every node's JSON, which is redundant information when the DAG is large and burns
context. A targeted query always comes first:

- search for a node → `search <regex>`
- look at the detail → `info <id>`
- look at the topology → `context <id>`

Use `list` only when the whole graph has to be ordered (like recommending the next step), and add
`--limit N` to control how many come back. **Do not do a targeted search with `list | grep` — that
is `search`'s job.**

### Quoting a pattern

Every pattern argument (search's regex, add's title / description) goes in double quotes, to stop
the shell from parsing special characters.

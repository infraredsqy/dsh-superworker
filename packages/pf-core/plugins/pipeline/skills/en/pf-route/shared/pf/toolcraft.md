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

In the same way, `info` / `open` / `context` cannot be merged, but **one call gets enough
information**, so avoid several round trips.

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

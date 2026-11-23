# Garbage Test Patterns

> For scan subagents to read alongside [`./compression-criteria.md`](./compression-criteria.md); the conductor does not read this file.

## Garbage patterns

| # | Pattern | Language-agnostic description | Typical examples (Catch2 / Jest / pytest) |
|---|---|---|---|
| P1 | `hardcoded-count` | Asserts a hardcoded size/count of a collection, method list, or entries | `REQUIRE(result.size() == 36)`, `expect(methods.length).toBe(10)` |
| P2 | `trivial-init` | Verifies only default initialization guaranteed by the language/framework | `REQUIRE(field == false)`, `assert(field is None)`, `expect(obj.count).toBe(0)` |
| P3 | `field-roundtrip` | Assigns a value and immediately reads it back | `x = val; REQUIRE(x == val)`, `obj.name = "foo"; assert obj.name == "foo"` |
| P4 | `enum-bound` | Pins an enum or constant to a specific integer value | `REQUIRE(static_cast<int>(Enum::A) == 0)`, `assert(Color.RED == 1)` |
| P5 | `container-op` | Tests basic add/remove/lookup operations of a standard container | `map.erase(k); REQUIRE(map.size() == 0)`, `arr.append(x); assert len(arr) == 1` |
| P6 | `trivial-error` | Tests only that bad input returns a fixed error value | `REQUIRE(func(bad) == -1)`, `assert(parse("").is_err())` |

## Deletion granularity

- Every assertion in a `TEST_CASE` (or equivalent test block) matches a garbage pattern → delete the whole block (`judgment: "entire"`).
- Some assertions are garbage and others verify real business logic → delete only the garbage lines (`judgment: "partial"`).
- All tests in a file are removed → remove that file from the build system (`CMakeLists.txt`, `Cargo.toml`, `package.json`, etc.).

## Coverage gate for deletion

Matching a garbage pattern is only half the requirement. **Before deleting, confirm the business behavior it touches is covered elsewhere**:

- Matches a garbage pattern **and** covered elsewhere → eligible for deletion.
- Matches a garbage pattern, but is the **only** coverage of that behavior → keep it and note this in the report.
- Uncertain whether coverage exists elsewhere → flag the behavior for the conductor and **keep it**.

Search for coverage explicitly (neighboring cases in the same file, sibling module tests, indirect coverage in end-to-end tests)—never guess.

## Safety exceptions

The following are **not** garbage tests and must not be deleted:

- Verifying a field is explicitly initialized to a non-zero/non-empty value required by business logic (distinct from language defaults)
- Verifying boundary behavior (e.g., querying an empty collection does not crash, negative indices are clamped)
- Verifying serialization roundtrips (serialize then deserialize and check field equality)
- Verifying state-machine transition validity

## Return field (`quality` object)

Merged with [`./compression-criteria.md`](./compression-criteria.md) into a single JSON response. Each finding's `quality` object uses this shape (see `compression-criteria.md` for the full merged schema):

```json
"quality": {
  "type": "enum-bound",
  "line_start": 15,
  "line_end": 22,
  "judgment": "entire"
}
```

- `judgment`: `entire` (whole block is garbage) / `partial` (mixed; remove garbage lines only) / `none` (verifies real behavior)

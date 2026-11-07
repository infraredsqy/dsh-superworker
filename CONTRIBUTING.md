# Contributing

Pull requests are welcome. Only the maintainer writes to this repository directly, so a change
lands by review, and an answer may take a while.

## What a patch has to clear

- **Read [docs/design-principles.md](docs/design-principles.md) before touching the UI** — that is
  this repo's law. The panel's own sheets live in `src/client/styles/`; every selector already
  carries its layer class, and a selector that escaped its layer is a failure, not a style choice.
- **The package face.** The manifest's `files`, `exports`, `bin` and `engines`, together with the
  `prepack` chain that builds the engine product the command carries, are what the install route
  depends on; `tests/package-surface.test.mjs` holds them, and the browser half's built artifact is
  held by `tests/client-render.test.mjs`.
- **A new behaviour needs a case, not a pin on the copy.** The wording and the layout move too often
  to hold in a test; the readings that need a real `.superworker/` are walked by hand on the list in
  [docs/publish.md](docs/publish.md).

## Commits

`<type>: <description>` -- English, present tense, lowercase, no period. The types in use: `feat`,
`fix`, `docs`, `refactor`, `style`, `test`, `chore`, `perf`, `build`.

## The contract docs

`docs/` carries the rules this repo runs under, and it is Chinese; the README pair is English and
Chinese.

# Publishing and Installation

> This document defines the **public package contract**, **installation routes**, **release policy**,
> **pre-release verification pass**, and **known constraints** for `dsh-superworker`.
>
> - **No version numbers**: neither this package's version nor specific DSH versions are copied here.
> - **No duplicate inventories**: exact `files`, plugin skill lists, and merge-driver command strings
>   live in `package.json`, each `plugin.json`, and
>   [packages/superworker-core/docs/merge.md](../packages/superworker-core/docs/merge.md).
> - **Public contract vs. maintainer automation**: this document states *what* must hold and *why*;
>   maintainer-side release choreography and local environment workarounds live in local automation,
>   not here.

## Delivery Model & Package Surface

End users never run build steps. All shipped artifacts are prebuilt once in this repository through a
single authoritative chain in `package.json`: `build:products` (engine build -> types -> host half ->
browser half). Both `prepack` and `npm test` invoke `build:products`.

```sh
pnpm install --frozen-lockfile
npm run build:products
```

The package manifest (`files`) ships only what runtime and downstream tooling require: both runtime
entries, `lib/types/**/*.d.ts`, `locale/*.json`, `cordis.patch.yml`, the built engine artifacts under
`packages/superworker-core/dist/**/*`, and the full plugin trees under
`packages/superworker-core/plugins/**/*`. Plugin folders ship whole so bundled skills stay paired
with their sibling reference files and match the exact engine build. Intermediate client build
artifacts (such as `lib/client-body.js`) are removed after bundling and never enter the tarball.

### Runtime Entrypoints

| Export | Target | Consumer |
|---|---|---|
| `.` (`main`) | `lib/host/index.js` | Host half: registers `ctx.superworker` and exposes gateway endpoints |
| `./client` | `lib/client.js` | Browser half (`dsh.client.platform: "web"`): loaded by the DSH web shell |
| `./locale/*.json` | `locale/{zh,en}.json` | DSH plugin inventory metadata (separate from the panel's internal locale bundle) |

### Key Manifest Invariants

All structural invariants below are enforced by `tests/package-surface.test.mjs` (`npm test`):

- **Profile mount (`dsh.bundle.patch`)**: points to `./cordis.patch.yml` (an `insert` entry with id
  `superworker`). `dsh plugin add` merges this layer into the profile's `dsh.profile.bundles`, and a
  profile's own `cordis.patch.yml` can still disable or override it by id.
- **Client load dependencies (`dsh.client.inject`)**: declares both
  `@deepseek-ai/dsh-client-connection` and `@deepseek-ai/dsh-client-locale`. **Neither may be
  removed**: without `connection`, the panel mounts before the data seam is ready and cannot read
  records (even while host endpoints work); without `locale`, the panel still renders with its
  built-in fallback language, but stops following DSH's locale setting.
- **Host compatibility (`engines.dsh`)**: the lower bound sits at the DSH version that introduced
  per-step conditional tool visibility; the upper bound tracks DSH's breaking line as `<0.3.0-0`
  rather than pinning an individual rc. The trailing `-0` is intentional: DSH evaluates ranges with
  `semver.satisfies(runtime, range, { includePrerelease: true })`, so `<0.3.0` alone would mistakenly
  admit `0.3.0-alpha.1`.
- **No CLI binary; one spawned helper**: `package.json` declares no `bin` entry. Both agent tool
  calls and panel actions execute in-process through the engine's `answer()` layer. The only file
  spawned as a child process is the git merge driver at
  `<install-dir>/packages/superworker-core/dist/merge-ledger.mjs`; its registration, arguments, and
  exit codes are specified in
  [packages/superworker-core/docs/merge.md](../packages/superworker-core/docs/merge.md).

## Packing Locally

```sh
npm pack --pack-destination .tmp/pack
```

`npm pack` requires no authentication and leaves the repository clean (`.tmp/` is gitignored).
Inspect tarball contents with `tar -tzf <path>` (on Windows with GNU tar, pass `--force-local`
before short flags when using drive-letter paths).

`npm pack` normalizes archive mtimes so identical inputs produce a stable SHA-256 hash. Note that
incremental `tsc -b` does not remove stale `.d.ts` files left by deleted sources — delete `lib/` and
re-pack before comparing a local tarball's hash against a clean CI build.

## Installation Routes

All routes go through DSH's plugin installer (`dsh plugin --profile <name> add <target>`):

### 1. From npm (recommended)

```sh
dsh plugin --profile <name> add dsh-superworker
```

`package.json` sets `publishConfig.tag` to `latest` so prerelease versions (which npm refuses to
publish without an explicit dist-tag) still resolve cleanly from the bare package name and transition
naturally when stable versions ship.

### 2. From a GitHub Release tarball (offline / fallback)

Download the `.tgz` attached to the GitHub Release and install it directly:

```sh
dsh plugin --profile <name> add ./dsh-superworker-<version>.tgz
```

This installs the exact same prebuilt artifact as npm and runs no build scripts.

### 3. From git (contributors / development)

```sh
dsh plugin --profile <name> add github:<owner>/<repo>
```

A git checkout contains source only, and pnpm >=10 blocks dependency build scripts by default. The
first `add` fails and prints the key to authorize in that profile's `pnpm-workspace.yaml`:

```yaml
allowBuilds:
  dsh-superworker: true
```

Authorizing `allowBuilds` permits code execution during install — only enable it for trusted sources
and pin a specific commit. Because this repo wires its build into `prepack` rather than `prepare`, a
git install also requires either prebuilt artifacts or a self-contained `prepare` script.

## Verifying and Removing an Install

```sh
dsh --profile <name> --dump-config                  # print merged config tree without booting
dsh plugin --profile <name> remove dsh-superworker  # uninstall plugin and remove its bundle layer
```

In `--dump-config`, locate the `# == dsh-superworker` section: its first top-level entry is
`- id: superworker`, pointing to this package with both host and client artifacts present on disk.

Config layer precedence is: profile `dsh.profile.bundles` (in manifest order) -> profile
`cordis.patch.yml` -> `$DSH_HOME/cordis.patch.yml` -> CLI `--patch` flags. Later layers override
earlier ones by entry `id`, replacing the entry's entire `config` object rather than merging keys.

**Bundled skills**: when the plugin loads, it installs its bundled plugin skills into
`$DSH_HOME/skills/<skill>/SKILL.md` (falling back to `~/.dsh` when `DSH_HOME` is unset) and records
ownership in `$DSH_HOME/superworker/skills.json`. Upgrades remove previously tracked skills before
writing the new set; uninstalling cleans up tracked skills without touching third-party skills. If a
foreign skill already occupies the same name under `$DSH_HOME/skills`, installation refuses to
overwrite it — naming both paths in the diagnostic — while the panel itself continues loading
normally.

## Release Policy & OIDC Publishing

> **Explicit maintainer approval is required before every release.** Being able to publish is not
> permission to publish. Never cut a release just to test CI or OIDC configuration; verify config
> changes on the next genuine release. Changes that do not affect the shipped package (`docs/`,
> comments, tests, CI config) are not a reason to release.

Releases use **npm OIDC Trusted Publishing** via `.github/workflows/publish.yml`:

- **Triggers**: pushing a `v*` tag (from the release branch) or manual `workflow_dispatch`.
- **Permissions**: strictly `id-token: write` and `contents: read`. **Never add long-lived npm
  tokens or secrets to the workflow** — eliminating stored credentials is the entire point of OIDC.
- **CI build**: the workflow runs `npm test` and `node tools/css-check.mjs` on Linux before
  `npm publish` (which runs `prepack` -> `build:products` in a clean environment).

### Post-Release Verification Criteria

Do not stop at a zero exit code from `git push`. Every release is complete only when all of the
following are verified:

1. **Workflow succeeded on CI**: the triggered `publish.yml` run passes both `npm test` and
   `node tools/css-check.mjs` on the Linux runner.
2. **OIDC authentication succeeded**: if CI fails with `ENEEDAUTH`, verify that the npmjs.com Trusted
   Publisher entry matches `package.json`'s `repository.url` and workflow filename verbatim, and
   explicitly permits `npm publish` (not just `npm stage publish`). Note that a newly created,
   unverified Trusted Publisher configuration expires after 48 hours if unused.
3. **Registry metadata matches**: the new version appears on `https://registry.npmjs.org` (npm may
   briefly return 404 while processing — wait and retry rather than re-publishing), `dist-tags.latest`
   points to it, and `dist.shasum` matches the CI publish log.
4. **Provenance attestation is present**: the published version carries npm provenance attestation
   (generated automatically for public repos + public packages published via OIDC).

## Pre-Release Verification

### Automated Checks

Run all three before cutting a release:

- `npm test` — builds all artifacts and runs both the plugin and engine unit suites (including
  rendering the browser half against in-memory records with zero console errors).
- `node tools/css-check.mjs` — validates stylesheet scoping, token usage, and theme contrast floors.
- `tools/testbed/testbed.ps1` (`up` / `check` / `down`) — boots an isolated DSH instance and verifies
  installation, startup manifest registration, and host gateway responses.

**Always verify the packed `.tgz`, not just a linked checkout**: pack with
`npm pack --pack-destination .tmp/pack` and pass `-Plugin <.tgz>` to `testbed.ps1 up`. Without
`-Plugin`, the testbed links the working directory directly instead of testing the packaged artifact.

### Manual UI Pass

Unit tests deliberately avoid pinning panel copy and fine-grained layout because they iterate
frequently; the real-record visual checks below are verified by hand in a profile pointed at a
workspace with a live `.superworker/` record (this repository has one):

- **Live record across all views**: every view renders cleanly — Overview windows and rows, Map/Graph
  cards and edges, Issue Pool readings, and Instructions scopes (global and per-line only; no
  per-node option in the scope selector).
- **Overview summary bar**: footer counts (`waiting` / `running` / `ready`) match the detail
  segments, update when switching scopes, and omit empty segments rather than printing zeros.
- **Overview windows**: primary nameplate extends cleanly to the left without clipping; child window
  titles stay on one line inside the frame; overflowing rows fade at the top with no scrollbar; all
  four animations fire at the right moments (window enter, window exit, new row arrival, waiting
  border pulse).
- **No-record workspace**: with neither current nor legacy record directories present, the panel
  states there is no record and renders no views.
- **Unreadable record**: with `.superworker/` present but files unreadable, the panel reports that
  the record cannot be read.
- **Partial workspace**: with only an issue pool or only a pipeline present, the absent view
  collapses to a single-line notice.
- **Interactive actions**: switch map layouts, change scope, pan and zoom the graph, cycle through
  all tabs, switch locale, add/archive/delete an instruction, and modify a setting to confirm disk
  persistence.
- **Overview Full / Compact toggle**: switching to Compact collapses each window to one row per step
  with active-step phrasing and a title no smaller than its step rows; the selection survives
  toggling back and reloading the page (persisted as `overviewMode`, not duplicated on the Settings
  view).

## Known Constraints

- **Official registry required for publishing**: if a local `~/.npmrc` points at a read-only mirror,
  any direct npm registry query or manual publish must pass `--registry=https://registry.npmjs.org`.
- **No bypass-2FA token automation**: direct publishing via bypass-2FA tokens is being phased out in
  favor of OIDC trusted publishing and staged 2FA approval. All automated releases must use OIDC.
- **No package-manager cache in CI**: `publish.yml` sets `package-manager-cache: false` to follow
  official clean release-build guidance.
- **Manual GitHub Release attachment**: uploading the `.tgz` from `npm pack` to a GitHub Release is a
  separate manual step alongside the npm release.
- **`engines.dsh` compatibility gates**: hosts outside the declared range receive
  `incompatible-version` along with an opt-in `allow-version` command stored in the profile's
  `compatibility.json` (exemptions do not carry across plugin or DSH upgrades).
- **Git installs require script opt-in**: installing from git requires `allowBuilds` in the profile;
  prefer the prebuilt npm or `.tgz` routes.
- **Per-workspace skills shadow plugin skills**: `<project>/.dsh/skills` and
  `<project>/.agents/skills` take precedence over `$DSH_HOME/skills`. When shadowed, the host logs a
  diagnostic line without modifying files on disk.

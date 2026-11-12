# dsh-superworker

English | [中文](README.zh.md)

`dsh-superworker` is a [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin
that renders a `.superworker/` pipeline record as a panel in the DSH Web UI.

The host half reads the record (`.superworker/`) of the current session's workspace and serves it behind a
gateway; the browser half draws it as the **Superworker** panel in the sidebar. Everything on screen —
instructions, node details, the map of who owes whom, the issue pool — comes from that record, and
writes from the panel go back to the same place.

In a session the pipeline is also reachable as the agent-facing `superworker` tool: it answers the
pipeline's words in place. The tool is registered once for the whole host, and the registry asks one
condition on every step, so a session whose workspace holds a `.superworker/` record sees the tool
from its first request, and carries the instructions in force into every step as runtime context —
the same text `instruction list` prints for that workspace, which for a git worktree is its main
tree's listing. Anywhere else the tool appears when one of the `sw-*` skills is loaded, or when a
user invokes one: an `/sw-*` invocation is seen before that step is sent, so the request carrying
the skill's instructions already carries the tool. Until then that session's request header stays
exactly as it would be without this plugin. The record is read on every step, not once: a workspace
that gains one mid-session carries the tool from the next step, and a session that leaves the
workspace stops carrying it.

## Status

Early, and tied to the DSH developer preview. The manifest declares an `engines.dsh` range, and DSH
refuses to install or boot the plugin outside that range (`incompatible-version`, with an opt-in
exemption command). The range follows DSH's breaking line and starts where this line's own mechanism
does: **0.2.2** is the first DSH whose tool registry asks a registration whether a given step should
see it, and that answer is what keeps the tool out of every session without a pipeline. An older
host honors no condition at all, so the tool would simply never appear there — those hosts are
refused up front. Inside 0.2.x any later rc is admitted, and the range moves when DSH moves to 0.3.

The `.superworker/` record it draws is at the same stage: still being worked out, with plenty left
to refine, and it will keep moving as the design settles. Each change follows what running a real
pipeline teaches, so the shape converges on what a pipeline actually needs — and feedback from a
live pipeline is what steers the next one.

## Install

Prerequisites: a DSH install with a profile to install into, and a workspace that holds a `.superworker/`
pipeline record. The panel's writes are answered in place by its host half (the engine's own words
layer), so there is no command to install and no `PATH` entry to arrange. The panel
reads the workspace of the session you have selected; with no session selected it says so.

Download the `.tgz` from this repo's [Releases](https://github.com/infraredsqy/dsh-superworker/releases)
and point DSH at the file:

```sh
dsh plugin --profile <name> add ./dsh-superworker-<version>.tgz
dsh plugin --profile <name> add dsh-superworker                  # the same artifact, by name (npm)
```

The package ships prebuilt — installing runs no build steps. pnpm may print a few `missing peer`
warnings: those packages are provided by DSH itself and resolve at runtime, so the warnings can be
ignored. The version policy and the third route (installing from git) live in
[docs/publish.md](docs/publish.md).

## What you get

- a **Superworker** entry in the Web UI sidebar: views over the record — the map, details,
  instructions, the issue pool, and the panel's own settings
- a **Superworker settings** section in the DSH settings: whether archived instructions show,
  whether closed issues show, whether a settled line opens its next round by itself, and whether the
  instructions in force are carried into the session context
- to verify an install: `dsh --profile <name> --dump-config`, and look for the
  `# == dsh-superworker` section

## Development

```sh
pnpm install --frozen-lockfile
npm test                  # unit tests: builds both products, then runs both suites
node tools/css-check.mjs  # the style-layer rules
npm pack                  # the distributable
```

`npm test` builds both products and runs both suites, the plugin's and the engine package's. What
each file pins, and what is walked by hand instead, is in [tests/AGENTS.md](tests/AGENTS.md);
[docs/publish.md](docs/publish.md) carries the hand pass, and `tools/testbed/` boots an isolated
DSH instance for it.

The repository map and ground rules live in [AGENTS.md](AGENTS.md). Read
[docs/design-principles.md](docs/design-principles.md) before touching the UI, and
[docs/publish.md](docs/publish.md) before shipping a version.

## Contact

Support for running this in your own pipeline, feedback on how it went, and commercial questions
go to [infraredsaw@gmail.com](mailto:infraredsaw@gmail.com). Bugs and feature requests are better
filed as [issues](https://github.com/infraredsqy/dsh-superworker/issues) — that way the next person
who hits the same wall finds them.

## License

[MIT](LICENSE)

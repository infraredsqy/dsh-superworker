# Security

## Reporting

Use GitHub's private advisory form:

https://github.com/infraredsqy/dsh-superworker/security/advisories/new

Please do not open a public issue for anything exploitable.

## What to send

`dsh --version`, the profile's `--dump-config` output around the `# == dsh-superworker` section, and
what you did in the panel. One report per problem is enough.

## In scope

- `src/host/` — the host half reads the workspace's `.superworker/` and serves it behind a gateway; the panel's
  writes are answered there through the engine's words layer, with no command spawned
- `src/client/` — the browser half, and what it draws from that data
- `lib/host/index.js`, `lib/client.js` — the artifacts the package ships, built from `src/`
- `cordis.patch.yml` — the line this package mounts into a profile
- `tools/testbed/` — it boots an isolated DSH instance on the loopback interface

## Out of scope

- DSH itself: that is the DeepSeek Harness project's report.
- A record you control anyway: the panel writes into your workspace's `.superworker/` through the engine's
  words layer, and hand-editing that is yours to do.

## Supported versions

The current `main`. Fixes land as commits, not as backports.

## Disclosure

You get an answer as soon as one is possible, with no promised timeline. Credit unless you ask
otherwise.
# Security

## Reporting

Use GitHub's private advisory form:

https://github.com/infraredsqy/dsh-pathfinder/security/advisories/new

Please do not open a public issue for anything exploitable.

## What to send

`dsh --version`, the profile's `--dump-config` output around the `# == dsh-pathfinder` section, and
what you did in the panel. One report per problem is enough.

## In scope

- `src/host/` — the host half reads the workspace's `.pf/` and serves it behind a gateway; the write
  side runs `pf` with an argv built from what the panel sent
- `src/client/` — the browser half, and what it draws from that data
- `lib/host/index.js`, `lib/client.js` — the artifacts the package ships, built from `src/`
- `cordis.patch.yml` — the line this package mounts into a profile
- `tools/testbed/` — it boots an isolated DSH instance on the loopback interface

## Out of scope

- DSH itself: that is the DeepSeek Harness project's report.
- A record you control anyway: the panel writes into your workspace's `.pf/` through `pf`, and
  hand-editing that is yours to do.

## Supported versions

The current `main`. Fixes land as commits, not as backports.

## Disclosure

You get an answer as soon as one is possible, with no promised timeline. Credit unless you ask
otherwise.
/* The DSH skill catalog the placement tests read through, shaped to the two rules this fix turns on.
 *
 * `@deepseek-ai/dsh-skill` merges layers — the global layer plus the viewing scope's chain, the
 * nearest layer winning a duplicate name outright, rank deciding duplicates only *inside* one layer.
 * `@deepseek-ai/dsh-skill-filesystem` scans roots at fixed ranks, and puts the project roots in the
 * scan only when the lookup names a `cwd`:
 *
 *   <project>/.dsh/skills 100 · <project>/.agents/skills 200 · custom 300 ·
 *   <dshHome>/skills 400 · <agentsHome>/skills 500
 *
 * Both stand-ins read real directories, so "the install's own read-back" and "what a session sees"
 * are two different reads of the same disk rather than one view pretending to be both. The ranks and
 * sources are the provider's own; `tests/host-skills.test.mjs` holds the two views separately. The
 * probe readings the ranks were first taken from live in this machine's pipeline record
 * (`.superworker/nodes/<uuid>/temp/`), which is not part of the repository — the rules above are what this
 * file carries, and nothing here reads that record.
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

/** The filesystem provider's own root ranks. */
export const RANKS = {
  'project-dsh': 100,
  'project-agents': 200,
  custom: 300,
  'user-dsh': 400,
  'user-agents': 500,
}

/** The scope key a preset-mounting provider registers under. Opaque identity, like the real layer key. */
export const PRESET_SCOPE = Object.freeze({ kind: 'preset' })

/** A `SKILL.md`'s frontmatter cells, as far as naming a skill goes; `undefined` when it is not one. */
function frontmatterOf(file) {
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return undefined
  }
  const lines = text.replace(/^\uFEFF/u, '').split('\n')
  if ((lines[0] ?? '').trim() !== '---') return undefined
  let closing = -1
  for (let index = 1; index < lines.length; index++) {
    if ((lines[index] ?? '').trim() === '---') {
      closing = index
      break
    }
  }
  if (closing < 0) return undefined
  const cells = {}
  for (const line of lines.slice(1, closing)) {
    if (line.trim() === '' || line.trimStart() !== line) continue
    const sep = line.indexOf(':')
    if (sep <= 0) continue
    cells[line.slice(0, sep).trim()] = line.slice(sep + 1).trim().replace(/^(['"])(.*)\1$/u, '$2')
  }
  if (cells.name === undefined || cells.description === undefined) return undefined
  return cells
}

/**
 * The local filesystem provider's own `list({ cwd })`: a directory bundle is `<root>/<name>/SKILL.md`,
 * a flat one is `<root>/<name>.md`, and a root that does not exist contributes nothing.
 */
export function fakeFileSystemProvider({ dshHome, agentsHome, customSkillDirs = [], provider = 'filesystem' } = {}) {
  const roots = (cwd) => {
    const out = []
    if (cwd !== undefined) {
      out.push({ path: join(cwd, '.dsh', 'skills'), source: 'project-dsh', rank: RANKS['project-dsh'] })
      out.push({ path: join(cwd, '.agents', 'skills'), source: 'project-agents', rank: RANKS['project-agents'] })
    }
    for (const dir of customSkillDirs) out.push({ path: dir, source: 'custom', rank: RANKS.custom })
    out.push({ path: join(dshHome, 'skills'), source: 'user-dsh', rank: RANKS['user-dsh'] })
    out.push({ path: join(agentsHome, 'skills'), source: 'user-agents', rank: RANKS['user-agents'] })
    return out
  }
  async function list(options = {}) {
    const out = []
    for (const root of roots(options.cwd)) {
      let entries
      try {
        entries = readdirSync(root.path, { withFileTypes: true })
      } catch {
        continue
      }
      for (const entry of [...entries].sort((left, right) => left.name.localeCompare(right.name))) {
        const locator = entry.isDirectory()
          ? join(root.path, entry.name, 'SKILL.md')
          : entry.isFile() && entry.name.toLowerCase().endsWith('.md')
            ? join(root.path, entry.name)
            : undefined
        if (locator === undefined) continue
        const cells = frontmatterOf(locator)
        if (cells === undefined) continue
        out.push({
          name: cells.name,
          description: cells.description,
          provider,
          source: root.source,
          rank: root.rank,
          path: locator,
        })
      }
    }
    return out
  }
  return { name: provider, list, roots }
}

/**
 * The registry's layer merge: `list({ cwd, scope })` merges the global layer with the viewing
 * scope's chain, the nearest layer winning a duplicate name outright; inside one layer rank, then
 * provider order, then the provider's own order decide. `mounts` is where each provider lives:
 * `{ layer: 'global' | 'preset', scope?, provider }`.
 */
export function fakeSkillRegistry({ mounts = [] } = {}) {
  const globalProviders = []
  const scoped = new Map()
  for (const mount of mounts) {
    if (mount.layer === 'global') {
      globalProviders.push(mount.provider)
      continue
    }
    const held = scoped.get(mount.scope) ?? []
    held.push(mount.provider)
    scoped.set(mount.scope, held)
  }

  /** One layer's winners: candidates sorted by rank, provider order, then the provider's own order. */
  async function winnersOf(providers, options) {
    const candidates = []
    for (const [order, provider] of providers.entries()) {
      const listed = await provider.list(options)
      for (const [local, candidate] of listed.entries()) candidates.push({ ...candidate, order, local })
    }
    candidates.sort((left, right) => left.rank - right.rank || left.order - right.order || left.local - right.local)
    const winners = new Map()
    for (const candidate of candidates) if (!winners.has(candidate.name)) winners.set(candidate.name, candidate)
    return winners
  }

  async function list(options = {}) {
    const chain = options.scope === undefined ? [] : [options.scope]
    const merged = new Map()
    /* Farthest layer first, nearest last: a nearer layer's entry overwrites a farther one outright. */
    for (const providers of [globalProviders, ...chain.map((key) => scoped.get(key) ?? [])]) {
      for (const [name, winner] of await winnersOf(providers, options)) merged.set(name, winner)
    }
    return [...merged.values()].sort((left, right) => left.name.localeCompare(right.name))
  }

  return { list, mounts: { globalProviders, scoped } }
}
/**
 * Reading the placed skills back through a catalog view — the read a session's own catalog does — as
 * a diagnostic, never as the judgement's verdict.
 *
 * The view is `list({ cwd, scope })`, never a bare `list()`: the provider that scans the skill root
 * is mounted in the session's own layer chain, and project roots only enter the scan when a `cwd` is
 * given. A read that names neither sees a different catalog, so it cannot stand as a reading of the
 * session's catalog at all. For every placed name, the winning entry is compared with the file this
 * line placed; a winner elsewhere — a project root's copy at rank 100/200 above this root's 400, or
 * another layer's — comes back as `skill-shadowed` naming both places. That code is what the
 * diagnostic saw, not a refusal: nothing on disk changes and no session fails.
 *
 * Placing happens when the line loads, before any session exists, so this half can honestly hand back
 * only *placed* (the root and the manifest), never "the catalog shows it". This module is the second
 * reading, taken where a workspace is known, and it is left as one logger line. It does not decide
 * the completion judgement — that reading is the session's own catalog, taken over the old
 * hand-copied copies under `<agentsHome>/skills` (rank 500, below this root's 400). A same-name copy
 * in a project root (rank 100/200) is DSH's own per-workspace override and lies outside this node's
 * judgement: the diagnostic notes it, and stops there.
 */
import { join, resolve, sep } from 'node:path'
import { PLUGIN_SKILL_FILE } from 'superworker-core'
import type { SkillViewOutcome } from '../failure.ts'
import { logLineOf, messageOf, type SkillHostContext, type SkillSummaryReading } from '../seams.ts'
import { dshHomeOf, skillRootOf } from '../skill-paths.ts'
import { placedSkills, refused } from './manifest.ts'

/** The view the diagnostic is read through: the session's cwd, and the scope whose layers that session sees. */
export interface SkillView {
  readonly cwd?: string | undefined
  readonly scope?: unknown
}

/** The one option the diagnostic takes: which DSH home's placement is read back. */
export interface SkillsHomeOptions {
  readonly dshHome?: string
}

/** True when `path` resolves inside `root` — the test that a winning catalog entry is the copy this line placed. */
function within(root: string, path: string | undefined): boolean {
  if (path === undefined) return false
  const base = resolve(root)
  const full = resolve(path)
  return full === base || full.startsWith(base.endsWith(sep) ? base : `${base}${sep}`)
}

/**
 * Read the placed skills back through a catalog view, as a diagnostic.
 *
 * An empty placement reports nothing and claims nothing.
 */
export async function confirmSkillsInView(
  host: SkillHostContext,
  view: SkillView = {},
  options: SkillsHomeOptions = {},
): Promise<SkillViewOutcome> {
  const dshHome = options.dshHome ?? dshHomeOf()
  const root = skillRootOf(dshHome)
  const held = placedSkills(dshHome)
  if (!held.ok) return held
  const placed = held.manifest.skills
  if (placed.length === 0) return { ok: true, names: [] }

  const skills = host.skills
  if (skills === undefined) {
    return refused(
      'no-skill-registry',
      `this line placed ${placed.length} skill(s) under ${root}, but the host exposes no skills service, ` +
        'so the catalog a session reads cannot be read back',
    )
  }
  let catalog: readonly SkillSummaryReading[]
  try {
    catalog = await skills.list({ cwd: view.cwd, scope: view.scope })
  } catch (error) {
    return refused('catalog-unreadable', `the skill catalog could not be read: ${messageOf(error)}`)
  }

  const shadowed: string[] = []
  for (const one of placed) {
    const ours = join(root, one.dir, PLUGIN_SKILL_FILE)
    const winner = catalog.find((entry) => entry.name === one.name)
    if (winner === undefined) {
      shadowed.push(`${one.name}: placed at ${ours}, but the catalog read for this view lists no such skill`)
      continue
    }
    if (within(root, winner.path)) continue
    shadowed.push(
      `${one.name}: this line placed ${ours}, but the catalog's winning entry comes from provider ` +
        `${JSON.stringify(winner.provider)} (source ${JSON.stringify(winner.source)}` +
        `${winner.path === undefined ? '' : ` at ${winner.path}`})`,
    )
  }
  if (shadowed.length > 0) return refused('skill-shadowed', shadowed.join('\n'))
  return { ok: true, names: placed.map((skill) => skill.name) }
}

/** Run the session-view diagnostic with this workspace's cwd and the session's own scope, handing back a code instead of throwing. */
export async function confirmSkillsForWorkspace(
  host: SkillHostContext,
  cwd: string,
  scope: unknown,
): Promise<SkillViewOutcome> {
  try {
    return await confirmSkillsInView(host, { cwd, scope })
  } catch (error) {
    return refused('catalog-unreadable', `the skill catalog could not be read: ${messageOf(error)}`)
  }
}

/**
 * Report one session-view read as a single logger line: the shadowed names with both places, or a
 * plain note that the placed names are the winners in this view.
 *
 * This line is a diagnostic, not an acceptance reading: the completion judgement is answered by the
 * session's own catalog, not by anything this line can see, and nothing here can fail a session. A
 * shadowed skill is not an install failure either — the copy is on disk, and a project root's
 * same-name copy is DSH's own per-workspace override, outside this node's judgement. The line exists
 * so that a shadowed placement is not silent: whoever reads the host's log sees both places.
 */
export function reportSkillView(host: SkillHostContext, outcome: SkillViewOutcome): void {
  if (outcome.ok) {
    if (outcome.names.length === 0) return
    logLineOf(
      host,
      'info',
      `plugin skills checked — ${outcome.names.length} skill(s) win their names in this workspace's catalog (diagnostic only)`,
    )
    return
  }
  logLineOf(
    host,
    'warn',
    `plugin skills shadowed in this workspace's catalog (diagnostic only) — ${outcome.code}: ${outcome.detail}`,
  )
}

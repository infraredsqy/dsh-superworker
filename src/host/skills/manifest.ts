/**
 * The placement record: what this line wrote into a skill root, read back, replaced, and taken back.
 *
 * The manifest is the only thing unloading touches. Every file the placement writes is recorded
 * (`<dshHome>/pathfinder/skills.json`, outside the skill root so the provider never scans it), so an
 * unload removes exactly those files: not a directory holding somebody else's file, not the old
 * hand-copied copies, not another root's skills. A second install replaces what the previous manifest
 * recorded, so an upgrade leaves no earlier version behind.
 *
 * A missing manifest is an empty placement, not a fault — a host that never saw this line has nothing
 * of ours anywhere. A manifest that exists but cannot be trusted is a refusal: overwriting a root
 * whose contents we cannot read, or taking back files we cannot enumerate, is how somebody else's
 * skill gets deleted.
 */
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute } from 'node:path'
import type { PfSkillRefusal, PfSkillRefusalCode } from '../failure.ts'
import { messageOf } from '../seams.ts'
import { dshHomeOf, MANIFEST_VERSION, manifestPathOf, skillRootOf } from '../skill-paths.ts'
import { SKILL_NAME } from './frontmatter.ts'

/** One skill this line placed: the directory it occupies and every file, both relative to the skill root. */
export interface PlacedSkill {
  readonly name: string
  readonly dir: string
  readonly files: readonly string[]
}

/** The record of one placement: what the next load replaces, and what unloading takes back. */
export interface SkillsManifest {
  readonly version: number
  readonly root: string
  readonly skills: readonly PlacedSkill[]
}

/** Reading the placement record: what is there, or why it cannot be trusted. */
export type ManifestReading =
  | { readonly ok: true; readonly manifest: SkillsManifest }
  | PfSkillRefusal

/** Whether one filesystem refusal says the path is simply not there — nothing to read, nothing to take back. */
export function absent(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error.code === 'ENOENT' || error.code === 'ENOTDIR')
  )
}

/** One refusal of this layer's own: a code, and the names this half does not own. */
export function refused(code: PfSkillRefusalCode, detail: string): PfSkillRefusal {
  return { ok: false, code, detail }
}

/** A path recorded in the manifest may only point inside the skill root: no absolute path, no `..`. */
function safeRelative(path: string): boolean {
  if (path.length === 0 || isAbsolute(path)) return false
  const segments = path.split(/[\\/]+/u)
  return segments.every((segment) => segment.length > 0 && segment !== '.' && segment !== '..')
}

/** Validate a parsed manifest against this host's skill root; anything doubtful is a refusal, never a guess. */
function manifestOf(raw: unknown, file: string, root: string): ManifestReading {
  const bad = (why: string): ManifestReading =>
    refused('manifest-unreadable', `${file}: ${why} (nothing was overwritten or taken back)`)
  if (raw === null || typeof raw !== 'object') return bad('not a JSON object')
  const held = raw as { version?: unknown; root?: unknown; skills?: unknown }
  if (held.version !== MANIFEST_VERSION) return bad(`version ${JSON.stringify(held.version)} is not ${MANIFEST_VERSION}`)
  if (held.root !== root) {
    return bad(`it records the skill root ${JSON.stringify(held.root)}, but this host's is ${JSON.stringify(root)}`)
  }
  if (!Array.isArray(held.skills)) return bad('it has no skills array')
  const skills: PlacedSkill[] = []
  for (const entry of held.skills) {
    if (entry === null || typeof entry !== 'object') return bad('a skills entry is not an object')
    const one = entry as { name?: unknown; dir?: unknown; files?: unknown }
    if (typeof one.name !== 'string' || !SKILL_NAME.test(one.name)) {
      return bad(`a skills entry does not carry a skill name: ${JSON.stringify(one.name)}`)
    }
    if (one.dir !== one.name) return bad(`skill ${JSON.stringify(one.name)} records the directory ${JSON.stringify(one.dir)}`)
    if (!Array.isArray(one.files) || one.files.length === 0) {
      return bad(`skill ${JSON.stringify(one.name)} records no file`)
    }
    const files: string[] = []
    for (const item of one.files) {
      if (typeof item !== 'string' || !safeRelative(item)) {
        return bad(`skill ${JSON.stringify(one.name)} records an unsafe file ${JSON.stringify(item)}`)
      }
      files.push(item)
    }
    skills.push({ name: one.name, dir: one.name, files })
  }
  return { ok: true, manifest: { version: MANIFEST_VERSION, root, skills } }
}

/**
 * What this line placed before, read back: the skills an upgrade replaces and an unload takes back.
 *
 * A missing manifest is an empty placement, not a fault — a host that never saw this line has nothing
 * of ours anywhere. A manifest that exists but cannot be trusted is a refusal: overwriting a root
 * whose contents we cannot read, or taking back files we cannot enumerate, is how somebody else's
 * skill gets deleted.
 */
export function placedSkills(dshHome: string = dshHomeOf()): ManifestReading {
  const file = manifestPathOf(dshHome)
  const root = skillRootOf(dshHome)
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch (error) {
    if (absent(error)) return { ok: true, manifest: { version: MANIFEST_VERSION, root, skills: [] } }
    return refused('manifest-unreadable', `${file}: ${messageOf(error)} (nothing was overwritten or taken back)`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    return refused('manifest-unreadable', `${file}: ${messageOf(error)} (nothing was overwritten or taken back)`)
  }
  return manifestOf(parsed, file, root)
}

/** Write the manifest the next load reads and the unload follows, by way of a rename so a half-written record is never read. */
export function writeManifest(dshHome: string, skills: readonly PlacedSkill[]): string {
  const file = manifestPathOf(dshHome)
  const root = skillRootOf(dshHome)
  mkdirSync(dirname(file), { recursive: true })
  const staging = `${file}.writing`
  writeFileSync(staging, `${JSON.stringify({ version: MANIFEST_VERSION, root, skills }, null, 2)}\n`, 'utf8')
  /* A rename over an existing file is not portable on Windows; remove the old record first, so a
   * crash in between leaves no record at all rather than the previous version's. */
  rmSync(file, { force: true })
  renameSync(staging, file)
  return file
}

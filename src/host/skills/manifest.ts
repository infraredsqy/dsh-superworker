/**
 * The placement record: what this line wrote into a skill root, read back, replaced, and taken back.
 *
 * The manifest is the only thing unloading touches. Every file the placement writes is recorded
 * (`<dshHome>/superworker/skills.json`, outside the skill root so the provider never scans it), so an
 * unload removes exactly those files: not a directory holding somebody else's file, not the old
 * hand-copied copies, not another root's skills. A second install replaces what the previous manifest
 * recorded, so an upgrade leaves no earlier version behind.
 *
 * A missing manifest is an empty placement, not a fault — a host that never saw this line has nothing
 * of ours anywhere. A manifest that exists but cannot be trusted is a refusal: overwriting a root
 * whose contents we cannot read, or taking back files we cannot enumerate, is how somebody else's
 * skill gets deleted. A write interrupted between its two renames leaves the previous record as a
 * backup, and the next load restores the record from it — so a crash never leaves this line's files
 * on disk with no record to prove whose they are.
 */
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute } from 'node:path'
import type { SkillRefusal, SkillRefusalCode } from '../failure.ts'
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

/** Reading the placement record: what is there — and whether an on-disk record backs the answer — or why it cannot be trusted. */
export type ManifestReading =
  | {
      readonly ok: true
      readonly manifest: SkillsManifest
      /** Whether a record on disk answers this reading: the file itself, or an interrupted write's backup restored over it. */
      readonly recorded: boolean
    }
  | SkillRefusal

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
export function refused(code: SkillRefusalCode, detail: string): SkillRefusal {
  return { ok: false, code, detail }
}

/** Where an interrupted write leaves the previous record for the next load to restore. */
export function manifestBackupPathOf(dshHome: string = dshHomeOf()): string {
  return `${manifestPathOf(dshHome)}.backup`
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
  return { ok: true, manifest: { version: MANIFEST_VERSION, root, skills }, recorded: true }
}

/**
 * What this line placed before, read back: the skills an upgrade replaces and an unload takes back.
 *
 * A missing manifest is an empty placement, not a fault — a host that never saw this line has nothing
 * of ours anywhere — unless an interrupted write left its backup: then the previous record is
 * restored from the backup and answered as the record, so the files the last completed placement
 * left behind stay accounted for. A manifest (or a backup) that exists but cannot be trusted is a
 * refusal: overwriting a root whose contents we cannot read, or taking back files we cannot
 * enumerate, is how somebody else's skill gets deleted.
 */
export function placedSkills(dshHome: string = dshHomeOf()): ManifestReading {
  const file = manifestPathOf(dshHome)
  const root = skillRootOf(dshHome)
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch (error) {
    if (!absent(error)) return refused('manifest-unreadable', `${file}: ${messageOf(error)} (nothing was overwritten or taken back)`)
    return placedSkillsFromBackup(dshHome, root)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    return refused('manifest-unreadable', `${file}: ${messageOf(error)} (nothing was overwritten or taken back)`)
  }
  return manifestOf(parsed, file, root)
}

/**
 * The record is not on disk: either this host never saw this line, or a write was interrupted
 * between moving the previous record to its backup and writing the new one. A backup left by such an
 * interruption is the record this line itself wrote — restore it and answer it, so the placement it
 * accounts for is never mistaken for somebody else's files. A backup that exists but cannot be
 * trusted is a refusal, like the record itself would be.
 */
function placedSkillsFromBackup(dshHome: string, root: string): ManifestReading {
  const backup = manifestBackupPathOf(dshHome)
  const empty: ManifestReading = { ok: true, manifest: { version: MANIFEST_VERSION, root, skills: [] }, recorded: false }
  let text: string
  try {
    text = readFileSync(backup, 'utf8')
  } catch (error) {
    if (absent(error)) return empty
    return refused('manifest-unreadable', `${backup}: ${messageOf(error)} (nothing was overwritten or taken back)`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    return refused('manifest-unreadable', `${backup}: ${messageOf(error)} (nothing was overwritten or taken back)`)
  }
  const reading = manifestOf(parsed, backup, root)
  if (!reading.ok) return reading
  try {
    renameSync(backup, manifestPathOf(dshHome))
  } catch {
    /* Best effort: the reading is already in hand, and the next load restores again. */
  }
  return reading
}

/**
 * Write the manifest the next load reads and the unload follows.
 *
 * Each step of the swap is one rename, so a half-written record is never read: the new record is
 * staged whole, the previous record moves to the backup, the staged one takes its place, and only
 * then does the backup go. A crash between the two renames leaves no record — but leaves the
 * previous one as the backup, which the next load restores, so the files already on disk are never
 * stranded without a record of whose they are. When the staged record cannot take its place, the
 * previous record moves back and the staged file is taken back with it — the failed attempt leaves
 * nothing of its own behind.
 */
export function writeManifest(dshHome: string, skills: readonly PlacedSkill[]): string {
  const file = manifestPathOf(dshHome)
  const backup = manifestBackupPathOf(dshHome)
  const root = skillRootOf(dshHome)
  mkdirSync(dirname(file), { recursive: true })
  const staging = `${file}.writing`
  writeFileSync(staging, `${JSON.stringify({ version: MANIFEST_VERSION, root, skills }, null, 2)}\n`, 'utf8')
  rmSync(backup, { force: true })
  try {
    renameSync(file, backup)
  } catch (error) {
    if (!absent(error)) throw error
  }
  try {
    renameSync(staging, file)
  } catch (error) {
    try {
      renameSync(backup, file)
    } catch {
      /* Best effort; the refusal the caller raises names the real failure. */
    }
    rmSync(staging, { force: true })
    throw error
  }
  rmSync(backup, { force: true })
  return file
}

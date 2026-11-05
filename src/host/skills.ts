/**
 * The skills a pf plugin ships, placed where DSH reads skills, and taken back out again.
 *
 * A plugin folder carries its own skills (`<plugin>/skills/<lang>/<method>/SKILL.md`, the convention
 * the plugin contract states). The engine already reads those folders — the scan of the plugin
 * directory, the folders one plugin ships, and the two ways they disagree with the declaration — so
 * nothing here re-reads a plugin's declaration or guesses at its skills: the engine hands over the
 * facts, this file owns what happens next.
 *
 * Four decisions this module makes, all of them stated where they are made:
 *
 * - **The skills go into the root a provider scans, not into a runtime registration.** In this
 *   composition the enabled `skill-filesystem` providers are mounted by the agent preset's standing
 *   composition, so their entries live in the preset layer; a runtime registration made by this line
 *   lands in the global layer, and the nearer layer wins a duplicate name outright — rank is only
 *   consulted inside one layer. Writing the files into `<dshHome>/skills` puts both copies in the
 *   same provider's scan, where the provider's own ranks decide: that root is 400, the old
 *   hand-copied copies under `<agentsHome>/skills` are 500. The root is resolved the way the provider
 *   resolves a config-less `dshHome` — `DSH_HOME`, else `~/.dsh`.
 * - **One language per method.** The same method ships under `zh` and `en`; a skill root keys a skill
 *   by the name in its frontmatter, so two copies would leave whichever the scan reached first. Each
 *   method is placed once, in the host's language when this half can know it (`zh` when it cannot —
 *   see {@link DEFAULT_LANGUAGE}).
 * - **The manifest is the only thing unloading touches.** Every file this line writes is recorded
 *   (`<dshHome>/pathfinder/skills.json`, outside the skill root so the provider never scans it), and
 *   unloading removes exactly those files: not a directory holding somebody else's file, not the old
 *   hand-copied copies, not another root's skills. A second install replaces what the previous
 *   manifest recorded, so an upgrade leaves no earlier version behind.
 * - **What is placed is recorded; a session's view is read separately, as a diagnostic.**
 *   Placing happens when the line loads, before any session exists, so this half can honestly hand
 *   back only *placed* (the root and the manifest), never "the catalog shows it". The session view —
 *   `list({ cwd, scope })`, the read a session's catalog does — is read once where a workspace is
 *   known ({@link confirmSkillsInView}) and left as one logger line: a diagnostic, never an install
 *   verdict and never a failed session. It does not decide the completion judgement — that reading is
 *   the session's own catalog, taken over the old hand-copied copies under `<agentsHome>/skills`
 *   (rank 500, below this root's 400). A same-name copy in a project root (rank 100/200) is DSH's own
 *   per-workspace override and lies outside this node's judgement: the diagnostic notes it, and stops
 *   there.
 */
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  rmdirSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  PLUGIN_SKILL_FILE,
  loadPlugins,
  skillFolders,
  skillProblems,
} from 'pf-core'
import type { PluginFolder } from 'pf-core'
import type {
  PfSkillRefusal,
  PfSkillRefusalCode,
  PfSkillsOutcome,
  PfSkillViewOutcome,
} from './failure.ts'

/** The language a method is placed in when this half cannot learn the reader's: the shipped tables' own. */
export const DEFAULT_LANGUAGE = 'zh'

/** The variable under which a deployment pins its DSH home; the provider reads the same one. */
const DSH_HOME_ENV = 'DSH_HOME'
/** The DSH home's directory name under the OS home: the provider's own default. */
const DSH_HOME_DIR = '.dsh'

/** The provider's own rank for `<dshHome>/skills` (`USER_DSH_RANK` in `dsh-skill-filesystem`). */
export const SKILL_ROOT_RANK = 400
/** The provider's own rank for `<agentsHome>/skills`, where the old hand-copied copies sit. */
export const OLD_COPIES_RANK = 500

/** This line's own folder under the DSH home, out of the skill root's way so the provider never scans it. */
const MANIFEST_DIR = 'pathfinder'
/** The manifest file naming every file this line placed. */
const MANIFEST_FILE = 'skills.json'
/** The manifest format this file writes and reads; a manifest of another version is refused, not guessed at. */
const MANIFEST_VERSION = 1

/** The skill-name shape DSH's provider accepts: kebab-case, the name it keys the catalog by. */
const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u

/**
 * The DSH home this host runs against: the variable a deployment pins, else `~/.dsh`.
 *
 * Exactly the resolution the filesystem provider applies to a config-less `dshHome`, so the root
 * written here is the root the provider scans — as long as no plugin config pins one. A deployment
 * that pins `dshHome` in its own plugin config is outside this half's knowledge: this file reads the
 * environment, not the provider's config, so the placement lands under a root that provider never
 * scans and no catalog shows it. The manifest's root check cannot catch that mismatch: both sides of
 * its comparison are this same computation, so it catches a record carried to another home or edited
 * by hand, and stops there. The pin is a known gap, not a refusal.
 */
export function dshHomeOf(): string {
  const configured = process.env[DSH_HOME_ENV]
  if (typeof configured === 'string' && configured.trim().length > 0) return resolve(configured.trim())
  return join(homedir(), DSH_HOME_DIR)
}

/** The skill root this line places into: the provider's `user-dsh` root, rank {@link SKILL_ROOT_RANK}. */
export function skillRootOf(dshHome: string = dshHomeOf()): string {
  return join(dshHome, 'skills')
}

/** Where the record of what this line placed lives. */
export function manifestPathOf(dshHome: string = dshHomeOf()): string {
  return join(dshHome, MANIFEST_DIR, MANIFEST_FILE)
}

/**
 * Where the plugin folders this package ships live.
 *
 * The same relative path answers in both trees: `src/host/skills.ts` walks up to the checkout, and
 * the bundled `lib/host/index.js` walks up to the installed package — `packages/pf-core/plugins/`
 * sits at the root either way. `package.json`'s `files` carries it, which is what makes the skills
 * part of the artifact rather than part of the checkout (`tests/package-surface` holds that).
 */
export function shippedPluginsDir(): string {
  return fileURLToPath(new URL(`../../packages/pf-core/plugins/`, import.meta.url))
}

/** One skill as this layer reads it out of a `SKILL.md`: what the placement needs, and nothing it does not. */
export interface SkillFile {
  readonly name: string
  readonly description: string
  readonly invocation: { readonly modelInvocable: boolean; readonly userInvocable: boolean }
  /** The instruction body: the file with its frontmatter block cut off and nothing else touched. */
  readonly content: string
}

/** Reading one shipped skill file: the skill, or why this file is not one. */
export type SkillFileReading =
  | { readonly ok: true; readonly value: SkillFile }
  | { readonly ok: false; readonly detail: string }

/**
 * The reserved names a skill file's frontmatter may carry and this layer honours.
 *
 * The filesystem provider's own vocabulary, read the same way: a skill is named and described, and
 * the two invocation keys decide which surfaces may offer it. Everything else in the block is left
 * alone — a shipped file may carry extra metadata and still be installable.
 */
const INVOCATION_KEYS = ['disable-model-invocation', 'user-invocable'] as const

/** A YAML-style boolean, in the spellings DSH's own provider accepts; anything else is a refused spelling. */
function booleanOf(raw: string): boolean | undefined {
  const text = raw.trim().toLowerCase()
  if (text === 'true' || text === 'yes' || text === 'on' || text === '1') return true
  if (text === 'false' || text === 'no' || text === 'off' || text === '0') return false
  return undefined
}

/** A frontmatter value with a matching pair of quotes taken off; an unquoted value is returned as it stands. */
function unquote(raw: string): string {
  const text = raw.trim()
  const first = text[0]
  if (text.length >= 2 && (first === '"' || first === "'") && text.endsWith(first)) return text.slice(1, -1)
  return text
}

/** The flat cells of a frontmatter block: `key: value` at the block's own level, indented cells (nested tables) skipped. */
function cellsOf(block: readonly string[]): Record<string, string> {
  const cells: Record<string, string> = {}
  for (const line of block) {
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue
    /* An indented line belongs to a cell above it (a nested table or a list); it is not a cell of its own. */
    if (line.trimStart() !== line) continue
    const sep = line.indexOf(':')
    if (sep <= 0) continue
    cells[line.slice(0, sep).trim()] = unquote(line.slice(sep + 1))
  }
  return cells
}

/**
 * Read one skill file: its frontmatter block and the instruction body after it.
 *
 * A file with no `---` block, no name, no description, or an invocation key in a spelling DSH would
 * read as neither true nor false is not a skill — and because these files ship inside the package,
 * "not a skill" is a packaging fault worth refusing over rather than a warning worth skipping.
 */
export function readSkillFile(text: string): SkillFileReading {
  const lines = text.replace(/^\uFEFF/u, '').split('\n')
  if ((lines[0] ?? '').trim() !== '---') {
    return { ok: false, detail: 'no frontmatter block (the file does not open with ---)' }
  }
  let closing = -1
  for (let index = 1; index < lines.length; index++) {
    if ((lines[index] ?? '').trim() === '---') {
      closing = index
      break
    }
  }
  if (closing < 0) return { ok: false, detail: 'no frontmatter block (the opening --- is never closed)' }
  const cells = cellsOf(lines.slice(1, closing))
  const name = cells['name'] ?? ''
  if (name === '') return { ok: false, detail: 'frontmatter has no name' }
  const description = cells['description'] ?? ''
  if (description === '') return { ok: false, detail: 'frontmatter has no description' }
  let disableModel = false
  let userInvocable = true
  for (const key of INVOCATION_KEYS) {
    const raw = cells[key]
    if (raw === undefined) continue
    const value = booleanOf(raw)
    if (value === undefined) return { ok: false, detail: `frontmatter ${key} is not a boolean: ${JSON.stringify(raw)}` }
    if (key === 'disable-model-invocation') disableModel = value
    else userInvocable = value
  }
  return {
    ok: true,
    value: {
      name,
      description,
      invocation: { modelInvocable: !disableModel, userInvocable },
      /* The body is everything after the closing delimiter line, byte for byte: the one thing this
       * layer must not touch is the text the model will read. */
      content: lines.slice(closing + 1).join('\n'),
    },
  }
}

/** One skill folder chosen for placement, with the file list the placement needs beside it. */
interface ChosenSkill {
  readonly lang: string
  readonly method: string
  readonly folder: string
  readonly file: string
  /** The folder's files, relative to the folder, in a stable order; `SKILL.md` is always among them. */
  readonly files: readonly string[]
}

/**
 * The language one method is placed in.
 *
 * The wanted language first, then the two shipped ones (the fallback, then English), then whatever
 * this method does ship — a method whose language is missing entirely is still placed, because a
 * skill in the wrong language is a reader's inconvenience while a missing skill is a broken plugin.
 * Never two: the root would keep only the one the scan reached first and drop the other without a trace.
 */
function languageOf(available: readonly string[], wanted: string): string | undefined {
  for (const lang of [wanted, DEFAULT_LANGUAGE, 'en']) {
    if (available.includes(lang)) return lang
  }
  return available[0]
}

/** Group every plugin's skill folders by method, and pick one language per method. */
function chooseSkills(folders: readonly PluginFolder[], wanted: string): Array<Omit<ChosenSkill, 'files'>> {
  const byMethod = new Map<string, Array<Omit<ChosenSkill, 'files'>>>()
  for (const folder of folders) {
    for (const skill of skillFolders(folder)) {
      const chosen: Omit<ChosenSkill, 'files'> = {
        lang: skill.lang,
        method: skill.method,
        folder: skill.folder,
        file: join(skill.folder, PLUGIN_SKILL_FILE),
      }
      const held = byMethod.get(skill.method)
      if (held === undefined) byMethod.set(skill.method, [chosen])
      else held.push(chosen)
    }
  }
  const out: Array<Omit<ChosenSkill, 'files'>> = []
  for (const method of [...byMethod.keys()].sort()) {
    const candidates = byMethod.get(method) ?? []
    const languages = candidates.map((candidate) => candidate.lang)
    const lang = languageOf(languages, wanted)
    const picked = candidates.find((candidate) => candidate.lang === lang)
    if (picked !== undefined) out.push(picked)
  }
  return out
}

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
type ManifestReading =
  | { readonly ok: true; readonly manifest: SkillsManifest }
  | PfSkillRefusal

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function absent(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error.code === 'ENOENT' || error.code === 'ENOTDIR')
  )
}

function refused(code: PfSkillRefusalCode, detail: string): PfSkillRefusal {
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
function writeManifest(dshHome: string, skills: readonly PlacedSkill[]): string {
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

/** Every file inside one skill folder, relative to it, in a stable order: the body, then the siblings it points at. */
function folderFiles(folder: string, prefix = ''): string[] {
  const out: string[] = []
  const entries = readdirSync(folder, { withFileTypes: true }).sort((left, right) =>
    left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
  )
  for (const entry of entries) {
    const rel = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`
    if (entry.isDirectory()) {
      out.push(...folderFiles(join(folder, entry.name), rel))
      continue
    }
    if (entry.isFile()) out.push(rel)
  }
  return out
}

/** The flat `.md` skills sitting directly in a root, by the name their frontmatter declares. */
function flatSkillNames(root: string): Map<string, string> {
  const found = new Map<string, string>()
  let entries
  try {
    entries = readdirSync(root, { withFileTypes: true })
  } catch (error) {
    if (absent(error)) return found
    throw error
  }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.md')) continue
    const file = join(root, entry.name)
    try {
      const reading = readSkillFile(readFileSync(file, 'utf8'))
      if (reading.ok) found.set(reading.value.name, file)
    } catch {
      /* An unreadable file is not a skill this layer can name, so it cannot be a collision with one. */
    }
  }
  return found
}

/** A directory that could not be removed because something is still in it: nobody else's file is at fault, and nothing more can be taken back. */
function notEmpty(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOTEMPTY'
}

/** Remove a folder's empty directories, deepest first; a refusal is ignored on this path, which only exists to tidy up after a failed write. */
function removeEmptyTree(folder: string): void {
  let names: string[]
  try {
    names = readdirSync(folder, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
  } catch {
    return
  }
  for (const name of names) removeEmptyTree(join(folder, name))
  try {
    rmdirSync(folder)
  } catch {
    /* Not empty (a file of ours could not be removed) or already gone: the refusal already names the write. */
  }
}

/**
 * Remove one placed file and the directories this line made for it, deepest first.
 *
 * The directories a skill folder holds are its own shape (`shared/pf/`, `subagent-prompts/`), not
 * something the manifest records: they follow from the file's own path, so the walk up from the file
 * to the skill's directory is the whole of it. A directory another file still lives in answers
 * ENOTEMPTY and stays, with that file in it — which is why the attempt is the test, rather than a
 * listing taken beforehand.
 */
function removePlacedFile(root: string, skillDir: string, file: string, problems: string[]): void {
  const full = join(root, file)
  try {
    rmSync(full, { force: true })
  } catch (error) {
    problems.push(`${full}: ${messageOf(error)}`)
  }
  const stop = join(root, skillDir)
  let dir = dirname(full)
  for (;;) {
    try {
      rmdirSync(dir)
    } catch (error) {
      /* Not empty (somebody else's file, or one of ours not removed yet) or already gone: neither is a fault. */
      if (!absent(error) && !notEmpty(error)) problems.push(`${dir}: ${messageOf(error)}`)
    }
    if (dir === stop || dir === dirname(dir)) return
    dir = dirname(dir)
  }
}

/**
 * Remove one placed skill's files, then every directory of its folder this line left empty.
 *
 * Only the files the manifest recorded are removed: a directory that also holds somebody else's file
 * stays, with that file in it. Removal failures are collected and handed back rather than thrown —
 * unloading happens on a fiber teardown and must not strand the rest.
 */
function removePlaced(root: string, skills: readonly PlacedSkill[]): string[] {
  const problems: string[] = []
  for (const skill of skills) {
    for (const file of skill.files) removePlacedFile(root, skill.dir, file, problems)
    try {
      rmdirSync(join(root, skill.dir))
    } catch (error) {
      /* Not empty (somebody else's file lives there) or already gone: both are fine, none is a fault. */
      if (!absent(error) && !notEmpty(error)) problems.push(`${join(root, skill.dir)}: ${messageOf(error)}`)
    }
  }
  return problems
}

/** The host facts this step reads, as a narrow face rather than the whole context: the catalog to read back through, a logger, and the lifecycle seam an unload's undo hangs on. */
export interface SkillHostContext {
  readonly skills?: SkillCatalogPort | undefined
  readonly logger?: SkillLogging | undefined
  /** Run once, with its result collected as an effect of the calling plugin (cordis's own seam). */
  readonly effect?: ((execute: () => unknown, label?: string) => unknown) | undefined
}

/** The logging face this layer uses; every level is optional, and a host without one still loads. */
interface SkillLogging {
  info?(line: string): void
  warn?(line: string): void
  error?(line: string): void
}

/** One winning catalog entry, as much of it as the diagnostic reads. */
export interface SkillSummaryReading {
  readonly name: string
  readonly provider: string
  readonly source: string
  readonly path?: string
}

/** The view the diagnostic is read through: the session's cwd, and the scope whose layers that session sees. */
export interface SkillView {
  readonly cwd?: string | undefined
  readonly scope?: unknown
}

/** The part of DSH's skill service this layer uses: one catalog read in a given view; every other member is somebody else's contract. */
export interface SkillCatalogPort {
  list(options?: {
    readonly cwd?: string | undefined
    readonly scope?: unknown
  }): Promise<readonly SkillSummaryReading[]>
}

/** What placing the shipped skills hands back: the outcome, and the undo for whatever landed. */
export interface PfSkillsInstall {
  readonly outcome: PfSkillsOutcome
  /** Take back every file this placement wrote; a no-op more than once, and a no-op after a refusal. */
  dispose(): void
}

/** Options of one placement: which plugin folders, which language the reader is in, and which home to place under. */
export interface PfSkillsInstallOptions {
  /** The plugin directory to read; the shipped one by default. */
  readonly pluginsDir?: string
  /** The host's language when this half can learn it; {@link DEFAULT_LANGUAGE} otherwise. */
  readonly language?: string
  /** The DSH home to place under (tests pin it); {@link dshHomeOf} otherwise. */
  readonly dshHome?: string
}

/** The one option the diagnostic takes: which DSH home's placement is read back. */
export interface PfSkillsHomeOptions {
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
 * Place the skills the shipped plugins carry, and hand back the undo.
 *
 * The work, in order: read the plugin directory and take the engine's verdict on the set (its
 * collision rule is the whole of "one skill name, one plugin"); read one language's `SKILL.md` per
 * method together with every sibling file it points at; read what was placed before; refuse when the
 * target name is already somebody else's; replace the previous placement; write every file; record
 * the result. A failure part-way takes back what this attempt wrote, so the caller never has half a
 * placement to reason about.
 *
 * Everything here is synchronous after the plugin scan, and nothing here reads a catalog: the facts
 * this returns are *placed*, the root and the manifest. Reading the session view back is a separate
 * step, because it needs a workspace.
 */
export async function installPluginSkills(
  host: SkillHostContext,
  options: PfSkillsInstallOptions = {},
): Promise<PfSkillsInstall> {
  const dshHome = options.dshHome ?? dshHomeOf()
  const root = skillRootOf(dshHome)
  try {
    return await place(host, dshHome, options)
  } catch (error) {
    /* The unexpected path: whatever it was, a caller gets a decidable code and a no-op undo. */
    return {
      outcome: refused('skill-place-failed', `${root}: ${messageOf(error)}`),
      dispose: () => undefined,
    }
  }
}

/** The placement proper: everything {@link installPluginSkills} does, with the unexpected paths caught above it. */
async function place(
  calling: SkillHostContext,
  home: string,
  which: PfSkillsInstallOptions,
): Promise<PfSkillsInstall> {
  const skillRoot = skillRootOf(home)
  const pluginsDir = which.pluginsDir ?? shippedPluginsDir()
  const scan = await loadPlugins(pluginsDir)
  if (scan.folders.length === 0) {
    return {
      outcome: refused('skills-missing', [`${pluginsDir} holds no plugin folder`, ...scan.problems].join('; ')),
      dispose: () => undefined,
    }
  }

  /* The engine's verdict on the set, and the whole of the collision rule: two plugins shipping one
   * skill name (or a metric naming a method with no skill of its own). Its sentences already name
   * the plugins and the skill, so they travel as the detail untouched. */
  const problems = skillProblems(scan.folders)
  if (problems.length > 0) {
    return { outcome: refused('skill-conflict', problems.join('\n')), dispose: () => undefined }
  }

  const chosen = chooseSkills(scan.folders, which.language ?? DEFAULT_LANGUAGE)
  const planned: ChosenSkill[] = []
  const unreadable: string[] = []
  for (const one of chosen) {
    let text: string
    try {
      text = readFileSync(one.file, 'utf8')
    } catch (error) {
      unreadable.push(`${one.file}: ${messageOf(error)}`)
      continue
    }
    const reading = readSkillFile(text)
    if (!reading.ok) {
      unreadable.push(`${one.file}: ${reading.detail}`)
      continue
    }
    /* The folder names the method, the file names the skill: the root must show the name the
     * declaration uses, so a file that disagrees with its own folder is a packaging fault. */
    if (reading.value.name !== one.method) {
      unreadable.push(
        `${one.file}: frontmatter names the skill ${JSON.stringify(reading.value.name)}, ` +
          `its folder names it ${JSON.stringify(one.method)}`,
      )
      continue
    }
    if (!SKILL_NAME.test(reading.value.name)) {
      unreadable.push(
        `${one.file}: ${JSON.stringify(reading.value.name)} is not a skill name DSH's provider would ` +
          'accept (lowercase kebab-case)',
      )
      continue
    }
    let files: string[]
    try {
      files = folderFiles(one.folder)
    } catch (error) {
      unreadable.push(`${one.folder}: ${messageOf(error)}`)
      continue
    }
    if (!files.includes(PLUGIN_SKILL_FILE)) {
      unreadable.push(`${one.folder}: no ${PLUGIN_SKILL_FILE}`)
      continue
    }
    planned.push({ ...one, files })
  }
  if (unreadable.length > 0) {
    return { outcome: refused('skill-unreadable', unreadable.join('\n')), dispose: () => undefined }
  }

  const previous = placedSkills(home)
  if (!previous.ok) return { outcome: previous, dispose: () => undefined }
  const owned = new Set(previous.manifest.skills.map((skill) => skill.name))

  /* A name already held in this root by somebody else's copy. Placing over it would put two
   * definitions in one directory (or two directories that cannot share a name), and silently
   * keeping one of them is exactly the outcome the completion judgement forbids. */
  const collisions: string[] = []
  const flat = flatSkillNames(skillRoot)
  for (const one of planned) {
    if (owned.has(one.method)) continue
    const directory = join(skillRoot, one.method)
    const flatFile = flat.get(one.method)
    const heldAt = existsSync(directory) ? join(directory, PLUGIN_SKILL_FILE) : flatFile
    if (heldAt === undefined) continue
    collisions.push(
      `${one.method}: this line ships ${one.file}, but ${heldAt} already holds a skill with that ` +
        'name and this line did not place it',
    )
  }
  if (collisions.length > 0) {
    return { outcome: refused('skill-shadowed', collisions.join('\n')), dispose: () => undefined }
  }

  /* An upgrade replaces what the previous manifest recorded — every earlier version of this line's
   * own skills goes, including names the shipped set no longer has. Somebody else's files are never
   * in these entries to begin with. */
  removePlaced(skillRoot, previous.manifest.skills)

  const written: string[] = []
  const created: string[] = []
  const placed: PlacedSkill[] = []
  try {
    mkdirSync(skillRoot, { recursive: true })
    for (const one of planned) {
      const target = join(skillRoot, one.method)
      mkdirSync(target, { recursive: true })
      const files: string[] = []
      for (const rel of one.files) {
        const destination = join(skillRoot, `${one.method}/${rel}`)
        mkdirSync(dirname(destination), { recursive: true })
        copyFileSync(join(one.folder, rel), destination)
        written.push(destination)
        files.push(`${one.method}/${rel}`)
      }
      created.push(target)
      placed.push({ name: one.method, dir: one.method, files })
    }
    const manifestFile = writeManifest(home, placed)
    return {
      outcome: { ok: true, names: placed.map((skill) => skill.name), root: skillRoot, manifest: manifestFile },
      dispose: disposePlacement(calling, home, skillRoot, placed, manifestFile),
    }
  } catch (error) {
    for (const file of written.reverse()) {
      try {
        rmSync(file, { force: true })
      } catch {
        /* Rollback is best effort; the refusal names what could not be written. */
      }
    }
    for (const directory of created.reverse()) removeEmptyTree(directory)
    return { outcome: refused('skill-place-failed', `${skillRoot}: ${messageOf(error)}`), dispose: () => undefined }
  }
}

/** The undo of one successful placement: exactly its own files, then the record, then the record's folder when empty. */
function disposePlacement(
  host: SkillHostContext,
  dshHome: string,
  root: string,
  placed: readonly PlacedSkill[],
  manifestFile: string,
): () => void {
  let disposed = false
  return (): void => {
    if (disposed) return
    disposed = true
    let problems: string[] = []
    try {
      problems = removePlaced(root, placed)
    } catch (error) {
      problems.push(`${root}: ${messageOf(error)}`)
    }
    try {
      rmSync(manifestFile, { force: true })
      rmdirSync(join(dshHome, MANIFEST_DIR))
    } catch (error) {
      if (!absent(error)) problems.push(`${dirname(manifestFile)}: ${messageOf(error)}`)
    }
    if (problems.length > 0) say(host, 'warn', `plugin skills not taken back — skill-place-failed: ${problems.join('; ')}`)
  }
}

/**
 * Read the placed skills back through a catalog view — the read a session's own catalog does — as a
 * diagnostic, never as the judgement's verdict.
 *
 * The view is `list({ cwd, scope })`, never a bare `list()`: the provider that scans the skill root
 * is mounted in the session's own layer chain, and project roots only enter the scan when a `cwd` is
 * given. A read that names neither sees a different catalog, so it cannot stand as a reading of the
 * session's catalog at all. For every placed name, the winning entry is compared with the file this
 * line placed; a winner elsewhere — a project root's copy at rank 100/200 above this root's 400, or
 * another layer's — comes back as `skill-shadowed` naming both places. That code is what the
 * diagnostic saw, not a refusal: nothing on disk changes and no session fails.
 *
 * An empty placement reports nothing and claims nothing.
 */
export async function confirmSkillsInView(
  host: SkillHostContext,
  view: SkillView = {},
  options: PfSkillsHomeOptions = {},
): Promise<PfSkillViewOutcome> {
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
): Promise<PfSkillViewOutcome> {
  try {
    return await confirmSkillsInView(host, { cwd, scope })
  } catch (error) {
    return refused('catalog-unreadable', `the skill catalog could not be read: ${messageOf(error)}`)
  }
}

/** One line through the host's logger, when there is one; every level it lacks falls back to the one it has. */
function say(host: SkillHostContext, level: 'info' | 'warn' | 'error', line: string): void {
  const logger = host.logger
  if (logger === undefined) return
  try {
    const write = logger[level] ?? logger.warn ?? logger.error ?? logger.info
    if (write !== undefined) write.call(logger, line)
  } catch {
    /* The logger is the composition's, not ours: one that throws must not take the line down. */
  }
}

/**
 * Report one placement through the host's logger — a line whether it landed or was refused.
 *
 * The line says what, where, and under which record, so a deployment that mounts a log exporter has
 * the verdict at boot instead of only a caller. A deployment whose exporter shows nothing (the web
 * instance captures warnings for a failed start only) still leaves two readable records of the same
 * fact: the manifest on disk and the session's own catalog view.
 */
function report(host: SkillHostContext, outcome: PfSkillsOutcome): void {
  if (outcome.ok) {
    say(
      host,
      'info',
      `plugin skills placed — ${outcome.names.length} skill(s) under ${outcome.root} (manifest ${outcome.manifest})`,
    )
    return
  }
  say(host, 'error', `plugin skills not placed — ${outcome.code}: ${outcome.detail}`)
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
export function reportSkillView(host: SkillHostContext, outcome: PfSkillViewOutcome): void {
  if (outcome.ok) {
    if (outcome.names.length === 0) return
    say(host, 'info', `plugin skills checked — ${outcome.names.length} skill(s) win their names in this workspace's catalog (diagnostic only)`)
    return
  }
  say(host, 'warn', `plugin skills shadowed in this workspace's catalog (diagnostic only) — ${outcome.code}: ${outcome.detail}`)
}

/**
 * Place the shipped skills when this line loads, and take them back out when it unloads.
 *
 * No `ctx.inject` on the skill registry: placing is a filesystem action, and waiting for a service
 * this line does not use would hold the whole panel back on a host that never mounts one — as well as
 * leave a host that does mount it with nothing said when the wait never comes. The undo hangs on
 * `ctx.effect`, the plugin's own fiber, so whatever the composition does with the line, the files go
 * with it.
 *
 * @returns whatever the host's own seam handed back, so a caller can wait for the attempt to settle.
 */
export function installSkillsWhenReady(
  ctx: unknown,
  options: PfSkillsInstallOptions = {},
): unknown {
  const host = ctx as SkillHostContext
  const start = async (): Promise<() => void> => {
    const install = await installPluginSkills(host, options)
    report(host, install.outcome)
    return install.dispose
  }
  if (typeof host.effect === 'function') return host.effect.call(host, start, 'pathfinder: plugin skills')
  return start()
}

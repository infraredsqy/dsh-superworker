/**
 * Placing the skills the shipped plugins carry, and taking them back out again.
 *
 * A plugin folder carries its own skills (`<plugin>/skills/<lang>/<method>/SKILL.md`, the convention
 * the plugin contract states). The engine already reads those folders — the scan of the plugin
 * directory, the folders one plugin ships, and the two ways they disagree with the declaration — so
 * nothing here re-reads a plugin's declaration or guesses at its skills: the engine hands over the
 * facts, this module owns what happens next.
 *
 * - **The skills go into the root a provider scans, not into a runtime registration.** In this
 *   composition the enabled `skill-filesystem` providers are mounted by the agent preset's standing
 *   composition, so their entries live in the preset layer; a runtime registration made by this line
 *   lands in the global layer, and the nearer layer wins a duplicate name outright — rank is only
 *   consulted inside one layer. Writing the files into `<dshHome>/skills` puts both copies in the
 *   same provider's scan, where the provider's own ranks decide: that root is 400, the old
 *   hand-copied copies under `<agentsHome>/skills` are 500.
 * - **One language per method.** The same method ships under `zh` and `en`; a skill root keys a skill
 *   by the name in its frontmatter, so two copies would leave whichever the scan reached first. Each
 *   method is placed once, in the host's language when this half can know it (`zh` when it cannot —
 *   see {@link DEFAULT_LANGUAGE}).
 * - **Everything written is recorded, and only the record is taken back** (`manifest.ts`).
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
 * step (`view.ts`), because it needs a workspace.
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, rmdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { PLUGIN_SKILL_FILE, loadPlugins, skillFolders, skillProblems } from 'superworker-core'
import type { PluginFolder } from 'superworker-core'
import type { SkillsOutcome } from '../failure.ts'
import { effectOf, logLineOf, messageOf, type SkillHostContext } from '../seams.ts'
import { MANIFEST_DIR, dshHomeOf, shippedPluginsDir, skillRootOf } from '../skill-paths.ts'
import { SKILL_NAME, readSkillFile, skillNameOfFile } from './frontmatter.ts'
import { absent, placedSkills, refused, writeManifest, type PlacedSkill } from './manifest.ts'

/** The language a method is placed in when this half cannot learn the reader's: the shipped tables' own. */
export const DEFAULT_LANGUAGE = 'zh'

/** What placing the shipped skills hands back: the outcome, and the undo for whatever landed. */
export interface SkillsInstall {
  readonly outcome: SkillsOutcome
  /** Take back every file this placement wrote; a no-op more than once, and a no-op after a refusal. */
  dispose(): void
}

/** Options of one placement: which plugin folders, which language the reader is in, and which home to place under. */
export interface SkillsInstallOptions {
  /** The plugin directory to read; the shipped one by default. */
  readonly pluginsDir?: string
  /** The host's language when this half can learn it; {@link DEFAULT_LANGUAGE} otherwise. */
  readonly language?: string
  /** The DSH home to place under (tests pin it); {@link dshHomeOf} otherwise. */
  readonly dshHome?: string
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
    const name = skillNameOfFile(file)
    if (name !== undefined) found.set(name, file)
  }
  return found
}

/**
 * Take back one directory when nothing else is in it: absent, already gone, and still holding
 * somebody else's file are all "nothing to take back" — only a real failure is worth a line, and
 * only when the caller collects them.
 *
 * This is the one spelling of "an empty directory this line made goes away": the file walk, the
 * skill folder, the placement record's own folder, and the rollback of a failed write all end here.
 */
function rmdirIfEmpty(dir: string, problems?: string[]): void {
  try {
    rmdirSync(dir)
  } catch (error) {
    if (!absent(error) && !notEmpty(error)) problems?.push(`${dir}: ${messageOf(error)}`)
  }
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
  rmdirIfEmpty(folder)
}

/**
 * Remove one placed file and the directories this line made for it, deepest first.
 *
 * The directories a skill folder holds are its own shape (`shared/sw/`, `subagent-prompts/`), not
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
    rmdirIfEmpty(dir, problems)
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
    rmdirIfEmpty(join(root, skill.dir), problems)
  }
  return problems
}

/**
 * Place the skills the shipped plugins carry, and hand back the undo.
 *
 * A refusal is decided by codes (see `failure.ts`), never by a sentence; the detail carries the names
 * this half does not own.
 */
export async function installPluginSkills(
  host: SkillHostContext,
  options: SkillsInstallOptions = {},
): Promise<SkillsInstall> {
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
  which: SkillsInstallOptions,
): Promise<SkillsInstall> {
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
    } catch (error) {
      problems.push(`${manifestFile}: ${messageOf(error)}`)
    }
    rmdirIfEmpty(join(dshHome, MANIFEST_DIR), problems)
    if (problems.length > 0) logLineOf(host, 'warn', `plugin skills not taken back — skill-place-failed: ${problems.join('; ')}`)
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
export function reportPlacement(host: SkillHostContext, outcome: SkillsOutcome): void {
  if (outcome.ok) {
    logLineOf(
      host,
      'info',
      `plugin skills placed — ${outcome.names.length} skill(s) under ${outcome.root} (manifest ${outcome.manifest})`,
    )
    return
  }
  logLineOf(host, 'error', `plugin skills not placed — ${outcome.code}: ${outcome.detail}`)
}

/**
 * Place the shipped skills when this line loads, and take them back out when it unloads.
 *
 * No `ctx.inject` on the skill registry: placing is a filesystem action, and waiting for a service
 * this line does not use would hold the whole panel back on a host that never mounts one — as well as
 * leave a host that does mount it with nothing said when the wait never comes. The undo hangs on
 * the effect seam, the plugin's own fiber, so whatever the composition does with the line, the files
 * go with it.
 *
 * @returns whatever the host's own seam handed back, so a caller can wait for the attempt to settle.
 */
export function installSkillsWhenReady(
  ctx: unknown,
  options: SkillsInstallOptions = {},
): unknown {
  const host = ctx as SkillHostContext
  const start = async (): Promise<() => void> => {
    const install = await installPluginSkills(host, options)
    reportPlacement(host, install.outcome)
    return install.dispose
  }
  const effect = effectOf(host)
  if (effect !== undefined) return effect(start, 'superworker: plugin skills')
  return start()
}

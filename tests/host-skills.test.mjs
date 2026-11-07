/* The skills the pf plugins ship: where they are placed, what is taken back, and which view says so.
 *
 * What is locked here is what the placement answers for, read from the place it happens:
 *
 * - one placement puts every method the plugin folders declare into the skill root DSH's filesystem
 *   provider scans (`<dshHome>/skills`, the provider's rank 400), one language per method, with the
 *   bytes of the shipped `SKILL.md` untouched — derived from the folders themselves, not from a list
 *   written down here; the pipeline plugin's three core sheets (`pf-conduct` / `pf-route` /
 *   `pf-instruct`) are part of that set, so the dispatch's `/pf-conduct` line has a skill to read on
 *   a clean machine, and a sheet a body points at (`shared/pf/`) travels inside the method's folder;
 * - the **session's own view** (`list({ cwd, scope })`, the read a session's catalog does) shows the
 *   placed copy winning every name over the old hand-copied copies at rank 500 — that catalog read is
 *   the judgement's own reading — and a bare `list()` with no layer of its own does *not*: that read
 *   cannot stand as evidence (the defect this pins);
 * - a same-name copy in a project root (rank 100) is *noted* by the session-side diagnostic — code
 *   `skill-shadowed` with both places, one logger line, no failed session — and not decided: a
 *   project root is DSH's own per-workspace override, outside this node's judgement;
 * - unloading takes back exactly what the placement manifest recorded, and nothing of anybody else's
 *   — not the old hand-copied copies, not a foreign skill in the same root. A second placement
 *   replaces the previous manifest's entries, so an upgrade leaves no earlier version behind.
 *
 * The catalog stand-in (`helpers/skill-catalog.mjs`) implements the two real packages' rules — root
 * ranks and the layer merge — over real directories, and holds the two views separately. The probe
 * readings the ranks were first taken from live in this machine's pipeline record
 * (`.pf/nodes/<uuid>/temp/`), which is not part of the repository; nothing here reads them, and the
 * cases below stand on the stand-in's rules alone.
 *
 *   node --test tests/     (npm test builds packages/pf-core first; this file imports the engine by
 *                           name, so without that build it cannot load)
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadPlugins, skillFolders } from 'pf-core'
import { apply } from '../src/host/index.ts'
import { SKILL_ROOT_RANK, manifestPathOf, shippedPluginsDir, skillRootOf } from '../src/host/skill-paths.ts'
import { readSkillFile } from '../src/host/skills/frontmatter.ts'
import { placedSkills } from '../src/host/skills/manifest.ts'
import { DEFAULT_LANGUAGE, installPluginSkills, installSkillsWhenReady } from '../src/host/skills/place.ts'
import { confirmSkillsInView } from '../src/host/skills/view.ts'
import { pinTo } from './helpers/env.mjs'
import { PRESET_SCOPE, fakeFileSystemProvider, fakeSkillRegistry } from './helpers/skill-catalog.mjs'

/** Every plugin folder's skills, as the engine reads them off this checkout. */
async function shippedPlugins() {
  const scan = await loadPlugins(shippedPluginsDir())
  return scan.folders
}

/** The method names the shipped skill folders declare, one per method (both languages declare the same method). */
async function declaredMethods() {
  const methods = new Set()
  for (const folder of await shippedPlugins()) for (const skill of skillFolders(folder)) methods.add(skill.method)
  return [...methods].sort()
}

/** The shipped `SKILL.md` file of one method, in the default language. */
async function shippedSkillFile(method) {
  for (const folder of await shippedPlugins()) {
    for (const skill of skillFolders(folder)) {
      if (skill.method === method && skill.lang === DEFAULT_LANGUAGE) return join(skill.folder, 'SKILL.md')
    }
  }
  throw new Error(`no shipped ${DEFAULT_LANGUAGE} skill folder for ${method}`)
}

/** A home pair per case: the DSH home this line places under, and the agents home the old copies live in. */
function homes() {
  const base = mkdtempSync(join(tmpdir(), 'pf-skills-'))
  const dsh = join(base, 'home')
  const agents = join(base, 'agents')
  mkdirSync(dsh, { recursive: true })
  mkdirSync(agents, { recursive: true })
  return { base, dsh, agents, clean: () => rmSync(base, { recursive: true, force: true }) }
}

/** One skill as the provider sees it: a directory bundle with a frontmatter block naming it. */
function shipSkill(root, name, { description = `${name}, somebody else's copy` } = {}) {
  const folder = join(root, name)
  mkdirSync(folder, { recursive: true })
  const file = join(folder, 'SKILL.md')
  writeFileSync(file, `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`, 'utf8')
  return file
}

/** The logger a placement reports through, with every line kept for the assertion. */
function recordingLogger() {
  const lines = []
  return {
    lines,
    logger: {
      info: (line) => lines.push(`info: ${line}`),
      warn: (line) => lines.push(`warn: ${line}`),
      error: (line) => lines.push(`error: ${line}`),
    },
  }
}

/** The stand-in catalog with the provider mounted exactly where this composition mounts it: a preset layer. */
async function sessionCatalog(h) {
  const provider = fakeFileSystemProvider({ dshHome: h.dsh, agentsHome: h.agents })
  const registry = fakeSkillRegistry({ mounts: [{ layer: 'preset', scope: PRESET_SCOPE, provider }] })
  return { provider, registry }
}

/** The workspace the session reads in: its own directory, a project root as far as the provider is concerned. */
function workspaceOf(h) {
  const workspace = join(h.base, 'workspace')
  mkdirSync(workspace, { recursive: true })
  return workspace
}

test('Installing once: skills land in the root DSH reads skills from, the manifest records name, dir and every file, one set per method', async () => {
  const h = homes()
  try {
    const install = await installPluginSkills({}, { dshHome: h.dsh })
    assert.equal(install.outcome.ok, true, `install refused: ${JSON.stringify(install.outcome)}`)

    const declared = await declaredMethods()
    assert.ok(declared.length > 0, 'the shipped plugin folders declare no skill at all')
    assert.deepEqual([...install.outcome.names].sort(), declared, 'the installed names do not match what the plugin folders declare')

    const root = skillRootOf(h.dsh)
    assert.equal(install.outcome.root, root)
    for (const name of declared) {
      const placed = join(root, name, 'SKILL.md')
      assert.ok(existsSync(placed), `${name}: SKILL.md was not placed under ${root}`)
      /* Installing is copying, byte for byte: the text the model reads is never rewritten on the way. */
      assert.deepEqual(readFileSync(placed), readFileSync(await shippedSkillFile(name)), `${name}: installing changed the text`)
    }
    /* The siblings a skill points at travel with it (`pool.md`, `scan.md`, `anti-patterns.md`). */
    assert.ok(existsSync(join(root, 'pf-issue-repair', 'pool.md')), 'the sibling a skill points at was not installed')

    /* The dispatch's first line is `/pf-conduct <node>`, so that method has to be in the catalog on a
     * clean machine: the three core sheets come from the pipeline plugin, beside the four the issue
     * and test-audit plugins ship. */
    for (const name of ['pf-conduct', 'pf-route', 'pf-instruct']) {
      assert.ok(declared.includes(name), `${name}: the release plugin folders carry no such core skill`)
      assert.ok(existsSync(join(root, name, 'SKILL.md')), `${name}: SKILL.md was not placed under ${root}`)
    }
    /* A sheet the body points at lands inside the method's own folder: the placed root is
     * `<dshHome>/skills/<method>/`, so `../shared/pf/` would point outside the skill. */
    assert.ok(
      existsSync(join(root, 'pf-conduct', 'shared', 'pf', 'subagents.md')),
      'the shared sheet pf-conduct points at was not installed',
    )
    assert.ok(
      existsSync(join(root, 'pf-route', 'shared', 'pf', 'toolcraft.md')),
      'the shared sheet pf-route points at was not installed',
    )
    for (const name of ['pf-conduct', 'pf-route']) {
      assert.equal(
        readFileSync(join(root, name, 'SKILL.md'), 'utf8').includes('../shared/pf/'),
        false,
        `${name}: the placed body still points outside the skill directory`,
      )
    }

    const manifest = JSON.parse(readFileSync(install.outcome.manifest, 'utf8'))
    assert.equal(manifest.root, root)
    assert.deepEqual(manifest.skills.map((one) => one.name).sort(), declared)
    for (const one of manifest.skills) {
      assert.equal(one.dir, one.name)
      assert.ok(one.files.length > 0)
      for (const file of one.files) assert.ok(file.startsWith(`${one.name}/`), `${file} in the manifest is not under ${one.name}/`)
    }
    /* The record sits outside the skill root: the provider must never scan it as a skill. */
    assert.equal(install.outcome.manifest.startsWith(root), false, 'the manifest went inside the skill root and would be scanned as a skill')
    install.dispose()
  } finally {
    h.clean()
  }
})

test('Self-contained: the three core skills each carry the sheets they reference, and every reference in the body is inside their own directory', async () => {
  const h = homes()
  try {
    const install = await installPluginSkills({}, { dshHome: h.dsh })
    assert.equal(install.outcome.ok, true, `install refused: ${JSON.stringify(install.outcome)}`)
    const root = skillRootOf(h.dsh)
    /* The placed root is `<dshHome>/skills/<method>/`, so a body that still said `../shared/pf/...`
     * would point outside the skill: the placement carries each method's own sheets into its folder
     * and ships the body with the in-folder form. */
    for (const name of ['pf-conduct', 'pf-route', 'pf-instruct']) {
      const body = readFileSync(join(root, name, 'SKILL.md'), 'utf8')
      assert.equal(body.includes('../shared/pf/'), false, `${name}: the placed body still points outside the skill directory`)
      const referenced = new Set([...body.matchAll(/shared\/pf\/([a-z-]+)\.md/gu)].map((m) => m[1]))
      for (const sheet of referenced) {
        assert.ok(
          existsSync(join(root, name, 'shared', 'pf', `${sheet}.md`)),
          `${name}: the shared/pf/${sheet}.md the body references was not placed inside its own directory`,
        )
      }
    }
    /* Only the sheets a method's own body names travel with it. */
    assert.ok(
      existsSync(join(root, 'pf-route', 'shared', 'pf', 'philosophy.md')),
      'pf-route: the philosophy.md the body references was not placed',
    )
    assert.equal(existsSync(join(root, 'pf-instruct', 'shared')), false, 'pf-instruct references nothing and still carried a sheet')
    /* Unloading takes the directories the placement made, not only the files: an emptied folder left
     * behind would be litter under the skill root for every install cycle. */
    install.dispose()
    for (const name of ['pf-conduct', 'pf-route', 'pf-instruct']) {
      assert.equal(existsSync(join(root, name)), false, `${name}: the directory is still in the skill root after uninstall`)
    }
  } finally {
    h.clean()
  }
})

test('The two copies of a shared sheet are byte-identical: subagents.md is kept in both pf-conduct and pf-route, zh and en each paired', () => {
  /* The placement rule ("each skill carries the sheets it references") keeps this page duplicated
   * on purpose — the guard here is that the copies never drift. A link cannot replace the second
   * copy: the sheet has to travel inside the method's own folder. */
  const plugins = shippedPluginsDir()
  for (const lang of ['zh', 'en']) {
    const pages = ['pf-conduct', 'pf-route'].map(
      (method) => join(plugins, 'pipeline', 'skills', lang, method, 'shared', 'pf', 'subagents.md'),
    )
    for (const page of pages) assert.ok(existsSync(page), `${lang}: ${page} is not on disk`)
    assert.deepEqual(readFileSync(pages[0]), readFileSync(pages[1]), `${lang}: the two subagents.md copies drifted apart byte-wise`)
  }
})

test('The session view (C1): rank 400 outranks the old hand-copied copy at 500, that name is the plugin copy alone; the old copy file untouched', async () => {
  const h = homes()
  try {
    const install = await installPluginSkills({}, { dshHome: h.dsh })
    assert.equal(install.outcome.ok, true, `install refused: ${JSON.stringify(install.outcome)}`)
    const declared = [...install.outcome.names]
    const target = declared[0]
    assert.ok(target !== undefined)
    /* The old hand-copied copy, exactly where the review found it winning: `<agentsHome>/skills`, rank 500. */
    const oldCopy = shipSkill(join(h.agents, 'skills'), target, { description: 'the old hand-copied copy' })
    const workspace = workspaceOf(h)
    const { registry } = await sessionCatalog(h)

    const session = await registry.list({ cwd: workspace, scope: PRESET_SCOPE })
    const forTarget = session.filter((entry) => entry.name === target)
    assert.equal(forTarget.length, 1, `two entries coexist under one name: ${JSON.stringify(forTarget)}`)
    assert.ok(
      forTarget[0].path.startsWith(skillRootOf(h.dsh)),
      `the entry the session sees is not the plugin copy: ${forTarget[0].path}`,
    )
    assert.equal(forTarget[0].source, 'user-dsh')
    assert.equal(forTarget[0].rank, SKILL_ROOT_RANK)
    for (const name of declared) {
      const winner = session.find((entry) => entry.name === name)
      assert.ok(winner !== undefined && winner.path.startsWith(skillRootOf(h.dsh)), `${name}: what wins in the session is not the plugin copy`)
    }
    assert.ok(existsSync(oldCopy), 'the old copy file was touched')

    const checked = await confirmSkillsInView({ skills: registry }, { cwd: workspace, scope: PRESET_SCOPE }, { dshHome: h.dsh })
    assert.equal(checked.ok, true, `the session-view readback is not ours: ${JSON.stringify(checked)}`)
    assert.deepEqual([...checked.names].sort(), declared, 'the names read back do not match what was installed')
    install.dispose()
  } finally {
    h.clean()
  }
})

test('C1 regression: a read with no arguments and no scope cannot see the session-layer provider, so it is no evidence of success', async () => {
  const h = homes()
  try {
    const install = await installPluginSkills({}, { dshHome: h.dsh })
    assert.equal(install.outcome.ok, true, `install refused: ${JSON.stringify(install.outcome)}`)
    const { registry } = await sessionCatalog(h)

    /* The read the install used to trust: global layer only, no cwd, no scope. */
    const bare = await registry.list()
    assert.deepEqual(bare, [], 'the bare readback actually saw the session-layer provider (this case premise is wrong)')

    const checked = await confirmSkillsInView({ skills: registry }, {}, { dshHome: h.dsh })
    assert.equal(checked.ok, false, 'a bare readback was taken for session-view evidence')
    assert.equal(checked.code, 'skill-shadowed')
    assert.match(checked.detail, new RegExp(install.outcome.names[0], 'u'))
    install.dispose()
  } finally {
    h.clean()
  }
})

test('Shadowed (diagnostic): when the project root (rank 100) outranks ours, the session-view readback answers skill-shadowed and names both places', async () => {
  const h = homes()
  try {
    const install = await installPluginSkills({}, { dshHome: h.dsh })
    assert.equal(install.outcome.ok, true, `install refused: ${JSON.stringify(install.outcome)}`)
    const target = install.outcome.names[0]
    const workspace = workspaceOf(h)
    const projectCopy = shipSkill(join(workspace, '.dsh', 'skills'), target)
    const { registry } = await sessionCatalog(h)

    /* The project root outranks the skill root within the same provider scan: 100 against 400. */
    const session = await registry.list({ cwd: workspace, scope: PRESET_SCOPE })
    assert.equal(session.find((entry) => entry.name === target)?.path, projectCopy)

    const reading = await confirmSkillsInView({ skills: registry }, { cwd: workspace, scope: PRESET_SCOPE }, { dshHome: h.dsh })
    assert.equal(reading.ok, false, `shadowed but no reading left behind: ${JSON.stringify(reading)}`)
    assert.equal(reading.code, 'skill-shadowed')
    assert.match(reading.detail, new RegExp(target, 'u'), 'the reading does not name that skill')
    assert.ok(
      reading.detail.includes(join(skillRootOf(h.dsh), target, 'SKILL.md')),
      'the reading does not name where this plugin placed it',
    )
    assert.ok(reading.detail.includes(projectCopy), 'the reading does not name the shadowing copy')
    assert.match(reading.detail, /project-dsh/u, 'the reading does not name the winning source')
    install.dispose()
  } finally {
    h.clean()
  }
})

test('Uninstalling: only what the manifest holds is taken back, somebody else\'s skill and the old hand-copied copy stay untouched, and that name in the session falls back to the old copy', async () => {
  const h = homes()
  try {
    const foreign = shipSkill(join(h.dsh, 'skills'), 'someone-elses-skill')
    const install = await installPluginSkills({}, { dshHome: h.dsh })
    assert.equal(install.outcome.ok, true, `install refused: ${JSON.stringify(install.outcome)}`)
    const target = install.outcome.names[0]
    const oldCopy = shipSkill(join(h.agents, 'skills'), target, { description: 'the old hand-copied copy' })
    const workspace = workspaceOf(h)
    const { registry } = await sessionCatalog(h)

    install.dispose()
    for (const name of install.outcome.names) {
      assert.equal(existsSync(join(skillRootOf(h.dsh), name)), false, `${name} is still in the skill root after uninstall`)
    }
    assert.ok(existsSync(foreign), 'uninstalling took somebody else\'s skill too')
    assert.ok(existsSync(oldCopy), 'uninstalling touched the old hand-copied copy')
    assert.equal(existsSync(manifestPathOf(h.dsh)), false, 'the manifest is still there after uninstall')
    assert.deepEqual(placedSkills(h.dsh).manifest.skills, [], 'the manifest still records something after uninstall')

    /* What a session sees afterwards: nothing of ours under our root any more; the name with the old
     * copy falls back to that copy, and the foreign skill is still there. */
    const session = await registry.list({ cwd: workspace, scope: PRESET_SCOPE })
    assert.equal(session.find((entry) => entry.name === target)?.source, 'user-agents')
    assert.ok(session.find((entry) => entry.name === 'someone-elses-skill') !== undefined)

    install.dispose()
    assert.equal(existsSync(foreign), true, 'uninstalling again wiped somebody else\'s skill')
  } finally {
    h.clean()
  }
})

test('Upgrade: the old version the previous manifest recorded is taken back first, then the new one goes in — nothing of the old stays', async () => {
  const h = homes()
  try {
    const root = skillRootOf(h.dsh)
    const stale = join(root, 'pf-old-version')
    mkdirSync(stale, { recursive: true })
    writeFileSync(join(stale, 'SKILL.md'), '---\nname: pf-old-version\ndescription: gone\n---\n', 'utf8')
    writeFileSync(join(stale, 'old.md'), 'old\n', 'utf8')
    mkdirSync(join(h.dsh, 'pathfinder'), { recursive: true })
    writeFileSync(
      manifestPathOf(h.dsh),
      JSON.stringify({
        version: 1,
        root,
        skills: [{ name: 'pf-old-version', dir: 'pf-old-version', files: ['pf-old-version/SKILL.md', 'pf-old-version/old.md'] }],
      }),
      'utf8',
    )

    const install = await installPluginSkills({}, { dshHome: h.dsh })
    assert.equal(install.outcome.ok, true, `install refused: ${JSON.stringify(install.outcome)}`)
    assert.equal(existsSync(stale), false, 'the old version this plugin installed last time is still on disk')
    for (const name of install.outcome.names) assert.ok(existsSync(join(root, name, 'SKILL.md')))
    install.dispose()
  } finally {
    h.clean()
  }
})

test('Somebody already holds our name in the same root: no overwrite, no coexistence, skill-shadowed naming both places', async () => {
  const h = homes()
  try {
    const [first] = await declaredMethods()
    assert.ok(first !== undefined, 'the plugin set declares no skills')
    const held = shipSkill(join(h.dsh, 'skills'), first, { description: 'somebody else put this here' })

    const install = await installPluginSkills({}, { dshHome: h.dsh })
    assert.equal(install.outcome.ok, false, `the name was taken and it installed anyway: ${JSON.stringify(install.outcome)}`)
    assert.equal(install.outcome.code, 'skill-shadowed')
    assert.match(install.outcome.detail, new RegExp(first, 'u'), 'the error does not name that skill')
    assert.ok(install.outcome.detail.includes(held), 'the error does not name the copy holding the name')
    assert.match(readFileSync(held, 'utf8'), /somebody else put this here/u, 'somebody else\'s skill was overwritten')
  } finally {
    h.clean()
  }
})

test('Name clash: two plugins ship the same skill name, the install errors and names both', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pf-skill-conflict-'))
  try {
    const ship = (plugin, lang, method) => {
      const folder = join(dir, plugin, 'skills', lang, method)
      mkdirSync(folder, { recursive: true })
      writeFileSync(join(dir, plugin, 'plugin.json'), JSON.stringify({ name: plugin }), 'utf8')
      writeFileSync(join(folder, 'SKILL.md'), `---\nname: ${method}\ndescription: ${plugin}'s ${method}\n---\n\n# ${method}\n`, 'utf8')
    }
    ship('first-plugin', 'zh', 'pf-taken-name')
    ship('second-plugin', 'en', 'pf-taken-name')

    const h = homes()
    const install = await installPluginSkills({}, { dshHome: h.dsh, pluginsDir: dir })
    h.clean()

    assert.equal(install.outcome.ok, false, 'two plugins ship the same skill name and the install did not error')
    assert.equal(install.outcome.code, 'skill-conflict')
    assert.match(install.outcome.detail, /first-plugin/u, 'the error does not name the first plugin')
    assert.match(install.outcome.detail, /second-plugin/u, 'the error does not name the second plugin')
    assert.match(install.outcome.detail, /pf-taken-name/u, 'the error does not name that skill')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('A frontmatter that is not shaped right: it does not install, and the file is named', async () => {
  const reading = readSkillFile('---\nname: pf-no-description\n---\n\nbody\n')
  assert.equal(reading.ok, false, 'a frontmatter with no description was read as a skill')
  assert.match(reading.detail, /description/u)

  const dir = mkdtempSync(join(tmpdir(), 'pf-skill-nameless-'))
  const h = homes()
  try {
    const folder = join(dir, 'shipper', 'skills', 'zh', 'pf-renamed')
    mkdirSync(folder, { recursive: true })
    writeFileSync(join(dir, 'shipper', 'plugin.json'), JSON.stringify({ name: 'shipper' }), 'utf8')
    writeFileSync(join(folder, 'SKILL.md'), '---\nname: pf-other-name\ndescription: names itself something else\n---\n', 'utf8')
    const install = await installPluginSkills({}, { dshHome: h.dsh, pluginsDir: dir })
    assert.equal(install.outcome.ok, false)
    assert.equal(install.outcome.code, 'skill-unreadable')
    assert.match(install.outcome.detail, /pf-renamed/u, 'the error does not name that folder')
    assert.match(install.outcome.detail, /pf-other-name/u, 'the error does not name the name written in the file')
    assert.equal(existsSync(join(skillRootOf(h.dsh), 'pf-other-name')), false, 'it errored and wrote anyway')
  } finally {
    rmSync(dir, { recursive: true, force: true })
    h.clean()
  }
})

test('A missing plugin directory, a broken manifest: both are decidable, and nothing is written', async () => {
  const h = homes()
  try {
    const empty = await installPluginSkills({}, { dshHome: h.dsh, pluginsDir: join(h.base, 'no-such-plugins') })
    assert.equal(empty.outcome.ok, false)
    assert.equal(empty.outcome.code, 'skills-missing')

    mkdirSync(join(h.dsh, 'pathfinder'), { recursive: true })
    writeFileSync(manifestPathOf(h.dsh), '{ not json', 'utf8')
    const broken = await installPluginSkills({}, { dshHome: h.dsh })
    assert.equal(broken.outcome.ok, false, 'the manifest was broken and it installed anyway')
    assert.equal(broken.outcome.code, 'manifest-unreadable')
    assert.match(broken.outcome.detail, /nothing was overwritten or taken back/u)
    assert.equal(existsSync(skillRootOf(h.dsh)), false, 'the manifest was broken and it still wrote into the skill root')
  } finally {
    h.clean()
  }
})

test('The install path (m1): every install leaves one line — what was placed, where, and where the manifest is', async () => {
  const h = homes()
  try {
    const { lines, logger } = recordingLogger()
    const host = {
      logger,
      effect(execute) {
        return execute()
      },
    }
    const dispose = await installSkillsWhenReady(host, { dshHome: h.dsh })
    assert.equal(typeof dispose, 'function', 'installing did not hand back the dispose handle')
    assert.equal(lines.length, 1, `one install should report one line: ${lines.join(' / ')}`)
    assert.match(lines[0], /^info: plugin skills placed/u)
    assert.match(lines[0], /manifest/u, 'the line does not leave the manifest location')
    assert.match(lines[0], new RegExp(`${(await declaredMethods()).length} skill`, 'u'), 'the line does not say how many skills were placed')
    dispose()
    assert.equal(existsSync(manifestPathOf(h.dsh)), false)
  } finally {
    h.clean()
  }
})

test('The install path: a refusal leaves one line with its code too, no throw', async () => {
  const h = homes()
  try {
    const { lines, logger } = recordingLogger()
    const host = {
      logger,
      effect(execute) {
        return execute()
      },
    }
    await installSkillsWhenReady(host, { dshHome: h.dsh, pluginsDir: join(h.base, 'no-such-plugins') })
    assert.equal(lines.length, 1, `a refusal should report one line: ${lines.join(' / ')}`)
    assert.match(lines[0], /^error: plugin skills not placed — skills-missing/u)
  } finally {
    h.clean()
  }
})

test('A host with no effect seam and no logger: this install still goes through, the dispose handle comes straight back, no throw', async () => {
  const h = homes()
  try {
    const dispose = await installSkillsWhenReady({}, { dshHome: h.dsh })
    assert.equal(typeof dispose, 'function')
    assert.ok(existsSync(join(skillRootOf(h.dsh), (await declaredMethods())[0], 'SKILL.md')))
    dispose()
    assert.equal(existsSync(manifestPathOf(h.dsh)), false)
  } finally {
    h.clean()
  }
})

test('apply: the skill install hangs on this line\'s own fiber, on disk once installed, gone once the fiber is torn off', async () => {
  const h = homes()
  const unpin = pinTo(h.dsh, ['DSH_HOME'])
  try {
    const reported = []
    let provided
    const pending = apply({
      workspaceFiles: {},
      sessions: { get: () => undefined },
      sandboxPolicy: { workspaceRoot: '' },
      get: () => undefined,
      provide(name, value) {
        provided = { name, value }
      },
      logger: { info: (line) => reported.push(line), warn: (line) => reported.push(line), error: (line) => reported.push(line) },
      effect(execute) {
        return execute()
      },
    })
    const dispose = await pending
    assert.equal(provided.name, 'pathfinder')
    assert.equal(reported.length, 1, `a finished install should leave one line: ${reported.join(' / ')}`)
    assert.deepEqual(
      placedSkills(h.dsh).manifest.skills.map((one) => one.name).sort(),
      (await declaredMethods()).sort(),
    )
    dispose()
    assert.equal(existsSync(manifestPathOf(h.dsh)), false)
  } finally {
    unpin()
    h.clean()
  }
})
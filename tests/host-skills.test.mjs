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
 * ranks and the layer merge — over real directories, and holds the two views separately; the raw
 * readings taken against the installed packages themselves live beside the node record
 * (`temp/fix-scope-probe-raw.txt`, from the fix round that established them).
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
import {
  DEFAULT_LANGUAGE,
  SKILL_ROOT_RANK,
  confirmSkillsInView,
  installPluginSkills,
  installSkillsWhenReady,
  manifestPathOf,
  placedSkills,
  readSkillFile,
  shippedPluginsDir,
  skillRootOf,
} from '../src/host/skills.ts'
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

test('装一次：技能进了 DSH 读技能的那个根，清单把名字、目录、每个文件都记下，一个方法一套', async () => {
  const h = homes()
  try {
    const install = await installPluginSkills({}, { dshHome: h.dsh })
    assert.equal(install.outcome.ok, true, `install refused: ${JSON.stringify(install.outcome)}`)

    const declared = await declaredMethods()
    assert.ok(declared.length > 0, 'the shipped plugin folders declare no skill at all')
    assert.deepEqual([...install.outcome.names].sort(), declared, '装下的名字与插件文件夹声明的那几个对不上')

    const root = skillRootOf(h.dsh)
    assert.equal(install.outcome.root, root)
    for (const name of declared) {
      const placed = join(root, name, 'SKILL.md')
      assert.ok(existsSync(placed), `${name}: SKILL.md 没放进 ${root}`)
      /* Installing is copying, byte for byte: the text the model reads is never rewritten on the way. */
      assert.deepEqual(readFileSync(placed), readFileSync(await shippedSkillFile(name)), `${name}: 装的时候动了文本`)
    }
    /* The siblings a skill points at travel with it (`pool.md`, `scan.md`, `anti-patterns.md`). */
    assert.ok(existsSync(join(root, 'pf-issue-repair', 'pool.md')), '技能指向的兄弟文件没跟着装')

    /* The dispatch's first line is `/pf-conduct <node>`, so that method has to be in the catalog on a
     * clean machine: the three core sheets come from the pipeline plugin, beside the four the issue
     * and test-audit plugins ship. */
    for (const name of ['pf-conduct', 'pf-route', 'pf-instruct']) {
      assert.ok(declared.includes(name), `${name}: 发布件的插件文件夹里没有这份核心技能`)
      assert.ok(existsSync(join(root, name, 'SKILL.md')), `${name}: SKILL.md 没放进 ${root}`)
    }
    /* A sheet the body points at lands inside the method's own folder: the placed root is
     * `<dshHome>/skills/<method>/`, so `../shared/pf/` would point outside the skill. */
    assert.ok(
      existsSync(join(root, 'pf-conduct', 'shared', 'pf', 'subagents.md')),
      'pf-conduct 指向的共享单页没跟着装',
    )
    assert.ok(
      existsSync(join(root, 'pf-route', 'shared', 'pf', 'toolcraft.md')),
      'pf-route 指向的共享单页没跟着装',
    )
    for (const name of ['pf-conduct', 'pf-route']) {
      assert.equal(
        readFileSync(join(root, name, 'SKILL.md'), 'utf8').includes('../shared/pf/'),
        false,
        `${name}: 装进去的正文还在往技能目录外面指`,
      )
    }

    const manifest = JSON.parse(readFileSync(install.outcome.manifest, 'utf8'))
    assert.equal(manifest.root, root)
    assert.deepEqual(manifest.skills.map((one) => one.name).sort(), declared)
    for (const one of manifest.skills) {
      assert.equal(one.dir, one.name)
      assert.ok(one.files.length > 0)
      for (const file of one.files) assert.ok(file.startsWith(`${one.name}/`), `清单里的 ${file} 不在 ${one.name}/ 下`)
    }
    /* The record sits outside the skill root: the provider must never scan it as a skill. */
    assert.equal(install.outcome.manifest.startsWith(root), false, '清单写进了技能根，会被当成一条技能')
    install.dispose()
  } finally {
    h.clean()
  }
})

test('自足：三份核心技能装进去后各自带着它引用的单页，正文里的每一处引用都在自己目录里', async () => {
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
      assert.equal(body.includes('../shared/pf/'), false, `${name}: 装进去的正文还在往技能目录外面指`)
      const referenced = new Set([...body.matchAll(/shared\/pf\/([a-z-]+)\.md/gu)].map((m) => m[1]))
      for (const sheet of referenced) {
        assert.ok(
          existsSync(join(root, name, 'shared', 'pf', `${sheet}.md`)),
          `${name}: 正文引用的 shared/pf/${sheet}.md 没跟着装进它自己的目录`,
        )
      }
    }
    /* Only the sheets a method's own body names travel with it. */
    assert.ok(
      existsSync(join(root, 'pf-route', 'shared', 'pf', 'philosophy.md')),
      'pf-route: 正文引用的 philosophy.md 没跟着装',
    )
    assert.equal(existsSync(join(root, 'pf-instruct', 'shared')), false, 'pf-instruct 什么都不引用，却带了一份单页')
    /* Unloading takes the directories the placement made, not only the files: an emptied folder left
     * behind would be litter under the skill root for every install cycle. */
    install.dispose()
    for (const name of ['pf-conduct', 'pf-route', 'pf-instruct']) {
      assert.equal(existsSync(join(root, name)), false, `${name}: 卸载后目录还留在技能根里`)
    }
  } finally {
    h.clean()
  }
})

test('会话视角（C1）：rank 400 压过旧手抄副本 500，那个名字只剩插件这份；旧副本的文件没动', async () => {
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
    assert.equal(forTarget.length, 1, `同一个名字两条并存：${JSON.stringify(forTarget)}`)
    assert.ok(
      forTarget[0].path.startsWith(skillRootOf(h.dsh)),
      `会话看到的那条不是插件这份：${forTarget[0].path}`,
    )
    assert.equal(forTarget[0].source, 'user-dsh')
    assert.equal(forTarget[0].rank, SKILL_ROOT_RANK)
    for (const name of declared) {
      const winner = session.find((entry) => entry.name === name)
      assert.ok(winner !== undefined && winner.path.startsWith(skillRootOf(h.dsh)), `${name}: 会话里赢的不是插件这份`)
    }
    assert.ok(existsSync(oldCopy), '旧副本的文件被动过')

    const checked = await confirmSkillsInView({ skills: registry }, { cwd: workspace, scope: PRESET_SCOPE }, { dshHome: h.dsh })
    assert.equal(checked.ok, true, `会话视角的读回不是我们这份：${JSON.stringify(checked)}`)
    assert.deepEqual([...checked.names].sort(), declared, '读回来的名字与装进去的对不上')
    install.dispose()
  } finally {
    h.clean()
  }
})

test('C1 回归：无参、无 scope 的读回看不到会话层的 provider，因此不能当成功证据', async () => {
  const h = homes()
  try {
    const install = await installPluginSkills({}, { dshHome: h.dsh })
    assert.equal(install.outcome.ok, true, `install refused: ${JSON.stringify(install.outcome)}`)
    const { registry } = await sessionCatalog(h)

    /* The read the install used to trust: global layer only, no cwd, no scope. */
    const bare = await registry.list()
    assert.deepEqual(bare, [], '无参读回居然看到了会话层的 provider（这条用例的前提就错了）')

    const checked = await confirmSkillsInView({ skills: registry }, {}, { dshHome: h.dsh })
    assert.equal(checked.ok, false, '无参读回被当成了会话视角的证据')
    assert.equal(checked.code, 'skill-shadowed')
    assert.match(checked.detail, new RegExp(install.outcome.names[0], 'u'))
    install.dispose()
  } finally {
    h.clean()
  }
})

test('遮蔽（诊断）：project 根（rank 100）压过我们这份时，会话视角的读回给 skill-shadowed 并点名两处', async () => {
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
    assert.equal(reading.ok, false, `被遮蔽了却没留下读数：${JSON.stringify(reading)}`)
    assert.equal(reading.code, 'skill-shadowed')
    assert.match(reading.detail, new RegExp(target, 'u'), '读数没点名那个技能')
    assert.ok(
      reading.detail.includes(join(skillRootOf(h.dsh), target, 'SKILL.md')),
      '读数没写出插件自己放的那一处',
    )
    assert.ok(reading.detail.includes(projectCopy), '读数没写出遮蔽方的那一处')
    assert.match(reading.detail, /project-dsh/u, '读数没点名胜出方的 source')
    install.dispose()
  } finally {
    h.clean()
  }
})

test('卸：只摘清单里的，别人的技能与旧手抄副本一个不动，会话里那个名字回到旧副本', async () => {
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
      assert.equal(existsSync(join(skillRootOf(h.dsh), name)), false, `${name} 卸载后还留在技能根里`)
    }
    assert.ok(existsSync(foreign), '卸载把别人的技能也带走了')
    assert.ok(existsSync(oldCopy), '卸载动了旧手抄副本')
    assert.equal(existsSync(manifestPathOf(h.dsh)), false, '卸载后清单还留着')
    assert.deepEqual(placedSkills(h.dsh).manifest.skills, [], '卸载后清单里还记着东西')

    /* What a session sees afterwards: nothing of ours under our root any more; the name with the old
     * copy falls back to that copy, and the foreign skill is still there. */
    const session = await registry.list({ cwd: workspace, scope: PRESET_SCOPE })
    assert.equal(session.find((entry) => entry.name === target)?.source, 'user-agents')
    assert.ok(session.find((entry) => entry.name === 'someone-elses-skill') !== undefined)

    install.dispose()
    assert.equal(existsSync(foreign), true, '再摘一次把别人的技能弄没了')
  } finally {
    h.clean()
  }
})

test('升级：上一次清单记的旧版本先摘掉，新的一份再放进去 —— 旧版本不留', async () => {
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
    assert.equal(existsSync(stale), false, '插件自己上一次装的旧版本还留在盘上')
    for (const name of install.outcome.names) assert.ok(existsSync(join(root, name, 'SKILL.md')))
    install.dispose()
  } finally {
    h.clean()
  }
})

test('同一个根里已经有人占了我们的名字：不覆盖、不并存，报 skill-shadowed 点名两处', async () => {
  const h = homes()
  try {
    const [first] = await declaredMethods()
    assert.ok(first !== undefined, 'the plugin set declares no skills')
    const held = shipSkill(join(h.dsh, 'skills'), first, { description: 'somebody else put this here' })

    const install = await installPluginSkills({}, { dshHome: h.dsh })
    assert.equal(install.outcome.ok, false, `占了名字却照样装：${JSON.stringify(install.outcome)}`)
    assert.equal(install.outcome.code, 'skill-shadowed')
    assert.match(install.outcome.detail, new RegExp(first, 'u'), '报错没点名那个技能')
    assert.ok(install.outcome.detail.includes(held), '报错没点名占着名字的那一处')
    assert.match(readFileSync(held, 'utf8'), /somebody else put this here/u, '把别人的技能覆盖了')
  } finally {
    h.clean()
  }
})

test('撞名：两个插件交同一个技能名，装载报错并点名是哪两个', async () => {
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

    assert.equal(install.outcome.ok, false, '两个插件交同一个技能名，装载却没报错')
    assert.equal(install.outcome.code, 'skill-conflict')
    assert.match(install.outcome.detail, /first-plugin/u, '报错没点名第一个插件')
    assert.match(install.outcome.detail, /second-plugin/u, '报错没点名第二个插件')
    assert.match(install.outcome.detail, /pf-taken-name/u, '报错没点名那个技能')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('前端面不成样子：装不上，并点名是哪个文件', async () => {
  const reading = readSkillFile('---\nname: pf-no-description\n---\n\nbody\n')
  assert.equal(reading.ok, false, '没有 description 的前端面被当成技能读了')
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
    assert.match(install.outcome.detail, /pf-renamed/u, '报错没点名那个文件夹')
    assert.match(install.outcome.detail, /pf-other-name/u, '报错没点名文件里写的名字')
    assert.equal(existsSync(join(skillRootOf(h.dsh), 'pf-other-name')), false, '报错了还是写进去了')
  } finally {
    rmSync(dir, { recursive: true, force: true })
    h.clean()
  }
})

test('缺插件目录、清单坏了：都可判定，且什么都不写', async () => {
  const h = homes()
  try {
    const empty = await installPluginSkills({}, { dshHome: h.dsh, pluginsDir: join(h.base, 'no-such-plugins') })
    assert.equal(empty.outcome.ok, false)
    assert.equal(empty.outcome.code, 'skills-missing')

    mkdirSync(join(h.dsh, 'pathfinder'), { recursive: true })
    writeFileSync(manifestPathOf(h.dsh), '{ not json', 'utf8')
    const broken = await installPluginSkills({}, { dshHome: h.dsh })
    assert.equal(broken.outcome.ok, false, '清单坏了却照样装')
    assert.equal(broken.outcome.code, 'manifest-unreadable')
    assert.match(broken.outcome.detail, /nothing was overwritten or taken back/u)
    assert.equal(existsSync(skillRootOf(h.dsh)), false, '清单坏了还往技能根里写')
  } finally {
    h.clean()
  }
})

test('装载路径（m1）：每次装载都留一行读数 —— 放了什么、放在哪、清单在哪', async () => {
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
    assert.equal(typeof dispose, 'function', '装载没把摘的手柄交回来')
    assert.equal(lines.length, 1, `一次装载该只报一行：${lines.join(' / ')}`)
    assert.match(lines[0], /^info: plugin skills placed/u)
    assert.match(lines[0], /manifest/u, '读数里没留下清单的位置')
    assert.match(lines[0], new RegExp(`${(await declaredMethods()).length} skill`, 'u'), '读数里没写装了几个')
    dispose()
    assert.equal(existsSync(manifestPathOf(h.dsh)), false)
  } finally {
    h.clean()
  }
})

test('装载路径：被拒绝时也留一行带码的读数，不抛', async () => {
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
    assert.equal(lines.length, 1, `拒绝该报一行：${lines.join(' / ')}`)
    assert.match(lines[0], /^error: plugin skills not placed — skills-missing/u)
  } finally {
    h.clean()
  }
})

test('没有 effect 接缝、也没有 logger 的宿主：这次照装，摘的手柄直接交回来，不抛', async () => {
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

test('apply：技能装载接在这条线自己的 fiber 上，装完盘上有、fiber 摘掉即摘净', async () => {
  const h = homes()
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = h.dsh
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
    assert.equal(reported.length, 1, `装好的时候该留一行读数：${reported.join(' / ')}`)
    assert.deepEqual(
      placedSkills(h.dsh).manifest.skills.map((one) => one.name).sort(),
      (await declaredMethods()).sort(),
    )
    dispose()
    assert.equal(existsSync(manifestPathOf(h.dsh)), false)
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    h.clean()
  }
})
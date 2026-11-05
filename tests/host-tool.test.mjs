/* The agent-facing `pathfinder` tool and its wake: the tool exists only for the
 * agents whose session loads a pipeline skill — by the `skill` tool's call result or
 * by a user `/pf-*` invocation — never for anyone else, and only once per agent.
 *
 * - **零常驻**: an unrelated agent's scope stays without the tool; a settled call of a
 *   tool that is not `skill`, a failed skill load, and a `/some-skill` invocation all
 *   leave the scope unarmed.
 * - **唤醒一次**: both triggers hit the same wake; a second skill load for an armed
 *   agent registers nothing more.
 * - the description the tool registers with stays at or under 400 bytes;
 * - the name lock: the registered name, the README and every markdown page the skills
 *   ship under a `skills/` tree come from one constant — the whole tree is walked, not
 *   just `SKILL.md`, and every `SKILL.md` has to name the tool at least once (without
 *   that leg a walk over a corpus that never names it would pass vacuously). A mention is
 *   the bare word: a `pathfinder` that is a segment of a path (the manifest directory) is
 *   a different constant and is not counted.
 *
 *   node --test tests/
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { apply } from '../src/host/index.ts'
import {
  PATHFINDER_TOOL_NAME,
  SKILL_NAME_PREFIX,
  argvOf,
  installToolWake,
  toolDescriptionOf,
  wakeAgent,
} from '../src/host/tool.ts'

/* Loading this line places the shipped skills into the DSH skill root; the root these
 * cases would write into is pinned to a temp home here, never the machine's own. */
const testHome = mkdtempSync(join(tmpdir(), 'pf-tool-home-'))
const previousHome = process.env.DSH_HOME
process.env.DSH_HOME = testHome
test.after(() => {
  if (previousHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = previousHome
  rmSync(testHome, { recursive: true, force: true })
})

const repo = fileURLToPath(new URL('..', import.meta.url))

/** A stand-in host context: the services by name, an event bus, and the effects it collected. */
function fakeContext() {
  const provided = {}
  const listeners = {}
  const effects = []
  const ctx = {
    provide: (service, value) => {
      provided[service] = value
    },
    on: (event, listener) => {
      ;(listeners[event] ??= []).push(listener)
      return () => {
        const held = listeners[event] ?? []
        const at = held.indexOf(listener)
        if (at >= 0) held.splice(at, 1)
      }
    },
    effect: (make) => {
      effects.push(make())
    },
    sessions: { get: () => undefined },
    sandboxPolicy: { workspaceRoot: 'C:\\tool-root' },
    get: () => undefined,
  }
  return { ctx, provided, listeners, effects }
}

/** An agent with a scoped context whose tools registry records what lands in it. */
function fakeAgent(id = 'agent-1') {
  const registered = []
  const agent = {
    id,
    ctx: {
      tools: {
        register(definition) {
          registered.push(definition)
          return () => {
            const at = registered.indexOf(definition)
            if (at >= 0) registered.splice(at, 1)
          }
        },
      },
      effect: (make) => {
        make()
      },
    },
  }
  return { agent, registered }
}

/** Settle one tool call through every `tools/post-execute` listener the context holds. */
async function firePostExecute(listeners, exec, result) {
  for (const listener of listeners['tools/post-execute'] ?? []) {
    await listener(exec, result, async () => ({ kind: 'accept' }))
  }
}

/** Propose one step through every `agent/pre-step` listener the context holds. */
async function firePreStep(listeners, payload, messages) {
  for (const listener of listeners['agent/pre-step'] ?? []) {
    await listener(payload, async () => ({ kind: 'enter', messages }))
  }
}

test('零常驻：无关工具的调用、失败的技能装载、别的技能名，都不唤醒', async () => {
  const { ctx, listeners } = fakeContext()
  apply(ctx)
  const { agent, registered } = fakeAgent()

  await firePostExecute(listeners, { name: 'bash', agent }, { isError: false })
  await firePostExecute(listeners, { name: 'skill', agent }, { isError: true })
  await firePreStep(
    listeners,
    { agent },
    [{ source: { kind: 'skill-invocation', name: 'some-skill' } }],
  )
  assert.equal(registered.length, 0, '没有任何一条触发线点亮这个 agent')
})

test('唤醒一次：skill 工具装了技能，下一轮这个 agent 的作用域里就有 pathfinder，且只有一份', async () => {
  const { ctx, listeners } = fakeContext()
  apply(ctx)
  const { agent, registered } = fakeAgent()

  await firePostExecute(listeners, { name: 'skill', agent }, { isError: false })
  assert.equal(registered.length, 1, '装一次')
  assert.equal(registered[0].name, PATHFINDER_TOOL_NAME)

  await firePostExecute(listeners, { name: 'skill', agent }, { isError: false })
  await firePreStep(listeners, { agent }, [{ source: { kind: 'skill-invocation', name: 'pf-route' } }])
  assert.equal(registered.length, 1, '同一个 agent 只有一份')
})

test('唤醒一次：用户敲 /pf-route 也走同一个唤醒，两条线不各注册各的', async () => {
  const { ctx, listeners } = fakeContext()
  apply(ctx)
  const { agent, registered } = fakeAgent()

  await firePreStep(listeners, { agent }, [
    { source: { kind: 'skill-invocation', name: 'pf-route' } },
    { source: { kind: 'skill-invocation', name: 'pf-conduct' } },
  ])
  assert.equal(registered.length, 1)
  assert.equal(registered[0].name, PATHFINDER_TOOL_NAME)
})

test('工具的形状：名字、描述字节数、参数与输出都是声明的面', () => {
  const { ctx } = fakeContext()
  const { agent, registered } = fakeAgent()
  wakeAgent(agent, { ctx })

  const tool = registered[0]
  assert.equal(tool.name, PATHFINDER_TOOL_NAME)
  assert.ok(Buffer.byteLength(tool.description, 'utf8') <= 400, `描述 ${Buffer.byteLength(tool.description, 'utf8')} 字节，上限 400`)
  assert.deepEqual(Object.keys(tool.parameters.properties ?? {}), ['word', 'args', 'help'])
  assert.deepEqual(tool.parameters.required, undefined, '没有必填参数：不枚举词名')
  assert.deepEqual(Object.keys(tool.output.schema.properties ?? {}), ['code', 'stdout', 'stderr'])
})

test('工具的四层帮助：argv 由 word / args / help 拼出，help 与 args 相加，词面自己应答', async () => {
  // 空手问，答的是整张索引；help 与没有词落在同一个词上。
  assert.deepEqual(argvOf({}), ['help'])
  assert.deepEqual(argvOf({ help: true }), ['help'])
  // 光有词、不要帮助：就是运行它。
  assert.deepEqual(argvOf({ word: 'next' }), ['next'])
  // 词 + help：这个词自己的那一页。
  assert.deepEqual(argvOf({ help: true, word: 'next' }), ['next', '--help'])
  // 词 + args + help：这一次调用的那一页 —— args 被带上，不是被丢掉。
  assert.deepEqual(argvOf({ help: true, word: 'dag', args: ['list'] }), ['dag', 'list', '--help'])
  // args 已经以 --help 收尾：沿用调用者的拼法，不追加第二个。
  assert.deepEqual(argvOf({ help: true, word: 'issue', args: ['status', '--help'] }), ['issue', 'status', '--help'])
  // --help 不在末尾：原位不动，末尾再补一个 —— 词层只把末尾那个读作求助，组词找动词时中间那个不算。
  assert.deepEqual(argvOf({ help: true, word: 'dag', args: ['--help', 'list'] }), ['dag', '--help', 'list', '--help'])
  // 没有 help：词 + args 就是运行这一次调用。
  assert.deepEqual(argvOf({ word: 'dag', args: ['list'] }), ['dag', 'list'])

  const { ctx } = fakeContext()
  const { agent, registered } = fakeAgent()
  wakeAgent(agent, { ctx })
  const answer = await registered[0].execute({ help: true }, { agent })
  assert.equal(answer.code, 0, answer.stderr)
  assert.match(answer.stdout, /pathfinder -- the agent pipeline/u, '空手问它，答的是整张索引')
})

test('名字锁：注册名、README 的拼法来自同一个常量；技能正文的拼法与它一致，且每个 SKILL.md 都点到它', () => {
  assert.equal(PATHFINDER_TOOL_NAME, 'pathfinder')
  assert.equal(SKILL_NAME_PREFIX, 'pf-')
  for (const file of ['README.md', 'README.zh.md']) {
    const text = readFileSync(join(repo, file), 'utf8')
    assert.match(text, /`pathfinder`/u, `${file} 提到这个工具时用注册处的拼写`)
  }
  // The skills live under the shipped plugins. Walk *every* markdown page in their
  // `skills/` trees — the pools and the reference pages quote command lines too — and
  // wherever one names the tool it names the registered spelling. A page that never
  // names it is not this lock's business; a `SKILL.md` that never names it is, because
  // otherwise the spelling scan passes without ever reading a spelling this phase wrote.
  const pluginsRoot = join(repo, 'packages', 'pf-core', 'plugins')
  const files = []
  const collect = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) collect(full)
      else if (entry.name.endsWith('.md')) files.push(full)
    }
  }
  const walkSkills = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const full = join(dir, entry.name)
      if (entry.name === 'skills') collect(full)
      else walkSkills(full)
    }
  }
  walkSkills(pluginsRoot)
  assert.ok(files.length >= 60, `随包技能正文都在（走到 ${files.length} 篇，至少 60）`)
  // The tool is a word, not a directory: `MANIFEST_DIR` in `src/host/skills.ts` happens
  // to spell `pathfinder` too, and a tool rename must not force the doc path to move. Keep
  // only path-free tokens — not preceded by a slash or a backslash, not followed by a
  // slash — so `<dshHome>/pathfinder/skills.json` is a path, not a spelling of the tool.
  const TOOL_MENTION = /(?<![/\\])pathfinder[A-Za-z]*(?!\/)/gu
  for (const file of files) {
    const text = readFileSync(file, 'utf8')
    const mentions = text.match(TOOL_MENTION) ?? []
    for (const spelling of mentions) {
      assert.equal(spelling, PATHFINDER_TOOL_NAME, `${file}: ${spelling} 不是注册处的拼写`)
    }
    if (file.endsWith('SKILL.md')) {
      const named = mentions.filter((spelling) => spelling === PATHFINDER_TOOL_NAME)
      assert.ok(named.length >= 1, `${file}: 没提到 ${PATHFINDER_TOOL_NAME}，名字锁就空转了`)
    }
  }
})

test('卸下：线的 effect 把两条触发线一起收走；agent 的 effect 把工具收走', async () => {
  const { ctx, listeners, effects } = fakeContext()
  apply(ctx)
  assert.equal((listeners['tools/post-execute'] ?? []).length, 1)
  assert.equal((listeners['agent/pre-step'] ?? []).length, 1)

  const { agent, registered } = fakeAgent()
  await firePostExecute(listeners, { name: 'skill', agent }, { isError: false })
  assert.equal(registered.length, 1)

  // The line's own effects: the wake's disposer is collected there, so an unload
  // takes both triggers back. (The skills placement's effect settles later and is not
  // this test's business.)
  for (const dispose of effects) if (typeof dispose === 'function') dispose()
  assert.equal((listeners['tools/post-execute'] ?? []).length, 0, 'post-execute 上的线收走了')
  assert.equal((listeners['agent/pre-step'] ?? []).length, 0, 'pre-step 上的线收走了')

  // The agent's own effect: the registration disposer is collected there.
  const { ctx: ctx2, listeners: listeners2 } = fakeContext()
  installToolWake(ctx2)
  const holder = []
  const agent2 = {
    id: 'agent-2',
    ctx: {
      tools: {
        register(definition) {
          holder.push(definition)
          return () => {
            const at = holder.indexOf(definition)
            if (at >= 0) holder.splice(at, 1)
          }
        },
      },
      effect: (make) => {
        agent2.dispose = make()
      },
    },
  }
  await firePostExecute(listeners2, { name: 'skill', agent: agent2 }, { isError: false })
  assert.equal(holder.length, 1)
  agent2.dispose()
  assert.equal(holder.length, 0, 'agent 走了，工具跟着走')
})

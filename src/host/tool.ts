/**
 * The agent-facing `superworker` tool: its face (name, description, parameters, output) and the one
 * call path behind it.
 *
 * The words themselves live in the engine (`answer` / `describe`); this file is the registration
 * half. Nothing here decides whether the tool is in front of an agent — that is the wake's business
 * (`wake.ts`), and neither side reads the other's memory. The one seam this face needs from outside
 * is the opener: a word that really opens a session (`dag open`) travels through it, and the caller
 * that builds the host hands the same seam the dispatch relay uses. Keeping it on the host face is
 * what lets this module stay out of the opener/relay/wake triangle entirely.
 *
 * Three names are pinned in one place ({@link SUPERWORKER_TOOL_NAME},
 * {@link SKILL_TOOL_NAME}, {@link SKILL_NAME_PREFIX}); the registration, the skill-body
 * scan and the README all read them, and the lock test goes red when they disagree.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { answer, describe, longResultPointerOf, type Executor } from 'superworker-core'
import { workspaceRootOf } from './seams.ts'
import { answerHandleOf } from './write.ts'

/** The agent-facing tool's name: the same spelling the skills and the README name. */
export const SUPERWORKER_TOOL_NAME = 'superworker'
/** The tool whose call result means "a skill was loaded": DSH's own skill loader. */
export const SKILL_TOOL_NAME = 'skill'
/** The prefix the pipeline's skills are named with, in the catalog and as `/superworker-*`. */
export const SKILL_NAME_PREFIX = 'superworker-'
/** The record's directory at a workspace root: the fact that says this workspace has a pipeline. */
export const PIPELINE_DIR = '.superworker'

/** The tool's parameters, as the model spells them (the words are never enumerated here). */
export interface SuperworkerToolArgs {
  readonly word?: unknown
  readonly args?: unknown
  readonly help?: unknown
}

/** The caller identity one execution carries, as far as this layer reads it. */
export interface SuperworkerToolExecution {
  readonly agent?: { readonly id?: unknown } | undefined
}

/** The definition as the registry accepts it; schemas stay structural here. */
export interface SuperworkerToolDefinition {
  readonly name: string
  readonly description: string
  readonly parameters: Record<string, unknown>
  readonly output: {
    readonly schema: Record<string, unknown>
    render(args: SuperworkerToolArgs, value: unknown): ReadonlyArray<{ readonly type: 'text'; readonly text: string }>
  }
  execute(args: SuperworkerToolArgs, exec: SuperworkerToolExecution): Promise<unknown>
}

/**
 * The description the tool registers with, generated from the engine's own index data.
 *
 * This is layer 0: the one text an agent has in context on every turn, so it has to teach the
 * recursion in the order the caller needs it — the index, a word's own page, the page of an
 * exact call (a word plus its args), and running that call. One word is named, as the example;
 * the index itself is not repeated here. The 400-byte lock (`tests/host-tool-answer.test.mjs`)
 * is the ceiling on how much teaching fits.
 */
export function toolDescriptionOf(): string {
  const index = describe()
  const what = index.shape.split('\n')[0] ?? 'superworker — the pipeline words'
  return (
    `${what}. The words answer from this session's workspace. ` +
    'help:true gives the word index; help:true plus a word gives that word\'s own page; ' +
    'help:true plus a word and its args gives that exact call\'s page (word:"dag", args:["list"] ' +
    'asks dag list --help). A word with args and no help runs it.'
  )
}

/**
 * The argv one tool call spells, in the words layer's own vocabulary.
 *
 * `help: true` composes with `args` instead of throwing them away: it asks the page of the exact
 * call the caller spelled, so `word: "issue", args: ["status"]` asks `issue status --help`, not
 * the group page. That flag rides in the line's last cell, which is how a table row and a plugin
 * word alike are asked for a call's page, so the composed call is a page; a caller who already
 * ended the line with `--help` keeps their own spelling rather than getting a second one.
 */
export function argvOf(args: SuperworkerToolArgs): string[] {
  const word = typeof args.word === 'string' && args.word !== '' ? args.word : undefined
  const rest = Array.isArray(args.args) ? args.args.filter((item): item is string => typeof item === 'string') : []
  if (args.help === true) {
    if (word === undefined) return ['help']
    return rest[rest.length - 1] === '--help' ? [word, ...rest] : [word, ...rest, '--help']
  }
  if (word === undefined) return ['help']
  return [word, ...rest]
}

/** One call's canonical value: the words layer's two streams and the exit code. */
export interface SuperworkerToolValue {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
}

/**
 * The facts one execution reads off the host: the context the seams are read through, and the opener
 * seam a word that opens a session travels through.
 *
 * The opener arrives here rather than being imported from `executor.ts` on purpose: the opener
 * imports the wake, the wake imports this face, and a direct import would close that triangle. The
 * two callers that arm an agent (the plugin entry for the event triggers, the opener for a dispatched
 * session) each hand in the seam they already hold.
 */
export interface SuperworkerToolHost {
  readonly ctx: Context
  executorOf(sessionId: SessionId, workspaceRoot: string): Executor
}

/** The tool itself: every call goes through the words layer's one `answer()`. */
export function defineSuperworkerTool(host: SuperworkerToolHost): SuperworkerToolDefinition {
  return {
    name: SUPERWORKER_TOOL_NAME,
    description: toolDescriptionOf(),
    parameters: {
      type: 'object',
      properties: {
        word: { type: 'string', description: 'the word to answer or run ("help" answers the index)' },
        args: { type: 'array', items: { type: 'string' }, description: "the rest of the line for a word that takes one" },
        help: { type: 'boolean', description: 'true: answer the index (no word), that word\'s own page (word only), or that exact call\'s page (word plus args), instead of running it' },
      },
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          code: { type: 'integer', description: 'the exit code the word answered with' },
          stdout: { type: 'string' },
          stderr: { type: 'string' },
        },
        required: ['code', 'stdout', 'stderr'],
        additionalProperties: false,
      },
      render(_args, value) {
        // The streams pass verbatim (the CLI's bytes are the contract); the one thing this
        // projection adds is the exit code spelled out when it is not zero.
        const answer = value as SuperworkerToolValue
        const text = `${answer.stdout}${answer.stderr}${answer.code === 0 ? '' : `\n(exit code ${answer.code})`}`
        return [{ type: 'text', text }]
      },
    },
    async execute(args, exec) {
      const raw = typeof exec.agent?.id === 'string' ? exec.agent.id : ''
      const sessionId = raw as SessionId
      const root = await workspaceRootOf(host.ctx, sessionId)
      const argv = argvOf(args)
      const outcome = await answer(argv, {
        ...answerHandleOf(root, { executor: host.executorOf(sessionId, root) }),
        // The tool call carries its cells as argv and owns no stream: `-o -` has no source here, so
        // it is answered with a named refusal instead of waiting on this process's stdin (which has
        // no end coming inside the host, and used to hang the whole call).
        readInput: () => Promise.reject(new Error('an agent tool call has no input stream')),
      })
      // The long-answer contract comes from the words layer, never restated here: an
      // oversized answer travels whole, with the pointer as its own last line. The word
      // a pointer is asked about is the line's first two cells (`dag list`), the way the
      // table spells a group's verb.
      const word = argv.length >= 2 ? `${argv[0]} ${argv[1]}` : (argv[0] ?? '')
      const pointer = longResultPointerOf(outcome.stdout, word)
      const stdout = pointer === null ? outcome.stdout : `${outcome.stdout}\n(${pointer})\n`
      return { code: outcome.code, stdout, stderr: outcome.stderr }
    },
  }
}

/**
 * The injection point: the constraints in force in a session's workspace, carried into every step
 * through DSH's runtime-context channel.
 *
 * DSH's prompt service takes ordered dynamic contexts and materializes them as a durable user-role
 * snapshot; the agent loop appends a new snapshot only when the rendered text changes, and restores
 * it after compaction. That is exactly the shape this line needs: no prompt-section surgery (a
 * changed section would replace the first prompt node and void the prefix cache), no per-step
 * message of its own.
 *
 * **The words are the plugin's own.** The text is what the shipped `instruction` plugin answers to
 * `instruction list` — its default read, its own visibility and position rules, at that workspace
 * root. Nothing here re-spells the reader view: the host calls the word through the same
 * `answer()` seam the panel's writes and the agent-facing tool go through, so a change to the
 * plugin's answer is a change here, with no second copy to drift.
 *
 * **Where "the record for this session" is, resolved by one function.** The word is asked with
 * `--project <root>`, which the words layer resolves through its own `projectRootOf`: a plain
 * directory answers itself, and a linked worktree's checkout leads back to the main tree that really
 * holds the account — the pipeline runs its work sessions in worktrees, and those are the sessions a
 * standing constraint has to reach. The record-presence gate below asks that same function instead of
 * keeping a second copy of the rule; asked of the raw session root, it would silence exactly the
 * worktree sessions this line exists for. In a plain project root the flag changes nothing, so the text
 * is byte for byte what `instruction list` prints when run there.
 *
 * **Four silences, and none of them is a box.** No record, a record whose entries cannot reach this
 * step, a record whose entries are all archived, and a host without the plugin each contribute
 * nothing at all — the reader view's own empty-state sentences are not injected, and no "暂无" is
 * written. With the switch off the contribution is the empty string too: not one byte.
 *
 * **The provider is synchronous, the read is not.** DSH asks a context provider for its text
 * synchronously, both at assembly and again at request admission (`refreshContext`), so this module
 * keeps the last text it computed per workspace root and hands that back. The fresh text is
 * computed at `system-prompt/assemble` — once per step, before the request — and written into that
 * assembly's own contribution, so the step that computes it is the step that carries it. A step
 * whose words did not change renders the same snapshot, which is what keeps the loop from appending
 * a duplicate.
 *
 * **The host's prompt service is optional.** Nothing here is a declared dependency: a deployment
 * without `systemPrompt` (a headless composition, an older host) registers nothing and the rest of
 * this half runs as it did. A failing word (no plugin installed, an unreadable record, a bad argv)
 * answers nothing rather than throwing into the assembly of somebody else's request.
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { answer, projectRootOf } from 'superworker-core'
import type { Context } from '@deepseek-ai/cordis'
import { RECORD_DIR } from './contract.ts'
import { answerHandleOf } from './write.ts'
import { PANEL_PREF_FIELDS } from './settings-fields.ts'
import { agentIdOf, busOf, liveWorkspaceRootOf, promptContextPortOf } from './seams.ts'

/** The contribution's name: unique among the runtime contexts this host assembles. */
export const INSTRUCTION_CONTEXT_NAME = 'superworker:instructions'

/**
 * Where it sits among the contexts: after the working directory (`100`), the sandbox and approval
 * policies (`110`, `115`) and the delegation/team facts (`120`, `125`), and before the harness-source
 * and web-surface contexts (`200`, `210`). A fact about this workspace's standing constraints reads
 * with the workspace facts, not with the deployment's own.
 */
export const INSTRUCTION_CONTEXT_ORDER = 150

/** The host's assembly waterfall: where a step's fresh text is computed and put in place. */
export const ASSEMBLE_EVENT = 'system-prompt/assemble'

/**
 * The first line of the reader view that carries entries. Every empty answer of the same word is a
 * sentence instead (`This project has no instruction record at all.`, `No instruction is visible
 * from this step.`, …), so this line is how "there is a listing" is told apart from "there is
 * nothing to carry" without re-spelling any of those sentences here.
 */
const LISTING_HEAD = /^This project has \d+ instruction\(s\) visible from this step:$/u

/** The word line the panel's instruction column and the tool answer with: the plugin's default read. */
export function instructionListArgv(root: string): readonly string[] {
  return ['instruction', 'list', '--project', root]
}

/** One word answer, as far as the text decision reads it. */
export interface WordAnswer {
  readonly code: number
  readonly stdout: string
}

/**
 * The injected text of one word answer: the reader view itself, or nothing.
 *
 * A failed answer is nothing: the word is not installed here (the plugin was moved away), or it
 * refused. An empty-state answer is nothing too — those are sentences about the absence of a record,
 * and a snapshot saying "there is no record" every step is a box drawn around nothing. What is left
 * is the listing, byte for byte, less the trailing newlines the context joiner supplies itself.
 */
export function instructionTextViewOf(said: WordAnswer): string {
  if (said.code !== 0) return ''
  const body = said.stdout.replace(/[\r\n]+$/u, '')
  if (body === '') return ''
  const firstLine = body.split('\n', 1)[0] ?? ''
  return LISTING_HEAD.test(firstLine) ? body : ''
}

/** The last text computed per workspace root: what the synchronous provider hands back. */
const carried = new Map<string, string>()

/**
 * The text to carry for one workspace root, read on the spot.
 *
 * Throws only what the words layer throws; a caller that must not disturb an assembly catches it.
 * @param root - The session's workspace root.
 */
export async function instructionContextTextOf(root: string): Promise<string> {
  const said = await answer(instructionListArgv(root), answerHandleOf(root))
  return instructionTextViewOf(said)
}

/**
 * Whether the switch is on: absent surface or absent field both read as on — the factory default is
 * "carry them".
 *
 * The switch is a volatile settings field: on the real host the resolved config hands it over as a
 * stable reference whose `get()` answers the current snapshot (schemastery wraps a volatile field
 * with cosmokit's `createVolatile`, and `apply(ctx, config)` receives that reference — the shape the
 * relay switch is pinned to in `tests/host-relay.test.mjs`). Read at the call, so a flip lands on the
 * next assembly without a reload. A plain boolean (stand-ins, older hosts that lack `.volatile()`)
 * reads as it is.
 */
function switchedOn(config: unknown): boolean {
  if (config === null || typeof config !== 'object') return true
  const held = (config as Record<string, unknown>)[PANEL_PREF_FIELDS.injectInstructions]
  const value = held !== null && typeof held === 'object' && typeof (held as { get?: unknown }).get === 'function'
    ? (held as { get: () => unknown }).get()
    : held
  return value !== false
}

/** The session's workspace root, from the agent the assembly is for: the same resolution the wake reads. */
function rootOf(ctx: Context, context: unknown): string | undefined {
  const agent = (typeof context === 'object' && context !== null ? context : {}) as { agent?: unknown }
  const proposed = agent.agent
  if (typeof proposed !== 'object' || proposed === null) return undefined
  const id = agentIdOf(proposed)
  if (id === undefined) return undefined
  return liveWorkspaceRootOf(ctx, id)
}

/**
 * Whether the resolved project root carries a record directory at all: the cheap fact that says the
 * word has something to read. The root handed in is the one the word itself would act on (a worktree
 * checkout already resolved to its main tree), not the session's raw working directory.
 */
function recordPresent(root: string): boolean {
  try {
    return existsSync(join(root, RECORD_DIR))
  } catch {
    /* An unreadable root holds no record this line can read. */
    return false
  }
}

/** The assembled contribution this module owns, as the patch below reads it. */
interface AssembledContexts {
  readonly contexts?: readonly { readonly name?: unknown; readonly text?: unknown }[]
}

/**
 * The same assembly with this module's contribution carrying `text`.
 *
 * Patching by name only: when the contribution is not in the assembly (no registered provider — the
 * host has switched optional runtime context off, or the service arrived after this line did), it is
 * left out rather than inserted at an order guessed from the other entries. An empty `text` stays in
 * place and renders to nothing: the snapshot joiner drops empty contributions by itself.
 */
export function withInstructionText(assembly: unknown, text: string): unknown {
  const held = (typeof assembly === 'object' && assembly !== null ? assembly : {}) as AssembledContexts
  const contexts = held.contexts
  if (!Array.isArray(contexts)) return assembly
  const at = contexts.findIndex((entry) => entry.name === INSTRUCTION_CONTEXT_NAME)
  if (at < 0) return assembly
  const patched = contexts.map((entry, index) => (index === at ? { ...entry, text } : entry))
  return { ...(assembly as object), contexts: patched }
}

/**
 * Install the injection: one registered contribution, and one assembly listener that keeps it
 * current.
 *
 * The provider hands back the text the previous assembly computed (and, for the very first step of a
 * session, nothing), the listener recomputes it for the step at hand and writes it into that step's
 * assembly, and the request admission that follows re-reads the provider — which now holds exactly
 * what the listener just wrote.
 *
 * @param ctx - The host context this line is applied to.
 * @param config - The line's resolved settings: the injection switch is read from it, per assembly.
 * @returns the disposer taking both off; a no-op when the host carries no prompt service.
 */
export function installInstructionContext(ctx: Context, config?: unknown): () => void {
  const prompt = promptContextPortOf(ctx)
  if (prompt === undefined) return () => undefined

  let offContribution: (() => void) | undefined
  try {
    offContribution = prompt.context({
      name: INSTRUCTION_CONTEXT_NAME,
      order: INSTRUCTION_CONTEXT_ORDER,
      text: (context: unknown) => {
        if (!switchedOn(config)) return ''
        const root = rootOf(ctx, context)
        return root === undefined ? '' : (carried.get(root) ?? '')
      },
    })
  } catch {
    /* A host that refuses the registration (a duplicate name, an assembly already in flight) has no
     * room for this contribution; the panel and the tool are unaffected. */
    offContribution = undefined
  }

  const bus = busOf(ctx)
  const offAssembly = bus === undefined
    ? undefined
    : bus.on(ASSEMBLE_EVENT, (_assembly: unknown, context: unknown, next: () => Promise<unknown>) => {
        const settled = next()
        if (!switchedOn(config)) return settled.then((result) => withInstructionText(result, ''))
        const root = rootOf(ctx, context)
        if (root === undefined) return settled.then((result) => withInstructionText(result, ''))
        /* The record is looked for where the word would look: a linked worktree's checkout resolves to
         * the main tree that holds it. A workspace whose resolved project root has no record directory
         * at all has nothing to ask about — the word is not run and the entry is emptied, which is the
         * same answer at a lower price. Keyed by the session root, so two worktrees of one main tree
         * each carry their own reading. */
        const accountRoot = projectRootOf(undefined, root)
        if (!recordPresent(accountRoot)) {
          carried.delete(root)
          return settled.then((result) => withInstructionText(result, ''))
        }
        return settled.then(async (result) => {
          let text = ''
          try {
            text = await instructionContextTextOf(root)
          } catch {
            /* The word threw (an unreadable account, a broken argv): carry nothing this step rather
             * than break somebody else's request. */
            text = ''
          }
          carried.set(root, text)
          return withInstructionText(result, text)
        })
      })

  return () => {
    try {
      if (typeof offContribution === 'function') offContribution()
    } finally {
      if (typeof offAssembly === 'function') offAssembly()
    }
  }
}
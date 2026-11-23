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
 * root and that session's own position. Nothing here re-spells the reader view: the host calls the
 * word through the same `answer()` seam the panel's writes and the agent-facing tool go through,
 * so a change to the plugin's answer is a change here, with no second copy to drift. Whether a
 * listing is held at all is judged by the plugin's own structured exit (`instruction list --json`,
 * the machine's view of the same read), never by matching the reader view's prose — a reworded or
 * localized listing still carries, and an empty-state answer still carries nothing.
 *
 * **Where "the record for this session" is, resolved by one function.** The word is asked with
 * `--project <root>`, which the words layer resolves through its own `projectRootOf`: a plain
 * directory answers itself, and a linked worktree's checkout leads back to the main tree that really
 * holds the account — the pipeline runs its work sessions in worktrees, and those are the sessions a
 * standing constraint has to reach. The record-presence gate below asks the shared record judgment
 * (`recordPresentAt` in `records.ts`) instead of keeping a second copy of the rule; asked of the raw
 * session root, it would silence exactly the worktree sessions this line exists for. In a plain
 * project root the flag changes nothing, so the text is byte for byte what `instruction list` prints
 * when run there.
 *
 * **The position the word is asked from is the session's own.** A session this host opened for a
 * node carries that node in the record's session notes, so the argv names it (`--node`) and the
 * plugin answers the constraints in force at that node — two nodes held in parallel by one line
 * hand their sessions two different listings, not the first node's for both. When no note names the
 * session (a consult, a hand-opened session, a note this machine does not hold), no `--node` goes
 * in: the fallback is the plugin's own default read, the same answer any caller that cannot name a
 * position gets — the host declines to invent a position it does not know, and the position rule
 * stays the plugin's one judgment, stated here as the chosen fallback.
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
import { answer, open, projectRootOf } from 'superworker-core'
import type { Context } from '@deepseek-ai/cordis'
import { answerHandleOf } from './write.ts'
import { recordPresentAt } from './records.ts'
import { PANEL_PREF_FIELDS } from './settings-fields.ts'
import { agentIdOf, busOf, panelSwitchOn, promptContextPortOf, workspaceRootOf } from './seams.ts'

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
 * The listing decision rides the plugin's own machine mark, not its prose: the reader view carries
 * entries exactly when the same read through the structured exit (`--json`) answers a non-empty
 * array. Every empty answer of the same word is a sentence instead (`This project has no
 * instruction record at all.`, `No instruction is visible from this step.`, …), and those answer
 * `[]` — so the mark tells "there is a listing" from "there is nothing to carry" without this half
 * matching a word of the plugin's English. The plugin may reword or localize its listing; the
 * injection judges structure and stays.
 */
/** The word line the panel's instruction column and the tool answer with: the plugin's default read, at the session's own node when one is named. */
export function instructionListArgv(root: string, node?: string): readonly string[] {
  return node === undefined
    ? ['instruction', 'list', '--project', root]
    : ['instruction', 'list', '--project', root, '--node', node]
}

/** The same read through the machine's exit: the structured listing the mark is judged from. */
export function instructionListMarkArgv(root: string, node?: string): readonly string[] {
  return ['instruction', 'list', '--json', '--project', root, ...(node === undefined ? [] : ['--node', node])]
}

/** One word answer, as far as the text decision reads it. */
export interface WordAnswer {
  readonly code: number
  readonly stdout: string
}

/**
 * Whether one mark answer says a listing is held: the structured exit answered, and the array it
 * carried is not empty. This is the machine-judgeable fact — the plugin's own `--json` view of the
 * same read, not its prose. A refused word, and a stdout that is not a JSON array, mark nothing.
 */
export function instructionListingHeldBy(mark: WordAnswer): boolean {
  if (mark.code !== 0) return false
  try {
    const rows: unknown = JSON.parse(mark.stdout)
    return Array.isArray(rows) && rows.length > 0
  } catch {
    return false
  }
}

/**
 * The injected text of one word answer, admitted by the mark: the reader view itself, or nothing.
 *
 * `view` is the plain read; `mark` and `recheck` bracket it — the structured exit run before and
 * after, spelling the same read. A failed answer on any side is nothing: the word is not installed
 * here (the plugin was moved away), or it refused. A mark that does not say a listing is held is
 * nothing too — the empty states (`This project has no instruction record at all.`, `No instruction
 * is visible from this step.`, …) are sentences about the absence of a record, and a snapshot
 * saying "there is no record" every step is a box drawn around nothing. And when the account moved
 * under the bracket (the two marks disagree), the view in between is nobody's snapshot: this step
 * carries nothing, and the next assembly reads again — that is what keeps a mid-read archive from
 * injecting the empty-state sentences, judged by structure, never by matching prose. What is left
 * is the listing, byte for byte, less the trailing newlines the context joiner supplies itself.
 */
export function instructionTextViewOf(view: WordAnswer, mark: WordAnswer, recheck: WordAnswer): string {
  if (mark.code !== 0 || view.code !== 0 || recheck.code !== 0) return ''
  if (!instructionListingHeldBy(mark) || mark.stdout !== recheck.stdout) return ''
  return view.stdout.replace(/[\r\n]+$/u, '')
}

/** The last text computed per session and its workspace root: what the synchronous provider hands back. */
const carried = new Map<string, string>()

/** One carried entry's key: the workspace root and the session that asked — two sessions in one root work two nodes and carry two listings. */
const carriedKeyOf = (root: string, id: string): string => `${root}\u0000${id}`

/**
 * Which node the named session is this line's worker on, read out of the record's own session
 * notes — the one attribution the record keeps (the opener notes the session it minted under its
 * node; the engine notes the session a node was born in). A session claimed by exactly one node
 * names a position; a session two nodes claim, or no node claims (a consult, a hand-opened
 * session), names none, and answers `undefined`.
 *
 * @param accountRoot - The resolved root the record sits in (a worktree checkout already led back
 *   to its main tree).
 */
async function nodeOfSession(accountRoot: string, sessionId: string): Promise<string | undefined> {
  let rows
  try {
    rows = await open(accountRoot).sessions.list()
  } catch {
    /* An unreadable record attributes nothing: the caller falls back explicitly. */
    return undefined
  }
  const claiming = rows
    .filter((row) => [...row.note.run, ...row.note.discussion].some((entry) => entry.session === sessionId))
    .map((row) => row.node)
  return claiming.length === 1 ? claiming[0] : undefined
}

/**
 * The text to carry for one workspace root, read on the spot.
 *
 * Throws only what the words layer throws; a caller that must not disturb an assembly catches it.
 * The listing decision is made by bracketing the view with the machine mark (see
 * {@link instructionTextViewOf}): three in-process reads, and the account standing still between
 * the marks is what admits the bytes in between.
 * @param root - The session's workspace root.
 * @param sessionId - The session asking; when named, the word is asked at the session's own node
 *   (the record's session notes are the one attribution), so a line holding two nodes in parallel
 *   hands each session its own listing. A session no note names gets the plugin's default read —
 *   **the chosen fallback**: no `--node` goes in rather than an invented position, because the
 *   plugin's own default is exactly what any caller that cannot name a position answers, and
 *   naming nothing keeps the position rule in the plugin's one place instead of guessing it here.
 */
export async function instructionContextTextOf(root: string, sessionId?: string): Promise<string> {
  const node = sessionId === undefined ? undefined : await nodeOfSession(projectRootOf(undefined, root), sessionId)
  const mark = await answer(instructionListMarkArgv(root, node), answerHandleOf(root))
  if (!instructionListingHeldBy(mark)) return ''
  const view = await answer(instructionListArgv(root, node), answerHandleOf(root))
  const recheck = await answer(instructionListMarkArgv(root, node), answerHandleOf(root))
  return instructionTextViewOf(view, mark, recheck)
}

/**
 * Whether the switch is on: absent surface or absent field both read as on — the factory default is
 * "carry them". The reading itself is the one this half spells (`panelSwitchOn` in `seams.ts`, the
 * same one the relay switch asks), so the two volatile switches cannot drift apart.
 */
function switchedOn(config: unknown): boolean {
  return panelSwitchOn(config, PANEL_PREF_FIELDS.injectInstructions)
}

/** The session a step is asked for, as both the provider and the assembly listener read it: the agent's id, and the workspace root it lives in. */
function holderOf(ctx: Context, context: unknown): { readonly id: string; readonly root: string } | undefined {
  const agent = (typeof context === 'object' && context !== null ? context : {}) as { agent?: unknown }
  const proposed = agent.agent
  if (typeof proposed !== 'object' || proposed === null) return undefined
  const id = agentIdOf(proposed)
  if (id === undefined) return undefined
  /* Both sides of the assembly ask synchronously, so this is the seam's synchronous form: the live
   * session store, then the sandbox policy. The persisted header is never read for this door — a
   * disk read inside a context provider would be a stall per step, and a live agent always has a
   * header of its own. */
  const root = workspaceRootOf(ctx, { sessionId: id, synchronous: true })
  if (root === undefined) return undefined
  return { id, root }
}

/**
 * Whether the resolved project root carries a record directory at all: the cheap fact that says the
 * word has something to read. The judgment is the shared one (`recordPresentAt` in `records.ts`);
 * the legacy layer is not asked here (the caller's call, spelled): an unmigrated workspace holds no
 * record the word itself would open, so its gate answers the layout the word acts on, and the wake
 * — which must reach such a workspace for `migrate` — is the side that counts it.
 */
function recordPresent(root: string): boolean {
  return recordPresentAt(root, false)
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
        const holder = holderOf(ctx, context)
        return holder === undefined ? '' : (carried.get(carriedKeyOf(holder.root, holder.id)) ?? '')
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
        const holder = holderOf(ctx, context)
        if (holder === undefined) return settled.then((result) => withInstructionText(result, ''))
        /* The record is looked for where the word would look: a linked worktree's checkout resolves to
         * the main tree that holds it. A workspace whose resolved project root has no record directory
         * at all has nothing to ask about — the word is not run and the entry is emptied, which is the
         * same answer at a lower price. Keyed by the session and its root, so two worktrees of one main
         * tree each carry their own reading, and two sessions in one root working two nodes each carry
         * their own node's listing. */
        const accountRoot = projectRootOf(undefined, holder.root)
        if (!recordPresent(accountRoot)) {
          carried.delete(carriedKeyOf(holder.root, holder.id))
          return settled.then((result) => withInstructionText(result, ''))
        }
        return settled.then(async (result) => {
          let text = ''
          try {
            text = await instructionContextTextOf(holder.root, holder.id)
          } catch {
            /* The word threw (an unreadable account, a broken argv): carry nothing this step rather
             * than break somebody else's request. */
            text = ''
          }
          carried.set(carriedKeyOf(holder.root, holder.id), text)
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
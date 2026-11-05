/**
 * The host half's write surface: every record-touching action on the panel is
 * handed to the tool's command to write.
 *
 * No JSON is assembled here and nothing under `.pf` is touched; a command is
 * handed out, its output collected, and the tool prints its own reasons for
 * refusal. Every run takes the same route: this package's own command entry
 * (`bin/pf.mjs`), run by the very node that runs this host half, argv handed to
 * `ctx.subprocess` directly. No shell sees the arguments, and no PATH is asked
 * where the command is. The user's verbatim sentence may be any sentence, with
 * spaces, quotes and `&`; it is the one value that travels outside the argument
 * gate, and it arrives as one argument.
 */
import type { Context } from '@deepseek-ai/cordis'
import { fileURLToPath } from 'node:url'
/* The subprocess gateway lives on the `@deepseek-ai/dsh-subprocess` package entry, only to attach `subprocess` to the Context: a type-only import, nothing enters the runtime. */
import type {} from '@deepseek-ai/dsh-subprocess'
import type { PfOutcome } from './failure.ts'

/** The argument gate: commands, subcommands, ids, key names, and values are all combinations of just these characters; the verbatim sentence is the one value outside it, see `runPf`. */
const SAFE_ARG = /^[A-Za-z0-9_.:+-]{1,200}$/

/** How long a single write may take at most. Each of these tool commands reads a small JSON and writes it back. */
const GRACE_MS = 4000

/** Output collection cap: the tool's refusal reason and the verbatim sentence must both fit. */
const MAX_BYTES = 64 * 1024

/**
 * Run a `pf` command and collect its output.
 * @param said - The user's verbatim sentence, appended to the end of the argv as one argument, as-is.
 */
export async function runPf(
  ctx: Context,
  workspaceRoot: string,
  args: readonly string[],
  signal: AbortSignal,
  said?: string,
): Promise<PfOutcome> {
  const unsafe = args.find((arg) => !SAFE_ARG.test(arg))
  if (unsafe !== undefined) return { ok: false, code: 'arg-not-allowed', detail: unsafe }

  const subprocess: Spawner | undefined = ctx.get('subprocess')
  if (subprocess === undefined) return { ok: false, code: 'no-subprocess' }

  const argv = launchArgs(args, said)

  try {
    const handle = subprocess.spawn({
      argv,
      cwd: workspaceRoot,
      stdio: {
        stdin: 'ignore',
        stdout: { maxBytes: MAX_BYTES },
        stderr: { maxBytes: MAX_BYTES },
      },
      graceMs: GRACE_MS,
      signal,
    })
    const outcome = await handle.done
    const out = handle.collected.stdout?.readFrom(0).text ?? ''
    const err = handle.collected.stderr?.readFrom(0).text ?? ''
    const text = [out, err].filter((part) => part.length > 0).join('\n').trim()
    /* The tool exiting non-zero is not this plugin's sentence to write: it said its own reason on
     * one of the two streams, and that reason travels as `detail`, verbatim. */
    if (outcome.exitCode !== 0) return { ok: false, code: 'tool-refused', ...(text.length > 0 ? { detail: text } : {}) }
    return { ok: true, text }
  } catch (error) {
    return { ok: false, code: 'spawn-failed', detail: messageOf(error) }
  }
}

/** The one thing this layer asks of the subprocess side: `spawn`. */
interface Spawner {
  spawn(spec: {
    argv: readonly string[]
    cwd: string
    stdio: {
      stdin: 'ignore'
      stdout: { maxBytes: number }
      stderr: { maxBytes: number }
    }
    graceMs: number
    signal: AbortSignal
  }): { readonly done: Promise<{ readonly exitCode: number | null }>; readonly collected: { readonly stdout?: { readFrom(from: number): { text: string } }; readonly stderr?: { readFrom(from: number): { text: string } } } }
}

/**
 * The argv for one write: this package's command entry, run by the node that
 * runs this host.
 *
 * The entry ships inside this package already — `bin/pf.mjs`, at the package
 * root beside `lib/host/` in the artifact — so a run names that file rather
 * than asking PATH for `pf`: an install that puts this package into a DSH
 * profile lands its `bin` under that profile's `node_modules`, and what PATH
 * answers there is a package manager's shim, or nothing at all. No interpreter
 * is guessed at, since the entry is this package's own file and the node
 * running this host is known.
 *
 * No command line is built and no shell is involved: cmd would split a
 * sentence on spaces and would execute an `&` inside it (measured: `--text a &
 * echo x` really runs the second command). Handing the argv over directly
 * means the user's verbatim sentence arrives as one argument, quotes and
 * `&` intact, and an install path with spaces needs no gate: it is one argv
 * entry, and nothing splits it.
 */
function launchArgs(args: readonly string[], said: string | undefined): readonly string[] {
  const argv = [process.execPath, PF_ENTRY, ...args]
  if (said !== undefined) argv.push(said)
  return argv
}

/**
 * The shipped command entry, named from this file's own location rather than
 * found on PATH: `../../bin/pf.mjs` is the package root's `bin/pf.mjs` from
 * both shapes this file runs in — `lib/host/index.js` in the artifact and
 * `src/host/write.ts` in a checkout.
 */
const PF_ENTRY = fileURLToPath(new URL('../../bin/pf.mjs', import.meta.url))

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
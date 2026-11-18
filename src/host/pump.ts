/**
 * The panel's one channel: when a workspace's records changed, who is told.
 *
 * Every reader of one workspace subscribes here — the overview, the detail, the
 * map, the settings pane, all through the single stream endpoint the gateway
 * exposes — so "the reading is stale" is not a question any pane asks itself.
 * Three kinds of notice wake it, and none of them is a poll:
 *
 * - the record directory itself, watched on this host (`fs.watch`, recursive),
 *   which is the one signal that speaks for *any* writer: a word run by an agent,
 *   a word run by a shell outside DSH, an editor, a `git checkout`;
 * - the host's own session events (`session/event`, `session/disposed`): a leg
 *   starting, ending, or being disposed of changes what the records say next, and
 *   the reading is re-taken on the same beat;
 * - this half's own writes and dispatches, which call {@link RecordsPump.stir}
 *   directly the moment they land — the panel that pressed the button should not
 *   wait for its own file change to come back through the watcher.
 *
 * Notices are coalesced: a burst (a word writing six files, a build touching the
 * tree) becomes one re-read per {@link COALESCE_MS}, and a re-read that finds the
 * same reading sends nothing at all. A subscriber's first frame goes out
 * immediately, so a panel that opens gets its reading without asking twice.
 *
 * The pump never throws into an event bus or a stream: a read that fails is one
 * frame carrying the refusal, and the next notice tries again.
 */
import type { Context } from '@deepseek-ai/cordis'
import { watch as watchDirectory, type FSWatcher } from 'node:fs'
import { join } from 'node:path'
import { RECORD_DIR, type SuperworkerFrame } from './contract.ts'
import { busOf, logLineOf, messageOf } from './seams.ts'

/**
 * How long notices merge into one re-read. Small enough that a word's writes
 * reach the panel on the same eyeblink, large enough that a burst of six files is
 * one read rather than six.
 */
const COALESCE_MS = 120

/** One workspace's frame read: the reader is handed the cancellation of the stream that asked. */
export type FrameReader = (signal: AbortSignal) => Promise<SuperworkerFrame>

/** The one thing a subscriber waits on: the next notice for its workspace. */
class Root {
  readonly path: string
  readonly #waiters = new Set<() => void>()
  #subscribers = 0
  #watcher: FSWatcher | undefined
  #timer: ReturnType<typeof setTimeout> | undefined

  constructor(path: string) {
    this.path = path
  }

  /** Hold this root open for one more subscriber; the first one arms the directory watch. */
  retain(): void {
    this.#subscribers += 1
    if (this.#subscribers === 1) this.#arm()
  }

  /** Let one go; the last one puts the directory watch down. */
  release(): void {
    this.#subscribers -= 1
    if (this.#subscribers > 0) return
    this.#subscribers = 0
    this.#disarm()
    this.#waiters.clear()
  }

  /** Take every subscriber back at once, when the whole line unloads. */
  releaseAll(): void {
    this.#subscribers = 0
    this.#disarm()
    this.#waiters.clear()
  }

  /** Whether anyone is still following this root: nobody means it can be forgotten. */
  get held(): boolean {
    return this.#subscribers > 0
  }

  /** A notice landed: one re-read after the burst settles, never one per notice. */
  stir(): void {
    this.#armIfPossible()
    if (this.#timer !== undefined) return
    this.#timer = setTimeout(() => {
      this.#timer = undefined
      this.#wake()
    }, COALESCE_MS)
    this.#timer.unref?.()
  }

  /** Resolve on the next notice, or when the stream is cancelled — whichever comes first. */
  next(signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.resolve()
    return new Promise<void>((resolve) => {
      const waiter = (): void => {
        signal.removeEventListener('abort', waiter)
        resolve()
      }
      this.#waiters.add(waiter)
      signal.addEventListener('abort', waiter, { once: true })
    })
  }

  #wake(): void {
    const waiters = [...this.#waiters]
    this.#waiters.clear()
    for (const waiter of waiters) waiter()
  }

  /** Arm the directory watch, when this workspace has a record directory to watch. */
  #armIfPossible(): void {
    if (this.#watcher !== undefined || this.#subscribers === 0) return
    this.#arm()
  }

  #arm(): void {
    try {
      /* Recursive: the records live in subdirectories (nodes, cycles, meta, issues), and a
         non-recursive watch would miss every one of them. Windows and Linux both support it. */
      this.#watcher = watchDirectory(join(this.path, RECORD_DIR), { recursive: true }, () => this.stir())
      this.#watcher.on('error', () => this.#disarm())
    } catch {
      /* No record directory yet (or no permission): the session notices and this half's own
         writes still wake the pump, and the first notice after the directory appears arms it. */
      this.#watcher = undefined
    }
  }

  #disarm(): void {
    const watcher = this.#watcher
    this.#watcher = undefined
    if (this.#timer !== undefined) {
      clearTimeout(this.#timer)
      this.#timer = undefined
    }
    if (watcher === undefined) return
    try {
      watcher.close()
    } catch {
      /* Closing is best-effort: the watcher is dropped either way. */
    }
  }
}

/**
 * The channel itself, one per host line: the roots it knows, the notices it hears,
 * and the frames it hands each follower.
 */
export class RecordsPump {
  readonly #roots = new Map<string, Root>()
  readonly #offs: (() => void)[] = []

  /**
   * @param ctx - The host context: the event bus is taken from it, and a refused
   * notice is one log line rather than a throw into the bus.
   */
  constructor(ctx: Context) {
    const bus = busOf(ctx)
    if (bus === undefined) return
    const keep = (off: unknown): void => {
      if (typeof off === 'function') this.#offs.push(off as () => void)
    }
    /* Two notices, both plain emits: a session moving is when the records it writes can change.
       (The words' file writes are watched directly, so no tool-call hook is needed — and a
       waterfall event is a worse place to stand: a listener that forgets `next()` stops it.) */
    for (const event of ['session/event', 'session/disposed']) {
      try {
        keep(bus.on(event, () => this.stirAll()))
      } catch (error) {
        logLineOf(ctx, 'warn', `the records pump could not listen to ${event}: ${messageOf(error)}`)
      }
    }
  }

  /** Re-read every followed workspace: a session notice names no root, and one panel hears few. */
  stirAll(): void {
    for (const root of this.#roots.values()) root.stir()
  }

  /** Re-read one workspace now-ish: this half's own writes and dispatches call this. */
  stir(workspaceRoot: string): void {
    this.#roots.get(workspaceRoot)?.stir()
  }

  /**
   * Follow one workspace: the first frame immediately, then one frame per change.
   *
   * The loop reads, sends only what differs from the last frame it sent, and then
   * waits for the next notice — so a quiet workspace costs nothing at all, and a
   * burst costs one read. A read that fails is a frame of its own, sent once, with
   * the refusal riding on it; the reading's last good value is not resent as if it
   * were current.
   * @param root - The workspace root, absolute and canonical.
   * @param read - The reader for this workspace's frame.
   * @param signal - The stream's own cancellation; ending the loop releases the root.
   */
  async *follow(root: string, read: FrameReader, signal: AbortSignal): AsyncIterable<SuperworkerFrame> {
    const node = this.#roots.get(root) ?? new Root(root)
    this.#roots.set(root, node)
    node.retain()
    try {
      let previous: string | undefined
      /* The first frame goes out before anything is awaited twice: a panel that just opened has
         nothing and must not wait for a file change to see its own workspace. */
      for (;;) {
        if (signal.aborted) return
        const frame = await this.#frameOf(root, read, signal)
        const stamp = stampOf(frame)
        if (stamp !== previous) {
          previous = stamp
          yield frame
        }
        if (signal.aborted) return
        await node.next(signal)
      }
    } finally {
      node.release()
      if (!node.held) this.#roots.delete(root)
    }
  }

  /** One frame, with a failed read carried instead of thrown: a stream that dies on a bad read is a panel that stops updating. */
  async #frameOf(root: string, read: FrameReader, signal: AbortSignal): Promise<SuperworkerFrame> {
    try {
      return await read(signal)
    } catch (error) {
      return { workspaceRoot: root, at: Date.now(), reading: null, sessions: null, failure: { code: 'unreadable', detail: messageOf(error) } }
    }
  }

  /** Take every listener and watcher back: the host line unloading leaves nothing armed. */
  dispose(): void {
    for (const off of this.#offs.splice(0)) {
      try {
        off()
      } catch {
        /* A listener that cannot be taken back is not this layer's to fix. */
      }
    }
    for (const root of this.#roots.values()) root.releaseAll()
    this.#roots.clear()
  }
}

/**
 * What a frame is compared by: everything but the moment it was read. Two reads
 * that say the same thing send one frame, so a wedged writer that keeps touching
 * files cannot make the panel redraw for nothing.
 */
function stampOf(frame: SuperworkerFrame): string {
  return JSON.stringify({ reading: frame.reading, sessions: frame.sessions, failure: frame.failure ?? null })
}

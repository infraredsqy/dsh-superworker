/**
 * Why a browser-side operation was refused, as a code rather than a sentence.
 *
 * The panel is the only place that knows which language its reader looks at, so it is the only
 * place that can write a sentence. Everything that can refuse an operation therefore refuses with a
 * code: the host half does (see `src/host/failure.ts`), and this half does for the reasons that
 * belong to the port itself — a channel that is not connected, an endpoint that is not there, an
 * answer that cannot be read.
 *
 * One vocabulary covers both, because a caller holding a refusal should not have to know which half
 * produced it: the panel spells any of these codes the same way (`src/client/words.ts`).
 */
import type { RecordRefusalCode } from '../host/failure.ts'

/** What the port itself can refuse, on top of whatever the host refuses for. */
export type PortRefusalCode =
  /** The mounted channel has no such endpoint. */
  | 'no-operation'
  /** Neither a mounted namespace nor a carrier is there, so nothing can be read. */
  | 'not-connected'
  /** The same, on the write side. */
  | 'no-write-channel'
  /** The answer arrived in a shape nothing here can read. */
  | 'unparsable-answer'
  /** The transport failed outright, or the host threw; `detail` is what it said. */
  | 'transport-failed'
  /** The project settings could not be read and the tool said nothing about why. */
  | 'config-unreadable'
  /** A project setting was written and did not take effect, with nothing said about why. */
  | 'config-write-failed'
  /** The settings service refused the change. */
  | 'settings-refused'
  /** No settings service is connected, so the change lives only on this screen. */
  | 'settings-unwritable'
  /** A refusal carrying no reason at all; the panel says so rather than showing nothing. */
  | 'unstated'

/** Every reason an operation can be refused, from either half. */
export type FailureCode = RecordRefusalCode | PortRefusalCode

/** A refusal: which one, plus the detail that goes with it — an argument, a path, a program's output. */
export interface Failure {
  readonly code: FailureCode
  readonly detail?: string
}

/** The words a read-side failure turned into: the port rejects with this, carrying its code. */
export class RefusedError extends Error {
  readonly failure: Failure
  constructor(failure: Failure) {
    super(failure.detail === undefined || failure.detail.length === 0 ? failure.code : failure.detail)
    this.name = 'RefusedError'
    this.failure = failure
  }
}

/**
 * Read a rejection back into a refusal.
 *
 * A reject that carries one of our codes keeps it; anything else (a programming error, a transport
 * that threw its own error) becomes a transport failure whose detail is what was thrown. Nothing is
 * swallowed: an unknown rejection still reaches the reader as a sentence.
 */
export function failureOf(error: unknown): Failure {
  if (error instanceof RefusedError) return error.failure
  return { code: 'transport-failed', detail: error instanceof Error ? error.message : String(error) }
}

/** What a write-side call hands back: the tool's own output on success, a refusal on failure. */
export type Outcome =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly code: FailureCode; readonly detail?: string }
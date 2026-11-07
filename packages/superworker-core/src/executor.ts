/** One dispatch request: which node of which line, handed out with what prompt. */
export interface DispatchRequest {
  /** This work line. */
  readonly cycle?: string;
  /** The node in hand. */
  readonly node?: string;
  /** The role this step plays in the pipeline (such as execute / review / fix). */
  readonly role?: string;
  /** The prompt handed to the executor. */
  readonly prompt: string;
  /**
   * The model route this session opens with, in the ecosystem's own spelling (`provider/model`). Read
   * at the call, in the most specific order — the dispatch's own `model` > the line's `model` policy >
   * the machine's `DSH_CONDUCT_MODEL` — and absent when nothing names one (the executor's own default
   * speaks). This layer never splits it: whoever opens the session owns the provider, and a host that
   * knows no such route is the host's own failure to report.
   */
  readonly model?: string;
  /**
   * The drill switch was on for this call: the call is made and its result is reported, but no session
   * may actually be opened. Absent means off (the ordinary state).
   */
  readonly dryRun?: boolean;
}

/**
 * The receipt of one dispatch: the session that was opened. Both cells are optional — the executor
 * may not know a session id, and the host word is only carried when one is stated.
 */
export interface OpenedSession {
  readonly sessionId?: string;
  readonly host?: string;
}

/**
 * The executor seam: every piece of execution outside the engine comes in here.
 *
 * The interface has `dispatch` as its only method — the engine itself has no entry that starts a
 * process or opens a session; the executor can only be injected from outside through
 * `RecordOpenOptions.executor`. Dispatch hands the node to a session, and the promise ends when that
 * session is **open**: the node's result is not here — the worker files a ticket, and `close`
 * settles it.
 */
export interface Executor {
  dispatch(request: DispatchRequest): Promise<OpenedSession>;
}

/**
 * What one simulated dispatch does: `'open'` leaves a session (the default), `'throw'` blows up the
 * way an executor that cannot open one does, and `'hang'` never settles. A function is asked per
 * call and receives the request plus the index of this dispatch (starting at 0).
 */
export type SimulationScript =
  | 'open'
  | 'throw'
  | 'hang'
  | ((request: DispatchRequest, index: number) => 'open' | 'throw' | 'hang');

/**
 * The simulated executor: opens sessions with deterministic ids (`sess-1`, `sess-2`, …) and records
 * every dispatch request received in `dispatched` (in arrival order, a shallow copy is stored, so
 * the caller cannot change the record). The script is the way a test makes it throw or never settle.
 */
export class SimulatedExecutor implements Executor {
  /** The dispatch requests received, in arrival order. */
  readonly dispatched: DispatchRequest[] = [];

  private readonly script: SimulationScript;

  constructor(script: SimulationScript = 'open') {
    this.script = script;
  }

  async dispatch(request: DispatchRequest): Promise<OpenedSession> {
    const index = this.dispatched.length;
    this.dispatched.push({ ...request });
    const outcome = typeof this.script === 'function' ? this.script(request, index) : this.script;
    if (outcome === 'throw') {
      throw new Error(`simulated executor: dispatch #${index + 1} was told to fail and opened no session`);
    }
    if (outcome === 'hang') return new Promise<OpenedSession>(() => {});
    return { sessionId: `sess-${index + 1}` };
  }
}

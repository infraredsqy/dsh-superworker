# DSH Dispatch Chain (Conduct Pipeline)

> For session-facing procedures, see [`close-and-handoff.md`](close-and-handoff.md) (close-out and `advance`) and [`startup.md`](startup.md) (manual start-up).
> This reference documents **why the chain is structured this way** and **how to troubleshoot failures**. Only three components participate: the panel relay (`src/host/relay.ts`), the native session opener (`src/host/executor.ts`), and the engine dispatcher (`packages/superworker-core/src/conductor.ts`). There is no external spawner script and no step builds a CLI `argv`.

## 1. Who Opens the Session

**Both triggers run inside the host through the same code path:**

- **Panel dispatch**: `dispatchCell` (`relay.ts`) completes three steps in one call—`conductor.dispatch` writes dispatch material if the prompt is not yet on disk, invokes the executor seam to open a session, and writes the `started` claim only after the session is actually created.
- **Automatic relay**: Triggered by `turn/end`, invoking the same `dispatchCell`. The relay tracks only **sessions opened by this host** (recorded in `tracked` when `dispatch` returns). After each turn ends, the host runs `advance`: if the plan says `dispatch`, it opens the next sessions; if the plan says `wait`, it stops and never overrides the gate. Disabling `autoRelay` (enabled by default) turns off automatic triggering only; manual panel dispatch continues to work.

**`Executor` is the sole seam**: the engine calls `dispatch(request)` and never opens sessions directly. The host binds `openNodeSession` (`executor.ts`), which performs five steps:
1. Verify the host exposes an `agents` service (fail with a specific error if missing).
2. Read the cell's prompt from the record store (`<record>/meta/launch/<cycle>/<node>/prompt.txt`).
3. Create the agent and session under the target workspace root and attach it to that workspace (a session created with `cwd` alone is unattached and appears under "ungrouped" in the panel).
4. Register turn-end listeners before submitting the prompt as the first instruction.
5. Write the node's `run` note. The host mints the session ID (`session-<uuid>`) purely for panel navigation; users never need to inspect it.

**The prompt contains a single invocation line** (`promptTextOf` in `prepare.ts`: `/sw-conduct <node-id> [pipeline]`) and nothing else. The session reads the node title, spec path, and close commands itself; user instructions are injected dynamically by the host with each turn's context (omitted when none are visible or `injectInstructions` is off). Embedding dynamic details in a static prompt only creates stale duplicates.

## 2. Engine and Disk Ordering

```
read started claim -> plugin dispatch gate -> write material (if prompt missing) -> executor.dispatch -> write started
```

- **Read claim first**: `conductor.dispatch` checks for `started` on disk before doing anything else. If present, it returns `already_open` without writing a byte or calling the executor.
- **Write material second**: If the prompt already exists on disk, preparation is skipped; otherwise `prepareDispatch` writes the prompt and `run.md` (`run.md` is created exclusively and never overwritten). In the standard flow, `hold` writes the claim only; `dispatch` owns materializing the prompt.
- **Write claim last**: `started` is written only after a session is confirmed open. Failure to write `started` is treated as an incident: the session is running with no disk record, so the call throws with the session ID and warns that re-dispatching will launch a duplicate session.
- **Dispatch gate precedes material and launch**: A plugin may block dispatch, recording its reasons in `dispatch_blocked`. No prompt is written and no session opens; the node pinned by the prior `hold` remains pinned, and the cycle stays active.
- **Why this order matters**: Once `started` is on disk, `plan` treats the cell as in flight and never dispatches it again. The opening side must therefore guarantee that a session can actually open before writing `started`. Processes without an opener follow the rule below.

## 3. Processes Without an Opener: Zero Writes

Engine commands in `answer()` that can launch sessions check **whether the caller has a session-opening seam** (`io.openerAvailable`, populated via `sessionOpenerAvailable()`, always true in dry-run mode). `settle` never opens sessions and skips this check.

- **`dispatch <cycle>`**: Reads `started` claims per node, marking existing ones as already open and proceeding only for unstarted nodes. If the process has no opener, **it refuses before calling the engine**: exit code `2`, zero bytes written, naming the panel (超级工坊), the expected prompt path, and the fact that panel dispatch materializes the prompt—plus two manual options (dispatch via the panel, or open a new session and paste the invocation line). If no unstarted nodes remain, it reports that already-open nodes will not be dispatched again.
- **`advance`**: Prints the plan and pins nodes as usual, writes no dispatch material (that belongs to `dispatch`), and records `spawn_error` without claiming any node or invoking the engine. This prevents a stub opener from failing after a claim is written and leaving a phantom "running" cell.
- **`settle <node>`**: Records the step, updates the node status, and runs close-time plugins—writing no prompt and opening no session. Splitting close-out into `settle` and `advance` isolates ledger settlement from pinning, materializing prompts, and launching sessions.

**Dry-run mode**: When `DSH_CONDUCT_SPAWN_DRY_RUN` is set to anything other than `''`, `0`, `false`, or `False`, `engine.mjs` supplies `SimulatedExecutor`. The full dispatch chain executes and returns a synthetic session ID (`sess-N`), while opening no real session and writing no `started` claim. Because nothing is left on disk to clean up, a rehearsed cell can be dispatched for real immediately afterward.

**Host-side dry-run**: The native opener honors the same flag—creating no agent, returning `host: "drill"` with no session ID (so the relay does not track it), and writing no claim.

## 4. Failure Modes and Troubleshooting

- **Launch refused**: Every `openNodeSession` rejection returns an error code and reason (`no-session-service`, `prompt-missing`, `open-failed`, etc.). When the executor throws, the engine writes no `started` claim (material may already be on disk) and leaves records untouched, propagating the reason verbatim: the panel button displays it to the user, while the automatic relay logs one warning line without throwing onto the event bus.
- **Session opened, claim write failed**: The engine throws with the session ID and instructs you to record the claim first. A prompt exists on disk without `started`, so another dispatch would open a duplicate session—either record the claim or reset and retry cleanly.
- **Session died, claim remains**: `started` is the sole evidence that a cell is already open, so `plan` will not re-dispatch it. The only recovery path is `cycle retry <cycle> <node> --drop` (clears both the claim and stale ticket), followed by `hold <node> --cycle <cycle>`, then `dispatch <cycle>`.
- **Parallel cycles hitting `index.lock`**: Another active cycle may be running git in the same working tree. An `index.lock` error is a transient contention: wait a few seconds and retry; if it persists after two or three attempts, stop and hand off to the user—never delete a lock file owned by a live process.
- **Troubleshooting order**: Session missing from the panel → verify which workspace it was attached to. Button rejected → read the returned `detail` message. Rejected for no opener → the current process cannot launch sessions by design; this is not a configuration error.

# The DSH dispatch chain (for the conduct pipeline)

> The half a session reads is this skill's own "The dispatch path" section ([`../SKILL.md`](../SKILL.md)): who calls it, and where to look when it breaks.
> This half carries **why it is written this way** and **how not to write it** — for troubleshooting. The chain has three names:
> the panel's relay (`src/host/relay.ts`), the native opener (`src/host/executor.ts`), and the engine's dispatch
> (`packages/pf-core/src/conductor.ts`). There is no spawner script, and no step anywhere assembles an argv.

## 1. Who opens this session

**Two ways, both opened by the host itself, walking the same road.**

- **The panel's cell**: `dispatchCell` (`relay.ts`) walks three steps in one call — the engine's `conductor.dispatch`
  lands this cell's material when the prompt is not on disk, hands the request to the executor seam, and writes
  the `started` claim only once a session is really out.
- **The automatic relay**: the same `dispatchCell`, fired by `turn/end`. The relay listens to **the sessions this host
  opened itself** (tracked when a dispatch returns); after each turn the host runs `advance` itself — that is the half
  that applies the plan. A plan saying `dispatch` opens the next sessions, and a plan saying `wait` is never overridden.
  The `autoRelay` switch (on by default) turns the trigger off; the button keeps working either way.

**The one seam is `Executor`**: the engine knows only `dispatch(request)` and never opens a session itself. This host
hangs `openNodeSession` (`executor.ts`) on it, and one open is five steps: probe the host for an `agents` service
(with none it refuses, naming the piece); read this cell's prompt out of the record store
(`<pf>/meta/launch/<line>/<node>/prompt.txt`); create the agent and its session under this workspace root and
attach it to that workspace (a session built from `cwd` alone joins no group and sits under "ungrouped" in the
panel); arm the round-end listeners before handing the prompt over as the first instruction; and finally write the
node's `run` note. The session id is the host's own mint (`session-<uuid>`); it is an address for the panel's
navigation, and no reader needs to see it.

**The prompt carries one invocation line** (`promptTextOf` in `prepare.ts`: `/pf-conduct <node id> [pipeline]`), and
its bytes are that one line. Why nothing more is padded in: the node's title, the spec's path, the closing command
and the user's instructions are all readable by the session itself; what gets padded in is a second copy of the same
thing, and the older one.

## 2. The engine and the disk, in order

```
read the started claim -> the plugin dispatch gate -> the material (landed only when the prompt is absent) -> executor.dispatch -> write started
```

- **The claim is read first.** The first thing `conductor.dispatch` does is look for this cell's `started` on disk;
  when it is there the answer is `already_open`, not one byte is written, and the executor is called not once.
- **The material lands second.** When the prompt is already on disk the preparation is skipped; when it is not,
  `prepareDispatch` lands the prompt and this round's `run.md` (the run doc is created exclusively, and one already
  written is left untouched). In the standard flow this is where the material is written: `hold` writes the
  claim only, and landing the material belongs to `dispatch`.
- **The claim is written last.** `started` lands only once a session is really out. A claim that cannot be written is
  an incident, not a warning: the session is out and nothing on disk says so, so the call throws with the session id
  in the sentence and says that dispatching again opens a second session.
- **The dispatch gate comes before the material and the session.** A plugin may answer "no" at the dispatch
  timing, and its reasons land one by one in the `dispatch_blocked` refusal; this dispatch therefore writes no
  prompt and opens no session, the node just pinned stays pinned (pinning was the previous step), and the line
  stays in service.
- That order has a cost: the moment the claim is on disk the plan counts this cell as in flight and never dispatches
  it twice. So "ask whether it can open at all, and only then land the claim" is the opening side's own guarantee —
  the side with no opener is the next section.

## 3. No opener: write nothing

The verbs in the engine's words layer (`answer()`) that can open a session read the same one thing: **whether this call has a seam for opening a session**
(`io.openerAvailable`, filled in by the caller from `sessionOpenerAvailable()`, true under the drill switch alone).
`settle` opens none, so that question never reaches it.

- `dispatch <cycle>`: it reads the `started` claim first, node by node — one on disk counts as "already opened";
  only when none is there does it go on. Having confirmed this process has no opener, **it refuses before the engine
  is reached**: exit code 2, not one byte written, and the sentence names the panel (寻路中心), where each prompt
  would land, and the way to write the material first (`prepare --cycle <cycle>`), then gives the two ways a person
  finishes this cell by hand (dispatch it in the panel, or open a new session and paste that line in). When no node
  is left to dispatch there is another sentence: a node already opened is not dispatched again.
- `advance`: the plan still prints, the nodes still get pinned, no material lands (that is the dispatch's step), and
  the opening step only writes `spawn_error` into the answer, claiming no node at all — the call never reaches the
  engine. That is what "claim nothing" means: a placeholder opener that refused after the claim would leave the cell
  "already open, with no session behind it".
- `settle <node>`: it records the step, marks the node and runs the close's plugin seam through, landing no prompt and
  opening no session at all. That is the division of labour behind the skill's two commands (first `settle`, then
  `advance`): the second one pins the node, and the dispatch step lands its prompt and hands it to the executor.

**The drill.** When `DSH_CONDUCT_SPAWN_DRY_RUN` holds anything outside `''` / `0` / `false` / `False`, `engine.mjs`
hands the engine a `SimulatedExecutor`: the call is made and answered, the session id is `sess-N`, no session opens,
and the `started` claim does not land either — it rehearses **the whole chain** and leaves not one byte on disk to
undo. So a cell rehearsed that way is dispatched for real straight away.

**The host side honours the same switch.** In a drill the native opener creates no agent and answers a receipt
whose host is `drill`, carrying no session id — which is also why the relay never takes it for one of its own
sessions. The claim stays off disk here too, so nothing comes away afterwards.

## 4. The dispatch chain and its failure modes

- **It cannot open.** Every refusal of `openNodeSession` is a code plus a reason (`no-session-service` /
  `prompt-missing` / `open-failed` …). When the executor throws, the engine lands no claim (the material may
  already have landed) and moves no record, and the reason comes back to the caller as it stands: the panel's
  button says it to a reader, the automatic relay leaves one warn log line, and nothing is thrown into the event
  bus.
- **A session opened, the claim did not land.** The engine throws with the session id in the sentence and says the
  claim is the thing to write first; at that moment a prompt is on disk with no claim beside it, and the next
  dispatch would open again — either land the claim as that sentence says, or take it all back and start over.
- **The session died, the claim is still there.** `started` is the only "already opened" evidence, so the plan never
  dispatches that cell again. There is one way to reopen it: `cycle retry <cycle> <node> --drop` (the claim and the
  old ticket go together), then `hold <node> --cycle <cycle>`, then `dispatch <cycle>`.
- **Two lines side by side.** The waking line may be running git on the same tree, and a write hitting `index.lock`
  is a momentary collision: wait a few seconds and re-run the same command, and when two or three tries still do not
  free it, stop and hand it to the user; the lock file belongs to a live process and must not be deleted.
- **The troubleshooting order.** A session missing from the panel: see which workspace it was attached to. The button
  refused: read the `detail` it answered. A call refused for lack of an opener: this process has no opener — it never opens
  sessions, and there is no configuration behind it.

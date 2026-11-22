/* The one agents-registry stand-in the opener's cases share: every create is recorded (the options,
 * the messages handed over) and the agent answers with the identity production reads — `agent.id`
 * (the session the create was given), the one spelling `src/host/seams.ts` and `tool.ts` look at.
 * One copy; a case needing a narrower registry turns faces on here instead of copying the stand-in.
 *
 * Faces, each off unless asked for:
 * - `gate` — every create stops on the promise `gate(record, index)` answers before the open gets
 *   its `{ agent, dispose }`, so a case controls when a create lands and a queue case reads which
 *   seat on the line was taken;
 * - `asksWait` — the agent carries a wait interface that records each ask on `record.waitAsked` and
 *   never answers: a round consulted there would hold the case forever, so the count stays readable
 *   as the proof the open never consulted it;
 * - `recordTools` — the agent carries a `ctx.tools` face that records every registration onto the
 *   record (`registered`, and `sequence` beside the followups), with the registry's gating half
 *   (`resolve`) kept so a reach the open should never make is answered rather than a crash.
 */
export function fakeAgents({ gate, asksWait, recordTools } = {}) {
  const created = []
  return {
    created,
    registry: {
      create(options) {
        const record = { options, followups: [], registered: [], sequence: [], waitAsked: 0 }
        created.push(record)
        const agent = {
          id: options.sessionId,
          status: 'idle',
          ...(recordTools === true
            ? {
                ctx: {
                  tools: {
                    register(definition) {
                      record.registered.push(definition)
                      record.sequence.push('register')
                      return () => {}
                    },
                    /* The gating half of the registry: kept so a case can prove the open never
                     * reaches for it — the tool is registered globally by the wake, not into this
                     * session's scope. */
                    resolve: async () => ({}),
                  },
                },
              }
            : {}),
          followup(message) {
            record.sequence.push('followup')
            record.followups.push(message)
          },
          ...(asksWait === true
            ? {
                whenIdle: () => {
                  record.waitAsked += 1
                  /* A round that never ends: a wait consulted here would hold the case's answer forever. */
                  return new Promise(() => {})
                },
              }
            : {}),
        }
        record.agent = agent
        const held = gate?.(record, created.length - 1) ?? Promise.resolve()
        return held.then(() => ({ agent, dispose: async () => {} }))
      },
    },
  }
}

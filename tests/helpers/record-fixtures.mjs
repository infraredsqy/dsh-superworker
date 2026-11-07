/* The record fixtures the model-side tests share: the one legal default shape of each collection
 * plus the moment every fixture record is cut at. A case's deliberate wreck — a missing field, a
 * strange word, a shape the record should never carry — is made at the call site by breaking
 * fields on the defaults, never by copying a new body here.
 */

/** The moment every fixture record is cut at. */
export const AT = new Date('2026-03-10T12:00:00.000Z')

/** A record at AT: the four collections present and empty unless the case names them. */
export function record(parts = {}) {
  return { nodes: {}, cycles: [], instructions: [], issues: {}, ...parts, at: parts.at ?? AT }
}

/** A legal default node. */
export function node(fields = {}) {
  return { mode: 'auto', status: 'todo', dependencies: [], ...fields }
}

/** A legal default cycle. */
export function cycle(fields = {}) {
  return { id: 'c1', status: 'active', holding: [], path: [], ...fields }
}

/** A legal default issue in the pool. */
export function issue(fields = {}) {
  return { id: 'i1', title: 'a mismatched criterion', severity: 'P3', status: 'open', discovered: '2026-03-01T00:00:00.000Z', ...fields }
}

/** A legal default instruction. */
export function instruction(fields = {}) {
  return { id: 'i1', text: 'one sentence', scope: 'global', state: 'live', at: '2026-03-10T00:00:00.000Z', ...fields }
}

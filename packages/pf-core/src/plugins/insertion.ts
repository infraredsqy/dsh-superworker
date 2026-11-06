import { writeFileSync } from 'node:fs';
import type { DagNamespace } from '../ledger';
import { nodeSpecPath, pfPaths, type PfPaths } from '../paths';
import type { NormalizedOffer } from './types';

/**
 * The core mechanism that turns an offer into a real node on the graph: set the node up, write its text, wire the
 * edges — "the declaration says what it wants, the mechanism says how it lands":
 *
 * 1. **the uuid**: `ledger.dag.add` mints and returns it in this process (no subprocess printing a uuid back: the
 *    dag namespace here is in the same process, and the return value carries the id directly);
 * 2. **the spec**: the generated text is written into the new node's `spec.md` — the node's session opens much
 *    later, and the text lands in the same step as the node;
 * 3. **the edges**: `after` (the node being closed) → the new node; and `before` (the node originally picked) is
 *    re-hung onto the new node. The old edge of `before` is taken off first (without tearing it the graph would
 *    cycle and the graph namespace would refuse), and that is exactly how an insertion voids this close's pick.
 *
 * **The description cell's reading is fixed**: the whole spec first goes through one JSON string encoding and
 * then into the description cell (the description is handed to the graph namespace as one argument and lands
 * there as it is, so the generated description is a JSON literal with quotes and escapes; both sides use this
 * reading at the same moment, which is why the bytes line up).
 *
 * The spec.md location is not spelled here: `paths.nodeSpecPath` is the one home of that spelling, so the
 * path an offer is told about and the path the text lands on cannot drift apart.
 *
 * An insertion is a graph edit and nothing more: it opens no session, does not move the line's hand and pins no
 * node. Every offer lands on its own and is contained on its own: one exploding offer spends only itself (one
 * WARNING line) and the rest still enter the graph.
 */

/** The placeholder in the spec text before the uuid exists. */
export const NEW_NODE = '%DUID%';

/** One landed insertion: the new node and where it goes. */
export interface AppliedInsertion {
  readonly plugin: string;
  readonly nodeId: string;
  readonly title: string;
  readonly tags: string[];
  /** Where the new node's spec.md lands (the forward-slash spelling a person reads). */
  readonly specPath: string;
  readonly why: string;
  readonly note: string;
}

/**
 * The whole landing of one offer: `add` (the description is evaluated first, so a builder that explodes leaves
 * nothing behind) → writing spec.md → the edges. `closed` is the node this close closes (the insertion hangs
 * behind it); `targetId` is the node originally picked (only with it is the other end wired; the closing seam has
 * no picking step, so the closing side passes null).
 */
export async function applyInsertion(
  root: string,
  dag: DagNamespace,
  offer: NormalizedOffer,
  closed: string | null,
  targetId: string | null,
): Promise<AppliedInsertion> {
  const paths: PfPaths = pfPaths(root);

  // The description is evaluated first: if the builder throws here, nothing has landed on the graph.
  const described = await offer.specOf(NEW_NODE);
  if (typeof described !== 'string') {
    throw new TypeError(`\`spec_of\` must return the node's text as a string, got ${typeof described}`);
  }
  const added = await dag.add({
    title: offer.title,
    // The description cell holds a JSON literal (one JSON string encoding, so the bytes match on both sides).
    description: JSON.stringify(described),
    tags: offer.tags,
  });

  // The edges land separately in a fixed order: depend after add (depend pushes the new node's updated_at one more
  // notch, and that is the shape of the bytes on disk). The other end is wired only when there is a before (without
  // removing the old before→after edge the graph would cycle); the closing seam has no picking step, so targetId is
  // always null.
  if (closed !== null) {
    await dag.link(added.id, closed);
  }
  if (closed !== null && targetId !== null) {
    await dag.unlink(targetId, closed);
    await dag.link(targetId, added.id);
  }

  // The text: evaluated a second time once the real uuid is in hand, and written into the new node's own spec.md
  // (this write is what creates the file: `dag.add` lays the node directory down and leaves no spec.md behind,
  // its absence being how "the requirements are not written yet" is expressed).
  const text = await offer.specOf(added.id);
  if (typeof text !== 'string') {
    throw new TypeError(`\`spec_of\` must return the node's text as a string, got ${typeof text}`);
  }
  const specPath = nodeSpecPath(paths, added.id);
  writeFileSync(specPath, text, 'utf8');

  return {
    plugin: offer.plugin,
    nodeId: added.id,
    title: offer.title,
    tags: offer.tags,
    specPath,
    why: offer.why,
    note: offer.note,
  };
}

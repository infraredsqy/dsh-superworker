/**
 * The pipeline plugin's implementation: the one gate its declaration has to name, answered with
 * nothing.
 *
 * This folder's whole content is instruction text (`skills/`). The engine's declaration grammar has
 * no cell for "skills and nothing else": a declaration without `commands` has to name a timing and
 * an action, and a folder whose declaration names one has to carry the implementation entry that
 * answers it. So this file is that answer, and it says the only true thing there is to say at every
 * pass: there is nothing to insert.
 *
 * `offer` is the insert gate at the close. A healthy plugin's usual answer is "none this round",
 * and that is what this one always answers: no node is written, no session is opened, and a
 * project's close stays byte for byte what it was.
 *
 * `offer_preview` is the rehearsal the timing owes: the same answer, asked with nothing to do and
 * nothing to change. This plugin asks no question and reads no record, so the two are one line.
 */
export function offer() {
  return null;
}

export function offer_preview() {
  return null;
}
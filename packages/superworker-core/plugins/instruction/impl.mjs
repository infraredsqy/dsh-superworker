/**
 * The instruction plugin's implementation: the two entry points its declaration names.
 *
 * This folder owns one record — `.superworker/instructions.json` — and one word of the command
 * surface, `instruction`, with the five verbs the account has. The declaration states the word and
 * the files; the verb surface lives in `tools/commands.mjs` and the record layer in
 * `tools/storage.mjs`, both beside this file and both loaded by the host by path.
 *
 * **The close-time cell is occupied, and its answer is always the same:** there is nothing to
 * insert. The engine's declaration grammar has no cell for "commands and nothing else" — a
 * declaration without `commands` has to name a timing and an action, and a folder whose declaration
 * names one has to carry the implementation entry that answers it. So `offer` is that answer, and it
 * says the only true thing there is to say at every pass: no node is written, no session is opened,
 * and a project's close stays byte for byte what it was (the account changes only when a person runs
 * one of its verbs).
 *
 * `offer_preview` is the rehearsal the timing owes: the same answer, asked with nothing to do and
 * nothing to change. This plugin asks no question and reads no record at that door, so the two are
 * one line.
 */
import { main as runCommand } from './tools/commands.mjs'

/** The close-time insert gate: this plugin never inserts anything. */
export function offer() {
  return null
}

/** The rehearsal of `offer`: the same answer, no record read, no byte written. */
export function offer_preview() {
  return null
}

/**
 * `instruction …`: this folder's own command surface. The host hands the rest of the line over
 * (`keep_name: false` takes the word off), with the project root in `ctx.root`.
 */
export async function main(argv, ctx) {
  return runCommand(argv, ctx)
}
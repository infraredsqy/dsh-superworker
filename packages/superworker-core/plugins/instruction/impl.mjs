/**
 * The instruction plugin's implementation: the one entry point its declaration names.
 *
 * This folder owns one record — `.superworker/instructions.json` — and one word of the command
 * surface, `instruction`, with the five verbs the account has. The declaration states the word and
 * the files, and states neither timing nor action: plugins with only commands occupy no cell (the
 * spared branch of `declarationProblems` in `src/plugins/declare.ts`), so there is no close-time
 * door here to ask — the account changes only when a person runs one of its verbs.
 *
 * The verb surface lives in `tools/commands.mjs` and the record layer in `tools/storage.mjs`, both
 * beside this file and both loaded by the host by path.
 */
import { main as runCommand } from './tools/commands.mjs'

/**
 * `instruction …`: this folder's own command surface. The host hands the rest of the line over
 * (`keep_name: false` takes the word off), with the project root in `ctx.root`.
 */
export async function main(argv, ctx) {
  return runCommand(argv, ctx)
}
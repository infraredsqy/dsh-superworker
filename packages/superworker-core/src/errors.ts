/**
 * Decidable errors: the error code is the contract, the wording is up to the caller.
 *
 * The foundation itself reports three codes, each matching exactly one kind of failure:
 *
 * - `invalid_utf8`  the bytes read are not UTF-8;
 * - `parse_failure` the bytes decode as UTF-8, but JSON does not parse;
 * - `lock_timeout`  waiting for the lock hit the limit without getting it, nothing was changed.
 *
 * The settings chain (`src/config.ts`) adds nine codes of its own besides those three:
 *
 * - `unknown_key`        the knob name is not on the list (a refusal names every configurable key);
 * - `invalid_value`      the value does not match the knob's kind — the write side refuses (nothing
 *                        written); the read side stays silent about a value that does not match,
 *                        because it has no effect on any reading;
 * - `layer_not_allowed`  this knob does not accept the layer being written or read up to (a refusal
 *                        names the layers it accepts);
 * - `cycle_not_found`    the line id named is not in this state.json — the same code for a line the
 *                        settings chain's cycle layer names and for one a cycles verb names;
 * - `node_not_found`     the node id named by the layer is not on this project's graph, or its spelling
 *                        is not one node-directory name (a path separator or a `.` / `..` segment never
 *                        becomes a path; an empty id is refused earlier, by the layer pointer, as a
 *                        `TypeError`);
 * - `ambiguous_holder`   a node read cannot be placed on the line layer: this state.json says more than
 *                        one line holds that node (one node is held by one line at a time), so nothing
 *                        was read from the line layer instead of guessing which line was meant;
 * - `not_a_project`      the directory handed to a setting verb holds no `.superworker` of its own (nothing
 *                        is guessed upward from it);
 * - `invalid_config_file` the layer file is JSON but not an object (key -> value).
 * - `worktree_mode_unsupported` the `worktree_mode` read is a mode this engine does not work in
 *                        (only `off` / `fork` are: `reuse` is refused as soon as it is read), the
 *                        mode is handed back to the caller and nothing was touched.
 *
 * The pipeline (`src/conductor.ts`) adds two codes of its own besides `dispatch_blocked`:
 *
 * - `dispatch_blocked`   dispatch was stopped by a plugin gate (the reasons are listed one per line
 *                        in the message, nothing was touched).
 * - `nothing_to_settle`  closing a line is refused: this node's handoff ticket is missing or
 *                        still `pending`, so there is no verdict to settle (the marker left by a
 *                        re-run is refused the same way), nothing was touched.
 * - `not_holding`        the node named is not on this line's claim list: the ticket has nowhere to
 *                        be written, the line has nothing to settle, nothing was touched.
 *
 * Other disk failures (permissions, a path out of bounds …) are thrown as Node's own errors: those
 * already carry a decidable `code`, and the foundation does not add a second vocabulary layer. The
 * caller branches on `code` and writes the wording itself.
 */

export type RecordErrorCode =
  | 'invalid_utf8'
  | 'parse_failure'
  | 'lock_timeout'
  | 'unknown_key'
  | 'invalid_value'
  | 'layer_not_allowed'
  | 'cycle_not_found'
  | 'node_not_found'
  | 'ambiguous_holder'
  | 'not_a_project'
  | 'invalid_config_file'
  | 'dispatch_blocked'
  | 'nothing_to_settle'
  | 'not_holding'
  | 'worktree_mode_unsupported';

export class RecordError extends Error {
  readonly code: RecordErrorCode;

  /** The path of the record or the lock being faced when the error happened (for diagnostics; how to present it is up to the caller). */
  readonly path: string;

  constructor(
    code: RecordErrorCode,
    path: string,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'RecordError';
    this.code = code;
    this.path = path;
  }
}

/** Tell whether a thrown value is a RecordError carrying this code (the wording is not touched, only the code is read). */
export function isRecordError(value: unknown, code?: RecordErrorCode): value is RecordError {
  return value instanceof RecordError && (code === undefined || value.code === code);
}

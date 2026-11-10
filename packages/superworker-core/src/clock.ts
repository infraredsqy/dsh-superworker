import type { MicroTimestamp, SecondsTimestamp } from './types';

/**
 * The record timestamp "now": the microsecond shape the graph (node records) uses,
 * UTC with a literal `Z` (`2026-01-01T00:00:00.000000Z`). Seconds and milliseconds
 * come from the wall clock (`Date.now()`), the microsecond tail from the monotonic
 * clock (`process.hrtime.bigint()`) — the wall clock is only millisecond-coarse, the
 * monotonic clock fills the elapsed time between two readings down to microseconds,
 * so the microsecond digits are real and no longer always zero. Strictly increasing
 * within the process — writes in the same microsecond each get their own timestamp,
 * none shares a value with another.
 *
 * Lines (state.json), handoff tickets and session files use the seconds
 * shape (`2026-01-01T00:00:00Z`): the wall clock truncated to seconds, writes in the
 * same second share one reading — the seconds shape is coarse by design.
 */

const PAD_WIDTH = 2;

function pad(value: number, width: number = PAD_WIDTH): string {
  return String(value).padStart(width, '0');
}

/** The microsecond-shape spelling of an epoch-microsecond reading (seconds and milliseconds go into Date, the last three digits are the microsecond remainder). */
export function microTimestampOf(epochUs: number): MicroTimestamp {
  const epochMs = Math.floor(epochUs / 1000);
  const microRemainder = epochUs - epochMs * 1000;
  const moment = new Date(epochMs);
  return (
    `${pad(moment.getUTCFullYear(), 4)}-${pad(moment.getUTCMonth() + 1)}-${pad(moment.getUTCDate())}` +
    `T${pad(moment.getUTCHours())}:${pad(moment.getUTCMinutes())}:${pad(moment.getUTCSeconds())}` +
    `.${pad(moment.getUTCMilliseconds() * 1000 + microRemainder, 6)}Z`
  );
}

/**
 * The anchor pair of the microsecond clock: wall clock and monotonic clock each take
 * one reading at the same moment, and later microseconds are filled in from the
 * monotonic clock's elapsed time. When the monotonic reading drifts from the wall
 * clock by more than a millisecond (the clock was set, the machine woke up) the anchor
 * is taken again — timestamps always stay close to the wall clock.
 */
let anchorWallUs = 0;
let anchorNs = 0n;
let lastUs = Number.NEGATIVE_INFINITY;

const REANCHOR_TOLERANCE_US = 1000;

function epochMicros(): number {
  const wallMs = Date.now();
  const ns = process.hrtime.bigint();
  if (anchorNs === 0n) {
    anchorWallUs = wallMs * 1000;
    anchorNs = ns;
  }
  let us = anchorWallUs + Number((ns - anchorNs) / 1000n);
  if (Math.abs(wallMs * 1000 - us) > REANCHOR_TOLERANCE_US) {
    // The monotonic reading drifted from the wall clock by more than a millisecond (clock set,
    // machine woken up): re-anchor so timestamps stay close to the wall clock again.
    anchorWallUs = wallMs * 1000;
    anchorNs = ns;
    us = anchorWallUs;
  }
  if (us <= lastUs) us = lastUs + 1;
  lastUs = us;
  return us;
}

/** The microsecond-shape timestamp of now; strictly increasing within the process, one value per write. */
export function nowMicro(): MicroTimestamp {
  return microTimestampOf(epochMicros());
}

/** The seconds-shape spelling of an epoch-microsecond reading (the sub-second tail is cut off, UTC with a literal `Z`). */
export function secondsTimestampOf(epochUs: number): SecondsTimestamp {
  const moment = new Date(Math.floor(epochUs / 1000));
  return (
    `${pad(moment.getUTCFullYear(), 4)}-${pad(moment.getUTCMonth() + 1)}-${pad(moment.getUTCDate())}` +
    `T${pad(moment.getUTCHours())}:${pad(moment.getUTCMinutes())}:${pad(moment.getUTCSeconds())}Z`
  );
}

/**
 * The seconds-shape timestamp of now (the shape lines, handoff tickets and session files
 * use); drawn from the same microsecond clock, also increasing within the process.
 *
 * The spelling is `secondsTimestampOf`'s, not a second one cut out of the micro shape: a test that pins
 * the clock hands out `secondsTimestampOf` too, so the pinned and the live path have to be one spelling
 * — two of them could drift apart with the whole golden corpus still green.
 */
export function nowSeconds(): SecondsTimestamp {
  return secondsTimestampOf(epochMicros());
}

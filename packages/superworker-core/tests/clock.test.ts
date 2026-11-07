import { describe, expect, it } from 'vitest';
import { microTimestampOf, nowMicro, nowSeconds, secondsTimestampOf } from '../src/clock.ts';

/**
 * Timestamp-shape invariants: the micro spelling is legal, strictly increasing within the process,
 * and its microsecond tail comes from a real microsecond clock (no longer always the 000 of a
 * millisecond times a thousand). The seconds form (the "now" of cycles, handoffs, instructions and
 * session notes) is truncated to the second. Only invariants are locked — the concrete readings
 * follow the wall clock and are not.
 */

const MICRO_SHAPE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
const SECONDS_SHAPE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

describe('nowMicro: timestamp shape and monotonicity', () => {
  it('the spelling is the micro form (UTC with a literal Z) and strictly increases within the process', () => {
    const readings = Array.from({ length: 40 }, () => nowMicro());
    for (const value of readings) expect(value).toMatch(MICRO_SHAPE);
    for (let index = 1; index < readings.length; index++) {
      expect(readings[index]! > readings[index - 1]!).toBe(true);
    }
  });

  it('the microsec tail is real: a run of readings cannot all end in 000 (the old millisecond-times-a-thousand flaw)', () => {
    const readings = Array.from({ length: 40 }, () => nowMicro());
    const roundTails = readings.filter((value) => value.endsWith('000Z'));
    expect(roundTails.length).toBeLessThan(readings.length);
  });

  it('microTimestampOf: the microsecond remainder is spelled into the sixth through ninth digits as is', () => {
    expect(microTimestampOf(0)).toBe('1970-01-01T00:00:00.000000Z');
    expect(microTimestampOf(1700000000123456)).toBe('2023-11-14T22:13:20.123456Z');
    expect(microTimestampOf(1700000000123000)).toBe('2023-11-14T22:13:20.123000Z');
  });
});

describe('nowSeconds: the seconds form on the cycle (state.json) side', () => {
  it('the spelling is the seconds form (UTC with a literal Z) with the fraction cut clean off', () => {
    const readings = Array.from({ length: 5 }, () => nowSeconds());
    for (const value of readings) expect(value).toMatch(SECONDS_SHAPE);
  });

  it('secondsTimestampOf: everything below the second is truncated as is', () => {
    expect(secondsTimestampOf(0)).toBe('1970-01-01T00:00:00Z');
    expect(secondsTimestampOf(1700000000123456)).toBe('2023-11-14T22:13:20Z');
    expect(secondsTimestampOf(1700000000999999)).toBe('2023-11-14T22:13:20Z');
    expect(secondsTimestampOf(1700000001000000)).toBe('2023-11-14T22:13:21Z');
  });

  it('the seconds reading and the micro reading sit on the same wall clock (within the same few seconds)', () => {
    const micro = nowMicro();
    const seconds = nowSeconds();
    expect(seconds.slice(0, 10)).toBe(micro.slice(0, 10));
  });
});

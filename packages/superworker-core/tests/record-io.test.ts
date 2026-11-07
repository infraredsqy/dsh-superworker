import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { isRecordError, RecordError } from '../src/errors.ts';
import { atomicWriteJson, jsonOptionsForRecord, readJsonFile } from '../src/jsonio.ts';
import { recordPaths } from '../src/paths.ts';

/**
 * The three readings of a read, plus a write-read round trip: present, missing (whether that
 * counts as empty is the caller's call), unparseable (the code is decidable, and nothing is ever
 * repaired on its own). Every engine operation lands in a temp dir.
 */

let workdir: string | undefined;

function tempPaths(): ReturnType<typeof recordPaths> {
  workdir = mkdtempSync(join(tmpdir(), 'superworker-io-'));
  const paths = recordPaths(workdir);
  // The test that writes raw bytes sets up its own records dir; the atomic writer and the lock
  // each create the dirs they need.
  mkdirSync(paths.recordDir, { recursive: true });
  return paths;
}

afterEach(() => {
  if (workdir !== undefined) {
    rmSync(workdir, { recursive: true, force: true });
    workdir = undefined;
  }
});

describe('the three readings of a read', () => {
  it('missing: the file is not there, missing comes back, and the reading carries no default of its own', async () => {
    const paths = tempPaths();
    expect(await readJsonFile(paths.stateJson, 'state.json')).toEqual({ kind: 'missing' });
  });

  it('present: a write-read round trip, unknown fields kept as they are, no validation and no rewriting', async () => {
    const paths = tempPaths();
    const dag = {
      nodes: {
        'aaaaaaaa-0001': {
          title: 'base',
          status: 'todo',
          mode: 'auto',
          dependencies: [],
          created_at: '2026-11-02T05:05:24.086827Z',
          updated_at: '2026-11-02T05:05:24.086827Z',
          future_field: { unknown: true },
        },
      },
    };
    await atomicWriteJson(paths.ideasJson, dag, jsonOptionsForRecord('ideas'));
    const reading = await readJsonFile(paths.ideasJson, 'ideas.json');
    expect(reading.kind).toBe('present');
    expect(reading.kind === 'present' && reading.value).toEqual(dag);
  });

  it('bytes are not UTF-8: invalid_utf8, and the file stays exactly where it was', async () => {
    const paths = tempPaths();
    const corrupt = [0x7b, 0xff, 0xfe, 0x7d];
    writeFileSync(paths.stateJson, Buffer.from(corrupt));
    const outcome = await readJsonFile(paths.stateJson, 'state.json').then(
      () => 'no-error',
      (error: unknown) => error,
    );
    expect(isRecordError(outcome, 'invalid_utf8')).toBe(true);
    expect((outcome as RecordError).path).toBe(paths.stateJson);
    expect((outcome as RecordError).cause).toBeInstanceOf(Error);
    // Never repaired on its own: every bad byte is still there.
    expect([...readFileSync(paths.stateJson)]).toEqual(corrupt);
  });

  it('bytes are UTF-8 but not JSON: parse_failure', async () => {
    const paths = tempPaths();
    writeFileSync(paths.stateJson, '{ nope');
    const outcome = await readJsonFile(paths.stateJson, 'state.json').then(
      () => 'no-error',
      (error: unknown) => error,
    );
    expect(isRecordError(outcome, 'parse_failure')).toBe(true);
  });

  it('a record with a byte order mark follows the same rule: parse failure', async () => {
    const paths = tempPaths();
    writeFileSync(paths.stateJson, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('{"a":1}', 'utf8')]));
    const outcome = await readJsonFile(paths.stateJson, 'state.json').then(
      () => 'no-error',
      (error: unknown) => error,
    );
    expect(isRecordError(outcome, 'parse_failure')).toBe(true);
  });

  it('an empty file is a parse failure, not an empty record', async () => {
    const paths = tempPaths();
    writeFileSync(paths.stateJson, Buffer.alloc(0));
    const outcome = await readJsonFile(paths.stateJson, 'state.json').then(
      () => 'no-error',
      (error: unknown) => error,
    );
    expect(isRecordError(outcome, 'parse_failure')).toBe(true);
  });

  it('the error code is the contract: isRecordError only accepts a matching code, and message and code stay independent', async () => {
    const paths = tempPaths();
    writeFileSync(paths.stateJson, 'not json at all');
    const outcome = await readJsonFile(paths.stateJson, 'state.json').then(
      () => 'no-error',
      (error: unknown) => error,
    );
    expect(isRecordError(outcome)).toBe(true);
    expect(isRecordError(outcome, 'invalid_utf8')).toBe(false);
    expect(isRecordError(outcome, 'lock_timeout')).toBe(false);
    expect(new RecordError('parse_failure', 'x', 'y').code).toBe('parse_failure');
  });
});

/* The drill: every command the transport layer prints, run against a project that has records of
 * its own, with the answer fixed beside it.
 *
 * The fixture project under `fixtures/pf-cli/project` carries those records, and every
 * `expected/*.txt` is the stdout that argv has for them. A case therefore passes when this
 * checkout's command answers the same bytes.
 *
 * `fixtures/pf-cli/overlay` carries the bytes a real project keeps out of git -- its session files and
 * the temp files a node left behind -- and is pasted over each case's copy: a checkout only ever
 * brings back tracked files, so those bytes cannot ride inside `project` itself.
 *
 * The engine package must be built (`packages/pf-core/dist`), because the command imports its product;
 * `npm test` builds it first. Without it every case skips itself with that reason.
 *
 *   node --test tests/
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const entry = join(root, 'bin', 'pf.mjs');
const fixture = join(root, 'tests', 'fixtures', 'pf-cli');
const built = existsSync(join(root, 'packages', 'pf-core', 'dist', 'index.mjs'));
const skip = built ? false : 'packages/pf-core/dist is not built: run `npm test`, or build the engine package first';

const cases = JSON.parse(readFileSync(join(fixture, 'cases.json'), 'utf8'));
const ids = JSON.parse(readFileSync(join(fixture, 'ids.json'), 'utf8'));

/** The word substitutions a case's argv carries (`{A}` is one node's id). */
function expand(word) {
  return word
    .replace('{A8}', ids.A.slice(0, 8))
    .replace('{A4}', ids.A.slice(0, 4))
    .replace('{A}', ids.A)
    .replace('{B}', ids.B)
    .replace('{C}', ids.C)
    .replace('{D}', ids.D)
    .replace('{E}', ids.E);
}

/** One case in its own copy of the fixture project: the case's prepare steps, then its line. */
function runCase(entryOfBattery) {
  const work = mkdtempSync(join(tmpdir(), 'pf-cli-'));
  const project = join(work, 'project');
  const home = join(work, 'home');
  cpSync(join(fixture, 'project'), project, { recursive: true });
  cpSync(join(fixture, 'overlay'), project, { recursive: true });
  const env = {
    ...process.env,
    PF_HOME_DIR: home,
    PF_PLUGINS_DIR: join(root, 'packages', 'pf-core', 'plugins'),
    DSH_CONDUCT_SPAWN_DRY_RUN: '1',
  };
  for (const command of entryOfBattery.setup) {
    spawnSync(process.execPath, [entry, ...command.map(expand)], { cwd: project, env, encoding: 'utf8' });
  }
  const result = spawnSync(process.execPath, [entry, ...entryOfBattery.argv.map(expand)], {
    cwd: project,
    env,
    encoding: 'utf8',
  });
  const expected = readFileSync(join(fixture, 'expected', `${entryOfBattery.name}.txt`), 'utf8');
  const actual = (result.stdout ?? '').replace(/\r\n/gu, '\n');
  rmSync(work, { recursive: true, force: true });
  return { expected, actual, code: result.status, stderr: result.stderr ?? '' };
}

for (const entryOfBattery of cases) {
  test(`drill: pf ${entryOfBattery.argv.join(' ')} 与捕获的字节同形`, { skip }, () => {
    const answer = runCase(entryOfBattery);
    assert.equal(answer.code, 0, answer.stderr);
    assert.equal(answer.actual, answer.expected);
  });
}
/* The parity contract: the same argv answered in-process by the engine's `answer()` and by the
 * transport's subprocess (`bin/pf.mjs`) must come back the same three ways — stdout, stderr and the
 * exit code, byte for byte. This is what makes the agent-facing tool path and the command line one
 * words layer with one answer, not two spellings of it.
 *
 * Four lines cover the four kinds of answer: the top listing (help), a read word, a write word, and
 * a refusal. Each runs against its own copy of the drill project, with the machine home and the
 * shipped plugins handed to both sides the same way (`PF_HOME_DIR` / `PF_PLUGINS_DIR` for the
 * subprocess, the same values as `io` for the in-process call).
 *
 * `packages/pf-core/dist` must be built (`npm test` builds it first); without it every case skips
 * itself with that reason.
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

const repo = fileURLToPath(new URL('..', import.meta.url));
const entry = join(repo, 'bin', 'pf.mjs');
const fixture = join(repo, 'tests', 'fixtures', 'pf-cli');
const shippedPlugins = join(repo, 'packages', 'pf-core', 'plugins');
const built = existsSync(join(repo, 'packages', 'pf-core', 'dist', 'index.mjs'));
const skip = built ? false : 'packages/pf-core/dist is not built: run `npm test`, or build the engine package first';

/** One scratch copy of the drill project and its machine home. */
function scratch() {
  const work = mkdtempSync(join(tmpdir(), 'pf-parity-'));
  const project = join(work, 'project');
  const home = join(work, 'home');
  cpSync(join(fixture, 'project'), project, { recursive: true });
  cpSync(join(fixture, 'overlay'), project, { recursive: true });
  return {
    work,
    project,
    home,
    done() {
      rmSync(work, { recursive: true, force: true });
    },
  };
}

/** The transport side: the entry as a subprocess, on the same env a real run carries. */
function runSubprocess(argv, { project, home }) {
  const result = spawnSync(process.execPath, [entry, ...argv], {
    cwd: project,
    env: {
      ...process.env,
      PF_HOME_DIR: home,
      PF_PLUGINS_DIR: shippedPlugins,
      DSH_CONDUCT_SPAWN_DRY_RUN: '',
    },
    encoding: 'utf8',
  });
  return { code: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

/** The tool side: the engine's `answer()` in this process, on the same seams. */
async function runInProcess(argv, { project, home }) {
  const { answer } = await import('pf-core');
  return answer(argv, {
    root: project,
    executor: {
      async dispatch() {
        throw new Error('no session opener is wired into this parity run');
      },
    },
    homeDir: home,
    pluginsDir: shippedPlugins,
    openerAvailable: false,
  });
}

const CASES = [
  { name: 'help（顶层清单）', argv: ['--help'] },
  { name: '读词（dag list）', argv: ['dag', 'list'] },
  { name: '写词（config set）', argv: ['config', 'set', 'test_tier', 'minimal'] },
  { name: '拒绝（不认识的词）', argv: ['nope'] },
];

for (const { name, argv } of CASES) {
  test(`对拍：pf ${argv.join(' ')} 两条路逐字节同形`, { skip }, async () => {
    const stage = scratch();
    try {
      const subprocess = runSubprocess(argv, stage);
      const inProcess = await runInProcess(argv, stage);
      assert.equal(inProcess.code, subprocess.code, `exit code differs (${name})`);
      assert.equal(inProcess.stdout, subprocess.stdout, `stdout differs (${name})`);
      assert.equal(inProcess.stderr, subprocess.stderr, `stderr differs (${name})`);
    } finally {
      stage.done();
    }
  });
}

test('对拍：写词那一笔两条路落在盘上的字节也一致', { skip }, async () => {
  const first = scratch();
  const second = scratch();
  try {
    runSubprocess(['config', 'set', 'test_tier', 'minimal'], first);
    await runInProcess(['config', 'set', 'test_tier', 'minimal'], second);
    const written = join('.pf', 'config.json');
    const fromSubprocess = readFileSync(join(first.project, written), 'utf8');
    const fromTool = readFileSync(join(second.project, written), 'utf8');
    assert.equal(fromTool, fromSubprocess, 'the project layer file the two paths wrote differs');
    assert.match(fromSubprocess, /"test_tier": "minimal"/u);
  } finally {
    first.done();
    second.done();
  }
});

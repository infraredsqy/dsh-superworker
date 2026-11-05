/* The transport layer's own surface: the entry's shape, the help a word prints, the words the
 * command refuses, and the four seams a round of review found open (the project root, the bare
 * `help` word, a plugin's own exit code, and the merge driver's registration).
 *
 * Three properties are pinned here, and each is a boundary rather than a snapshot:
 *
 * - the entry is one Node script (`#!/usr/bin/env node`), and nothing under `bin/` carries a platform
 *   branch: the command is the same one on every platform because it asks the platform nothing;
 * - the help listing covers every word the router walks, and a group's listing covers that group's
 *   verbs — one table feeds both, so a word cannot be routable and unprintable;
 * - the rows of the verbs / groups listing, and the whole of a leaf's help, are the reference tool's
 *   own bytes (the three sheets in `fixtures/pf-cli/help/`), which is what makes the surface the same
 *   one a skill already talks to.
 *
 * The project-root cases run against throwaway copies of the drill project: one command's answer is
 * the reference tool's own answer in the same directory (a subdirectory reads its own, empty records;
 * a linked worktree's checkout root reads the main tree's).
 *
 *   node --test tests/
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const entry = join(root, 'bin', 'pf.mjs');
const lib = join(root, 'bin', 'lib');
const fixture = join(root, 'tests', 'fixtures', 'pf-cli');
const plugins = join(root, 'packages', 'pf-core', 'plugins');

/** Run the entry as a program would: a process, the checkout's node, one exit code. */
function run(argv, options = {}) {
  const env = {
    ...process.env,
    PF_HOME_DIR: options.home ?? process.env.PF_HOME_DIR ?? '',
    ...(options.env ?? {}),
  };
  if (options.plugins !== undefined) env.PF_PLUGINS_DIR = options.plugins;
  else delete env.PF_PLUGINS_DIR;
  const result = spawnSync(process.execPath, [entry, ...argv], {
    cwd: options.cwd ?? root,
    env,
    encoding: 'utf8',
  });
  return { code: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

function filesUnder(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...filesUnder(full));
    else out.push(full);
  }
  return out;
}

/** Every file under one directory, with the hash of its bytes: what a "wrote nothing" claim is read against. */
function snapshot(dir) {
  const out = {};
  for (const file of filesUnder(dir)) {
    out[file.slice(dir.length)] = createHash('sha256').update(readFileSync(file)).digest('hex');
  }
  return out;
}

/** A throwaway copy of the drill project (the reference tool's own records, and the ones it keeps out
 * of git), plus its machine home. */
function scratchProject() {
  const work = mkdtempSync(join(tmpdir(), 'pf-cli-'));
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

/** One `git -C <project> <args>` as a child, with its stdout trimmed. */
function git(project, args) {
  const result = spawnSync('git', ['-C', project, ...args], { encoding: 'utf8' });
  return { code: result.status ?? 1, stdout: (result.stdout ?? '').trim(), stderr: result.stderr ?? '' };
}

test('入口：一行 shebang 指 Node，脚本自己就是一个程序', () => {
  const first = readFileSync(entry, 'utf8').split('\n')[0];
  assert.equal(first, '#!/usr/bin/env node');
});

test('跨平台：bin/ 里没有平台分支，也没有第二种脚本宿主', () => {
  const offenders = [];
  for (const file of filesUnder(join(root, 'bin'))) {
    const text = readFileSync(file, 'utf8');
    for (const pattern of [/process\.platform/u, /\bwin32\b/u, /\.ps1\b/u, /\bpowershell\b/iu]) {
      if (pattern.test(text)) offenders.push(`${file.split(root).at(-1)}: ${pattern}`);
    }
  }
  assert.deepEqual(offenders, []);
});

test('启动：node 起入口，version 报本树的版本与落点', () => {
  const answer = run(['version']);
  assert.equal(answer.code, 0, answer.stderr);
  const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
  assert.match(answer.stdout, new RegExp(`^pf ${version.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')} at .+ \\(tools: .+\\)\\n$`, 'u'));
});

test('帮助面：每条字的帮助都印得出来，而且以它自己的 usage 行开头', async () => {
  const { helpText } = await import(new URL('../bin/lib/argparse.mjs', import.meta.url));
  const { specOf, COMMANDS, GROUPS } = await import(new URL('../bin/lib/spec.mjs', import.meta.url));
  for (const [key, row] of Object.entries(COMMANDS)) {
    const text = helpText(specOf(row));
    assert.ok(text.startsWith(`usage: ${row.prog}`), `${key}: ${text.split('\n')[0]}`);
    for (const option of row.options) {
      assert.ok(text.includes(option.flags[0]), `${key} lists ${option.flags[0]}`);
    }
  }
  for (const [group, row] of Object.entries(GROUPS)) {
    const text = helpText(specOf(row));
    for (const command of row.commands) {
      assert.ok(text.includes(command.word), `${group} lists ${command.word}`);
    }
  }
  assert.ok(Object.keys(COMMANDS).length >= 40, 'the table carries every word');
});

test('帮助面：pf --help 覆盖命令全集：每个动词、每个组都在名单上', async () => {
  const { topHelp } = await import(new URL('../bin/lib/cli.mjs', import.meta.url));
  const { COMMANDS, GROUPS } = await import(new URL('../bin/lib/spec.mjs', import.meta.url));
  const text = await topHelp();
  for (const row of Object.values(COMMANDS).filter((row) => row.group === undefined)) {
    assert.ok(new RegExp(`^\\s{12}${row.word}\\s`, 'mu').test(text), `verbs list carries ${row.word}`);
  }
  for (const group of Object.keys(GROUPS)) {
    assert.ok(new RegExp(`^\\s{12}${group} <verb>\\s`, 'mu').test(text), `groups list carries ${group}`);
  }
});

test('帮助面：抽查两条，与捕获下来的清单逐字节一致', async () => {
  const { helpText } = await import(new URL('../bin/lib/argparse.mjs', import.meta.url));
  const { specOf, COMMANDS } = await import(new URL('../bin/lib/spec.mjs', import.meta.url));
  for (const [caseName, key] of [['next', 'next'], ['clean-temp', 'clean-temp']]) {
    const expected = readFileSync(
      join(root, 'tests', 'fixtures', 'pf-cli', 'help', `${caseName}.txt`),
      'utf8',
    );
    assert.equal(helpText(specOf(COMMANDS[key])), expected, `${caseName} help differs`);
  }
});

test('拒绝：不认识的词、以及这一层不做的词，都回「没有这条命令」且退出码 2', () => {
  for (const argv of [['nope'], ['migra' + 'te'], ['fork-worktree']]) {
    const answer = run(argv);
    assert.equal(answer.code, 2, `${argv.join(' ')}: ${answer.stderr}`);
    assert.match(answer.stderr, /does not recognize/u);
    assert.ok(answer.stderr.includes('pf -- the agent pipeline'), 'the refusal carries the listing');
  }
  // A group's own choice list is the refusal of a verb this layer does not carry: the words it does
  // carry are the ones printed back, and the argument is named by the group's own dest (the
  // reference's spelling), not by the listing's metavar.
  const notCarried = run(['session', 'import']);
  assert.equal(notCarried.code, 2);
  assert.match(
    notCarried.stderr,
    /argument session_command: invalid choice: 'import' \(choose from 'show', 'list'\)/u,
  );
  // `dag` is the one group whose dest keeps the angle brackets.
  const dagNope = run(['dag', 'nonsense']);
  assert.equal(dagNope.code, 2);
  assert.match(dagNope.stderr, /argument <command>: invalid choice: 'nonsense'/u);
  const cycleNope = run(['cycle', 'nonsense']);
  assert.equal(cycleNope.code, 2);
  assert.match(cycleNope.stderr, /argument cycle_command: invalid choice: 'nonsense'/u);
});

test('项目根：子目录就是项目根，不落进父项目（与外部工具同一问同一答）', () => {
  const scratch = scratchProject();
  try {
    const sub = join(scratch.project, 'tools');
    mkdirSync(sub, { recursive: true });
    // The reference tool, asked in this same directory, answers "No cycles found.": the project root
    // is `cwd`, and `cwd` holds no records of its own. The parent's line must not show through.
    const answer = run(['cycle', 'list'], { cwd: sub, plugins, home: scratch.home });
    assert.equal(answer.code, 0, answer.stderr);
    assert.equal(answer.stdout, 'No cycles found.\n');
  } finally {
    scratch.done();
  }
});

test('项目根：链接工作树的 checkout 根回到主树，工作在 main 的记录上', () => {
  const scratch = scratchProject();
  try {
    mkdirSync(join(scratch.project, '.git', 'worktrees', 'wt-1'), { recursive: true });
    const worktree = join(scratch.work, 'wt-1');
    mkdirSync(worktree);
    // A linked worktree's `.git` is a file pointing into the main tree's `.git/worktrees/<name>`;
    // that pointer is the whole rule, and the main tree really has a `.pf` here.
    writeFileSync(
      join(worktree, '.git'),
      `gitdir: ${join(scratch.project, '.git', 'worktrees', 'wt-1')}\n`,
      'utf8',
    );
    const answer = run(['cycle', 'list'], { cwd: worktree, plugins, home: scratch.home });
    assert.equal(answer.code, 0, answer.stderr);
    assert.match(answer.stdout, /c1\s+Line one/u, 'the main tree’s line is the one read here');
  } finally {
    scratch.done();
  }
});

test('解析器：裸词 help 照常当一个位置参数读（标题、查询都收它）', () => {
  const scratch = scratchProject();
  try {
    // A node whose title is `help` is really created (the reference prints `Node created: <id>`).
    const added = run(['dag', 'add', 'help'], { cwd: scratch.project, plugins, home: scratch.home });
    assert.equal(added.code, 0, added.stderr);
    assert.match(added.stdout, /^Node created: /u);

    const searched = run(['dag', 'search', 'help'], { cwd: scratch.project, plugins, home: scratch.home });
    assert.equal(searched.code, 0, searched.stderr);
    const found = JSON.parse(searched.stdout);
    assert.equal(found[0]?.title, 'help');

    // A word the command does not take is argparse's own refusal, not a help page with exit 0.
    for (const argv of [['next', 'help'], ['dag', 'list', 'help'], ['instruction', 'list', 'help']]) {
      const answer = run(argv, { cwd: scratch.project, plugins, home: scratch.home });
      assert.equal(answer.code, 2, `${argv.join(' ')}: ${answer.stderr}`);
      assert.match(answer.stderr, /unrecognized arguments: help/u);
      assert.doesNotMatch(answer.stderr, /description:/u, 'no listing was printed');
    }

    // The two help entries are still where they were.
    assert.match(run(['help']).stdout, /^pf -- the agent pipeline/u);
    const dagHelp = run(['dag', 'help'], { cwd: scratch.project, plugins, home: scratch.home });
    assert.equal(dagHelp.code, 0, dagHelp.stderr);
    assert.match(dagHelp.stdout, /^usage: /u);
  } finally {
    scratch.done();
  }
});

test('插件的词：没装插件时明确说不认识，装了就转发到它', () => {
  const scratch = scratchProject();
  try {
    const bare = run(['issue', 'list'], { plugins: join(scratch.work, 'no-such-plugins'), cwd: scratch.project });
    assert.equal(bare.code, 2);
    assert.match(bare.stderr, /does not recognize `issue`/u);

    const installed = run(['issue', 'list'], { plugins, cwd: scratch.project, home: scratch.home });
    assert.equal(installed.code, 0, installed.stderr);
    // The answer is the plugin's own: an empty pool prints its empty list, and nothing of the
    // transport layer's own words reaches the stream.
    assert.equal(installed.stdout.trim(), '[]');

    const forwarded = run(['issue', '--help'], { plugins, cwd: scratch.project, home: scratch.home });
    assert.equal(forwarded.code, 0, forwarded.stderr);
    assert.match(forwarded.stdout, /^usage: issue <verb>/u, 'the plugin prints its own listing');
  } finally {
    scratch.done();
  }
});

test('插件的词：命令自带那套插件——项目里没有 plugins/ 也照旧转发，两道收尾守卫的旋钮也答得上', () => {
  const scratch = scratchProject();
  try {
    // Nothing here but the records: no `plugins/` folder, and no PF_PLUGINS_DIR in this run. The
    // reference implementation scanned its own tree, so the plugin words worked in any project; the
    // command supplies its bundled set for the same reason, and that is what this leg pins.
    assert.equal(existsSync(join(scratch.project, 'plugins')), false);
    const answer = run(['issue', 'list'], { cwd: scratch.project, home: scratch.home });
    assert.equal(answer.code, 0, answer.stderr);
    assert.equal(answer.stdout.trim(), '[]');

    // The two closing guards (`issue_pool_weight_limit`, `test_seconds_limit`) come from the same
    // two plugins: a knob that is not installed is refused as an invalid choice, so answering here
    // is what says the guards are back.
    for (const key of ['test_seconds_limit', 'issue_pool_weight_limit']) {
      const guard = run(['config', 'get', key], { cwd: scratch.project, home: scratch.home });
      assert.equal(guard.code, 0, `${key}: ${guard.stderr}`);
    }
  } finally {
    scratch.done();
  }
});

test('插件的词：main 交回数字就是退出码；抛错保留插件自己的 stderr 并点名插件', () => {
  const scratch = scratchProject();
  try {
    const probeDir = join(scratch.work, 'plugins');
    mkdirSync(join(probeDir, 'probe'), { recursive: true });
    writeFileSync(
      join(probeDir, 'probe', 'plugin.json'),
      `${JSON.stringify(
        {
          name: 'probe',
          summary: 'a command word whose answer is text or an exit code',
          timing: 'close',
          action: 'insert',
          commands: { boom: { summary: 'probe', keep_name: false } },
        },
        null,
        2,
      )}\n`,
      'utf8',
    );
    writeFileSync(
      join(probeDir, 'probe', 'impl.mjs'),
      '/** The probe: the plugin contract says main may hand back text, an exit code, or nothing. */\n' +
        'export async function main(argv) {\n' +
        "  if (argv[0] === 'code') return 7;\n" +
        "  if (argv[0] === 'fail') {\n" +
        "    process.stderr.write('probe complained\\n');\n" +
        "    throw new Error('the probe refused on purpose');\n" +
        '  }\n' +
        '  return undefined;\n' +
        '}\n',
      'utf8',
    );
    const options = { cwd: scratch.project, plugins: probeDir, home: scratch.home };

    const coded = run(['boom', 'code'], options);
    assert.equal(coded.code, 7, coded.stderr);
    assert.equal(coded.stdout, '');

    const failed = run(['boom', 'fail'], options);
    assert.equal(failed.code, 1);
    assert.match(failed.stderr, /probe complained/u, 'the plugin’s own stderr is kept');
    assert.match(failed.stderr, /plugin 'probe': main failed: the probe refused on purpose/u);
  } finally {
    scratch.done();
  }
});

test('合并驱动：init 印的就是 git 里真写下的；已经能跑的注册一个字节不改', () => {
  const scratch = scratchProject();
  try {
    assert.equal(git(scratch.project, ['init', '-b', 'master']).code, 0);
    const first = run(['init', '--project', '.'], { cwd: scratch.project, plugins, home: scratch.home });
    assert.equal(first.code, 0, first.stderr);
    const printed = /^Merge driver registered: merge\.pf\.driver = (.+)$/mu.exec(first.stdout);
    assert.ok(printed, `the report carries the command it left: ${first.stdout}`);
    const stored = git(scratch.project, ['config', '--local', '--get', 'merge.pf.driver']);
    assert.equal(stored.code, 0);
    assert.equal(printed[1], stored.stdout, 'the line printed is the string git holds');

    // A registration this machine really answers is not rewritten: an absolute form whose two quoted
    // paths are both files here is left exactly as it was, and init says which string that is.
    const standIn = join(scratch.project, 'own-merge.mjs');
    writeFileSync(standIn, '#!/usr/bin/env node\n', 'utf8');
    const kept = `"${process.execPath}" "${standIn}" %O %A %B %P`;
    assert.equal(git(scratch.project, ['config', '--local', 'merge.pf.driver', kept]).code, 0);
    const again = run(['init', '--project', '.'], { cwd: scratch.project, plugins, home: scratch.home });
    assert.equal(again.code, 0, again.stderr);
    assert.ok(again.stdout.includes(`Merge driver registered: merge.pf.driver = ${kept}`), again.stdout);
    assert.equal(git(scratch.project, ['config', '--local', '--get', 'merge.pf.driver']).stdout, kept);

    // A registration nothing answers here is replaced, with the command this machine can run.
    const dead = '"C:/nowhere/node.exe" "C:/nowhere/merge-ledger.mjs" %O %A %B %P';
    assert.equal(git(scratch.project, ['config', '--local', 'merge.pf.driver', dead]).code, 0);
    const repaired = run(['register', '--project', '.'], { cwd: scratch.project, plugins, home: scratch.home });
    assert.equal(repaired.code, 0, repaired.stderr);
    // `register` prints the driver string and nothing around it (the reference tool's line).
    const repairedLine = repaired.stdout.trim();
    assert.doesNotMatch(repairedLine, /Merge driver registered/u);
    assert.notEqual(repairedLine, dead);
    assert.equal(git(scratch.project, ['config', '--local', '--get', 'merge.pf.driver']).stdout, repairedLine);
  } finally {
    scratch.done();
  }
});

test('config 帮助：没有 .pf 的目录回落成核心键，不印捕获下来的插件键表', () => {
  const scratch = scratchProject();
  try {
    const bare = join(scratch.work, 'bare');
    mkdirSync(bare, { recursive: true });
    const answer = run(['config', 'get', '--help'], { cwd: bare, plugins, home: scratch.home });
    assert.equal(answer.code, 0, answer.stderr);
    assert.match(answer.stdout, /\{max_agents,test_tier,worktree_mode\}/u);
    assert.doesNotMatch(answer.stdout, /issue_pool|test_audit/u);
  } finally {
    scratch.done();
  }
});

test('指令记录：rm / revive 改的是 --project 点名的那份记录，退出码跟着结果走', () => {
  const scratch = scratchProject();
  try {
    const target = join(scratch.work, 'target');
    cpSync(join(fixture, 'project'), target, { recursive: true });
    const entries = (dir) =>
      JSON.parse(readFileSync(join(dir, '.pf', 'instructions.json'), 'utf8')).instructions;
    const entryOf = (dir, id) => entries(dir).find((entry) => entry.id === id);

    // cwd and the named project each hold a record: the removal has to land on the target's.
    const removed = run(['instruction', 'rm', 'i-0001', '--project', target], {
      cwd: scratch.project,
      plugins,
      home: scratch.home,
    });
    assert.equal(removed.code, 0, removed.stderr);
    assert.deepEqual(entries(target).map((entry) => entry.id), ['i-0002', 'i-0003']);
    assert.deepEqual(entries(scratch.project).map((entry) => entry.id), ['i-0001', 'i-0002', 'i-0003']);

    // i-0002 is live in both copies, so a revive that ignored `--project` would answer "already
    // live" and exit 1 against the cwd's record: this is the state that catches it.
    const withdrawn = run(['instruction', 'resolve', 'i-0002', '--state', 'withdrawn', '--project', target], {
      cwd: scratch.work,
      plugins,
      home: scratch.home,
    });
    assert.equal(withdrawn.code, 0, withdrawn.stderr);
    assert.equal(entryOf(target, 'i-0002').state, 'withdrawn');

    const revived = run(['instruction', 'revive', 'i-0002', '--project', target], {
      cwd: scratch.project,
      plugins,
      home: scratch.home,
    });
    assert.equal(revived.code, 0, revived.stderr);
    assert.equal(revived.stdout, 'INSTRUCTION i-0002 → live\n');
    assert.equal(entryOf(target, 'i-0002').state, 'live');
    assert.equal(entryOf(scratch.project, 'i-0002').state, 'live');
  } finally {
    scratch.done();
  }
});

test('cycle retry --summary：给的那句落在 signals/<线>/<节点>.json 的票上', () => {
  const scratch = scratchProject();
  try {
    const node = JSON.parse(readFileSync(join(fixture, 'ids.json'), 'utf8')).A;
    const answer = run(['cycle', 'retry', 'c1', node, '--summary', 'redo it'], {
      cwd: scratch.project,
      plugins,
      home: scratch.home,
    });
    assert.equal(answer.code, 0, answer.stderr);
    const ticket = JSON.parse(
      readFileSync(join(scratch.project, '.pf', 'signals', 'c1', `${node}.json`), 'utf8'),
    );
    assert.equal(ticket.summary, 'redo it');
    assert.equal(ticket.status, 'pending');
  } finally {
    scratch.done();
  }
});

test('dispatch：线手里那个节点还没有 prompt 时零写入、回外部工具那句、退出码 2（票在盘上、重新钉住、票被放掉三档都拒）', () => {
  const scratch = scratchProject();
  try {
    const node = JSON.parse(readFileSync(join(fixture, 'ids.json'), 'utf8')).A;
    const options = { cwd: scratch.project, plugins, home: scratch.home };
    const pfDir = join(scratch.project, '.pf');
    const prompt = join(pfDir, 'meta', 'launch', 'c1', node, 'prompt.txt');
    const refused =
      `Error: no prompt file at ${prompt}. That file is written by the step that pinned this node: ` +
      `usually the closing call (\`pf next --after ${node} --json\`), and after an insertion the later ` +
      '`next` that picks the node up.';

    // The drill project's own hand: `c1` is in service and holds A, whose ticket is still on disk, so
    // the plan is not a dispatch. The reference refuses here before it writes anything: same sentence,
    // same exit code, and the records stay exactly as they were.
    const before = snapshot(pfDir);
    const waiting = run(['dispatch', 'c1'], options);
    assert.equal(waiting.code, 2, waiting.stderr);
    assert.equal(waiting.stderr.trim(), refused);
    assert.deepEqual(snapshot(pfDir), before, 'the refusal wrote nothing');
    assert.equal(existsSync(join(pfDir, 'meta', 'launch')), false, 'no launch material was laid down');

    // The same hand re-pinned the way the review built it: out of service, pinned again, back in
    // service. Still no prompt to send, still refused, still not one byte written.
    for (const argv of [
      ['cycle', 'status', 'c1', 'inactive'],
      ['cycle', 'hold', 'c1', node],
      ['cycle', 'status', 'c1', 'active'],
    ]) {
      const step = run(argv, options);
      assert.equal(step.code, 0, `${argv.join(' ')}: ${step.stderr}`);
    }
    const repinned = snapshot(pfDir);
    const again = run(['dispatch', 'c1'], options);
    assert.equal(again.code, 2, again.stderr);
    assert.equal(again.stderr.trim(), refused);
    assert.deepEqual(snapshot(pfDir), repinned, 'the second refusal wrote nothing');

    // The third state: the plan really is a dispatch (the ticket is dropped) but the prompt still is
    // not on disk. This verb stays read-only on that state too — the material belongs to the step that
    // pinned the node, never to `dispatch` — so it is the same refusal and the same zero writes. The
    // reference answers it this way; fix-3's positive control lived here and has moved to the
    // `next --spawn` path below, which is the one that lands material.
    const dropped = run(['cycle', 'retry', 'c1', node, '--drop'], options);
    assert.equal(dropped.code, 0, dropped.stderr);
    const ticketGone = snapshot(pfDir);
    const stillRefused = run(['dispatch', 'c1'], options);
    assert.equal(stillRefused.code, 2, stillRefused.stderr);
    assert.equal(stillRefused.stderr.trim(), refused);
    assert.deepEqual(snapshot(pfDir), ticketGone, 'the third refusal wrote nothing');
    assert.equal(existsSync(join(pfDir, 'meta', 'launch')), false, 'still no launch material');
  } finally {
    scratch.done();
  }
});

test('dispatch：cycle start 之后直接派发被拒；材料由 next --spawn 落，已开过会话时回旧句', () => {
  const scratch = scratchProject();
  try {
    const options = { cwd: scratch.project, plugins, home: scratch.home };
    const pfDir = join(scratch.project, '.pf');
    const ok = (argv) => {
      const answer = run(argv, options);
      assert.equal(answer.code, 0, `${argv.join(' ')}: ${answer.stderr}`);
      return answer;
    };
    // The state this tier is about: a line that holds a node, the prompt not yet on disk. `cycle start`
    // is the reference's own way to build it (its `work7` in review-3): out of service, a fresh line
    // with a tag, which pins by the usual ranking.
    ok(['cycle', 'status', 'c1', 'inactive']);
    ok(['cycle', 'start', 'c9', '--tags', 'coding']);
    const node = JSON.parse(readFileSync(join(pfDir, 'state.json'), 'utf8'))
      .cycles.find((cycle) => cycle.id === 'c9').holding[0].id;
    const prompt = join(pfDir, 'meta', 'launch', 'c9', node, 'prompt.txt');
    const refused =
      `Error: no prompt file at ${prompt}. That file is written by the step that pinned this node: ` +
      `usually the closing call (\`pf next --after ${node} --json\`), and after an insertion the later ` +
      '`next` that picks the node up.';

    // Tier one: the plan is a dispatch, but no prompt has landed. The standalone verb must write not
    // one byte -- not the prompt, not the run doc, not the record.
    const before = snapshot(pfDir);
    const first = run(['dispatch', 'c9'], options);
    assert.equal(first.code, 2, first.stderr);
    assert.equal(first.stderr.trim(), refused);
    assert.deepEqual(snapshot(pfDir), before, 'the refusal wrote nothing');
    assert.equal(existsSync(join(pfDir, 'meta', 'launch')), false, 'no launch material was laid down');
    assert.equal(existsSync(join(pfDir, 'nodes', node, 'run.md')), false, 'no run doc was laid down');

    // Tier two: the pin -> dispatch path of `next` is where the material lands. In the drill it opens
    // the simulated session `sess-1`, writes the prompt the engine computed and this round's run doc.
    const spawned = run(['next', '--cycle', 'c9', '--spawn', '--json'], {
      ...options,
      env: { DSH_CONDUCT_SPAWN_DRY_RUN: '1' },
    });
    assert.equal(spawned.code, 0, spawned.stderr);
    const answer = JSON.parse(spawned.stdout);
    assert.equal(answer.action, 'dispatch');
    assert.equal(answer.spawned, 'sess-1');
    assert.equal(readFileSync(prompt, 'utf8').replace(/\r\n/gu, '\n'), `/pf-conduct ${node} [pipeline]\n`);
    assert.equal(existsSync(join(pfDir, 'meta', 'launch', 'c9', node, 'started')), true);
    assert.equal(existsSync(join(pfDir, 'nodes', node, 'run.md')), true);

    // Tier three: the session is out, so a second dispatch onto the same node keeps the old refusal
    // sentence — whole, including the three commands that reopen such a node.
    const started = snapshot(pfDir);
    const again = run(['dispatch', 'c9'], options);
    assert.equal(again.code, 2, again.stderr);
    assert.equal(
      again.stderr.trim(),
      `Error: every node this cycle holds already had its session started (${node.slice(0, 8)}), ` +
        'so there is nothing to dispatch: doing it again would boot a second session onto the same node. ' +
        'To reopen one, retry it the documented way: ' +
        `\`pf cycle retry c9 <node> --drop\`, then \`pf cycle hold c9 <node>\`, then ` +
        '`pf next --cycle c9 --spawn --json`.',
    );
    assert.deepEqual(snapshot(pfDir), started, 'the already-started refusal wrote nothing');
  } finally {
    scratch.done();
  }
});

test('dispatch：prompt 在盘上、没有 started 记号、票还在盘上——这一档交给引擎派发、退出码 0', () => {
  const scratch = scratchProject();
  try {
    const node = JSON.parse(readFileSync(join(fixture, 'ids.json'), 'utf8')).A;
    const options = { cwd: scratch.project, plugins, home: scratch.home };
    const pfDir = join(scratch.project, '.pf');
    // The state: a prompt an earlier round left behind, no claim beside it, and the ticket already on
    // disk (so the plan is still waiting on that ticket). "The session is out" is the claim, not the
    // prompt: this is a dispatch, and the engine opens it.
    const launch = join(pfDir, 'meta', 'launch', 'c1', node);
    mkdirSync(launch, { recursive: true });
    const promptText = `/pf-conduct ${node} [pipeline]\n`;
    writeFileSync(join(launch, 'prompt.txt'), promptText, 'utf8');

    const opened = run(['dispatch', 'c1'], { ...options, env: { DSH_CONDUCT_SPAWN_DRY_RUN: '1' } });
    assert.equal(opened.code, 0, opened.stderr);
    assert.equal(opened.stdout.trim(), 'opened sess-1');
    // The claim is the one write this verb makes: the prompt it found is left byte for byte as it was,
    // and no run doc is invented beside it (that belongs to the step that pinned the node).
    assert.equal(existsSync(join(launch, 'started')), true);
    assert.equal(readFileSync(join(launch, 'prompt.txt'), 'utf8'), promptText);
    assert.equal(existsSync(join(pfDir, 'nodes', node, 'run.md')), false);

    // The next dispatch finds the claim: the old sentence, whole, and no second session.
    const again = run(['dispatch', 'c1'], options);
    assert.equal(again.code, 2, again.stderr);
    assert.equal(
      again.stderr.trim(),
      `Error: every node this cycle holds already had its session started (${node.slice(0, 8)}), ` +
        'so there is nothing to dispatch: doing it again would boot a second session onto the same node. ' +
        'To reopen one, retry it the documented way: ' +
        `\`pf cycle retry c1 <node> --drop\`, then \`pf cycle hold c1 <node>\`, then ` +
        '`pf next --cycle c1 --spawn --json`.',
    );
  } finally {
    scratch.done();
  }
});

test('dispatch：这个进程开不了会话时先拒，退出码 2，一个 started 也不落', () => {
  const scratch = scratchProject();
  try {
    const node = JSON.parse(readFileSync(join(fixture, 'ids.json'), 'utf8')).A;
    const options = { cwd: scratch.project, plugins, home: scratch.home };
    const pfDir = join(scratch.project, '.pf');
    // The state that reaches the engine: the prompt is on disk, the claim is not. An opener-less
    // process would land the claim before its placeholder executor refused, so the cell would read
    // as "already open" with no session behind it.
    const launch = join(pfDir, 'meta', 'launch', 'c1', node);
    mkdirSync(launch, { recursive: true });
    writeFileSync(join(launch, 'prompt.txt'), `/pf-conduct ${node} [pipeline]\n`, 'utf8');

    const before = snapshot(pfDir);
    const refused = run(['dispatch', 'c1'], { ...options, env: { DSH_CONDUCT_SPAWN_DRY_RUN: '' } });
    assert.equal(refused.code, 2, refused.stderr);
    assert.match(refused.stderr, /寻路中心/u, '拒绝句说开会话的是面板');
    assert.ok(refused.stderr.includes(join(launch, 'prompt.txt')), '拒绝句说出材料在哪');
    assert.equal(existsSync(join(launch, 'started')), false, '一个 started 都没落');
    assert.deepEqual(snapshot(pfDir), before, '这一拒一个字节都没写');
  } finally {
    scratch.done();
  }
});

test('next --spawn：这个进程开不了会话时计划照印，spawn 那一步说没做，一个节点也不认领', () => {
  const scratch = scratchProject();
  try {
    const options = { cwd: scratch.project, plugins, home: scratch.home };
    const pfDir = join(scratch.project, '.pf');
    const ok = (argv) => {
      const answer = run(argv, options);
      assert.equal(answer.code, 0, `${argv.join(' ')}: ${answer.stderr}`);
      return answer;
    };
    ok(['cycle', 'status', 'c1', 'inactive']);
    ok(['cycle', 'start', 'c9', '--tags', 'coding']);
    const node = JSON.parse(readFileSync(join(pfDir, 'state.json'), 'utf8'))
      .cycles.find((cycle) => cycle.id === 'c9').holding[0].id;
    const prompt = join(pfDir, 'meta', 'launch', 'c9', node, 'prompt.txt');

    const answer = run(['next', '--cycle', 'c9', '--spawn'], {
      ...options,
      env: { DSH_CONDUCT_SPAWN_DRY_RUN: '' },
    });
    assert.equal(answer.code, 0, answer.stderr);
    assert.match(answer.stdout, /^action: dispatch$/mu, '计划照印');
    assert.match(answer.stdout, /^spawn_error: \S/mu, 'spawn 那一步说自己没做');
    assert.match(answer.stdout, /寻路中心/u, '那句话点名面板');
    assert.ok(answer.stdout.includes(prompt), '那句话说出材料在哪');
    assert.match(answer.stdout, /^applied: True$/mu, '钉住与落材料那几步照做');
    assert.equal(existsSync(prompt), true, '材料照常落');
    assert.equal(existsSync(join(pfDir, 'meta', 'launch', 'c9', node, 'started')), false, '一个节点也不认领');
  } finally {
    scratch.done();
  }
});

test('dispatch：技能那两行按顺序跑得通——next --after 先落 prompt，dispatch 再开会话', () => {
  const scratch = scratchProject();
  try {
    const node = JSON.parse(readFileSync(join(fixture, 'ids.json'), 'utf8')).A;
    const options = { cwd: scratch.project, plugins, home: scratch.home };
    const pfDir = join(scratch.project, '.pf');
    const dry = { ...options, env: { DSH_CONDUCT_SPAWN_DRY_RUN: '1' } };

    // The closing call settles the finished node, pins the slot it opens, and lands that slot's
    // material: the prompt and this round's run doc. It opens no session.
    const closing = run(['next', '--after', node, '--json'], dry);
    assert.equal(closing.code, 0, closing.stderr);
    const answer = JSON.parse(closing.stdout);
    assert.equal(answer.action, 'dispatch');
    assert.equal(answer.nodes.length, 1);
    const openedNode = answer.node_id;
    const launch = join(pfDir, 'meta', 'launch', 'c1', openedNode);
    assert.equal(
      readFileSync(join(launch, 'prompt.txt'), 'utf8').replace(/\r\n/gu, '\n'),
      `/pf-conduct ${openedNode} [pipeline]\n`,
    );
    assert.equal(existsSync(join(pfDir, 'nodes', openedNode, 'run.md')), true);
    assert.equal(existsSync(join(launch, 'started')), false, 'the closing call lands the material, not the session');

    // The second line finds that prompt and starts the session from it; nothing is written twice.
    const opened = run(['dispatch', 'c1'], dry);
    assert.equal(opened.code, 0, opened.stderr);
    assert.equal(opened.stdout.trim(), 'opened sess-1');
    assert.equal(existsSync(join(launch, 'started')), true);
    assert.equal(
      readFileSync(join(launch, 'prompt.txt'), 'utf8').replace(/\r\n/gu, '\n'),
      `/pf-conduct ${openedNode} [pipeline]\n`,
    );
  } finally {
    scratch.done();
  }
});

test('instruction resolve --note：给的那句落在记录里，不是 null', () => {
  const scratch = scratchProject();
  try {
    const answer = run(
      ['instruction', 'resolve', 'i-0001', '--state', 'withdrawn', '--note', 'owner said so'],
      { cwd: scratch.project, plugins, home: scratch.home },
    );
    assert.equal(answer.code, 0, answer.stderr);
    const entry = JSON.parse(
      readFileSync(join(scratch.project, '.pf', 'instructions.json'), 'utf8'),
    ).instructions.find((row) => row.id === 'i-0001');
    assert.equal(entry.note, 'owner said so');
    assert.equal(entry.state, 'withdrawn');
  } finally {
    scratch.done();
  }
});

test('指令记录：空视图按条数分档，没有记录时说的就是「没有记录」', () => {
  const scratch = scratchProject();
  try {
    const bare = join(scratch.work, 'bare');
    mkdirSync(bare, { recursive: true });
    const started = run(['init', '--project', '.'], { cwd: bare, plugins, home: scratch.home });
    assert.equal(started.code, 0, started.stderr);

    const noRecord = 'This project has no instruction record at all.\nThat is not an error: work can start as usual.\n';
    for (const argv of [['instruction', 'list'], ['instruction', 'list', '--all']]) {
      const answer = run(argv, { cwd: bare, plugins, home: scratch.home });
      assert.equal(answer.code, 0, answer.stderr);
      assert.equal(answer.stdout, noRecord, argv.join(' '));
    }

    // The record exists, all three entries are out of force: the reader's view says how many, and
    // the account views say which kind of silence this is. The state is laid down on the fixture copy
    // directly, so the test spends its processes on the readings it is pinning.
    const book = join(scratch.project, '.pf', 'instructions.json');
    const data = JSON.parse(readFileSync(book, 'utf8'));
    for (const entry of data.instructions) entry.state = 'withdrawn';
    writeFileSync(book, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
    const visible = run(['instruction', 'list'], { cwd: scratch.project, plugins, home: scratch.home });
    assert.equal(visible.code, 0, visible.stderr);
    assert.match(visible.stdout, /^No instruction is visible from this step\.\n/u);
    assert.match(visible.stdout, /\(The instruction record has 3 entries: /u);
    assert.doesNotMatch(visible.stdout, /no instruction record at all/u);

    const scoped = run(['instruction', 'list', '--scope', 'global'], {
      cwd: scratch.project,
      plugins,
      home: scratch.home,
    });
    assert.equal(scoped.stdout, 'No instruction with scope=global is still in force.\n(The instruction record has 3 entries.)\n');
  } finally {
    scratch.done();
  }
});

test('会话档：空记录时 --json 是 JSON，散文给出的是项目根那条路径', () => {
  const scratch = scratchProject();
  try {
    const bare = join(scratch.work, 'bare');
    mkdirSync(bare, { recursive: true });
    assert.equal(run(['init', '--project', '.'], { cwd: bare, plugins, home: scratch.home }).code, 0);

    const asJson = run(['session', 'list', '--json'], { cwd: bare, plugins, home: scratch.home });
    assert.equal(asJson.code, 0, asJson.stderr);
    assert.deepEqual(JSON.parse(asJson.stdout), {});

    const expected = `no session notes under ${join(bare, '.pf', 'meta', 'sessions')}\n`;
    assert.equal(run(['session', 'list'], { cwd: bare, plugins, home: scratch.home }).stdout, expected);
    // From outside: the path is the named project's, not the cwd's.
    const fromOutside = run(['session', 'list', '--project', bare], {
      cwd: scratch.work,
      plugins,
      home: scratch.home,
    });
    assert.equal(fromOutside.stdout, expected);
  } finally {
    scratch.done();
  }
});

test('init：--own-repo 真给 .pf 一个自己的仓库，--no-own-repo 与 --commit 都不建', () => {
  const scratch = scratchProject();
  try {
    // One project says no (both ways), one says yes by default.
    const plain = join(scratch.work, 'plain');
    mkdirSync(plain, { recursive: true });
    assert.equal(git(plain, ['init', '-b', 'master']).code, 0);
    for (const argv of [['init', '--no-own-repo'], ['init', '--commit']]) {
      const answer = run([...argv, '--project', '.'], { cwd: plain, plugins, home: scratch.home });
      assert.equal(answer.code, 0, `${argv.join(' ')}: ${answer.stderr}`);
      assert.equal(existsSync(join(plain, '.pf', '.git')), false, argv.join(' '));
      assert.doesNotMatch(answer.stdout, /repository of its own/u, argv.join(' '));
      assert.doesNotMatch(answer.stdout, /was not asked for/u, argv.join(' '));
    }

    const owned = join(scratch.work, 'owned');
    mkdirSync(owned, { recursive: true });
    assert.equal(git(owned, ['init', '-b', 'master']).code, 0);
    const answer = run(['init', '--own-repo', '--project', '.'], { cwd: owned, plugins, home: scratch.home });
    assert.equal(answer.code, 0, answer.stderr);
    assert.equal(existsSync(join(owned, '.pf', '.git')), true);
    assert.match(answer.stdout, /^Gave .+ a repository of its own:/mu);
  } finally {
    scratch.done();
  }
});

test('config 帮助：取值表按这台机器此刻认得的旋钮算（没装插件只列核心键）', () => {
  const scratch = scratchProject();
  try {
    const noPlugins = join(scratch.work, 'no-plugins');
    mkdirSync(noPlugins, { recursive: true });
    const bare = run(['config', 'get', '--help'], { cwd: scratch.project, plugins: noPlugins, home: scratch.home });
    assert.equal(bare.code, 0, bare.stderr);
    assert.match(bare.stdout, /\{max_agents,test_tier,worktree_mode\}/u);
    const refused = run(['config', 'get', 'issue_pool'], {
      cwd: scratch.project,
      plugins: noPlugins,
      home: scratch.home,
    });
    assert.equal(refused.code, 2);
    assert.match(
      refused.stderr,
      /argument key: invalid choice: 'issue_pool' \(choose from 'max_agents', 'test_tier', 'worktree_mode'\)/u,
    );

    // With the two plugins installed the same table carries their knobs — it is computed, not written down.
    const full = run(['config', 'get', '--help'], { cwd: scratch.project, plugins, home: scratch.home });
    assert.equal(full.code, 0, full.stderr);
    assert.match(
      full.stdout,
      /\{issue_pool,issue_pool_weight_limit,max_agents,test_audit,test_seconds_limit,test_tier,worktree_mode\}/u,
    );
  } finally {
    scratch.done();
  }
});
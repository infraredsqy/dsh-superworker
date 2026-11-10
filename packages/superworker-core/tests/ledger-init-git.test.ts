import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { GitResult, GitRunner } from '../src/git';
import { mergeDriverCommand } from '../src/initledger';
import { open } from '../src/open';
import { git, gitRunner as realGit } from './helpers/git-runner';

/**
 * init / register with git: the three attachments.
 *
 * Everything git knows — whether this is a checkout, where `info/exclude` is, where the project sits
 * inside the repository, and the config file itself — is asked through the injected `GitRunner`;
 * the engine parses no git directory layout and writes no config byte. What lands is the one
 * exclude line this engine owns, and the merge driver's two keys, with the command computed at write
 * time in the one form this package writes: the quoted node path plus the quoted built entry, both
 * absolute.
 *
 * The fake runner pins the call shapes; the real one pins that git really accepts them (a checkout,
 * a project in a subdirectory, a linked worktree).
 */

const LAYOUT_FILES = ['.gitignore', '.gitattributes', 'AGENTS.md', 'config.json'];

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'superworker-init-git-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  root = undefined!;
});

/** The one line this engine owns: a repository-root-anchored `.superworker/`. */
function excludeLines(text: string): string[] {
  return text.split(/\r?\n/).filter((line) => /^\s*\/.*\.superworker\/\s*$/.test(line));
}

interface RecordedCall {
  readonly cwd: string;
  readonly args: string[];
}

/** A fake runner: every call is recorded, and answers are canned (default: a happy answer with empty stdout). */
function recordingGit(
  answers: (args: readonly string[]) => GitResult | undefined,
): { runner: GitRunner; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const runner: GitRunner = {
    run(cwd: string, args: readonly string[]): Promise<GitResult> {
      calls.push({ cwd, args: [...args] });
      return Promise.resolve(answers(args) ?? { code: 0, stdout: '', stderr: '' });
    },
  };
  return { runner, calls };
}

/** The answers a checkout at the repository root gives. */
function checkoutAnswers(args: readonly string[]): GitResult | undefined {
  const spelled = args.join(' ');
  if (spelled === 'rev-parse --git-common-dir') return { code: 0, stdout: '.git\n', stderr: '' };
  if (spelled === 'rev-parse --git-path info/exclude') {
    return { code: 0, stdout: '.git/info/exclude\n', stderr: '' };
  }
  if (spelled === 'rev-parse --show-prefix') return { code: 0, stdout: '', stderr: '' };
  return undefined;
}

describe('ledger.init in a real checkout', () => {
  it('the exclude line goes in, the driver is registered through git config, and .superworker is given a repository of its own', async () => {
    await git(root, 'init', '-b', 'master');
    const report = await open(root).ledger.init({ git: realGit });

    expect(report.written).toEqual(LAYOUT_FILES);
    expect(report.ownRepo).toBe('created');
    expect(report.exclude).toBe('written');
    expect(report.mergeDriver).toBe('written');

    const exclude = readFileSync(join(root, '.git', 'info', 'exclude'), 'utf8');
    expect(excludeLines(exclude)).toEqual(['/.superworker/']);

    // git wrote the keys itself: the value is exactly the string this machine computes.
    const driver = (await git(root, 'config', '--local', '--get', 'merge.superworker.driver')).trim();
    expect(driver).toBe(mergeDriverCommand());
    // The one form this package writes: the quoted node path plus the quoted built entry, both
    // absolute — a Windows node path has spaces, and git splits the driver string on spaces. No
    // form of the registration depends on what this machine happens to have on `PATH`.
    expect(driver).toMatch(/^".+" ".+merge-ledger\.mjs" %O %A %B %P$/u);
    expect((await git(root, 'config', '--local', '--get', 'merge.superworker.name')).trim())
      .toBe('superworker ledger three-way merge');

    // Everything worked, so no warning is left: the repository of .superworker's own was given, not advised on.
    expect(report.warnings).toEqual([]);
    expect(existsSync(join(root, '.superworker', '.git'))).toBe(true);
  });

  it('git itself sends every record under the directory to the driver, and steps the settings file out of that line', async () => {
    await git(root, 'init', '-b', 'master');
    await open(root).ledger.init({ git: realGit });
    const recordDir = join(root, '.superworker');
    // The reading a merge really takes: git resolves the attribute for each path it is about to merge. The records
    // are laid down by whatever writes them (the instruction account belongs to a plugin, the tickets to the
    // pipeline), so three of these paths do not exist here — the attribute is a rule about the tree, not about a
    // file being there.
    const asked = [
      'ideas.json',
      'state.json',
      'instructions.json',
      'signals/line/node.json',
      'issues/issues.json',
      'config.json',
      'AGENTS.md',
    ];
    const said = (await git(recordDir, 'check-attr', 'merge', '--', ...asked))
      .split('\n')
      .filter((line) => line !== '');
    expect(said).toEqual([
      'ideas.json: merge: superworker',
      'state.json: merge: superworker',
      'instructions.json: merge: superworker',
      'signals/line/node.json: merge: superworker',
      'issues/issues.json: merge: superworker',
      // One setting, not a table of entries: git's own answer is what keeps two changed settings out of the driver.
      'config.json: merge: unset',
      // Nothing else under the directory is a record.
      'AGENTS.md: merge: unspecified',
    ]);
  });

  it('idempotent: a second run changes neither .superworker, nor the exclude file, nor git config', async () => {
    await git(root, 'init', '-b', 'master');
    const superworker = open(root);
    await superworker.ledger.init({ git: realGit });
    const before = hashTree(join(root, '.superworker'));
    const excludeBefore = readFileSync(join(root, '.git', 'info', 'exclude'), 'utf8');
    const configBefore = readFileSync(join(root, '.git', 'config'), 'utf8');

    const second = await superworker.ledger.init({ git: realGit });
    expect(second.written).toEqual([]);
    expect(hashTree(join(root, '.superworker'))).toBe(before);
    expect(readFileSync(join(root, '.git', 'info', 'exclude'), 'utf8')).toBe(excludeBefore);
    expect(readFileSync(join(root, '.git', 'config'), 'utf8')).toBe(configBefore);
  });

  it('ownRepo: no repository when none was asked for, the given one is created, and an existing one is left alone', async () => {
    await git(root, 'init', '-b', 'master');
    const superworker = open(root);

    // `ownRepo: false` is the caller saying "plain files on purpose": nothing is created, nothing is warned about.
    const notAsked = await superworker.ledger.init({ ownRepo: false, git: realGit });
    expect(notAsked.ownRepo).toBe('skipped');
    expect(existsSync(join(root, '.superworker', '.git'))).toBe(false);
    expect(notAsked.warnings.join('\n')).not.toContain('repository of its own');

    // Asked for (the default): one git init gives it a repository, and the reading says who gave it.
    const asked = await superworker.ledger.init({ git: realGit });
    expect(asked.ownRepo).toBe('created');
    expect(statSync(join(root, '.superworker', '.git')).isDirectory()).toBe(true);

    // A second run finds it there and leaves it exactly as it was.
    const repoHash = hashTree(join(root, '.superworker', '.git'));
    const again = await superworker.ledger.init({ git: realGit });
    expect(again.ownRepo).toBe('present');
    expect(hashTree(join(root, '.superworker', '.git'))).toBe(repoHash);
  });

  it('a project in a subdirectory: the line is anchored at the repository root, one per project', async () => {
    await git(root, 'init', '-b', 'master');
    const app = join(root, 'packages', 'app');
    const web = join(root, 'packages', 'web');
    mkdirSync(app, { recursive: true });
    mkdirSync(web, { recursive: true });

    expect((await open(app).ledger.init({ git: realGit })).exclude).toBe('written');
    expect((await open(web).ledger.init({ git: realGit })).exclude).toBe('written');

    const exclude = readFileSync(join(root, '.git', 'info', 'exclude'), 'utf8');
    expect(excludeLines(exclude).sort())
      .toEqual(['/packages/app/.superworker/', '/packages/web/.superworker/'].sort());
  });

  it('a record directory the project git tracks: init refuses before a byte lands, naming an agent', async () => {
    // The one gate init refuses on: an older workspace put the records into the index, and taking
    // them back out of a repository's history is a person's decision — so init stops before the
    // layout, the exclude line or the driver keys are written, and the error hands the job to an
    // agent instead of naming git's own commands.
    await git(root, 'init', '-b', 'master');
    mkdirSync(join(root, '.superworker'), { recursive: true });
    writeFileSync(join(root, '.superworker', 'state.json'), '{"cycles":[]}', 'utf8');
    await git(root, 'add', '-f', '.superworker');
    const trackedBefore = await git(root, 'ls-files', '--', '.superworker');
    const recordBefore = hashTree(join(root, '.superworker'));
    const configBefore = readFileSync(join(root, '.git', 'config'), 'utf8');

    let caught: unknown;
    try {
      await open(root).ledger.init({ git: realGit });
    } catch (error) {
      caught = error;
    }
    expect((caught as Error).message).toContain("tracked by this project's git");
    expect((caught as Error).message).toContain('consult an agent');
    expect((caught as Error).message).toContain('Nothing was written');
    // Not a byte landed: the tracked records are exactly the bytes they were, the index holds what
    // it held, no exclude line went in, and git config carries no driver keys.
    expect(hashTree(join(root, '.superworker'))).toBe(recordBefore);
    expect(await git(root, 'ls-files', '--', '.superworker')).toBe(trackedBefore);
    const exclude = existsSync(join(root, '.git', 'info', 'exclude'))
      ? readFileSync(join(root, '.git', 'info', 'exclude'), 'utf8')
      : '';
    expect(excludeLines(exclude)).toEqual([]);
    expect(readFileSync(join(root, '.git', 'config'), 'utf8')).toBe(configBefore);
  });
});

describe('what is asked of git, and what happens when it will not answer', () => {
  it('the calls are the ones git defines, from the project root, and the driver string is computed at write time', async () => {
    mkdirSync(join(root, '.git', 'info'), { recursive: true });
    const fake = recordingGit(checkoutAnswers);
    const report = await open(root).ledger.init({ git: fake.runner });
    expect(report.exclude).toBe('written');
    expect(report.mergeDriver).toBe('written');
    expect(report.mergeDriverCommand).toBe(mergeDriverCommand());

    expect(fake.calls.map((call) => call.args)).toEqual([
      ['ls-files', '--', '.superworker'],
      ['rev-parse', '--git-common-dir'],
      ['init', '--quiet'],
      ['rev-parse', '--git-path', 'info/exclude'],
      ['rev-parse', '--show-prefix'],
      ['config', '--local', '--get', 'merge.superworker.driver'],
      ['config', '--local', 'merge.superworker.name', 'superworker ledger three-way merge'],
      ['config', '--local', 'merge.superworker.driver', mergeDriverCommand()],
    ]);
    // The one `git init` stands in the record directory, every other call in the project root.
    expect(fake.calls.filter((call) => call.cwd !== root).map((call) => call.args)).toEqual([['init', '--quiet']]);
    expect(fake.calls.find((call) => call.args[0] === 'init')!.cwd).toBe(join(root, '.superworker'));
    expect(excludeLines(readFileSync(join(root, '.git', 'info', 'exclude'), 'utf8')))
      .toEqual(['/.superworker/']);
  });

  it('the exclude rewrite leaves every line it does not own byte for byte, CRLF included', async () => {
    await git(root, 'init', '-b', 'master');
    const excludePath = join(root, '.git', 'info', 'exclude');

    // A mixed file: an LF line, then another project's CRLF line. The line this run adds goes last;
    // both lines already there keep exactly the bytes they had (the review's probe, byte for byte).
    writeFileSync(excludePath, 'keepme/\n/other/project/.superworker/\r\n', 'utf8');
    expect((await open(root).ledger.init({ git: realGit })).exclude).toBe('written');
    expect(readFileSync(excludePath, 'utf8')).toBe('keepme/\n/other/project/.superworker/\r\n/.superworker/\n');

    // A wholly CRLF file comes out wholly CRLF: the line this run adds takes the file's own ending,
    // so this write introduces no mixture, and `keepme/` — not this project's line, not even a `.superworker`
    // line — is not normalized either.
    const crlf = 'keepme/\r\n/other/project/.superworker/\r\n';
    writeFileSync(excludePath, crlf, 'utf8');
    expect((await open(root).ledger.init({ git: realGit })).exclude).toBe('written');
    expect(readFileSync(excludePath, 'utf8')).toBe(
      'keepme/\r\n/other/project/.superworker/\r\n/.superworker/\r\n',
    );
  });

  it('valid UTF-8 round-trips: a lone CR, a CRLF line and a CJK line come back byte for byte', async () => {
    // Every other line is left exactly as it was, ending included: a lone `\r` is an ending, not a
    // byte to normalize, and non-ASCII text that *is* valid UTF-8 is written back as the same bytes.
    await git(root, 'init', '-b', 'master');
    const excludePath = join(root, '.git', 'info', 'exclude');
    writeFileSync(excludePath, '# 保留的注释\r/other/project/.superworker/\r\nkeepme/\n', 'utf8');
    expect((await open(root).ledger.init({ git: realGit })).exclude).toBe('written');
    expect(readFileSync(excludePath, 'utf8')).toBe(
      '# 保留的注释\r/other/project/.superworker/\r\nkeepme/\n/.superworker/\n',
    );
  });

  it('bytes that are not valid UTF-8 fail the reading, and the file is left byte for byte', async () => {
    // A hand-edited file from a Chinese Windows box: `# 保留` in cp936, then another project's
    // ASCII line. A lenient decode would replace those four bytes with U+FFFD and the write would
    // put the damaged text back; bytes this engine cannot re-encode are bytes it must not rewrite.
    await git(root, 'init', '-b', 'master');
    const excludePath = join(root, '.git', 'info', 'exclude');
    const bytes = Buffer.from([
      0x23, 0x20, 0xb1, 0xa3, 0xc1, 0xf4, 0x0a, // `# 保留` in cp936, then LF
      0x2f, 0x6f, 0x74, 0x68, 0x65, 0x72, 0x2f, 0x70, 0x72, 0x6f, 0x6a, 0x65, 0x63, 0x74, 0x2f,
      0x2e, 0x70, 0x66, 0x2f, 0x0a, // `/other/project/.superworker/` then LF
    ]);
    writeFileSync(excludePath, bytes);
    const report = await open(root).ledger.init({ git: realGit });
    expect(report.exclude).toBe('failed');
    expect(report.warnings.join('\n')).toContain('not valid UTF-8');
    expect(report.warnings.join('\n')).toContain(excludePath);
    expect(readFileSync(excludePath).equals(bytes)).toBe(true);
    // The bottom line still lands, and the other attachment (git config) still writes.
    expect(report.written).toEqual(LAYOUT_FILES);
    expect(report.mergeDriver).toBe('written');
  });

  it('an exclude path that is there but cannot be read fails the reading, and nothing is written', async () => {
    // git answered every question, and the path it named exists — as a directory, so the read
    // fails. That is not "there is no exclude file yet": reading it as empty and rewriting would
    // drop every other project's line. The reading says failure, names the file and the reason,
    // and leaves the path exactly as it was.
    mkdirSync(join(root, '.git', 'info', 'exclude'), { recursive: true });
    const fake = recordingGit(checkoutAnswers);
    const report = await open(root).ledger.init({ git: fake.runner });
    expect(report.exclude).toBe('failed');
    expect(report.warnings.join('\n')).toContain('could not be read');
    expect(report.warnings.join('\n')).toContain(join(root, '.git', 'info', 'exclude'));
    expect(statSync(join(root, '.git', 'info', 'exclude')).isDirectory()).toBe(true);
    // Not one byte was laid beside it either (the write, and its temporary file, never started).
    expect(readdirSync(join(root, '.git', 'info'))).toEqual(['exclude']);
    // The other attachments are unaffected: only the exclude reading failed.
    expect(report.written).toEqual(LAYOUT_FILES);
    expect(report.mergeDriver).toBe('written');
  });

  it('an exclude file that cannot be written reads as a failed write, not as "not a checkout"', async () => {
    // git answered every question — this is a checkout, and this is where `info/exclude` lives — and
    // only the write fails, because the directory that path names is a plain file. That has a
    // reading of its own: the checkout was found, so it is not "git could not be asked".
    mkdirSync(join(root, '.git'), { recursive: true });
    writeFileSync(join(root, '.git', 'info'), 'not a directory\n', 'utf8');
    const fake = recordingGit(checkoutAnswers);
    const report = await open(root).ledger.init({ git: fake.runner });
    expect(report.exclude).toBe('failed');
    expect(report.warnings.join('\n')).toContain('could not be written');
    expect(report.warnings.join('\n')).toContain(join(root, '.git', 'info', 'exclude'));
    // The bottom line is untouched by any attachment: the layout still lands, and the other
    // attachment (git config) wrote fine.
    expect(report.written).toEqual(LAYOUT_FILES);
    expect(report.mergeDriver).toBe('written');
  });

  it('git answers "not a checkout": every attachment is skipped, named in warnings, and init resolves', async () => {
    const refused: GitRunner = {
      run: () => Promise.resolve({ code: 128, stdout: '', stderr: 'fatal: not a git repository' }),
    };
    const report = await open(root).ledger.init({ git: refused });
    expect(report.written).toEqual(LAYOUT_FILES);
    // The asked-for repository is the attachment whose own git init git refused: the reading stays
    // "skipped" and the warning names what failed.
    expect(report.ownRepo).toBe('skipped');
    expect(report.exclude).toBe('skipped-not-a-checkout');
    expect(report.mergeDriver).toBe('skipped-no-config');
    expect(report.warnings).toHaveLength(3);
    expect(report.warnings.join('\n')).toContain('`git init` failed: fatal: not a git repository');
    expect(report.warnings.join('\n')).toContain('exited 128');
    expect(readFileSync(join(root, '.superworker', '.gitignore'), 'utf8').length).toBeGreaterThan(0);
  });

  it('a registration this machine already answers is kept: nothing is written over it, and the report names it', async () => {
    mkdirSync(join(root, '.git', 'info'), { recursive: true });
    const standIn = join(root, 'chosen-merge.mjs');
    writeFileSync(standIn, '#!/usr/bin/env node\n', 'utf8');
    const chosen = `"${process.execPath}" "${standIn}" %O %A %B %P`;
    const fake = recordingGit((args) => {
      if (args.join(' ') === 'config --local --get merge.superworker.driver') {
        return { code: 0, stdout: `${chosen}\n`, stderr: '' };
      }
      return checkoutAnswers(args);
    });
    const report = await open(root).ledger.init({ git: fake.runner });
    expect(report.mergeDriver).toBe('kept');
    expect(report.mergeDriverCommand).toBe(chosen);
    // Not one write of either key: the pair already there is the pair that stays.
    expect(fake.calls.some((call) => call.args[0] === 'config' && call.args[2] !== '--get')).toBe(false);
  });
});

/** Hash of the whole tree (relative path + content fed to sha256 one after another). */
function hashTree(dir: string): string {
  const hash = createHash('sha256');
  const walk = (current: string, prefix: string): void => {
    for (const name of readdirSync(current).sort()) {
      const full = join(current, name);
      if (statSync(full).isDirectory()) walk(full, `${prefix}${name}/`);
      else {
        hash.update(`${prefix}${name}\n`);
        hash.update(readFileSync(full));
      }
    }
  };
  walk(dir, '');
  return hash.digest('hex');
}

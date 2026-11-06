import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runMergeDriver, type MergeDriverRequest } from '../src/ledgermerge/driver';
import { open } from '../src/open';
import { ledgerLockPath, pfPaths } from '../src/paths';
import { LEDGER_MERGE_CASES } from './ledger-merge-cases';

/**
 * The three-way merge driver: it merges by record, not by line.
 *
 * The byte-for-byte half comes from `ledger-merge-cases.ts`: the expected bytes are what running
 * `git merge` in a temp git repo collected in that round (the rules are in that data's file
 * header). All this file does is lay the three sides into a temp project root, run the driver and
 * compare byte for byte; test time starts no process.
 *
 * The other cases pin the rules themselves: a tombstone is never lost, a deletion propagates, a
 * state takes the higher rank, an unknown shape is refused, not a byte lands when the record
 * directory was never init-ed, and the driver leaves a file alone when the merge result equals it.
 */

/** Record bytes are LF on every platform (machine-read bytes must match across machines). */
const EOL = '\n';

let root: string;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'pf-merge-'));
  // The record directory is init-ed first: the two marks init lays down are the driver's write gate (the same shape as the `.pf` in git).
  await open(root).ledger.init();
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  root = undefined!;
});

/** One driver reading: the exit code, the words, and how `%A` finally looks. */
interface MergeRun {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly oursBytes: Buffer;
  /** The mtime (ms) the sides really had when the driver ran; 0 for a side that is not a file. */
  readonly mtimes: { readonly ours: number; readonly theirs: number };
}

interface Sides {
  readonly base?: string | null;
  readonly ours?: string | null;
  readonly theirs?: string | null;
  readonly path?: string;
  readonly dryRun?: boolean;
  /** The three side file names: by default the git temp-file shape, which names no record, so only `path` can say what it is. */
  readonly names?: { readonly base: string; readonly ours: string; readonly theirs: string };
  /**
   * The mtimes to set after the sides are written, so a case can make file age disagree with the
   * record's own timestamps on purpose (the write order of this helper is base, ours, theirs).
   */
  readonly mtimes?: { readonly base?: Date; readonly ours?: Date; readonly theirs?: Date };
}

/**
 * Lay the three sides into a temp directory and run the driver once.
 *
 * The side file names deliberately take the git temp-file shape (`.merge_file_XXXX`): under git
 * that is exactly what the driver gets, so a record can only be named by `%P` (`path`) or by its
 * own shape. The sides are written in the order base, ours, theirs; a case that cares about file
 * age sets `mtimes` so it is not left to the write order.
 */
async function run(sides: Sides): Promise<MergeRun> {
  const names = sides.names ?? {
    base: '.merge_file_BASE',
    ours: '.merge_file_OURS',
    theirs: '.merge_file_THEIRS',
  };
  const paths = {
    base: join(root, 'sides', names.base),
    ours: join(root, 'sides', names.ours),
    theirs: join(root, 'sides', names.theirs),
  };
  mkdirSync(dirname(paths.ours), { recursive: true });
  for (const side of ['base', 'ours', 'theirs'] as const) {
    const text = sides[side];
    if (text === null || text === undefined) {
      // A side that is absent has to be really absent: a file an earlier run laid down must not stand in for it.
      rmSync(paths[side], { force: true });
      continue;
    }
    writeFileSync(paths[side], text.replace(/\n/g, EOL));
  }
  for (const side of ['base', 'ours', 'theirs'] as const) {
    const mtime = sides.mtimes?.[side];
    if (mtime !== undefined) utimesSync(paths[side], mtime, mtime);
  }

  const stdout: string[] = [];
  const stderr: string[] = [];
  const request: MergeDriverRequest = {
    base: paths.base,
    ours: paths.ours,
    theirs: paths.theirs,
    root,
    ...(sides.path === undefined ? {} : { path: sides.path }),
    ...(sides.dryRun === true ? { dryRun: true } : {}),
  };
  const code = await runMergeDriver(request, {
    stdout: (text) => stdout.push(text),
    stderr: (text) => stderr.push(text),
  });
  const oursBytes = existsSync(paths.ours) ? readFileSync(paths.ours) : Buffer.alloc(0);
  return {
    code,
    stdout: stdout.join(''),
    stderr: stderr.join(''),
    oursBytes,
    mtimes: { ours: mtimeOf(paths.ours), theirs: mtimeOf(paths.theirs) },
  };
}

/** The mtime of a side (ms); 0 when it is not a file. */
function mtimeOf(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}

/** The bytes a piece of record text (LF spelling) has once it has landed. */
function bytesOf(text: string): Buffer {
  return Buffer.from(text.replace(/\n/g, EOL), 'utf8');
}

/** Wait real time: asserting "nothing has been written in this window" needs a real window, and the lock's probe interval is 50ms. */
function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

describe('byte-for-byte replay: the output collected in a temp git repo', () => {
  for (const item of LEDGER_MERGE_CASES) {
    it(`${item.name} (${item.path})`, async () => {
      const run1 = await run({
        base: item.base,
        ours: item.ours,
        theirs: item.theirs,
        path: item.path,
      });
      expect(run1.code).toBe(item.expectCode);
      if (item.expectMerged === null) {
        // Refused or in conflict: not a byte should move, so git keeps %A and records this merge as a conflict.
        expect(run1.oursBytes.equals(bytesOf(item.ours))).toBe(true);
      } else {
        expect(run1.oursBytes.equals(bytesOf(item.expectMerged))).toBe(true);
      }
    });
  }

  it('the conflict lands on a field: the words name which record, which field, and what each side says', async () => {
    const conflict = LEDGER_MERGE_CASES.find((item) => item.name === 'ideas-title-conflict')!;
    const run1 = await run({
      base: conflict.base,
      ours: conflict.ours,
      theirs: conflict.theirs,
      path: conflict.path,
    });
    expect(run1.code).toBe(1);
    expect(run1.stderr).toContain('merge-ledger: conflict [.pf/ideas.json] Node aaaaaaaa field title');
    expect(run1.stderr).toContain('ours="甲侧标题"');
    expect(run1.stderr).toContain('theirs="乙侧标题"');
    expect(run1.stderr).toContain('1 places need a human decision');
  });

  it('a delete-versus-edit conflict: the whole record is judged at once', async () => {
    const conflict = LEDGER_MERGE_CASES.find(
      (item) => item.name === 'instructions-delete-vs-edit',
    )!;
    const run1 = await run({
      base: conflict.base,
      ours: conflict.ours,
      theirs: conflict.theirs,
      path: conflict.path,
    });
    expect(run1.code).toBe(1);
    expect(run1.stderr).toContain('instruction 2 field (the whole record)');
    expect(run1.stderr).toContain('delete vs edit collided');
  });
});

describe('an unrecognised record is left alone', () => {
  it('unrecognised by name and by shape: exit code 2, and not a byte is written', async () => {
    const unknown = JSON.stringify({ version: 1, foo: 'bar' }, null, 2);
    const run1 = await run({ base: unknown, ours: unknown, theirs: unknown });
    expect(run1.code).toBe(2);
    expect(run1.stderr).toContain('this is not a ledger file this driver handles');
    expect(run1.oursBytes.equals(bytesOf(unknown))).toBe(true);
  });

  it('recognised by name but the content is not a record: the wrong shape is refused', async () => {
    const list = JSON.stringify([{ id: '1' }], null, 2);
    const run1 = await run({ base: list, ours: list, theirs: list, path: '.pf/ideas.json' });
    expect(run1.code).toBe(2);
    expect(run1.stderr).toContain('not a JSON object');
    expect(run1.oursBytes.equals(bytesOf(list))).toBe(true);
  });

  it('when the name says nothing the shape decides: a file whose only key is `nodes` is the graph', async () => {
    const ideas = JSON.stringify({ nodes: {} }, null, 2);
    const run1 = await run({ base: ideas, ours: ideas, theirs: ideas });
    expect(run1.code).toBe(0);
    expect(run1.oursBytes.equals(bytesOf(ideas))).toBe(true);
  });
});

describe('one side has no such file', () => {
  const ideas = JSON.stringify(
    {
      nodes: {
        'dddddddd-4444-4444-8444-444444444444': {
          title: '只有这边有',
          description: '',
          status: 'todo',
          mode: 'auto',
          dependencies: [],
          created_at: '2026-02-01T00:00:00.000000Z',
          updated_at: '2026-02-01T00:00:00.000000Z',
        },
      },
    },
    null,
    2,
  );

  it('theirs missing: take ours; ours missing: write theirs in', async () => {
    const theirsOnly = await run({ base: null, ours: null, theirs: ideas, path: '.pf/ideas.json' });
    expect(theirsOnly.code).toBe(0);
    expect(JSON.parse(theirsOnly.oursBytes.toString('utf8'))).toEqual(JSON.parse(ideas));

    const oursOnly = await run({ base: ideas, ours: ideas, theirs: null, path: '.pf/ideas.json' });
    expect(oursOnly.code).toBe(0);
    expect(JSON.parse(oursOnly.oursBytes.toString('utf8'))).toEqual(JSON.parse(ideas));
  });

  it('neither side has it: nothing to merge, exit code 0', async () => {
    const neither = await run({ base: null, ours: null, theirs: null, path: '.pf/ideas.json' });
    expect(neither.code).toBe(0);
    expect(neither.stderr).toContain('neither side has a file');
  });

  it('git add/add hands an empty file: that is the one absence, and it is said out loud', async () => {
    const added = await run({ base: null, ours: '', theirs: ideas, path: '.pf/ideas.json' });
    expect(added.code).toBe(0);
    // What lands was written by this record's own writer (ideas sorting keys), so only the record itself is compared.
    expect(JSON.parse(added.oursBytes.toString('utf8'))).toEqual(JSON.parse(ideas));
    expect(added.stderr).toContain('0-byte file');
    expect(added.stderr).toContain('reading it as absent');
  });

  it('a file that is not 0 bytes but does not read as a record is a parse error, never a silent absence', async () => {
    // A whitespace-only file, and one that opens with a byte order mark: neither may be read as
    // "this side has no record", which would quietly drop the other side's whole graph.
    const badSides = ['  \n\n\t\n', '\uFEFF{"nodes": {}}'];
    for (const bad of badSides) {
      const run1 = await run({ base: null, ours: bad, theirs: ideas, path: '.pf/ideas.json' });
      expect(run1.code, `side text ${JSON.stringify(bad)}`).toBe(2);
      expect(run1.stderr).toContain('nothing is written');
      // `%A` keeps its own bytes: nothing was written over them.
      expect(run1.oursBytes.equals(Buffer.from(bad, 'utf8'))).toBe(true);
    }
  });
});

/**
 * A side that is there but cannot be read is a usage error, never "this side has no record".
 *
 * git hands the driver its own temporary files; if one of them cannot be opened (a share-locked
 * handle on Windows, no permission on POSIX), reading it as absent would write the other side's
 * record over it and let git record the merge as resolved. The stand-in staged here — a directory
 * where a side file should be — is the same family of failure: the path exists, so the read error
 * is not ENOENT, which is the only code that means "absent".
 */
describe('a side that is present but unreadable: exit 2, a line on stderr, not a byte written', () => {
  const ideas = JSON.stringify(
    {
      nodes: {
        'dddddddd-4444-4444-8444-444444444444': {
          title: '只有这边有',
          description: '',
          status: 'todo',
          mode: 'auto',
          dependencies: [],
          created_at: '2026-02-01T00:00:00.000000Z',
          updated_at: '2026-02-01T00:00:00.000000Z',
        },
      },
    },
    null,
    2,
  );

  /** The three side paths, with the one named side staged as a directory: present, and not readable as a file. */
  function stageSides(unreadable: 'ours' | 'theirs'): {
    readonly base: string;
    readonly ours: string;
    readonly theirs: string;
  } {
    const dir = join(root, 'sides');
    mkdirSync(dir, { recursive: true });
    const paths = {
      base: join(dir, '.merge_file_BASE'),
      ours: join(dir, '.merge_file_OURS'),
      theirs: join(dir, '.merge_file_THEIRS'),
    };
    for (const side of ['base', 'ours', 'theirs'] as const) {
      if (side === unreadable) {
        mkdirSync(paths[side], { recursive: true });
        continue;
      }
      writeFileSync(paths[side], ideas.replace(/\n/g, EOL));
    }
    return paths;
  }

  it('the other side is present but unreadable: a usage error, and `%A` keeps every byte', async () => {
    const paths = stageSides('theirs');
    const oursBefore = readFileSync(paths.ours);
    const stderr: string[] = [];
    const code = await runMergeDriver(
      { ...paths, root, path: '.pf/ideas.json' },
      { stdout: () => {}, stderr: (text) => stderr.push(text) },
    );
    const said = stderr.join('');
    expect(code).toBe(2);
    expect(said).toContain('is there but could not be read');
    // The side is named once, then the file it was reading: one word per fact.
    expect(said).toContain('the theirs side (.merge_file_THEIRS) is there but could not be read');
    expect(readFileSync(paths.ours).equals(oursBefore)).toBe(true);
  });

  it('this side is present but unreadable: not read as absent, so the other side is not written in its place', async () => {
    const paths = stageSides('ours');
    const theirsBefore = readFileSync(paths.theirs);
    const stderr: string[] = [];
    const code = await runMergeDriver(
      { ...paths, root, path: '.pf/ideas.json' },
      { stdout: () => {}, stderr: (text) => stderr.push(text) },
    );
    const said = stderr.join('');
    expect(code).toBe(2);
    expect(said).toContain('is there but could not be read');
    expect(said).toContain('the ours side (.merge_file_OURS) is there but could not be read');
    expect(statSync(paths.ours).isDirectory()).toBe(true);
    expect(readFileSync(paths.theirs).equals(theirsBefore)).toBe(true);
  });

  it('the side is said once even when the file itself is called after its side', async () => {
    // A path whose file name is the side's own word: the line used to read "theirs theirs is there
    // but could not be read", which looks like a broken template at the exact moment a person is
    // being told the merge was not judged. One side word, then the file in parentheses.
    const dir = join(root, 'sides');
    mkdirSync(dir, { recursive: true });
    const paths = { base: join(dir, 'base'), ours: join(dir, 'ours'), theirs: join(dir, 'theirs') };
    writeFileSync(paths.base, ideas.replace(/\n/g, EOL));
    writeFileSync(paths.ours, ideas.replace(/\n/g, EOL));
    mkdirSync(paths.theirs, { recursive: true });
    const oursBefore = readFileSync(paths.ours);
    const said: string[] = [];
    const code = await runMergeDriver(
      { ...paths, root, path: '.pf/ideas.json' },
      { stdout: () => {}, stderr: (text) => said.push(text) },
    );
    const line = said.join('');
    expect(code).toBe(2);
    expect(line).toContain('the theirs side (theirs) is there but could not be read');
    expect(line).not.toContain('theirs theirs');
    expect(readFileSync(paths.ours).equals(oursBefore)).toBe(true);
  });
});

describe('the record directory was never init-ed: not a byte is written', () => {
  it('exit code 1, and both `%A` and `.pf/meta` stay exactly as they were', async () => {
    const bare = mkdtempSync(join(tmpdir(), 'pf-merge-bare-'));
    try {
      // This run really would write (each side adds a node), so the write gate gets its chance to speak.
      const side = (id: string, title: string): string =>
        JSON.stringify(
          {
            nodes: {
              [id]: {
                title,
                description: '',
                status: 'todo',
                mode: 'auto',
                dependencies: [],
                created_at: '2026-02-01T00:00:00.000000Z',
                updated_at: '2026-02-01T00:00:00.000000Z',
              },
            },
          },
          null,
          2,
        );
      const base = JSON.stringify({ nodes: {} }, null, 2);
      const ours = side('aaaaaaaa-1111-4111-8111-111111111111', '甲侧新节点');
      const theirs = side('bbbbbbbb-2222-4222-8222-222222222222', '乙侧新节点');
      const sides = join(bare, 'sides');
      mkdirSync(sides, { recursive: true });
      const paths = {
        base: join(sides, 'base'),
        ours: join(sides, 'ours'),
        theirs: join(sides, 'theirs'),
      };
      writeFileSync(paths.base, base.replace(/\n/g, EOL));
      writeFileSync(paths.ours, ours.replace(/\n/g, EOL));
      writeFileSync(paths.theirs, theirs.replace(/\n/g, EOL));
      const code = await runMergeDriver(
        { ...paths, root: bare, path: '.pf/ideas.json' },
        { stdout: () => {}, stderr: () => {} },
      );
      expect(code).toBe(1);
      expect(readFileSync(paths.ours, 'utf8')).toBe(bytesOf(ours).toString('utf8'));
      // The write gate comes before the lock: `mkdir` should not set up a `.pf/meta/` in someone else's repo on the way.
      expect(existsSync(join(bare, '.pf'))).toBe(false);
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  });
});

describe('the rules', () => {
  const nodeA = 'aaaaaaaa-1111-4111-8111-111111111111';
  const nodeB = 'bbbbbbbb-2222-4222-8222-222222222222';

  function node(title: string, status: string, stamp: string, dependencies: string[] = []) {
    return {
      title,
      description: '',
      status,
      mode: 'auto',
      dependencies,
      created_at: '2026-02-01T00:00:00.000000Z',
      updated_at: stamp,
    };
  }

  it('both sides moved the state: the higher rank wins (todo < shelved < completed)', async () => {
    const base = JSON.stringify({ nodes: { [nodeA]: node('甲', 'todo', '2026-02-01T00:00:00.000000Z') } }, null, 2);
    const ours = JSON.stringify({ nodes: { [nodeA]: node('甲', 'shelved', '2026-02-01T01:00:00.000000Z') } }, null, 2);
    const theirs = JSON.stringify({ nodes: { [nodeA]: node('甲', 'completed', '2026-02-01T02:00:00.000000Z') } }, null, 2);
    const run1 = await run({ base, ours, theirs, path: '.pf/ideas.json' });
    expect(run1.code).toBe(0);
    expect(JSON.parse(run1.oursBytes.toString('utf8'))).toMatchObject({
      nodes: { [nodeA]: { status: 'completed', updated_at: '2026-02-01T02:00:00.000000Z' } },
    });
  });

  it('the graph: one side takes the node away while the other leaves it be, so the node is gone', async () => {
    const base = JSON.stringify({ nodes: { [nodeA]: node('甲', 'todo', '2026-02-01T00:00:00.000000Z'), [nodeB]: node('乙', 'todo', '2026-02-01T00:00:00.000000Z') } }, null, 2);
    const ours = JSON.stringify({ nodes: { [nodeA]: node('甲', 'todo', '2026-02-01T00:00:00.000000Z') } }, null, 2);
    const theirs = base;
    const run1 = await run({ base, ours, theirs, path: '.pf/ideas.json' });
    expect(run1.code).toBe(0);
    expect(Object.keys(JSON.parse(run1.oursBytes.toString('utf8')).nodes)).toEqual([nodeA]);
  });

  it('the graph: one side takes the node away and the other changed it, which is a delete-versus-edit conflict', async () => {
    const base = JSON.stringify({ nodes: { [nodeA]: node('甲', 'todo', '2026-02-01T00:00:00.000000Z') } }, null, 2);
    const ours = JSON.stringify({ nodes: {} }, null, 2);
    const theirs = JSON.stringify({ nodes: { [nodeA]: node('甲改', 'todo', '2026-02-01T02:00:00.000000Z') } }, null, 2);
    const run1 = await run({ base, ours, theirs, path: '.pf/ideas.json' });
    expect(run1.code).toBe(1);
    expect(run1.stderr).toContain('Node aaaaaaaa field (the whole record)');
    expect(run1.stderr).toContain('<deleted on this side>');
  });

  it('the graph: a dependency edge the merge breaks has to be named (a dangling one reads as satisfied, so the pipeline will not find it on its own)', async () => {
    const base = JSON.stringify({ nodes: { [nodeA]: node('甲', 'todo', '2026-02-01T00:00:00.000000Z'), [nodeB]: node('乙', 'todo', '2026-02-01T00:00:00.000000Z') } }, null, 2);
    const ours = JSON.stringify({ nodes: { [nodeB]: node('乙', 'todo', '2026-02-01T00:00:00.000000Z') } }, null, 2);
    const theirs = JSON.stringify({ nodes: { [nodeA]: node('甲', 'todo', '2026-02-01T00:00:00.000000Z'), [nodeB]: node('乙', 'todo', '2026-02-01T00:00:00.000000Z', [nodeA]) } }, null, 2);
    const run1 = await run({ base, ours, theirs, path: '.pf/ideas.json' });
    expect(run1.code).toBe(1);
    expect(run1.stderr).toContain('a dependency was deleted by the merge');
    expect(run1.stderr).toContain('field dependencies');
    expect(run1.oursBytes.equals(bytesOf(ours))).toBe(true);
  });

  it('instructions: one side takes it away and the other leaves it be, so the entry is gone while its tombstone stays', async () => {
    const first = (id: string, text: string) => ({
      id,
      text,
      scope: 'global',
      target: 'stage',
      state: 'live',
      cycle: null,
      node: null,
      said_by: 'user',
      at: '2026-02-01T00:00:00Z',
      resolved_at: null,
      note: null,
    });
    const base = JSON.stringify({ instructions: [first('1', '第一条'), first('2', '第二条')], removed: [] }, null, 2);
    const ours = JSON.stringify({ instructions: [first('1', '第一条')], removed: [{ id: '2', at: '2026-02-01T02:00:00Z' }] }, null, 2);
    const theirs = JSON.stringify({ instructions: [first('1', '第一条'), first('2', '第二条')], removed: [{ id: '9', at: '2026-02-01T03:00:00Z' }] }, null, 2);
    const run1 = await run({ base, ours, theirs, path: '.pf/instructions.json' });
    expect(run1.code).toBe(0);
    const merged = JSON.parse(run1.oursBytes.toString('utf8')) as {
      instructions: Array<{ id: string }>;
      removed: Array<{ id: string }>;
    };
    expect(merged.instructions.map((item) => item.id)).toEqual(['1']);
    // The removal traces take a union by id: no one ever takes one back.
    expect(merged.removed.map((item) => item.id)).toEqual(['2', '9']);
  });

  it('instructions: one side puts it back and the other changes it again, with neither timestamp orderable — a conflict', async () => {
    const first = (state: string, resolved: string | null) => ({
      id: '1',
      text: '第一条',
      scope: 'global',
      target: 'stage',
      state,
      cycle: null,
      node: null,
      said_by: 'user',
      at: '2026-02-01T00:00:00Z',
      resolved_at: resolved,
      note: null,
    });
    const base = JSON.stringify({ instructions: [first('withdrawn', '2026-02-01T01:00:00Z')], removed: [] }, null, 2);
    const ours = JSON.stringify({ instructions: [first('live', null)], removed: [] }, null, 2);
    const theirs = JSON.stringify({ instructions: [first('withdrawn', '2026-02-01T02:00:00Z')], removed: [] }, null, 2);
    const run1 = await run({ base, ours, theirs, path: '.pf/instructions.json' });
    expect(run1.code).toBe(1);
    expect(run1.stderr).toContain('two owner acts collided');
  });

  it('the line: the same node has two verdicts on the two sides, and the tail of path takes no union', async () => {
    const step = (result: string) => ({
      node: nodeA,
      started_at: '2026-02-01T00:00:00Z',
      ended_at: '2026-02-01T00:10:00Z',
      result,
    });
    const cycle = (path: unknown[]) => ({
      id: 'pf-core',
      title: '主线程',
      status: 'active',
      holding: [],
      path,
      created_at: '2026-02-01T00:00:00Z',
      updated_at: '2026-02-01T00:10:00Z',
    });
    const base = JSON.stringify({ cycles: [cycle([])] }, null, 2);
    const ours = JSON.stringify({ cycles: [cycle([step('completed')])] }, null, 2);
    const theirs = JSON.stringify({ cycles: [cycle([step('failed')])] }, null, 2);
    const run1 = await run({ base, ours, theirs, path: '.pf/state.json' });
    expect(run1.code).toBe(1);
    expect(run1.stderr).toContain('cycle \'pf-core\' field path');
    expect(run1.stderr).toContain('different results on the two sides');
  });

  it('the ticket: a field both sides changed follows the ticket whose own timestamp is later, never the file it arrived in', async () => {
    const ticket = (summary: string, stamp: string) => ({
      cycle: 'pf-core',
      node: nodeA,
      status: 'completed',
      summary,
      outputs: {},
      timestamp: stamp,
    });
    const base = JSON.stringify(ticket('原报告', '2026-02-01T00:00:00Z'), null, 2);
    const ours = JSON.stringify(ticket('甲侧报告', '2026-02-01T01:00:00Z'), null, 2);
    const theirs = JSON.stringify(ticket('乙侧报告', '2026-02-01T02:00:00Z'), null, 2);
    const path = `.pf/signals/pf-core/${nodeA}.json`;

    // git hands the driver its own temporary files; their names and timestamps say nothing about
    // which attempt is later. The mtimes here deliberately disagree with the tickets' own stamps:
    // `%A` is the newer file (`ours` was written last, and its mtime is put later still) while
    // `%B` carries the later timestamp. Ordering by file age would take `ours`; the ticket's own
    // timestamp is the only ordering, and the later ticket wins in either name arrangement.
    const oursFileLater = new Date('2026-03-02T00:00:00Z');
    const theirsFileEarlier = new Date('2026-03-01T00:00:00Z');

    const first = await run({
      base,
      ours,
      theirs,
      path,
      names: { base: '.merge_file_1', ours: '.merge_file_3', theirs: '.merge_file_2' },
      mtimes: { ours: oursFileLater, theirs: theirsFileEarlier },
    });
    // The fixture really does contradict the timestamps: the file that would win on age is `ours`.
    expect(first.mtimes.ours).toBeGreaterThan(first.mtimes.theirs);
    expect(first.code).toBe(0);
    expect(JSON.parse(first.oursBytes.toString('utf8'))).toMatchObject({
      summary: '乙侧报告',
      timestamp: '2026-02-01T02:00:00Z',
    });

    const second = await run({
      base,
      ours,
      theirs,
      path,
      names: { base: '.merge_file_2', ours: '.merge_file_1', theirs: '.merge_file_3' },
      mtimes: { ours: oursFileLater, theirs: theirsFileEarlier },
    });
    expect(second.mtimes.ours).toBeGreaterThan(second.mtimes.theirs);
    expect(second.code).toBe(0);
    expect(JSON.parse(second.oursBytes.toString('utf8'))).toMatchObject({
      summary: '乙侧报告',
      timestamp: '2026-02-01T02:00:00Z',
    });
  });

  it('the ticket: two attempts that cannot be ordered are a conflict for a person (no timestamp, or the same one)', async () => {
    const ticket = (summary: string, stamp?: string) => ({
      cycle: 'pf-core',
      node: nodeA,
      status: 'completed' as const,
      summary,
      outputs: {},
      ...(stamp === undefined ? {} : { timestamp: stamp }),
    });
    const path = `.pf/signals/pf-core/${nodeA}.json`;

    // Neither side carries a timestamp: there is nothing to order them by.
    const noStamp = await run({
      base: JSON.stringify(ticket('原报告'), null, 2),
      ours: JSON.stringify(ticket('甲侧报告'), null, 2),
      theirs: JSON.stringify(ticket('乙侧报告'), null, 2),
      path,
    });
    expect(noStamp.code).toBe(1);
    expect(noStamp.stderr).toContain('cannot be ordered');
    expect(JSON.parse(noStamp.oursBytes.toString('utf8'))).toMatchObject({ summary: '甲侧报告' });

    // Both carry the same timestamp: the two attempts happen at one moment, and nothing may be guessed.
    const sameStamp = await run({
      base: JSON.stringify(ticket('原报告', '2026-02-01T00:00:00Z'), null, 2),
      ours: JSON.stringify(ticket('甲侧报告', '2026-02-01T03:00:00Z'), null, 2),
      theirs: JSON.stringify(ticket('乙侧报告', '2026-02-01T03:00:00Z'), null, 2),
      path,
    });
    expect(sameStamp.code).toBe(1);
    expect(sameStamp.stderr).toContain('both attempts carry the timestamp 2026-02-01T03:00:00Z');
    expect(JSON.parse(sameStamp.oursBytes.toString('utf8'))).toMatchObject({ summary: '甲侧报告' });
  });

  it('--dry-run: only the decisions and conflicts are printed, and not a byte is written', async () => {
    const conflict = LEDGER_MERGE_CASES.find((item) => item.name === 'ideas-title-conflict')!;
    const run1 = await run({
      base: conflict.base,
      ours: conflict.ours,
      theirs: conflict.theirs,
      path: conflict.path,
      dryRun: true,
    });
    expect(run1.code).toBe(1);
    expect(run1.stdout).toContain('--dry-run [.pf/ideas.json] kind=ideas');
    expect(run1.stdout).toContain('conflicts; nothing written');
    expect(run1.oursBytes.equals(bytesOf(conflict.ours))).toBe(true);
  });
});

/**
 * The remaining decision branches: each is its own stretch of the implementation, and only its
 * own case can pin it.
 *
 * Assertions land on visible results only — the exit code, the bytes of `%A`, the field a
 * conflict line names (the plain sentence in the words is not compared: its wording may be tuned
 * for readability, the rules will not move).
 */
describe('the side branches of the decision: each branch has a case of its own', () => {
  const nodeA = 'aaaaaaaa-1111-4111-8111-111111111111';
  const nodeB = 'bbbbbbbb-2222-4222-8222-222222222222';
  const nodeC = 'cccccccc-3333-4333-8333-333333333333';

  /** A graph node: the same fields the writer lays down, with `extra` used to change one edge or one state. */
  function idea(title: string, extra: Record<string, unknown> = {}) {
    return {
      title,
      description: '',
      status: 'todo',
      mode: 'auto',
      dependencies: [] as string[],
      created_at: '2026-02-01T00:00:00.000000Z',
      updated_at: '2026-02-01T00:00:00.000000Z',
      ...extra,
    };
  }

  /** One instruction record (the key order is the one it lands with). */
  function instruction(state: string, resolved: string | null) {
    return {
      id: '1',
      text: '第一条',
      scope: 'global',
      target: 'stage',
      state,
      cycle: null,
      node: null,
      said_by: 'user',
      at: '2026-02-01T00:00:00Z',
      resolved_at: resolved,
      note: null,
    };
  }

  /** The whole instruction record: both sides write this one entry, and `removed` stays empty. */
  function instructionsText(state: string, resolved: string | null): string {
    return JSON.stringify(
      { instructions: [instruction(state, resolved)], removed: [] },
      null,
      2,
    );
  }

  it('instructions: both sides archive the same entry, and the newer resolved_at takes the whole group', async () => {
    const base = JSON.stringify({ instructions: [instruction('live', null)], removed: [] }, null, 2);
    const early = instructionsText('withdrawn', '2026-02-01T01:00:00Z');
    const late = instructionsText('withdrawn', '2026-02-01T02:00:00Z');
    const latest = instructionsText('withdrawn', '2026-02-01T03:00:00Z');

    // The act on the other side is later: the state and resolved_at group comes from there whole.
    const laterTheirs = await run({ base, ours: early, theirs: late, path: '.pf/instructions.json' });
    expect(laterTheirs.code).toBe(0);
    expect(laterTheirs.oursBytes.equals(bytesOf(late))).toBe(true);

    // The other way round, with the later act on this side: the group comes from here whole (only the two runs together pin "take the newer side").
    const laterOurs = await run({ base, ours: latest, theirs: late, path: '.pf/instructions.json' });
    expect(laterOurs.code).toBe(0);
    expect(laterOurs.oursBytes.equals(bytesOf(latest))).toBe(true);
  });

  it('instructions: both sides remove the same instruction, and the tombstone takes the earlier timestamp', async () => {
    const text = (at: string): string =>
      JSON.stringify({ instructions: [], removed: [{ id: '1', at }] }, null, 2);
    const base = JSON.stringify({ instructions: [instruction('live', null)], removed: [] }, null, 2);
    const ours = text('2026-02-01T02:00:00Z');
    const theirs = text('2026-02-01T03:00:00Z');
    const run1 = await run({ base, ours, theirs, path: '.pf/instructions.json' });
    expect(run1.code).toBe(0);
    // Whoever removed it first is the moment it left the record: the earlier timestamp stays in the result (two machines each removing the same entry).
    expect(run1.oursBytes.equals(bytesOf(text('2026-02-01T02:00:00Z')))).toBe(true);
  });

  it('the graph: a state written outside the vocabulary is never guessed at', async () => {
    const base = JSON.stringify({ nodes: { [nodeA]: idea('甲') } }, null, 2);
    const ours = JSON.stringify({ nodes: { [nodeA]: idea('甲', { status: 'in_progress' }) } }, null, 2);
    const theirs = JSON.stringify({ nodes: { [nodeA]: idea('甲', { status: 'completed' }) } }, null, 2);
    const run1 = await run({ base, ours, theirs, path: '.pf/ideas.json' });
    expect(run1.code).toBe(1);
    expect(run1.stderr).toContain('Node aaaaaaaa field status');
    expect(run1.oursBytes.equals(bytesOf(ours))).toBe(true);
  });

  it('the graph: with no dependencies cell in base, adding and trimming an edge cannot be told apart — a conflict', async () => {
    // This node in base has no `dependencies` key at all: each side wrote its own version of the
    // edges, and with no common starting point "added one" and "trimmed one" look exactly alike on
    // the same value.
    const baseNode = {
      title: '甲',
      description: '',
      status: 'todo',
      mode: 'auto',
      created_at: '2026-02-01T00:00:00.000000Z',
      updated_at: '2026-02-01T00:00:00.000000Z',
    };
    const base = JSON.stringify({ nodes: { [nodeA]: baseNode, [nodeB]: idea('乙') } }, null, 2);
    const ours = JSON.stringify(
      { nodes: { [nodeA]: idea('甲', { dependencies: [nodeB] }), [nodeB]: idea('乙') } },
      null,
      2,
    );
    const theirs = JSON.stringify(
      { nodes: { [nodeA]: idea('甲', { dependencies: [] }), [nodeB]: idea('乙') } },
      null,
      2,
    );
    const run1 = await run({ base, ours, theirs, path: '.pf/ideas.json' });
    expect(run1.code).toBe(1);
    expect(run1.stderr).toContain('Node aaaaaaaa field dependencies');
    expect(run1.oursBytes.equals(bytesOf(ours))).toBe(true);
  });

  it('the graph: one side trims an edge while the other adds one — a quarrel over the same edge, a conflict', async () => {
    const base = JSON.stringify(
      {
        nodes: {
          [nodeA]: idea('甲', { dependencies: [nodeB] }),
          [nodeB]: idea('乙'),
          [nodeC]: idea('丙'),
        },
      },
      null,
      2,
    );
    const ours = JSON.stringify(
      {
        nodes: {
          [nodeA]: idea('甲', { dependencies: [] }),
          [nodeB]: idea('乙'),
          [nodeC]: idea('丙'),
        },
      },
      null,
      2,
    );
    const theirs = JSON.stringify(
      {
        nodes: {
          [nodeA]: idea('甲', { dependencies: [nodeB, nodeC] }),
          [nodeB]: idea('乙'),
          [nodeC]: idea('丙'),
        },
      },
      null,
      2,
    );
    const run1 = await run({ base, ours, theirs, path: '.pf/ideas.json' });
    expect(run1.code).toBe(1);
    expect(run1.stderr).toContain('Node aaaaaaaa field dependencies');
    expect(run1.oursBytes.equals(bytesOf(ours))).toBe(true);
  });

  it('the line: each side says a word, and no coin is tossed', async () => {
    const cycle = (status: string) => ({
      id: 'pf-core',
      title: '主线程',
      status,
      holding: [] as string[],
      path: [] as unknown[],
      created_at: '2026-02-01T00:00:00Z',
      updated_at: '2026-02-01T00:10:00Z',
    });
    // The line book has only active / inactive, so two words cannot be ordered against each
    // other; this branch is reachable only when one side carries a word outside the vocabulary (a
    // hand edit, or a record that came from elsewhere), and then it must go to a person.
    const base = JSON.stringify({ cycles: [cycle('active')] }, null, 2);
    const ours = JSON.stringify({ cycles: [cycle('inactive')] }, null, 2);
    const theirs = JSON.stringify({ cycles: [cycle('stalled')] }, null, 2);
    const run1 = await run({ base, ours, theirs, path: '.pf/state.json' });
    expect(run1.code).toBe(1);
    expect(run1.stderr).toContain("cycle 'pf-core' field status");
    expect(run1.oursBytes.equals(bytesOf(ours))).toBe(true);
  });
});

/**
 * How a table is read off the three sides: one reading for every record, so a hand-written shape cannot be read one
 * way by the graph and another way by the lines.
 *
 * An entry without an identity is the case that tells the readings apart. The writers lay entries down in a table
 * keyed by their id, so only a hand-written list can carry `id: ''` — and keying that under nothing is how a conflict
 * line once read "Node  field (the whole record)": it named no node at all.
 */
describe('the tables: one reading of a list-or-mapping shape', () => {
  /** A graph node with the writer's fields, plus whatever a hand edit added. */
  function idea(title: string, extra: Record<string, unknown> = {}) {
    return {
      title,
      description: '',
      status: 'todo',
      mode: 'auto',
      dependencies: [] as string[],
      created_at: '2026-02-01T00:00:00.000000Z',
      updated_at: '2026-02-01T00:00:00.000000Z',
      ...extra,
    };
  }

  it('a graph list entry whose id and uuid are both empty is left out, not keyed under nothing', async () => {
    const emptyId = { id: '', uuid: '' };
    const base = JSON.stringify({ nodes: [idea('甲', emptyId)] }, null, 2);
    const ours = JSON.stringify({ nodes: [idea('甲侧', emptyId)] }, null, 2);
    const theirs = JSON.stringify({ nodes: [] }, null, 2);
    const run1 = await run({ base, ours, theirs, path: '.pf/ideas.json' });
    expect(run1.code).toBe(0);
    expect(JSON.parse(run1.oursBytes.toString('utf8'))).toEqual({ nodes: {} });
  });

  it('a hand-written list entry with no identity is left out of the instruction table too, and the entry with an id merges beside it', async () => {
    /** One instruction with the writer's fields; `id` and the resolution act are what a case varies. */
    const instruction = (id: string, text: string, state: string, resolved: string | null) => ({
      id,
      text,
      scope: 'global',
      target: 'stage',
      state,
      cycle: null,
      node: null,
      said_by: 'user',
      at: '2026-02-01T00:00:00Z',
      resolved_at: resolved,
      note: null,
    });
    const base = JSON.stringify(
      { instructions: [instruction('1', '第一条', 'live', null)], removed: [] },
      null,
      2,
    );
    const ours = JSON.stringify(
      {
        instructions: [
          instruction('', '没有身份的一条', 'live', null),
          instruction('1', '第一条', 'withdrawn', '2026-02-01T02:00:00Z'),
        ],
        removed: [],
      },
      null,
      2,
    );
    const theirs = JSON.stringify(
      { instructions: [instruction('1', '第一条', 'withdrawn', '2026-02-01T01:00:00Z')], removed: [] },
      null,
      2,
    );
    const run1 = await run({ base, ours, theirs, path: '.pf/instructions.json' });
    expect(run1.code).toBe(0);
    const merged = JSON.parse(run1.oursBytes.toString('utf8')) as {
      instructions: { id: string; state: string; resolved_at: string | null }[];
    };
    expect(merged.instructions.map((entry) => entry.id)).toEqual(['1']);
    // The group still comes whole from the side that acted later (nothing about the empty entry changes that).
    expect(merged.instructions[0]).toMatchObject({
      state: 'withdrawn',
      resolved_at: '2026-02-01T02:00:00Z',
    });
  });

  it('a hand-written mapping is taken as it is: the line table merges by its key and lands as a list', async () => {
    const cycle = (status: string) => ({
      id: 'pf-core',
      title: '主线程',
      status,
      holding: [] as string[],
      path: [] as unknown[],
      created_at: '2026-02-01T00:00:00Z',
      updated_at: '2026-02-01T00:10:00Z',
    });
    const base = JSON.stringify({ cycles: { 'pf-core': cycle('active') } }, null, 2);
    const ours = JSON.stringify({ cycles: { 'pf-core': cycle('inactive') } }, null, 2);
    const theirs = JSON.stringify({ cycles: { 'pf-core': cycle('active') } }, null, 2);
    const run1 = await run({ base, ours, theirs, path: '.pf/state.json' });
    expect(run1.code).toBe(0);
    const merged = JSON.parse(run1.oursBytes.toString('utf8')) as {
      cycles: { id: string; status: string }[];
    };
    expect(merged.cycles).toEqual([{ ...cycle('inactive') }]);
  });
});

/**
 * The writing half of the driver: the landing spot, and the record lock that comes after the
 * write gate. Other cases only ever reach the write gate (with the record directory never
 * init-ed it stops before the lock), so only this place reaches the lock and the default
 * landing spot.
 */
describe('the writing half of the driver: the record lock and the default landing spot', () => {
  const nodeA = 'aaaaaaaa-1111-4111-8111-111111111111';
  const nodeB = 'bbbbbbbb-2222-4222-8222-222222222222';

  /** A graph with one node only: each side adds one, so the merge result must differ from `%A` and the writing half is reached. */
  function ideasSide(id: string, title: string): string {
    return JSON.stringify(
      {
        nodes: {
          [id]: {
            title,
            description: '',
            status: 'todo',
            mode: 'auto',
            dependencies: [],
            created_at: '2026-02-01T00:00:00.000000Z',
            updated_at: '2026-02-01T00:00:00.000000Z',
          },
        },
      },
      null,
      2,
    );
  }

  /** Lay the three sides into `<target>/sides/` under the git temp-file names and hand their paths back. */
  function laySides(
    target: string,
    sides: { readonly base: string; readonly ours: string; readonly theirs: string },
  ): { readonly base: string; readonly ours: string; readonly theirs: string } {
    const dir = join(target, 'sides');
    mkdirSync(dir, { recursive: true });
    const paths = {
      base: join(dir, '.merge_file_BASE'),
      ours: join(dir, '.merge_file_OURS'),
      theirs: join(dir, '.merge_file_THEIRS'),
    };
    writeFileSync(paths.base, sides.base.replace(/\n/g, EOL));
    writeFileSync(paths.ours, sides.ours.replace(/\n/g, EOL));
    writeFileSync(paths.theirs, sides.theirs.replace(/\n/g, EOL));
    return paths;
  }

  it('another writer holds the record lock: the driver waits for it to let go, and not a byte moves before it writes', async () => {
    const oursText = ideasSide(nodeA, '甲侧新节点');
    const paths = laySides(root, {
      base: JSON.stringify({ nodes: {} }, null, 2),
      ours: oursText,
      theirs: ideasSide(nodeB, '乙侧新节点'),
    });
    // A real writer holds this record tree's lock: the lock file being there is the whole signal of a cross-process hold.
    const lock = ledgerLockPath(pfPaths(root));
    mkdirSync(dirname(lock), { recursive: true });
    writeFileSync(lock, '');

    const pending = runMergeDriver({ ...paths, root, path: '.pf/ideas.json' }, {
      stdout: () => {},
      stderr: () => {},
    });
    // The lock is in someone else's hands, so nothing is written in this window (waiting for the lock has a limit, which is not reached here).
    await delay(300);
    expect(readFileSync(paths.ours, 'utf8')).toBe(bytesOf(oursText).toString('utf8'));

    // The holder lets go: the driver takes over, writes the merged record in, and gives its own lock back too.
    rmSync(lock, { force: true });
    expect(await pending).toBe(0);
    const written = JSON.parse(readFileSync(paths.ours, 'utf8')) as {
      nodes: Record<string, unknown>;
    };
    expect(Object.keys(written.nodes).sort()).toEqual([nodeA, nodeB].sort());
    expect(existsSync(lock)).toBe(false);
  }, 5000);

  it("no root passed: a project under a subdirectory of the repository is found from %P, not from the working directory", async () => {
    // git starts the driver at the top of the working tree; the project here sits two directories
    // below it, with its own record tree.
    const project = join(root, 'packages', 'app');
    mkdirSync(project, { recursive: true });
    await open(project).ledger.init();
    const oursText = ideasSide(nodeA, '甲侧新节点');
    const paths = laySides(root, {
      base: JSON.stringify({ nodes: {} }, null, 2),
      ours: oursText,
      theirs: ideasSide(nodeB, '乙侧新节点'),
    });
    const before = process.cwd();
    process.chdir(root);
    try {
      const code = await runMergeDriver(
        { ...paths, path: 'packages/app/.pf/ideas.json' },
        { stdout: () => {}, stderr: () => {} },
      );
      expect(code).toBe(0);
    } finally {
      process.chdir(before);
    }
    const written = JSON.parse(readFileSync(paths.ours, 'utf8')) as {
      nodes: Record<string, unknown>;
    };
    expect(Object.keys(written.nodes).sort()).toEqual([nodeA, nodeB].sort());
  }, 5000);

  it('no root and no %P passed: the walk up from the working directory finds the init-ed record tree and merges', async () => {
    // git starts a driver at the top of the working tree, but a person can also run it by hand from
    // anywhere below the project. Here the process stands one directory under the record tree and
    // no %P comes in, so only the walk up can place the record tree -- the branch the "nothing
    // found" case below does not reach.
    await open(root).ledger.init();
    const oursText = ideasSide(nodeA, '甲侧新节点');
    const paths = laySides(root, {
      base: JSON.stringify({ nodes: {} }, null, 2),
      ours: oursText,
      theirs: ideasSide(nodeB, '乙侧新节点'),
    });
    const below = join(root, 'notes');
    mkdirSync(below, { recursive: true });
    const before = process.cwd();
    process.chdir(below);
    try {
      const code = await runMergeDriver(
        { ...paths },
        { stdout: () => {}, stderr: () => {} },
      );
      expect(code).toBe(0);
    } finally {
      process.chdir(before);
    }
    const written = JSON.parse(readFileSync(paths.ours, 'utf8')) as {
      nodes: Record<string, unknown>;
    };
    expect(Object.keys(written.nodes).sort()).toEqual([nodeA, nodeB].sort());
  }, 5000);

  it('no .pf can be located from %P or from the directory above it: the driver says so, writing nothing', async () => {
    const bare = mkdtempSync(join(tmpdir(), 'pf-merge-nop-'));
    try {
      const sides = join(bare, 'sides');
      mkdirSync(sides, { recursive: true });
      const paths = {
        base: join(sides, 'base'),
        ours: join(sides, 'ours'),
        theirs: join(sides, 'theirs'),
      };
      const base = JSON.stringify({ nodes: {} }, null, 2);
      const oursText = ideasSide(nodeA, '甲侧新节点');
      writeFileSync(paths.base, base);
      writeFileSync(paths.ours, oursText);
      writeFileSync(paths.theirs, ideasSide(nodeB, '乙侧新节点'));
      const before = process.cwd();
      process.chdir(bare);
      let code = -1;
      let said = '';
      try {
        // No %P at all, and no init-ed `.pf` anywhere above: the record tree cannot be located.
        code = await runMergeDriver({ ...paths }, {
          stdout: () => {},
          stderr: (text) => {
            said += text;
          },
        });
      } finally {
        process.chdir(before);
      }
      expect(code).toBe(2);
      expect(said).toContain('no .pf sits at');
      expect(readFileSync(paths.ours, 'utf8')).toBe(oursText);
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  }, 5000);

  it('a %P into a tree with no initialised .pf: no record tree is located (exit 2), not "was never init-ed" (exit 1)', async () => {
    // git named a position; the directory in front of that `.pf` segment holds a `.pf` directory
    // but not one `init` ever set up. That is "there is no record tree at the position git named"
    // -- the driver's own exit-2 answer -- and not a located tree whose records were never set up:
    // the two readings send a person to two different places.
    const bare = mkdtempSync(join(tmpdir(), 'pf-merge-uninit-'));
    try {
      mkdirSync(join(bare, '.pf'), { recursive: true });
      writeFileSync(join(bare, '.pf', 'ideas.json'), JSON.stringify({ nodes: {} }, null, 2));
      const sides = join(bare, 'sides');
      mkdirSync(sides, { recursive: true });
      const paths = {
        base: join(sides, 'base'),
        ours: join(sides, 'ours'),
        theirs: join(sides, 'theirs'),
      };
      const oursText = ideasSide(nodeA, '甲侧新节点');
      writeFileSync(paths.base, JSON.stringify({ nodes: {} }, null, 2));
      writeFileSync(paths.ours, oursText);
      writeFileSync(paths.theirs, ideasSide(nodeB, '乙侧新节点'));
      const before = process.cwd();
      process.chdir(bare);
      let code = -1;
      let said = '';
      try {
        code = await runMergeDriver({ ...paths, path: '.pf/ideas.json' }, {
          stdout: () => {},
          stderr: (text) => {
            said += text;
          },
        });
      } finally {
        process.chdir(before);
      }
      expect(code).toBe(2);
      expect(said).toContain('no .pf sits at');
      expect(said).not.toContain('was never init-ed');
      expect(readFileSync(paths.ours, 'utf8')).toBe(oursText);
      // Nothing was written into the record tree either.
      expect(readFileSync(join(bare, '.pf', 'ideas.json'), 'utf8')).toBe(
        JSON.stringify({ nodes: {} }, null, 2),
      );
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  }, 5000);
});

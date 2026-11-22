import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { jsonBytes } from '../src/jsonio';
import { withLedgerLock } from '../src/ledgerlock';
import { recordPaths } from '../src/paths';
import { isRecordError } from '../src/errors';
import { pluginBase } from '../src/plugins/base';

/**
 * The record base the host context hands a plugin (`ctx.base`): the contract of the seam itself,
 * not of any one plugin. The mechanics behind the cells are the engine's own record IO and lock —
 * pinned on those modules' own suites — so what is locked here is what a plugin's own layer reads:
 * the cells exist, they behave as their one-line contracts say, and the lock is taken under the
 * path the caller names (its own lock, never the record tree's). Engine operations always land in
 * a temp dir.
 */

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'superworker-plugin-base-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('moments and bytes', () => {
  it('the two timestamp spellings are the engine\u2019s own shapes: microseconds and seconds, UTC with a literal Z', () => {
    const base = pluginBase();
    expect(base.nowMicro()).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/);
    expect(base.nowSeconds()).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    // Strictly increasing within the process: two reads never share one microsecond.
    expect(base.nowMicro() < base.nowMicro()).toBe(true);
  });

  it('readJson answers the three readings: present, missing, and a decidable error for bytes and text that cannot be read', async () => {
    const base = pluginBase();
    const path = join(root, 'record.json');
    expect(await base.readJson(path)).toEqual({ kind: 'missing' });
    writeFileSync(path, '{"b":1,"a":"中文"}', 'utf8');
    expect(await base.readJson(path)).toEqual({ kind: 'present', value: { b: 1, a: '中文' } });
    writeFileSync(path, 'not json', 'utf8');
    await expect(base.readJson(path)).rejects.toSatisfy((error: unknown) => isRecordError(error, 'parse_failure'));
    writeFileSync(path, Buffer.from([0xff, 0xfe]), 'utf8');
    await expect(base.readJson(path)).rejects.toSatisfy((error: unknown) => isRecordError(error, 'invalid_utf8'));
  });

  it('writeJson lands exactly the bytes jsonBytes spells, through the atomic landing', async () => {
    const base = pluginBase();
    const path = join(root, 'deep', 'record.json');
    const value = { b: 1, a: { d: [2, 1], c: '中文' } };
    await base.writeJson(path, value, { sortKeys: true });
    expect(readFileSync(path)).toEqual(Buffer.from(jsonBytes(value, { sortKeys: true })));
    expect(readFileSync(path, 'utf8').endsWith('\n')).toBe(false);
  });

  it('the platform line ending is the cell a person-read text takes; it is never written into a record', () => {
    const base = pluginBase();
    expect(base.EOL).toBe(process.platform === 'win32' ? '\r\n' : '\n');
    const path = join(root, 'record.json');
    return pluginBase().writeJson(path, { eol: base.EOL }, {}).then(() => {
      // The record carries the value as data; the bytes around it stay LF.
      expect(readFileSync(path, 'utf8')).toContain('"eol"');
    });
  });
});

describe('withLock: one record lock under the path the caller names', () => {
  /** A gate the test opens itself: the overlap window is made real without a timer. */
  function gate(): { hold: Promise<void>; open: () => void } {
    let open!: () => void;
    const hold = new Promise<void>((done) => {
      open = done;
    });
    return { hold, open };
  }

  it('two concurrent bodies on one path run one after the other, and both changes land', async () => {
    const base = pluginBase();
    const lockPath = join(root, 'own', 'my-record.lock');
    const order: string[] = [];
    let inside = 0;
    const firstGate = gate();
    const body = (name: string, hold?: Promise<void>): (() => Promise<void>) => async () => {
      expect(inside).toBe(0);
      inside += 1;
      order.push(`${name}:in`);
      if (hold !== undefined) await hold;
      order.push(`${name}:out`);
      inside -= 1;
    };
    // Both bodies are started while the first still holds its window: the second can only be
    // queued behind it — the answer order below is the lock's witness.
    const first = base.withLock(lockPath, body('first', firstGate.hold));
    const second = base.withLock(lockPath, body('second'));
    firstGate.open();
    await Promise.all([first, second]);
    expect(order).toEqual(['first:in', 'first:out', 'second:in', 'second:out']);
    // The lock file is the holder's residue only while held; released, it is gone.
    expect(existsSync(lockPath)).toBe(false);
  });

  it('a different path never waits behind another: two records, two locks', async () => {
    const base = pluginBase();
    const firstGate = gate();
    const first = base.withLock(join(root, 'one.lock'), async () => {
      await firstGate.hold;
      return 'one';
    });
    // The first body still holds its lock while the second runs to its end: a different path
    // never queues.
    const second = base.withLock(join(root, 'two.lock'), async () => 'two');
    expect(await second).toBe('two');
    firstGate.open();
    expect(await first).toBe('one');
  });

  it('waiting past the limit is a decidable lock_timeout naming the path, with the record\u2019s own name in the sentence', async () => {
    const base = pluginBase();
    const lockPath = join(root, 'my-record.lock');
    writeFileSync(lockPath, '', 'utf8');
    const failure: unknown = await base
      .withLock(lockPath, async () => 'never reached', { timeoutMs: 0, label: 'my record' })
      .catch((error: unknown) => error);
    expect(isRecordError(failure, 'lock_timeout')).toBe(true);
    const error = failure as { path: string; message: string };
    expect(error.path).toBe(lockPath);
    expect(error.message).toContain(lockPath);
    expect(error.message).toContain('my record');
    expect(error.message).toContain('delete that path');
    // Nothing is swept for the caller: clearing a lock file stays a person's call.
    expect(existsSync(lockPath)).toBe(true);
  });

  it('the record tree\u2019s lock is a different path: a plugin lock and the ledger lock do not stand in for each other', async () => {
    const base = pluginBase();
    const pluginLock = join(root, 'meta', 'my-record.lock');
    await base.withLock(pluginLock, async () => {
      expect(existsSync(pluginLock)).toBe(true);
      // Holding the plugin lock does not hold the record tree's: both can be taken at once, which
      // is exactly why they must never be taken together.
      const paths = recordPaths(root);
      await withLedgerLock(paths, async () => {
        expect(existsSync(join(paths.recordDir, 'meta', 'ledger.lock'))).toBe(true);
      });
    });
    expect(existsSync(pluginLock)).toBe(false);
  });
});

describe('verbSurface: one command surface from a plugin\u2019s own tables', () => {
  /**
   * A toy surface with the two shapes a plugin really has: a reading verb and a writing verb. The
   * writing verb's placeholder word and required flags are parameters, so a second surface built
   * from different tables can carry its own words.
   */
  function toySurface(locked: string[], takeLabel = '<key…>', required: readonly string[] = []) {
    return pluginBase().verbSurface({
      name: 'toy',
      head: 'usage: toy <verb> [options]',
      blurb: ['the toy pool: one file per project.'],
      flags: {
        id: { long: '--id', kind: 'value' },
        brief: { long: '--brief', kind: 'flag' },
        limit: { long: '--limit', short: '-n', kind: 'int' },
      },
      specs: {
        show: { options: ['brief', 'limit'], positional: { min: 0, max: 0 } },
        take: { options: ['id'], required, positional: { min: 1, max: Number.POSITIVE_INFINITY, label: takeLabel } },
      },
      aliases: { old_show: 'show' },
      runners: {
        show: (parsed) => `show ${JSON.stringify(parsed.options)}`,
        take: (parsed) => `take ${parsed.positional.join(',')}`,
      },
      writingVerbs: ['take'],
      withWrite: (_ctx, body) => {
        locked.push('take');
        return body();
      },
    });
  }

  it('a line is parsed by the one parser: short fold, closed checks, and a refusal that carries code 2 and the usage head', async () => {
    const locked: string[] = [];
    const surface = toySurface(locked);
    expect(await surface.main(['show', '-n', '5'], {})).toBe('show {"limit":5}');
    expect(await surface.main(['old_show'], {})).toBe('show {}'); // an alias is the same verb
    const refusal: unknown = await surface.main(['show', '--wat'], {}).catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(surface.UsageError);
    expect((refusal as { code: number }).code).toBe(2);
    expect((refusal as Error).message).toContain('usage: toy <verb> [options]');
    expect((refusal as Error).message).toContain('unrecognized argument: --wat');
    expect(locked).toEqual([]); // a refused line never reaches a verb, writing or not
  });

  it('a writing verb goes through the record\u2019s own lock entry; a reading verb does not', async () => {
    const locked: string[] = [];
    const surface = toySurface(locked);
    expect(await surface.main(['take', 'a', 'b'], {})).toBe('take a,b');
    expect(await surface.main(['show'], {})).toBe('show {}');
    expect(locked).toEqual(['take']);
  });

  it('a required flag the line left out is a code 2 refusal, decided before the writing lock is taken', async () => {
    const locked: string[] = [];
    const surface = toySurface(locked, '<key…>', ['id']);
    const refusal: unknown = await surface.main(['take', 'a'], {}).catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(surface.UsageError);
    expect((refusal as { code: number }).code).toBe(2);
    expect((refusal as Error).message).toContain('argument --id: is required (run `toy help`)');
    expect(locked).toEqual([]); // a refused line never takes the write lock
    // Given, the same line runs and takes the lock like any writing line.
    expect(await surface.main(['take', 'a', '--id', 'x'], {})).toBe('take a');
    expect(locked).toEqual(['take']);
  });

  it('the usage page is rendered from the same tables, with the alias named on its row', () => {
    const locked: string[] = [];
    const surface = toySurface(locked);
    const page = String(surface.usage());
    expect(page).toContain('usage: toy <verb> [options]');
    expect(page).toContain('the toy pool: one file per project.');
    expect(page).toContain('show [--brief] [-n|--limit <n>]');
    expect(page).toContain('take <key…> [--id <value>]');
    expect(page).toContain('(also answers as `old_show`)');
    // The placeholder word is the table's own spelling: this layer spells none of its own.
    expect(page).not.toContain('<id');
  });

  it('a second surface renders the placeholder word its own table spells, not this layer\u2019s', () => {
    const locked: string[] = [];
    const page = String(toySurface(locked, '<file…>').usage());
    expect(page).toContain('take <file…> [--id <value>]');
    expect(page).not.toContain('<key');
  });

  it('a verb that takes positional arguments but names no placeholder word is an assembly mistake', () => {
    expect(() =>
      pluginBase().verbSurface({
        name: 'toy',
        head: 'usage: toy <verb> [options]',
        flags: {},
        specs: { take: { options: [], positional: { min: 1, max: 1 } } },
        runners: { take: () => undefined },
      }),
    ).toThrow(TypeError);
  });

  it('naming writing verbs without a lock entry is an assembly mistake, refused when the surface is built', () => {
    const base = pluginBase();
    expect(() =>
      base.verbSurface({
        name: 'toy',
        head: 'usage: toy <verb> [options]',
        flags: {},
        specs: { take: { options: [], positional: { min: 1, max: 1, label: '<key>' } } },
        runners: { take: () => undefined },
        writingVerbs: ['take'],
      }),
    ).toThrow(TypeError);
  });

  it('not declaring `contextOf` hands each verb the context the caller named, cell for cell', async () => {
    // The default is the caller's own context object — not a copy, not a rewritten root. A word that
    // names no other project must see exactly what it was handed, so a runner can compare identity.
    const seen: unknown[] = [];
    const surface = pluginBase().verbSurface({
      name: 'toy',
      head: 'usage: toy <verb> [options]',
      flags: { id: { long: '--id', kind: 'value' } },
      specs: {
        show: { options: [], positional: { min: 0, max: 0 } },
        take: { options: ['id'], positional: { min: 1, max: 1, label: '<key>' } },
      },
      runners: {
        show: (_parsed, ctx) => {
          seen.push(ctx);
          return 'show';
        },
        take: (_parsed, ctx) => {
          seen.push(ctx);
          return 'take';
        },
      },
      writingVerbs: ['take'],
      withWrite: (ctx, body) => {
        seen.push(ctx);
        return body();
      },
    });
    const handed = { root: join(root, 'somewhere') };
    await surface.main(['show'], handed);
    await surface.main(['take', 'a'], handed);
    // The reading verb and the writing verb see the same context, and the writing verb's lock entry
    // sees it too: nothing rewrote the root on the way.
    expect(seen).toEqual([handed, handed, handed]);
    for (const value of seen) expect(value).toBe(handed);
  });

  it('not declaring `emptyArgv` makes the empty line a help request: the page, as a success, no refusal', async () => {
    // The default reading of "no verb named" is the usage page answered as a success. A word that
    // reads the empty line as a refused line declares `emptyArgv: 'refuse'`; without that cell the
    // seam answers exactly what `help` answers, and nothing carries code 2.
    let ran = 0;
    const surface = pluginBase().verbSurface({
      name: 'toy',
      head: 'usage: toy <verb> [options]',
      blurb: ['the toy pool: one file per project.'],
      flags: {},
      specs: { show: { options: [], positional: { min: 0, max: 0 } } },
      runners: {
        show: () => {
          ran += 1;
          return 'show';
        },
      },
    });
    const page = String(surface.usage());
    const empty = await surface.main([], {});
    expect(empty).toBe(page);
    // The same page `help` answers, and no verb ran: an empty line is not a refused line here.
    expect(String(await surface.main(['help'], {}))).toBe(page);
    expect(ran).toBe(0);
  });

  it('`emptyArgv: \'refuse\'` answers the page minus its trailing blank lines, whatever line ending the page uses', async () => {
    // The refusal's sentence is the help page with its tail taken off. A word that declares a CRLF
    // `eol` must not be left with a stray `\r` at the end of that sentence: the sentence would then
    // not be the page minus its blank lines, which is the only thing the cell promises.
    const surface = pluginBase().verbSurface({
      name: 'toy',
      head: 'usage: toy <verb> [options]',
      blurb: ['the toy pool.'],
      eol: '\r\n',
      refusalHead: false,
      emptyArgv: 'refuse',
      flags: {},
      specs: { show: { options: [], positional: { min: 0, max: 0 } } },
      runners: { show: () => 'show' },
    });
    const page = String(surface.usage());
    expect(page.endsWith('\r\n')).toBe(true);
    const refusal: unknown = await surface.main([], {}).catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(surface.UsageError);
    expect((refusal as { code: number }).code).toBe(2);
    const sentence = (refusal as Error).message;
    // The page, its trailing blank lines gone — and no trailing line break of either spelling left.
    expect(sentence).toBe(page.replace(/(?:\r?\n)+$/u, ''));
    expect(sentence.endsWith('\r')).toBe(false);
    expect(sentence.endsWith('\n')).toBe(false);
  });

  it('a word that declares no `eol` answers in the platform line ending: its page and its refusal lead are the base\u2019s `EOL`', async () => {
    // The seam's default line ending is the platform's — what a word whose text a person reads on
    // this machine follows — and `base.EOL` is where this platform is read into. Spelling the whole
    // document against it is the reading the `toContain` assertions above cannot make: a default of
    // a literal `'\n'` would leave this page and every refusal's head-and-blank-line joined with LF
    // on a machine whose text is CRLF, and each single-line `toContain` would keep passing.
    const platformEol = pluginBase().EOL;
    const surface = pluginBase().verbSurface({
      name: 'toy',
      head: 'usage: toy <verb> [options]',
      flags: {},
      specs: { show: { options: [], positional: { min: 0, max: 0 } } },
      runners: { show: () => 'show' },
    });
    const page = String(surface.usage());
    expect(page).toBe(['usage: toy <verb> [options]', '', '  show', ''].join(platformEol));
    // A refusal with the head on (the default): the head, a blank line, the sentence — all three
    // separated by that same ending.
    const refusal: unknown = await surface.main(['show', '--wat'], {}).catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(surface.UsageError);
    expect((refusal as { code: number }).code).toBe(2);
    expect((refusal as Error).message).toBe(
      `usage: toy <verb> [options]${platformEol}${platformEol}`
        + 'unrecognized argument: --wat (run `toy help` for the flags this verb takes)',
    );
  });

  it('a word that declares a line ending of its own keeps the refusal head, joined in that ending and not the platform\u2019s', async () => {
    // The other branch of the refusal spelling: a word whose text product is not the platform's
    // declares one, and the head stays on (`refusalHead` left at its default). The two branches only
    // differ when the declared ending is not the platform's, so the case declares the ending this
    // machine does not use — LF where the text here is CRLF, and the other way round — which is also
    // the real shape (the instruction account's answers are LF on every platform).
    const platformEol = pluginBase().EOL;
    const declaredEol = platformEol === '\r\n' ? '\n' : '\r\n';
    const surface = pluginBase().verbSurface({
      name: 'toy',
      head: 'usage: toy <verb> [options]',
      flags: {},
      specs: { show: { options: [], positional: { min: 0, max: 0 } } },
      runners: { show: () => 'show' },
      eol: declaredEol,
    });
    const page = String(surface.usage());
    expect(page).toBe(['usage: toy <verb> [options]', '', '  show', ''].join(declaredEol));
    // The refusal's sentence carries the head in front of it, and the blank line between them is the
    // declared ending too — not the one the refusal class would spell on its own.
    const refusal: unknown = await surface.main(['show', '--wat'], {}).catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(surface.UsageError);
    expect((refusal as { code: number }).code).toBe(2);
    expect((refusal as Error).message).toBe(
      `usage: toy <verb> [options]${declaredEol}${declaredEol}`
        + 'unrecognized argument: --wat (run `toy help` for the flags this verb takes)',
    );
  });

  it('a `lineChecks` entry runs after parsing and before the lock; a writing verb without one is left to its runner', async () => {
    // The hook is where a word settles what the whole line must carry, at the moment this layer took
    // the writing verb's lock over: still outside the lock, so a refusal it makes leaves the lock's
    // own directory — and every record file behind it — uncreated.
    const order: string[] = [];
    const surface = pluginBase().verbSurface({
      name: 'toy',
      head: 'usage: toy <verb> [options]',
      flags: { id: { long: '--id', kind: 'value' } },
      specs: {
        take: { options: ['id'], positional: { min: 1, max: 1, label: '<key>' } },
        drop: { options: [], positional: { min: 1, max: 1, label: '<key>' } },
      },
      runners: {
        take: (parsed) => {
          order.push('runner:take');
          return `take ${parsed.positional.join(',')}`;
        },
        drop: (parsed) => {
          order.push('runner:drop');
          return `drop ${parsed.positional.join(',')}`;
        },
      },
      lineChecks: {
        take: (parsed) => {
          order.push('check:take');
          if (parsed.positional[0] === 'empty') throw new Error('nothing to take');
        },
      },
      writingVerbs: ['take', 'drop'],
      withWrite: (_ctx, body) => {
        order.push('lock');
        return body();
      },
    });
    // A line the check refuses never reaches the lock or the runner.
    const refusal: unknown = await surface.main(['take', 'empty'], {}).catch((error: unknown) => error);
    expect((refusal as Error).message).toBe('nothing to take');
    expect(order).toEqual(['check:take']);
    // A line the check passes runs its runner under the lock, in that order.
    expect(await surface.main(['take', 'a'], {})).toBe('take a');
    expect(order).toEqual(['check:take', 'check:take', 'lock', 'runner:take']);
    // A writing verb with no check entry takes the lock and runs, exactly as before the hook existed.
    expect(await surface.main(['drop', 'b'], {})).toBe('drop b');
    expect(order.slice(4)).toEqual(['lock', 'runner:drop']);
  });
});

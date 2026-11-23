import { EOL } from '../jsonio.ts';

/**
 * The one copy of a plugin command surface's **mechanics**: split a line into flags and positional
 * arguments (long and short spellings, attached values, closed sets, `--`), check the positional
 * count, render the usage page from the same tables, fold old verb spellings, answer the help
 * requests, and route the writing verbs through the record's own lock. The **words** — which flags
 * and verbs exist, what each verb does, which lock is the record's own — stay with the plugin that
 * owns the record; the plugin hands its tables to `createVerbSurface` and runs the surface's `main`
 * as its command entry point.
 *
 * A refusal about how the line was written (an unknown verb, a flag the verb does not take, the
 * wrong positional count, a required flag the line left out, a value outside a closed set) is a
 * `UsageError`: it carries `code: 2` —
 * the same code the core's own parser answers a refused line with — and answers with the usage
 * page. Any other failure is about the record rather than the line and carries no code.
 */

/** The kinds one flag can take: a switch (`flag`), one value, one integer, or a list of values. */
export type VerbFlagKind = 'flag' | 'value' | 'int' | 'list';

/** One flag cell: long spelling, optional short spelling, how it takes a value, and the closed set of values. */
export interface VerbFlagCell {
  readonly long: string;
  readonly short?: string;
  readonly kind: VerbFlagKind;
  readonly choices?: readonly string[];
}

/** The positional shape of one verb: how many arguments it takes, and which option carries them in its own rows. */
export interface VerbPositional {
  readonly min: number;
  readonly max: number;
  /** The option whose rows carry the positional arguments themselves (`--from-file`); a line taking it needs none. */
  readonly suppliedBy?: string;
  /**
   * The placeholder word this verb's usage row spells for its positional arguments. It is the
   * plugin's own word — this layer carries none of its own — and a verb that takes positional
   * arguments without one is an assembly mistake.
   */
  readonly label?: string;
}

/** One verb's option table: which flags it knows, which of them the line must give, and its positional shape. */
export interface VerbSpec {
  readonly options: readonly string[];
  /** The flags the verb cannot run without: a line that leaves one out is refused at parse time, before any verb — writing or not — runs. */
  readonly required?: readonly string[];
  readonly positional: VerbPositional;
}

/** One parsed line: the flags it named and the positional arguments left over. */
export interface ParsedVerbArgs {
  readonly options: Record<string, unknown>;
  readonly positional: string[];
}

/** One verb's runner: the parsed line and the plugin context the host handed in. */
export type VerbRunner<C> = (parsed: ParsedVerbArgs, ctx: C) => unknown | Promise<unknown>;

/**
 * The plugin's own half of a command surface: its word, its usage head, its flags, verbs, aliases
 * and runners, and — for the verbs that write the record — its own lock entry (which lock file is
 * the record's own is the record owner's knowledge, not this layer's).
 */
export interface VerbSurfaceTables<C> {
  /** The command word (`issue`): it names the help request inside refusal sentences. */
  readonly name: string;
  /** The head of the usage page (`usage: issue <verb> [options]`), and of every usage error's sentence. */
  readonly head: string;
  /** The flags the surface knows, keyed by their plain name. */
  readonly flags: Readonly<Record<string, VerbFlagCell>>;
  /** One entry per verb: its flags and its positional shape. The usage page is rendered from this table. */
  readonly specs: Readonly<Record<string, VerbSpec>>;
  /** Old spellings that route to their canonical verb (`by_module` → `by-module`); the help page names them on the row they route to. */
  readonly aliases?: Readonly<Record<string, string>>;
  /** One runner per verb. */
  readonly runners: Readonly<Record<string, VerbRunner<C>>>;
  /** The verbs whose "read → change → write" runs exclusively; each goes through `withWrite`. */
  readonly writingVerbs?: readonly string[];
  /** The record's own lock, held through one writing verb's run; required when `writingVerbs` is given. */
  readonly withWrite?: (ctx: C, body: () => Promise<unknown>) => Promise<unknown>;
  /** The lines between the head and the verb rows on the usage page (what the record is and where it lives). */
  readonly blurb?: readonly string[];
  /**
   * The checks one writing verb's line passes on its own content, run after the line is parsed and
   * **before** that verb's lock is taken. They are the plugin's own reading of what a whole line
   * must carry (an `add` that names no sentence); a check throws whatever the word answers that
   * with. Nothing is read from or written to the record before them, so a line they refuse leaves
   * no trace on disk — the lock's directory included — which is how a refusal read before this
   * layer held the lock and the write together. The ordering is a gap the instruction migration
   * exposed: a refused writing verb that reached the lock would leave `.superworker/meta/` behind
   * (the lock's taking creates it), and that directory alone flips an unmigrated workspace's
   * `migrate` from `ready` to `both-present`. Keyed by verb: a writing verb with no entry is
   * left to its runner, inside the lock, exactly as before.
   */
  readonly lineChecks?: Readonly<Record<string, (parsed: ParsedVerbArgs, ctx: C) => void>>;
  /**
   * The context one parsed line runs under. The default is the one the caller handed in. A word
   * whose line can name another project rewrites it here — after the line is parsed and **before**
   * the writing lock is taken, so the lock lands on the record this line acts on rather than on the
   * one its caller happened to stand in. A `--project` rewrite left to the runner is the gap the
   * instruction migration exposed: the lock would land on the caller's own tree while the write
   * lands on the named one.
   */
  readonly contextOf?: (parsed: ParsedVerbArgs, ctx: C) => C;
  /**
   * The line ending of this word's text product — its usage page and the sentences it answers. The
   * default is the platform's (`jsonio.ts`), which is what a word whose text a person reads on this
   * machine follows; a word whose answers were LF on every platform before this layer took them over
   * declares `'\n'` here instead. This cell came out of the instruction migration: that word's page
   * and answers are LF on every platform, and the platform default would have bent them CRLF on
   * Windows.
   */
  readonly eol?: string;
  /**
   * Whether a refusal puts the usage head in front of its sentence (`<head>`, a blank line, the
   * sentence) — the default, and what a word whose refusals have always read that way answers.
   * `false` leaves the sentence standing alone: `new UsageError(sentence).message` is the sentence,
   * and the whole page when the sentence is the page. Both are defensible readings; the word that
   * owns the refusals declares which. Another instruction-migration gap: that word's refusals are
   * the bare sentence, and the head-first default would have prefixed a usage head they never
   * carried.
   */
  readonly refusalHead?: boolean;
  /**
   * What a line that names no verb at all means for this word. `help` (the default) answers the
   * usage page as a success; `refuse` is a usage refusal — `code: 2`, the page as its sentence —
   * which is what a word whose caller reads "no verb named" as a refused line answers. The two are
   * both defensible readings of the same empty line, so the word that owns it declares which. Also
   * a gap the instruction migration exposed: an empty line is a `code: 2` refusal in that word,
   * where the default answers the same line with the usage page as a success.
   */
  readonly emptyArgv?: 'help' | 'refuse';
}

/** A refusal about how the line was written, not about what the record holds: `code = 2`, answered with the usage page. */
export class UsageError extends Error {
  /** The one code the plugin-command seam carries for a refused line; every other failure carries none. */
  readonly code = 2;

  constructor(head: string, sentence: string) {
    super(`${head}${EOL}${EOL}${sentence}`);
    this.name = 'UsageError';
  }
}

/** The assembled surface: the entry point a plugin's `main` forwards to, the usage page, the refusal class, and the parser. */
export interface VerbSurface<C> {
  /** The command's entry point: the first entry of argv is the verb (a `keep_name: false` declaration has the host take the word off). */
  main(argv: readonly string[], ctx: C): Promise<unknown>;
  /** The usage page: the verbs and their flags, derived from the one table, with old spellings named on the row they route to. */
  usage(): string;
  /** The refusal class of this surface's word, already carrying its usage head: `new UsageError(sentence)` is a refusal about the line, `code: 2`. */
  readonly UsageError: new (sentence: string) => UsageError;
  /** Split one line's rest into flags and positionals; a token the verb does not know is refused on the spot. */
  parseArgs(argv: readonly string[], spec: VerbSpec): ParsedVerbArgs;
}

/**
 * Assemble one plugin command surface from its own tables: the parsing, the usage rendering, the
 * help handling and the writing-verb locking are this layer's one copy; the tables are the
 * plugin's own words. `writingVerbs` without `withWrite` is an assembly mistake and is refused
 * here — a writing verb that could not take its lock would be a silent writer.
 */
export function createVerbSurface<C>(tables: VerbSurfaceTables<C>): VerbSurface<C> {
  const flags = tables.flags;
  const aliases = tables.aliases ?? {};
  if ((tables.writingVerbs?.length ?? 0) > 0 && typeof tables.withWrite !== 'function') {
    throw new TypeError(
      `the command surface of ${JSON.stringify(tables.name)} names writing verbs but hands in no withWrite`,
    );
  }
  const writingVerbs = new Set<string>(tables.writingVerbs ?? []);
  // The word's own text product: the line ending its page and its refusals use (the platform's by
  // default), and whether a refusal leads with the usage head (it does by default).
  const eol = tables.eol ?? EOL;
  const refusalHead = tables.refusalHead ?? true;
  // A usage row with no placeholder word would misinform: a verb that takes positional arguments
  // must have its table spell its own word.
  for (const [word, spec] of Object.entries(tables.specs)) {
    if (spec.positional.min > 0 && spec.positional.label === undefined) {
      throw new TypeError(
        `the command surface of ${JSON.stringify(tables.name)}: ${JSON.stringify(word)} takes positional arguments but names no placeholder word`,
      );
    }
  }

  /** This surface's refusal: the usage head is the surface's own, the caller spells only the sentence. */
  class SurfaceUsageError extends UsageError {
    constructor(sentence: string) {
      super(tables.head, sentence);
      // The one spelling of this word's refusal sentence: the seam's default is the head, a blank
      // line and the sentence; a word that declares `refusalHead: false` answers the sentence alone.
      if (!refusalHead) this.message = sentence;
      else if (eol !== EOL) this.message = `${tables.head}${eol}${eol}${sentence}`;
    }
  }

  const usageErrorOf = (sentence: string): UsageError => new SurfaceUsageError(sentence);

  /** Short spellings are folded into long ones first (`-v` -> `--verbose`, `-n5` -> `--limit=5`). */
  function normalizeShortFlags(argv: readonly string[], spec: VerbSpec): string[] {
    const shorts = new Map<string, VerbFlagCell>();
    const takingValue: VerbFlagCell[] = [];
    for (const key of spec.options) {
      const cell = flags[key];
      if (cell.short === undefined) continue;
      shorts.set(cell.short, cell);
      if (cell.kind !== 'flag') takingValue.push(cell);
    }
    const out: string[] = [];
    let positionalOnly = false;
    for (let index = 0; index < argv.length; index += 1) {
      const token = argv[index]!;
      if (token === '--') {
        positionalOnly = true;
        out.push(token);
        continue;
      }
      if (positionalOnly) {
        out.push(token);
        continue;
      }
      const exact = shorts.get(token);
      if (exact !== undefined) {
        // When the previous token is a short spelling taking a value, this one is that value and is
        // not folded as a flag (the -t in `-n -t`).
        const previous = index > 0 ? shorts.get(argv[index - 1]!) : undefined;
        out.push(previous !== undefined && previous.kind !== 'flag' ? token : exact.long);
        continue;
      }
      const attached = attachedShortValue(token, takingValue);
      if (attached !== null) {
        out.push(attached);
        continue;
      }
      out.push(token);
    }
    return out;
  }

  /** The fold of the attached form: `-n5` / `-n=5` -> `--limit=5` (the value is carried over as it is). */
  function attachedShortValue(token: string, takingValue: readonly VerbFlagCell[]): string | null {
    for (const cell of takingValue) {
      if (cell.short === undefined || !token.startsWith(cell.short)) continue;
      const rest = token.slice(cell.short.length);
      if (rest === '') continue;
      const value = rest.startsWith('=') ? rest.slice(1) : rest;
      return `${cell.long}=${value}`;
    }
    return null;
  }

  /** Whether this token counts as a flag (a negative number like `-1` is a value, not a flag). */
  function looksLikeFlag(token: string): boolean {
    return token.startsWith('-') && token.length > 1 && !/^-\d/.test(token);
  }

  /** Which known flag this token lands on; `null` when it is none. */
  function flagNameOf(token: string, spec: VerbSpec): string | null {
    if (!token.startsWith('--')) return null;
    const name = token.includes('=') ? token.slice(0, token.indexOf('=')) : token;
    for (const key of spec.options) {
      if (flags[key]!.long === name) return key;
    }
    return null;
  }

  function inlineValueOf(token: string): string | undefined {
    const at = token.indexOf('=');
    return at < 0 ? undefined : token.slice(at + 1);
  }

  function positionalWanted(spec: VerbSpec): string {
    if (spec.positional.max === Number.POSITIVE_INFINITY) return `at least ${spec.positional.min}`;
    if (spec.positional.min === spec.positional.max) return `${spec.positional.min}`;
    return `${spec.positional.min} to ${spec.positional.max}`;
  }

  function parseArgs(argv: readonly string[], spec: VerbSpec): ParsedVerbArgs {
    const options: Record<string, unknown> = {};
    const positional: string[] = [];
    for (let index = 0; index < argv.length; index += 1) {
      const token = argv[index]!;
      if (token === '--') {
        positional.push(...argv.slice(index + 1));
        break;
      }
      const name = flagNameOf(token, spec);
      if (name === null) {
        if (looksLikeFlag(token)) {
          throw usageErrorOf(
            `unrecognized argument: ${token} (run \`${tables.name} help\` for the flags this verb takes)`,
          );
        }
        positional.push(token);
        continue;
      }
      const cell = flags[name]!;
      const inline = inlineValueOf(token);
      if (cell.kind === 'flag') {
        if (inline !== undefined) throw usageErrorOf(`argument ${cell.long}: takes no value`);
        options[name] = true;
        continue;
      }
      if (cell.kind === 'list') {
        const values: string[] = [];
        if (inline !== undefined) values.push(inline);
        else {
          while (index + 1 < argv.length && !looksLikeFlag(argv[index + 1]!)) {
            values.push(argv[(index += 1)]!);
          }
        }
        options[name] = values;
        continue;
      }
      let raw = inline;
      if (raw === undefined) {
        index += 1;
        raw = argv[index];
      }
      if (raw === undefined) throw usageErrorOf(`argument ${cell.long}: expected one value`);
      if (cell.kind === 'int') {
        if (!/^[+-]?\d+$/.test(raw)) {
          throw usageErrorOf(`argument ${cell.long}: invalid int value: '${raw}'`);
        }
        options[name] = Number(raw);
        continue;
      }
      if (cell.choices !== undefined && !cell.choices.includes(raw)) {
        throw usageErrorOf(`invalid ${name} "${raw}", valid: ${[...cell.choices].sort().join(', ')}`);
      }
      options[name] = raw;
    }
    const count = positional.length;
    // An option that carries the positionals in its own rows (a batch file names its ids) answers the
    // minimum positional count for the whole line.
    const minimum = spec.positional.suppliedBy !== undefined && options[spec.positional.suppliedBy] !== undefined
      ? 0
      : spec.positional.min;
    if (count < minimum || count > spec.positional.max) {
      throw usageErrorOf(
        `this verb wants ${positionalWanted(spec)} positional argument(s), got ${count} (run \`${tables.name} help\`)`,
      );
    }
    // A flag the verb requires and the line left out is the same kind of refusal, decided on the
    // parsed line itself: no verb — writing or not — sees it.
    for (const key of spec.required ?? []) {
      if (options[key] === undefined) {
        throw usageErrorOf(`argument ${flags[key]!.long}: is required (run \`${tables.name} help\`)`);
      }
    }
    return { options, positional };
  }

  /** The usage spelling of one flag (help and parsing use the same table). */
  function flagUsage(key: string): string {
    const cell = flags[key]!;
    const short = cell.short === undefined ? '' : `${cell.short}|`;
    const tail = cell.kind === 'flag' ? '' : cell.kind === 'int' ? ' <n>' : ' <value>';
    return `[${short}${cell.long}${tail}]`;
  }

  function usage(): string {
    const rows = Object.keys(tables.specs).map((word) => {
      const spec = tables.specs[word]!;
      const positional = spec.positional.min === 0 ? '' : ` ${spec.positional.label!}`;
      const flagCells = spec.options.map(flagUsage).join(' ');
      const alias = Object.keys(aliases).find((spoken) => aliases[spoken] === word);
      return `  ${word}${positional}${flagCells.length > 0 ? ` ${flagCells}` : ''}`
        + `${alias === undefined ? '' : `   (also answers as \`${alias}\`)`}`;
    });
    const lines: string[] = [tables.head, ''];
    if (tables.blurb !== undefined && tables.blurb.length > 0) lines.push(...tables.blurb, '');
    lines.push(...rows, '');
    return lines.join(eol);
  }

  async function main(argv: readonly string[], ctx: C): Promise<unknown> {
    const args = [...argv];
    if (args.length === 0) {
      // "No verb named" is the word's own reading of the empty line: a help request (the page, as a
      // success) or a refused line (the page as the refusal's sentence, code 2). The sentence is the
      // page minus its trailing blank lines, whatever line ending those blank lines are spelled in
      // (`\r\n` too, not only `\n`), so the refusal really is the page with its tail taken off.
      if (tables.emptyArgv === 'refuse') throw usageErrorOf(usage().replace(/(?:\r?\n)+$/u, ''));
      return usage();
    }
    const spoken = args[0]!;
    if (spoken === 'help' || spoken === '--help' || spoken === '-h') return usage();
    // An old spelling is the same verb: the canonical name is what the tables and the help page are
    // keyed by, so the rest of this function never hears the alias.
    const word = aliases[spoken] ?? spoken;
    const runner = tables.runners[word];
    if (runner === undefined) {
      throw usageErrorOf(`unrecognized command "${spoken}" (run \`${tables.name} help\`)`);
    }
    // A trailing help flag is the help request: the last cell is exactly `--help` or `-h`, with something before it.
    if (args.length > 1 && (args[args.length - 1] === '--help' || args[args.length - 1] === '-h')) {
      return usage();
    }
    const spec = tables.specs[word]!;
    const parsed = parseArgs(normalizeShortFlags(args.slice(1), spec), spec);
    // A word whose line can name another project rewrites the context here — after the line is
    // parsed, before the lock is taken — so the write and its lock land on the record this line acts on.
    const target = tables.contextOf === undefined ? ctx : tables.contextOf(parsed, ctx);
    if (writingVerbs.has(word)) {
      // What the line itself must carry is decided here, still outside the lock: a refused line
      // reaches no record, so it cannot bring the lock's own directory into being on its way.
      tables.lineChecks?.[word]?.(parsed, target);
      return tables.withWrite!(target, async () => runner(parsed, target));
    }
    return runner(parsed, target);
  }

  return { main, usage, UsageError: SurfaceUsageError, parseArgs };
}

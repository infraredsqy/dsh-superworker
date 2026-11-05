/**
 * The command line in front of the engine: an argv parser and the help printer, both grown from one
 * table row per word.
 *
 * The geometry: a 78-column body (the terminal width minus the two columns a printer takes off, fixed
 * here so the same line of output is the same file on any machine), the word column at two spaces, the
 * sense column at most 24, and
 * senses wrapped in what is left. The rules are written once, in `usageBlock` / `sectionBlock`, so the
 * parser's usage, the printed help and the router's words cannot come apart.
 */

/** The printed body's width: listings wrap here with no terminal to ask. */
export const WIDTH = 78;
/** The widest the sense column may open. */
export const MAX_HELP_POSITION = 24;
/** Where the word column opens. */
const MARGIN = 2;

const SECTION_TITLES = { positional: 'positional arguments:', option: 'options:' };

// ── wrapping ────────────────────────────────────────────────────────────────

/**
 * One text as the lines it prints in `width` columns: greedy, whitespace-split, and a chunk that is
 * wider than the whole column goes on a line of its own rather than being cut (the wrapper never cuts
 * a word it printed).
 */
export function wrap(text, width) {
  const words = String(text).replace(/\s+/gu, ' ').trim().split(' ').filter((word) => word !== '');
  const lines = [];
  let line = '';
  for (const word of words) {
    if (line === '') {
      line = word;
      continue;
    }
    if ([...line].length + 1 + [...word].length <= width) {
      line += ` ${word}`;
      continue;
    }
    lines.push(line);
    line = word;
  }
  if (line !== '') lines.push(line);
  return lines.length === 0 ? [''] : lines;
}

// ── the usage line ──────────────────────────────────────────────────────────

/** One option's usage spelling: its first flag and its value cell. */
function optionUsage(action) {
  const flag = action.usageFlag ?? action.flags[0];
  if (action.metavar === undefined) return flag;
  if (action.nargs === '*' || action.nargs === '+') return `${flag} ${action.metavar} [${action.metavar} ...]`;
  return `${flag} ${action.metavar}`;
}

/**
 * The pieces one command's usage line is laid out from, in the order the actions were declared. A
 * mutually exclusive cell's members stand next to each other: they print as one bracketed run with
 * ` | ` between the members and the brackets on the outsides.
 */
function usagePieces(actions) {
  const pieces = [];
  let index = 0;
  while (index < actions.length) {
    const action = actions[index];
    if (action.exclusive !== undefined) {
      const run = [];
      while (index < actions.length && actions[index].exclusive?.title === action.exclusive.title) {
        run.push(actions[index]);
        index += 1;
      }
      const texts = run.map((cell) => optionUsage(cell));
      texts[0] = `[${texts[0]}`;
      for (let at = 0; at < texts.length - 1; at += 1) texts[at] += ' |';
      texts[texts.length - 1] += ']';
      pieces.push({ positional: false, texts });
      continue;
    }
    index += 1;
    if (action.kind === 'option') {
      const body = optionUsage(action);
      pieces.push({
        positional: false,
        texts: [action.required === true ? body : `[${body}]`],
      });
      continue;
    }
    if (action.kind === 'subparsers') {
      pieces.push({ positional: true, texts: [`${action.metavar} ...`] });
      continue;
    }
    const meta = action.metavar;
    if (action.nargs === '*') pieces.push({ positional: true, texts: [`[${meta} ...]`] });
    else if (action.nargs === '+') pieces.push({ positional: true, texts: [`${meta} [${meta} ...]`] });
    else pieces.push({ positional: true, texts: [action.required === true ? meta : `[${meta}]`] });
  }
  return pieces;
}

/** Lay pieces out under one indent, the first line carrying `prefix` when one is given. */
function wrapPieces(pieces, indent, prefix) {
  const lines = [];
  let line = [];
  let lineLength = (prefix === undefined ? indent.length : prefix.length) - 1;
  for (const piece of pieces) {
    if (lineLength + 1 + [...piece].length > WIDTH && line.length > 0) {
      lines.push(indent + line.join(' '));
      line = [];
      lineLength = indent.length - 1;
    }
    line.push(piece);
    lineLength += [...piece].length + 1;
  }
  if (line.length > 0) lines.push(indent + line.join(' '));
  if (prefix !== undefined && lines.length > 0) lines[0] = prefix + lines[0].slice(indent.length);
  return lines;
}

/** One command's usage block, as printed (no trailing blank line). */
export function usageBlock(spec) {
  const prefix = 'usage: ';
  const all = usagePieces(spec.actions());
  const optionalPieces = all.filter((cell) => !cell.positional).flatMap((cell) => cell.texts);
  const positionalPieces = all.filter((cell) => cell.positional).flatMap((cell) => cell.texts);
  const flat = [spec.prog, ...optionalPieces, ...positionalPieces].join(' ');
  if ([...prefix].length + [...flat].length <= WIDTH) return `${prefix}${flat}`;
  const indent = ' '.repeat(prefix.length + spec.prog.length + 1);
  const lines = wrapPieces([spec.prog, ...optionalPieces], indent, prefix);
  lines.push(...wrapPieces(positionalPieces, indent));
  return lines.join('\n');
}

// ── the sections ────────────────────────────────────────────────────────────

/** The invocation printed in the word column: flags, then the metavar, as the listing spells it. */
export function invocationOf(action) {
  if (action.kind === 'positional') return action.metavar;
  if (action.kind === 'exclusive') return action.actions.map(invocationOf).join(' | ');
  const flags = action.flags.join(', ');
  if (action.metavar === undefined) return flags;
  // A repeated option prints its value cell twice: `--status {a} [{a} ...]`.
  if (action.nargs === '*' || action.nargs === '+') {
    return `${flags} ${action.metavar} [${action.metavar} ...]`;
  }
  return `${flags} ${action.metavar}`;
}

/**
 * One section: the word column and the sense column, one row per action; a sense that does not fit the
 * row wraps under itself. `senseColumn` is fixed for the whole section so every row lines up.
 */
/**
 * One section: the word column and the sense column, one row per action; a sense that does not fit the
 * row wraps under itself. `senseColumn` is fixed for the whole section so every row lines up, and a
 * nested row (a group's verbs) opens two columns further in.
 */
function sectionBlock(title, rows, senseColumn) {
  const width = Math.max(WIDTH - senseColumn, 11);
  const lines = [title];
  for (const row of rows) {
    const indent = row.indent ?? MARGIN;
    const actionWidth = senseColumn - indent - 2;
    const invocation = row.invocation;
    const sense = row.sense ?? '';
    if (sense === '') {
      lines.push(`${' '.repeat(indent)}${invocation}`);
      continue;
    }
    const wrapped = wrap(sense, width);
    if ([...invocation].length <= actionWidth) {
      lines.push(
        `${' '.repeat(indent)}${invocation}${' '.repeat(actionWidth - [...invocation].length)}  ${wrapped[0]}`,
      );
      for (const line of wrapped.slice(1)) lines.push(' '.repeat(senseColumn) + line);
    } else {
      lines.push(`${' '.repeat(indent)}${invocation}`);
      for (const line of wrapped) lines.push(' '.repeat(senseColumn) + line);
    }
  }
  return lines;
}

/** The sense column of one section: the widest word of that section, under the printer's ceiling. */
function senseColumnOf(rows) {
  let widest = 0;
  for (const row of rows) widest = Math.max(widest, [...row.invocation].length + (row.indent ?? MARGIN));
  return Math.min(widest + 2, MAX_HELP_POSITION);
}

/** One command's full help text, as printed. */
export function helpText(spec) {
  const blocks = [usageBlock(spec)];
  if (typeof spec.description === 'string' && spec.description !== '') blocks.push(spec.description);

  const positionalRows = [];
  const widest = [];
  for (const action of spec.actions()) {
    if (action.kind === 'positional') {
      positionalRows.push({ invocation: action.metavar, sense: action.help, indent: MARGIN });
      widest.push({ invocation: action.metavar, indent: MARGIN });
    }
    if (action.kind === 'subparsers') {
      positionalRows.push({ invocation: action.metavar, sense: '', indent: MARGIN });
      widest.push({ invocation: action.metavar, indent: MARGIN });
      for (const command of action.commands) {
        positionalRows.push({ invocation: command.word, sense: command.help, indent: MARGIN + 2 });
        widest.push({ invocation: command.word, indent: MARGIN + 2 });
      }
    }
  }
  const optionRows = spec
    .actions()
    .filter((action) => action.kind === 'option')
    .map((action) => ({ invocation: invocationOf(action), sense: action.help, indent: MARGIN }));
  for (const row of optionRows) widest.push(row);

  // One column for both sections: the widest word in the whole parser, so a command's two listings
  // line up under one sense column.
  const column = senseColumnOf(widest);
  if (positionalRows.length > 0) {
    blocks.push(sectionBlock(SECTION_TITLES.positional, positionalRows, column).join('\n'));
  }
  if (optionRows.length > 0) {
    blocks.push(sectionBlock(SECTION_TITLES.option, optionRows, column).join('\n'));
  }
  if (typeof spec.epilog === 'string' && spec.epilog !== '') blocks.push(spec.epilog);
  return `${blocks.join('\n\n')}\n`;
}

// ── parsing ─────────────────────────────────────────────────────────────────

const LONG_FLAG = /^--[^=]+/u;

/** One option's value cell: how many words it takes and whether they are a closed list. */
function valueCells(option) {
  if (option.nargs === '*' || option.nargs === '+') return null;
  return 1;
}

/** The destination name an option / positional writes to. */
export function destOf(flags) {
  const long = flags.find((flag) => flag.startsWith('--'));
  const name = (long ?? flags[0]).replace(/^--?/u, '');
  return name.replace(/-/gu, '_');
}

/**
 * Parse one command line against one table row.
 *
 * Returns `{ help: true }` for a help word, `{ error }` for a line the row refuses, and `{ values,
 * positionals }` otherwise. Options are matched by their flags; a value-taking option takes the next
 * word (or the text after `=`); a subparser group takes its verb from the first positional word.
 */
export function parse(spec, argv) {
  const actions = spec.actions();
  const byFlag = new Map();
  const byWord = new Map();
  for (const action of actions) {
    if (action.kind === 'option') for (const flag of action.flags) byFlag.set(flag, action);
    if (action.kind === 'exclusive') for (const option of action.actions) for (const flag of option.flags) byFlag.set(flag, { ...option, exclusive: action });
  }
  const subparsers = actions.find((action) => action.kind === 'subparsers');
  if (subparsers !== undefined) for (const command of subparsers.commands) byWord.set(command.word, command);

  const values = {};
  const positionalWords = [];
  const seenExclusive = new Map();
  let i = 0;
  let help = false;
  while (i < argv.length) {
    const word = argv[i];
    if (word === '--') {
      positionalWords.push(...argv.slice(i + 1));
      break;
    }
    const flagMatch = LONG_FLAG.exec(word);
    if (LONG_FLAG.test(word) || (/^-[A-Za-z]/u.test(word) && !/^-\d/u.test(word))) {
      const flag = flagMatch === null ? word : flagMatch[0];
      const inline = word.includes('=') ? word.slice(word.indexOf('=') + 1) : undefined;
      const action = byFlag.get(flag);
      if (action === undefined) return { error: `unrecognized arguments: ${word}` };
      if (action.kind === 'help' || action.flags.includes('-h') || action.flags.includes('--help')) {
        help = true;
        i += 1;
        continue;
      }
      const dest = action.dest ?? destOf(action.flags);
      if (action.exclusive !== undefined) {
        const other = seenExclusive.get(action.exclusive.title);
        if (other !== undefined && other !== flag) {
          return { error: `argument ${flag}: not allowed with argument ${other}` };
        }
        seenExclusive.set(action.exclusive.title, flag);
      }
      const cells = valueCells(action);
      if (cells === null) {
        const collected = [];
        let j = i + 1;
        while (j < argv.length && !argv[j].startsWith('-')) {
          collected.push(argv[j]);
          j += 1;
        }
        values[dest] = collected;
        i = j;
        continue;
      }
      if (action.metavar === undefined) {
        values[dest] = true;
        i += 1;
        continue;
      }
      const raw = inline ?? argv[i + 1];
      if (raw === undefined) return { error: `argument ${flag}: expected one argument` };
      if (action.choices !== undefined && !action.choices.includes(raw)) {
        return {
          error: `argument ${flag}: invalid choice: '${raw}' (choose from ${action.choices.map((c) => `'${c}'`).join(', ')})`,
        };
      }
      values[dest] = raw;
      i += inline === undefined ? 2 : 1;
      continue;
    }
    positionalWords.push(word);
    i += 1;
  }

  const positionals = [];
  let wordAt = 0;
  const positionSpecs = actions.filter((action) => action.kind === 'positional');
  for (const action of positionSpecs) {
    if (action.nargs === '*' || action.nargs === '+') {
      const collected = positionalWords.slice(wordAt);
      wordAt = positionalWords.length;
      positionals.push(collected);
      continue;
    }
    const word = positionalWords[wordAt];
    wordAt += 1;
    positionals.push(word === undefined ? [] : [word]);
  }
  // A subparser group takes the words the positionals did not: the verb, then the rest of the line.
  if (subparsers !== undefined) {
    const rest = positionalWords.slice(wordAt);
    const verb = rest[0];
    if (verb === undefined) {
      return {
        error: `the following arguments are required: ${subparsers.cellName}`,
      };
    }
    const command = byWord.get(verb);
    if (command === undefined) {
      return {
        error: `argument ${subparsers.dest ?? subparsers.cellName}: invalid choice: '${verb}' (choose from ${[...byWord.keys()].map((w) => `'${w}'`).join(', ')})`,
      };
    }
    return { ...parse(command, rest.slice(1)), verb, subcommand: command };
  }

  if (help) return { help: true, values };
  for (const [index, action] of positionSpecs.entries()) {
    const words = positionals[index] ?? [];
    if (action.required === true && words.length === 0) {
      return { error: `the following arguments are required: ${action.metavar}` };
    }
    if (action.choices !== undefined) {
      for (const word of words) {
        if (!action.choices.includes(word)) {
          return {
            error: `argument ${action.dest ?? action.metavar}: invalid choice: '${word}' (choose from ${action.choices.map((c) => `'${c}'`).join(', ')})`,
          };
        }
      }
    }
  }
  const requiredOptions = actions.filter((action) => action.kind === 'option' && action.required === true);
  for (const option of requiredOptions) {
    const dest = option.dest ?? destOf(option.flags);
    if (values[dest] === undefined) {
      return { error: `the following arguments are required: ${option.flags.join('/')}` };
    }
  }
  const extras = positionalWords.slice(wordAt);
  if (extras.length > 0 && positionSpecs.every((action) => action.nargs !== '*' && action.nargs !== '+')) {
    return { error: `unrecognized arguments: ${extras.join(' ')}` };
  }
  for (const option of actions) {
    if (option.kind !== 'option' || option.choices === undefined) continue;
    const dest = option.dest ?? destOf(option.flags);
    const given = values[dest];
    if (typeof given === 'string' && !option.choices.includes(given)) {
      return {
        error: `argument ${option.flags[0]}: invalid choice: '${given}' (choose from ${option.choices.map((c) => `'${c}'`).join(', ')})`,
      };
    }
  }
  return { values, positionals };
}

/** The usage error a refused line prints, with the program's own name. */
export function usageError(spec, message) {
  return `${usageBlock(spec)}\n${spec.prog}: error: ${message}\n`;
}
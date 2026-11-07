/**
 * The bridge between the command table (`table.ts`, one row per word) and the printer / parser
 * (`argparse.ts`). It turns a row into the action list both read, so nothing has to be restated: the
 * usage line, the two section listings, the defaults and the routing all come off the same row.
 *
 * The help word is the row's own `-h, --help` entry for a leaf; a group's row does not carry it
 * (the group's listing prints it as its only option), so it is added here.
 */
import { COMMAND_ROWS, GROUP_ROWS } from './table';
import type { SpecAction, WordRow, WordSpec } from './types';

/** The help cell every command carries, spelled as the leaf listings spell it. */
const HELP_OPTION = {
  flags: ['-h', '--help'],
  help: 'show this help message and exit',
  kind: 'help',
};

/** One table row's options, with `next`'s own help cell kept as its row carries it. */
function optionsOf(row: WordRow): SpecAction[] {
  const options: SpecAction[] = [];
  for (const [index, cell] of (row.options ?? []).entries()) {
    const option: SpecAction & { flags: readonly string[]; help: string } = {
      kind: 'option',
      isHelp: cell.flags.some((flag) => flag === '--help'),
      flags: cell.flags,
      help: cell.help ?? '',
      ...(cell.dest === undefined ? {} : { dest: cell.dest }),
      ...(cell.metavar === undefined ? {} : { metavar: cell.metavar }),
      ...(cell.nargs === undefined ? {} : { nargs: cell.nargs }),
      ...(cell.required === true ? { required: true } : {}),
      ...(cell.choices === undefined ? {} : { choices: cell.choices }),
      // A repeated option's usage prints the metavar twice; the first flag is the one it names.
      usageFlag: cell.flags[0],
    };
    if (index === 0) option.help = cell.help ?? HELP_OPTION.help;
    options.push(option);
  }
  if (options.length === 0) options.push({ ...HELP_OPTION, kind: 'option', isHelp: true });
  // The exclusive cells named by the usage line: an option is in one, and the group is what the
  // parser refuses a second member of.
  for (const group of row.exclusive ?? []) {
    const title = group.join('|');
    let position = 0;
    for (const option of options) {
      if (!option.flags!.some((flag) => group.includes(flag))) continue;
      // The members stand next to each other in the row's own order: a usage line prints them as one
      // bracketed run with ` | ` between, and the listing prints each one on its own row.
      (option as { exclusive?: SpecAction['exclusive'] }).exclusive = { title, position };
      position += 1;
    }
  }
  return options;
}

/**
 * The settings verbs whose one positional is the knob name. The list a settings verb accepts is read
 * at run time, out of the settings table in force — the core settings plus whatever an installed
 * plugin declares — so a table built with a plugin installed must not be printed in a project without it.
 */
const CONFIG_KEY_WORDS = new Set(['config get', 'config set', 'config unset']);

/**
 * One row as the printer / parser spec. `knobs` is the settings list in force for this call — handed
 * in with it, never kept here: the same row printed from another project must answer another page.
 */
export function specOf(row: WordRow, knobs?: readonly string[]): WordSpec {
  const actions: SpecAction[] = [];
  actions.push(...optionsOf(row));
  const key = row.group === undefined ? row.word : `${row.group} ${row.word}`;
  for (const [index, cell] of (row.positionals ?? []).entries()) {
    // The settings verbs' knob cell is read at run time: the metavar, the listing and the refusal all
    // come off the same list, so the help cannot offer a name the engine would refuse.
    const knobCell = index === 0 && knobs !== undefined && knobs.length > 0 && CONFIG_KEY_WORDS.has(key);
    const metavar = knobCell ? `{${knobs!.join(',')}}` : cell.metavar;
    actions.push({
      kind: 'positional',
      name: knobCell ? metavar : cell.name,
      // The name a refusal prints is the cell's own `dest`, or its name when the row states nothing
      // further: a cell whose name spells its choices still answers with the role it stands for.
      dest: knobCell ? 'key' : (cell.dest ?? cell.name),
      metavar,
      required: cell.required === true,
      ...(cell.nargs === undefined ? {} : { nargs: cell.nargs }),
      ...(knobCell || cell.choices === undefined ? {} : { choices: cell.choices }),
      ...(knobCell ? { choices: knobs! } : {}),
      ...(cell.help === undefined ? {} : { help: cell.help }),
    });
  }
  if ((row.commands ?? []).length > 0) {
    const metavar = row.metavar ?? `{${row.commands!.map((command) => command.word).join(',')}}`;
    actions.push({
      kind: 'subparsers',
      metavar,
      cellName: metavar.replace(/^<|>$/gu, ''),
      dest: row.dest ?? metavar.replace(/^<|>$/gu, ''),
      commands: row.commands!.map((command) => ({
        ...specOf(command, knobs),
        word: command.word,
        help: command.help ?? command.summary ?? '',
      })),
    });
  }
  const ordered = actions;
  return {
    word: row.word,
    group: row.group,
    prog: row.prog,
    description: row.description ?? undefined,
    epilog: row.epilog ?? undefined,
    // The usage line prints a group's own options and, last, its subparser metavar.
    actions: () => ordered,
  };
}

/** A leaf word's row (a group's verb is looked up as `"<group> <verb>"`). */
export function rowFor(word: string): WordRow | undefined {
  return COMMAND_ROWS[word];
}

/** A group's row. */
export function groupFor(word: string): WordRow | undefined {
  return GROUP_ROWS[word];
}

/** The two tables, as the transport and the tests read them: every leaf row, and every group. */
export { COMMAND_ROWS as COMMANDS, GROUP_ROWS as GROUPS };

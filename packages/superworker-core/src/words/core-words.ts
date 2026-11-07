import { TOP } from './table';

/**
 * The words the core answers itself, worked out from the one word table instead of copied: the verbs
 * and group names the table's top carries, the two words about this process (`doctor`, `version`),
 * and the help word.
 *
 * A second copy of this list is how a plugin word the core really answers — `plan`, `cycle` — stayed in
 * the routing table while the router's own table answered it first: the word was swallowed in silence,
 * and doctor never reported the clash. One reader, one answer.
 *
 * Only the table's top is read here, never a single row: a row carries prose (descriptions, help), and
 * the host build inlines this layer into its own product — the words of the set are wanted, the prose
 * of four hundred rows is not.
 */

/** The words about this checkout itself, as the listing prints them: word, its `--help` form, one line of sense. */
export const CORE_SELF_VERBS: ReadonlyArray<readonly [string, string, string]> = [
  ['doctor', 'doctor [--fix]', 'read the health of this checkout and this project'],
  ['version', 'version', 'print the version and where this checkout lives'],
];

/** The words this layer answers before it consults any table: the listing and the two help flags. */
export const CORE_HELP_WORDS: readonly string[] = ['-h', '--help', 'help'];

/** The words the core answers itself: the table's verbs and groups, the two words about this process, and the help word. */
export const CORE_COMMAND_WORDS: ReadonlySet<string> = new Set([
  ...TOP.verbs,
  ...TOP.groups,
  ...CORE_SELF_VERBS.map(([word]) => word),
  'help',
]);

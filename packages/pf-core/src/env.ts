import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * The seven runtime environment switches, in the one place that reads them.
 *
 * A switch is read **on every call**, never cached at import time: a sandbox that moves the
 * machine layer or the plugin folder between two calls is answered on the second call. The
 * precedence is the same for all of them — an explicit option handed in on the call wins, the
 * environment variable sits underneath it, and the built-in default underneath both — so a test
 * that shuts one of them into a temporary directory never has the environment run over it, and a
 * process that states nothing behaves exactly as it did before these switches were read here.
 *
 * The six names and what each one moves:
 *
 * - `PF_HOME_DIR` — the machine layer's home: `<home>/.pf/config.json`, and nothing else.
 * - `PF_PLUGINS_DIR` — the folder one plugin per sub-folder is read from; whitespace is cut off,
 *   a value opening with `~` is expanded to this machine's home (`~` alone is the home itself),
 *   and an empty value means the default `<root>/plugins`.
 * - `DSH_CONDUCT_SPAWNER` — which spawner opens the next session: a bare word (`dsh` / `zcode`)
 *   or a path. A per-call name wins over it, and a line's own `spawner` policy wins over both.
 * - `DSH_CONDUCT_SPAWN_DRY_RUN` — the drill switch: anything but `''`, `0`, `false`, `False` is on.
 * - `DSH_CONDUCT_MODEL` — the model route this machine hands the sessions it opens (`provider/model`);
 *   a per-call name wins over it, and a line's own `model` policy wins over both.
 * - `DSH_SESSION_ID` — the session id of this process itself: a node registered here notes the
 *   conversation it was born in under that id.
 * - `ZCODE_DATA_BASE_DIR` — the ZCode host's data root; `.zcode` hangs under it, and the path is
 *   only handed out when the spawner that opens the session is the ZCode one.
 */

const PF_HOME_DIR = 'PF_HOME_DIR';
const PF_PLUGINS_DIR = 'PF_PLUGINS_DIR';
const DSH_CONDUCT_SPAWNER = 'DSH_CONDUCT_SPAWNER';
const DSH_CONDUCT_SPAWN_DRY_RUN = 'DSH_CONDUCT_SPAWN_DRY_RUN';
const DSH_CONDUCT_MODEL = 'DSH_CONDUCT_MODEL';
const DSH_SESSION_ID = 'DSH_SESSION_ID';
const ZCODE_DATA_BASE_DIR = 'ZCODE_DATA_BASE_DIR';

/** The words the drill switch reads as off; every other value (including none at all) is its own word. */
const DRY_RUN_OFF = ['', '0', 'false', 'False'];

/** One switch as a trimmed non-empty string; an absent or blank value is `undefined` (the default speaks instead). */
function switched(name: string): string | undefined {
  const raw = process.env[name];
  if (raw === undefined) return undefined;
  const text = raw.trim();
  return text === '' ? undefined : text;
}

/**
 * A path-shaped value with a leading `~` opened up: a bare `~` is this machine's home, and `~/x` is
 * `x` under it. A `~` opening a longer word (`~user`) is left as written — this engine resolves no
 * other user's home, and a path that only looks like one must not be guessed at.
 */
function expandHome(value: string): string {
  if (value === '~') return homedir();
  if (value.startsWith('~/')) return join(homedir(), value.slice(2));
  return value;
}

/** `PF_HOME_DIR`: the machine layer's home, or `undefined` when the switch names none. */
export function envHomeDir(): string | undefined {
  return switched(PF_HOME_DIR);
}

/** `PF_PLUGINS_DIR`: the plugin folder, or `undefined` when the switch names none; a `~` at its head is expanded. */
export function envPluginsDir(): string | undefined {
  const stated = switched(PF_PLUGINS_DIR);
  return stated === undefined ? undefined : expandHome(stated);
}

/** `DSH_CONDUCT_SPAWNER`: the spawner named for this machine (a word or a path), or `undefined`. */
export function envSpawner(): string | undefined {
  return switched(DSH_CONDUCT_SPAWNER);
}

/** `DSH_CONDUCT_SPAWN_DRY_RUN`: whether this dispatch is a drill (the switch's own truthiness rule). */
export function envSpawnDryRun(): boolean {
  const raw = process.env[DSH_CONDUCT_SPAWN_DRY_RUN];
  return raw !== undefined && !DRY_RUN_OFF.includes(raw);
}

/**
 * `DSH_CONDUCT_MODEL`: the model route this machine's sessions open with, or `undefined`.
 *
 * The value is carried as one word in the ecosystem's own spelling, `provider/model`; this layer
 * neither splits it nor knows providers — whoever opens the session does.
 */
export function envModel(): string | undefined {
  return switched(DSH_CONDUCT_MODEL);
}

/** `DSH_SESSION_ID`: the session id of this process itself, or `undefined` when nothing names one. */
export function envSessionId(): string | undefined {
  return switched(DSH_SESSION_ID);
}

/** `ZCODE_DATA_BASE_DIR`: the ZCode host's data root (`.zcode` under it), this machine's home by default. */
export function zcodeDataDir(): string {
  return join(switched(ZCODE_DATA_BASE_DIR) ?? homedir(), '.zcode');
}

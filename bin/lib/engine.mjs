/**
 * The engine handle, the working project, the plugin folder the engine scans, the two outward seams
 * this process owns (git and the executor), and the words for a refusal.
 *
 * The engine is reached through its package export only: `open` from `pf-core`, whose product is the
 * frozen interface (`packages/pf-core/docs/api.md`). Nothing here imports the engine's source, and a
 * runtime installed outside the repository reads that same export out of the copy shipped beside
 * `bin/` (`packages/pf-core/dist/`) rather than out of a checkout it does not have.
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
/** This checkout's root: `bin/lib/` sits two levels under it. */
export const REPO_ROOT = resolve(HERE, '..', '..');
/** This checkout's binary directory. */
export const BIN_DIR = join(REPO_ROOT, 'bin');

/**
 * The engine's product as this tree ships it: `bin/` and `packages/pf-core/dist/` sit side by side
 * in the artifact, so a runtime installed outside the repository carries the engine in its own
 * directory and reaches it by this path, not through some `node_modules` it does not have.
 */
export const ENGINE_PRODUCT = join(REPO_ROOT, 'packages', 'pf-core', 'dist', 'index.mjs');

/**
 * The plugins this tree ships, by the same "beside `bin/`" shape as the engine's product: the
 * artifact carries `packages/pf-core/plugins/` next to `packages/pf-core/dist/`, so one path finds
 * them in the checkout and in an installed runtime alike.
 */
export const BUNDLED_PLUGINS = join(REPO_ROOT, 'packages', 'pf-core', 'plugins');

/**
 * The plugin folder the engine scans for this command, in one line of precedence: the user's
 * `PF_PLUGINS_DIR` when it names one, else the plugins this runtime bundles. The bundled set is what
 * keeps `pf issue …` and the two closing guards (`issue_pool_weight_limit`, `test_seconds_limit`)
 * answering in any project. The engine's own default (`<project root>/plugins`) is therefore not
 * reachable through this command: a project's own `plugins/` folder is not consulted here.
 */
function useBundledPlugins() {
  const stated = process.env.PF_PLUGINS_DIR;
  // An empty value is the engine's own "switch names none", so it falls through to the bundled set.
  if (stated !== undefined && stated.trim() !== '') return;
  process.env.PF_PLUGINS_DIR = BUNDLED_PLUGINS;
}

useBundledPlugins();

/**
 * The engine's product file this process would load: the package name where it resolves (the
 * checkout, `node_modules/pf-core` linked at the workspace package), else the copy shipped beside
 * `bin/` (everything an install unpacks). `null` when neither is there.
 */
export function engineProductPath() {
  try {
    return fileURLToPath(import.meta.resolve('pf-core'));
  } catch {
    return existsSync(ENGINE_PRODUCT) ? ENGINE_PRODUCT : null;
  }
}

/**
 * The engine module itself, by the same two routes. Only a name that resolves nowhere falls through
 * to the shipped copy: an engine that is found and fails to load keeps its own error.
 */
async function loadEngine() {
  try {
    return await import('pf-core');
  } catch (error) {
    const shipped = engineProductPath();
    if (error?.code !== 'ERR_MODULE_NOT_FOUND' || shipped === null) throw error;
    return await import(pathToFileURL(shipped).href);
  }
}

const engine = await loadEngine();

/** This tree's own version number, read off the package manifest it ships. */
export function version() {
  const manifest = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'));
  return String(manifest.version ?? '0.0.0');
}

/** One `git <args>` in a directory: the exit code is an answer, not an exception. */
export const gitRunner = {
  run(cwd, args) {
    return new Promise((settle) => {
      const child = spawn('git', [...args], { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk) => {
        stdout += chunk;
      });
      child.stderr.on('data', (chunk) => {
        stderr += chunk;
      });
      child.on('error', (error) => {
        settle({ code: 127, stdout, stderr: `${stderr}${error.message}` });
      });
      child.on('close', (code) => {
        settle({ code: code ?? 1, stdout, stderr });
      });
    });
  },
};

/**
 * Whether this process can open a session at all: true exactly under the drill switch, the one
 * condition under which `executor()` hands the engine a simulated opener. With the switch off a
 * command-line process has no opener — opening a node's session is the panel's work — and the verbs
 * read this before the engine gets a chance to land a `started` claim nobody can honour.
 */
export function sessionOpenerAvailable() {
  return drillOn();
}

/** The drill switch, read the way the engine reads it: on unless the value is one of the four off spellings, and absent reads as off. */
function drillOn() {
  return !['', '0', 'false', 'False'].includes(process.env.DSH_CONDUCT_SPAWN_DRY_RUN ?? '');
}

/**
 * The session opener this process hands the engine.
 *
 * Opening a node's session is the execution seam (`Executor`); the engine never opens one itself.
 * With the drill switch on (`DSH_CONDUCT_SPAWN_DRY_RUN`, the same one the engine reads), a simulated
 * session is opened: the call is made in full and reported, and nothing is started. With it off this
 * checkout has no opener to hand over yet — that is the pipeline host's half — so the call refuses
 * out loud instead of pretending a session exists.
 */
export function executor() {
  if (sessionOpenerAvailable()) return new engine.SimulatedExecutor();
  return {
    async dispatch() {
      throw new Error(
        'no session opener is wired into this checkout: opening a node\'s session is the pipeline ' +
          'host\'s half, handed in through the engine\'s executor seam. Set DSH_CONDUCT_SPAWN_DRY_RUN=1 ' +
          'to rehearse the call without opening one.',
      );
    },
  };
}

/**
 * The project root a command acts on: the directory named, else the current directory — as it is, with
 * one exception. Inside a linked worktree the ledger is not the worktree's own copy: in parallel mode a
 * node's code work goes into the main tree's `.pf/worktrees/<short id>`, and that checkout holds a copy
 * of `.pf/` as of the fork, so a recording command that accepted it would settle on a stale snapshot.
 * A worktree root is recognised by its `.git` being a **file** pointing at `<main>/.git/worktrees/<name>`;
 * that pointer leads back to the main tree, and only when the main tree really has a `.pf/`. Everything
 * else — a subdirectory, a submodule (its `.git` file points at `.git/modules/…`), a directory that is
 * no project at all — is answered as the directory it is. Nothing climbs to a repository root: the
 * engine itself refuses a folder with no `.pf` of its own rather than trying one above it.
 */
export function projectRoot(named) {
  const start = named === undefined || named === '' ? process.cwd() : resolve(named);
  return mainTreeOf(start) ?? start;
}

/** The main tree a linked worktree's checkout root points back at, or `null` when this is no worktree root. */
function mainTreeOf(start) {
  let firstLine;
  try {
    const dotGit = join(start, '.git');
    if (!statSync(dotGit).isFile()) return null;
    firstLine = readFileSync(dotGit, 'utf8').split('\n')[0].trim();
  } catch {
    return null;
  }
  if (!firstLine.startsWith('gitdir:')) return null;
  const target = firstLine.slice('gitdir:'.length).trim();
  if (target === '') return null;
  const gitdir = resolve(start, target);
  // `<main>/.git/worktrees/<name>` and nothing else: a submodule's `gitdir:` does not name a worktree.
  if (basename(dirname(gitdir)) !== 'worktrees') return null;
  const main = resolve(gitdir, '..', '..', '..');
  try {
    if (!statSync(join(main, '.pf')).isDirectory()) return null;
  } catch {
    return null;
  }
  return main;
}

/** The setting names the settings verbs accept here: the engine's own list plus every installed plugin's knobs. */
export async function configKeys() {
  const pf = await handleOf(projectRoot(undefined));
  return pf.config.keys();
}

/** The engine handle of one project. */
export async function handleOf(root) {
  return engine.open(root, { executor: executor(), ...homeDirOption() });
}

/** The machine-layer home, when this process was told where it is (`PF_HOME_DIR` is the engine's own switch). */
function homeDirOption() {
  const home = process.env.PF_HOME_DIR;
  return home === undefined || home === '' ? {} : { homeDir: resolve(home) };
}

/** The exact words of one refusal: the engine's own sentence when it carries one. */
export function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}

/** Whether an engine refusal carries one of its decidable codes. */
export function codeOf(error) {
  return error !== null && typeof error === 'object' && typeof error.code === 'string' ? error.code : null;
}
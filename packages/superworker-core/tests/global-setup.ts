import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RUNTIME_SWITCHES } from '../src/env.ts';
import { hashDirectory } from './helpers/hash-dir.ts';

/**
 * The runtime switches the engine reads, taken from the engine's own table (`src/env.ts`) rather
 * than copied here: a switch added to that table is shut by this setup without another edit, and
 * one that only exists in this file would be a name the engine never reads.
 *
 * The suite shuts them before any worker starts: a suite whose result depends on what the machine
 * happened to export is not hermetic, and these five move the machine layer's home, the plugin folder,
 * the session id, the drill switch and the model route — exactly the things the cases in this suite
 * shut into temp dirs themselves. Each case that means to read one of them exports it for its own
 * stretch again.
 */

/**
 * The global guard for the whole suite: shut the machine layer into a fresh temporary sandbox, then
 * record the hash of the repo root `.superworker` before the run, recompute it at teardown and compare.
 *
 * - The machine layer (`SUPERWORKER_HOME_DIR`) is a **sandbox created here**, not merely cleared: with the
 *   switch absent the layer is the real `~/.superworker/config.json`, and one case that reads a stored knob
 *   there would make the suite answer to the machine it runs on (a machine-wide setting is the kind
 *   that bites). An empty sandbox reads exactly like a machine that stores nothing, which is what
 *   every case here assumes. It goes away again at teardown.
 * - `SUPERWORKER_PLUGINS_DIR` is cleared and **not** pointed anywhere: the four plugins the repo carries
 *   (`plugins/`) travel with the tree and are what the plugin and doctor cases stand on, so hiding
 *   them would take those cases' premise away. A case that needs the switch sets it itself and puts
 *   it back.
 * - The hash runs on the guard's face (`skipLiveFaces` in `helpers/hash-dir.ts`): the covered set is
 *   the record tree's stable remainder — the seed files `init` lays into a checkout, and every byte
 *   that is not one of the faces a running line writes in ordinary work. This repo's own record is a
 *   live one: a parallel cycle of the pipeline that drives it has its sessions writing records for
 *   the whole suite window (`nodes/`, `signals/`, the record files, the record repo), and hashing
 *   those would fail the suite on another cell's ordinary work. What the face still catches is
 *   exactly what this suite can do wrong: landing anything new in the record tree, or touching the
 *   seed. Engine operations belong in temp dirs; the seed is where that shows first.
 */
export default function globalSetup(): () => void {
  const saved = new Map<string, string | undefined>();
  for (const name of RUNTIME_SWITCHES) {
    saved.set(name, process.env[name]);
    delete process.env[name];
  }
  const homeSandbox = mkdtempSync(join(tmpdir(), 'superworker-suite-home-'));
  process.env.SUPERWORKER_HOME_DIR = homeSandbox;
  const recordDir = fileURLToPath(new URL('../../../.superworker', import.meta.url));
  const before = hashDirectory(recordDir, { skipLiveFaces: true });
  return () => {
    try {
      rmSync(homeSandbox, { recursive: true, force: true, maxRetries: 3 });
    } catch {
      // A sandbox that cannot be removed is litter under the system temp, not a suite failure: the
      // run is over and nothing reads it again.
    }
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    const after = hashDirectory(recordDir, { skipLiveFaces: true });
    if (after !== before) {
      throw new Error(
        `the repo root .superworker's stable face differs before and after the whole suite: before=${before} after=${after}. ` +
          'Engine operations belong in temp dirs; nothing the suite ran may land on the record tree or its seed.',
      );
    }
  };
}

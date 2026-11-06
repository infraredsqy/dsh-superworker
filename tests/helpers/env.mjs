/* The one way the host-side tests pin the machine's two home switches, their values put back when
 * the case (or the file) is done. A test may not read the developer's own home: the engine's global
 * settings layer and the DSH skill root both live under it.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** Both names the host half and the engine read a home from. */
export const HOME_SWITCHES = ['PF_HOME_DIR', 'DSH_HOME']

/**
 * Point the home switches at `home` for the caller's stretch; `restore` puts every value the
 * machine had back. This is the half a case uses when it already made the directory itself (a case
 * that reads the same path from its own reading), `pinHome` is the half that makes one.
 */
export function pinTo(home, names = HOME_SWITCHES) {
  const previous = new Map(names.map((name) => [name, process.env[name]]))
  for (const name of names) process.env[name] = home
  return () => {
    for (const name of names) {
      const held = previous.get(name)
      if (held === undefined) delete process.env[name]
      else process.env[name] = held
    }
  }
}

/**
 * Point the home switches at a fresh temporary directory for the caller's stretch.
 *
 * `names` is which switches to pin — the machine layer's (`PF_HOME_DIR`), the DSH skill root's
 * (`DSH_HOME`), or both. Every value the machine had is handed back by `restore`, which also takes
 * the temporary home away: a file registers it with `test.after`, a case calls it in `finally`.
 */
export function pinHome(names = HOME_SWITCHES, prefix = 'pf-home-') {
  const home = mkdtempSync(join(tmpdir(), prefix))
  const unpin = pinTo(home, names)
  const restore = () => {
    unpin()
    rmSync(home, { recursive: true, force: true })
  }
  return { home, restore }
}

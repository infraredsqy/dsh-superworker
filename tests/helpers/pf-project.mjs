/* A throwaway pf project on real disk, and the two readings the write-plane cases take from one:
 * its root (closed again when the case is done) and its settings file as it sits there.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { open } from 'pf-core'

/** A throwaway project: `.pf` laid down by the engine itself, closed again when the case is done. */
export async function project(prefix = 'pf-project-') {
  const root = mkdtempSync(join(tmpdir(), prefix))
  await open(root).ledger.init()
  return {
    root,
    done() {
      rmSync(root, { recursive: true, force: true })
    },
  }
}

/** The project settings file as it sits on disk; `init` lays an empty object and writes add to it. */
export function configOnDisk(root) {
  return JSON.parse(readFileSync(join(root, '.pf', 'config.json'), 'utf8'))
}

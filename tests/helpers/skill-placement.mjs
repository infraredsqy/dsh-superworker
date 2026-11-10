/* One placement record in a pinned DSH home, and the taking of it back.
 *
 * This is the shape the skills step writes when the line loads, and it is also the precondition of
 * the opener's session-side catalog read: with nothing placed, that read answers "nothing to check"
 * without asking the catalog at all. Two files need the shape — the opener's diagnostic cases, and
 * the relay's case that holds an open in flight past its mint — so it lives here once.
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** One placement record plus the file it names, written under `home`; the path of that copy comes back. */
export function placeOneSkill(home, name) {
  const root = join(home, 'skills')
  const ours = join(root, name, 'SKILL.md')
  mkdirSync(join(root, name), { recursive: true })
  writeFileSync(ours, `---\nname: ${name}\ndescription: placed by the plugin\n---\n\n# ${name}\n`, 'utf8')
  mkdirSync(join(home, 'superworker'), { recursive: true })
  writeFileSync(
    join(home, 'superworker', 'skills.json'),
    JSON.stringify({ version: 1, root, skills: [{ name, dir: name, files: [`${name}/SKILL.md`] }] }),
    'utf8',
  )
  return ours
}

/** Take the placement back off the home, so the next case starts with this line having placed nothing. */
export function clearPlacement(home) {
  rmSync(join(home, 'superworker'), { recursive: true, force: true })
  rmSync(join(home, 'skills'), { recursive: true, force: true })
}

/**
 * Where the skills layer points: the DSH home, the skill root, the placement record, and the plugin
 * folder this package ships.
 *
 * A leaf on purpose — node's `path`, `os` and `url` and nothing else. Four modules need one of these
 * paths (the dispatch relay, the write surface, the agent-facing tool, the opener), and a path is not
 * a reason to drag the filesystem, the plugin scan and the placement logic into a caller that only
 * wanted to name a directory.
 */
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** The language a method is placed in when this half cannot learn the reader's: the shipped tables' own. */
export const DEFAULT_LANGUAGE = 'zh'

/** The provider's own rank for `<dshHome>/skills` (`USER_DSH_RANK` in `dsh-skill-filesystem`). */
export const SKILL_ROOT_RANK = 400
/** The provider's own rank for `<agentsHome>/skills`, where the old hand-copied copies sit. */
export const OLD_COPIES_RANK = 500

/** The variable under which a deployment pins its DSH home; the provider reads the same one. */
const DSH_HOME_ENV = 'DSH_HOME'
/** The DSH home's directory name under the OS home: the provider's own default. */
const DSH_HOME_DIR = '.dsh'

/** This line's own folder under the DSH home, out of the skill root's way so the provider never scans it. */
export const MANIFEST_DIR = 'pathfinder'
/** The manifest file naming every file this line placed. */
export const MANIFEST_FILE = 'skills.json'
/** The manifest format this file writes and reads; a manifest of another version is refused, not guessed at. */
export const MANIFEST_VERSION = 1

/**
 * The DSH home this host runs against: the variable a deployment pins, else `~/.dsh`.
 *
 * Exactly the resolution the filesystem provider applies to a config-less `dshHome`, so the root
 * written here is the root the provider scans — as long as no plugin config pins one. A deployment
 * that pins `dshHome` in its own plugin config is outside this half's knowledge: this file reads the
 * environment, not the provider's config, so the placement lands under a root that provider never
 * scans and no catalog shows it. The manifest's root check cannot catch that mismatch: both sides of
 * its comparison are this same computation, so it catches a record carried to another home or edited
 * by hand, and stops there. The pin is a known gap, not a refusal.
 */
export function dshHomeOf(): string {
  const configured = process.env[DSH_HOME_ENV]
  if (typeof configured === 'string' && configured.trim().length > 0) return resolve(configured.trim())
  return join(homedir(), DSH_HOME_DIR)
}

/** The skill root this line places into: the provider's `user-dsh` root, rank {@link SKILL_ROOT_RANK}. */
export function skillRootOf(dshHome: string = dshHomeOf()): string {
  return join(dshHome, 'skills')
}

/** Where the record of what this line placed lives. */
export function manifestPathOf(dshHome: string = dshHomeOf()): string {
  return join(dshHome, MANIFEST_DIR, MANIFEST_FILE)
}

/**
 * Where the plugin folders this package ships live.
 *
 * The same relative path answers in both trees: the source half walks up to the checkout, and the
 * bundled `lib/host/index.js` walks up to the installed package — `packages/pf-core/plugins/` sits at
 * the root either way. `package.json`'s `files` carries it, which is what makes the skills part of
 * the artifact rather than part of the checkout (`tests/package-surface` holds that).
 */
export function shippedPluginsDir(): string {
  return fileURLToPath(new URL(`../../packages/pf-core/plugins/`, import.meta.url))
}

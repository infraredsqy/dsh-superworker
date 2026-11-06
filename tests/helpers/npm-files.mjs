/* The npm `files` question, in one place: which paths a manifest's wildcard entries cover, and the
 * walk that answers it. Both package-surface cases (the manifest itself and the assembled release
 * tree) read this same reading, so a pattern that means one thing in npm cannot mean another here.
 */
import { readdirSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Whether npm's `files` wildcard (`**` crosses directories, `*` does not) covers a concrete path.
 */
export function covered(pattern, file) {
  const body = pattern
    .replace(/[.+^${}()|[\]\\]/gu, '\\$&')
    /* One pass, so the group a replacement inserts is not scanned again by the next rule. */
    .replace(/\*\*\/|\*/gu, (match) => (match === '**/' ? '(?:[^/]+/)*' : '[^/]*'))
  return new RegExp(`^${body}$`, 'u').test(file)
}

/** Every file under a directory, as a slash-separated path relative to it. */
export function filesUnder(dir, prefix = '') {
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`
    if (entry.isDirectory()) out.push(...filesUnder(join(dir, entry.name), rel))
    else out.push(rel)
  }
  return out
}

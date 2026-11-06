/* The workspaceFiles port stand-in the host-side tests share: directory entries inferred from a
 * filename → text dict, reads paged by line with the real port's own semantics (offset-1 slicing,
 * the eof arithmetic, the not-found code, the two refusal codes). One implementation lives here,
 * so nothing pages differently from the port.
 */
import { NOT_FOUND } from '../../src/host/records.ts'

/**
 * The error the port gives when the target does not exist. The code is the one exported by
 * records.ts — the contract lives in one place repo-wide; if anyone drifts, it snaps here.
 */
export function absentError(path) {
  const error = new Error(`no entry at ${path}`)
  error.code = NOT_FOUND
  return error
}

/** The code the port gives when a page's byte count breaches its cap. */
const PAGE_TOO_LARGE = 'workspace-file/too-large'

/** The code the port gives when the requested page line count exceeds its own tier. */
const PAGE_LIMIT_REFUSED = 'gateway/bad-request'

/** The real port's line split: a trailing `\n` terminates the last line and does not start an empty one. */
function linesOf(text) {
  return (text.endsWith('\n') ? text.slice(0, -1) : text).split('\n')
}

/**
 * One page, by the real port's paging semantics: `offset` is 1-based; a page holds
 * `min(requested ?? tier, tier)` lines; `eof` says whether the page reached the last line; an
 * explicit limit over `tier` is refused, and so is a page whose bytes breach `maxBytes` — nothing
 * is ever truncated.
 */
export function readPage(text, range = {}, { tier = 400, maxBytes = Infinity } = {}) {
  const lines = linesOf(text)
  const offset = range.offset ?? 1
  if (range.limit !== undefined && range.limit > tier) throw refused(PAGE_LIMIT_REFUSED)
  const page = lines.slice(offset - 1, offset - 1 + Math.min(range.limit ?? tier, tier))
  const bytes = page.reduce((sum, line) => sum + Buffer.byteLength(line, 'utf8'), 0) + Math.max(page.length - 1, 0)
  if (bytes > maxBytes) throw refused(PAGE_TOO_LARGE)
  return { text: page.join('\n'), lines: page.length, eof: offset - 1 + page.length >= lines.length }
}

/** The port's two refusal codes, wearing the code as their message like the real port's do. */
function refused(code) {
  const error = new Error(code)
  error.code = code
  return error
}

/**
 * The stand-in port over a filename → text dict: `list` infers the entries under a directory from
 * the file names (a name with no `/` under it is a file, one with is a directory), `read` pages by
 * line through {@link readPage}. The refusal simulation (a tier below the default, a byte cap) is
 * optional — omit it and every page passes.
 *
 * Every call is recorded on `calls` (kind, scope, path, range and the signal the caller handed
 * over), so a case that judges *which root* was asked needs no port of its own. An empty dict is the
 * bare not-found face: every directory and every file is absent, which is what the plugin cases
 * stand on.
 */
export function fakeWorkspaceFiles(files, { tier = 400, maxBytes = Infinity } = {}) {
  const calls = []
  return {
    calls,
    async list(scope, dir, signal) {
      calls.push({ kind: 'list', scope, path: dir, signal })
      const prefix = dir === '' ? '' : `${dir}/`
      const found = new Map()
      for (const path of Object.keys(files)) {
        if (!path.startsWith(prefix)) continue
        const [head, ...tail] = path.slice(prefix.length).split('/')
        if (head.length === 0) continue
        found.set(head, { name: head, type: tail.length === 0 ? 'file' : 'directory' })
      }
      if (found.size === 0) throw absentError(dir)
      return { path: dir, entries: [...found.values()], truncated: false }
    },
    async read(scope, path, range, signal) {
      calls.push({ kind: 'read', scope, path, range, signal })
      const text = files[path]
      if (text === undefined) throw absentError(path)
      return readPage(text, range, { tier, maxBytes })
    },
  }
}

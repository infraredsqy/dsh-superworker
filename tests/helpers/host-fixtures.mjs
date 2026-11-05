/* The one stand-in the host-side gateway tests share: the minimal host context the endpoints run in. */

/**
 * A minimal host context, enough for this layer: the session's header names the workspace root, and
 * no other service is exposed.
 */
export function fakeContext({ workspaceRoot = 'C:\\workspace' } = {}) {
  return {
    workspaceFiles: {},
    sessions: { get: () => ({ header: { cwd: workspaceRoot } }) },
    sandboxPolicy: { workspaceRoot },
    get: () => undefined,
  }
}
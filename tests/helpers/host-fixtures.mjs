/* The command-plane fixtures the host-side gateway tests share: the subprocess stand-in every
 * endpoint's command line is recorded on, the minimal host context the endpoints run in, and the
 * words cut from a recorded command line.
 */

/**
 * A subprocess stand-in: every spawn's spec lands on `specs`, and each run answers with the given
 * exit code and streams. It carries no `resolveExecutable`: the write path names this package's
 * own command entry, so nothing here is ever asked where the command lives.
 */
export function fakeSubprocess({ exitCode = 0, stdout = '', stderr = '' } = {}) {
  const specs = []
  return {
    specs,
    spawn(spec) {
      specs.push(spec)
      return {
        done: Promise.resolve({ exitCode }),
        collected: {
          stdout: { readFrom: () => ({ text: stdout }) },
          stderr: { readFrom: () => ({ text: stderr }) },
        },
      }
    },
  }
}

/** A minimal host context, enough for this layer: the command runs at whatever root the session header points to. */
export function fakeContext({ subprocess, workspaceRoot = 'C:\\workspace' } = {}) {
  return {
    workspaceFiles: {},
    sessions: { get: () => ({ header: { cwd: workspaceRoot } }) },
    sandboxPolicy: { workspaceRoot },
    get: (service) => (service === 'subprocess' ? subprocess : undefined),
  }
}

/** The tool's own words on a recorded argv: everything after the node and this package's entry. */
export function wordsOf(spec) {
  return spec.argv.slice(2)
}

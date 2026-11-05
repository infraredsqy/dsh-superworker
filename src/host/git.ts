/**
 * The git seam the words layer is handed.
 *
 * `init`, `register` and `doctor` read and write the repository's own config, its `info/exclude`
 * and its merge-driver entries. That is git's business, so git is the one program this half runs —
 * no shell sits in between (the arguments are handed over exactly as the word asked for them), no
 * window is shown, and every exit code comes back as an answer instead of being thrown. A project
 * that draws this panel is a git checkout already; the only case that answers "git could not be
 * run" is a machine with no git on `PATH`.
 */
import { spawn } from 'node:child_process'

/** One git answer: the exit code, and the two streams as text. */
export interface HostGitResult {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
}

/** The runner the words layer reads `init` / `register` / `doctor` through. */
export function hostGitRunner(): { run(cwd: string, args: readonly string[]): Promise<HostGitResult> } {
  return {
    run(cwd, args) {
      return new Promise((resolve) => {
        const child = spawn('git', [...args], { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
        let stdout = ''
        let stderr = ''
        child.stdout?.setEncoding('utf8')
        child.stdout?.on('data', (text: string) => {
          stdout += text
        })
        child.stderr?.setEncoding('utf8')
        child.stderr?.on('data', (text: string) => {
          stderr += text
        })
        child.on('error', (error: Error) => {
          resolve({ code: 127, stdout, stderr: `${stderr}${error.message}\n` })
        })
        child.on('close', (code: number | null) => {
          resolve({ code: code ?? 1, stdout, stderr })
        })
      })
    },
  }
}
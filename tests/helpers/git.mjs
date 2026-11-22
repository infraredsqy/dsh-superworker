/* The one git runner the fixture cases share: a real git subprocess laid into a temporary
 * directory, so a worktree case reads the `.git` pointer git itself writes instead of a stand-in
 * for it. One copy; a case needing a narrower git face layers its own lines on top of this runner.
 */
import { execFile } from 'node:child_process'

/**
 * One git line in a directory, the conventions of the engine's own fixture runner: `cwd` always
 * given, a fixed identity through the environment, a non-zero exit throws (an unbuildable fixture
 * would make the case below assert about the wrong thing).
 */
export function gitIn(cwd, ...args) {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      args,
      {
        cwd,
        encoding: 'utf8',
        windowsHide: true,
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: 'superworker test',
          GIT_AUTHOR_EMAIL: 'superworker-test@example.invalid',
          GIT_COMMITTER_NAME: 'superworker test',
          GIT_COMMITTER_EMAIL: 'superworker-test@example.invalid',
          GIT_TERMINAL_PROMPT: '0',
        },
      },
      (error, stdout, stderr) => {
        if (error === null) resolve(stdout)
        else reject(new Error(`git ${args.join(' ')} failed in ${cwd}: ${stderr || error.message}`))
      },
    )
  })
}

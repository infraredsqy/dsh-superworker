import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { cycleHoldingIds, readStateLedger } from './cycles';
import type { GitResult, GitRunner } from './git';
import {
  LAYOUT_FILE_NAMES,
  MERGE_DRIVER_NAME_FORM,
  MERGE_DRIVER_PF_FORM,
  namedDriverCommand,
  readAbsoluteForm,
  resolvesOnPath,
} from './initledger';
import type { DagNamespace } from './ledger';
import { PF_DIR_NAME, type PfPaths } from './paths';
import { readGraphSnapshot } from './graph';

/**
 * The check-up's record and git face: whether `init`'s layout is all there, whether the graph holds
 * (no cycles, no dangling references), whether the nodes a line holds are still on the graph, and
 * whether the merge driver's two keys are in this project's git config.
 *
 * This face is not part of pushing a line along, and it does not belong to the plugin platform
 * either: it reads the records and git's own config, and every cell is a reading handed back as a
 * `DoctorCheck`. The conductor only assembles the whole report and keeps the plugin face and the
 * timing gates; the criteria here are this module's own.
 */

/** One check of doctor. */
export interface DoctorCheck {
  name: string;
  ok: boolean;
  detail?: string;
}

/** The check-up report of doctor. */
export interface DoctorReport {
  ok: boolean;
  checks: DoctorCheck[];
}

/**
 * The three-cell check-up of the record face: the records are complete, no reference dangles, nothing cycles.
 *
 * A project with no `.pf/` does not count as red — a new project has not set up a record directory yet, and
 * this cell only says it should run `init` once. While the record directory is there, one missing file of
 * `init`'s layout is named (the names come from the one layout table, `LAYOUT_FILE_NAMES`, so the doctor
 * and `init` cannot disagree about what the layout is); the graph goes through the criteria of
 * `ledger.dag.validate` (cycles, dangling dependencies); and the nodes a line holds must still be on the
 * graph, with unrecognised ones named.
 */
export async function recordChecks(
  paths: PfPaths,
  dag: DagNamespace,
): Promise<DoctorCheck[]> {
  const gaps: string[] = [];
  const initialized = existsSync(paths.pfDir) && statSync(paths.pfDir).isDirectory();
  if (initialized) {
    for (const name of LAYOUT_FILE_NAMES) {
      const path = join(paths.pfDir, name);
      if (!existsSync(path) || !statSync(path).isFile()) gaps.push(`${PF_DIR_NAME}/${name} is missing`);
    }
  }

  const graph = await dag.validate();
  const snapshot = await readGraphSnapshot(paths);
  const cycles = (await readStateLedger(paths)).cycles;
  const dangling: string[] = [];
  for (const cycle of cycles) {
    // The claim is read off the one shape-tolerant reader (`cycleHoldingIds`), so a bare id string on an older
    // disc is checked against the graph like any other claim instead of passing for an empty hand.
    for (const id of cycleHoldingIds(cycle)) {
      if (!(id in snapshot.nodes)) {
        dangling.push(`cycle "${cycle.id}" holds ${id}, which is not on the graph`);
      }
    }
  }

  return [
    {
      name: 'records',
      ok: gaps.length === 0,
      detail: !initialized
        ? `there is no ${PF_DIR_NAME} here yet (a new project runs ledger.init)`
        : gaps.length === 0
          ? `the layout (${LAYOUT_FILE_NAMES.join(', ')}) is all in place`
          : gaps.join('\n'),
    },
    {
      name: 'graph',
      ok: graph.ok,
      detail: graph.ok
        ? `${graph.total} node(s), no cycles and no dangling references`
        : graph.problems.join('\n'),
    },
    {
      name: 'cycles',
      ok: dangling.length === 0,
      detail: dangling.length === 0
        ? cycles.length === 0
          ? 'no cycles yet'
          : `${cycles.length} cycle(s), every held node is on the graph`
        : dangling.join('\n'),
    },
  ];
}

/**
 * The bound on one git question the check-up asks (milliseconds).
 *
 * Reading one key of git's own config takes a few milliseconds, so the bound is never reached in
 * ordinary work: it is not a budget for a slow git, it guards against a git that never answers at all,
 * which would otherwise hold the whole check-up open. The merge-driver cell asks at most a few
 * questions, and the first question left unanswered ends the cell (red) instead of waiting again, so
 * the whole cell lands within one bound however many the git would have swallowed.
 */
export const DOCTOR_GIT_TIMEOUT_MS = 10_000;

/**
 * One question put to git with a bound on the wait: the answer, or `null` when nothing came back in time.
 *
 * The bound cancels nothing — a git is left to run to its own end, this call merely stops waiting on it,
 * which is the whole point: the check-up must be able to come back even when a git does not. The
 * milliseconds really waited are handed back so the red cell can say how long it was.
 */
function boundedGitAnswer(
  git: GitRunner,
  root: string,
  args: readonly string[],
  timeoutMs: number,
): Promise<{ readonly result: GitResult | null; readonly waitedMs: number }> {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve({ result: null, waitedMs: Date.now() - startedAt });
    }, timeoutMs);
    git.run(root, args).then(
      (result) => {
        clearTimeout(timer);
        if (settled) return;
        settled = true;
        resolve({ result, waitedMs: Date.now() - startedAt });
      },
      (error) => {
        clearTimeout(timer);
        if (settled) return;
        settled = true;
        reject(error);
      },
    );
  });
}

/**
 * The red cell of a git question that stayed unanswered within the bound: which question it was and how
 * long was waited, why that reds this cell, and what to do about it. A registration that was never read
 * is not certified as there — certifying it would tell a person to keep a line nothing has confirmed.
 */
function unansweredCell(args: readonly string[], waitedMs: number, timeoutMs: number): DoctorCheck {
  return {
    name: 'merge-driver',
    ok: false,
    detail:
      `git did not answer within ${timeoutMs} ms (waited ${waitedMs} ms) for \`git ${args.join(' ')}\`: ` +
      'the registration of the merge driver cannot be read here, and a registration that was never read ' +
      'is not certified as there, so this cell is red -- two branches that both changed a record may ' +
      'still come back as a plain git conflict; find out what git is waiting on in this project and run ' +
      'ledger.register',
  };
}

/**
 * The merge-driver cell of the check-up: git's `merge.pf.driver` is registered, and the registration
 * is one this machine can actually answer.
 *
 * - not a git checkout, or no git handed in: **not red** — a project outside git has nowhere to
 *   register a driver, and a reading that cannot be taken is never read as zero.
 * - one of the questions put to git unanswered within `timeoutMs`: **red** — the registration is not
 *   certified on a reading that never came back, and the cell names the question and the wait.
 * - `merge.pf.driver` absent: **red**, the same tier as an incomplete layout — merges of records
 *   come back as plain git conflicts until it is registered. The driver is the key git runs.
 * - `merge.pf.driver` there but `merge.pf.name` absent: **not red** — `merge.pf.name` is only the
 *   label git shows for the driver, so a merge is driven all the same; the detail still says the
 *   pair `ledger.register` writes is incomplete.
 * - registered in a command form this tree answers — `pf merge-ledger %O %A %B %P` (this tree's own
 *   router, the form an installed `pf` command writes) or `pf-merge-ledger %O %A %B %P` (this
 *   package's bin) — and that command resolves on `PATH` here: green.
 * - registered in one of those command forms, but its command does not resolve on `PATH`: **red** —
 *   the string was written where the command was installed, and nothing answers it here; every record
 *   merge comes back as a plain git conflict.
 * - registered in the absolute form (the quoted node path plus the quoted built entry), and both
 *   those paths are files here: **not red**, but said out loud — the two paths it names are here,
 *   and a moved checkout or another machine breaks it, so it should be re-registered as the command
 *   form.
 * - registered in that absolute form but pointing at paths that are not here (a moved checkout):
 *   **red**, with the re-register advice rather than "both quoted paths are here".
 * - registered as anything else — neither form: **red**, and the sentence names the value and says
 *   to re-register. Nothing this tree answers such a string, so a merge of records still comes back
 *   as a plain git conflict; certifying it would tell a person to keep a dead line.
 */
export async function mergeDriverCheck(
  root: string,
  git: GitRunner | undefined,
  timeoutMs: number,
): Promise<DoctorCheck> {
  if (git === undefined) {
    return {
      name: 'merge-driver',
      ok: true,
      detail: 'not asked: no git was handed in, so where the driver is registered cannot be read',
    };
  }
  try {
    const checkout = await boundedGitAnswer(git, root, ['rev-parse', '--git-common-dir'], timeoutMs);
    if (checkout.result === null) {
      return unansweredCell(['rev-parse', '--git-common-dir'], checkout.waitedMs, timeoutMs);
    }
    if (checkout.result.code !== 0) {
      return {
        name: 'merge-driver',
        ok: true,
        detail: 'not a git checkout: there is nowhere to register a merge driver, so nothing is missing',
      };
    }
    const nameArgs = ['config', '--local', '--get', 'merge.pf.name'] as const;
    const nameRead = await boundedGitAnswer(git, root, nameArgs, timeoutMs);
    if (nameRead.result === null) return unansweredCell(nameArgs, nameRead.waitedMs, timeoutMs);
    const driverArgs = ['config', '--local', '--get', 'merge.pf.driver'] as const;
    const driverRead = await boundedGitAnswer(git, root, driverArgs, timeoutMs);
    if (driverRead.result === null) return unansweredCell(driverArgs, driverRead.waitedMs, timeoutMs);
    /** One read key: a key git does not have is absent, not empty (git says so with its exit code and no text). */
    const readKey = (result: GitResult): string | null => {
      const value = result.stdout.trim();
      return result.code === 0 && value !== '' ? value : null;
    };
    const name = readKey(nameRead.result);
    const driver = readKey(driverRead.result);
    // git runs the driver and shows the name; a driver without its label still drives merges, so
    // only the driver key missing is the red state — the label's absence is said, not redded.
    if (driver === null) {
      const missing = name === null ? 'merge.pf.driver and merge.pf.name' : 'merge.pf.driver';
      return {
        name: 'merge-driver',
        ok: false,
        detail:
          `the merge driver is not registered (${missing} missing): two branches that ` +
          'both changed a record come back as a plain git conflict -- run ledger.register',
      };
    }
    const incompletePair =
      name === null
        ? '. The pair ledger.register writes is incomplete: merge.pf.name (the label git shows for ' +
          'the driver, not what drives a merge) is not set -- run ledger.register to write the pair'
        : '';
    // The shape alone is not the answer: the string was written where its command was on `PATH`, and
    // this machine may not have it. Ask the same reading the writer asked, over the same two command
    // forms — this package's bin, and this tree's own `pf merge-ledger` word.
    const command = namedDriverCommand(driver);
    if (command !== null) {
      const form = driver.startsWith(`${MERGE_DRIVER_PF_FORM} `) ? MERGE_DRIVER_PF_FORM : MERGE_DRIVER_NAME_FORM;
      if (resolvesOnPath(command)) {
        return {
          name: 'merge-driver',
          ok: true,
          detail: `registered in the name form (${form}), which resolves on PATH here${incompletePair}`,
        };
      }
      return {
        name: 'merge-driver',
        ok: false,
        detail:
          `registered in the name form (${form}), but ${command} ` +
          'does not resolve on PATH on this machine: nothing answers it, so a merge of records ' +
          'comes back as a plain git conflict -- put it on PATH and re-register with ledger.register',
      };
    }
    if (driver.startsWith('"')) {
      // The quoted form this package writes names two paths. Certify it only when both are here;
      // a moved checkout leaves them behind, and that is exactly the string a person is about to
      // keep because the paths were there the day the cell last looked.
      const absolute = readAbsoluteForm(driver);
      if (absolute.shaped && absolute.missing.length === 0) {
        return {
          name: 'merge-driver',
          ok: true,
          detail:
            `registered in the absolute form (${driver}): both quoted paths are here, but a moved ` +
            `checkout or another machine breaks it -- re-register as the name form ` +
            `(${MERGE_DRIVER_PF_FORM} or ${MERGE_DRIVER_NAME_FORM} on PATH)${incompletePair}`,
        };
      }
      if (absolute.shaped) {
        return {
          name: 'merge-driver',
          ok: false,
          detail:
            `registered as ${driver}: the absolute form points at ${absolute.missing.join(' and ')}, ` +
            `which ${absolute.missing.length === 1 ? 'is' : 'are'} not on this machine any more (a ` +
            'moved checkout leaves its paths behind), so nothing answers a merge of records -- ' +
            're-register it with ledger.register (the name form, ' +
            `${MERGE_DRIVER_PF_FORM} or ${MERGE_DRIVER_NAME_FORM} on PATH, survives a moved checkout)`,
        };
      }
    }
    return {
      name: 'merge-driver',
      ok: false,
      detail:
        `registered as ${driver}: that is neither the name form (${MERGE_DRIVER_PF_FORM} %O %A %B %P ` +
        `or ${MERGE_DRIVER_NAME_FORM} %O %A %B %P) nor the absolute form (this package's built entry, ` +
        'both paths quoted), so no command answers it and a merge of records comes back as a plain ' +
        'git conflict -- re-register it with ledger.register',
    };
  } catch {
    return {
      name: 'merge-driver',
      ok: true,
      detail: 'not asked: git answered nothing this time, so the registration is not judged',
    };
  }
}

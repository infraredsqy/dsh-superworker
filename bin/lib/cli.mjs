/**
 * `pf`: the transport layer's adapter in front of the engine's words layer.
 *
 * The words themselves — the table, the parser, the printer, the verbs, the routing, the help — live
 * in the engine package now, and this adapter answers them through `answer()` on this process's own
 * seams (the directory it stands in, the drill switch, git, the session opener). What stays here are
 * the three words that are answers about **this process**: the checkout's doctor, its version, and
 * the merge driver's hand-off to the engine's one process entry.
 */
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import {
  BIN_DIR,
  REPO_ROOT,
  engineProductPath,
  executor,
  gitRunner,
  handleOf,
  homeDirOption,
  messageOf,
  pfCore,
  pluginsDirOption,
  projectRoot,
  sessionOpenerAvailable,
  version,
} from './engine.mjs';

/** `pf version`: this tree's version and where it lives. */
function versionVerb() {
  return `pf ${version()} at ${BIN_DIR} (tools: ${REPO_ROOT})`;
}

/** One refusal, spelled the way every refusal on this command is spelled. */
function refuse(message, code = 1) {
  return { code, stderr: `Error: ${message}` };
}

/** `pf doctor [--fix]`: the engine's check-up, printed cell by cell. */
async function doctorVerb(rest) {
  const fix = rest.includes('--fix');
  const root = await projectRoot(undefined);
  const pf = await handleOf(root);
  try {
    const report = await pf.conductor.doctor({ git: gitRunner });
    const lines = [`pf ${version()} at ${BIN_DIR}`, `tool tree: ${REPO_ROOT}`, `project root: ${root}`];
    for (const check of report.checks) {
      const mark = check.ok ? '✓' : '✗';
      const detail = (check.detail ?? '').split('\n');
      lines.push(`  ${mark} ${check.name}${detail.length === 1 && detail[0] !== '' ? `: ${detail[0]}` : ''}`);
      if (detail.length > 1 || (detail.length === 1 && detail[0] === '')) {
        for (const line of detail) lines.push(`      ${line}`);
      }
    }
    if (fix) {
      await pf.ledger.init({ git: gitRunner });
      lines.push('  → `init` ran once to fill the layout files in (it recognizes what is already there)');
    }
    lines.push(report.ok ? 'every health check passed.' : `${report.checks.filter((check) => !check.ok).length} check(s) still red.`);
    return { stdout: lines.join('\n'), ...(report.ok ? {} : { code: 1 }) };
  } catch (error) {
    return refuse(messageOf(error), 1);
  }
}

/**
 * `pf merge-ledger`: the word walks the same table row every word does — `--help` prints the row's
 * help and a line the row refuses is a usage error — and then the argv git handed over (the bare
 * paths, flags never being part of that line) is handed to the engine's one process entry, whose
 * exit code comes back as it is.
 */
async function mergeLedgerVerb(rest) {
  const spec = pfCore.specOf(pfCore.COMMANDS['merge-ledger']);
  const parsed = pfCore.parse(spec, rest);
  if (parsed.help === true) {
    return { code: 0, stdout: pfCore.helpText(spec) };
  }
  if (parsed.error !== undefined) {
    return { code: 2, stderr: pfCore.usageError(spec, parsed.error) };
  }
  // Beside the engine's product, wherever this process found that: the checkout's node_modules or
  // the copy the artifact ships next to `bin/`.
  const product = engineProductPath();
  if (product === null) {
    process.stderr.write("pf: the engine's product is not on disk: neither node_modules/pf-core nor the copy beside bin/\n");
    return { code: 1 };
  }
  const binary = join(dirname(product), 'merge-ledger.mjs');
  const argv = (parsed.positionals ?? []).flatMap((words) => [...words]);
  return { code: await forward(binary, argv) };
}

/** Run one child with this process's own streams, and hand back its exit code. */
function forward(entry, argv) {
  return new Promise((settle) => {
    const child = spawn(process.execPath, [entry, ...argv], { stdio: 'inherit', windowsHide: true });
    child.on('error', (error) => {
      process.stderr.write(`pf: the merge driver could not start: ${error.message}\n`);
      settle(1);
    });
    child.on('close', (code) => settle(code ?? 1));
  });
}

/** The one place either stream is written. */
async function write(answer) {
  if (answer.stdout !== undefined && answer.stdout !== '') {
    process.stdout.write(answer.stdout.endsWith('\n') ? answer.stdout : `${answer.stdout}\n`);
  }
  if (answer.stderr !== undefined && answer.stderr !== '') {
    process.stderr.write(answer.stderr.endsWith('\n') ? answer.stderr : `${answer.stderr}\n`);
  }
}

/** The whole command line: argv in, exit code out. */
export async function main(argv) {
  const verb = argv[0];
  if (verb === 'version') {
    await write({ stdout: versionVerb() });
    return 0;
  }
  if (verb === 'doctor') {
    const answer = await doctorVerb(argv.slice(1));
    await write(answer);
    return answer.code ?? 0;
  }
  if (verb === 'merge-ledger') {
    const answer = await mergeLedgerVerb(argv.slice(1));
    await write(answer);
    return answer.code ?? 0;
  }
  // Everything else is the words layer's: one line in, the two streams and the exit code out.
  const answer = await pfCore.answer(argv, {
    root: process.cwd(),
    executor: executor(),
    git: gitRunner,
    openerAvailable: sessionOpenerAvailable(),
    ...homeDirOption(),
    ...pluginsDirOption(),
  });
  await write(answer);
  return answer.code;
}

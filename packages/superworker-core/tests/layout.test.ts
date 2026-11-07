import { describe, expect, it } from 'vitest';
import {
  RECORD_DIR_NAME,
  launchPromptPath,
  ledgerLockPath,
  nodeDir,
  nodeTempDir,
  recordPaths,
  sessionNotePath,
  signalPath,
  startedMarkerPath,
} from '../src/paths.ts';
import { join } from 'node:path';

/** Directory layout: every write target comes from a constant or a function in `src/paths.ts`. */

describe('.superworker directory layout', () => {
  it('record files and the four records sit in place; the issue pool lives under issues/', () => {
    const root = join('some', 'project');
    const paths = recordPaths(root);
    expect(paths.root).toBe(root);
    expect(paths.recordDir).toBe(join(root, RECORD_DIR_NAME));
    expect(RECORD_DIR_NAME).toBe('.superworker');
    expect(paths.stateJson).toBe(join(root, '.superworker', 'state.json'));
    expect(paths.ideasJson).toBe(join(root, '.superworker', 'ideas.json'));
    expect(paths.instructionsJson).toBe(join(root, '.superworker', 'instructions.json'));
    expect(paths.issuesJson).toBe(join(root, '.superworker', 'issues', 'issues.json'));
  });

  it('signals, nodes, metadata and session notes land where the layout says', () => {
    const paths = recordPaths('p');
    expect(paths.signalsDir).toBe(join('p', '.superworker', 'signals'));
    expect(paths.nodesDir).toBe(join('p', '.superworker', 'nodes'));
    expect(paths.metaDir).toBe(join('p', '.superworker', 'meta'));
    expect(paths.sessionsDir).toBe(join('p', '.superworker', 'meta', 'sessions'));
    expect(signalPath(paths, 'superworker-core', 'df5129ce')).toBe(
      join('p', '.superworker', 'signals', 'superworker-core', 'df5129ce.json'),
    );
    expect(nodeDir(paths, 'df5129ce')).toBe(join('p', '.superworker', 'nodes', 'df5129ce'));
    expect(nodeTempDir(paths, 'df5129ce')).toBe(join('p', '.superworker', 'nodes', 'df5129ce', 'temp'));
    expect(sessionNotePath(paths, 'df5129ce')).toBe(
      join('p', '.superworker', 'meta', 'sessions', 'df5129ce.json'),
    );
    expect(ledgerLockPath(paths)).toBe(join('p', '.superworker', 'meta', 'ledger.lock'));
  });

  it('every builder that takes a node id runs the same guard, so no caller string spells another location', () => {
    const paths = recordPaths('p');
    // The id-to-path guard is one seat: the node directory and its files, and the signal / session /
    // launch places, all refuse the spellings that would join outside the node's own place.
    const builders: Array<(nodeId: string) => string> = [
      (nodeId) => nodeDir(paths, nodeId),
      (nodeId) => nodeTempDir(paths, nodeId),
      (nodeId) => signalPath(paths, 'superworker-core', nodeId),
      (nodeId) => sessionNotePath(paths, nodeId),
      (nodeId) => launchPromptPath(paths, 'superworker-core', nodeId),
      (nodeId) => startedMarkerPath(paths, 'superworker-core', nodeId),
    ];
    for (const bad of ['', '.', '..', '../..', 'a/b', 'a\\b']) {
      for (const build of builders) {
        expect(() => build(bad), `${JSON.stringify(bad)} must not become a path`).toThrow(
          /not one name a record directory can hold/,
        );
      }
    }
  });
});

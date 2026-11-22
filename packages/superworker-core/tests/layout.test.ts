import { describe, expect, it } from 'vitest';
import {
  launchPromptPath,
  nodeDir,
  nodeTempDir,
  recordPaths,
  sessionNotePath,
  signalPath,
  startedMarkerPath,
} from '../src/paths.ts';

/** Directory layout: the node id to path builders refuse the spellings that would escape the tree. */

describe('.superworker directory layout', () => {
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

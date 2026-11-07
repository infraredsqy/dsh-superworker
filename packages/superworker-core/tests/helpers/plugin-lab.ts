import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { open, type Pf } from '../../src/open';

/**
 * The stage for plugin tests: a project root (already initialised), a home walled into the root,
 * and a helper that writes plugin folders. Engine work stays in temp dirs; the whole tree is
 * taken away when a test ends.
 */

export interface PluginLab {
  readonly root: string;
  /** The machine-level home, walled into the temp project root: `<root>/_home`. */
  readonly home: string;
  readonly superworker: Pf;
  /** Write one plugin folder: a declaration (object or raw text) plus any number of accompanying files. */
  plugin(name: string, decl: unknown, files?: Record<string, string>): string;
  /** Set up one active cycle in state.json (the items it holds come along). */
  cycle(id: string, holding: string[]): void;
  cleanup(): void;
}

export function makeLab(prefix: string): PluginLab {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const home = join(root, '_home');
  mkdirSync(home, { recursive: true });
  const superworker = open(root);
  const lab: PluginLab = {
    root,
    home,
    superworker,
    plugin(name, decl, files = {}) {
      const folder = join(root, 'plugins', name);
      mkdirSync(folder, { recursive: true });
      const declText = typeof decl === 'string' ? decl : JSON.stringify(decl, null, 2);
      writeFileSync(join(folder, 'plugin.json'), declText, 'utf8');
      for (const [rel, content] of Object.entries(files)) {
        const path = join(folder, ...rel.split('/'));
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, content, 'utf8');
      }
      return folder;
    },
    cycle(id, holding) {
      const record = {
        id,
        title: `cycle ${id}`,
        status: 'active',
        holding: holding.map((node) => ({ id: node, since: null })),
        path: [],
        created_at: '2020-01-01T00:00:00Z',
        updated_at: '2020-01-01T00:00:00Z',
      };
      writeFileSync(join(root, '.superworker', 'state.json'), JSON.stringify({ cycles: [record] }, null, 2), 'utf8');
    },
    cleanup() {
      rmSync(root, { recursive: true, force: true });
    },
  };
  return lab;
}

/** A valid close-time insert declaration (tests overwrite cells as they need). */
export function closeInsertDecl(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: undefined,
    summary: 'a test plugin that inserts a node at the close',
    enable_knob: 'plugin_on',
    timing: 'close',
    action: 'insert',
    knobs: {
      plugin_on: { kind: 'switch', default: 'on', summary: 'whether the plugin acts' },
    },
    ...overrides,
  };
}

/** A valid declaration that blocks a dispatch. */
export function dispatchBlockDecl(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    summary: 'a test plugin that may block a dispatch',
    enable_knob: 'gate_on',
    timing: 'dispatch',
    action: 'block',
    knobs: {
      gate_on: { kind: 'switch', default: 'on', summary: 'whether the gate is armed' },
    },
    ...overrides,
  };
}

import { defineConfig } from 'tsdown';

/**
 * Two products, two configurations:
 *
 * - `dist/index.mjs` — the library itself, its declarations beside it, unchanged in name and shape;
 * - `dist/merge-ledger.mjs` — the package's one executable entry (`sw-merge-ledger`), which git
 *   calls as a merge driver. Its first line is the shebang npm's shims execute, injected here so
 *   the source file stays plain TypeScript; npm's own shims are generated at install time from the
 *   `bin` entry of `package.json`, which is the only executable entry this package has.
 *
 * The second build must not clean the first product away, so `clean` is turned off there.
 */
export default defineConfig([
  {
    entry: [{ index: 'src/index.ts' }],
    clean: true,
  },
  {
    entry: [{ 'merge-ledger': 'src/merge-ledger-bin.ts' }],
    banner: '#!/usr/bin/env node\n',
    dts: false,
    clean: false,
  },
]);

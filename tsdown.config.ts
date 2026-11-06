import { defineConfig } from 'tsdown'

/**
 * One entry, for the host half: tsc compiles src/host to lib/types, then tsdown bundles it into lib/host/index.js.
 * The shape mirrors DSH's own plugin packages (entry taken from compiled output; format/platform/target match theirs).
 * This config covers only the host half: the table below carries that single entry.
 *
 * The browser half is src/client/; tsdown does not build it — tools/build-client.mjs scopes the styles down to
 * the panel layer and bundles them into lib/client.js with rolldown (`npm run bundle:client`), wired via
 * package.json's `exports["./client"]`.
 */
export default defineConfig({
  entry: { 'host/index': 'lib/types/host/index.js' },
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
  /* schemastery is provided by the host (it is a peerDependency of this package), so neverBundle keeps it out
     of the bundle: the dynamic import ships as-is and the host's module graph wires it up at load time. */
  deps: { neverBundle: ['@deepseek-ai/schemastery'] },
})
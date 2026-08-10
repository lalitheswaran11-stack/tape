/**
 * Bundle the feed service into a single self-contained dist/main.js so the
 * runtime container can be `node:22-alpine` + one file — no node_modules.
 *
 * - `noExternal: ['ws']` inlines the only runtime dependency. tsup would
 *   otherwise externalize it because it appears in `dependencies`.
 * - `external: ['bufferutil', 'utf-8-validate']` covers ws's optional native
 *   accelerators: ws `require`s them inside try/catch and falls back to its
 *   JS implementations when the require throws, which is exactly what
 *   happens in the bundle. Without listing them, esbuild fails to resolve
 *   the specifiers at build time.
 * - `@lalithesh-star/tape-core/protocol` is imported with `import type` only
 *   throughout src/, so it is fully erased at compile time and must not
 *   appear in the output (verified in CI-adjacent local smoke: the bundle
 *   imports only `node:` builtins).
 * - The `createRequire` banner gives the ESM bundle a real `require`: ws is
 *   CJS, so esbuild routes its `require('zlib')`/`require('stream')` calls
 *   through a `__require` helper that needs `require` in scope (in bare ESM
 *   it would throw "Dynamic require ... is not supported" at import time).
 */

import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { main: 'src/main.ts' },
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  noExternal: ['ws'],
  external: ['bufferutil', 'utf-8-validate'],
  banner: {
    js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
  },
  clean: true,
  minify: false,
});

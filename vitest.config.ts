import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/**
 * Root Vitest config. A single `vitest run` from the repo root discovers and
 * runs every `*.test.ts` across all workspace packages and the web app, so the
 * whole suite is one command with one pass/fail summary.
 *
 * Workspace packages are aliased to their `src` entry so tests run against
 * TypeScript source directly — the suite stays green on a fresh checkout with
 * no prior `npm run build` (which would only have produced the `dist` output
 * the package `exports` otherwise point at).
 */
const coreSrcEntry = fileURLToPath(new URL('./packages/core/src/index.ts', import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@jonny-boi/core': coreSrcEntry,
    },
  },
  test: {
    include: ['{packages,apps}/*/src/**/*.test.ts'],
  },
});

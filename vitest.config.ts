import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/**
 * Root Vitest config. A single `vitest run` from the repo root discovers and
 * runs every `*.test.ts` across all workspace packages and the web app, so the
 * whole suite is one command with one pass/fail summary.
 *
 * Every workspace package is aliased to its `src` entry so tests run against
 * TypeScript source directly — the suite stays green on a fresh checkout with
 * no prior `npm run build` (without these aliases, cross-package imports would
 * resolve through each package's `exports`, which point at the unbuilt `dist`).
 * Add a package here when it gains cross-package importers in tests.
 */
const SOURCE_ALIASED_PACKAGES = ['core', 'cards', 'ai', 'sim', 'data-tools'] as const;

const aliasToSrc = Object.fromEntries(
  SOURCE_ALIASED_PACKAGES.map((pkg) => [
    `@jonny-boi/${pkg}`,
    fileURLToPath(new URL(`./packages/${pkg}/src/index.ts`, import.meta.url)),
  ]),
);

export default defineConfig({
  resolve: {
    alias: aliasToSrc,
  },
  test: {
    include: ['{packages,apps}/*/src/**/*.test.ts'],
  },
});

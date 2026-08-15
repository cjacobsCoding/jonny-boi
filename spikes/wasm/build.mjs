/**
 * Transpile the spike's TypeScript to plain ESM in `build/`, so every measurement
 * runs on ordinary compiled JS.
 *
 * This is not a convenience — it is a correctness requirement for the profiling.
 * Running the sources through `tsx` at start-up put the loader's own transpile
 * work (`runCallSync`, `readFileUtf8`, `parse`) at the TOP of the first CPU
 * profile, which would have inflated the "not our code" share and distorted every
 * ratio the recommendation rests on. Compiled output has no loader in the process.
 *
 * `@jonny-boi/*` stay external: they resolve through the workspace's own built
 * `dist/`, which is exactly what the product ships and runs.
 */

import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { readdirSync } from 'node:fs';

const here = fileURLToPath(new URL('.', import.meta.url));
const srcDir = `${here}src`;

const entryPoints = readdirSync(srcDir)
  .filter((f) => f.endsWith('.ts'))
  .map((f) => `${srcDir}/${f}`);

await build({
  entryPoints,
  outdir: `${here}build`,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  bundle: true,
  packages: 'external',
  sourcemap: false,
  logLevel: 'info',
});

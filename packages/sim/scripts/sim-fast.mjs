#!/usr/bin/env node
/**
 * `npm run sim:fast` — the CLI without paying tsx's compile on every invocation.
 *
 * ⚠️ WHY THIS IS A SEPARATE SCRIPT AND NOT A CHANGE TO `npm run sim`. Running the
 * built `dist` is 2.8s faster to start (0.61s against 3.4s, measured) — which is
 * most of a short command and ~15% of a large `suggest`. But `dist` can be STALE,
 * and this repo has already paid for that once: a benchmark run against an
 * out-of-date `dist` reported "a confident, plausible number for a tree that no
 * longer exists". A CLI that silently answered from last week's engine would be
 * the same trap, aimed at the user instead of at us.
 *
 * So `npm run sim` stays on tsx, which is always correct by construction, and this
 * script buys the speed only after PROVING the build is current: it compares the
 * newest source mtime against the oldest build output and REFUSES to run when the
 * build is behind, naming the file that is newer. A refusal is cheap; a wrong
 * answer delivered fast is not.
 */
import { readdirSync, statSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
// scripts -> sim -> packages -> repo root. Resolved from THIS FILE rather than
// cwd, because npm runs workspace scripts with cwd set to the package.
const repoRoot = join(here, '..', '..', '..');

/** The newest mtime under `dir`, and which file carries it. */
function newest(dir, filter) {
  let best = { time: 0, file: '' };
  const walk = (current) => {
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === '.git') continue;
        walk(full);
      } else if (filter(entry.name)) {
        const { mtimeMs } = statSync(full);
        if (mtimeMs > best.time) best = { time: mtimeMs, file: full };
      }
    }
  };
  walk(dir);
  return best;
}

/** The OLDEST build output — a partial build is as stale as an absent one. */
function oldestBuilt(dir) {
  let best = { time: Number.POSITIVE_INFINITY, file: '' };
  const walk = (current) => {
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.js')) {
        const { mtimeMs } = statSync(full);
        if (mtimeMs < best.time) best = { time: mtimeMs, file: full };
      }
    }
  };
  walk(dir);
  return best;
}

const entry = join(repoRoot, 'packages', 'sim', 'dist', 'src', 'cli.js');
if (!existsSync(entry)) {
  console.error('sim:fast needs a build that does not exist yet — run `npm run build` first.');
  process.exit(2);
}

// Every package the CLI pulls in, not just `sim`: a stale `core` is just as wrong.
const packagesDir = join(repoRoot, 'packages');
const newestSource = newest(packagesDir, (name) => name.endsWith('.ts') && !name.endsWith('.d.ts'));
const oldestBuild = oldestBuilt(join(repoRoot, 'packages', 'sim', 'dist'));

if (newestSource.time > oldestBuild.time) {
  console.error(
    'sim:fast refuses to run: the build is behind the source.\n' +
      `  newer source: ${newestSource.file.replace(repoRoot, '.')}\n` +
      'Run `npm run build`, or use `npm run sim` (tsx, always current but ~2.8s slower to start).',
  );
  process.exit(2);
}

// IMPORTED, not spawned: the CLI reads `process.argv` itself, so running it in
// THIS process saves a whole node start-up — which is a meaningful share of what
// this script exists to save.
await import(pathToFileURL(entry).href);

/**
 * Write the recorded payment corpus to `results/corpus.json` and print its shape.
 * The shape matters as much as the timings: if the real distribution is 2 sources
 * and a 2-pip cost, no kernel language can buy much.
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { captureCorpus } from './corpus.js';

const resultsDir = fileURLToPath(new URL('../results/', import.meta.url));
mkdirSync(resultsDir, { recursive: true });

const cases = captureCorpus({
  pilotId: 'heuristic',
  games: 40,
  seed: 0xc0ffee,
  maxTurns: 30,
  maxActions: 4000,
});

writeFileSync(`${resultsDir}corpus.json`, JSON.stringify(cases));

const sourceCounts = cases.map((c) => c.sources.length);
const modeCounts = cases.flatMap((c) => c.sources.map((s) => s.length));
const pips = cases.map(
  (c) =>
    (c.cost.generic ?? 0) +
    (c.cost.W ?? 0) +
    (c.cost.U ?? 0) +
    (c.cost.B ?? 0) +
    (c.cost.R ?? 0) +
    (c.cost.G ?? 0) +
    (c.cost.C ?? 0) +
    (c.cost.hybrid?.length ?? 0),
);
const hybrids = cases.filter((c) => (c.cost.hybrid?.length ?? 0) > 0).length;

const mean = (xs: readonly number[]): number => (xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length);
const max = (xs: readonly number[]): number => xs.reduce((a, b) => (b > a ? b : a), 0);
const histogram = (xs: readonly number[]): string => {
  const counts = new Map<number, number>();
  for (const x of xs) counts.set(x, (counts.get(x) ?? 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([k, n]) => `${k}:${((n / xs.length) * 100).toFixed(0)}%`)
    .join(' ');
};

process.stdout.write(
  [
    `cases:                 ${cases.length}`,
    `sources per case:      mean ${mean(sourceCounts).toFixed(2)}  max ${max(sourceCounts)}`,
    `  distribution:        ${histogram(sourceCounts)}`,
    `modes per source:      mean ${mean(modeCounts).toFixed(2)}  max ${max(modeCounts)}`,
    `mana value of cost:    mean ${mean(pips).toFixed(2)}  max ${max(pips)}`,
    `  distribution:        ${histogram(pips)}`,
    `cases with hybrid:     ${hybrids} (${((hybrids / cases.length) * 100).toFixed(1)}%)`,
    '',
  ].join('\n'),
);

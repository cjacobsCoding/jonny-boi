/** SCRATCH — reproduce the three action-cap games at BOTH seats. */
import { describe, expect, it } from 'vitest';
import { buildRegistry, loadCardPool } from '@jonny-boi/cards';
import { createDefaultAiRegistry, DEFAULT_PILOT_ID } from '@jonny-boi/ai';
import { formatViolations, replaySoakMixedGame } from './soak.js';

const pool = loadCardPool({ onWarn: () => {} });
const registry = buildRegistry();
const pilot = createDefaultAiRegistry().getPilot(DEFAULT_PILOT_ID)!;

describe('the three games that cannot end', () => {
  for (const seed of [3434778477, 1390617766, 113343071]) {
    for (const onPlay of ['A', 'B'] as const) {
      it(`seed ${seed} onPlay=${onPlay}`, () => {
        const { violations } = replaySoakMixedGame({ pool, registry, pilot, seed, onPlay });
        expect(violations.length, `\n${formatViolations(violations)}\n`).toBe(0);
      }, 120_000);
    }
  }
});

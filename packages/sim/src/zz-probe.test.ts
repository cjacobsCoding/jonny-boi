import { describe, expect, it } from 'vitest';
import { buildRegistry, loadCardPool } from '@jonny-boi/cards';
import { createDefaultAiRegistry, DEFAULT_PILOT_ID } from '@jonny-boi/ai';
import type { GameEvent, PlayerId } from '@jonny-boi/core';
import { loadDeck } from './deck.js';
import { makeSeats } from './matchup.js';
import { PINNED_MATCHUPS } from './soak-pinned-decks.js';
import { runMatch } from './match.js';
import { soakSimConfig } from './soak.js';

const pool = loadCardPool({ onWarn: () => {} });
const registry = buildRegistry();
const pilot = createDefaultAiRegistry().getPilot(DEFAULT_PILOT_ID)!;

const ROWS: ReadonlyArray<readonly [number, PlayerId]> = [
  [1390617766, 'A'],
  [3434778477, 'B'],
  [113343071, 'A'],
];

describe('probe', () => {
  for (const [seed, onPlay] of ROWS) {
    it(`probe seed ${seed}`, () => {
      const m = PINNED_MATCHUPS[seed]!;
      const seats = makeSeats(loadDeck(m.A, pool), loadDeck(m.B, pool), { pilotA: pilot, pilotB: pilot }, registry);
      const counts = new Map<string, number>();
      const sim = soakSimConfig();
      const r = runMatch(seats, seed, {
        sim,
        startingPlayer: onPlay,
        onEvent: (e: GameEvent) => counts.set(e.type, (counts.get(e.type) ?? 0) + 1),
      });
      const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
      // eslint-disable-next-line no-console
      console.log(
        `SEED ${seed} onPlay=${onPlay} actions=${r.actions}/${sim.maxActionsPerGame} turns=${r.turns} ` +
          `outcome=${JSON.stringify(r.outcome)} spellCopied=${counts.get('spellCopied') ?? 0} ` +
          `spellCast=${counts.get('spellCast') ?? 0} top=${JSON.stringify(top)}`,
      );
      expect(true).toBe(true);
    });
  }
});

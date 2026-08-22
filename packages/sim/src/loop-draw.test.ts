/**
 * CR 104.4b — a game that CANNOT be stopped is a draw, not a broken game.
 *
 * Some real card pairs are genuine MANDATORY infinite loops: Dualcaster Mage
 * ("when this enters, copy target instant or sorcery spell" — not a "may") plus a
 * Rite of Replication copy that makes another Dualcaster Mage. Every step is
 * compulsory, so no player can decline their way out. Such a game used to run to
 * the GAME-wide action cap and be recorded as a bogus timeout — indistinguishable
 * from "the engine is stuck", which is exactly what the soak's `gameCanEnd`
 * invariant is for. A per-TURN bound separates the two.
 *
 * ⚠️ These tests deliberately do NOT depend on a pilot walking into the loop.
 * The first version of this file pinned one soak seed where the heuristic looped,
 * and the very next pilot improvement made it WIN that game instead — a green
 * test turning red for a good reason is a test measuring the wrong thing. What is
 * pinned here is the mechanism and the boundary.
 */
import { describe, expect, it } from 'vitest';
import { createDefaultAiRegistry, DEFAULT_PILOT_ID } from '@jonny-boi/ai';
import { buildRegistry, loadCardPool } from '@jonny-boi/cards';
import { DEFAULT_SIM_CONFIG } from './config.js';
import { loadDeck } from './deck.js';
import { runMatch } from './match.js';
import { makeSeats } from './matchup.js';
import { buildAnchoredDeck, indexPoolForSoak } from './soak-decks.js';
import { soakSimConfig } from './soak.js';

const pool = loadCardPool({ onWarn: () => {} });
const registry = buildRegistry();
const pilot = createDefaultAiRegistry().getPilot(DEFAULT_PILOT_ID)!;
const index = indexPoolForSoak(pool.cards);

function anchoredSeats(mechanicA: 'spell-copy' | 'lifegain', seedA: number, seedB: number) {
  const a = buildAnchoredDeck(index, mechanicA, seedA);
  const b = buildAnchoredDeck(index, 'token-copy', seedB);
  if (!a || !b) throw new Error('anchored decks did not build');
  return makeSeats(loadDeck(a, pool), loadDeck(b, pool), { pilotA: pilot, pilotB: pilot }, registry);
}

describe('a turn that never ends is a draw, not a timeout', () => {
  it('reports `loop`, distinct from the timeout that means "we gave up"', () => {
    // A bound of 1 makes the very first turn overrun, which is the only way to
    // reach this branch without relying on a particular board arising. What is
    // being pinned is that the outcome SAYS loop — a `timeout` here would put a
    // rules-correct draw in the same bucket as an engine that is stuck.
    const seats = anchoredSeats('lifegain', 4242, 99);
    const r = runMatch(seats, 7, {
      sim: { ...soakSimConfig(), maxActionsPerTurn: 1 },
      startingPlayer: 'A',
    });
    expect(r.outcome.kind).toBe('loop');
    expect(r.actions, 'it stops at the bound, nowhere near the game cap').toBeLessThan(
      soakSimConfig().maxActionsPerGame,
    );
  }, 120000);

  it('leaves ordinary games completely alone', () => {
    // The guard that matters most: a per-turn bound set too low would silently
    // draw real games and every win-rate in the product would quietly shift.
    expect(DEFAULT_SIM_CONFIG.maxActionsPerTurn).toBeGreaterThan(1000);
    const seats = anchoredSeats('lifegain', 4242, 99);
    const r = runMatch(seats, 7, { sim: soakSimConfig(), startingPlayer: 'A' });
    expect(r.outcome.kind, 'a normal game must never be called a loop').not.toBe('loop');
  }, 120000);

  it('the copy-mirror board resolves one way or another — never the action cap', () => {
    // The board that produced the finding: spell-copy vs token-copy, dealing
    // Dualcaster Mage and Rite of Replication. Asserting only that it ENDS is
    // deliberate — whether the pilot wins it or the rules draw it is a pilot
    // question and will change again; that it terminates is the invariant.
    const a = buildAnchoredDeck(index, 'spell-copy', 951626966);
    const b = buildAnchoredDeck(index, 'token-copy', 1665702627);
    if (!a || !b) throw new Error('anchored decks did not build');
    const names = [...a.cards, ...b.cards].map((e) => pool.get(e.cardId)?.name ?? e.cardId);
    expect(names, 'this seed no longer deals Dualcaster Mage — different game').toContain(
      'Dualcaster Mage',
    );
    expect(names, 'this seed no longer deals Rite of Replication — different game').toContain(
      'Rite of Replication',
    );
    for (const onPlay of ['A', 'B'] as const) {
      const seats = makeSeats(loadDeck(a, pool), loadDeck(b, pool), { pilotA: pilot, pilotB: pilot }, registry);
      const r = runMatch(seats, 951626966, { sim: soakSimConfig(), startingPlayer: onPlay });
      expect(r.actions, `onPlay ${onPlay}: must not burn the game-wide cap`).toBeLessThan(
        soakSimConfig().maxActionsPerGame,
      );
    }
  }, 300000);
});

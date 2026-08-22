/**
 * CR 104.4b — a game that CANNOT be stopped is a draw, not a broken game.
 *
 * Some real card pairs are genuine MANDATORY infinite loops. Dualcaster Mage
 * ("when this enters, copy target instant or sorcery spell" — not a "may") plus
 * a Rite of Replication copy that makes another Dualcaster Mage is the printed
 * example: every step of it is compulsory, so no player can decline their way
 * out, and the rules end the game rather than calling either card broken.
 *
 * Before this, such a game ran until the GAME-wide action cap and was recorded
 * as a bogus timeout — indistinguishable from "the engine is stuck", which is
 * what the soak's `gameCanEnd` invariant is for. A per-TURN bound separates the
 * two: no legitimate turn is thousands of actions long.
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

/** The exact pairing the fast soak found: seed 951626966, spell-copy vs token-copy. */
function theLoopGame(onPlay: 'A' | 'B') {
  const a = buildAnchoredDeck(index, 'spell-copy', 951626966);
  const b = buildAnchoredDeck(index, 'token-copy', 1665702627);
  if (!a || !b) throw new Error('anchored decks did not build');
  // WHICH GAME — the same discipline the pinned soak replays keep. Without these
  // the assertions below are green for two different reasons.
  // `DeckEntry.cardId` is a Scryfall id here, so resolve through the pool — the
  // decklist is the game's identity and it has to be asserted by NAME.
  const names = [...a.cards, ...b.cards].map((e) => pool.get(e.cardId)?.name ?? e.cardId);
  expect(names, 'this seed no longer deals Dualcaster Mage — different game').toContain('Dualcaster Mage');
  expect(names, 'this seed no longer deals Rite of Replication — different game').toContain(
    'Rite of Replication',
  );
  const seats = makeSeats(loadDeck(a, pool), loadDeck(b, pool), { pilotA: pilot, pilotB: pilot }, registry);
  return runMatch(seats, 951626966, { sim: soakSimConfig(), startingPlayer: onPlay });
}

describe('a mandatory loop ends the game as a draw', () => {
  it('ends by CR 104.4b rather than burning the game-wide action cap', () => {
    for (const onPlay of ['A', 'B'] as const) {
      const r = theLoopGame(onPlay);
      expect(r.outcome.kind, `onPlay ${onPlay}: the rules end this game`).toBe('loop');
      // The point of the per-turn bound: it stops LONG before the game cap, so
      // the outcome says "loop" instead of the "timeout" that means "no idea".
      expect(r.actions, `onPlay ${onPlay}`).toBeLessThan(soakSimConfig().maxActionsPerGame);
    }
  }, 300000);

  it('leaves ordinary games alone — the bound is far above a real turn', () => {
    // The guard that matters: a per-turn cap set too low would silently draw
    // real games and every win-rate in the product would quietly shift.
    expect(DEFAULT_SIM_CONFIG.maxActionsPerTurn).toBeGreaterThan(1000);
    const a = buildAnchoredDeck(index, 'lifegain', 4242);
    const b = buildAnchoredDeck(index, 'lifegain', 99);
    if (!a || !b) throw new Error('anchored decks did not build');
    const seats = makeSeats(loadDeck(a, pool), loadDeck(b, pool), { pilotA: pilot, pilotB: pilot }, registry);
    const r = runMatch(seats, 7, { sim: soakSimConfig(), startingPlayer: 'A' });
    expect(r.outcome.kind, 'a normal game must never be called a loop').not.toBe('loop');
  }, 300000);
});

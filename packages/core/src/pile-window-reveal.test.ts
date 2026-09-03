/**
 * §3.123 — CASCADE AND RIPPLE **SAY** THAT THEY REVEALED THE CARDS.
 *
 * Both keywords take cards off the top of the library in public: cascade exiles
 * them face up (CR 702.85a) and ripple literally says "reveal" (CR 702.60a).
 * This engine models the window by moving them to exile and bottoming them when
 * it closes — so the cards are public for the length of ONE resolution and are
 * back in the library, hidden, before any seat gets priority again.
 *
 * Nothing in a settled state records that. The sim's observation-leak scanner
 * shrinks its never-seen set at DECISION boundaries, so a card that was public
 * only between two of them looks like it was never on display — and the
 * window's own `zoneChange` and `pileBottomed` events, which name it, read as a
 * hidden-information leak. On the 6,257-card pool (which is the first to carry
 * the Coldsnap "Surging" ripple cards) that produced **688 leak reports in a
 * single soak lane**, every one of them a faithful public event.
 *
 * The remedy is §3.119's, because it is the same shape: a reveal is the one way
 * a card becomes public WITHOUT changing zones at a boundary anyone can watch,
 * so the engine has to emit `cardRevealed` and say so. It fires no triggers
 * (`internal/triggers-runtime.ts`), so this adds a fact to the log and changes
 * no game outcome.
 *
 * THE ORDER IS PART OF THE FIX: the reveal must precede the `zoneChange` it
 * explains, because a scanner processes a flush's observations in emission
 * order and would otherwise report the move before learning the card was shown.
 */

import { describe, expect, it } from 'vitest';
import { createGame, performCascade, performRipple, type CardDefinition, type GameEvent, type GameState } from './index.js';
import { createEffectRegistry } from './effects.js';
import { deckOf, landDef } from './test-fixtures.js';

const FILLER = landDef('Filler', 'G');

function spell(id: string, cost: number): CardDefinition {
  return { id, name: id, types: ['sorcery'], timing: 'sorcery', cost: { generic: cost }, effects: [] };
}

/** A game whose A library is exactly `defs`, top first. */
function gameWithLibrary(defs: readonly CardDefinition[]): GameState {
  const registry = createEffectRegistry();
  const { state } = createGame({ seed: 5, startingPlayer: 'A', registry, decks: { A: deckOf(FILLER, 40), B: deckOf(FILLER, 40) } });
  let next = 900_000;
  state.players.A.library = defs.map((def) => ({
    instanceId: next++ as GameState['players']['A']['library'][number]['instanceId'],
    def,
    owner: 'A',
    controller: 'A',
    zone: 'library',
    tapped: false,
    summoningSick: false,
    damage: 0,
    counters: {},
  })) as GameState['players']['A']['library'];
  return state;
}

/** Every `cardRevealed`, in emission order, as `#id/name`. */
function reveals(events: readonly GameEvent[]): string[] {
  return events
    .filter((e): e is Extract<GameEvent, { type: 'cardRevealed' }> => e.type === 'cardRevealed')
    .map((e) => `#${e.instanceId}/${e.name}`);
}

describe('a pile window reveals what it takes off the library (§3.123)', () => {
  it('cascade reveals EVERY card it exiles, hit included, from the library', () => {
    const state = gameWithLibrary([FILLER, FILLER, spell('Hit', 2), spell('Deep', 1)]);
    const events: GameEvent[] = [];
    const pile = performCascade(state, 'A', 4, (e) => events.push(e));
    expect(pile).toHaveLength(3); // two lands, then the first cheap nonland
    const revealed = events.filter((e): e is Extract<GameEvent, { type: 'cardRevealed' }> => e.type === 'cardRevealed');
    expect(revealed.map((e) => e.instanceId)).toEqual([...pile]);
    for (const event of revealed) expect(event.fromZone).toBe('library');
  });

  it('ripple reveals all four, whether or not a same-name card is found', () => {
    const state = gameWithLibrary([spell('Surge', 1), FILLER, FILLER, FILLER, spell('Deep', 1)]);
    const events: GameEvent[] = [];
    const pile = performRipple(state, 'A', 'Nothing With This Name', 4, (e) => events.push(e));
    expect(pile).toHaveLength(4);
    expect(reveals(events)).toHaveLength(4);
    // Declined by having no match: the pile went back to the bottom, and every
    // card the `pileBottomed` event names was announced first.
    const bottomed = events.find((e) => e.type === 'pileBottomed');
    expect(bottomed).toBeDefined();
    for (const id of (bottomed as Extract<GameEvent, { type: 'pileBottomed' }>).instanceIds) {
      expect(reveals(events).some((r) => r.startsWith(`#${id}/`))).toBe(true);
    }
  });

  it('announces each card BEFORE the zone change that moves it', () => {
    const state = gameWithLibrary([spell('Hit', 1), spell('Deep', 1)]);
    const events: GameEvent[] = [];
    performCascade(state, 'A', 3, (e) => events.push(e));
    const first = events.findIndex((e) => e.type === 'cardRevealed');
    const move = events.findIndex((e) => e.type === 'zoneChange');
    expect(first).toBeGreaterThanOrEqual(0);
    expect(move).toBeGreaterThan(first);
  });

  it('reveals nothing when the library is empty — no phantom announcement', () => {
    const state = gameWithLibrary([]);
    const events: GameEvent[] = [];
    expect(performCascade(state, 'A', 4, (e) => events.push(e))).toHaveLength(0);
    expect(reveals(events)).toEqual([]);
  });
});

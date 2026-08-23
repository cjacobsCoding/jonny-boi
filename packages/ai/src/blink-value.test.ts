/**
 * PRICING AN OPTIONAL EFFECT, AND PRICING A BLINK.
 *
 * Two entries in the value table that were missing, found by watching a real
 * game rather than by reading the code:
 *
 *  - `mayEffects` ("you may <body>") was absent, so it scored the flat
 *    unknown-effect constant and the nested body was NEVER LOOKED AT. A pilot
 *    aiming an optional trigger therefore scored every candidate identically and
 *    fell through to the first one offered.
 *  - `blinkTarget` was absent for the same reason, and a blink is the one effect
 *    where aiming at your OWN permanent is the point.
 *
 * Together they had Conjurer's Closet eating its own Soldier tokens while a
 * Thragtusk stood next to it: measured at 9 Soldiers + 1 Beast destroyed per 40
 * games, and 1 per 40 afterwards.
 */
import { describe, expect, it } from 'vitest';
import type { CardDefinition, CardInstance, GameState } from '@jonny-boi/core';
import { DEFAULT_HEURISTIC_WEIGHTS } from './weights.js';
import { valueOfEffects } from './effect-value.js';
import { resolutionValueContext } from './effect-value.js';
import { cardValueContext } from './card-value.js';
import { boardIndex } from './board-stats.js';
import { CARD_POOL } from '@jonny-boi/cards';

// REAL pool cards, not hand-built fixtures: a fixture that omitted the `who`
// param the printed card carries priced its own draw at zero and made this file
// disagree with the game for a reason that was never in the code under test.
function pooled(name: string): CardDefinition {
  const c = CARD_POOL.find((e) => e.name === name);
  if (!c) throw new Error('pool missing ' + name);
  return c;
}

const DRAWER = pooled('Wall of Omens');       // enters: draw a card
const VANILLA = pooled('Grizzly Bears');       // nothing to re-trigger
const TOKEN: CardDefinition = { ...VANILLA, id: 'x-token', name: 'Soldier token', isToken: true };

function stateWith(defs: readonly CardDefinition[]): { state: GameState; ids: number[] } {
  // A LIBRARY is not decoration here: `drawCards` prices a draw from an empty
  // one as decking yourself, which turned "blink the card-drawer" negative and
  // made this file disagree with the game for a reason not in the code.
  const library = () =>
    Array.from({ length: 20 }, (_, i) => ({ instanceId: 900 + i, def: VANILLA, controller: 'A', owner: 'A', zone: 'library' })) as unknown as CardInstance[];
  const seat = () => ({
    life: 20, hand: [], library: library(), graveyard: [], exile: [], command: [],
    manaPool: { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 }, landsPlayedThisTurn: 0, hasLost: false,
  });
  const state = {
    battlefield: [] as CardInstance[], players: { A: seat(), B: seat() }, nextInstanceId: 1,
    stack: [], continuous: [], turnNumber: 1, step: 'precombatMain',
    activePlayer: 'A', priorityPlayer: 'A', gameOver: false,
  } as unknown as GameState;
  const ids: number[] = [];
  for (const def of defs) {
    const id = state.nextInstanceId++;
    state.battlefield.push({
      instanceId: id, def, controller: 'A', owner: 'A', zone: 'battlefield', tapped: false,
      summoningSick: false, damageMarked: 0, markedByDeathtouch: false, attachedTo: null, counters: {},
    } as unknown as CardInstance);
    ids.push(id);
  }
  return { state, ids };
}

function priceBlink(state: GameState, target: number): number {
  const index = boardIndex(state);
  const base = resolutionValueContext(state, 'A', DEFAULT_HEURISTIC_WEIGHTS, cardValueContext(state, index));
  return valueOfEffects([{ primitive: 'blinkTarget', params: {} }], { ...base, targets: [target] });
}

function priceOptionalBlink(state: GameState, target: number): number {
  const index = boardIndex(state);
  const base = resolutionValueContext(state, 'A', DEFAULT_HEURISTIC_WEIGHTS, cardValueContext(state, index));
  return valueOfEffects(
    [{ primitive: 'mayEffects', params: { effects: [{ primitive: 'blinkTarget', params: {} }] } }],
    { ...base, targets: [target] },
  );
}

describe('pricing a blink', () => {
  it('prefers a creature with an enters trigger over a vanilla body', () => {
    const { state, ids } = stateWith([DRAWER, VANILLA]);
    expect(priceBlink(state, ids[0]!)).toBeGreaterThan(priceBlink(state, ids[1]!));
  });

  it('prices blinking your own TOKEN as a loss - it ceases to exist', () => {
    const { state, ids } = stateWith([TOKEN]);
    expect(priceBlink(state, ids[0]!)).toBeLessThan(0);
  });

  it('prices a vanilla blink as a small loss, not a neutral move', () => {
    // It returns summoning-sick and shorn of counters; nothing is gained.
    const { state, ids } = stateWith([VANILLA]);
    expect(priceBlink(state, ids[0]!)).toBeLessThan(0);
  });
});

describe('pricing "you may <body>"', () => {
  it('is worth what the body is worth - it must RECURSE', () => {
    // The bug: an unpriced `mayEffects` scored a flat constant and the body was
    // invisible, so every candidate tied and the pilot took the first offered.
    const { state, ids } = stateWith([DRAWER, TOKEN]);
    const good = priceOptionalBlink(state, ids[0]!);
    const bad = priceOptionalBlink(state, ids[1]!);
    expect(good).toBeGreaterThan(bad);
    expect(bad, 'eating your own token must not read as neutral').toBeLessThan(0);
  });

  it('agrees with the un-wrapped body, so wrapping a card in "you may" changes no price', () => {
    const { state, ids } = stateWith([DRAWER]);
    expect(priceOptionalBlink(state, ids[0]!)).toBe(priceBlink(state, ids[0]!));
  });
});

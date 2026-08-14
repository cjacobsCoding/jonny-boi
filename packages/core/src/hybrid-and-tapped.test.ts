/**
 * Tests for two engine capabilities that unblock real decks:
 *
 *  - HYBRID MANA COSTS ({G/W}), without which Kitchen Finks had to be authored
 *    as a one-mana 3/2 — a card the pool was effectively cheating with.
 *  - ENTERS TAPPED, without which every common dual land would come down
 *    untapped and every deck playing them would simulate a turn too fast.
 */

import { describe, expect, it } from 'vitest';
import { canPay, convertedManaCost, emptyPool, payCost, type ManaPool } from './mana.js';
import { entersTapped } from './card.js';
import type { CardDefinition } from './card.js';
import {
  applyAction,
  createGame,
  DEFAULT_RULES,
  generateLegalActions,
  type GameAction,
  type GameState,
} from './index.js';
import { createEffectRegistry } from './effects.js';
import { deckOf, giveHand } from './test-fixtures.js';

/** Apply an action, asserting it was not rejected. */
function act(state: GameState, action: GameAction): GameState {
  const result = applyAction(state, action, DEFAULT_RULES, createEffectRegistry());
  const rejected = result.events.find((e) => e.type === 'actionRejected');
  if (rejected) throw new Error(`unexpected rejection: ${(rejected as { reason: string }).reason}`);
  return result.state;
}

/** Pass priority until the given step is reached (lands need a main phase). */
function advanceToStep(state: GameState, target: string): GameState {
  let s = state;
  let guard = 0;
  while (s.step !== target && !s.gameOver && guard++ < 300) {
    s = act(s, { kind: 'passPriority', player: s.priorityPlayer });
  }
  return s;
}

/** Build a pool from a partial spec (absent colors are zero). */
function pool(spec: Partial<ManaPool>): ManaPool {
  return { ...emptyPool(), ...spec };
}

describe('hybrid mana costs', () => {
  // Kitchen Finks: {1}{G/W}{G/W}
  const kitchenFinks = { generic: 1, hybrid: [['G', 'W'], ['G', 'W']] } as const;

  it('counts each hybrid symbol as one toward mana value', () => {
    expect(convertedManaCost(kitchenFinks)).toBe(3);
  });

  it('pays both symbols with the same color when that is all you have', () => {
    const result = payCost(pool({ G: 3 }), kitchenFinks);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.pool.G).toBe(0);
  });

  it('pays each symbol with a different color when that is what works', () => {
    // Exactly one G, one W, and one spare for the generic — only the mixed
    // assignment can pay this, which a greedy "always use G" would miss.
    const result = payCost(pool({ G: 1, W: 1, U: 1 }), kitchenFinks);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.pool.G).toBe(0);
      expect(result.pool.W).toBe(0);
      expect(result.pool.U).toBe(0);
    }
  });

  it('refuses when neither hybrid color is available', () => {
    const result = payCost(pool({ U: 5 }), kitchenFinks);
    expect(result.ok).toBe(false);
  });

  it('refuses when there is enough colored mana but not enough total', () => {
    // Two G pays the hybrids but leaves nothing for the {1}.
    expect(canPay(pool({ G: 2 }), kitchenFinks)).toBe(false);
  });

  it('never spends more than the cost requires', () => {
    const result = payCost(pool({ G: 5, W: 5 }), kitchenFinks);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const spent = 10 - (result.pool.G + result.pool.W);
      expect(spent).toBe(convertedManaCost(kitchenFinks));
    }
  });

  it('is deterministic — the same pool and cost always pay the same way', () => {
    const first = payCost(pool({ G: 2, W: 2 }), kitchenFinks);
    const second = payCost(pool({ G: 2, W: 2 }), kitchenFinks);
    expect(first).toEqual(second);
  });

  it('leaves plain costs untouched', () => {
    const result = payCost(pool({ R: 1 }), { R: 1 });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.pool.R).toBe(0);
  });
});

describe('entersTapped', () => {
  const tapland: CardDefinition = {
    id: 'test:tapland',
    name: 'Test Tapland',
    types: ['land'],
    entersTapped: true,
    produces: ['U'],
  };
  const basic: CardDefinition = {
    id: 'test:basic',
    name: 'Test Basic',
    types: ['land'],
    produces: ['U'],
  };

  it('reads the flag off a definition', () => {
    expect(entersTapped(tapland)).toBe(true);
    expect(entersTapped(basic)).toBe(false);
  });

  it('a played tapland arrives tapped and cannot be tapped for mana this turn', () => {
    const game = createGame({ seed: 7, decks: { A: deckOf(basic, 40), B: deckOf(basic, 40) } });
    let s = advanceToStep(game.state, 'precombatMain');
    const [land] = giveHand(s, 'A', [tapland]);
    s = act(s, { kind: 'playLand', player: 'A', instanceId: land!.instanceId });

    const onBattlefield = s.battlefield.find((c) => c.instanceId === land!.instanceId);
    expect(onBattlefield?.tapped).toBe(true);
    // The board tells the truth to the action generator too: no mana from it.
    const manaActions = generateLegalActions(s, 'A', DEFAULT_RULES).filter(
      (action) => action.kind === 'tapForMana' && action.instanceId === land!.instanceId,
    );
    expect(manaActions).toHaveLength(0);
  });

  it('a played untapped land is still untapped (no regression)', () => {
    const game = createGame({ seed: 8, decks: { A: deckOf(basic, 40), B: deckOf(basic, 40) } });
    let s = advanceToStep(game.state, 'precombatMain');
    const [land] = giveHand(s, 'A', [basic]);
    s = act(s, { kind: 'playLand', player: 'A', instanceId: land!.instanceId });

    expect(s.battlefield.find((c) => c.instanceId === land!.instanceId)?.tapped).toBe(false);
  });
});

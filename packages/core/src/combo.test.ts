/**
 * The infinite-combo detector, on scripted action sequences and hand-built
 * signatures (DESIGN §3.178 stage 1). The engine end-to-end lives in
 * `combo-engine.test.ts`; this file is the pure rule and nothing else.
 */
import { describe, expect, it } from 'vitest';
import type { GameAction } from './actions.js';
import type { GameState, PlayerId } from './state.js';
import { createGame } from './engine.js';
import { landDef, deckOf } from './test-fixtures.js';
import {
  COMBO_MAX_CYCLE_ACTIONS,
  COMBO_REPEAT_CAP,
  COMBO_REPEAT_DEFAULT,
  comboActionKey,
  comboCycleKey,
  comboResourceKey,
  comboSignatureOf,
  describeComboDelta,
  findComboLoop,
  parseComboResourceKey,
  summarizeComboLoop,
  type ComboHistoryEntry,
  type ComboSignature,
} from './combo.js';

// --- scripted histories ------------------------------------------------------------

const BOARD = 'turn:A:precombatMain\nbf:a;b\nstack:\ngy:A=\nex:A=\ngy:B=\nex:B=\ncombat:none';

function sig(resources: Record<string, number>, structure = BOARD): ComboSignature {
  return { structure, resources };
}

const activate = (player: PlayerId, instanceId: number): GameAction => ({
  kind: 'activateAbility',
  player,
  instanceId,
  abilityIndex: 0,
});
const pass = (player: PlayerId): GameAction => ({ kind: 'passPriority', player });

/** Build a history from `[action, signatureAfter]` pairs after a baseline. */
function history(baseline: ComboSignature, steps: readonly (readonly [GameAction, ComboSignature])[]): ComboHistoryEntry[] {
  return [
    { action: null, actionKey: null, signature: baseline },
    ...steps.map(([action, signature]) => ({ action, actionKey: comboActionKey(action), signature })),
  ];
}

const LIFE_A = comboResourceKey('life', 'A');
const LIFE_B = comboResourceKey('life', 'B');
const MANA_A_G = comboResourceKey('mana', 'A', 'G');

/** Any state; the detector reads it only to name token and counter subjects. */
function anyState(): GameState {
  const forest = landDef('Forest', 'G');
  return createGame({ seed: 1, decks: { A: deckOf(forest, 40), B: deckOf(forest, 40) } }).state;
}

describe('findComboLoop — the loop and its refusals', () => {
  const state = anyState();

  it('finds a life-gain loop: two equal cycles, the same board at every boundary, +2 life each time', () => {
    // Cycle = tap A (gain 2), tap B (untap A and itself). Life climbs 20 → 22 → 24.
    const h = history(sig({ [LIFE_A]: 20 }), [
      [activate('A', 1), sig({ [LIFE_A]: 22 }, BOARD + '|a-tapped')],
      [activate('A', 2), sig({ [LIFE_A]: 22 })],
      [activate('A', 1), sig({ [LIFE_A]: 24 }, BOARD + '|a-tapped')],
      [activate('A', 2), sig({ [LIFE_A]: 24 })],
    ]);
    const verdict = findComboLoop(h, state);
    expect(verdict.found).toBe(true);
    if (!verdict.found) return;
    expect(verdict.loop.player).toBe('A');
    expect(verdict.loop.cycle.map((a) => a.kind)).toEqual(['activateAbility', 'activateAbility']);
    expect(verdict.loop.deltas).toEqual([
      { key: LIFE_A, kind: 'life', player: 'A', delta: 2, label: '+2 life' },
    ]);
    expect(summarizeComboLoop(verdict.loop)).toBe('+2 life per cycle');
  });

  it('refuses the untap ↔ untap no-op: identical cycles, identical board, nothing moved', () => {
    const h = history(sig({ [LIFE_A]: 20 }), [
      [activate('A', 1), sig({ [LIFE_A]: 20 }, BOARD + '|a-tapped')],
      [activate('A', 2), sig({ [LIFE_A]: 20 })],
      [activate('A', 1), sig({ [LIFE_A]: 20 }, BOARD + '|a-tapped')],
      [activate('A', 2), sig({ [LIFE_A]: 20 })],
    ]);
    expect(findComboLoop(h, state)).toEqual({ found: false, reason: 'noNetChange' });
  });

  it('refuses a cycle whose structure differs at a boundary (a sacrifice)', () => {
    const h = history(sig({ [LIFE_A]: 20 }), [
      [activate('A', 1), sig({ [LIFE_A]: 22 })],
      [activate('A', 2), sig({ [LIFE_A]: 22 })],
      [activate('A', 1), sig({ [LIFE_A]: 24 })],
      // The second cycle ends with a permanent gone.
      [activate('A', 2), sig({ [LIFE_A]: 24 }, BOARD.replace('bf:a;b', 'bf:a'))],
    ]);
    expect(findComboLoop(h, state)).toEqual({ found: false, reason: 'structureMoved' });
  });

  it('refuses when the two cycles moved a resource by different amounts', () => {
    const h = history(sig({ [LIFE_A]: 20 }), [
      [activate('A', 1), sig({ [LIFE_A]: 22 })],
      [activate('A', 1), sig({ [LIFE_A]: 25 })],
    ]);
    expect(findComboLoop(h, state)).toEqual({ found: false, reason: 'deltaDiffers' });
  });

  it('refuses a loop that SPENDS the owner\'s mana every cycle — it ends when the pool does', () => {
    const h = history(sig({ [LIFE_A]: 20, [MANA_A_G]: 3 }), [
      [activate('A', 1), sig({ [LIFE_A]: 21, [MANA_A_G]: 2 })],
      [activate('A', 1), sig({ [LIFE_A]: 22, [MANA_A_G]: 1 })],
    ]);
    expect(findComboLoop(h, state)).toEqual({ found: false, reason: 'consumesFuel' });
  });

  it('the OPPONENT losing life is the loop\'s effect, never its fuel', () => {
    const h = history(sig({ [LIFE_A]: 20, [LIFE_B]: 20 }), [
      [activate('A', 1), sig({ [LIFE_A]: 20, [LIFE_B]: 18 })],
      [activate('A', 1), sig({ [LIFE_A]: 20, [LIFE_B]: 16 })],
    ]);
    const verdict = findComboLoop(h, state);
    expect(verdict.found).toBe(true);
    if (verdict.found) expect(verdict.loop.deltas.map((d) => d.label)).toEqual(['−2 life']);
  });

  it('the opponent\'s PASSES are part of the cycle and the loop is still the actor\'s', () => {
    const h = history(sig({ [LIFE_A]: 20 }), [
      [activate('A', 1), sig({ [LIFE_A]: 20 }, BOARD + '|stack')],
      [pass('A'), sig({ [LIFE_A]: 20 }, BOARD + '|stack|passed')],
      [pass('B'), sig({ [LIFE_A]: 21 })],
      [activate('A', 1), sig({ [LIFE_A]: 21 }, BOARD + '|stack')],
      [pass('A'), sig({ [LIFE_A]: 21 }, BOARD + '|stack|passed')],
      [pass('B'), sig({ [LIFE_A]: 22 })],
    ]);
    const verdict = findComboLoop(h, state);
    expect(verdict.found).toBe(true);
    if (verdict.found) {
      expect(verdict.loop.player).toBe('A');
      expect(verdict.loop.cycle).toHaveLength(3);
    }
  });

  it('refuses a loop BOTH players act in (the opponent did more than pass)', () => {
    const h = history(sig({ [LIFE_A]: 20 }), [
      [activate('A', 1), sig({ [LIFE_A]: 21 })],
      [activate('B', 9), sig({ [LIFE_A]: 21 }, BOARD + '|x')],
      [activate('A', 1), sig({ [LIFE_A]: 22 })],
      [activate('B', 9), sig({ [LIFE_A]: 22 }, BOARD + '|x')],
    ]);
    expect(findComboLoop(h, state)).toEqual({ found: false, reason: 'sharedLoop' });
  });

  it('compares an answerChoice by its ANSWER, not by the choice id minted per question', () => {
    const answer = (choiceId: number): GameAction => ({
      kind: 'answerChoice',
      player: 'A',
      choiceId,
      answer: { kind: 'selectTargets', targets: [1] },
    });
    const h = history(sig({ [LIFE_A]: 20 }), [
      [answer(101), sig({ [LIFE_A]: 21 })],
      [answer(102), sig({ [LIFE_A]: 22 })],
    ]);
    expect(findComboLoop(h, state).found).toBe(true);
    expect(comboActionKey(answer(101))).toBe(comboActionKey(answer(102)));
  });

  it('reports the SMALLEST repeating cycle', () => {
    const h = history(sig({ [LIFE_A]: 20 }), [
      [activate('A', 1), sig({ [LIFE_A]: 21 })],
      [activate('A', 1), sig({ [LIFE_A]: 22 })],
      [activate('A', 1), sig({ [LIFE_A]: 23 })],
      [activate('A', 1), sig({ [LIFE_A]: 24 })],
    ]);
    const verdict = findComboLoop(h, state);
    expect(verdict.found && verdict.loop.cycle.length).toBe(1);
  });

  it('honours the cycle cap: one action over it is not found, exactly at it is', () => {
    const cycleOf = (k: number, offset: number): (readonly [GameAction, ComboSignature])[] =>
      Array.from({ length: k }, (_, i) => {
        const last = i === k - 1;
        // Every action in the run is distinct (a different instance), so no
        // shorter k can match; the last one closes the cycle with +1 life.
        return [activate('A', 100 + i), sig({ [LIFE_A]: last ? 20 + offset : 19 + offset }, last ? BOARD : `${BOARD}|${i}`)] as const;
      });
    const over = COMBO_MAX_CYCLE_ACTIONS + 1;
    const tooLong = history(sig({ [LIFE_A]: 20 }), [...cycleOf(over, 1), ...cycleOf(over, 2)]);
    expect(findComboLoop(tooLong, state)).toEqual({ found: false, reason: 'noRepeat' });
    const atCap = history(sig({ [LIFE_A]: 20 }), [
      ...cycleOf(COMBO_MAX_CYCLE_ACTIONS, 1),
      ...cycleOf(COMBO_MAX_CYCLE_ACTIONS, 2),
    ]);
    const verdict = findComboLoop(atCap, state);
    expect(verdict.found && verdict.loop.cycle.length).toBe(COMBO_MAX_CYCLE_ACTIONS);
  });

  it('a history with no repeat at all is `noRepeat`', () => {
    const h = history(sig({ [LIFE_A]: 20 }), [[activate('A', 1), sig({ [LIFE_A]: 21 })]]);
    expect(findComboLoop(h, state)).toEqual({ found: false, reason: 'noRepeat' });
  });
});

describe('the cycle key is rotation-free, so a dismissal survives the next action by hand', () => {
  it('every rotation of a cycle shares one key; a different cycle does not', () => {
    const keys = ['a', 'p', 'q'];
    expect(comboCycleKey(['p', 'q', 'a'])).toBe(comboCycleKey(keys));
    expect(comboCycleKey(['q', 'a', 'p'])).toBe(comboCycleKey(keys));
    expect(comboCycleKey(['a', 'q', 'p'])).not.toBe(comboCycleKey(keys));
  });
});

describe('comboSignatureOf — what is structure and what is a resource', () => {
  it('tokens are COUNTED in resources and absent from the structure; cards are structure', () => {
    const state = anyState();
    const saproling = { id: 'saproling-token', name: 'Saproling', types: ['creature' as const], power: 1, toughness: 1, isToken: true };
    const bear = { id: 'bear', name: 'Bear', types: ['creature' as const], power: 2, toughness: 2 };
    const mint = (def: typeof saproling | typeof bear) => ({
      instanceId: state.nextInstanceId++,
      def,
      controller: 'A' as const,
      owner: 'A' as const,
      zone: 'battlefield' as const,
      tapped: false,
      summoningSick: false,
      damageMarked: 0,
      markedByDeathtouch: false,
      counters: {},
    });
    state.battlefield.push(mint(bear));
    const one = comboSignatureOf(state);
    state.battlefield.push(mint(saproling), mint(saproling));
    const two = comboSignatureOf(state);
    expect(two.structure, 'two tokens change no structure').toBe(one.structure);
    expect(two.resources[comboResourceKey('tokens', 'A', 'saproling-token')]).toBe(2);
    expect(one.structure).toContain('bear:A:U');
  });

  it('tapping a card changes the structure; mana in the pool and life are resources', () => {
    const state = anyState();
    const before = comboSignatureOf(state);
    state.battlefield.push({
      instanceId: state.nextInstanceId++,
      def: landDef('Forest', 'G'),
      controller: 'A',
      owner: 'A',
      zone: 'battlefield',
      tapped: false,
      summoningSick: false,
      damageMarked: 0,
      markedByDeathtouch: false,
      counters: {},
    });
    const untapped = comboSignatureOf(state);
    state.battlefield[state.battlefield.length - 1]!.tapped = true;
    state.players.A.manaPool = { ...state.players.A.manaPool, G: 1 };
    state.players.A.life = 25;
    const tapped = comboSignatureOf(state);
    expect(tapped.structure).not.toBe(untapped.structure);
    expect(before.structure).not.toBe(untapped.structure);
    expect(tapped.resources[MANA_A_G]).toBe(1);
    expect(tapped.resources[LIFE_A]).toBe(25);
    expect(untapped.resources[MANA_A_G]).toBeUndefined();
  });

  it('counters are a resource keyed by the permanent, and the label names it', () => {
    const state = anyState();
    const ballista = {
      id: 'walking-ballista',
      name: 'Walking Ballista',
      types: ['artifact' as const, 'creature' as const],
      power: 0,
      toughness: 0,
    };
    const inst = {
      instanceId: state.nextInstanceId++,
      def: ballista,
      controller: 'A' as const,
      owner: 'A' as const,
      zone: 'battlefield' as const,
      tapped: false,
      summoningSick: false,
      damageMarked: 0,
      markedByDeathtouch: false,
      counters: { '+1/+1': 3 },
    };
    state.battlefield.push(inst);
    const s = comboSignatureOf(state);
    const key = comboResourceKey('counters', 'A', `${inst.instanceId}:+1/+1`);
    expect(s.resources[key]).toBe(3);
    expect(parseComboResourceKey(key)).toEqual({ kind: 'counters', player: 'A', subject: `${inst.instanceId}:+1/+1` });
    // Through the detector, so the label is the one the prompt will show.
    const h = history(sig({ [key]: 1 }), [
      [activate('A', inst.instanceId), sig({ [key]: 2 })],
      [activate('A', inst.instanceId), sig({ [key]: 3 })],
    ]);
    const verdict = findComboLoop(h, state);
    expect(verdict.found && verdict.loop.deltas[0]!.label).toBe('+1 +1/+1 counter on Walking Ballista');
  });
});

describe('the named numbers and the phrasing funnel', () => {
  it('the cap, the default and the cycle bound are whole numbers in the right order', () => {
    expect(Number.isInteger(COMBO_REPEAT_CAP) && COMBO_REPEAT_CAP > 1).toBe(true);
    expect(COMBO_REPEAT_DEFAULT).toBeGreaterThanOrEqual(1);
    expect(COMBO_REPEAT_DEFAULT).toBeLessThanOrEqual(COMBO_REPEAT_CAP);
    expect(COMBO_MAX_CYCLE_ACTIONS).toBeGreaterThan(0);
  });

  it('describes a delta with its sign and a pluralised noun', () => {
    expect(describeComboDelta('life', { name: '' }, 3)).toBe('+3 life');
    expect(describeComboDelta('tokens', { name: 'Saproling' }, 1)).toBe('+1 Saproling');
    expect(describeComboDelta('mana', { name: 'G' }, 2)).toBe('+2 {G}');
    expect(describeComboDelta('hand', { name: '' }, -1)).toBe('−1 card in hand');
    expect(describeComboDelta('hand', { name: '' }, 2)).toBe('+2 cards in hand');
    expect(describeComboDelta('poison', { name: '' }, 1)).toBe('+1 poison counter');
  });
});

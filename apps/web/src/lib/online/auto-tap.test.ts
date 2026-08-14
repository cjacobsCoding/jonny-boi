/**
 * ONLINE auto-tap: the online seat must be able to cast a spell at all.
 *
 * The server only lists a `castSpell` once the caster's pool ALREADY covers the
 * cost, and the online board had no control that taps a land. So an online game
 * could play lands and attack, but every spell stayed uncastable forever — the
 * pool was permanently empty and no cast was ever offered.
 *
 * These drive the real engine + the real masked view: plan against the redacted
 * view the client actually receives, then apply the emitted actions through
 * `applyAction` exactly as the server would, and assert the spell resolves onto
 * the stack. If the sequence were illegal in any way the engine would reject it.
 */
import { describe, expect, it } from 'vitest';
import { buildRegistry, loadCardPool } from '@jonny-boi/cards';
import { maskStateForSeat } from '@jonny-boi/protocol';
import {
  applyAction,
  createGame,
  DEFAULT_RULES,
  generateLegalActions,
  poolTotal,
  type CardDefinition,
  type CardInstance,
  type GameAction,
  type GameState,
  type PlayerId,
} from '@jonny-boi/core';
import { castSequence, castableWithTaps } from './auto-tap.js';

const pool = loadCardPool({ onWarn: () => {} });
const registry = buildRegistry();

function card(name: string): CardDefinition {
  const found = pool.getByName(name);
  if (!found) throw new Error(`no pool card named "${name}"`);
  return found;
}

function place(state: GameState, def: CardDefinition, controller: PlayerId): CardInstance {
  const inst: CardInstance = {
    instanceId: state.nextInstanceId++,
    def,
    controller,
    owner: controller,
    zone: 'battlefield',
    tapped: false,
    summoningSick: false,
    damageMarked: 0,
    markedByDeathtouch: false,
    counters: {},
  };
  state.battlefield.push(inst);
  return inst;
}

function toHand(state: GameState, def: CardDefinition, controller: PlayerId): CardInstance {
  const inst: CardInstance = {
    instanceId: state.nextInstanceId++,
    def,
    controller,
    owner: controller,
    zone: 'hand',
    tapped: false,
    summoningSick: false,
    damageMarked: 0,
    markedByDeathtouch: false,
    counters: {},
  };
  state.players[controller].hand.push(inst);
  return inst;
}

/** A game in A's precombat main, sculpted by `build`. */
function sculpted(build: (state: GameState) => void): GameState {
  const forest = card('Forest');
  const { state } = createGame({
    seed: 5,
    decks: {
      A: { cards: Array.from({ length: 40 }, () => forest) },
      B: { cards: Array.from({ length: 40 }, () => forest) },
    },
    registry,
  });
  state.step = 'precombatMain';
  state.activePlayer = 'A';
  state.priorityPlayer = 'A';
  state.stack = [];
  state.players.A.hand = [];
  state.players.B.hand = [];
  build(state);
  return state;
}

/** Apply a client sequence the way the server does: in order, validating each. */
function applySequence(state: GameState, actions: readonly GameAction[]): GameState {
  let s = state;
  for (const action of actions) {
    const result = applyAction(s, action, DEFAULT_RULES, registry);
    const rejected = result.events.find((e) => e.type === 'actionRejected');
    if (rejected) throw new Error(`server rejected ${action.kind}: ${(rejected as { reason: string }).reason}`);
    s = result.state;
  }
  return s;
}

describe('the online seat can cast spells', () => {
  it('regression: the server offers NO cast while the pool is empty', () => {
    const state = sculpted((s) => {
      place(s, card('Mountain'), 'A');
      toHand(s, card('Lightning Bolt'), 'A');
    });
    const legal = generateLegalActions(state, DEFAULT_RULES);
    // This is the whole bug: nothing to click, and no way to tap for mana either.
    expect(legal.some((a) => a.kind === 'castSpell')).toBe(false);
    expect(poolTotal(state.players.A.manaPool)).toBe(0);
  });

  it('plans taps from the REDACTED view and casts an untargeted spell', () => {
    let finks!: CardInstance;
    const state = sculpted((s) => {
      for (let i = 0; i < 3; i++) place(s, card('Forest'), 'A');
      finks = toHand(s, card('Eternal Witness'), 'A'); // {1}{G}{G}
    });
    const masked = maskStateForSeat(state, 'A');
    const legal = generateLegalActions(state, DEFAULT_RULES);

    const sequence = castSequence(masked, 'A', finks, [], legal);
    expect(sequence, 'a fundable spell must produce a sequence').not.toBeNull();
    // Three taps then the cast — no more taps than the cost needs.
    expect(sequence!.filter((a) => a.kind === 'tapForMana')).toHaveLength(3);
    expect(sequence![sequence!.length - 1]!.kind).toBe('castSpell');

    const after = applySequence(state, sequence!);
    expect(after.stack).toHaveLength(1);
    expect(poolTotal(after.players.A.manaPool)).toBe(0); // nothing stranded
  });

  it('casts a TARGETED spell with a client-chosen target', () => {
    let bolt!: CardInstance;
    const state = sculpted((s) => {
      place(s, card('Mountain'), 'A');
      bolt = toHand(s, card('Lightning Bolt'), 'A');
    });
    const masked = maskStateForSeat(state, 'A');
    const legal = generateLegalActions(state, DEFAULT_RULES);

    const sequence = castSequence(masked, 'A', bolt, ['B'], legal);
    expect(sequence).not.toBeNull();
    const after = applySequence(state, sequence!);
    expect(after.stack).toHaveLength(1);
  });

  it('reports which hand cards become castable once we tap', () => {
    let bolt!: CardInstance;
    let giant!: CardInstance;
    const state = sculpted((s) => {
      place(s, card('Mountain'), 'A');
      bolt = toHand(s, card('Lightning Bolt'), 'A'); // {R} — one Mountain pays
      giant = toHand(s, card('Serra Angel'), 'A'); // {3}{W}{W} — nowhere near
    });
    const masked = maskStateForSeat(state, 'A');
    const legal = generateLegalActions(state, DEFAULT_RULES);

    const castable = castableWithTaps(masked, 'A', masked.players.A.hand ?? [], legal);
    expect(castable.has(bolt.instanceId)).toBe(true);
    expect(castable.has(giant.instanceId)).toBe(false);
  });

  it('offers nothing when the seat has no legal taps (not our priority window)', () => {
    const state = sculpted((s) => {
      place(s, card('Mountain'), 'A');
      toHand(s, card('Lightning Bolt'), 'A');
    });
    // B holds priority, so the server sends B no tap actions for A's permanents.
    const legalForB = generateLegalActions({ ...state, priorityPlayer: 'B' }, DEFAULT_RULES);
    const masked = maskStateForSeat(state, 'A');
    expect(castableWithTaps(masked, 'A', masked.players.A.hand ?? [], legalForB).size).toBe(0);
  });

  it('funds a coloured cost off a MODAL source (Birds of Paradise)', () => {
    let bolt!: CardInstance;
    const state = sculpted((s) => {
      place(s, card('Birds of Paradise'), 'A');
      bolt = toHand(s, card('Lightning Bolt'), 'A'); // needs {R}
    });
    const masked = maskStateForSeat(state, 'A');
    const legal = generateLegalActions(state, DEFAULT_RULES);

    const sequence = castSequence(masked, 'A', bolt, ['B'], legal);
    expect(sequence, 'the Bird can make {R}').not.toBeNull();
    const after = applySequence(state, sequence!);
    expect(after.stack).toHaveLength(1);
  });
});

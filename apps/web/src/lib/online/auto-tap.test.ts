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

/**
 * §3.60 shipped the "spare the useful source" preference to the ONLINE seat's
 * auto-tap as well as the hotseat's, but only the hotseat path was pinned — an
 * ablation of the online preference reddened nothing, so the online half of the
 * fix could have rotted silently. This is that missing pin, and it is the
 * reported complaint verbatim: "it's like auto choosing mana-elfs when it could
 * have chosen basic lands".
 */
describe('online auto-tap spares the useful sources (§3.60)', () => {
  it('taps the Forest and leaves the mana creature untapped when either could pay', () => {
    let bear!: CardInstance;
    let forest!: CardInstance;
    let elves!: CardInstance;
    const state = sculpted((s) => {
      forest = place(s, card('Forest'), 'A');
      elves = place(s, card('Llanowar Elves'), 'A');
      elves.summoningSick = false; // it has been around; tapping it IS an option
      bear = toHand(s, card('Grizzly Bears'), 'A'); // {1}{G} — needs both sources
      place(s, card('Forest'), 'A'); // the spare land that makes the choice real
    });
    const masked = maskStateForSeat(state, 'A');
    const legal = generateLegalActions(state, DEFAULT_RULES);

    const sequence = castSequence(masked, 'A', bear, [], legal);
    expect(sequence, 'two Forests can pay {1}{G} without the elf').not.toBeNull();

    const after = applySequence(state, sequence!);
    const elfAfter = after.battlefield.find((c) => c.instanceId === elves.instanceId);
    const forestAfter = after.battlefield.find((c) => c.instanceId === forest.instanceId);
    // The whole point: the body that can still block or attack is the one left up.
    expect(elfAfter?.tapped, 'the mana creature must be spared').toBe(false);
    expect(forestAfter?.tapped, 'a basic land should have paid instead').toBe(true);
  });
});

/**
 * §3.143 — PHYREXIAN MANA at the online seat.
 *
 * `{B/P}` is "{B}, or 2 life" (CR 107.4f), so a cast is one offer per fundable
 * life amount and the taps that fund one reading do not fund another. The
 * failure this pins is the silent one: a sequence that plans "{1}{B}{B}" and
 * then asks the server for a cast it never offered, or plans one land for the
 * life reading and submits a cast with no life on it — the server applies the
 * taps, refuses the cast, and the seat is left with tapped lands and no spell.
 *
 * The pool prints no Phyrexian card today (checked: zero), so the definition is
 * built here in Dismember's exact shape rather than looked up.
 */
const DISMEMBER: CardDefinition = {
  id: 'dismember',
  name: 'Dismember',
  types: ['instant'],
  timing: 'instant',
  cost: { generic: 1, hybrid: [['B', { life: 2 }], ['B', { life: 2 }]] },
  effects: [{ primitive: 'dealDamage', params: { amount: 5, targets: 'any' } }],
};

describe('online auto-tap and Phyrexian mana (§3.143)', () => {
  it('pays the life when the board cannot make black, and says so on the cast', () => {
    let dismember!: CardInstance;
    const state = sculpted((s) => {
      place(s, card('Mountain'), 'A');
      place(s, card('Mountain'), 'A');
      dismember = toHand(s, DISMEMBER, 'A');
    });
    const masked = maskStateForSeat(state, 'A');
    const legal = generateLegalActions(state, DEFAULT_RULES);
    const before = state.players.A.life;

    const sequence = castSequence(masked, 'A', dismember, ['B'], legal);
    expect(sequence, '{1} and 4 life is fundable off one Mountain').not.toBeNull();
    // ONE tap, not two: the plan is for the reading the cast will actually make.
    expect(sequence!.filter((a) => a.kind === 'tapForMana')).toHaveLength(1);
    const cast = sequence![sequence!.length - 1]!;
    expect(cast.kind === 'castSpell' ? cast.phyrexianLife : undefined).toBe(4);

    // The server accepts every step — which it would not if the cast asked for a
    // reading the taps had not funded.
    const after = applySequence(state, sequence!);
    expect(after.stack).toHaveLength(1);
    expect(after.players.A.life).toBe(before - 4);
  });

  it('spends NO life when the mana is there — cheapest reading first', () => {
    let dismember!: CardInstance;
    const state = sculpted((s) => {
      for (let i = 0; i < 3; i++) place(s, card('Swamp'), 'A');
      dismember = toHand(s, DISMEMBER, 'A');
    });
    const masked = maskStateForSeat(state, 'A');
    const legal = generateLegalActions(state, DEFAULT_RULES);
    const before = state.players.A.life;

    const sequence = castSequence(masked, 'A', dismember, ['B'], legal);
    expect(sequence).not.toBeNull();
    const cast = sequence![sequence!.length - 1]!;
    // No field at all, not a zero — the action every consumer has always seen.
    expect(cast.kind === 'castSpell' && 'phyrexianLife' in cast).toBe(false);
    expect(sequence!.filter((a) => a.kind === 'tapForMana')).toHaveLength(3);

    const after = applySequence(state, sequence!);
    expect(after.stack).toHaveLength(1);
    expect(after.players.A.life, 'life is not spent when mana will do').toBe(before);
  });

  it('reports the card castable-with-taps on the strength of its life reading', () => {
    let dismember!: CardInstance;
    const state = sculpted((s) => {
      place(s, card('Mountain'), 'A');
      dismember = toHand(s, DISMEMBER, 'A');
    });
    const masked = maskStateForSeat(state, 'A');
    const legal = generateLegalActions(state, DEFAULT_RULES);
    // The affordance and the sequence are one answer: a card that glows must
    // produce a sequence, and this board can only fund it with life.
    expect(castableWithTaps(masked, 'A', masked.players.A.hand ?? [], legal).has(dismember.instanceId)).toBe(true);
    expect(castSequence(masked, 'A', dismember, ['B'], legal)).not.toBeNull();
  });
});

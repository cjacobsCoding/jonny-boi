/**
 * ALTERNATIVE AND ADDITIONAL CASTING COSTS — cycling (CR 702.29), buyback
 * (CR 702.27) and madness (CR 702.35).
 *
 * The three are one branch because they are three answers to the same question:
 * what a card costs, and where it goes, when it is played by some route other
 * than "pay the printed cost from your hand". Each is pinned here by the
 * property that would break most silently:
 *
 *  1. **Cycling's discard is a COST, not an effect.** The card is gone from hand
 *     before the ability is on the stack, it goes through the SAME discard funnel
 *     every other discard uses (so madness and "whenever you cycle or discard"
 *     see it), and countering the ability would not give the card back.
 *  2. **Buyback and flashback agree about the exit from the stack**, because
 *     both read `spellLeaveDestination` — with the REASON, which is what makes a
 *     bought-back spell return to hand on resolution and go to the graveyard when
 *     it is countered.
 *  3. **Madness is a replacement on the discard**, not a cast-time choice: the
 *     card is exiled by whichever funnel discarded it, the window is state the
 *     legal-action generator answers with exactly two moves, and passing
 *     declines it into the graveyard rather than stranding it in exile.
 *  4. **Every new stack-object/state field survives the per-action clone.**
 *     `boughtBack` and `madnessWindow` are the field-by-field `clone.ts` trap
 *     that flashback and card-grants both fell into.
 */

import { describe, expect, it } from 'vitest';
import {
  applyAction,
  cloneState,
  createGame,
  DEFAULT_RULES,
  dumpState,
  generateLegalActions,
  spellLeaveDestination,
  type CardDefinition,
  type GameAction,
  type GameState,
  type SpellStackObject,
} from './index.js';
import { createEffectRegistry, type EffectRegistry } from './effects.js';
import { deckOf, giveHand, landDef } from './test-fixtures.js';
import { moveToZone } from './internal/zones.js';

const ISLAND = landDef('Island', 'U');
const SEED = 0xc7c1;

/** A cycling land — the corpus's most common shape (Barren Moor, a Triome). */
const CYCLING_LAND: CardDefinition = {
  id: 'cycling-land',
  name: 'Lonely Sandbar',
  types: ['land'],
  entersTapped: true,
  produces: ['U'],
  cycling: [{ cost: { U: 1 }, effects: [{ primitive: 'noteCycled' }], label: 'Cycling {U}' }],
};

/** A card printing TWO cycling abilities, so "which one" is part of the action. */
const TWO_CYCLERS: CardDefinition = {
  id: 'two-cyclers',
  name: 'Angel of the Ruins',
  types: ['creature'],
  power: 5,
  toughness: 4,
  cost: { generic: 5, W: 2 },
  cycling: [
    { cost: { generic: 2 }, effects: [{ primitive: 'noteCycled' }], label: 'Plainscycling {2}' },
    { cost: { generic: 4 }, effects: [{ primitive: 'noteCycled' }], label: 'Cycling {4}' },
  ],
};

/** Reiterate-shaped: an instant with buyback, printed {1}{U}, buyback {3}. */
const BUYBACK_INSTANT: CardDefinition = {
  id: 'buyback-instant',
  name: 'Reiterate',
  types: ['instant'],
  timing: 'instant',
  cost: { generic: 1, U: 1 },
  buyback: { generic: 3 },
  effects: [{ primitive: 'noteResolved' }],
};

/** A madness creature: printed {4}{U}, madness {1}{U}. */
const MADNESS_CREATURE: CardDefinition = {
  id: 'madness-creature',
  name: 'Basking Rootwalla',
  types: ['creature'],
  power: 2,
  toughness: 2,
  cost: { generic: 4, U: 1 },
  madness: { generic: 1, U: 1 },
};

/** A plain card with no madness — the control for the discard funnel. */
const PLAIN_CARD: CardDefinition = {
  id: 'plain-card',
  name: 'Plain Card',
  types: ['sorcery'],
  cost: { generic: 1 },
  effects: [{ primitive: 'noteResolved' }],
};

/** A sorcery whose script discards a card from its controller's hand — the
 * "a discard made by an EFFECT" funnel (the cards package's `moveOwnedCard`
 * equivalent, exercised here through core's own `moveToZone`). */
const DISCARDER: CardDefinition = {
  id: 'discarder',
  name: 'Tormenting Voice',
  types: ['sorcery'],
  cost: { generic: 1 },
  effects: [{ primitive: 'discardFirstCard' }],
};

function makeRegistry(): {
  reg: EffectRegistry;
  resolved: () => number;
  cycled: () => number;
} {
  const reg = createEffectRegistry();
  let resolvedCount = 0;
  let cycledCount = 0;
  reg.register('noteResolved', () => {
    resolvedCount += 1;
  });
  reg.register('noteCycled', () => {
    cycledCount += 1;
  });
  // Discards the controller's first hand card through core's zone funnel, which
  // is exactly what a real discard primitive does.
  reg.register('discardFirstCard', (ctx) => {
    const card = ctx.state.players[ctx.controller].hand[0];
    if (!card) return;
    // Core's own hand → graveyard funnel, which is what a real discard
    // primitive drives — the point being that madness applies to it without the
    // primitive knowing madness exists.
    moveToZone(ctx.state, card, 'graveyard', ctx.emit, ctx.controller);
  });
  return { reg, resolved: () => resolvedCount, cycled: () => cycledCount };
}

function act(state: GameState, action: GameAction, reg: EffectRegistry): GameState {
  const result = applyAction(state, action, DEFAULT_RULES, reg);
  const rejected = result.events.find((e) => e.type === 'actionRejected');
  if (rejected) {
    throw new Error(`unexpected rejection: ${(rejected as { reason: string }).reason}\n${dumpState(state)}`);
  }
  return result.state;
}

function rejection(state: GameState, action: GameAction, reg: EffectRegistry): string {
  const result = applyAction(state, action, DEFAULT_RULES, reg);
  const rejected = result.events.find((e) => e.type === 'actionRejected');
  expect(rejected, 'expected the action to be rejected').toBeDefined();
  return (rejected as { reason: string }).reason;
}

function pass(state: GameState, reg: EffectRegistry): GameState {
  return act(state, { kind: 'passPriority', player: state.priorityPlayer }, reg);
}

function resolveTop(state: GameState, reg: EffectRegistry): GameState {
  return pass(pass(state, reg), reg);
}

function gameAtMain(reg: EffectRegistry): GameState {
  const created = createGame({
    seed: SEED,
    startingPlayer: 'A',
    registry: reg,
    decks: { A: deckOf(ISLAND, 40), B: deckOf(ISLAND, 40) },
  });
  let state = created.state;
  let guard = 0;
  while (state.step !== 'precombatMain' && !state.gameOver && guard++ < 50) state = pass(state, reg);
  state.players.A.hand = [];
  state.players.B.hand = [];
  return state;
}

function fund(state: GameState, player: 'A' | 'B', pool: Partial<Record<'W' | 'U' | 'B' | 'R' | 'G' | 'C', number>>): void {
  state.players[player].manaPool = { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0, ...pool };
}

// --- cycling ---------------------------------------------------------------

describe('cycling — an activated ability from HAND', () => {
  it('is offered only when the pool covers the cycling cost, once per printed ability', () => {
    const { reg } = makeRegistry();
    const state = gameAtMain(reg);
    const [card] = giveHand(state, 'A', [TWO_CYCLERS]);

    expect(generateLegalActions(state, DEFAULT_RULES).some((a) => a.kind === 'cycleCard')).toBe(false);

    // {2} funds only the cheaper ability.
    fund(state, 'A', { C: 2 });
    const cheap = generateLegalActions(state, DEFAULT_RULES).filter((a) => a.kind === 'cycleCard');
    expect(cheap).toHaveLength(1);
    expect((cheap[0] as Extract<GameAction, { kind: 'cycleCard' }>).abilityIndex).toBe(0);

    fund(state, 'A', { C: 4 });
    const both = generateLegalActions(state, DEFAULT_RULES).filter(
      (a): a is Extract<GameAction, { kind: 'cycleCard' }> => a.kind === 'cycleCard',
    );
    expect(both).toHaveLength(2);
    expect(both.map((a) => a.abilityIndex)).toEqual([0, 1]);
    expect(both.every((a) => a.instanceId === card!.instanceId)).toBe(true);
  });

  it('pays the cost, discards the card as part of it, and resolves the ability', () => {
    const { reg, cycled } = makeRegistry();
    let state = gameAtMain(reg);
    const [card] = giveHand(state, 'A', [CYCLING_LAND]);
    fund(state, 'A', { U: 1 });

    state = act(state, { kind: 'cycleCard', player: 'A', instanceId: card!.instanceId }, reg);

    // The COST is fully paid the moment the ability is on the stack: mana gone,
    // card already in the graveyard, ability waiting to resolve.
    expect(state.players.A.manaPool.U).toBe(0);
    expect(state.players.A.hand).toHaveLength(0);
    expect(state.players.A.graveyard.map((c) => c.instanceId)).toEqual([card!.instanceId]);
    expect(state.stack).toHaveLength(1);
    expect(cycled()).toBe(0);

    state = resolveTop(state, reg);
    expect(cycled()).toBe(1);
    expect(state.stack).toHaveLength(0);
  });

  it('emits cardCycled, which is what a "when you cycle" trigger reads', () => {
    const { reg } = makeRegistry();
    const state = gameAtMain(reg);
    const [card] = giveHand(state, 'A', [CYCLING_LAND]);
    fund(state, 'A', { U: 1 });
    const result = applyAction(
      state,
      { kind: 'cycleCard', player: 'A', instanceId: card!.instanceId },
      DEFAULT_RULES,
      reg,
    );
    const cycledEvent = result.events.find((e) => e.type === 'cardCycled');
    expect(cycledEvent).toBeDefined();
    expect((cycledEvent as { name: string }).name).toBe('Lonely Sandbar');
  });

  it('is instant speed — a cycling LAND cycles on the opponent\'s turn, and is never PLAYED as a land off the cycling action', () => {
    const { reg } = makeRegistry();
    let state = gameAtMain(reg);
    const [card] = giveHand(state, 'B', [CYCLING_LAND]);
    fund(state, 'B', { U: 1 });
    state = pass(state, reg); // A passes; B holds priority on A's turn
    expect(state.priorityPlayer).toBe('B');
    const offers = generateLegalActions(state, DEFAULT_RULES);
    expect(offers.some((a) => a.kind === 'cycleCard')).toBe(true);
    // A land is never PLAYED by the non-active player, so this is unambiguously
    // the cycling ability and not a land drop.
    expect(offers.some((a) => a.kind === 'playLand')).toBe(false);
    state = act(state, { kind: 'cycleCard', player: 'B', instanceId: card!.instanceId }, reg);
    expect(state.players.B.graveyard).toHaveLength(1);
  });

  it('rejects cycling a card that is not in hand, has no such ability, or cannot be paid for', () => {
    const { reg } = makeRegistry();
    const state = gameAtMain(reg);
    const [cycler] = giveHand(state, 'A', [CYCLING_LAND]);
    const [plain] = giveHand(state, 'A', [PLAIN_CARD]);

    expect(rejection(state, { kind: 'cycleCard', player: 'A', instanceId: cycler!.instanceId }, reg)).toBe(
      'insufficient mana to cycle this card',
    );
    fund(state, 'A', { U: 1 });
    expect(rejection(state, { kind: 'cycleCard', player: 'A', instanceId: plain!.instanceId }, reg)).toBe(
      'that card has no such cycling ability',
    );
    expect(
      rejection(state, { kind: 'cycleCard', player: 'A', instanceId: cycler!.instanceId, abilityIndex: 3 }, reg),
    ).toBe('that card has no such cycling ability');
    expect(rejection(state, { kind: 'cycleCard', player: 'B', instanceId: cycler!.instanceId }, reg)).toBe(
      'you do not have priority',
    );
  });
});

// --- buyback ---------------------------------------------------------------

describe('buyback — an additional cost that changes where the spell goes', () => {
  it('asks at cast time and returns the card to HAND when paid', () => {
    const { reg, resolved } = makeRegistry();
    let state = gameAtMain(reg);
    const [card] = giveHand(state, 'A', [BUYBACK_INSTANT]);
    fund(state, 'A', { U: 1, C: 4 }); // printed {1}{U} + buyback {3}

    state = act(state, { kind: 'castSpell', player: 'A', instanceId: card!.instanceId }, reg);
    const choice = state.pendingChoice;
    expect(choice, 'the buyback question is asked at cast time').toBeTruthy();
    expect(choice!.kind).toBe('payMana');
    const spell = state.stack[0] as SpellStackObject;
    expect(spell.awaitingCastChoice).toBe('buyback');

    state = act(
      state,
      { kind: 'answerChoice', player: 'A', choiceId: choice!.id, answer: { kind: 'payMana', pay: true } },
      reg,
    );
    expect((state.stack[0] as SpellStackObject).boughtBack).toBe(true);
    // The buyback mana really was charged.
    expect(state.players.A.manaPool.C).toBe(0);

    state = resolveTop(state, reg);
    expect(resolved()).toBe(1);
    expect(state.players.A.hand.map((c) => c.instanceId)).toEqual([card!.instanceId]);
    expect(state.players.A.graveyard).toHaveLength(0);
  });

  it('declining leaves the printed behaviour: the spell goes to the graveyard', () => {
    const { reg } = makeRegistry();
    let state = gameAtMain(reg);
    const [card] = giveHand(state, 'A', [BUYBACK_INSTANT]);
    fund(state, 'A', { U: 1, C: 4 });
    state = act(state, { kind: 'castSpell', player: 'A', instanceId: card!.instanceId }, reg);
    state = act(
      state,
      {
        kind: 'answerChoice',
        player: 'A',
        choiceId: state.pendingChoice!.id,
        answer: { kind: 'payMana', pay: false },
      },
      reg,
    );
    expect((state.stack[0] as SpellStackObject).boughtBack).toBe(false);
    state = resolveTop(state, reg);
    expect(state.players.A.hand).toHaveLength(0);
    expect(state.players.A.graveyard.map((c) => c.instanceId)).toEqual([card!.instanceId]);
  });

  it('never asks a caster who cannot afford the buyback — the spell simply casts without it', () => {
    const { reg } = makeRegistry();
    let state = gameAtMain(reg);
    const [card] = giveHand(state, 'A', [BUYBACK_INSTANT]);
    fund(state, 'A', { U: 1, C: 1 }); // enough for the printed cost only
    state = act(state, { kind: 'castSpell', player: 'A', instanceId: card!.instanceId }, reg);
    expect(state.pendingChoice ?? null).toBeNull();
    expect((state.stack[0] as SpellStackObject).boughtBack).toBe(false);
  });

  it('is one answer with flashback, not two: countered means the graveyard, resolved means hand', () => {
    const boughtBack = {
      kind: 'spell',
      instanceId: 1,
      card: {} as never,
      controller: 'A',
      resolvesTo: 'graveyard',
      targets: [],
      boughtBack: true,
    } as unknown as SpellStackObject;
    expect(spellLeaveDestination(boughtBack, 'resolve')).toBe('hand');
    expect(spellLeaveDestination(boughtBack, 'counter')).toBe('graveyard');

    // Flashback outranks buyback either way — a card cast from the graveyard is
    // exiled however it leaves the stack (CR 702.34a).
    const flashedBack = { ...boughtBack, castFrom: 'graveyard' } as SpellStackObject;
    expect(spellLeaveDestination(flashedBack, 'resolve')).toBe('exile');
    expect(spellLeaveDestination(flashedBack, 'counter')).toBe('exile');
  });

  it('survives the per-action clone (the field-by-field clone.ts trap)', () => {
    const { reg } = makeRegistry();
    let state = gameAtMain(reg);
    const [card] = giveHand(state, 'A', [BUYBACK_INSTANT]);
    fund(state, 'A', { U: 1, C: 4 });
    state = act(state, { kind: 'castSpell', player: 'A', instanceId: card!.instanceId }, reg);
    state = act(
      state,
      {
        kind: 'answerChoice',
        player: 'A',
        choiceId: state.pendingChoice!.id,
        answer: { kind: 'payMana', pay: true },
      },
      reg,
    );
    const cloned = cloneState(state);
    expect((cloned.stack[0] as SpellStackObject).boughtBack).toBe(true);
  });
});

// --- madness ---------------------------------------------------------------

describe('madness — a replacement on the discard, then a cast from exile', () => {
  /** Discard A's only hand card through core's own zone funnel. */
  function discardViaEffect(state: GameState, reg: EffectRegistry, victim: CardDefinition): GameState {
    // The discarder's script takes hand[0], so the victim goes in first.
    giveHand(state, 'A', [victim]);
    const [discarder] = giveHand(state, 'A', [DISCARDER]);
    fund(state, 'A', { C: 1 });
    const cast = act(state, { kind: 'castSpell', player: 'A', instanceId: discarder!.instanceId }, reg);
    return resolveTop(cast, reg);
  }

  it('exiles a discarded madness card and opens a window; a plain card is simply discarded', () => {
    const { reg } = makeRegistry();
    let state = gameAtMain(reg);
    state = discardViaEffect(state, reg, MADNESS_CREATURE);
    expect(state.players.A.exile).toHaveLength(1);
    expect(state.players.A.graveyard.some((c) => c.def.id === MADNESS_CREATURE.id)).toBe(false);
    expect(state.madnessWindow?.controller).toBe('A');
    expect(state.priorityPlayer).toBe('A');

    const plain = gameAtMain(reg);
    const after = discardViaEffect(plain, reg, PLAIN_CARD);
    expect(after.players.A.exile).toHaveLength(0);
    expect(after.madnessWindow ?? null).toBeNull();
  });

  it('offers exactly two moves while the window stands, and refuses everything else', () => {
    const { reg } = makeRegistry();
    let state = gameAtMain(reg);
    state = discardViaEffect(state, reg, MADNESS_CREATURE);
    fund(state, 'A', { U: 1, C: 1 });

    const offers = generateLegalActions(state, DEFAULT_RULES);
    // Pass, the cast, and any mana source — a window that could not be funded
    // would be a trap rather than an offer.
    expect(offers.filter((a) => a.kind !== 'tapForMana')).toHaveLength(2);
    expect(offers.some((a) => a.kind === 'passPriority')).toBe(true);
    const cast = offers.find(
      (a): a is Extract<GameAction, { kind: 'castSpell' }> => a.kind === 'castSpell',
    );
    expect(cast!.fromZone).toBe('exile');

    // Anything else — including the opponent acting — is refused.
    expect(rejection(state, { kind: 'passPriority', player: 'B' }, reg)).toBe(
      'a madness window is awaiting its controller',
    );
  });

  it('casts from exile for the MADNESS cost, ignoring the card\'s own timing', () => {
    const { reg } = makeRegistry();
    let state = gameAtMain(reg);
    state = discardViaEffect(state, reg, MADNESS_CREATURE);
    const exiled = state.players.A.exile[0]!;
    fund(state, 'A', { U: 1, C: 1 }); // the madness cost {1}{U}, NOT the printed {4}{U}

    state = act(
      state,
      { kind: 'castSpell', player: 'A', instanceId: exiled.instanceId, fromZone: 'exile' },
      reg,
    );
    expect(state.madnessWindow ?? null).toBeNull();
    expect(state.players.A.exile).toHaveLength(0);
    expect(state.players.A.manaPool.U).toBe(0);
    const spell = state.stack[state.stack.length - 1] as SpellStackObject;
    expect(spell.castFrom).toBe('exile');
    expect(spell.resolvesTo).toBe('battlefield');

    state = resolveTop(state, reg);
    expect(state.battlefield.some((c) => c.def.id === MADNESS_CREATURE.id)).toBe(true);
  });

  it('passing DECLINES: the card falls into the graveyard the discard would have put it in', () => {
    const { reg } = makeRegistry();
    let state = gameAtMain(reg);
    state = discardViaEffect(state, reg, MADNESS_CREATURE);
    const exiledId = state.players.A.exile[0]!.instanceId;

    const result = applyAction(state, { kind: 'passPriority', player: 'A' }, DEFAULT_RULES, reg);
    state = result.state;
    expect(result.events.some((e) => e.type === 'madnessDeclined')).toBe(true);
    expect(state.madnessWindow ?? null).toBeNull();
    expect(state.players.A.exile).toHaveLength(0);
    expect(state.players.A.graveyard.some((c) => c.instanceId === exiledId)).toBe(true);
  });

  it('refuses a cast from exile with no window open, and one aimed at another card', () => {
    const { reg } = makeRegistry();
    let state = gameAtMain(reg);
    state = discardViaEffect(state, reg, MADNESS_CREATURE);
    const exiled = state.players.A.exile[0]!;
    fund(state, 'A', { U: 1, C: 1 });

    // Wrong seat.
    expect(
      rejection(state, { kind: 'castSpell', player: 'B', instanceId: exiled.instanceId, fromZone: 'exile' }, reg),
    ).toBe('a madness window is awaiting its controller');

    // Decline, then try again: no window, no cast.
    const declined = act(state, { kind: 'passPriority', player: 'A' }, reg);
    expect(
      rejection(
        declined,
        { kind: 'castSpell', player: 'A', instanceId: exiled.instanceId, fromZone: 'exile' },
        reg,
      ),
    ).toBe('that card is not in exile');
  });

  it('the open window survives the per-action clone', () => {
    const { reg } = makeRegistry();
    let state = gameAtMain(reg);
    state = discardViaEffect(state, reg, MADNESS_CREATURE);
    const cloned = cloneState(state);
    expect(cloned.madnessWindow).toEqual(state.madnessWindow);
    expect(cloned.madnessWindow).not.toBe(state.madnessWindow);
  });
});

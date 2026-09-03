/**
 * SUSPEND (CR 702.62) — the core half, on the real engine.
 *
 *  - the `suspendCard` SPECIAL ACTION: offered exactly when the card's own cast
 *    timing is open and the pool covers the suspend cost, legal for a card with
 *    no mana cost, and refused for everything the menu would not show;
 *  - what it does: pays, exiles the card with N time counters, and creates the
 *    exile-side upkeep ability as a DELAYED trigger whose body is the
 *    definition's `suspend.upkeep`;
 *  - the free-cast WINDOW: the cast costs nothing, ignores the card's own
 *    timing, gives a creature haste, and a decline leaves the card exiled.
 *
 * The tick that removes counters lives in the cards package (`suspendTick`) and
 * is pinned there on a real Rift Bolt; here a test body opens the window
 * directly, so what is under test is core alone.
 */

import { describe, expect, it } from 'vitest';
import {
  applyAction,
  createGame,
  DEFAULT_RULES,
  generateLegalActions,
  isSuspended,
  openSuspendWindow,
  TIME_COUNTER,
  type CardDefinition,
  type EffectContext,
  type GameAction,
  type GameState,
  type SpellStackObject,
} from './index.js';
import { createEffectRegistry, type EffectRegistry } from './effects.js';
import { creatureDef, deckOf, giveHand, landDef } from './test-fixtures.js';

const MOUNTAIN = landDef('Mountain', 'R');

/** A sorcery-speed 7-drop with Suspend 2—{R}; its tick is the test body below. */
const BEAST: CardDefinition = {
  ...creatureDef('beast', 7, 5, { cost: { generic: 5, R: 2 }, name: 'Suspended Beast' }),
  suspend: { count: 2, cost: { R: 1 }, upkeep: [{ primitive: 'tick' }] },
};

/** A card with NO mana cost — castable only ever through suspend. */
const VISION: CardDefinition = {
  id: 'vision',
  name: 'Costless Vision',
  types: ['sorcery'],
  timing: 'sorcery',
  // CR 202.1b — printed with NO mana cost, as the compiler marks Ancestral Vision.
  noManaCost: true,
  effects: [{ primitive: 'noteResolved' }],
  suspend: { count: 1, cost: { R: 1 }, upkeep: [{ primitive: 'tick' }] },
};

function registry(resolved: string[]): EffectRegistry {
  const reg = createEffectRegistry();
  reg.register('noteResolved', (ctx: EffectContext) => {
    resolved.push(ctx.source.def.name);
  });
  // A minimal tick: drop one time counter and open the window when none remain.
  reg.register('tick', (ctx: EffectContext) => {
    const card = ctx.source;
    if (!isSuspended(card)) return;
    const left = (card.counters[TIME_COUNTER] ?? 0) - 1;
    card.counters = { ...card.counters, [TIME_COUNTER]: left };
    if (left > 0) {
      ctx.createDelayedTrigger({ condition: { on: 'upkeep', who: 'you' }, effects: [{ primitive: 'tick' }], label: 'tick' });
      return;
    }
    openSuspendWindow(ctx.state, card, ctx.emit);
  });
  return reg;
}

function apply(state: GameState, action: GameAction, reg: EffectRegistry) {
  return applyAction(state, action, DEFAULT_RULES, reg);
}

function act(state: GameState, action: GameAction, reg: EffectRegistry): GameState {
  const result = apply(state, action, reg);
  const rejected = result.events.find((e) => e.type === 'actionRejected');
  if (rejected) throw new Error(`unexpected rejection: ${(rejected as { reason: string }).reason}`);
  return result.state;
}

function rejection(state: GameState, action: GameAction, reg: EffectRegistry): string | undefined {
  const rejected = apply(state, action, reg).events.find((e) => e.type === 'actionRejected');
  return rejected ? (rejected as { reason: string }).reason : undefined;
}

function pass(state: GameState, reg: EffectRegistry): GameState {
  return act(state, { kind: 'passPriority', player: state.priorityPlayer }, reg);
}

function until(state: GameState, reg: EffectRegistry, done: (s: GameState) => boolean): GameState {
  let s = state;
  for (let guard = 0; guard < 600; guard++) {
    if (done(s)) return s;
    if (s.gameOver) throw new Error('game ended first');
    if (s.pendingChoice) throw new Error('a question parked the game first');
    s = pass(s, reg);
  }
  throw new Error(`never reached the condition (turn ${s.turnNumber} ${s.step})`);
}

function gameAtMain(reg: EffectRegistry): GameState {
  const { state } = createGame({
    seed: 3,
    startingPlayer: 'A',
    registry: reg,
    decks: { A: deckOf(MOUNTAIN, 40), B: deckOf(MOUNTAIN, 40) },
  });
  const s = until(state, reg, (x) => x.step === 'precombatMain');
  s.players.A.hand = [];
  s.players.B.hand = [];
  return s;
}

function fund(state: GameState, player: 'A' | 'B', r: number): void {
  state.players[player].manaPool = { W: 0, U: 0, B: 0, R: r, G: 0, C: 0 };
}

const offered = (state: GameState, kind: GameAction['kind']) => generateLegalActions(state).some((a) => a.kind === kind);

describe('the suspend special action (CR 702.62a)', () => {
  it('is offered only once the pool covers the suspend cost, at the card’s own timing — and for a card with no mana cost', () => {
    const reg = registry([]);
    const state = gameAtMain(reg);
    giveHand(state, 'A', [BEAST, VISION]);
    expect(offered(state, 'suspendCard')).toBe(false);
    fund(state, 'A', 1);
    const suspends = generateLegalActions(state).filter((a) => a.kind === 'suspendCard');
    expect(suspends).toHaveLength(2);
    // The seven-drop itself is NOT castable on {R}; suspending it is.
    expect(offered(state, 'castSpell')).toBe(false);
    // Off the sorcery-speed window the offer disappears with the timing.
    const offTurn = until(state, reg, (s) => s.activePlayer === 'B' && s.priorityPlayer === 'A');
    fund(offTurn, 'A', 1);
    expect(offered(offTurn, 'suspendCard')).toBe(false);
    expect(rejection(offTurn, { kind: 'suspendCard', player: 'A', instanceId: state.players.A.hand[0]!.instanceId }, reg)).toMatch(
      /could begin to cast/,
    );
  });

  it('pays the cost, exiles the card with N time counters, and creates the exile-side upkeep ability', () => {
    const reg = registry([]);
    const state = gameAtMain(reg);
    const [beast] = giveHand(state, 'A', [BEAST]);
    fund(state, 'A', 1);
    const result = apply(state, { kind: 'suspendCard', player: 'A', instanceId: beast!.instanceId }, reg);
    const after = result.state;
    expect(after.players.A.manaPool.R).toBe(0);
    expect(after.players.A.hand).toHaveLength(0);
    const exiled = after.players.A.exile.find((c) => c.instanceId === beast!.instanceId)!;
    expect(exiled.counters[TIME_COUNTER]).toBe(2);
    expect(isSuspended(exiled)).toBe(true);
    expect(after.delayedTriggers?.map((d) => d.ability.label)).toEqual(['Suspend: Suspended Beast']);
    expect(after.delayedTriggers?.[0]?.sourceInstanceId).toBe(beast!.instanceId);
    expect(result.events.map((e) => e.type)).toContain('cardSuspended');
    // A special action uses no stack and keeps priority.
    expect(after.stack).toHaveLength(0);
    expect(after.priorityPlayer).toBe('A');
  });

  it('refuses a card that is not in hand, has no suspend, or cannot be paid for', () => {
    const reg = registry([]);
    const state = gameAtMain(reg);
    const [beast, plain] = giveHand(state, 'A', [BEAST, creatureDef('plain', 1, 1)]);
    expect(rejection(state, { kind: 'suspendCard', player: 'A', instanceId: beast!.instanceId }, reg)).toBe(
      'insufficient mana to pay the suspend cost',
    );
    fund(state, 'A', 1);
    expect(rejection(state, { kind: 'suspendCard', player: 'A', instanceId: plain!.instanceId }, reg)).toBe(
      'that card has no suspend',
    );
    expect(rejection(state, { kind: 'suspendCard', player: 'A', instanceId: 424_242 }, reg)).toBe(
      'that card is not in your hand',
    );
  });
});

describe('the free-cast window when the last time counter leaves', () => {
  /** Suspend the beast on turn 1 and run to the upkeep whose tick opens the window. */
  function windowOpen(reg: EffectRegistry): GameState {
    const state = gameAtMain(reg);
    const [beast] = giveHand(state, 'A', [BEAST]);
    fund(state, 'A', 1);
    let s = act(state, { kind: 'suspendCard', player: 'A', instanceId: beast!.instanceId }, reg);
    // Turn 3's upkeep: 2 → 1. Turn 5's upkeep: 1 → 0, window.
    s = until(s, reg, (x) => x.turnNumber === 3 && x.step === 'draw');
    expect(s.players.A.exile[0]!.counters[TIME_COUNTER]).toBe(1);
    s = until(s, reg, (x) => x.madnessWindow?.kind === 'suspend');
    return s;
  }

  it('opens as the tick resolves, on the suspending player’s upkeep, and freezes the game for them', () => {
    const reg = registry([]);
    const s = windowOpen(reg);
    expect(s.turnNumber).toBe(5);
    expect(s.step).toBe('upkeep');
    expect(s.priorityPlayer).toBe('A');
    expect(s.madnessWindow).toMatchObject({ controller: 'A', kind: 'suspend' });
    const menu = generateLegalActions(s).filter((a) => a.kind !== 'tapForMana');
    expect(menu.map((a) => a.kind).sort()).toEqual(['castSpell', 'passPriority']);
    expect(rejection(s, { kind: 'passPriority', player: 'B' }, reg)).toBe('a madness window is awaiting its controller');
  });

  it('casts the card for NOTHING, ignoring its cost and its sorcery timing, and a creature enters with haste', () => {
    const reg = registry([]);
    const s = windowOpen(reg);
    const exiled = s.players.A.exile[0]!;
    // An empty pool and no untapped land: the seven-drop is still castable.
    expect(s.players.A.manaPool.R).toBe(0);
    let after = act(s, { kind: 'castSpell', player: 'A', instanceId: exiled.instanceId, fromZone: 'exile' }, reg);
    expect(after.madnessWindow ?? null).toBeNull();
    const spell = after.stack[after.stack.length - 1] as SpellStackObject;
    expect(spell.castFrom).toBe('exile');
    expect(spell.hasteOnEntry).toBe(true);
    after = pass(after, reg);
    after = pass(after, reg);
    const beast = after.battlefield.find((c) => c.def.name === 'Suspended Beast')!;
    expect(beast).toBeDefined();
    // "It gains haste until you lose control of it" — it enters unsick.
    expect(beast.summoningSick).toBe(false);
  });

  it('passing DECLINES: the card remains exiled with no time counters, and the game moves on', () => {
    const reg = registry([]);
    const s = windowOpen(reg);
    const result = apply(s, { kind: 'passPriority', player: 'A' }, reg);
    const after = result.state;
    expect(after.madnessWindow ?? null).toBeNull();
    expect(after.players.A.exile).toHaveLength(1);
    expect(after.players.A.exile[0]!.counters[TIME_COUNTER]).toBe(0);
    expect(isSuspended(after.players.A.exile[0]!)).toBe(false);
    expect(result.events.map((e) => e.type)).toContain('suspendDeclined');
    expect(after.players.A.graveyard).toHaveLength(0);
    // No second window ever comes: the delayed ability is spent.
    expect(after.delayedTriggers ?? []).toHaveLength(0);
  });

  it('a no-cost card goes the whole way: suspended, ticked, cast free, resolved', () => {
    const resolved: string[] = [];
    const reg = registry(resolved);
    const state = gameAtMain(reg);
    const [vision] = giveHand(state, 'A', [VISION]);
    fund(state, 'A', 1);
    let s = act(state, { kind: 'suspendCard', player: 'A', instanceId: vision!.instanceId }, reg);
    s = until(s, reg, (x) => x.madnessWindow?.kind === 'suspend');
    expect(s.turnNumber).toBe(3);
    s = act(s, { kind: 'castSpell', player: 'A', instanceId: vision!.instanceId, fromZone: 'exile' }, reg);
    s = pass(s, reg);
    s = pass(s, reg);
    expect(resolved).toEqual(['Costless Vision']);
    expect(s.players.A.graveyard.map((c) => c.def.name)).toEqual(['Costless Vision']);
  });
});

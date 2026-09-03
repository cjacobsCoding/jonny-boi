/**
 * §3.123 — A MADNESS WINDOW HOLDING A **LAND** OFFERS A LAND PLAY, NOT A CAST.
 *
 * Madlands (the pool's only land with madness) prints "Madness {0} … play it
 * for its madness cost … You can play a land only during your turn and only if
 * you have an available land play remaining." The window's menu had only ever
 * held casts, so it offered a `castSpell fromZone: 'exile'` — and `applyCastSpell`
 * answered with the flat refusal every land gets, **"lands are played, not cast"**.
 *
 * That is the §3.36 class in its purest form: an action on the menu that the
 * apply path refuses. It cost the pilot the whole window (the soak's
 * `noRejectedActions`, seed 2348957995, on the 6,257-card pool), because a
 * rejection is not a free retry — the harness passes priority after
 * `maxConsecutiveRejectedActions` and the discarded land is buried.
 *
 * Every assertion below is about the OFFER AND THE ACCEPT AGREEING: the exact
 * rejection is pinned as the thing that must no longer happen, the offered
 * action is applied and must be accepted, and the land-play window's four
 * conditions gate the offer the same way they gate the play.
 */

import { describe, expect, it } from 'vitest';
import {
  applyAction,
  createGame,
  DEFAULT_RULES,
  discardDestination,
  generateLegalActions,
  type CardDefinition,
  type CardInstance,
  type GameAction,
  type GameEvent,
  type GameState,
} from './index.js';
import { createEffectRegistry, type EffectRegistry } from './effects.js';
import { deckOf, giveHand, landDef } from './test-fixtures.js';

const FOREST = landDef('Forest', 'G');

/** Madlands: a land whose madness cost is free (the printed {0}). */
const MADLANDS: CardDefinition = {
  id: 'madlands',
  name: 'Madlands',
  types: ['land'],
  entersTapped: true,
  madness: { generic: 0 },
  producesOptions: [{ B: 1 }, { R: 1 }],
};

/** A land with a madness cost that is NOT free, to prove the cost is really paid. */
const PRICEY: CardDefinition = { ...MADLANDS, id: 'pricey', name: 'Pricey Madlands', madness: { G: 1 } };

function reg(): EffectRegistry {
  return createEffectRegistry();
}

function apply(state: GameState, action: GameAction, r: EffectRegistry) {
  return applyAction(state, action, DEFAULT_RULES, r);
}

function rejection(state: GameState, action: GameAction, r: EffectRegistry): string | undefined {
  const rejected = apply(state, action, r).events.find((e) => e.type === 'actionRejected');
  return rejected ? (rejected as { reason: string }).reason : undefined;
}

function act(state: GameState, action: GameAction, r: EffectRegistry): GameState {
  const result = apply(state, action, r);
  const rejected = result.events.find((e) => e.type === 'actionRejected');
  if (rejected) throw new Error(`unexpected rejection: ${(rejected as { reason: string }).reason}`);
  return result.state;
}

function gameAtMain(r: EffectRegistry): GameState {
  const { state } = createGame({
    seed: 11,
    startingPlayer: 'A',
    registry: r,
    decks: { A: deckOf(FOREST, 40), B: deckOf(FOREST, 40) },
  });
  let s = state;
  for (let guard = 0; guard < 200 && s.step !== 'precombatMain'; guard++) {
    s = act(s, { kind: 'passPriority', player: s.priorityPlayer }, r);
  }
  s.players.A.hand = [];
  s.players.B.hand = [];
  return s;
}

/**
 * Discard `def` from A's hand through the REAL discard funnel, so the window is
 * opened by the rule under test rather than assigned by the test.
 */
function windowOn(state: GameState, def: CardDefinition): { state: GameState; card: CardInstance } {
  const [card] = giveHand(state, 'A', [def]);
  const events: GameEvent[] = [];
  const zone = discardDestination(state, card as CardInstance, (e) => events.push(e));
  expect(zone).toBe('exile');
  state.players.A.hand = state.players.A.hand.filter((c) => c.instanceId !== card!.instanceId);
  (card as CardInstance).zone = 'exile';
  state.players.A.exile.push(card as CardInstance);
  state.priorityPlayer = 'A';
  return { state, card: card as CardInstance };
}

describe('a madness window holding a land (§3.123)', () => {
  it('offers a PLAY, never a cast — and the cast the menu used to hold is still refused', () => {
    const r = reg();
    const { state, card } = windowOn(gameAtMain(r), MADLANDS);
    const menu = generateLegalActions(state).filter((a) => a.kind !== 'tapForMana');
    expect(menu.map((a) => a.kind).sort()).toEqual(['passPriority', 'playLand']);
    // THE LITERAL REJECTION THIS FIX EXISTS FOR. It stays a rejection — a land
    // is never cast — but nothing offers it any more.
    expect(rejection(state, { kind: 'castSpell', player: 'A', instanceId: card.instanceId, fromZone: 'exile' }, r)).toBe(
      'lands are played, not cast',
    );
  });

  it('APPLIES the offered play: the land enters, the window closes, the land drop is spent', () => {
    const r = reg();
    const { state, card } = windowOn(gameAtMain(r), MADLANDS);
    const play = generateLegalActions(state).find((a) => a.kind === 'playLand');
    expect(play).toBeDefined();
    const before = state.players.A.landsPlayedThisTurn;
    // Applied exactly as offered — this is the assertion the soak invariant makes.
    const after = act(state, play as GameAction, r);
    expect(after.madnessWindow ?? null).toBeNull();
    expect(after.players.A.exile.some((c) => c.instanceId === card.instanceId)).toBe(false);
    const played = after.battlefield.find((c) => c.instanceId === card.instanceId);
    expect(played).toBeDefined();
    expect(played?.controller).toBe('A');
    expect(played?.tapped).toBe(true); // Madlands enters tapped
    expect(after.players.A.landsPlayedThisTurn).toBe(before + 1);
  });

  it('is not offered when the land-play window is shut, and passing then buries the card', () => {
    const r = reg();
    const opened = windowOn(gameAtMain(r), MADLANDS);
    // Land drop already spent: the same four conditions `applyPlayLand` refuses by.
    opened.state.players.A.landsPlayedThisTurn = 1;
    expect(generateLegalActions(opened.state).some((a) => a.kind === 'playLand')).toBe(false);
    expect(
      rejection(opened.state, { kind: 'playLand', player: 'A', instanceId: opened.card.instanceId, fromZone: 'exile' }, r),
    ).toBe('no land plays remaining this turn');
    const declined = act(opened.state, { kind: 'passPriority', player: 'A' }, r);
    expect(declined.madnessWindow ?? null).toBeNull();
    expect(declined.players.A.graveyard.some((c) => c.instanceId === opened.card.instanceId)).toBe(true);
  });

  it('charges the madness cost — an unaffordable one is neither offered nor accepted', () => {
    const r = reg();
    const { state, card } = windowOn(gameAtMain(r), PRICEY);
    expect(state.players.A.manaPool.G).toBe(0);
    expect(generateLegalActions(state).some((a) => a.kind === 'playLand')).toBe(false);
    expect(rejection(state, { kind: 'playLand', player: 'A', instanceId: card.instanceId, fromZone: 'exile' }, r)).toBe(
      'insufficient mana for the madness cost',
    );
    state.players.A.manaPool = { W: 0, U: 0, B: 0, R: 0, G: 1, C: 0 };
    const play = generateLegalActions(state).find((a) => a.kind === 'playLand');
    expect(play).toBeDefined();
    const after = act(state, play as GameAction, r);
    expect(after.players.A.manaPool.G).toBe(0); // the cost was actually paid
    expect(after.battlefield.some((c) => c.instanceId === card.instanceId)).toBe(true);
  });

  it('meets the split-second lock like any other menu', () => {
    const r = reg();
    // The window's menu was the ONE exit of `generateLegalActions` that the
    // CR 702.61 filter never reached, so a split-second spell standing while a
    // window was open offered a cast the wall then refused (§3.123).
    //
    // ⚠️ AND THE LAND PLAY GOES TOO — not because 702.61 locks it (it does not;
    // a land play is a special action, CR 115.2a) but because CR 305.1 needs an
    // EMPTY stack and this lock needs a non-empty one. The two can never
    // coexist, which is why neither the engine filter nor the pilot's gate
    // carves out an exception for it.
    const madnessLand = windowOn(gameAtMain(r), MADLANDS);
    const locker: CardDefinition = {
      id: 'locker',
      name: 'Split Second Elemental',
      types: ['creature'],
      power: 3,
      toughness: 2,
      cost: { R: 1 },
      keywords: { flash: true, splitSecond: true },
    };
    const [spell] = giveHand(madnessLand.state, 'B', [locker]);
    madnessLand.state.players.B.hand = [];
    (spell as { zone: string }).zone = 'stack';
    madnessLand.state.stack.push({ kind: 'spell', instanceId: spell!.instanceId, controller: 'B', card: spell!, targets: [] } as never);
    const menu = generateLegalActions(madnessLand.state).filter((a) => a.kind !== 'tapForMana');
    expect(menu.map((a) => a.kind).sort()).toEqual(['passPriority']);

    // A NONLAND in the same window is a cast, and the lock takes it away.
    const instant: CardDefinition = {
      id: 'madinstant',
      name: 'Mad Instant',
      types: ['instant'],
      timing: 'instant',
      cost: { G: 1 },
      madness: { generic: 0 },
      effects: [],
    };
    const nonland = windowOn(gameAtMain(r), instant);
    const [locker2] = giveHand(nonland.state, 'B', [locker]);
    nonland.state.players.B.hand = [];
    (locker2 as { zone: string }).zone = 'stack';
    nonland.state.stack.push({ kind: 'spell', instanceId: locker2!.instanceId, controller: 'B', card: locker2!, targets: [] } as never);
    expect(generateLegalActions(nonland.state).some((a) => a.kind === 'castSpell')).toBe(false);
  });

  it('still freezes the game for everyone else while it stands', () => {
    const r = reg();
    const { state, card } = windowOn(gameAtMain(r), MADLANDS);
    expect(rejection(state, { kind: 'passPriority', player: 'B' }, r)).toBe('a madness window is awaiting its controller');
    // …and B cannot play A's land either.
    expect(rejection(state, { kind: 'playLand', player: 'B', instanceId: card.instanceId, fromZone: 'exile' }, r)).toBe(
      'a madness window is awaiting its controller',
    );
  });
});

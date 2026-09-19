/**
 * THE SECOND CASTABLE HALF — split cards (CR 709), aftermath (CR 702.127),
 * adventurer cards (CR 715) and a Siege's reward (CR 310.4).
 *
 * Four printed layouts, ONE model: a definition may carry a second half that is
 * really cast, plus a list of the zones that half may be cast FROM, plus — for
 * the two halves you earn rather than hold — a per-instance PERMISSION recorded
 * as a card grant. What each test here pins is the thing that would otherwise
 * silently play a strictly different card:
 *
 *  1. **A split card off the stack is neither half** (CR 709.4). Its mana value,
 *     colours and type line are the COMBINED ones, which is what a discard
 *     filter, a cost-reduction and a "creature card with mana value 3 or less"
 *     read. Casting one swaps in the half being cast and nothing else.
 *  2. **Aftermath is a zone list, not a flashback.** The right half is offered
 *     from the graveyard and NOT from hand, pays its OWN printed cost (not a
 *     flashback cost it does not print), and is exiled on the way out.
 *  3. **An adventure exiles its card as it RESOLVES, not when countered**, and
 *     leaves behind permission to cast the creature half from exile. The
 *     permission names one face: the other is refused.
 *  4. **A defeated Siege is exiled rather than buried**, with permission to cast
 *     its reward half from exile WITHOUT paying — and a plain battle, which has
 *     no reward, still goes to the graveyard.
 *  5. **The permission dies with the object (CR 400.7)** and survives the
 *     per-action clone (the field-by-field `clone.ts` trap).
 */

import { describe, expect, it } from 'vitest';
import {
  applyAction,
  castPermissionFor,
  cloneState,
  createGame,
  DEFAULT_RULES,
  dumpState,
  generateLegalActions,
  convertedManaCost,
  playableFaceOf,
  spellLeaveDestination,
  type CardDefinition,
  type CardInstance,
  type GameAction,
  type GameState,
  type SpellStackObject,
} from './index.js';
import { createEffectRegistry, type EffectRegistry } from './effects.js';
import { deckOf, giveGraveyard, giveHand, landDef } from './test-fixtures.js';

const ISLAND = landDef('Island', 'U');
const SEED = 0x5911;

/** "Fire" — the left half, {1}{R}, an instant. */
const FIRE: CardDefinition = {
  id: 'fire',
  name: 'Fire',
  types: ['instant'],
  timing: 'instant',
  cost: { generic: 1, R: 1 },
  effects: [{ primitive: 'noteLeft' }],
};

/** "Ice" — the right half, {1}{U}, an instant. */
const ICE: CardDefinition = {
  id: 'fire#back',
  name: 'Ice',
  types: ['instant'],
  timing: 'instant',
  cost: { generic: 1, U: 1 },
  effects: [{ primitive: 'noteRight' }],
  isBackFace: true,
};

/**
 * "Fire // Ice" as the compiler builds it: the CR 709.4 combined object, not
 * castable itself, with both halves hanging off it.
 */
const FIRE_ICE: CardDefinition = {
  id: 'fire-ice',
  name: 'Fire // Ice',
  types: ['instant'],
  cost: { generic: 2, R: 1, U: 1 },
  frontFace: FIRE,
  backFace: ICE,
  backFaceCastable: true,
};

/** "Dusk // Dawn": the right half is castable only from the graveyard. */
const DUSK: CardDefinition = {
  id: 'dusk',
  name: 'Dusk',
  types: ['sorcery'],
  cost: { generic: 2, W: 2 },
  effects: [{ primitive: 'noteLeft' }],
};
const DAWN: CardDefinition = {
  id: 'dusk#back',
  name: 'Dawn',
  types: ['sorcery'],
  cost: { generic: 3, W: 2 },
  effects: [{ primitive: 'noteRight' }],
  isBackFace: true,
};
const DUSK_DAWN: CardDefinition = {
  id: 'dusk-dawn',
  name: 'Dusk // Dawn',
  types: ['sorcery'],
  cost: { generic: 5, W: 4 },
  frontFace: DUSK,
  backFace: DAWN,
  backFaceCastable: true,
  backFaceCastZones: ['graveyard'],
};

/** "Bonecrusher Giant // Stomp": a creature whose back half is an Adventure. */
const STOMP: CardDefinition = {
  id: 'giant#back',
  name: 'Stomp',
  types: ['instant'],
  timing: 'instant',
  cost: { generic: 1, R: 1 },
  effects: [{ primitive: 'noteRight' }],
  isBackFace: true,
  adventure: true,
};
const BONECRUSHER: CardDefinition = {
  id: 'giant',
  name: 'Bonecrusher Giant',
  types: ['creature'],
  cost: { generic: 2, R: 1 },
  power: 4,
  toughness: 3,
  backFace: STOMP,
  backFaceCastable: true,
};

/** A Siege: a 1-defense battle whose reward half is a free cast from exile. */
const REWARD_CREATURE: CardDefinition = {
  id: 'siege#back',
  name: 'Zilortha, Apex of Ikoria',
  types: ['creature'],
  power: 7,
  toughness: 5,
  isBackFace: true,
};
const SIEGE: CardDefinition = {
  id: 'siege',
  name: 'Invasion of Ikoria',
  types: ['battle'],
  subtypes: ['siege'],
  cost: { generic: 1, G: 1 },
  defense: 1,
  backFace: REWARD_CREATURE,
  backFaceCastable: true,
  backFaceCastZones: ['exile'],
  backFaceFreeCast: true,
};

/** A do-nothing instant, used purely to make a resolution happen. */
const NOOP_INSTANT: CardDefinition = {
  id: 'noop',
  name: 'Poke',
  types: ['instant'],
  timing: 'instant',
  cost: { generic: 1 },
};

/** A battle with NO reward — the control for the Siege exile. */
const PLAIN_BATTLE: CardDefinition = {
  id: 'plain-battle',
  name: 'Plain Invasion',
  types: ['battle'],
  cost: { generic: 1, G: 1 },
  defense: 1,
};

interface Harness {
  readonly reg: EffectRegistry;
  readonly left: () => number;
  readonly right: () => number;
}

function makeRegistry(): Harness {
  const reg = createEffectRegistry();
  let left = 0;
  let right = 0;
  reg.register('noteLeft', () => {
    left += 1;
  });
  reg.register('noteRight', () => {
    right += 1;
  });
  return { reg, left: () => left, right: () => right };
}

function act(state: GameState, action: GameAction, reg: EffectRegistry): GameState {
  const result = applyAction(state, action, DEFAULT_RULES, reg);
  const rejected = result.events.find((e) => e.type === 'actionRejected');
  if (rejected) throw new Error(`unexpected rejection: ${(rejected as { reason: string }).reason}\n${dumpState(state)}`);
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

/** A pool big enough for anything in this file. */
function fund(state: GameState, player: 'A' | 'B'): void {
  state.players[player].manaPool = { W: 4, U: 4, B: 4, R: 4, G: 4, C: 8 };
}

const casts = (state: GameState, instanceId: number): GameAction[] =>
  generateLegalActions(state)
    .filter((a): a is Extract<GameAction, { kind: 'castSpell' }> => a.kind === 'castSpell')
    .filter((a) => a.instanceId === instanceId);

describe('split cards — one card, two halves, CR 709.4 characteristics off the stack', () => {
  it('is neither half while it sits in a zone: the combined name, types and mana value', () => {
    // The whole reason a split card is modelled with the COMBINED object as the
    // definition rather than with its left half: every characteristic read of a
    // card in hand — a discard filter, a cost reduction, "mana value 3 or less"
    // — goes through `card.def`, and CR 709.4 says that object is both halves.
    expect(FIRE_ICE.name).toBe('Fire // Ice');
    expect(convertedManaCost(FIRE_ICE.cost!)).toBe(convertedManaCost(FIRE.cost!) + convertedManaCost(ICE.cost!));
    // …and it is not itself castable: `playableFaceOf` hands back a HALF.
    expect(playableFaceOf(FIRE_ICE, 'front')).toBe(FIRE);
    expect(playableFaceOf(FIRE_ICE, 'back')).toBe(ICE);
    expect(playableFaceOf(FIRE_ICE, undefined)).toBe(FIRE);
  });

  it('offers BOTH halves from hand, each on its own terms', () => {
    const { reg } = makeRegistry();
    const state = gameAtMain(reg);
    const [card] = giveHand(state, 'A', [FIRE_ICE]);
    fund(state, 'A');
    const offers = casts(state, card!.instanceId);
    expect(offers).toHaveLength(2);
    expect(offers.some((a) => a.face === undefined)).toBe(true);
    expect(offers.some((a) => a.face === 'back')).toBe(true);
  });

  it('casting a half runs THAT half and pays THAT half — not the combined cost', () => {
    const { reg, left, right } = makeRegistry();
    let state = gameAtMain(reg);
    const [card] = giveHand(state, 'A', [FIRE_ICE]);
    state.players.A.manaPool = { W: 0, U: 1, B: 0, R: 0, G: 0, C: 1 };
    state = act(state, { kind: 'castSpell', player: 'A', instanceId: card!.instanceId, face: 'back' }, reg);
    // The stack object IS the right half — name, types and script all follow.
    const spell = state.stack[0] as SpellStackObject;
    expect(spell.card.def.name).toBe('Ice');
    // Exactly the right half's cost left the pool; the combined cost would have
    // been unpayable from this pool at all.
    expect(state.players.A.manaPool).toEqual({ W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 });
    state = resolveTop(state, reg);
    expect(right()).toBe(1);
    expect(left()).toBe(0);
  });

  it('reverts to the combined object when the card leaves the stack (CR 712.8a-style)', () => {
    const { reg } = makeRegistry();
    let state = gameAtMain(reg);
    const [card] = giveHand(state, 'A', [FIRE_ICE]);
    fund(state, 'A');
    state = act(state, { kind: 'castSpell', player: 'A', instanceId: card!.instanceId, face: 'back' }, reg);
    state = resolveTop(state, reg);
    const buried = state.players.A.graveyard.find((c) => c.instanceId === card!.instanceId);
    expect(buried?.def.name).toBe('Fire // Ice');
  });
});

describe('aftermath — the right half is cast ONLY from the graveyard (CR 702.127a)', () => {
  it('is not offered from hand, and is refused if a client asks anyway', () => {
    const { reg } = makeRegistry();
    const state = gameAtMain(reg);
    const [card] = giveHand(state, 'A', [DUSK_DAWN]);
    fund(state, 'A');
    const offers = casts(state, card!.instanceId);
    expect(offers).toHaveLength(1);
    expect(offers[0]!.face).toBeUndefined();
    const reason = rejection(
      state,
      { kind: 'castSpell', player: 'A', instanceId: card!.instanceId, face: 'back' },
      reg,
    );
    expect(reason).toContain('cannot be cast from your hand');
  });

  it('is offered from the graveyard for its OWN cost — not a flashback cost it does not print', () => {
    const { reg, right } = makeRegistry();
    let state = gameAtMain(reg);
    const [card] = giveGraveyard(state, 'A', [DUSK_DAWN]);
    // Exactly {3}{W}{W}: enough for the right half, not a symbol more.
    state.players.A.manaPool = { W: 2, U: 0, B: 0, R: 0, G: 0, C: 3 };
    const offers = casts(state, card!.instanceId);
    expect(offers).toHaveLength(1);
    expect(offers[0]!.face).toBe('back');
    expect(offers[0]!.fromZone).toBe('graveyard');
    state = act(state, offers[0]!, reg);
    expect(state.players.A.manaPool).toEqual({ W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 });
    state = resolveTop(state, reg);
    expect(right()).toBe(1);
    // "Then exile it" — the graveyard cast's own exile replacement, unchanged.
    expect(state.players.A.exile.some((c) => c.instanceId === card!.instanceId)).toBe(true);
    expect(state.players.A.graveyard).toHaveLength(0);
  });

  it('does not make the LEFT half castable from the graveyard', () => {
    const { reg } = makeRegistry();
    const state = gameAtMain(reg);
    const [card] = giveGraveyard(state, 'A', [DUSK_DAWN]);
    fund(state, 'A');
    const reason = rejection(state, { kind: 'castSpell', player: 'A', instanceId: card!.instanceId, fromZone: 'graveyard' }, reg);
    expect(reason).toContain('no flashback');
  });
});

describe('adventures — exile on resolution, cast the creature later (CR 715.3d)', () => {
  it('exiles the card as the adventure RESOLVES and leaves permission behind', () => {
    const { reg, right } = makeRegistry();
    let state = gameAtMain(reg);
    const [card] = giveHand(state, 'A', [BONECRUSHER]);
    fund(state, 'A');
    state = act(state, { kind: 'castSpell', player: 'A', instanceId: card!.instanceId, face: 'back' }, reg);
    state = resolveTop(state, reg);
    expect(right()).toBe(1);
    const exiled = state.players.A.exile.find((c) => c.instanceId === card!.instanceId);
    expect(exiled, 'the adventurer should be in exile, not the graveyard').toBeDefined();
    // The face reverted: what waits in exile is the CREATURE (CR 715.2).
    expect(exiled!.def.name).toBe('Bonecrusher Giant');
    // `by` is the OWNER's seat — every permission before §3.161 was the owner's
    // own, and an absent `castBy` on the grant still resolves to exactly that.
    expect(castPermissionFor(state, exiled as CardInstance)).toEqual({ face: 'front', free: false, by: 'A' });
  });

  it('offers the creature half from exile, and casting it resolves to the battlefield', () => {
    const { reg } = makeRegistry();
    let state = gameAtMain(reg);
    const [card] = giveHand(state, 'A', [BONECRUSHER]);
    fund(state, 'A');
    state = act(state, { kind: 'castSpell', player: 'A', instanceId: card!.instanceId, face: 'back' }, reg);
    state = resolveTop(state, reg);
    fund(state, 'A');
    const offers = casts(state, card!.instanceId);
    expect(offers).toHaveLength(1);
    expect(offers[0]!.fromZone).toBe('exile');
    expect(offers[0]!.face).toBeUndefined();
    state = act(state, offers[0]!, reg);
    state = resolveTop(state, reg);
    expect(state.battlefield.some((p) => p.instanceId === card!.instanceId)).toBe(true);
    // The permission went with the card when it left exile (CR 400.7).
    expect(state.cardGrants ?? []).toHaveLength(0);
  });

  it('a COUNTERED adventure goes to the graveyard — the exile is a RESOLUTION replacement', () => {
    // CR 715.3d exiles the card when the adventure RESOLVES. A countered
    // adventure is an ordinary countered spell and the creature half is gone for
    // good, so the two exits must disagree — which is exactly what the required
    // `reason` argument on `spellLeaveDestination` exists to force a caller to
    // say. Asserted on the one function both exits read, so a future exit path
    // cannot pick up a third opinion.
    const { reg } = makeRegistry();
    let state = gameAtMain(reg);
    const [card] = giveHand(state, 'A', [BONECRUSHER]);
    fund(state, 'A');
    state = act(state, { kind: 'castSpell', player: 'A', instanceId: card!.instanceId, face: 'back' }, reg);
    const spell = state.stack[0] as SpellStackObject;
    expect(spell.card.def.adventure).toBe(true);
    expect(spellLeaveDestination(spell, 'resolve')).toBe('exile');
    expect(spellLeaveDestination(spell, 'counter')).toBe('graveyard');
  });

  it('refuses to cast the OTHER face from exile — the permission names one', () => {
    const { reg } = makeRegistry();
    let state = gameAtMain(reg);
    const [card] = giveHand(state, 'A', [BONECRUSHER]);
    fund(state, 'A');
    state = act(state, { kind: 'castSpell', player: 'A', instanceId: card!.instanceId, face: 'back' }, reg);
    state = resolveTop(state, reg);
    fund(state, 'A');
    const reason = rejection(
      state,
      { kind: 'castSpell', player: 'A', instanceId: card!.instanceId, fromZone: 'exile', face: 'back' },
      reg,
    );
    expect(reason).toContain('may not be cast from exile');
  });

  it('an exiled card with NO permission cannot be cast from exile at all', () => {
    const { reg } = makeRegistry();
    const state = gameAtMain(reg);
    const [card] = giveHand(state, 'A', [FIRE_ICE]);
    const inst = card as CardInstance;
    state.players.A.hand = [];
    inst.zone = 'exile';
    state.players.A.exile.push(inst);
    fund(state, 'A');
    expect(casts(state, inst.instanceId)).toHaveLength(0);
    const reason = rejection(state, { kind: 'castSpell', player: 'A', instanceId: inst.instanceId, fromZone: 'exile' }, reg);
    expect(reason).toContain('no permission to be cast from exile');
  });
});

describe('Sieges — the reward half after the last defense counter (CR 310.4)', () => {
  /**
   * Put a battle on the battlefield with its last defense counter already gone
   * and let the state-based actions see it. SBAs run after a RESOLUTION (not on
   * a bare priority pass), so the trigger here is resolving a do-nothing
   * instant - the same moment the last counter would come off in a real game.
   */
  function defeatBattle(def: CardDefinition): { state: GameState; instanceId: number; reg: EffectRegistry } {
    const { reg } = makeRegistry();
    let state = gameAtMain(reg);
    const [battle, poke] = giveHand(state, 'A', [def, NOOP_INSTANT]);
    const inst = battle as CardInstance;
    state.players.A.hand = state.players.A.hand.filter((c) => c.instanceId !== inst.instanceId);
    inst.zone = 'battlefield';
    inst.counters = {};
    state.battlefield.push(inst);
    fund(state, 'A');
    state = act(state, { kind: 'castSpell', player: 'A', instanceId: poke!.instanceId }, reg);
    state = resolveTop(state, reg);
    return { state, instanceId: inst.instanceId, reg };
  }

  it('exiles a defeated SIEGE and grants a FREE cast of its reward half', () => {
    const { state, instanceId } = defeatBattle(SIEGE);
    const exiled = state.players.A.exile.find((c) => c.instanceId === instanceId);
    expect(exiled, 'a defeated Siege is exiled, not buried').toBeDefined();
    expect(castPermissionFor(state, exiled as CardInstance)).toEqual({ face: 'back', free: true, by: 'A' });
  });

  it('offers the reward with an EMPTY pool — it is cast without paying its mana cost', () => {
    const { state, instanceId, reg } = defeatBattle(SIEGE);
    state.players.A.manaPool = { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 };
    const offers = casts(state, instanceId);
    expect(offers).toHaveLength(1);
    expect(offers[0]!.face).toBe('back');
    const after = resolveTop(act(state, offers[0]!, reg), reg);
    const permanent = after.battlefield.find((p) => p.instanceId === instanceId);
    expect(permanent?.def.name).toBe('Zilortha, Apex of Ikoria');
  });

  it('a battle with NO reward half still goes to the graveyard', () => {
    const { state, instanceId } = defeatBattle(PLAIN_BATTLE);
    expect(state.players.A.graveyard.some((c) => c.instanceId === instanceId)).toBe(true);
    expect(state.players.A.exile).toHaveLength(0);
  });
});

describe('the permission survives the per-action clone (the clone.ts field-by-field trap)', () => {
  it('carries castFace and castFree across cloneState', () => {
    const { reg } = makeRegistry();
    let state = gameAtMain(reg);
    const [card] = giveHand(state, 'A', [BONECRUSHER]);
    fund(state, 'A');
    state = act(state, { kind: 'castSpell', player: 'A', instanceId: card!.instanceId, face: 'back' }, reg);
    state = resolveTop(state, reg);
    const copy = cloneState(state);
    const exiled = copy.players.A.exile.find((c) => c.instanceId === card!.instanceId);
    expect(castPermissionFor(copy, exiled as CardInstance)).toEqual({ face: 'front', free: false, by: 'A' });
    // …and it is a COPY: mutating the clone's grant cannot reach the original.
    (copy.cardGrants ?? []).length = 0;
    const original = state.players.A.exile.find((c) => c.instanceId === card!.instanceId);
    expect(castPermissionFor(state, original as CardInstance)).toBeDefined();
  });
});

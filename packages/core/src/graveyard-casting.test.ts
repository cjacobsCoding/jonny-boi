/**
 * THE GRAVEYARD-CASTING FAMILY (DESIGN §3.111) — the core half, on the real
 * engine, with hand-built definitions and probe bodies (the printed bodies —
 * unearth's return, scavenge's counters, the token copies — live in the cards
 * package and are pinned there on the real printed cards).
 *
 *  1. `activateGraveyardAbility`: offered exactly when the ability's timing is
 *     open and the pool covers its cost; refused for everything the menu would
 *     not show; pays in full; the printed "Exile this card from your graveyard"
 *     is a COST (the card is in exile before the ability resolves); the body
 *     runs with `ctx.source` being the card wherever it now sits.
 *  2. CR 702.84c — an unearthed permanent that would leave the battlefield is
 *     exiled instead, through the engine's own state-based death.
 *  3. The graveyard-cast KINDS: retrace pays the printed cost plus a land, and
 *     the spell goes BACK to the graveyard; jump-start discards and exiles;
 *     escape pays its own cost plus N other graveyard cards and is not exiled;
 *     a flashback printed as a sacrifice or a tap pays exactly that.
 *  4. The clone trap: `graveyardCast` on the stack object and `exileIfLeaves`
 *     on the instance both survive the per-action clone.
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
  type CardInstance,
  type EffectContext,
  type GameAction,
  type GameState,
  type SelectCardsChoice,
  type SpellStackObject,
} from './index.js';
import { createEffectRegistry, type EffectRegistry } from './effects.js';
import { creatureDef, deckOf, giveGraveyard, giveHand, landDef, spellDef } from './test-fixtures.js';

const SWAMP = landDef('Swamp', 'B');
const BEAR = creatureDef('bear', 2, 2, { cost: { generic: 1, G: 1 }, name: 'Bear' });

/** Unearth {B} on a 2/1 — the body is a probe that does what the cards package's does. */
const UNEARTHER: CardDefinition = {
  ...creatureDef('unearther', 2, 1, { cost: { generic: 1, B: 1 }, name: 'Unearther' }),
  graveyardAbilities: [
    { kind: 'unearth', cost: { mana: { B: 1 } }, effects: [{ primitive: 'unearthProbe' }], timing: 'sorcery', label: 'Unearth {B}' },
  ],
};
/** Scavenge {2} on a 3/3 — exile-as-cost, targeting a creature. */
const SCAVENGER: CardDefinition = {
  ...creatureDef('scavenger', 3, 3, { cost: { generic: 2, G: 1 }, name: 'Scavenger' }),
  graveyardAbilities: [
    {
      kind: 'scavenge',
      cost: { mana: { generic: 2 } },
      exileSelf: true,
      effects: [{ primitive: 'noteResolved', params: { targets: 'creature' } }],
      timing: 'sorcery',
      label: 'Scavenge {2}',
    },
  ],
};
/** "{1}: Return ~ from your graveyard to your hand" — instant speed, no exile. */
const RETURNER: CardDefinition = {
  ...creatureDef('returner', 1, 2, { cost: { B: 1 }, name: 'Returner' }),
  graveyardAbilities: [
    { kind: 'returnToHand', cost: { mana: { generic: 1 } }, effects: [{ primitive: 'noteResolved' }], label: '{1}: Return this card from your graveyard to your hand' },
  ],
};
/** A {B} sorcery with retrace. */
const RETRACER: CardDefinition = {
  ...spellDef('retracer', 'sorcery', [{ primitive: 'noteResolved' }], { B: 1 }),
  graveyardCasts: [{ kind: 'retrace', additional: { kind: 'discard', filter: { anyOfTypes: ['land'] }, label: 'Discard a land card' } }],
};
/** A {U} instant with jump-start. */
const JUMPER: CardDefinition = {
  ...spellDef('jumper', 'instant', [{ primitive: 'noteResolved' }], { U: 1 }),
  graveyardCasts: [{ kind: 'jumpStart', additional: { kind: 'discard', label: 'Discard a card' } }],
};
/** A {U}{U} sorcery with Escape—{U}, Exile two other cards from your graveyard. */
const ESCAPER: CardDefinition = {
  ...spellDef('escaper', 'sorcery', [{ primitive: 'noteResolved' }], { U: 2 }),
  graveyardCasts: [
    { kind: 'escape', cost: { U: 1 }, additional: { kind: 'exileFromGraveyard', count: 2, label: 'Exile two other cards from your graveyard' } },
  ],
};
/** Dread Return's shape: Flashback—Sacrifice three creatures. */
const DREAD: CardDefinition = {
  ...spellDef('dread', 'sorcery', [{ primitive: 'noteResolved' }], { generic: 2, B: 2 }),
  flashback: {},
  flashbackAdditionalCost: { kind: 'sacrifice', count: 3, filter: { anyOfTypes: ['creature'] }, label: 'Sacrifice three creatures' },
};
/** Battle Screech's shape: Flashback—Tap two untapped creatures you control. */
const SCREECH: CardDefinition = {
  ...spellDef('screech', 'sorcery', [{ primitive: 'noteResolved' }], { generic: 2, W: 2 }),
  flashback: {},
  flashbackAdditionalCost: { kind: 'tap', count: 2, filter: { anyOfTypes: ['creature'] }, label: 'Tap two untapped creatures you control' },
};

interface Resolved {
  readonly name: string;
  readonly zone: string;
  readonly targets: readonly (number | string)[];
}

function makeRegistry(): { reg: EffectRegistry; resolved: Resolved[] } {
  const reg = createEffectRegistry();
  const resolved: Resolved[] = [];
  reg.register('noteResolved', (ctx: EffectContext) => {
    resolved.push({ name: ctx.source.def.name, zone: ctx.source.zone, targets: [...ctx.targets] });
  });
  // What the cards package's `unearthReturn` does, in miniature: graveyard →
  // battlefield, unsick, with CR 702.84c's flag set.
  reg.register('unearthProbe', (ctx: EffectContext) => {
    const owner = ctx.state.players[ctx.source.owner];
    const index = owner.graveyard.findIndex((c) => c.instanceId === ctx.source.instanceId);
    if (index < 0) return;
    const [card] = owner.graveyard.splice(index, 1);
    if (!card) return;
    card.zone = 'battlefield';
    card.controller = ctx.controller;
    card.summoningSick = false;
    card.exileIfLeaves = true;
    ctx.state.battlefield.push(card);
    ctx.emit({ type: 'zoneChange', instanceId: card.instanceId, from: 'graveyard', to: 'battlefield' });
    resolved.push({ name: card.def.name, zone: 'battlefield', targets: [] });
  });
  return { reg, resolved };
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

const pass = (state: GameState, reg: EffectRegistry): GameState =>
  act(state, { kind: 'passPriority', player: state.priorityPlayer }, reg);

/** Pass until `done` holds; a parked question or a finished game fails loudly. */
function until(state: GameState, reg: EffectRegistry, done: (s: GameState) => boolean): GameState {
  let s = state;
  for (let guard = 0; guard < 400; guard++) {
    if (done(s)) return s;
    if (s.gameOver) throw new Error('game ended first');
    if (s.pendingChoice) throw new Error(`a question parked the game first:\n${dumpState(s)}`);
    s = pass(s, reg);
  }
  throw new Error(`never reached the condition (turn ${s.turnNumber} ${s.step})`);
}

function gameAtMain(reg: EffectRegistry): GameState {
  const { state } = createGame({
    seed: 0x6a7,
    startingPlayer: 'A',
    registry: reg,
    decks: { A: deckOf(SWAMP, 40), B: deckOf(SWAMP, 40) },
  });
  const s = until(state, reg, (x) => x.step === 'precombatMain');
  s.players.A.hand = [];
  s.players.B.hand = [];
  return s;
}

function fund(state: GameState, player: 'A' | 'B', pool: Partial<Record<'W' | 'U' | 'B' | 'R' | 'G' | 'C', number>>): void {
  state.players[player].manaPool = { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0, ...pool };
}

/** Put copies of `def` onto the battlefield under `player`, settled and untapped. */
function onBattlefield(state: GameState, player: 'A' | 'B', defs: readonly CardDefinition[]): CardInstance[] {
  const cards = giveHand(state, player, defs);
  state.players[player].hand = state.players[player].hand.filter((c) => !cards.includes(c));
  for (const card of cards) {
    card.zone = 'battlefield';
    card.summoningSick = false;
    state.battlefield.push(card);
  }
  return cards;
}

const offers = (state: GameState, kind: GameAction['kind']) => generateLegalActions(state).filter((a) => a.kind === kind);
const inZone = (state: GameState, player: 'A' | 'B', zone: 'graveyard' | 'exile' | 'hand', id: number) =>
  state.players[player][zone].some((c) => c.instanceId === id);

function answerSelect(state: GameState, reg: EffectRegistry, ids: readonly number[]): GameState {
  const choice = state.pendingChoice as SelectCardsChoice | null;
  if (!choice) throw new Error(`no choice pending:\n${dumpState(state)}`);
  return act(state, { kind: 'answerChoice', player: choice.chooser, choiceId: choice.id, answer: { kind: 'selectCards', instanceIds: [...ids] } }, reg);
}

describe('activateGraveyardAbility — the offer and the refusal (CR 702.84a, 702.96a)', () => {
  it('is offered once the pool covers the cost, only at the ability’s timing, and never for a card that is not in the graveyard', () => {
    const { reg } = makeRegistry();
    const state = gameAtMain(reg);
    const [unearther] = giveGraveyard(state, 'A', [UNEARTHER]);
    expect(offers(state, 'activateGraveyardAbility')).toHaveLength(0);
    fund(state, 'A', { B: 1 });
    expect(offers(state, 'activateGraveyardAbility')).toEqual([
      { kind: 'activateGraveyardAbility', player: 'A', instanceId: unearther!.instanceId, abilityIndex: 0 },
    ]);
    // Off the sorcery-speed window the offer disappears with the timing …
    const offTurn = until(state, reg, (s) => s.activePlayer === 'B' && s.priorityPlayer === 'A');
    fund(offTurn, 'A', { B: 1 });
    expect(offers(offTurn, 'activateGraveyardAbility')).toHaveLength(0);
    expect(rejection(offTurn, { kind: 'activateGraveyardAbility', player: 'A', instanceId: unearther!.instanceId, abilityIndex: 0 }, reg)).toMatch(/sorcery speed/);
    // … while an INSTANT-speed graveyard ability is offered there too.
    const [returner] = giveGraveyard(offTurn, 'A', [RETURNER]);
    fund(offTurn, 'A', { C: 1 });
    expect(offers(offTurn, 'activateGraveyardAbility').map((a) => (a as { instanceId: number }).instanceId)).toEqual([returner!.instanceId]);
    // A hand-built action for a card in HAND, or for an ability the card does not print, is refused.
    const [inHand] = giveHand(state, 'A', [UNEARTHER]);
    expect(rejection(state, { kind: 'activateGraveyardAbility', player: 'A', instanceId: inHand!.instanceId, abilityIndex: 0 }, reg)).toBe('that card is not in your graveyard');
    expect(rejection(state, { kind: 'activateGraveyardAbility', player: 'A', instanceId: unearther!.instanceId, abilityIndex: 3 }, reg)).toBe('that card has no such graveyard ability');
  });

  it('pays the mana, keeps an unearth card in the graveyard while its ability is on the stack, and the body runs with the card as its source', () => {
    const { reg, resolved } = makeRegistry();
    let state = gameAtMain(reg);
    const [unearther] = giveGraveyard(state, 'A', [UNEARTHER]);
    fund(state, 'A', { B: 1, C: 1 });
    state = act(state, { kind: 'activateGraveyardAbility', player: 'A', instanceId: unearther!.instanceId, abilityIndex: 0 }, reg);
    expect(state.players.A.manaPool.B).toBe(0);
    expect(state.players.A.manaPool.C).toBe(1);
    expect(state.stack).toHaveLength(1);
    expect(state.stack[0]).toMatchObject({ kind: 'trigger', origin: 'activated', sourceInstanceId: unearther!.instanceId, label: 'Unearth {B}' });
    expect(inZone(state, 'A', 'graveyard', unearther!.instanceId)).toBe(true);
    state = pass(pass(state, reg), reg);
    expect(resolved).toEqual([{ name: 'Unearther', zone: 'battlefield', targets: [] }]);
    const back = state.battlefield.find((c) => c.instanceId === unearther!.instanceId);
    expect(back?.summoningSick).toBe(false);
    expect(back?.exileIfLeaves).toBe(true);
  });

  it('"Exile this card from your graveyard" is a COST: the card is in exile before the ability resolves, and the body sees it there', () => {
    const { reg, resolved } = makeRegistry();
    let state = gameAtMain(reg);
    const [bear] = onBattlefield(state, 'A', [BEAR]);
    const [scavenger] = giveGraveyard(state, 'A', [SCAVENGER]);
    fund(state, 'A', { C: 2 });
    // One offer per legal creature target.
    const offered = offers(state, 'activateGraveyardAbility');
    expect(offered.map((a) => (a as { targets?: unknown[] }).targets)).toEqual([[bear!.instanceId]]);
    // A target the ability's restriction does not allow is refused.
    expect(rejection(state, { ...(offered[0] as GameAction), targets: ['B'] } as GameAction, reg)).toMatch(/target/i);
    state = act(state, offered[0] as GameAction, reg);
    expect(inZone(state, 'A', 'exile', scavenger!.instanceId)).toBe(true);
    expect(inZone(state, 'A', 'graveyard', scavenger!.instanceId)).toBe(false);
    state = pass(pass(state, reg), reg);
    expect(resolved).toEqual([{ name: 'Scavenger', zone: 'exile', targets: [bear!.instanceId] }]);
  });
});

describe('CR 702.84c — an unearthed permanent that would leave the battlefield is exiled instead', () => {
  it('dies to a state-based action into EXILE, not the graveyard, and the flag does not follow it', () => {
    const { reg } = makeRegistry();
    let state = gameAtMain(reg);
    const [unearther] = giveGraveyard(state, 'A', [UNEARTHER]);
    fund(state, 'A', { B: 1 });
    state = act(state, { kind: 'activateGraveyardAbility', player: 'A', instanceId: unearther!.instanceId, abilityIndex: 0 }, reg);
    state = pass(pass(state, reg), reg);
    const body = state.battlefield.find((c) => c.instanceId === unearther!.instanceId) as CardInstance;
    // The clone trap: the flag must survive the per-action clone to matter.
    expect(cloneState(state).battlefield.find((c) => c.instanceId === unearther!.instanceId)?.exileIfLeaves).toBe(true);
    body.damageMarked = body.def.toughness ?? 1;
    state = pass(state, reg);
    expect(state.battlefield.some((c) => c.instanceId === unearther!.instanceId)).toBe(false);
    expect(inZone(state, 'A', 'exile', unearther!.instanceId)).toBe(true);
    expect(inZone(state, 'A', 'graveyard', unearther!.instanceId)).toBe(false);
    expect(state.players.A.exile.find((c) => c.instanceId === unearther!.instanceId)?.exileIfLeaves).toBeUndefined();
  });
});

describe('the graveyard-cast kinds (CR 702.81a retrace, 702.133a jump-start, 702.138a escape)', () => {
  it('retrace: offered only with a land to discard, pays the PRINTED cost plus the land, and the spell goes BACK to the graveyard', () => {
    const { reg, resolved } = makeRegistry();
    let state = gameAtMain(reg);
    const [retracer] = giveGraveyard(state, 'A', [RETRACER]);
    fund(state, 'A', { B: 1 });
    // No land in hand: not offered, and refused — and a plain flashback cast is refused too (it has none).
    expect(offers(state, 'castSpell')).toHaveLength(0);
    expect(rejection(state, { kind: 'castSpell', player: 'A', instanceId: retracer!.instanceId, fromZone: 'graveyard' }, reg)).toBe('that card has no flashback');
    expect(rejection(state, { kind: 'castSpell', player: 'A', instanceId: retracer!.instanceId, fromZone: 'graveyard', graveyardCast: 'retrace' }, reg)).toMatch(/additional cost/);
    const [swampA, swampB, bearInHand] = giveHand(state, 'A', [SWAMP, SWAMP, BEAR]);
    expect(offers(state, 'castSpell')).toEqual([
      { kind: 'castSpell', player: 'A', instanceId: retracer!.instanceId, fromZone: 'graveyard', graveyardCast: 'retrace' },
    ]);
    state = act(state, offers(state, 'castSpell')[0] as GameAction, reg);
    expect(state.players.A.manaPool.B).toBe(0);
    // The land question: two candidates, both lands, never the Bear.
    const choice = state.pendingChoice as SelectCardsChoice;
    expect(choice.kind).toBe('selectCards');
    expect(choice.fromZone).toBe('hand');
    expect(choice.candidates.map((c) => c.instanceId).sort()).toEqual([swampA!.instanceId, swampB!.instanceId].sort());
    expect(choice.candidates.some((c) => c.instanceId === bearInHand!.instanceId)).toBe(false);
    state = answerSelect(state, reg, [swampB!.instanceId]);
    expect(inZone(state, 'A', 'graveyard', swampB!.instanceId)).toBe(true);
    expect((state.stack[0] as SpellStackObject).graveyardCast).toBe('retrace');
    expect((cloneState(state).stack[0] as SpellStackObject).graveyardCast).toBe('retrace');
    state = pass(pass(state, reg), reg);
    expect(resolved).toEqual([{ name: 'retracer', zone: 'stack', targets: [] }]);
    expect(inZone(state, 'A', 'graveyard', retracer!.instanceId)).toBe(true);
    expect(inZone(state, 'A', 'exile', retracer!.instanceId)).toBe(false);
    // … and can be retraced again with the other land.
    fund(state, 'A', { B: 1 });
    expect(offers(state, 'castSpell')).toHaveLength(1);
  });

  it('jump-start: discards any card and the spell is EXILED as it resolves', () => {
    const { reg } = makeRegistry();
    let state = gameAtMain(reg);
    const [jumper] = giveGraveyard(state, 'A', [JUMPER]);
    const [bearInHand] = giveHand(state, 'A', [BEAR]);
    fund(state, 'A', { U: 1 });
    state = act(state, { kind: 'castSpell', player: 'A', instanceId: jumper!.instanceId, fromZone: 'graveyard', graveyardCast: 'jumpStart' }, reg);
    // Exactly one candidate: the question is settled without stopping the game.
    expect(state.pendingChoice).toBeFalsy();
    expect(inZone(state, 'A', 'graveyard', bearInHand!.instanceId)).toBe(true);
    state = pass(pass(state, reg), reg);
    expect(inZone(state, 'A', 'exile', jumper!.instanceId)).toBe(true);
  });

  it('escape: pays the ESCAPE cost, exiles N other graveyard cards (never itself), and is not exiled afterwards', () => {
    const { reg } = makeRegistry();
    let state = gameAtMain(reg);
    const [escaper, fuelA, fuelB, fuelC] = giveGraveyard(state, 'A', [ESCAPER, SWAMP, SWAMP, SWAMP]);
    fund(state, 'A', { U: 1 });
    expect(offers(state, 'castSpell')).toEqual([
      { kind: 'castSpell', player: 'A', instanceId: escaper!.instanceId, fromZone: 'graveyard', graveyardCast: 'escape' },
    ]);
    state = act(state, offers(state, 'castSpell')[0] as GameAction, reg);
    expect(state.players.A.manaPool.U).toBe(0);
    const choice = state.pendingChoice as SelectCardsChoice;
    expect(choice.fromZone).toBe('graveyard');
    expect(choice.candidates.map((c) => c.instanceId).sort()).toEqual([fuelA!.instanceId, fuelB!.instanceId, fuelC!.instanceId].sort());
    expect(choice.min).toBe(2);
    expect(choice.max).toBe(2);
    state = answerSelect(state, reg, [fuelA!.instanceId, fuelC!.instanceId]);
    expect(inZone(state, 'A', 'exile', fuelA!.instanceId)).toBe(true);
    expect(inZone(state, 'A', 'graveyard', fuelB!.instanceId)).toBe(true);
    state = pass(pass(state, reg), reg);
    expect(inZone(state, 'A', 'graveyard', escaper!.instanceId)).toBe(true);
    // Thin graveyard now (one other card): no longer offered.
    fund(state, 'A', { U: 1 });
    expect(offers(state, 'castSpell')).toHaveLength(0);
  });

  it('spellLeaveDestination: retrace and escape return to the graveyard, flashback and jump-start exile — resolved or countered', () => {
    const base = { kind: 'spell', instanceId: 1, card: { def: BEAR } as CardInstance, controller: 'A', resolvesTo: 'graveyard', targets: [], castFrom: 'graveyard' } as const;
    for (const reason of ['resolve', 'counter'] as const) {
      expect(spellLeaveDestination({ ...base } as SpellStackObject, reason)).toBe('exile');
      expect(spellLeaveDestination({ ...base, graveyardCast: 'jumpStart' } as SpellStackObject, reason)).toBe('exile');
      expect(spellLeaveDestination({ ...base, graveyardCast: 'retrace' } as SpellStackObject, reason)).toBe('graveyard');
      expect(spellLeaveDestination({ ...base, graveyardCast: 'escape' } as SpellStackObject, reason)).toBe('graveyard');
    }
  });
});

describe('flashback printed as a non-mana cost (CR 702.34a — Dread Return, Battle Screech)', () => {
  it('"Sacrifice three creatures": offered only with three, sacrifices exactly them, pays no mana, and exiles the spell', () => {
    const { reg } = makeRegistry();
    let state = gameAtMain(reg);
    const [dread] = giveGraveyard(state, 'A', [DREAD]);
    onBattlefield(state, 'A', [BEAR, BEAR]);
    expect(offers(state, 'castSpell')).toHaveLength(0);
    const [third] = onBattlefield(state, 'A', [BEAR]);
    expect(offers(state, 'castSpell')).toEqual([{ kind: 'castSpell', player: 'A', instanceId: dread!.instanceId, fromZone: 'graveyard' }]);
    state = act(state, offers(state, 'castSpell')[0] as GameAction, reg);
    // Exactly three legal payers: settled without a question, all three gone.
    expect(state.pendingChoice).toBeFalsy();
    expect(state.battlefield.some((c) => c.def.name === 'Bear')).toBe(false);
    expect(inZone(state, 'A', 'graveyard', third!.instanceId)).toBe(true);
    state = pass(pass(state, reg), reg);
    expect(inZone(state, 'A', 'exile', dread!.instanceId)).toBe(true);
  });

  it('"Tap two untapped creatures you control": only untapped ones count, and paying taps them', () => {
    const { reg } = makeRegistry();
    let state = gameAtMain(reg);
    const [screech] = giveGraveyard(state, 'A', [SCREECH]);
    const [bearA, bearB] = onBattlefield(state, 'A', [BEAR, BEAR]);
    bearA!.tapped = true;
    expect(offers(state, 'castSpell')).toHaveLength(0);
    bearA!.tapped = false;
    expect(offers(state, 'castSpell')).toHaveLength(1);
    state = act(state, offers(state, 'castSpell')[0] as GameAction, reg);
    expect(state.pendingChoice).toBeFalsy();
    expect(state.battlefield.find((c) => c.instanceId === bearA!.instanceId)?.tapped).toBe(true);
    expect(state.battlefield.find((c) => c.instanceId === bearB!.instanceId)?.tapped).toBe(true);
    state = pass(pass(state, reg), reg);
    expect(inZone(state, 'A', 'exile', screech!.instanceId)).toBe(true);
  });
});

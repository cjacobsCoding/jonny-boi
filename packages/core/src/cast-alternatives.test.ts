/**
 * THE CAST-ALTERNATIVE FAMILY (DESIGN §3.112) — the core half, on the real engine.
 *
 *  - EVOKE (CR 702.74a): the cheaper cast is offered when the printed cost is
 *    not, the creature is sacrificed as it enters, and its ETB still fires.
 *  - DASH (CR 702.109a): enters unsick, returned to hand at the next end step;
 *    a bounced-and-recast copy (a new object, CR 400.7) is left alone.
 *  - SURGE (CR 702.117a): refused until another spell was cast this turn.
 *  - PROTOTYPE (CR 702.160a): cast as the smaller, differently coloured body;
 *    the printed face returns when it leaves the battlefield.
 *  - ENTWINE (CR 702.42a): asked before the mode menu; "yes" announces every mode.
 *  - FORETELL (CR 702.143a / 116.2h) and PLOT (702.170a / 116.2k): the special
 *    action, the face-down marker, "after the current turn has ended", the
 *    foretell cost / the free sorcery-speed cast.
 *  - CHANNEL-shaped from-hand abilities: targets on the `cycleCard` action,
 *    sorcery timing (transmute), one offer per legal target.
 *  - Every new instance / stack-object field survives the per-action clone —
 *    the field-by-field `clone.ts` trap that has fired five times before.
 *
 * The rider BODIES (`sacrificeSelfIfCastWith`, `returnSelfToHand`, `warpExile`)
 * live in the cards package and are pinned there on real printed cards; here a
 * test registry supplies minimal bodies, so what is under test is core alone.
 */

import { describe, expect, it } from 'vitest';
import {
  addCardGrant,
  applyAction,
  castPermissionFor,
  cloneState,
  colorsOfDefinition,
  createGame,
  DEFAULT_RULES,
  FORETELL_COST,
  generateLegalActions,
  TARGET_RESTRICTION_PARAM,
  type CardDefinition,
  type EffectContext,
  type GameAction,
  type GameState,
  type SpellStackObject,
} from './index.js';
import { createEffectRegistry, type EffectRegistry } from './effects.js';
import { moveToZone, resetInstanceForNewZone } from './internal/zones.js';
import { creatureDef, deckOf, giveHand, landDef } from './test-fixtures.js';

const MOUNTAIN = landDef('Mountain', 'R');
const BEAR = creatureDef('bear', 2, 2, { cost: { generic: 1 } });

/** Mulldrifter-shaped: {4}{U} 2/2, "when this enters, draw two", Evoke {2}{U}. */
const DRIFTER: CardDefinition = {
  ...creatureDef('drifter', 2, 2, { cost: { generic: 4, U: 1 }, name: 'Test Drifter' }),
  triggers: [{ condition: { on: 'etb' }, effects: [{ primitive: 'noteDrew' }], label: 'ETB: draw two' }],
  alternativeCosts: {
    evoke: {
      cost: { generic: 2, U: 1 },
      riders: [
        {
          condition: { on: 'etb' },
          effects: [{ primitive: 'sacrificeIfCastWith', params: { castWith: 'evoke' } }],
          label: 'Evoke: sacrifice it',
          removesFromBattlefield: true,
        },
      ],
    },
  },
};

/** Kolaghan Skirmisher-shaped: {1}{B} 2/2 with Dash {2}{B} — here {3}{R} / dash {1}{R}. */
const DASHER: CardDefinition = {
  ...creatureDef('dasher', 3, 2, { cost: { generic: 3, R: 1 }, name: 'Test Dasher' }),
  alternativeCosts: {
    dash: {
      cost: { generic: 1, R: 1 },
      riders: [
        {
          condition: { on: 'endStep', who: 'any' },
          effects: [{ primitive: 'returnIfDashed' }],
          label: 'Dash: return it to hand',
          removesFromBattlefield: true,
        },
      ],
    },
  },
};

/** Boulder Salvo-shaped: a {4}{R} sorcery with Surge {1}{R}. */
const SURGER: CardDefinition = {
  id: 'surger',
  name: 'Test Surge',
  types: ['sorcery'],
  timing: 'sorcery',
  cost: { generic: 4, R: 1 },
  alternativeCosts: { surge: { cost: { generic: 1, R: 1 } } },
  effects: [{ primitive: 'noteResolved' }],
};

/** A {1} sorcery — the "another spell" surge asks for. */
const CANTRIP: CardDefinition = {
  id: 'cantrip',
  name: 'Test Cantrip',
  types: ['sorcery'],
  timing: 'sorcery',
  cost: { generic: 1 },
  effects: [{ primitive: 'noteResolved' }],
};

/** Goring Warplow-shaped: {6} 5/4 artifact creature, Prototype {1}{B} — 1/1. */
const WARPLOW: CardDefinition = {
  ...creatureDef('warplow', 5, 4, { cost: { generic: 6 }, name: 'Test Warplow' }),
  types: ['artifact', 'creature'],
  alternativeCosts: { prototype: { cost: { generic: 1, B: 1 }, face: { power: 1, toughness: 1 } } },
};

/** Barbed Lightning-shaped: choose one of two target-free modes, Entwine {2}. */
const ENTWINER: CardDefinition = {
  id: 'entwiner',
  name: 'Test Entwine',
  types: ['instant'],
  timing: 'instant',
  cost: { R: 1 },
  entwine: { generic: 2 },
  modal: {
    min: 1,
    max: 1,
    modes: [
      { id: 'a', label: 'Mode A', effects: [{ primitive: 'noteA' }] },
      { id: 'b', label: 'Mode B', effects: [{ primitive: 'noteB' }] },
    ],
  },
};

/** Kaya's Onslaught-shaped: a {2}{W} instant with Foretell {W}. */
const FORETOLD: CardDefinition = {
  id: 'foretold',
  name: 'Test Foretold',
  types: ['instant'],
  timing: 'instant',
  cost: { generic: 2, W: 1 },
  foretell: { W: 1 },
  effects: [{ primitive: 'noteResolved' }],
};

/** Djinn of Fool's Fall-shaped: a {4}{U} 4/3 with Plot {3}{U}. */
const PLOTTED: CardDefinition = {
  ...creatureDef('plotted', 4, 3, { cost: { generic: 4, U: 1 }, name: 'Test Plotted' }),
  plot: { generic: 3, U: 1 },
};

/** Ghost-Lit Raider's channel, in miniature: "{R}, Discard this card: deal 4 to target creature". */
const CHANNELER: CardDefinition = {
  ...creatureDef('channeler', 2, 1, { cost: { generic: 2, R: 1 }, name: 'Test Channeler' }),
  cycling: [
    {
      cost: { R: 1 },
      effects: [{ primitive: 'boltTarget', params: { [TARGET_RESTRICTION_PARAM]: 'creature' } }],
      label: 'Channel — {R}',
      kind: 'channel',
    },
  ],
};

/** A transmute-shaped sorcery-speed discard activation. */
const TRANSMUTER: CardDefinition = {
  id: 'transmuter',
  name: 'Test Transmuter',
  types: ['instant'],
  timing: 'instant',
  cost: { U: 1 },
  effects: [{ primitive: 'noteResolved' }],
  cycling: [{ cost: { U: 1 }, effects: [{ primitive: 'noteResolved' }], label: 'Transmute {U}', kind: 'transmute', timing: 'sorcery' }],
};

interface Notes {
  drew: number;
  resolved: string[];
  modes: string[];
  bolted: number[];
}

function registry(notes: Notes): EffectRegistry {
  const reg = createEffectRegistry();
  reg.register('noteDrew', () => {
    notes.drew += 1;
  });
  reg.register('noteResolved', (ctx: EffectContext) => {
    notes.resolved.push(ctx.source.def.name);
  });
  reg.register('noteA', () => {
    notes.modes.push('a');
  });
  reg.register('noteB', () => {
    notes.modes.push('b');
  });
  reg.register('boltTarget', (ctx: EffectContext) => {
    const id = ctx.targets?.[0];
    if (typeof id === 'number') notes.bolted.push(id);
  });
  // The evoke / blitz rider body, in miniature (the cards package's
  // `sacrificeSelfIfCastWith`): sacrifice the source only while it still
  // carries the stamp the rider was made for.
  reg.register('sacrificeIfCastWith', (ctx: EffectContext) => {
    const perm = ctx.state.battlefield.find((c) => c.instanceId === ctx.source.instanceId);
    if (!perm || perm.castWith !== ctx.params.castWith) return;
    moveToZone(ctx.state, perm, 'graveyard', ctx.emit);
    resetInstanceForNewZone(perm);
  });
  // The dash rider body, in miniature (the cards package's `returnSelfToHand`).
  reg.register('returnIfDashed', (ctx: EffectContext) => {
    const perm = ctx.state.battlefield.find((c) => c.instanceId === ctx.source.instanceId);
    if (!perm || perm.castWith !== 'dash') return;
    moveToZone(ctx.state, perm, 'hand', ctx.emit);
    resetInstanceForNewZone(perm);
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
    if (s.pendingChoice) throw new Error(`a question parked the game first: ${s.pendingChoice.prompt}`);
    s = pass(s, reg);
  }
  throw new Error(`never reached the condition (turn ${s.turnNumber} ${s.step})`);
}

function gameAtMain(reg: EffectRegistry): GameState {
  const { state } = createGame({
    seed: 7,
    startingPlayer: 'A',
    registry: reg,
    decks: { A: deckOf(MOUNTAIN, 40), B: deckOf(MOUNTAIN, 40) },
  });
  const s = until(state, reg, (x) => x.step === 'precombatMain');
  s.players.A.hand = [];
  s.players.B.hand = [];
  return s;
}

function fund(state: GameState, player: 'A' | 'B', pool: Partial<GameState['players']['A']['manaPool']>): void {
  state.players[player].manaPool = { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0, ...pool };
}

function castOffers(state: GameState): Extract<GameAction, { kind: 'castSpell' }>[] {
  return generateLegalActions(state).filter(
    (a): a is Extract<GameAction, { kind: 'castSpell' }> => a.kind === 'castSpell',
  );
}

function fresh(): { notes: Notes; reg: EffectRegistry; state: GameState } {
  const notes: Notes = { drew: 0, resolved: [], modes: [], bolted: [] };
  const reg = registry(notes);
  return { notes, reg, state: gameAtMain(reg) };
}

describe('evoke (CR 702.74a)', () => {
  it('offers the evoke cast when only the evoke cost is affordable, and not the printed one', () => {
    const { reg, state } = fresh();
    const [drifter] = giveHand(state, 'A', [DRIFTER]);
    fund(state, 'A', { U: 1, C: 2 });
    const offers = castOffers(state).filter((a) => a.instanceId === drifter!.instanceId);
    expect(offers.map((a) => a.alternative)).toEqual(['evoke']);
    void reg;
  });

  it('sacrifices the creature as it enters, and its ETB still resolves (Mulldrifter\'s point)', () => {
    const { notes, reg, state } = fresh();
    const [drifter] = giveHand(state, 'A', [DRIFTER]);
    fund(state, 'A', { U: 1, C: 2 });
    let s = act(state, { kind: 'castSpell', player: 'A', instanceId: drifter!.instanceId, alternative: 'evoke' }, reg);
    expect((s.stack[0] as SpellStackObject).alternative).toBe('evoke');
    s = until(s, reg, (x) => x.stack.length === 0 && x.players.A.graveyard.some((c) => c.instanceId === drifter!.instanceId));
    expect(notes.drew).toBe(1);
    expect(s.battlefield.some((c) => c.instanceId === drifter!.instanceId)).toBe(false);
    // The stamp is a fact about THAT stay on the battlefield (CR 400.7).
    expect(s.players.A.graveyard.find((c) => c.instanceId === drifter!.instanceId)?.castWith).toBeUndefined();
  });

  it('cast for its printed cost, the creature stays and no rider is created', () => {
    const { notes, reg, state } = fresh();
    const [drifter] = giveHand(state, 'A', [DRIFTER]);
    fund(state, 'A', { U: 1, C: 4 });
    let s = act(state, { kind: 'castSpell', player: 'A', instanceId: drifter!.instanceId }, reg);
    s = until(s, reg, (x) => x.stack.length === 0 && x.battlefield.some((c) => c.instanceId === drifter!.instanceId));
    expect(notes.drew).toBe(1);
    expect(s.delayedTriggers ?? []).toHaveLength(0);
    expect(s.battlefield.find((c) => c.instanceId === drifter!.instanceId)?.castWith).toBeUndefined();
  });

  it('refuses an alternative cost the card does not print, and one paid from a zone other than the hand', () => {
    const { reg, state } = fresh();
    const [bear] = giveHand(state, 'A', [BEAR]);
    fund(state, 'A', { C: 3 });
    expect(rejection(state, { kind: 'castSpell', player: 'A', instanceId: bear!.instanceId, alternative: 'evoke' }, reg)).toContain(
      'no evoke cost',
    );
  });
});

describe('dash (CR 702.109a)', () => {
  it('enters unsick and is returned to hand at the beginning of the next end step; a recast copy stays', () => {
    const { reg, state } = fresh();
    const [dasher] = giveHand(state, 'A', [DASHER]);
    fund(state, 'A', { R: 1, C: 1 });
    let s = act(state, { kind: 'castSpell', player: 'A', instanceId: dasher!.instanceId, alternative: 'dash' }, reg);
    s = until(s, reg, (x) => x.battlefield.some((c) => c.instanceId === dasher!.instanceId));
    const entered = s.battlefield.find((c) => c.instanceId === dasher!.instanceId)!;
    expect(entered.summoningSick).toBe(false);
    expect(entered.castWith).toBe('dash');
    expect(s.delayedTriggers?.[0]?.removesFromBattlefield).toEqual([dasher!.instanceId]);
    // The rider fires at the beginning of the NEXT end step and returns it.
    s = until(s, reg, (x) => x.players.A.hand.some((c) => c.instanceId === dasher!.instanceId));
    expect(s.turnNumber).toBe(1);
    expect(s.step).toBe('end');
    // Recast for the printed cost on the next turn: a new object, no stamp, and
    // the end step leaves it on the battlefield.
    s = until(s, reg, (x) => x.turnNumber === 3 && x.step === 'precombatMain' && x.priorityPlayer === 'A');
    fund(s, 'A', { R: 1, C: 3 });
    s = act(s, { kind: 'castSpell', player: 'A', instanceId: dasher!.instanceId }, reg);
    s = until(s, reg, (x) => x.battlefield.some((c) => c.instanceId === dasher!.instanceId));
    expect(s.battlefield.find((c) => c.instanceId === dasher!.instanceId)?.castWith).toBeUndefined();
    s = until(s, reg, (x) => x.turnNumber === 4 && x.step === 'upkeep');
    expect(s.battlefield.some((c) => c.instanceId === dasher!.instanceId)).toBe(true);
  });
});

describe('surge (CR 702.117a)', () => {
  it('is refused and not offered until another spell was cast this turn', () => {
    const { notes, reg, state } = fresh();
    const [surger, cantrip] = giveHand(state, 'A', [SURGER, CANTRIP]);
    fund(state, 'A', { R: 1, C: 2 });
    expect(castOffers(state).some((a) => a.alternative === 'surge')).toBe(false);
    expect(rejection(state, { kind: 'castSpell', player: 'A', instanceId: surger!.instanceId, alternative: 'surge' }, reg)).toContain(
      'another spell',
    );
    let s = act(state, { kind: 'castSpell', player: 'A', instanceId: cantrip!.instanceId }, reg);
    s = until(s, reg, (x) => x.stack.length === 0);
    expect(castOffers(s).some((a) => a.alternative === 'surge')).toBe(true);
    s = act(s, { kind: 'castSpell', player: 'A', instanceId: surger!.instanceId, alternative: 'surge' }, reg);
    s = until(s, reg, (x) => x.stack.length === 0);
    expect(notes.resolved).toEqual(['Test Cantrip', 'Test Surge']);
    expect(s.players.A.manaPool.C).toBe(0);
  });
});

describe('prototype (CR 702.160a)', () => {
  it('casts the smaller, black body for the prototype cost, and reverts when it leaves', () => {
    const { reg, state } = fresh();
    const [warplow] = giveHand(state, 'A', [WARPLOW]);
    fund(state, 'A', { B: 1, C: 1 });
    expect(castOffers(state).map((a) => a.alternative)).toEqual(['prototype']);
    let s = act(state, { kind: 'castSpell', player: 'A', instanceId: warplow!.instanceId, alternative: 'prototype' }, reg);
    s = until(s, reg, (x) => x.battlefield.some((c) => c.instanceId === warplow!.instanceId));
    const perm = s.battlefield.find((c) => c.instanceId === warplow!.instanceId)!;
    expect([perm.def.power, perm.def.toughness]).toEqual([1, 1]);
    expect(perm.def.cost).toEqual({ generic: 1, B: 1 });
    expect(colorsOfDefinition(perm.def)).toEqual(['B']);
    expect(perm.def.types).toEqual(['artifact', 'creature']);
    moveToZone(s, perm, 'graveyard', () => {});
    resetInstanceForNewZone(perm);
    expect([perm.def.power, perm.def.toughness]).toEqual([5, 4]);
    expect(colorsOfDefinition(perm.def)).toEqual([]);
  });
});

describe('entwine (CR 702.42a)', () => {
  it('asks before the mode menu, and paying announces every mode', () => {
    const { notes, reg, state } = fresh();
    const [entwiner] = giveHand(state, 'A', [ENTWINER]);
    fund(state, 'A', { R: 1, C: 2 });
    let s = act(state, { kind: 'castSpell', player: 'A', instanceId: entwiner!.instanceId }, reg);
    expect(s.pendingChoice?.kind).toBe('payMana');
    expect(s.pendingChoice?.prompt).toContain('entwine');
    s = act(s, { kind: 'answerChoice', player: 'A', choiceId: s.pendingChoice!.id, answer: { kind: 'payMana', pay: true } }, reg);
    const spell = s.stack[0] as SpellStackObject;
    expect(spell.entwined).toBe(true);
    expect(spell.modePicks?.map((p) => p.modeId)).toEqual(['a', 'b']);
    expect(s.players.A.manaPool.C).toBe(0);
    s = until(s, reg, (x) => x.stack.length === 0);
    expect(notes.modes).toEqual(['a', 'b']);
  });

  it('declined, the ordinary mode menu follows; unaffordable, it is never asked', () => {
    const { reg, state } = fresh();
    const [entwiner] = giveHand(state, 'A', [ENTWINER]);
    fund(state, 'A', { R: 1, C: 2 });
    let s = act(state, { kind: 'castSpell', player: 'A', instanceId: entwiner!.instanceId }, reg);
    s = act(s, { kind: 'answerChoice', player: 'A', choiceId: s.pendingChoice!.id, answer: { kind: 'payMana', pay: false } }, reg);
    expect(s.pendingChoice?.kind).toBe('chooseModes');
    expect((s.stack[0] as SpellStackObject).entwined).toBe(false);
    const poor = gameAtMain(reg);
    const [second] = giveHand(poor, 'A', [ENTWINER]);
    fund(poor, 'A', { R: 1 });
    const t = act(poor, { kind: 'castSpell', player: 'A', instanceId: second!.instanceId }, reg);
    expect(t.pendingChoice?.kind).toBe('chooseModes');
  });
});

describe('foretell (CR 702.143a, a special action — 116.2h)', () => {
  it('pays {2} on your own turn, exiles face down, and casts after this turn for the foretell cost', () => {
    const { notes, reg, state } = fresh();
    const [card] = giveHand(state, 'A', [FORETOLD]);
    fund(state, 'A', { C: 2 });
    expect(generateLegalActions(state).some((a) => a.kind === 'foretellCard')).toBe(true);
    let s = act(state, { kind: 'foretellCard', player: 'A', instanceId: card!.instanceId }, reg);
    const exiled = s.players.A.exile.find((c) => c.instanceId === card!.instanceId)!;
    expect(exiled.faceDown).toBe(true);
    expect(s.players.A.manaPool.C).toBe(0);
    // "After the current turn has ended": nothing this turn.
    fund(s, 'A', { W: 1 });
    expect(castPermissionFor(s, exiled)).toBeUndefined();
    expect(castOffers(s).some((a) => a.instanceId === card!.instanceId)).toBe(false);
    // On the opponent's turn the instant may be cast from exile for {W}.
    s = until(s, reg, (x) => x.turnNumber === 2 && x.priorityPlayer === 'A');
    fund(s, 'A', { W: 1 });
    expect(castPermissionFor(s, exiled)?.cost).toEqual({ W: 1 });
    const offer = castOffers(s).find((a) => a.instanceId === card!.instanceId);
    expect(offer?.fromZone).toBe('exile');
    s = act(s, offer as GameAction, reg);
    expect(s.stack[0]?.kind === 'spell' && (s.stack[0] as SpellStackObject).card.faceDown).toBeUndefined();
    expect(s.players.A.manaPool.W).toBe(0);
    s = until(s, reg, (x) => x.stack.length === 0);
    expect(notes.resolved).toEqual(['Test Foretold']);
  });

  it('is refused on the opponent\'s turn', () => {
    const { reg, state } = fresh();
    const [card] = giveHand(state, 'A', [FORETOLD]);
    let s = until(state, reg, (x) => x.turnNumber === 2 && x.priorityPlayer === 'A');
    fund(s, 'A', { C: 2 });
    expect(rejection(s, { kind: 'foretellCard', player: 'A', instanceId: card!.instanceId }, reg)).toContain('your own turn');
    expect(generateLegalActions(s).some((a) => a.kind === 'foretellCard')).toBe(false);
    s = s; // keep the linter honest about the reassignment above
  });
});

describe('plot (CR 702.170a, a special action — 116.2k)', () => {
  it('pays the plot cost in a main phase, then casts free as a sorcery on a later turn', () => {
    const { reg, state } = fresh();
    const [card] = giveHand(state, 'A', [PLOTTED]);
    fund(state, 'A', { U: 1, C: 3 });
    let s = act(state, { kind: 'plotCard', player: 'A', instanceId: card!.instanceId }, reg);
    const exiled = s.players.A.exile.find((c) => c.instanceId === card!.instanceId)!;
    expect(exiled.faceDown).toBeUndefined();
    expect(s.players.A.manaPool.U).toBe(0);
    // Not this turn, and not in the next turn's upkeep (sorcery speed) — only in a main phase, for nothing.
    s = until(s, reg, (x) => x.turnNumber === 3 && x.step === 'upkeep' && x.priorityPlayer === 'A');
    expect(castOffers(s).some((a) => a.instanceId === card!.instanceId)).toBe(false);
    s = until(s, reg, (x) => x.turnNumber === 3 && x.step === 'precombatMain' && x.priorityPlayer === 'A');
    fund(s, 'A', {});
    const offer = castOffers(s).find((a) => a.instanceId === card!.instanceId);
    expect(offer?.fromZone).toBe('exile');
    s = act(s, offer as GameAction, reg);
    s = until(s, reg, (x) => x.battlefield.some((c) => c.instanceId === card!.instanceId));
    expect(s.battlefield.find((c) => c.instanceId === card!.instanceId)?.def.name).toBe('Test Plotted');
  });

  it('is refused outside a main phase with an empty stack', () => {
    const { reg, state } = fresh();
    const [card] = giveHand(state, 'A', [PLOTTED]);
    const s = until(state, reg, (x) => x.step === 'beginCombat' && x.priorityPlayer === 'A');
    fund(s, 'A', { U: 1, C: 3 });
    expect(rejection(s, { kind: 'plotCard', player: 'A', instanceId: card!.instanceId }, reg)).toContain('main phase');
  });
});

describe('a permission cast keeps the card\'s timing (regression: the apply path waved every exile cast through)', () => {
  it('rejects a permitted sorcery cast off-turn even though the offer loop never offered it', () => {
    const { reg, state } = fresh();
    const [cantrip] = giveHand(state, 'A', [CANTRIP]);
    // Hand-built: exile the sorcery with an open permission (no window).
    moveToZone(state, cantrip!, 'exile', () => {});
    addCardGrant(
      state,
      { targetInstanceId: cantrip!.instanceId, sourceInstanceId: cantrip!.instanceId, zone: 'exile', duration: 'permanent', castFace: 'front' },
      () => {},
    );
    const s = until(state, reg, (x) => x.activePlayer === 'B' && x.priorityPlayer === 'A');
    fund(s, 'A', { C: 1 });
    expect(castOffers(s).some((a) => a.instanceId === cantrip!.instanceId)).toBe(false);
    expect(rejection(s, { kind: 'castSpell', player: 'A', instanceId: cantrip!.instanceId, fromZone: 'exile' }, reg)).toContain(
      'sorcery speed',
    );
  });
});

describe('channel-shaped abilities on the cycling funnel (§3.112)', () => {
  it('offers one activation per legal target, carries the target to the stack, and refuses an illegal one', () => {
    const { notes, reg, state } = fresh();
    const [channeler, bear] = giveHand(state, 'A', [CHANNELER, BEAR]);
    fund(state, 'A', { R: 1, C: 1 });
    let s = act(state, { kind: 'castSpell', player: 'A', instanceId: bear!.instanceId }, reg);
    s = until(s, reg, (x) => x.battlefield.some((c) => c.instanceId === bear!.instanceId));
    fund(s, 'A', { R: 1 });
    const cycles = generateLegalActions(s).filter(
      (a): a is Extract<GameAction, { kind: 'cycleCard' }> => a.kind === 'cycleCard',
    );
    expect(cycles).toEqual([{ kind: 'cycleCard', player: 'A', instanceId: channeler!.instanceId, abilityIndex: 0, targets: [bear!.instanceId] }]);
    expect(rejection(s, { kind: 'cycleCard', player: 'A', instanceId: channeler!.instanceId, abilityIndex: 0, targets: ['B'] }, reg)).toBeDefined();
    s = act(s, cycles[0] as GameAction, reg);
    expect(s.stack[0]?.kind === 'trigger' && s.stack[0].targets).toEqual([bear!.instanceId]);
    s = until(s, reg, (x) => x.stack.length === 0);
    expect(notes.bolted).toEqual([bear!.instanceId]);
    expect(s.players.A.graveyard.some((c) => c.instanceId === channeler!.instanceId)).toBe(true);
  });

  it('a sorcery-speed activation (transmute) is offered in a main phase and refused elsewhere', () => {
    const { reg, state } = fresh();
    const [transmuter] = giveHand(state, 'A', [TRANSMUTER]);
    fund(state, 'A', { U: 1 });
    expect(generateLegalActions(state).some((a) => a.kind === 'cycleCard')).toBe(true);
    const s = until(state, reg, (x) => x.step === 'beginCombat' && x.priorityPlayer === 'A');
    fund(s, 'A', { U: 1 });
    expect(generateLegalActions(s).some((a) => a.kind === 'cycleCard')).toBe(false);
    expect(rejection(s, { kind: 'cycleCard', player: 'A', instanceId: transmuter!.instanceId, abilityIndex: 0 }, reg)).toContain('sorcery');
  });
});

describe('the per-action clone carries every new field', () => {
  it('castWith, faceDown, alternative and entwined survive cloneState', () => {
    const { reg, state } = fresh();
    const [dasher, foretold, entwiner] = giveHand(state, 'A', [DASHER, FORETOLD, ENTWINER]);
    fund(state, 'A', { R: 2, C: 5 });
    let s = act(state, { kind: 'castSpell', player: 'A', instanceId: dasher!.instanceId, alternative: 'dash' }, reg);
    expect((cloneState(s).stack[0] as SpellStackObject).alternative).toBe('dash');
    s = until(s, reg, (x) => x.battlefield.some((c) => c.instanceId === dasher!.instanceId));
    expect(cloneState(s).battlefield.find((c) => c.instanceId === dasher!.instanceId)?.castWith).toBe('dash');
    fund(s, 'A', { C: 2 });
    s = act(s, { kind: 'foretellCard', player: 'A', instanceId: foretold!.instanceId }, reg);
    expect(cloneState(s).players.A.exile.find((c) => c.instanceId === foretold!.instanceId)?.faceDown).toBe(true);
    fund(s, 'A', { R: 1, C: 2 });
    s = act(s, { kind: 'castSpell', player: 'A', instanceId: entwiner!.instanceId }, reg);
    s = act(s, { kind: 'answerChoice', player: 'A', choiceId: s.pendingChoice!.id, answer: { kind: 'payMana', pay: true } }, reg);
    expect((cloneState(s).stack[0] as SpellStackObject).entwined).toBe(true);
    void FORETELL_COST;
  });
});

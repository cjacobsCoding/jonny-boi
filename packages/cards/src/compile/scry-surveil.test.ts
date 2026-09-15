/**
 * SCRY & SURVEIL — the look-at-the-top-N flow, and the printed templates that
 * use it, proven the way this compiler's contract demands: a REAL card compiles
 * `'complete'` with its params pinned, AND the compiled definition plays
 * correctly in a real `createGame` + `applyAction` game with the questions
 * actually answered.
 *
 * The closures under test:
 *   - "Scry N"                                  (Preordain's rider; the Temples)
 *   - "Surveil N"                               (the Ravnica surveil-land cycle)
 *   - "Scry N, then EFFECT" / "Surveil N, then EFFECT" (the one-sentence rider)
 *   - "When ~ enters, scry 1." on an enters-tapped land (Temple of Epiphany)
 *   - "Counter target spell unless its controller pays {X}. Scry 2." (Condescend)
 *
 * The failure modes are tested as first-class cases, because they are where a
 * library primitive goes wrong: a library SHORTER than N, a scry that keeps
 * nothing, a surveil that keeps everything, and — the one that matters most —
 * that the chosen ORDER is reproduced exactly, top card first.
 */

import { describe, expect, it } from 'vitest';
import type {
  CardDefinition,
  CardInstance,
  ChoiceAnswer,
  GameAction,
  GameState,
  PendingChoice,
  PlayerId,
} from '@jonny-boi/core';
import { applyAction, createGame, DEFAULT_RULES, dumpState } from '@jonny-boi/core';
import { compileCard } from './compile.js';
import type { CompilableCard } from './types.js';
import { buildRegistry } from '../pool.js';
import { CARD_POOL } from '../../data/pool.js';

type Registry = ReturnType<typeof buildRegistry>;

/** Seeds are fixed per test so any failure is reproducible. */
const SEEDS = Object.freeze({
  scry: 401,
  surveil: 402,
  short: 403,
  temple: 404,
  condescend: 405,
  bottomAll: 406,
  order: 407,
  opt: 408,
});

const DECK_SIZE = 40;

function makeCard(overrides: Partial<CompilableCard> & { name: string }): CompilableCard {
  return {
    id: `test:${overrides.name}`,
    manaCost: { generic: 0, W: 0, U: 0, B: 0, R: 0, G: 0, C: 0, other: [] },
    typeLine: { supertypes: [], types: [], subtypes: [] },
    oracleText: '',
    power: null,
    toughness: null,
    keywords: [],
    ...overrides,
  };
}

// --- the real cards, as printed --------------------------------------------------

/** Preordain: the canonical "scry, then draw" one-sentence rider. */
const PREORDAIN = makeCard({
  name: 'Preordain',
  typeLine: { supertypes: [], types: ['Sorcery'], subtypes: [] },
  manaCost: { generic: 0, W: 0, U: 1, B: 0, R: 0, G: 0, C: 0, other: [] },
  oracleText: 'Scry 2, then draw a card.',
});

/** Opt, exactly as Scryfall prints it — `keywords: ['Scry']` included. */
const OPT = makeCard({
  name: 'Opt',
  typeLine: { supertypes: [], types: ['Instant'], subtypes: [] },
  manaCost: { generic: 0, W: 0, U: 1, B: 0, R: 0, G: 0, C: 0, other: [] },
  oracleText: 'Scry 1.\nDraw a card.',
  keywords: ['Scry'],
});

/** Temple of Epiphany — an enters-tapped land whose ETB trigger scries. */
const TEMPLE_OF_EPIPHANY = makeCard({
  name: 'Temple of Epiphany',
  typeLine: { supertypes: [], types: ['Land'], subtypes: [] },
  oracleText:
    'Temple of Epiphany enters tapped.\nWhen Temple of Epiphany enters, scry 1.\n{T}: Add {U} or {R}.',
});

/** Undercity Sewers — the surveil-land cycle's shape. */
const UNDERCITY_SEWERS = makeCard({
  name: 'Undercity Sewers',
  typeLine: { supertypes: [], types: ['Land'], subtypes: [] },
  oracleText:
    'Undercity Sewers enters tapped.\nWhen Undercity Sewers enters, surveil 1.\n{T}: Add {U} or {B}.',
});

/** A plain "Surveil 2" spell body (the rider-free form). */
const SURVEIL_SPELL = makeCard({
  name: 'Test Surveil',
  typeLine: { supertypes: [], types: ['Instant'], subtypes: [] },
  manaCost: { generic: 0, W: 0, U: 1, B: 0, R: 0, G: 0, C: 0, other: [] },
  oracleText: 'Surveil 2.',
});

/** Condescend: an {X} soft counter AND a scry, in one card. */
const CONDESCEND = makeCard({
  name: 'Condescend',
  typeLine: { supertypes: [], types: ['Instant'], subtypes: [] },
  manaCost: { generic: 0, W: 0, U: 1, B: 0, R: 0, G: 0, C: 0, other: ['X'] },
  oracleText: 'Counter target spell unless its controller pays {X}. Scry 2.',
});

// --- compile ----------------------------------------------------------------------

describe('scry & surveil — the compiler recognizes the printed wordings', () => {
  it('compiles Preordain completely ("Scry 2, then draw a card")', () => {
    const result = compileCard(PREORDAIN);
    expect(result.status, JSON.stringify(result.missing)).toBe('complete');
    expect(result.definition.effects).toEqual([
      { primitive: 'scry', params: { count: 2 } },
      { primitive: 'drawCards', params: { count: 1 } },
    ]);
  });

  it('compiles a plain "Surveil 2" body', () => {
    const result = compileCard(SURVEIL_SPELL);
    expect(result.status, JSON.stringify(result.missing)).toBe('complete');
    expect(result.definition.effects).toEqual([{ primitive: 'surveil', params: { count: 2 } }]);
  });

  it('compiles Temple of Epiphany completely — tapland + ETB scry + the dual mana ability', () => {
    const result = compileCard(TEMPLE_OF_EPIPHANY);
    expect(result.status, JSON.stringify(result.missing)).toBe('complete');
    expect(result.definition.entersTapped).toBe(true);
    // "Scry 1" is the primitive's default depth, so the ref carries no params.
    expect(result.definition.triggers).toEqual([
      {
        condition: { on: 'etb' },
        effects: [{ primitive: 'scry' }],
        label: 'Enters: scry 1',
      },
    ]);
    expect(result.definition.producesOptions).toEqual([{ U: 1 }, { R: 1 }]);
  });

  it('compiles Undercity Sewers completely — the surveil-land shape', () => {
    const result = compileCard(UNDERCITY_SEWERS);
    expect(result.status, JSON.stringify(result.missing)).toBe('complete');
    expect(result.definition.entersTapped).toBe(true);
    expect(result.definition.triggers?.[0]?.effects).toEqual([{ primitive: 'surveil' }]);
  });

  it('compiles Condescend completely — an {X} soft counter plus a scry', () => {
    const result = compileCard(CONDESCEND);
    expect(result.status, JSON.stringify(result.missing)).toBe('complete');
    expect(result.definition.xCost).toBe(1);
    expect(result.definition.effects).toEqual([
      { primitive: 'counterUnlessPaid', params: { targets: 'spell', unlessPaidX: true } },
      { primitive: 'scry', params: { count: 2 } },
    ]);
  });
});

describe('scry & surveil — the neighbouring wordings still refuse honestly', () => {
  it('REFUSES a CONDITIONAL scry (no rule reads the condition)', () => {
    const result = compileCard(
      makeCard({
        name: 'Test Conditional Scry',
        typeLine: { supertypes: [], types: ['Sorcery'], subtypes: [] },
        oracleText: 'If you control an artifact, scry 2.',
      }),
    );
    expect(result.status).toBe('incomplete');
  });

  /**
   * ⚠️ **This test used to assert the opposite, and the assertion was false.**
   * It read "REFUSES a scry rider whose tail needs its own chosen target" and
   * passed only because `", then "` was not yet a clause separator — the SAME
   * card written as two sentences, or joined with " and ", has compiled to
   * these exact two refs since the scry family shipped. So the refusal was a
   * property of one SPELLING, not of the compiler, and pinning it would have
   * made `", then "` look like a regression when it is the §3.60 fix: one
   * joined sentence means one thing however it is punctuated.
   *
   * What replaces it is the claim actually worth pinning — the three spellings
   * AGREE. If any one of them ever drifts, this goes red and names which.
   */
  it('a scry rider with a targeted tail compiles the SAME however it is punctuated', () => {
    const spellings = [
      'Scry 1.\nTest Scry Bolt deals 3 damage to any target.',
      'Scry 1 and Test Scry Bolt deals 3 damage to any target.',
      'Scry 1, then Test Scry Bolt deals 3 damage to any target.',
    ];
    const compiled = spellings.map((oracleText) =>
      compileCard(
        makeCard({ name: 'Test Scry Bolt', typeLine: { supertypes: [], types: ['Instant'], subtypes: [] }, oracleText }),
      ),
    );
    for (const [index, result] of compiled.entries()) {
      expect(result.status, `${spellings[index]} → ${JSON.stringify(result.missing)}`).toBe('complete');
    }
    // Byte-for-byte the same effect list, not merely "all three complete": two
    // spellings that compiled to different refs would be the drift this pins.
    const [sentences, and, then] = compiled.map((r) => JSON.stringify(r.definition.effects));
    expect(and).toBe(sentences);
    expect(then).toBe(sentences);
  });

  it('REFUSES "counter unless its controller pays {X}" on a card with no printed {X} cost', () => {
    const result = compileCard(
      makeCard({
        name: 'Test Fake X Counter',
        typeLine: { supertypes: [], types: ['Instant'], subtypes: [] },
        manaCost: { generic: 1, W: 0, U: 1, B: 0, R: 0, G: 0, C: 0, other: [] },
        oracleText: 'Counter target spell unless its controller pays {X}.',
      }),
    );
    expect(result.status).toBe('incomplete');
  });
});

// --- play -------------------------------------------------------------------------

function getByName(name: string): CardDefinition {
  const card = CARD_POOL.find((c) => c.name === name);
  if (!card) throw new Error(`pool missing ${name}`);
  return card;
}

const ISLAND = getByName('Island');
const FOREST = getByName('Forest');
const SERRA = getByName('Serra Angel');
const BOLT = getByName('Lightning Bolt');

function deck(def: CardDefinition, n = DECK_SIZE): { cards: CardDefinition[] } {
  return { cards: Array.from({ length: n }, () => def) };
}

function act(state: GameState, action: GameAction, reg: Registry): GameState {
  const result = applyAction(state, action, DEFAULT_RULES, reg);
  const rejected = result.events.find((e) => e.type === 'actionRejected');
  if (rejected) {
    throw new Error(`unexpected rejection: ${(rejected as { reason: string }).reason}\n${dumpState(state)}`);
  }
  return result.state;
}

function pass(state: GameState, reg: Registry): GameState {
  return act(state, { kind: 'passPriority', player: state.priorityPlayer }, reg);
}

function advanceToStep(state: GameState, step: GameState['step'], reg: Registry, max = 400): GameState {
  let s = state;
  let guard = 0;
  while (s.step !== step && !s.gameOver && !s.pendingChoice && guard++ < max) s = pass(s, reg);
  return s;
}

function floodMana(state: GameState, player: PlayerId): void {
  const plenty = DECK_SIZE;
  state.players[player].manaPool = { W: plenty, U: plenty, B: plenty, R: plenty, G: plenty, C: plenty };
}

let syntheticId = 94_000;

function instance(def: CardDefinition, player: PlayerId, zone: CardInstance['zone']): CardInstance {
  return {
    instanceId: syntheticId++,
    def,
    controller: player,
    owner: player,
    zone,
    tapped: false,
    summoningSick: false,
    damageMarked: 0,
    markedByDeathtouch: false,
    counters: {},
  };
}

function gameAtMain(reg: Registry, seed: number): GameState {
  const { state } = createGame({
    seed,
    startingPlayer: 'A',
    registry: reg,
    decks: { A: deck(ISLAND), B: deck(ISLAND) },
  });
  const s = advanceToStep(state, 'precombatMain', reg);
  s.players.A.hand = [];
  s.players.B.hand = [];
  return s;
}

function answer(state: GameState, reg: Registry, value: ChoiceAnswer): GameState {
  const choice = state.pendingChoice;
  if (!choice) throw new Error(`no choice pending:\n${dumpState(state)}`);
  return act(state, { kind: 'answerChoice', player: choice.chooser, choiceId: choice.id, answer: value }, reg);
}

function settle(
  state: GameState,
  reg: Registry,
  reply: (choice: PendingChoice, state: GameState) => ChoiceAnswer,
  max = 40,
): GameState {
  let s = state;
  let guard = 0;
  while ((s.stack.length > 0 || s.pendingChoice) && !s.gameOver && guard++ < max) {
    s = s.pendingChoice ? answer(s, reg, reply(s.pendingChoice, s)) : pass(s, reg);
  }
  if (guard >= max) throw new Error(`resolution did not settle:\n${dumpState(s)}`);
  return s;
}

/** Seat a known, distinguishable stack of cards on top of a player's library. */
function stackLibrary(state: GameState, player: PlayerId, defs: readonly CardDefinition[]): CardInstance[] {
  const seeded = defs.map((def) => instance(def, player, 'library'));
  state.players[player].library = [...seeded, ...state.players[player].library];
  return seeded;
}

/** The instance ids offered by a pending `selectCards`, in candidate order. */
function offered(choice: PendingChoice): number[] {
  return (choice as { candidates: ReadonlyArray<{ instanceId: number }> }).candidates.map((c) => c.instanceId);
}

describe('scry & surveil — the compiled cards play as printed', () => {
  const reg = buildRegistry(CARD_POOL);

  it('Preordain: keeps the chosen card on top, bottoms the rest, THEN draws it', () => {
    const state = gameAtMain(reg, SEEDS.scry);
    floodMana(state, 'A');
    const [keep, bottom] = stackLibrary(state, 'A', [FOREST, SERRA]) as [CardInstance, CardInstance];
    const librarySize = state.players.A.library.length;
    const [preordain] = (state.players.A.hand = [instance(compileCard(PREORDAIN).definition, 'A', 'hand')]);

    let s = act(state, { kind: 'castSpell', player: 'A', instanceId: preordain!.instanceId }, reg);
    s = settle(s, reg, (choice) => {
      expect(choice.kind).toBe('selectCards');
      // The look offers exactly the top two, in library order.
      expect(offered(choice)).toEqual([keep.instanceId, bottom.instanceId]);
      return { kind: 'selectCards', instanceIds: [keep.instanceId] };
    });

    // The kept card was on top and got drawn by the rider; the other went to the
    // BOTTOM (still in the library, at its very end).
    expect(s.players.A.hand.map((c) => c.instanceId)).toEqual([keep.instanceId]);
    const library = s.players.A.library;
    expect(library.length).toBe(librarySize - 1);
    expect(library[library.length - 1]!.instanceId, 'the unkept card is on the bottom').toBe(
      bottom.instanceId,
    );
  });

  it('Preordain keeping NOTHING bottoms both, in the order the chooser picked', () => {
    const state = gameAtMain(reg, SEEDS.bottomAll);
    floodMana(state, 'A');
    const [first, second] = stackLibrary(state, 'A', [FOREST, SERRA]) as [CardInstance, CardInstance];
    const [preordain] = (state.players.A.hand = [instance(compileCard(PREORDAIN).definition, 'A', 'hand')]);

    let s = act(state, { kind: 'castSpell', player: 'A', instanceId: preordain!.instanceId }, reg);
    let asked = 0;
    s = settle(s, reg, (choice) => {
      asked += 1;
      // First question: what stays on top (nothing). Second: the bottom ORDER —
      // asked only because there are two cards to order.
      if (asked === 1) return { kind: 'selectCards', instanceIds: [] };
      expect(offered(choice)).toEqual([first.instanceId, second.instanceId]);
      // Deliberately the REVERSE of candidate order, so a primitive that ignored
      // the answer's order would fail here.
      return { kind: 'selectCards', instanceIds: [second.instanceId, first.instanceId] };
    });

    expect(asked, 'the bottom order is its own question when 2+ cards go down').toBe(2);
    const library = s.players.A.library;
    // First-chosen surfaces soonest, i.e. sits ABOVE the other at the bottom.
    const tail = library.slice(-2).map((c) => c.instanceId);
    expect(tail).toEqual([second.instanceId, first.instanceId]);
    // Neither card was drawn by the scry itself; the rider drew the new top card.
    expect(s.players.A.hand.map((c) => c.instanceId)).not.toContain(first.instanceId);
  });

  it('a scry with the library SHORTER than N looks at what is there and asks once', () => {
    const state = gameAtMain(reg, SEEDS.short);
    floodMana(state, 'A');
    const [only] = stackLibrary(state, 'A', [SERRA]) as [CardInstance];
    // Exactly one card in the whole library — a Scry 2 must not stall or throw.
    state.players.A.library = [only];
    const [preordain] = (state.players.A.hand = [instance(compileCard(PREORDAIN).definition, 'A', 'hand')]);

    let s = act(state, { kind: 'castSpell', player: 'A', instanceId: preordain!.instanceId }, reg);
    let asked = 0;
    s = settle(s, reg, (choice) => {
      asked += 1;
      expect(offered(choice)).toEqual([only.instanceId]);
      return { kind: 'selectCards', instanceIds: [only.instanceId] };
    });

    // One question only: with a single card kept there is no bottom order to ask.
    expect(asked).toBe(1);
    expect(s.players.A.hand.map((c) => c.instanceId), 'the kept card was then drawn').toEqual([
      only.instanceId,
    ]);
  });

  it('the kept ORDER is reproduced exactly — first chosen ends up on top', () => {
    const state = gameAtMain(reg, SEEDS.order);
    floodMana(state, 'A');
    const [a, b] = stackLibrary(state, 'A', [FOREST, SERRA]) as [CardInstance, CardInstance];
    const [surveilSpell] = (state.players.A.hand = [
      instance(compileCard(SURVEIL_SPELL).definition, 'A', 'hand'),
    ]);

    let s = act(state, { kind: 'castSpell', player: 'A', instanceId: surveilSpell!.instanceId }, reg);
    s = settle(s, reg, () => ({ kind: 'selectCards', instanceIds: [b.instanceId, a.instanceId] }));

    expect(s.players.A.library.slice(0, 2).map((c) => c.instanceId)).toEqual([b.instanceId, a.instanceId]);
    // The only card in the graveyard is the resolved spell itself — keeping
    // every looked-at card bins none of them.
    const binnedIds = s.players.A.graveyard.map((c) => c.instanceId);
    expect(binnedIds).not.toContain(a.instanceId);
    expect(binnedIds).not.toContain(b.instanceId);
  });

  it('Surveil: the unkept cards go to the GRAVEYARD, and nothing else fires', () => {
    const state = gameAtMain(reg, SEEDS.surveil);
    floodMana(state, 'A');
    const [keep, binned] = stackLibrary(state, 'A', [SERRA, BOLT]) as [CardInstance, CardInstance];
    const [surveilSpell] = (state.players.A.hand = [
      instance(compileCard(SURVEIL_SPELL).definition, 'A', 'hand'),
    ]);

    let s = act(state, { kind: 'castSpell', player: 'A', instanceId: surveilSpell!.instanceId }, reg);
    s = settle(s, reg, () => ({ kind: 'selectCards', instanceIds: [keep.instanceId] }));

    expect(s.players.A.graveyard.map((c) => c.instanceId)).toContain(binned.instanceId);
    expect(s.players.A.library[0]!.instanceId).toBe(keep.instanceId);
    // A graveyard filling up is not a death and not a mill: nothing may be left
    // waiting behind the move.
    expect(s.stack).toHaveLength(0);
    expect(s.pendingChoice).toBeFalsy();
  });

  it('Temple of Epiphany: playing the land enters it tapped and scries on the ETB trigger', () => {
    const state = gameAtMain(reg, SEEDS.temple);
    const [top] = stackLibrary(state, 'A', [SERRA]) as [CardInstance];
    const temple = instance(compileCard(TEMPLE_OF_EPIPHANY).definition, 'A', 'hand');
    state.players.A.hand = [temple];

    let s = act(state, { kind: 'playLand', player: 'A', instanceId: temple.instanceId }, reg);
    const land = s.battlefield.find((c) => c.instanceId === temple.instanceId);
    expect(land, 'the Temple is on the battlefield').toBeDefined();
    expect(land!.tapped, 'and it entered tapped, as printed').toBe(true);

    let sawLook = false;
    s = settle(s, reg, (choice) => {
      sawLook = true;
      expect(offered(choice)).toEqual([top.instanceId]);
      return { kind: 'selectCards', instanceIds: [] }; // bottom it
    });
    expect(sawLook, 'the enters-the-battlefield trigger asked the scry question').toBe(true);
    expect(s.players.A.library[s.players.A.library.length - 1]!.instanceId).toBe(top.instanceId);
  });

  it('Condescend: the victim pays the chosen X and keeps their spell, then the caster scries', () => {
    const state = gameAtMain(reg, SEEDS.condescend);
    floodMana(state, 'A');
    floodMana(state, 'B');
    stackLibrary(state, 'A', [SERRA, FOREST]);
    const victimSpell = instance(BOLT, 'B', 'hand');
    state.players.B.hand = [victimSpell];
    const condescend = instance(compileCard(CONDESCEND).definition, 'A', 'hand');
    state.players.A.hand = [condescend];
    const lifeBefore = state.players.A.life;

    // B casts a Bolt at A; A responds with Condescend for X = 2. (The caster
    // keeps priority after casting, so B passes it back before A may respond.)
    let s = act(state, { kind: 'passPriority', player: 'A' }, reg);
    s = act(s, { kind: 'castSpell', player: 'B', instanceId: victimSpell.instanceId, targets: ['A'] }, reg);
    s = act(s, { kind: 'passPriority', player: 'B' }, reg);
    const spellObject = s.stack.find((o) => o.kind === 'spell')!;
    s = act(
      s,
      { kind: 'castSpell', player: 'A', instanceId: condescend.instanceId, targets: [spellObject.instanceId] },
      reg,
    );
    // The cast parks the "choose a value for X" question first.
    expect(s.pendingChoice?.kind).toBe('chooseNumber');
    s = answer(s, reg, { kind: 'chooseNumber', value: 2 });

    let payAsked = false;
    s = settle(s, reg, (choice) => {
      if (choice.kind === 'payMana') {
        payAsked = true;
        expect(choice.chooser, "the SPELL's controller is the one asked to pay").toBe('B');
        expect(choice.cost).toEqual({ generic: 2 });
        return { kind: 'payMana', pay: true };
      }
      // The scry rider, resolved by the caster: bottom everything, then supply
      // the bottom ORDER the primitive asks for next (min = max = 2 there).
      expect(choice.chooser).toBe('A');
      return { kind: 'selectCards', instanceIds: offered(choice).slice(0, choice.min) };
    });

    expect(payAsked, 'the {X} payment was offered').toBe(true);
    // Paying saved the Bolt, so it resolved and dealt its damage to A.
    expect(s.players.A.life).toBeLessThan(lifeBefore);
  });

  it('Condescend for X = 0 counters nothing — a cost of {0} is always paid', () => {
    const state = gameAtMain(reg, SEEDS.condescend + 1);
    floodMana(state, 'A');
    floodMana(state, 'B');
    stackLibrary(state, 'A', [SERRA, FOREST]);
    const victimSpell = instance(BOLT, 'B', 'hand');
    state.players.B.hand = [victimSpell];
    const condescend = instance(compileCard(CONDESCEND).definition, 'A', 'hand');
    state.players.A.hand = [condescend];
    const lifeBefore = state.players.A.life;

    let s = act(state, { kind: 'passPriority', player: 'A' }, reg);
    s = act(s, { kind: 'castSpell', player: 'B', instanceId: victimSpell.instanceId, targets: ['A'] }, reg);
    s = act(s, { kind: 'passPriority', player: 'B' }, reg);
    const spellObject = s.stack.find((o) => o.kind === 'spell')!;
    s = act(
      s,
      { kind: 'castSpell', player: 'A', instanceId: condescend.instanceId, targets: [spellObject.instanceId] },
      reg,
    );
    if (s.pendingChoice?.kind === 'chooseNumber') s = answer(s, reg, { kind: 'chooseNumber', value: 0 });

    s = settle(s, reg, (choice) => {
      if (choice.kind === 'payMana') throw new Error('X = 0 must never ask anybody to pay');
      return { kind: 'selectCards', instanceIds: offered(choice).slice(0, choice.min) };
    });

    expect(s.players.A.life, 'the un-countered Bolt resolved').toBeLessThan(lifeBefore);
  });
});

/**
 * THE KEYWORD SWEEP — the regression these tests exist for.
 *
 * Scryfall lists `Scry`, `Surveil` and `Mill` in a card's `keywords` array. The
 * compiler models all three as effect PRIMITIVES matched by the rule table, not as
 * keyword flags, so the post-rules keyword sweep used to report the bare keyword a
 * second time even after the printed line had compiled perfectly — leaving Opt,
 * Preordain, the Theros temples and the Ravnica surveil-lands `incomplete` on the
 * strength of a word the compiler had already implemented.
 *
 * Every card below carries the REAL Scryfall `keywords` value; on the old behaviour
 * each one reported `the "Scry"/"Surveil"/"Mill" keyword ability` and failed here.
 *
 * The second block is the half that must stay honest: a wording the rule table does
 * NOT match compiles no primitive, so the card still reports.
 */
describe('the keyword sweep — Scry/Surveil/Mill are primitives, not unmodelled keywords', () => {
  it('compiles Opt completely — the whole text compiled, so the sweep must stay quiet', () => {
    const result = compileCard(OPT);
    expect(result.status, JSON.stringify(result.missing)).toBe('complete');
    expect(result.definition.effects).toEqual([
      { primitive: 'scry' },
      { primitive: 'drawCards', params: { count: 1 } },
    ]);
  });

  it('compiles Preordain with its Scryfall keyword attached', () => {
    const result = compileCard({ ...PREORDAIN, keywords: ['Scry'] });
    expect(result.status, JSON.stringify(result.missing)).toBe('complete');
  });

  it('compiles a Temple with the keyword listed — the scry sits inside an ETB TRIGGER', () => {
    // The nesting is the point: a shallow look at the card's top-level effects
    // finds no scry primitive here, so the guard has to walk the triggers.
    const result = compileCard({ ...TEMPLE_OF_EPIPHANY, keywords: ['Scry'] });
    expect(result.status, JSON.stringify(result.missing)).toBe('complete');
    expect(result.definition.triggers?.[0]?.effects).toEqual([{ primitive: 'scry' }]);
  });

  it('compiles Castle Vantress — the scry sits inside an ACTIVATED ability', () => {
    const result = compileCard(
      makeCard({
        name: 'Castle Vantress',
        typeLine: { supertypes: [], types: ['Land'], subtypes: [] },
        oracleText: '{T}: Add {U}.\n{2}{U}{U}, {T}: Scry 2.',
        keywords: ['Scry'],
      }),
    );
    expect(result.status, JSON.stringify(result.missing)).toBe('complete');
    expect(result.definition.activated?.[0]?.effects).toEqual([
      { primitive: 'scry', params: { count: 2 } },
    ]);
  });

  it('compiles Undercity Sewers with the Surveil keyword listed', () => {
    const result = compileCard({ ...UNDERCITY_SEWERS, keywords: ['Surveil'] });
    expect(result.status, JSON.stringify(result.missing)).toBe('complete');
  });

  it('compiles a self-mill body with the Mill keyword listed', () => {
    const result = compileCard(
      makeCard({
        name: 'Test Self Mill',
        typeLine: { supertypes: [], types: ['Sorcery'], subtypes: [] },
        manaCost: { generic: 0, W: 0, U: 1, B: 0, R: 0, G: 0, C: 0, other: [] },
        oracleText: 'You mill three cards.',
        keywords: ['Mill'],
      }),
    );
    expect(result.status, JSON.stringify(result.missing)).toBe('complete');
    expect(result.definition.effects).toEqual([
      { primitive: 'mill', params: { amount: 3, self: true } },
    ]);
  });

  it('compiles a targeted mill with the Mill keyword listed', () => {
    const result = compileCard(
      makeCard({
        name: 'Test Target Mill',
        typeLine: { supertypes: [], types: ['Sorcery'], subtypes: [] },
        manaCost: { generic: 0, W: 0, U: 1, B: 0, R: 0, G: 0, C: 0, other: [] },
        oracleText: 'Target player mills four cards.',
        keywords: ['Mill'],
      }),
    );
    expect(result.status, JSON.stringify(result.missing)).toBe('complete');
  });
});

describe('the keyword sweep — an unmatched wording still reports honestly', () => {
  /** No compiled scry primitive → no skip. The guard is evidence-based. */
  it('REFUSES a derived-count scry even though Scryfall lists the keyword', () => {
    const result = compileCard(
      makeCard({
        name: 'Test Derived Scry',
        typeLine: { supertypes: [], types: ['Sorcery'], subtypes: [] },
        oracleText: 'Scry X, where X is the number of creatures you control.',
        keywords: ['Scry'],
      }),
    );
    expect(result.status).toBe('incomplete');
    expect(result.missing.length, 'reported once, by the clause — never a bare-keyword duplicate').toBe(1);
    expect(result.missing[0]?.text).toContain('Scry X');
  });

  it('REFUSES a conditional surveil even though Scryfall lists the keyword', () => {
    const result = compileCard(
      makeCard({
        name: 'Test Conditional Surveil',
        typeLine: { supertypes: [], types: ['Sorcery'], subtypes: [] },
        oracleText: 'If you control an artifact, surveil 2.',
        keywords: ['Surveil'],
      }),
    );
    expect(result.status).toBe('incomplete');
  });

  it('REFUSES a derived-count mill even though Scryfall lists the keyword', () => {
    const result = compileCard(
      makeCard({
        name: 'Test Derived Mill',
        typeLine: { supertypes: [], types: ['Sorcery'], subtypes: [] },
        oracleText: 'Each player mills cards equal to the number of creatures they control.',
        keywords: ['Mill'],
      }),
    );
    expect(result.status).toBe('incomplete');
  });

  it('a card whose OTHER line fails still reports, with the scry keyword suppressed', () => {
    // The scry compiled; the second line did not. Exactly one honest entry, and it
    // names the line that actually failed rather than the keyword that worked.
    //
    // ⚠️ The unimplementable stand-in MOVED HERE, for the fourth time in this
    // repo: it was "Bolster 3" until §3.110 shipped bolster (CR 701.39), exactly
    // as §3.102's stand-in walked menace → ward → indestructible → skulk →
    // horsemanship → cumulative upkeep as each of those landed. Morph is the
    // current top of `keyword-gap-report.mjs` (49 cards sole-blocked), so it is
    // the next one that will have to move.
    const result = compileCard(
      makeCard({
        name: 'Test Half Broken',
        typeLine: { supertypes: [], types: ['Sorcery'], subtypes: [] },
        oracleText: 'Scry 2.\nMorph {2}{U}',
        keywords: ['Scry'],
      }),
    );
    expect(result.status).toBe('incomplete');
    expect(result.missing.some((m) => m.text.toLowerCase().includes('scry'))).toBe(false);
  });
});

describe('the keyword sweep — Opt plays as printed once it compiles', () => {
  const reg = buildRegistry(CARD_POOL);

  it('Opt: scries 1 keeping the card, then draws exactly that card', () => {
    const state = gameAtMain(reg, SEEDS.opt);
    floodMana(state, 'A');
    const [top] = stackLibrary(state, 'A', [SERRA]) as [CardInstance];
    const [opt] = (state.players.A.hand = [instance(compileCard(OPT).definition, 'A', 'hand')]);

    let s = act(state, { kind: 'castSpell', player: 'A', instanceId: opt!.instanceId }, reg);
    s = settle(s, reg, (choice) => {
      expect(offered(choice)).toEqual([top.instanceId]);
      return { kind: 'selectCards', instanceIds: [top.instanceId] };
    });

    expect(s.players.A.hand.map((c) => c.instanceId)).toEqual([top.instanceId]);
  });
});

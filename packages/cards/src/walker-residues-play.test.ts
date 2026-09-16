/**
 * THE WALKER RESIDUES, PLAYED (DESIGN §3.153).
 *
 * `compile/walker-residues.test.ts` proves the SHAPES the compiler emits. This
 * file proves the cards actually do what they print, by driving each ability in
 * a real game through `applyAction` and asserting what happened on the board —
 * because §8a item 7 is the standing finding here: a test that calls core's side
 * directly can stay green while the thing a card crosses is broken.
 *
 * Each ability below is run from the surface a player touches: activate the
 * loyalty ability, pass priority twice so it resolves, answer the questions it
 * asks, then read the zones.
 */

import { describe, expect, it } from 'vitest';
import type {
  CardDefinition,
  CardInstance,
  ChoiceAnswer,
  EffectRegistry,
  GameAction,
  GameState,
  InstanceId,
  PlayerId,
} from '@jonny-boi/core';
import {
  aggregateFor,
  applyAction,
  createGame,
  DEFAULT_RULES,
  dumpState,
  effectivePower,
  LOYALTY_COUNTER,
  untapsDuringUntapStep,
} from '@jonny-boi/core';
import { compileCard } from './compile/compile.js';
import type { CompilableCard } from './compile/types.js';
import { buildRegistry } from './pool.js';

// ---------------------------------------------------------------------------
// harness
// ---------------------------------------------------------------------------

const DECK_SIZE = 40;

function printed(overrides: Partial<CompilableCard> & { name: string; oracleText: string }): CompilableCard {
  return {
    id: `id:${overrides.name}`,
    manaCost: { generic: 2, W: 0, U: 0, B: 0, R: 0, G: 0, C: 0, other: [] },
    typeLine: { supertypes: [], types: ['Creature'], subtypes: ['Human'] },
    power: 2,
    toughness: 2,
    keywords: [],
    ...overrides,
  } as CompilableCard;
}

/** Compile a printed card and INSIST it is complete — the definition a game plays. */
function definitionOf(card: CompilableCard): CardDefinition {
  const result = compileCard(card);
  expect(result.status, `missing: ${JSON.stringify(result.missing)}`).toBe('complete');
  return result.definition;
}

const TAMIYO_PRINTED = printed({
  name: 'Tamiyo, the Moon Sage',
  oracleText:
    "+1: Tap target permanent. It doesn't untap during its controller's next untap step.\n" +
    '−2: Draw a card for each tapped creature target player controls.\n' +
    '−8: You get an emblem with "You have no maximum hand size" and "Whenever a card is put into your graveyard from anywhere, you may return it to your hand."',
  typeLine: { supertypes: ['Legendary'], types: ['Planeswalker'], subtypes: ['Tamiyo'] },
  power: null,
  toughness: null,
  loyalty: 4,
} as Partial<CompilableCard> & { name: string; oracleText: string });

const FOREST: CardDefinition = { id: 'Forest', name: 'Forest', types: ['land'], basic: true } as CardDefinition;

/**
 * A free sorcery that mills its caster one card — the cheapest way to put a card
 * into a graveyard FROM THE LIBRARY through the engine's own `zoneChange`, which
 * is the move the emblem's trigger must see and `permanentDies` cannot.
 */
const MILL_ONE: CardDefinition = compileCard({
  id: 'id:Probe Mill',
  name: 'Probe Mill',
  oracleText: 'You mill a card.',
  manaCost: { generic: 0, W: 0, U: 0, B: 0, R: 0, G: 0, C: 0, other: [] },
  typeLine: { supertypes: [], types: ['Sorcery'], subtypes: [] },
  power: null,
  toughness: null,
  keywords: [],
} as unknown as CompilableCard).definition;

/** The same mill as an INSTANT, so the other seat can cast it on your turn. */
const MILL_ONE_INSTANT: CardDefinition = compileCard({
  id: 'id:Probe Mill Instant',
  name: 'Probe Mill Instant',
  oracleText: 'You mill a card.',
  manaCost: { generic: 0, W: 0, U: 0, B: 0, R: 0, G: 0, C: 0, other: [] },
  typeLine: { supertypes: [], types: ['Instant'], subtypes: [] },
  power: null,
  toughness: null,
  keywords: [],
} as unknown as CompilableCard).definition;

function bear(id: string): CardDefinition {
  return { id, name: id, types: ['creature'], power: 2, toughness: 2 } as CardDefinition;
}

function deck(def: CardDefinition, n = DECK_SIZE): { cards: CardDefinition[] } {
  return { cards: Array.from({ length: n }, () => def) };
}

function act(state: GameState, action: GameAction, reg: EffectRegistry): GameState {
  const result = applyAction(state, action, DEFAULT_RULES, reg);
  const rejected = result.events.find((e) => e.type === 'actionRejected');
  if (rejected) {
    throw new Error(`unexpected rejection: ${(rejected as { reason: string }).reason}\n${dumpState(state)}`);
  }
  return result.state;
}

function pass(state: GameState, reg: EffectRegistry): GameState {
  return act(state, { kind: 'passPriority', player: state.priorityPlayer }, reg);
}

function advanceToStep(state: GameState, step: GameState['step'], reg: EffectRegistry, max = 400): GameState {
  let s = state;
  let guard = 0;
  while (s.step !== step && !s.gameOver && !s.pendingChoice && guard++ < max) s = pass(s, reg);
  return s;
}

function answer(state: GameState, reg: EffectRegistry, value: ChoiceAnswer): GameState {
  const choice = state.pendingChoice;
  if (!choice) throw new Error(`no pending choice to answer\n${dumpState(state)}`);
  return act(state, { kind: 'answerChoice', player: choice.chooser, choiceId: choice.id, answer: value }, reg);
}

let syntheticId = 77_000;

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
    attachedTo: null,
    counters: {},
  };
}

function place(state: GameState, def: CardDefinition, controller: PlayerId, tapped = false): CardInstance {
  const card = instance(def, controller, 'battlefield');
  card.tapped = tapped;
  if (def.loyalty !== undefined && def.types.includes('planeswalker')) {
    card.counters = { [LOYALTY_COUNTER]: def.loyalty };
  }
  state.battlefield.push(card);
  return card;
}

function gameAtMain(reg: EffectRegistry, seed: number): GameState {
  const { state } = createGame({ seed, registry: reg, decks: { A: deck(FOREST), B: deck(FOREST) } });
  const s = advanceToStep(state, 'precombatMain', reg);
  s.players.A.hand = [];
  s.players.B.hand = [];
  return s;
}

/** Let a spell or ability on the stack resolve: both players pass. */
function resolveTop(state: GameState, reg: EffectRegistry): GameState {
  return pass(pass(state, reg), reg);
}

/**
 * Empty the stack, answering every "you may" with YES on the way.
 *
 * The emblem fires once per card that reached the graveyard, and a mill spell
 * puts TWO there (the milled card and the spell itself), so a test that passed
 * a fixed number of times would be asserting against whichever trigger happened
 * to be on top. Draining is the honest shape — and the count of questions asked
 * is itself returned, because "it fired" and "it fired the right number of
 * times" are different claims.
 */
function settleStack(
  state: GameState,
  reg: EffectRegistry,
  max = 40,
): { readonly state: GameState; readonly questions: number } {
  let s = state;
  let questions = 0;
  let guard = 0;
  while ((s.stack.length > 0 || s.pendingChoice) && guard++ < max) {
    if (s.pendingChoice) {
      questions += 1;
      s = answer(s, reg, { kind: 'confirm', yes: true });
      continue;
    }
    s = pass(s, reg);
  }
  return { state: s, questions };
}

// ---------------------------------------------------------------------------
// Tamiyo, the Moon Sage — each ability, driven
// ---------------------------------------------------------------------------

describe('Tamiyo, the Moon Sage — played, not merely compiled', () => {
  const reg = buildRegistry();
  const TAMIYO = definitionOf(TAMIYO_PRINTED);

  it("+1: the frozen permanent is still tapped after its controller's untap step", () => {
    let s = gameAtMain(reg, 511);
    const tamiyo = place(s, TAMIYO, 'A');
    const victim = place(s, bear('Victim'), 'B');

    s = act(
      s,
      {
        kind: 'activateAbility',
        player: 'A',
        instanceId: tamiyo.instanceId,
        abilityIndex: 0,
        targets: [victim.instanceId],
      },
      reg,
    );
    s = resolveTop(s, reg);

    const frozen = s.battlefield.find((c) => c.instanceId === victim.instanceId)!;
    expect(frozen.tapped).toBe(true);
    // ⚠️ The DISCRIMINATOR. A tap alone would also leave it tapped right now;
    // what the printed rider says is that the untap step will not fix it. So the
    // claim is read from the untap step's own one question, which is what
    // `beginTurn` actually calls.
    expect(untapsDuringUntapStep(s, frozen)).toBe(false);
    // And an unfrozen permanent of the same kind answers the other way, so the
    // reading above is not a function that always says no.
    const free = place(s, bear('Free'), 'B', true);
    expect(untapsDuringUntapStep(s, free)).toBe(true);
  });

  it('−2: draws exactly the TARGET player’s tapped creatures, on an asymmetric board', () => {
    let s = gameAtMain(reg, 512);
    const tamiyo = place(s, TAMIYO, 'A');
    // A: one tapped creature. B: three. Two different numbers, so a count that
    // answered for the wrong seat cannot coincide with the right answer.
    place(s, bear('a-tapped'), 'A', true);
    place(s, bear('a-untapped'), 'A', false);
    place(s, bear('b-tapped-1'), 'B', true);
    place(s, bear('b-tapped-2'), 'B', true);
    place(s, bear('b-tapped-3'), 'B', true);
    place(s, bear('b-untapped'), 'B', false);
    const before = s.players.A.hand.length;

    s = act(
      s,
      { kind: 'activateAbility', player: 'A', instanceId: tamiyo.instanceId, abilityIndex: 1, targets: ['B'] },
      reg,
    );
    s = resolveTop(s, reg);
    expect(s.players.A.hand.length - before).toBe(3);
  });

  /**
   * ⚠️ THE TEST §3.150's WARNING IS ABOUT. Widening the count to
   * `creaturesOpponentControls` would pass the test above and fail this one:
   * Tamiyo may target ANY player, her own controller included, and aimed at
   * herself she draws for HER tapped creatures.
   */
  it('−2 aimed at YOURSELF counts your OWN tapped creatures — not the opponent’s', () => {
    let s = gameAtMain(reg, 513);
    const tamiyo = place(s, TAMIYO, 'A');
    place(s, bear('a-tapped'), 'A', true);
    place(s, bear('a-untapped'), 'A', false);
    place(s, bear('b-tapped-1'), 'B', true);
    place(s, bear('b-tapped-2'), 'B', true);
    place(s, bear('b-tapped-3'), 'B', true);
    const before = s.players.A.hand.length;

    s = act(
      s,
      { kind: 'activateAbility', player: 'A', instanceId: tamiyo.instanceId, abilityIndex: 1, targets: ['A'] },
      reg,
    );
    s = resolveTop(s, reg);
    // ONE, not three. An opponent shortcut reads three here.
    expect(s.players.A.hand.length - before).toBe(1);
  });

  it('−8: the emblem exists in the command zone and gives no maximum hand size', () => {
    let s = gameAtMain(reg, 514);
    const tamiyo = place(s, TAMIYO, 'A');
    // The printed ultimate costs 8 and she enters at 4, so the loyalty is topped
    // up rather than the ability being faked — the cost is still paid for real.
    s.battlefield.find((c) => c.instanceId === tamiyo.instanceId)!.counters = { [LOYALTY_COUNTER]: 8 };

    s = act(
      s,
      { kind: 'activateAbility', player: 'A', instanceId: tamiyo.instanceId, abilityIndex: 2 },
      reg,
    );
    s = resolveTop(s, reg);

    expect(s.players.A.command).toHaveLength(1);
    const emblem = s.players.A.command[0]!;
    expect(emblem.def.isEmblem).toBe(true);
    expect(emblem.def.noMaximumHandSize).toBe(true);
    // BOTH halves, which is the split §3.150 landed: the emblem also carries the
    // trigger, and an emblem holding only its first quoted ability is exactly
    // the silent half-right the quote split exists to prevent.
    expect(emblem.def.triggers).toHaveLength(1);
    expect(emblem.def.triggers![0]!.condition.on).toBe('cardPutIntoGraveyardFromAnywhere');
  });

  it('−8: the emblem’s trigger FIRES from the command zone and returns the milled card', () => {
    let s = gameAtMain(reg, 515);
    const tamiyo = place(s, TAMIYO, 'A');
    s.battlefield.find((c) => c.instanceId === tamiyo.instanceId)!.counters = { [LOYALTY_COUNTER]: 8 };
    s = act(s, { kind: 'activateAbility', player: 'A', instanceId: tamiyo.instanceId, abilityIndex: 2 }, reg);
    s = resolveTop(s, reg);
    expect(s.players.A.command).toHaveLength(1);

    // A card reaches A's graveyard FROM THE LIBRARY — the zone `permanentDies`
    // cannot see, and the whole reason the emblem needed its own event. It is
    // milled by a REAL SPELL A casts, so the `zoneChange` the trigger collector
    // watches is emitted by the engine rather than described by this test.
    const millCard = s.players.A.library[0]!;
    const mill = instance(MILL_ONE, 'A', 'hand');
    s.players.A.hand = [mill];
    s = act(s, { kind: 'castSpell', player: 'A', instanceId: mill.instanceId }, reg);
    s = resolveTop(s, reg);
    expect(s.players.A.graveyard.some((c) => c.instanceId === millCard.instanceId)).toBe(true);

    // TWO cards reached A's graveyard from two different zones — the milled card
    // from the LIBRARY and the spell itself from the STACK — so the emblem asks
    // twice. Both are "from anywhere", and a matcher that only saw the
    // battlefield would have asked zero times.
    const settled = settleStack(s, reg);
    expect(settled.questions).toBe(2);
    s = settled.state;

    // The milled card is back in hand, and out of the graveyard.
    expect(s.players.A.hand.some((c) => c.instanceId === millCard.instanceId)).toBe(true);
    expect(s.players.A.graveyard.some((c) => c.instanceId === millCard.instanceId)).toBe(false);
  });

  /**
   * ⚠️ §1a, the STRONGER-than-printed direction, half one: a TOKEN is not a
   * card. It reaches a graveyard on its way out of existence, so a matcher that
   * asked only "did something reach my graveyard" would give the emblem a
   * printed ability it does not have.
   */
  it('−8: the emblem does NOT fire on a TOKEN dying', () => {
    let s = gameAtMain(reg, 517);
    const tamiyo = place(s, TAMIYO, 'A');
    s.battlefield.find((c) => c.instanceId === tamiyo.instanceId)!.counters = { [LOYALTY_COUNTER]: 8 };
    s = act(s, { kind: 'activateAbility', player: 'A', instanceId: tamiyo.instanceId, abilityIndex: 2 }, reg);
    s = settleStack(s, reg).state;
    expect(s.players.A.command).toHaveLength(1);

    // A 0/0 token: state-based actions put it into the graveyard the next time
    // anyone would receive priority.
    const token = place(s, { ...bear('Ghost'), isToken: true, power: 0, toughness: 0 } as CardDefinition, 'A');
    s = pass(s, reg);
    expect(s.battlefield.some((c) => c.instanceId === token.instanceId)).toBe(false);

    // ZERO questions: a token is not a card. A matcher that asked only "did
    // something reach my graveyard" gets one here.
    const settled = settleStack(s, reg);
    expect(settled.questions).toBe(0);
  });

  /**
   * ⚠️ §1a, the STRONGER-than-printed direction. The emblem says "your
   * graveyard"; a card reaching the OTHER seat's graveyard must not wake it, and
   * that is invisible in a one-seat test because the trigger would fire either
   * way.
   */
  it('−8: the emblem does NOT fire on the other player’s graveyard', () => {
    let s = gameAtMain(reg, 516);
    const tamiyo = place(s, TAMIYO, 'A');
    s.battlefield.find((c) => c.instanceId === tamiyo.instanceId)!.counters = { [LOYALTY_COUNTER]: 8 };
    s = act(s, { kind: 'activateAbility', player: 'A', instanceId: tamiyo.instanceId, abilityIndex: 2 }, reg);
    s = resolveTop(s, reg);

    s = settleStack(s, reg).state;
    expect(s.players.A.command).toHaveLength(1);

    // B mills THEMSELVES, with an instant so it happens on A's turn and nothing
    // of A's is involved at all. Two cards reach B's graveyard; A's emblem
    // watches A's graveyard only, so it must ask nothing.
    const theirs = s.players.B.library[0]!;
    const mill = instance(MILL_ONE_INSTANT, 'B', 'hand');
    s.players.B.hand = [mill];
    // B needs priority to cast, which on A's turn means A passing first.
    if (s.priorityPlayer !== 'B') s = pass(s, reg);
    s = act(s, { kind: 'castSpell', player: 'B', instanceId: mill.instanceId }, reg);
    const settled = settleStack(s, reg);
    s = settled.state;

    expect(s.players.B.graveyard.some((c) => c.instanceId === theirs.instanceId)).toBe(true);
    // ZERO questions — the discriminator against the test above, which got two.
    expect(settled.questions).toBe(0);
    expect(s.players.B.hand.some((c) => c.instanceId === theirs.instanceId)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Jace, Architect of Thought — the two clauses this lane landed
// ---------------------------------------------------------------------------

const JACE_PLUS_ONE = printed({
  name: 'Probe Architect',
  oracleText:
    '+1: Until your next turn, whenever a creature an opponent controls attacks, it gets -1/-0 until end of turn.',
  typeLine: { supertypes: ['Legendary'], types: ['Planeswalker'], subtypes: ['Jace'] },
  power: null,
  toughness: null,
  loyalty: 4,
} as Partial<CompilableCard> & { name: string; oracleText: string });

const JACE_MINUS_TWO = printed({
  name: 'Probe Architect Two',
  oracleText:
    '−2: Reveal the top three cards of your library. An opponent separates those cards into two piles. Put one pile into your hand and the other on the bottom of your library in any order.',
  typeLine: { supertypes: ['Legendary'], types: ['Planeswalker'], subtypes: ['Jace'] },
  power: null,
  toughness: null,
  loyalty: 4,
} as Partial<CompilableCard> & { name: string; oracleText: string });

describe('Jace, Architect of Thought — the landed clauses, played', () => {
  const reg = buildRegistry();

  it("+1: the OPPONENT's attackers each shrink, and every one of them does", () => {
    let s = gameAtMain(reg, 601);
    const jace = place(s, definitionOf(JACE_PLUS_ONE), 'A');
    s = act(s, { kind: 'activateAbility', player: 'A', instanceId: jace.instanceId, abilityIndex: 0 }, reg);
    s = settleStack(s, reg).state;
    expect(s.delayedTriggers ?? []).toHaveLength(1);

    // Hand the turn to B and have TWO creatures attack. One firing per attacker
    // is the printed reading; a single fire would shrink only one of them.
    const one = place(s, bear('attacker-1'), 'B');
    const two = place(s, bear('attacker-2'), 'B');
    s = advanceToStep(s, 'declareAttackers', reg, 800);
    while (s.activePlayer !== 'B' && !s.gameOver) s = advanceToStep(s, 'declareAttackers', reg, 800);
    one.summoningSick = false;
    two.summoningSick = false;
    s = act(
      s,
      {
        kind: 'declareAttackers',
        player: 'B',
        attackers: [{ instanceId: one.instanceId }, { instanceId: two.instanceId }],
      },
      reg,
    );
    s = settleStack(s, reg).state;

    const powerOf = (id: InstanceId): number => {
      const inst = s.battlefield.find((c) => c.instanceId === id)!;
      return effectivePower(inst, aggregateFor(s, id));
    };
    // 2/2 printed, −1/−0 each. BOTH, which is the discriminator against a
    // trigger that fired once for the declaration.
    expect(powerOf(one.instanceId)).toBe(1);
    expect(powerOf(two.instanceId)).toBe(1);
  });

  /**
   * ⚠️ §1a, the STRONGER-than-printed direction, and the reason the lifetime is
   * one field rather than two. "Until your next turn" ends as your next turn
   * BEGINS — a delayed ability that quietly outlived it would keep shrinking
   * attackers forever and nothing would ever report.
   */
  it('+1: the ability is GONE by the start of your next turn', () => {
    let s = gameAtMain(reg, 602);
    const jace = place(s, definitionOf(JACE_PLUS_ONE), 'A');
    s = act(s, { kind: 'activateAbility', player: 'A', instanceId: jace.instanceId, abilityIndex: 0 }, reg);
    s = settleStack(s, reg).state;
    expect(s.delayedTriggers ?? []).toHaveLength(1);

    // Through B's whole turn it is still there — the duration covers exactly the
    // opponent's turn, which is the point of the printed line.
    let guard = 0;
    while (s.activePlayer === 'A' && !s.gameOver && guard++ < 400) s = pass(s, reg);
    expect(s.delayedTriggers ?? []).toHaveLength(1);

    // …and it is gone the moment A's next turn begins.
    guard = 0;
    while (s.activePlayer === 'B' && !s.gameOver && guard++ < 400) s = pass(s, reg);
    expect(s.activePlayer).toBe('A');
    expect(s.delayedTriggers ?? []).toHaveLength(0);
  });

  it('−2: an OPPONENT splits the revealed three, and the controller takes a pile', () => {
    let s = gameAtMain(reg, 603);
    const jace = place(s, definitionOf(JACE_MINUS_TWO), 'A');
    const topThree = s.players.A.library.slice(0, 3).map((c) => c.instanceId);
    const libraryBefore = s.players.A.library.length;
    const handBefore = s.players.A.hand.length;

    s = act(s, { kind: 'activateAbility', player: 'A', instanceId: jace.instanceId, abilityIndex: 0 }, reg);
    s = resolveTop(s, reg);

    // ⚠️ THE FINDING. The engine CAN ask a non-controlling player a question
    // mid-resolution: this first question is addressed to B, not to A.
    expect(s.pendingChoice, `no split question raised\n${dumpState(s)}`).toBeTruthy();
    expect(s.pendingChoice!.chooser).toBe('B');
    s = answer(s, reg, { kind: 'selectCards', instanceIds: [topThree[0]!] });

    // The second question is the CONTROLLER's: which pile goes to hand.
    expect(s.pendingChoice, `no pile question raised\n${dumpState(s)}`).toBeTruthy();
    expect(s.pendingChoice!.chooser).toBe('A');
    const modes = (s.pendingChoice as { modes?: ReadonlyArray<{ id: string }> }).modes ?? [];
    s = answer(s, reg, { kind: 'chooseModes', modeIds: [modes[0]!.id] });

    // Pile one was one card; it went to hand and the other two to the bottom.
    expect(s.players.A.hand.length - handBefore).toBe(1);
    expect(s.players.A.hand.some((c) => c.instanceId === topThree[0]!)).toBe(true);
    expect(s.players.A.library.length).toBe(libraryBefore - 1);
    // The other two are at the BOTTOM, not still on top — the destination the
    // printed line names, and the discriminator against leaving them in place.
    const bottom = s.players.A.library.slice(-2).map((c) => c.instanceId);
    expect(bottom.sort()).toEqual([topThree[1]!, topThree[2]!].sort());
  });
});

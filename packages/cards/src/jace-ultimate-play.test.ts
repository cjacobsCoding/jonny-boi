/**
 * JACE, ARCHITECT OF THOUGHT'S −8, PLAYED — the last of his residues, and the
 * one that needed the engine rather than a template.
 *
 * "For each player, search that player's library for a nonland card and exile
 * it, then that player shuffles. You may cast those cards without paying their
 * mana costs."
 *
 * Three things had to be true and none was (§3.150 / §3.154 pinned them by
 * name): a search may put its card into EXILE; a search may be of the OTHER
 * player's library with the CONTROLLER choosing; and a cast permission may
 * belong to a seat other than the card's owner — the card exiled from B's
 * library sits in B's exile, and A is the one who may cast it.
 *
 * This drives the ability through the real engine: the two questions (A
 * searches A's library, then B's), the two exiles, the two free casts offered
 * to A alone, and the cast of B's card entering under A's control. Then the
 * compile-status half: Jace compiles COMPLETE, so the next pool regeneration
 * carries him.
 */
import { describe, expect, it } from 'vitest';
import {
  applyAction,
  createGame,
  DEFAULT_RULES,
  generateLegalActions,
  LOYALTY_COUNTER,
  type CardDefinition,
  type CardInstance,
  type ChoiceAnswer,
  type GameAction,
  type GameState,
  type PlayerId,
  type SpellStackObject,
} from '@jonny-boi/core';
import { buildRegistry } from './pool.js';
import { CARD_POOL } from '../data/pool.js';
import { compileCard } from './compile/compile.js';
import type { CompilableCard } from './compile/types.js';

type Registry = ReturnType<typeof buildRegistry>;

const DECK_SIZE = 40;

function getByName(name: string): CardDefinition {
  const card = CARD_POOL.find((c) => c.name === name);
  if (!card) throw new Error(`${name} is not in the pool`);
  return card;
}

/** Jace, exactly as printed, compiled by the same compiler the pool generator runs. */
const JACE_PRINTED: CompilableCard = {
  id: 'jace-architect-of-thought',
  name: 'Jace, Architect of Thought',
  manaCost: { generic: 2, W: 0, U: 2, B: 0, R: 0, G: 0, C: 0, other: [] },
  typeLine: { supertypes: ['Legendary'], types: ['Planeswalker'], subtypes: ['Jace'] },
  oracleText:
    '+1: Until your next turn, whenever a creature an opponent controls attacks, it gets -1/-0 until end of turn.\n' +
    '−2: Reveal the top three cards of your library. An opponent separates those cards into two piles. Put one pile into your hand and the other on the bottom of your library in any order.\n' +
    '−8: For each player, search that player’s library for a nonland card and exile it, then that player shuffles. You may cast those cards without paying their mana costs.',
  power: null,
  toughness: null,
  loyalty: 4,
  colors: ['U'],
  keywords: [],
} as unknown as CompilableCard;

const SWAMP = getByName('Swamp');
const MOUNTAIN = getByName('Mountain');
const GOBLIN = getByName('Raging Goblin');
const SERRA = getByName('Serra Angel');

function act(state: GameState, action: GameAction, reg: Registry): GameState {
  const result = applyAction(state, action, DEFAULT_RULES, reg);
  const rejected = result.events.find((e) => e.type === 'actionRejected');
  if (rejected) throw new Error(`unexpected rejection: ${(rejected as { reason: string }).reason}`);
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
let syntheticId = 93_000;
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
function place(state: GameState, def: CardDefinition, controller: PlayerId, loyalty?: number): CardInstance {
  const card = instance(def, controller, 'battlefield');
  const printed = loyalty ?? def.loyalty;
  if (printed !== undefined && def.types.includes('planeswalker')) card.counters = { [LOYALTY_COUNTER]: printed };
  state.battlefield.push(card);
  return card;
}
function answer(state: GameState, reg: Registry, value: ChoiceAnswer): GameState {
  const choice = state.pendingChoice;
  if (!choice) throw new Error('no pending choice to answer');
  return act(state, { kind: 'answerChoice', player: choice.chooser, choiceId: choice.id, answer: value }, reg);
}
function castOffersFor(state: GameState, player: PlayerId, id: number): GameAction[] {
  return generateLegalActions({ ...state, priorityPlayer: player }, DEFAULT_RULES).filter(
    (a) => a.kind === 'castSpell' && a.player === player && a.instanceId === id,
  );
}

/** A's precombat main on a 40-Swamp / 40-Mountain game, hands emptied. */
function gameAtMain(reg: Registry, seed: number): GameState {
  const { state } = createGame({
    seed,
    registry: reg,
    decks: { A: { cards: Array.from({ length: DECK_SIZE }, () => SWAMP) }, B: { cards: Array.from({ length: DECK_SIZE }, () => MOUNTAIN) } },
  });
  const s = advanceToStep(state, 'precombatMain', reg);
  s.players.A.hand = [];
  s.players.B.hand = [];
  return s;
}

describe('Jace, Architect of Thought', () => {
  it('compiles COMPLETE — the −8 was the last residue, and it is gone', () => {
    const result = compileCard(JACE_PRINTED);
    expect(result.status, `missing: ${JSON.stringify(result.missing)}`).toBe('complete');
    const ultimate = result.definition.activated?.find((a) => a.cost.loyalty === -8);
    expect(ultimate, 'the −8 is an activated loyalty ability').toBeDefined();
    expect(ultimate?.effects[0]?.primitive).toBe('searchLibrary');
    expect(ultimate?.effects[0]?.params).toMatchObject({ who: 'each', chooser: 'controller', destination: 'exile', grantCast: 'free' });
  });

  it('−8, played: A searches BOTH libraries, both cards are exiled, and A alone may cast either — free', () => {
    const reg = buildRegistry();
    const jaceDef = compileCard(JACE_PRINTED).definition;
    let s = gameAtMain(reg, 808);
    const jace = place(s, jaceDef, 'A', 8);
    // Give each library one nonland card to find (the decks are all lands).
    const goblinInA = instance(GOBLIN, 'A', 'library');
    const serraInB = instance(SERRA, 'B', 'library');
    s.players.A.library.unshift(goblinInA);
    s.players.B.library.unshift(serraInB);

    const ultimateIndex = jaceDef.activated!.findIndex((a) => a.cost.loyalty === -8);
    s = act(s, { kind: 'activateAbility', player: 'A', instanceId: jace.instanceId, abilityIndex: ultimateIndex }, reg);
    // Paying the whole 8 leaves Jace at 0 loyalty, and CR 704.5i takes him at the
    // action's SBA boundary — the ability is already on the stack and resolves.
    expect(s.battlefield.some((c) => c.instanceId === jace.instanceId), 'Jace is gone at 0 loyalty').toBe(false);
    s = pass(s, reg);
    s = pass(s, reg);

    // Question 1: A searches A's library — the only nonland is the Goblin.
    expect(s.pendingChoice?.chooser).toBe('A');
    expect(s.pendingChoice?.kind).toBe('selectCards');
    s = answer(s, reg, { kind: 'selectCards', instanceIds: [goblinInA.instanceId] });
    // Question 2: A searches B's library — the chooser is STILL A (the card says who looks).
    expect(s.pendingChoice?.chooser, "the controller searches the opponent's library").toBe('A');
    s = answer(s, reg, { kind: 'selectCards', instanceIds: [serraInB.instanceId] });

    // Both cards sit in their OWNERS' exile zones.
    expect(s.players.A.exile.some((c) => c.instanceId === goblinInA.instanceId), "A's card in A's exile").toBe(true);
    expect(s.players.B.exile.some((c) => c.instanceId === serraInB.instanceId), "B's card in B's exile").toBe(true);

    // A is offered BOTH, free; B is offered neither.
    s = advanceToStep(s, 'precombatMain', reg); // back at a main phase with an empty stack (still A's turn)
    expect(s.stack).toHaveLength(0);
    s.players.A.manaPool = { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 };
    expect(castOffersFor(s, 'A', goblinInA.instanceId), 'A may cast its own exiled card').toHaveLength(1);
    expect(castOffersFor(s, 'A', serraInB.instanceId), "A may cast B's exiled card").toHaveLength(1);
    expect(castOffersFor(s, 'B', serraInB.instanceId), 'B may not cast its own exiled card — the permission is A\'s').toHaveLength(0);

    // Cast the Angel out of B's exile: free, controlled by A, still owned by B.
    const offer = castOffersFor(s, 'A', serraInB.instanceId)[0] as GameAction;
    expect((offer as { fromZone?: string }).fromZone).toBe('exile');
    s = act(s, offer, reg);
    expect((s.stack[0] as SpellStackObject).controller).toBe('A');
    expect(s.players.A.manaPool.W, 'nothing was paid').toBe(0);
    s = pass(s, reg);
    s = pass(s, reg);
    const angel = s.battlefield.find((c) => c.instanceId === serraInB.instanceId);
    expect(angel?.controller, 'enters under the caster\'s control').toBe('A');
    expect(angel?.owner, 'ownership is unchanged').toBe('B');
  });
});

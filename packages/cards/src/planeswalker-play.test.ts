/**
 * "Does the ENGINE play Liliana of the Veil?" — the un-stubbed planeswalker,
 * proved through REAL GAMES, exactly like the other choice-driven pool cards.
 *
 * She was the pool's canonical stub ("planeswalker loyalty abilities"); now every
 * printed line must actually happen at the table: entering at 3 loyalty, the +1
 * both-players discard (each seat choosing its own card, active player first),
 * the −2 edict (the VICTIM picks the creature), the −6 pile split (controller
 * splits, victim picks the pile), and dying to Lightning Bolt — "any target"
 * includes planeswalkers under the modern rules, with no damage redirection.
 */

import { describe, expect, it } from 'vitest';
import type {
  CardDefinition,
  CardInstance,
  ChoiceAnswer,
  GameAction,
  GameState,
  PlayerId,
} from '@jonny-boi/core';
import {
  applyAction,
  createGame,
  DEFAULT_RULES,
  dumpState,
  LOYALTY_COUNTER,
  loyaltyOf,
} from '@jonny-boi/core';
import { buildRegistry } from './pool.js';
import { CARD_POOL } from '../data/pool.js';

type Registry = ReturnType<typeof buildRegistry>;

const DECK_SIZE = 40;

function getByName(name: string): CardDefinition {
  const card = CARD_POOL.find((c) => c.name === name);
  if (!card) throw new Error(`pool missing ${name}`);
  return card;
}

const SWAMP = getByName('Swamp');
const MOUNTAIN = getByName('Mountain');
const BOLT = getByName('Lightning Bolt');
const LILIANA = getByName('Liliana of the Veil');
const GOBLIN = getByName('Raging Goblin');

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

let syntheticId = 91_000;

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

function setHand(state: GameState, player: PlayerId, defs: readonly CardDefinition[]): CardInstance[] {
  const cards = defs.map((def) => instance(def, player, 'hand'));
  state.players[player].hand = cards;
  return cards;
}

/** Put a permanent onto the battlefield; a walker gets its printed loyalty. */
function place(state: GameState, def: CardDefinition, controller: PlayerId, loyalty?: number): CardInstance {
  const card = instance(def, controller, 'battlefield');
  const printed = loyalty ?? def.loyalty;
  if (printed !== undefined && def.types.includes('planeswalker')) {
    card.counters = { [LOYALTY_COUNTER]: printed };
  }
  state.battlefield.push(card);
  return card;
}

function gameAtMain(reg: Registry, seed: number): GameState {
  const { state } = createGame({
    seed,
    registry: reg,
    decks: { A: deck(SWAMP), B: deck(MOUNTAIN) },
  });
  const s = advanceToStep(state, 'precombatMain', reg);
  s.players.A.hand = [];
  s.players.B.hand = [];
  return s;
}

function answer(state: GameState, reg: Registry, value: ChoiceAnswer): GameState {
  const choice = state.pendingChoice;
  if (!choice) throw new Error(`no pending choice to answer\n${dumpState(state)}`);
  return act(state, { kind: 'answerChoice', player: choice.chooser, choiceId: choice.id, answer: value }, reg);
}

function onBattlefield(state: GameState, id: number): CardInstance | undefined {
  return state.battlefield.find((c) => c.instanceId === id);
}

describe('Liliana of the Veil — un-stubbed, plays as printed', () => {
  const reg = buildRegistry();

  it('is cast for {1}{B}{B} and enters at 3 loyalty', () => {
    let s = gameAtMain(reg, 301);
    const [lili] = setHand(s, 'A', [LILIANA]);
    floodMana(s, 'A');
    s = act(s, { kind: 'castSpell', player: 'A', instanceId: lili!.instanceId }, reg);
    s = pass(s, reg);
    s = pass(s, reg);
    const onField = onBattlefield(s, lili!.instanceId);
    expect(onField).toBeDefined();
    expect(loyaltyOf(onField!)).toBe(3);
  });

  it('+1: each player discards a card of their own choice, active player answering first', () => {
    let s = gameAtMain(reg, 302);
    const lili = place(s, LILIANA, 'A');
    const [keepA, tossA] = setHand(s, 'A', [SWAMP, BOLT]);
    const [tossB, keepB] = setHand(s, 'B', [MOUNTAIN, GOBLIN]);

    s = act(s, { kind: 'activateAbility', player: 'A', instanceId: lili.instanceId, abilityIndex: 0 }, reg);
    expect(loyaltyOf(onBattlefield(s, lili.instanceId)!)).toBe(4); // paid up front
    s = pass(s, reg);
    s = pass(s, reg); // resolve → first question

    // APNAP: the active player (A) chooses first, from A's own hand.
    expect(s.pendingChoice?.chooser).toBe('A');
    s = answer(s, reg, { kind: 'selectCards', instanceIds: [tossA!.instanceId] });
    expect(s.pendingChoice?.chooser).toBe('B');
    s = answer(s, reg, { kind: 'selectCards', instanceIds: [tossB!.instanceId] });

    expect(s.players.A.hand.map((c) => c.instanceId)).toEqual([keepA!.instanceId]);
    expect(s.players.B.hand.map((c) => c.instanceId)).toEqual([keepB!.instanceId]);
    expect(s.players.A.graveyard.some((c) => c.instanceId === tossA!.instanceId)).toBe(true);
    expect(s.players.B.graveyard.some((c) => c.instanceId === tossB!.instanceId)).toBe(true);
  });

  it('−2: the targeted player sacrifices a creature THEY choose (an edict, not targeted removal)', () => {
    let s = gameAtMain(reg, 303);
    const lili = place(s, LILIANA, 'A');
    const big = place(s, getByName('Serra Angel'), 'B');
    const small = place(s, GOBLIN, 'B');

    s = act(
      s,
      { kind: 'activateAbility', player: 'A', instanceId: lili.instanceId, abilityIndex: 1, targets: ['B'] },
      reg,
    );
    expect(loyaltyOf(onBattlefield(s, lili.instanceId)!)).toBe(1); // 3 − 2
    s = pass(s, reg);
    s = pass(s, reg); // resolve → the victim's question

    expect(s.pendingChoice?.chooser).toBe('B');
    // B keeps the angel by sacrificing the goblin — the choice is theirs.
    s = answer(s, reg, { kind: 'selectCards', instanceIds: [small.instanceId] });
    expect(onBattlefield(s, big.instanceId)).toBeDefined();
    expect(onBattlefield(s, small.instanceId)).toBeUndefined();
    expect(s.players.B.graveyard.some((c) => c.instanceId === small.instanceId)).toBe(true);
  });

  it('−6: the controller splits the piles, the victim picks which pile is sacrificed', () => {
    let s = gameAtMain(reg, 304);
    const lili = place(s, LILIANA, 'A', 7); // ticked up over several turns
    const angel = place(s, getByName('Serra Angel'), 'B');
    const goblin = place(s, GOBLIN, 'B');
    const mountain = place(s, MOUNTAIN, 'B');

    s = act(
      s,
      { kind: 'activateAbility', player: 'A', instanceId: lili.instanceId, abilityIndex: 2, targets: ['B'] },
      reg,
    );
    expect(loyaltyOf(onBattlefield(s, lili.instanceId)!)).toBe(1); // 7 − 6
    s = pass(s, reg);
    s = pass(s, reg);

    // Question 1: A (the controller) separates B's permanents into two piles.
    expect(s.pendingChoice?.chooser).toBe('A');
    expect(s.pendingChoice?.kind).toBe('selectCards');
    // Pile 1: the angel alone. Pile 2: goblin + mountain.
    s = answer(s, reg, { kind: 'selectCards', instanceIds: [angel.instanceId] });

    // Question 2: B picks which pile is sacrificed — they give up the angel.
    expect(s.pendingChoice?.chooser).toBe('B');
    expect(s.pendingChoice?.kind).toBe('chooseModes');
    s = answer(s, reg, { kind: 'chooseModes', modeIds: ['pile1'] });

    expect(onBattlefield(s, angel.instanceId)).toBeUndefined();
    expect(s.players.B.graveyard.some((c) => c.instanceId === angel.instanceId)).toBe(true);
    expect(onBattlefield(s, goblin.instanceId)).toBeDefined();
    expect(onBattlefield(s, mountain.instanceId)).toBeDefined();
  });

  it('a second loyalty activation in the same turn is refused', () => {
    let s = gameAtMain(reg, 305);
    const lili = place(s, LILIANA, 'A');
    setHand(s, 'A', [SWAMP]);
    setHand(s, 'B', [MOUNTAIN]);
    s = act(s, { kind: 'activateAbility', player: 'A', instanceId: lili.instanceId, abilityIndex: 0 }, reg);
    s = pass(s, reg);
    s = pass(s, reg);
    // Answer both discard questions (each hand has one card → trivial? one card
    // with min=max=1 IS trivial and auto-answers; accept either path).
    while (s.pendingChoice) {
      const choice = s.pendingChoice;
      s = answer(s, reg, {
        kind: 'selectCards',
        instanceIds: choice.kind === 'selectCards' ? choice.candidates.slice(0, 1).map((c) => c.instanceId) : [],
      });
    }
    const again = applyAction(
      s,
      { kind: 'activateAbility', player: 'A', instanceId: lili.instanceId, abilityIndex: 1, targets: ['B'] },
      DEFAULT_RULES,
      reg,
    );
    const rejected = again.events.find((e) => e.type === 'actionRejected');
    expect(rejected && (rejected as { reason: string }).reason).toMatch(/already activated a loyalty ability/);
  });

  it('Lightning Bolt finishes her off — "any target" includes planeswalkers, no redirection', () => {
    let s = gameAtMain(reg, 306);
    // B's turn is not needed: A bolts their OWN opponent's walker. Put Liliana
    // on B's side and bolt from A.
    const lili = place(s, LILIANA, 'B');
    const [bolt] = setHand(s, 'A', [BOLT]);
    floodMana(s, 'A');
    s = act(s, { kind: 'castSpell', player: 'A', instanceId: bolt!.instanceId, targets: [lili.instanceId] }, reg);
    s = pass(s, reg);
    s = pass(s, reg);
    expect(onBattlefield(s, lili.instanceId)).toBeUndefined();
    expect(s.players.B.graveyard.some((c) => c.instanceId === lili.instanceId)).toBe(true);
    // Not a point of it went to the player.
    expect(s.players.B.life).toBe(DEFAULT_RULES.startingLife);
  });
});

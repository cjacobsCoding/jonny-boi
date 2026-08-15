/**
 * The pilot answering a REAL card's choice, through the real effect registry.
 *
 * `packages/ai` may not depend on `@jonny-boi/cards`, so its own choice tests build
 * inline fixtures. That leaves one gap only this package can close: the pilot's mode
 * scoring reads a modal card's authored `modes` data by primitive **id**, and a
 * mismatch between the ids the pilot prices and the ids `cards` actually registers
 * would be invisible to both packages' suites while silently degrading every mode to
 * "unknown" (the exact failure `heuristic.ts` documents for `destroyTarget`). So the
 * assertions here are made against the pool's genuine Cryptic Command, resolved by
 * the genuine `modal` / `counterSpell` / `returnToHand` / `tapPermanents` /
 * `drawCards` primitives, and are checked by their EFFECT on the board rather than
 * by the answer object.
 */

import { describe, expect, it } from 'vitest';
import {
  applyAction,
  createGame,
  createRng,
  DEFAULT_RULES,
  generateLegalActions,
  type CardDefinition,
  type CardInstance,
  type GameState,
  type InstanceId,
  type ManaPool,
  type PlayerId,
} from '@jonny-boi/core';
import { buildRegistry, loadCardPool } from '@jonny-boi/cards';
import { createDefaultAiRegistry, HEURISTIC_PILOT_ID } from '@jonny-boi/ai';

const pool = loadCardPool({ onWarn: () => {} });
const registry = buildRegistry();

/** A pool card by name — a missing one is a test bug, not a runtime condition. */
function card(name: string): CardDefinition {
  const def = pool.getByName(name);
  if (!def) throw new Error(`pool has no card named "${name}"`);
  return def;
}

const CRYPTIC = card('Cryptic Command');
const ISLAND = card('Island');

/** Mint a card instance straight into a zone (test positions only). */
function place(state: GameState, def: CardDefinition, player: PlayerId, zone: CardInstance['zone']): CardInstance {
  const inst: CardInstance = {
    instanceId: state.nextInstanceId++ as InstanceId,
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
  if (zone === 'battlefield') state.battlefield.push(inst);
  else if (zone === 'hand') state.players[player].hand.push(inst);
  return inst;
}

/** Enough floating mana to cast anything in the pool without tapping lands. */
function fillPool(state: GameState, player: PlayerId): void {
  const full: ManaPool = { W: 9, U: 9, B: 9, R: 9, G: 9, C: 9 };
  state.players[player].manaPool = full;
}

/**
 * Cast Cryptic Command at `target` and pass until it resolves far enough to park
 * its "choose two" question. Returns the state with the choice pending.
 */
function parkCrypticOn(target: (state: GameState) => InstanceId | undefined, seed = 7): GameState {
  const created = createGame({
    seed,
    registry,
    decks: {
      A: { cards: Array.from({ length: 30 }, () => ISLAND) },
      B: { cards: Array.from({ length: 30 }, () => ISLAND) },
    },
  });
  let state = created.state;
  let guard = 0;
  while (state.step !== 'precombatMain' && guard++ < 50) {
    state = applyAction(state, { kind: 'passPriority', player: state.priorityPlayer }, DEFAULT_RULES, registry).state;
  }
  const targetId = target(state);
  const spell = place(state, CRYPTIC, 'A', 'hand');
  fillPool(state, 'A');
  state = applyAction(
    state,
    {
      kind: 'castSpell',
      player: 'A',
      instanceId: spell.instanceId,
      ...(targetId === undefined ? {} : { targets: [targetId] }),
    },
    DEFAULT_RULES,
    registry,
  ).state;
  state = applyAction(state, { kind: 'passPriority', player: 'A' }, DEFAULT_RULES, registry).state;
  return applyAction(state, { kind: 'passPriority', player: 'B' }, DEFAULT_RULES, registry).state;
}

/** Let the heuristic pilot answer the parked choice and apply its answer. */
function answerWithPilot(state: GameState): GameState {
  const pilot = createDefaultAiRegistry().getPilot(HEURISTIC_PILOT_ID);
  if (!pilot) throw new Error('no heuristic pilot');
  const action = pilot.chooseAction({
    view: state,
    legalActions: generateLegalActions(state),
    rng: createRng(1),
    registry,
    rulesConfig: DEFAULT_RULES,
  });
  const result = applyAction(state, action, DEFAULT_RULES, registry);
  expect(result.events.some((e) => e.type === 'actionRejected')).toBe(false);
  return result.state;
}

describe('the heuristic pilot casting the pool’s real Cryptic Command', () => {
  it('draws a card and taps the board rather than bouncing a land', () => {
    // "Choose two" with only a land targeted: drawing and tapping their creatures
    // both beat spending half the spell to return a Forest. (The old pilot took the
    // two printed-first modes — counter and bounce — and never drew.)
    const state = parkCrypticOn((s) => {
      place(s, card('Grizzly Bears'), 'B', 'battlefield');
      return place(s, card('Forest'), 'B', 'battlefield').instanceId;
    });
    expect(state.pendingChoice?.kind).toBe('chooseModes');
    const handBefore = state.players.A.hand.length;
    const done = answerWithPilot(state);
    expect(done.players.A.hand.length).toBe(handBefore + 1);
    expect(done.battlefield.some((c) => c.def.name === 'Forest')).toBe(true);
    expect(done.battlefield.find((c) => c.def.name === 'Grizzly Bears')?.tapped).toBe(true);
  });

  it('bounces a real threat rather than leaving it alone', () => {
    const state = parkCrypticOn((s) => place(s, card('Serra Angel'), 'B', 'battlefield').instanceId);
    const done = answerWithPilot(state);
    expect(done.battlefield.some((c) => c.def.name === 'Serra Angel')).toBe(false);
    expect(done.players.B.hand.some((c) => c.def.name === 'Serra Angel')).toBe(true);
  });

  it('never bounces its OWN permanent', () => {
    const state = parkCrypticOn((s) => place(s, card('Serra Angel'), 'A', 'battlefield').instanceId);
    const done = answerWithPilot(state);
    expect(done.battlefield.some((c) => c.controller === 'A' && c.def.name === 'Serra Angel')).toBe(true);
  });

  it('taps the opponent’s board when that is the mode that matters', () => {
    const state = parkCrypticOn((s) => {
      for (let i = 0; i < 3; i++) place(s, card('Serra Angel'), 'B', 'battlefield');
      return undefined; // no target chosen: counter/bounce are off the menu
    });
    const done = answerWithPilot(state);
    const theirs = done.battlefield.filter((c) => c.controller === 'B' && c.def.name === 'Serra Angel');
    expect(theirs.length).toBe(3);
    expect(theirs.every((c) => c.tapped)).toBe(true);
  });
});

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
 * Cast Cryptic Command and stop at its first cast-time question.
 *
 * Modes are announced AS THE SPELL IS CAST (CR 601.2b), so the question is
 * standing the moment `castSpell` is applied — nothing has to resolve first, and
 * nobody has had priority to respond. `setup` builds the board the pilot will
 * price its modes against; the cast itself names no target, because a modal
 * spell aims per mode rather than as a whole card.
 */
function parkCrypticOn(setup: (state: GameState) => void, seed = 7): GameState {
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
  setup(state);
  const spell = place(state, CRYPTIC, 'A', 'hand');
  fillPool(state, 'A');
  return applyAction(
    state,
    { kind: 'castSpell', player: 'A', instanceId: spell.instanceId },
    DEFAULT_RULES,
    registry,
  ).state;
}

/**
 * Answer every cast-time question with the pilot, then let the spell resolve.
 * A modal cast asks two kinds of question in a row (which modes, then where each
 * one points), so a test that answered only the first would be measuring half a
 * decision.
 */
function settleWithPilot(state: GameState, max = 20): GameState {
  let s = state;
  let guard = 0;
  while ((s.pendingChoice || s.stack.length > 0) && !s.gameOver && guard++ < max) {
    s = s.pendingChoice
      ? answerWithPilot(s)
      : applyAction(s, { kind: 'passPriority', player: s.priorityPlayer }, DEFAULT_RULES, registry).state;
  }
  return s;
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
  it('asks for its modes AT CAST — the whole point of the cast-time system', () => {
    const state = parkCrypticOn((s) => {
      place(s, card('Grizzly Bears'), 'B', 'battlefield');
    });
    expect(state.pendingChoice?.kind).toBe('chooseModes');
    // Still on the stack, unresolved, with the caster holding priority: the
    // modes are committed to before the opponent may respond.
    expect(state.stack).toHaveLength(1);
  });

  it('draws a card and taps the board rather than bouncing a land', () => {
    // Drawing and tapping their creature both beat spending half the spell to
    // return a Forest. (The old pilot took the two printed-first modes — counter
    // and bounce — and never drew.)
    const state = parkCrypticOn((s) => {
      place(s, card('Grizzly Bears'), 'B', 'battlefield');
      place(s, card('Forest'), 'B', 'battlefield');
    });
    const handBefore = state.players.A.hand.length;
    const done = settleWithPilot(state);
    expect(done.players.A.hand.length).toBe(handBefore + 1);
    // The LAND is what must survive: spending half a four-mana spell to return a
    // Forest is the blunder under test. Whether the Bear is bounced or tapped is
    // a real judgement call the pilot is entitled to make either way.
    expect(done.battlefield.some((c) => c.def.name === 'Forest')).toBe(true);
    const bear = done.battlefield.find((c) => c.def.name === 'Grizzly Bears');
    expect(bear === undefined || bear.tapped).toBe(true);
  });

  it('bounces a real threat rather than leaving it alone', () => {
    const state = parkCrypticOn((s) => {
      place(s, card('Serra Angel'), 'B', 'battlefield');
    });
    const done = settleWithPilot(state);
    expect(done.battlefield.some((c) => c.def.name === 'Serra Angel')).toBe(false);
    expect(done.players.B.hand.some((c) => c.def.name === 'Serra Angel')).toBe(true);
  });

  it('never bounces its OWN permanent when the opponent has one to bounce', () => {
    const state = parkCrypticOn((s) => {
      place(s, card('Serra Angel'), 'A', 'battlefield');
      place(s, card('Grizzly Bears'), 'B', 'battlefield');
    });
    const done = settleWithPilot(state);
    expect(done.battlefield.some((c) => c.controller === 'A' && c.def.name === 'Serra Angel')).toBe(true);
  });

  it('taps the opponent’s board when that is the mode that matters', () => {
    const state = parkCrypticOn((s) => {
      for (let i = 0; i < 3; i++) place(s, card('Serra Angel'), 'B', 'battlefield');
    });
    const done = settleWithPilot(state);
    const theirs = done.battlefield.filter((c) => c.controller === 'B' && c.def.name === 'Serra Angel');
    // One may have been bounced (that is a real choice here); the ones that
    // stayed are all tapped, which is the mode under test.
    expect(theirs.length).toBeGreaterThanOrEqual(2);
    expect(theirs.every((c) => c.tapped)).toBe(true);
  });
});

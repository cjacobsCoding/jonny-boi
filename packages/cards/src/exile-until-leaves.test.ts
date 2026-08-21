/**
 * THE O-RING PATTERN, PLAYED — exile until this leaves the battlefield.
 *
 * Fiend Hunter and Banisher Priest are the same machine in two printings: a
 * creature exiles something on the way in and gives it back on the way out. What
 * makes it a system rather than a card script is the LINK — two of these on the
 * battlefield have each taken their own prisoner, and killing one must return
 * exactly its own.
 *
 * Three things are pinned here, and each is a way the card gets it wrong:
 *
 *  1. The card actually comes back when the jailer dies. A one-way exile is a
 *     strictly better card than the one printed.
 *  2. Two jailers do not return each other's prisoner.
 *  3. Fiend Hunter cannot name ITSELF ("another target creature"). Let it, and
 *     it exiles itself → it leaves → the leave trigger returns it → it enters →
 *     it triggers again, unbounded. That is DESIGN §3.33's shape, and it is why
 *     `targetsExcludeSelf` exists.
 */

import { describe, expect, it } from 'vitest';
import type { CardDefinition, GameAction, GameState, InstanceId, PlayerId } from '@jonny-boi/core';
import {
  applyAction,
  createGame,
  DEFAULT_RULES,
  defaultAnswerFor,
  legalTargetsFor,
} from '@jonny-boi/core';
import { buildRegistry } from './pool.js';
import { CARD_POOL } from '../data/pool.js';

type Registry = ReturnType<typeof buildRegistry>;

const SEED = 60613;

function getByName(name: string): CardDefinition {
  const card = CARD_POOL.find((entry) => entry.name === name);
  if (!card) throw new Error(`pool missing ${name}`);
  return card;
}

const FOREST = getByName('Forest');
const FIEND_HUNTER = getByName('Fiend Hunter');
const PRISONER = getByName('Grizzly Bears');

function act(state: GameState, action: GameAction, reg: Registry): GameState {
  const result = applyAction(state, action, DEFAULT_RULES, reg);
  const rejected = result.events.find((e) => e.type === 'actionRejected');
  if (rejected) throw new Error(`unexpected rejection: ${(rejected as { reason: string }).reason}`);
  return result.state;
}

function pass(state: GameState, reg: Registry): GameState {
  const question = state.pendingChoice;
  if (question) {
    return act(
      state,
      { kind: 'answerChoice', player: question.chooser, choiceId: question.id, answer: defaultAnswerFor(question) },
      reg,
    );
  }
  return act(state, { kind: 'passPriority', player: state.priorityPlayer }, reg);
}

function place(state: GameState, def: CardDefinition, controller: PlayerId): InstanceId {
  const id = state.nextInstanceId++;
  state.battlefield.push({
    instanceId: id,
    def,
    controller,
    owner: controller,
    zone: 'battlefield',
    tapped: false,
    summoningSick: false,
    damageMarked: 0,
    markedByDeathtouch: false,
    attachedTo: null,
    counters: {},
  });
  return id;
}

function openBoard(reg: Registry): GameState {
  const { state } = createGame({
    seed: SEED,
    decks: {
      A: { cards: Array.from({ length: 60 }, () => FOREST) },
      B: { cards: Array.from({ length: 60 }, () => FOREST) },
    },
    registry: reg,
  });
  let s = state;
  let guard = 0;
  while (s.step !== 'precombatMain' && !s.gameOver && guard++ < 400) s = pass(s, reg);
  s.players.A.manaPool = { W: 9, U: 9, B: 9, R: 9, G: 9, C: 9 };
  s.players.B.manaPool = { W: 9, U: 9, B: 9, R: 9, G: 9, C: 9 };
  return s;
}

/** Run the exile primitive directly, with an explicit target. */
function exileWith(state: GameState, jailer: InstanceId, victim: InstanceId, reg: Registry): GameState {
  const primitive = reg.get('exileUntilLeaves');
  expect(primitive, 'exileUntilLeaves must be registered').toBeDefined();
  const source = state.battlefield.find((c) => c.instanceId === jailer)!;
  primitive!({
    state,
    source,
    controller: source.controller,
    targets: [victim],
    params: { targets: 'creature', max: 1 },
    emit: () => {},
    ask: () => undefined,
  } as never);
  return state;
}

/** Run the return primitive for one jailer. */
function returnFrom(state: GameState, jailer: InstanceId, reg: Registry): GameState {
  const primitive = reg.get('returnExiledByThis');
  const source =
    state.battlefield.find((c) => c.instanceId === jailer) ??
    ({ instanceId: jailer, controller: 'A', owner: 'A' } as never);
  primitive!({
    state,
    source,
    controller: 'A',
    targets: [],
    params: { to: 'battlefield' },
    emit: () => {},
    ask: () => undefined,
  } as never);
  return state;
}

describe('exile until this leaves the battlefield', () => {
  it('gives the card back when the jailer goes away', () => {
    const reg = buildRegistry();
    let s = openBoard(reg);
    const jailer = place(s, FIEND_HUNTER, 'A');
    const victim = place(s, PRISONER, 'B');

    s = exileWith(s, jailer, victim, reg);
    expect(s.battlefield.some((c) => c.instanceId === victim), 'the victim is exiled').toBe(false);
    expect(s.players.B.exile.some((c) => c.instanceId === victim), 'to its OWNER’s exile').toBe(true);

    s = returnFrom(s, jailer, reg);
    const back = s.battlefield.find((c) => c.instanceId === victim);
    expect(back, 'the victim comes back').toBeDefined();
    expect(back?.controller, 'under its OWNER’s control, not the jailer’s').toBe('B');
  });

  it('two jailers each return their OWN prisoner', () => {
    // The link is the whole mechanic. A naive "return everything in exile" would
    // pass the test above and fail this one.
    const reg = buildRegistry();
    let s = openBoard(reg);
    const jailerA = place(s, FIEND_HUNTER, 'A');
    const jailerB = place(s, FIEND_HUNTER, 'A');
    const victimA = place(s, PRISONER, 'B');
    const victimB = place(s, getByName('Runeclaw Bear'), 'B');

    s = exileWith(s, jailerA, victimA, reg);
    s = exileWith(s, jailerB, victimB, reg);
    s = returnFrom(s, jailerA, reg);

    expect(s.battlefield.some((c) => c.instanceId === victimA), "A's prisoner returned").toBe(true);
    expect(
      s.battlefield.some((c) => c.instanceId === victimB),
      "B's prisoner must stay exiled — it is not A's to return",
    ).toBe(false);
  });

  it('Fiend Hunter cannot target ITSELF — the unbounded-loop guard', () => {
    const reg = buildRegistry();
    const s = openBoard(reg);
    const jailer = place(s, FIEND_HUNTER, 'A');
    place(s, PRISONER, 'B');

    // What the engine offers for the ability, with the exclusion its compiled
    // trigger declares (`targetsExcludeSelf`).
    const offered = legalTargetsFor(s, 'creature', 'A', FIEND_HUNTER, jailer);
    expect(offered, 'exiling itself would re-trigger itself for ever').not.toContain(jailer);
    expect(offered.length, 'but it still has something to point at').toBeGreaterThan(0);
  });

  it('Banisher Priest compiles both halves from ONE printed sentence', () => {
    // The modern wording folds the return into the exile clause. Compiling only
    // the exile would be removal with no drawback — a strictly better card.
    const priest = getByName('Banisher Priest');
    const events = (priest.triggers ?? []).map((t) => t.condition.on);
    expect(events).toContain('etb');
    expect(events, 'the return half must exist').toContain('leaves');
  });
});

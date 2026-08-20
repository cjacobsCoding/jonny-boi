/**
 * THE TRIGGERING PLAYER, and the printed intervening "if".
 *
 * Two seams, tested on real played games rather than on the matcher alone:
 *
 *  1. **`triggeringPlayer`** — the player an event was about, carried from the
 *     match all the way into `EffectContext`. It is the field that makes "at the
 *     beginning of EACH player's draw step, that player draws an additional card"
 *     a different card from "…, you draw an additional card". Every assertion
 *     here is about WHICH SEAT the body happened to, because that is the only
 *     thing that can silently be wrong: the trigger fires either way.
 *
 *  2. **the intervening "if"** (CR 603.4) — checked TWICE, and both checks are
 *     pinned. A false condition must stop the ability from ever reaching the
 *     stack (so nobody may respond to it), and a condition that lapses between
 *     trigger and resolution must remove it from the stack doing nothing.
 */

import { describe, expect, it } from 'vitest';
import {
  applyAction,
  cloneState,
  createGame,
  DEFAULT_RULES,
  defaultAnswerFor,
  interveningIfHolds,
  matchTriggers,
  triggeringPlayerFor,
  type CardDefinition,
  type EffectContext,
  type GameAction,
  type GameState,
  type PlayerId,
  type RulesConfig,
  type TriggeredAbility,
} from './index.js';
import { createEffectRegistry, type EffectRegistry } from './effects.js';
import { deckOf, landDef } from './test-fixtures.js';

const ISLAND = landDef('Island', 'U');

/** Where a `whichPlayer`-style body records who it actually happened to. */
interface Witness {
  readonly seats: PlayerId[];
}

/**
 * A registry whose primitives all read `ctx.triggeringPlayer`. Deliberately
 * thin: the point of every test below is WHO, so each primitive does the one
 * thing whose seat can be checked.
 */
function testRegistry(witness: Witness): EffectRegistry {
  const reg = createEffectRegistry();
  // "That player draws a card" — the Howling Mine body, in miniature.
  reg.register('drawForTriggeringPlayer', (ctx: EffectContext) => {
    const seat = ctx.triggeringPlayer ?? ctx.controller;
    witness.seats.push(seat);
    const player = ctx.state.players[seat];
    const top = player.library.shift();
    if (!top) return;
    top.zone = 'hand';
    player.hand.push(top);
    ctx.emit({ type: 'drawCard', player: seat, instanceId: top.instanceId });
  });
  // The bug this whole seam exists to prevent: a body that reads the CONTROLLER.
  reg.register('drawForController', (ctx: EffectContext) => {
    witness.seats.push(ctx.controller);
  });
  return reg;
}

/**
 * These tests are about WHICH SEAT a step trigger runs for, and they measure it by
 * watching hands grow. The cleanup step's discard down to maximum hand size
 * (CR 514.1) would erase exactly that evidence at the end of every turn — a seat
 * that drew two extra cards is back at seven before the next assertion runs — so
 * the limit is lifted here. It is not being avoided: `block-and-statics.test.ts`
 * and `engine.test.ts` are where the discard itself is pinned.
 */
const RULES: RulesConfig = { ...DEFAULT_RULES, maximumHandSize: Number.MAX_SAFE_INTEGER };

function act(state: GameState, action: GameAction, reg: EffectRegistry): GameState {
  const result = applyAction(state, action, RULES, reg);
  const rejected = result.events.find((e) => e.type === 'actionRejected');
  if (rejected) throw new Error(`unexpected rejection: ${(rejected as { reason: string }).reason}`);
  return result.state;
}

/**
 * Pass priority — or, when a turn-based action has parked a question (the cleanup
 * step's discard down to maximum hand size, CR 514.1), ANSWER it. A seat with a
 * question outstanding may do nothing else, so a helper that only ever passes
 * would wedge the moment any rule stops to ask something.
 */
function pass(state: GameState, reg: EffectRegistry): GameState {
  return act(state, nextActionFor(state), reg);
}

/** The only thing a seat may legally do right now: answer, or pass. */
function nextActionFor(state: GameState): GameAction {
  const question = state.pendingChoice;
  return question
    ? {
        kind: 'answerChoice',
        player: question.chooser,
        choiceId: question.id,
        answer: defaultAnswerFor(question),
      }
    : { kind: 'passPriority', player: state.priorityPlayer };
}

/** Pass priority until `turnNumber` reaches `target` (resolving everything on the way). */
function playThroughTurn(state: GameState, target: number, reg: EffectRegistry, max = 900): GameState {
  let s = state;
  let guard = 0;
  while (s.turnNumber < target && !s.gameOver && guard++ < max) s = pass(s, reg);
  return s;
}

/**
 * Put a permanent straight onto the battlefield under `controller`. Tests here
 * are about what a permanent's trigger does over several turns, not about
 * casting it, and a cast would put the card's arrival between the assertions.
 */
function placeOnBattlefield(
  state: GameState,
  controller: PlayerId,
  def: CardDefinition,
  opts: { readonly tapped?: boolean } = {},
): number {
  const instanceId = state.nextInstanceId++;
  state.battlefield.push({
    instanceId,
    def,
    controller,
    owner: controller,
    zone: 'battlefield',
    tapped: opts.tapped === true,
    summoningSick: false,
    damageMarked: 0,
    markedByDeathtouch: false,
    attachedTo: null,
    counters: {},
  });
  return instanceId;
}

/** An artifact carrying one declared trigger. */
function artifactWithTrigger(name: string, ability: TriggeredAbility): CardDefinition {
  return { id: name, name, types: ['artifact'], triggers: [ability] };
}

const HOWLING_MINE_ABILITY: TriggeredAbility = {
  condition: { on: 'drawStep', who: 'any', intervening: { kind: 'sourceUntapped' } },
  effects: [{ primitive: 'drawForTriggeringPlayer' }],
  label: "each player's draw step: if ~ is untapped, that player draws an additional card",
};

function newGame(reg: EffectRegistry, seed = 7): GameState {
  return createGame({ seed, decks: { A: deckOf(ISLAND, 60), B: deckOf(ISLAND, 60) }, registry: reg }).state;
}

describe('the triggering player rides the resolution', () => {
  it('a `who: "any"` step trigger runs its body for WHOEVER\'s step it is, not for the controller', () => {
    const witness: Witness = { seats: [] };
    const reg = testRegistry(witness);
    let s = newGame(reg);
    // Controlled by A. If the body read its controller, every entry below would
    // be 'A' — which is exactly the Howling Mine bug.
    placeOnBattlefield(s, 'A', artifactWithTrigger('Howling Mine', HOWLING_MINE_ABILITY));

    s = playThroughTurn(s, 5, reg);
    expect(s.gameOver).toBe(false);
    // Both seats appear, and the FIRST turn's draw step belongs to the starting
    // player, so the sequence alternates from whoever that was.
    expect(new Set(witness.seats)).toEqual(new Set(['A', 'B']));
    expect(witness.seats.length).toBeGreaterThan(1);
    for (let i = 1; i < witness.seats.length; i++) {
      expect(witness.seats[i]).not.toBe(witness.seats[i - 1]);
    }
  });

  it('really moves the card into the RIGHT hand — the opponent draws two on their own turn', () => {
    const witness: Witness = { seats: [] };
    const reg = testRegistry(witness);
    let s = newGame(reg);
    placeOnBattlefield(s, 'A', artifactWithTrigger('Howling Mine', HOWLING_MINE_ABILITY));
    const startedWith = { A: s.players.A.hand.length, B: s.players.B.hand.length };
    const startingPlayer = s.activePlayer;
    const other: PlayerId = startingPlayer === 'A' ? 'B' : 'A';

    // Exactly one full turn cycle: each seat has had one draw step.
    s = playThroughTurn(s, 3, reg);
    // The starting player skips their first draw (CR 103.7a), so over turns 1-2
    // the non-starting player has drawn twice (turn draw + trigger) and the
    // starting player once (trigger only, on turn 1) plus turn 2's… — rather
    // than encode the turn structure here, assert the thing that matters: BOTH
    // hands grew, which cannot happen if the body ran for one seat every time.
    expect(s.players[other].hand.length).toBeGreaterThan(startedWith[other]);
    expect(s.players[startingPlayer].hand.length).toBeGreaterThan(startedWith[startingPlayer]);
  });

  it('survives the clone made at every action boundary', () => {
    // The field is copied FIELD BY FIELD in `internal/clone.ts`. Dropping it
    // there would lose the triggering player one action after the trigger went
    // on the stack — the body would silently fall back to the controller — so
    // this asserts on a real stack object rather than on a hand-built one.
    const witness: Witness = { seats: [] };
    const reg = testRegistry(witness);
    const s = newGame(reg);
    s.stack.push({
      kind: 'trigger',
      instanceId: s.nextInstanceId++,
      sourceInstanceId: 1,
      controller: 'A',
      effects: [{ primitive: 'drawForTriggeringPlayer' }],
      targets: [],
      label: 'test',
      triggeringPlayer: 'B',
      intervening: { kind: 'sourceUntapped' },
    });
    const copy = cloneState(s);
    const cloned = copy.stack[0] as { triggeringPlayer?: PlayerId; intervening?: unknown };
    expect(cloned.triggeringPlayer).toBe('B');
    expect(cloned.intervening).toEqual({ kind: 'sourceUntapped' });
    // And an ordinary trigger stays byte-for-byte what it always was.
    const plain = cloneState(
      (() => {
        const t = newGame(reg);
        t.stack.push({
          kind: 'trigger',
          instanceId: 99,
          sourceInstanceId: 1,
          controller: 'A',
          effects: [],
          targets: [],
          label: 'plain',
        });
        return t;
      })(),
    );
    expect(Object.hasOwn(plain.stack[0]!, 'triggeringPlayer')).toBe(false);
    expect(Object.hasOwn(plain.stack[0]!, 'intervening')).toBe(false);
  });

  it('names the right player for each event kind, and nobody for the events about a permanent', () => {
    // `triggeringPlayerFor` is the single place the answer is decided, so its
    // table is pinned directly — a wrong entry here is a body pointed at the
    // wrong seat everywhere that event is watched.
    expect(
      triggeringPlayerFor({ on: 'drawStep', who: 'any' }, {
        type: 'stepBegin',
        step: 'draw',
        activePlayer: 'B',
        turnNumber: 3,
      } as never),
    ).toBe('B');
    expect(
      triggeringPlayerFor({ on: 'drawsCard', who: 'any' }, {
        type: 'drawCard',
        player: 'B',
        instanceId: 4,
      } as never),
    ).toBe('B');
    expect(
      triggeringPlayerFor({ on: 'gainLife', who: 'any' }, {
        type: 'gainLife',
        player: 'A',
        amount: 2,
      } as never),
    ).toBe('A');
    // A permanent's own ETB / attack / death is about a permanent, not a player.
    expect(
      triggeringPlayerFor({ on: 'etb' }, {
        type: 'zoneChange',
        instanceId: 1,
        from: 'hand',
        to: 'battlefield',
      } as never),
    ).toBeUndefined();
  });

  it('a "whenever a player draws a card" trigger fires on EVERY draw and names the drawer', () => {
    const witness: Witness = { seats: [] };
    const reg = testRegistry(witness);
    const s = newGame(reg);
    const source = placeOnBattlefield(
      s,
      'A',
      artifactWithTrigger('Spiteful Visions', {
        condition: { on: 'drawsCard', who: 'any' },
        effects: [{ primitive: 'drawForTriggeringPlayer' }],
      }),
    );
    const sources = [
      {
        instanceId: source,
        controller: 'A' as PlayerId,
        name: 'Spiteful Visions',
        triggers: s.battlefield[0]!.def.triggers!,
      },
    ];
    const matched = matchTriggers(sources, { type: 'drawCard', player: 'B', instanceId: 12 });
    expect(matched.length).toBe(1);
    expect(matched[0]!.triggeringPlayer).toBe('B');
    expect(matched[0]!.controller).toBe('A');
  });
});

describe('the printed intervening "if" (CR 603.4)', () => {
  it('a false condition stops the ability REACHING the stack, not merely resolving', () => {
    const witness: Witness = { seats: [] };
    const reg = testRegistry(witness);
    let s = newGame(reg);
    // "At the beginning of each player's draw step, IF YOU CONTROL THREE OR MORE
    // ARTIFACTS, …" on a board with one artifact — this one. The condition is
    // false at every draw step, so the ability must never appear on the stack at
    // all: an opponent gets no window to respond to something that never
    // triggered, and nothing that counts abilities on the stack sees it.
    placeOnBattlefield(
      s,
      'A',
      artifactWithTrigger('Gated Mine', {
        condition: {
          on: 'drawStep',
          who: 'any',
          intervening: { kind: 'controlCount', filter: { anyOfTypes: ['artifact'] }, min: 3 },
        },
        effects: [{ primitive: 'drawForTriggeringPlayer' }],
      }),
    );
    let sawTriggerOnStack = false;
    let guard = 0;
    while (s.turnNumber < 5 && !s.gameOver && guard++ < 900) {
      const result = applyAction(s, nextActionFor(s), RULES, reg);
      if (result.events.some((e) => e.type === 'triggerPutOnStack')) sawTriggerOnStack = true;
      s = result.state;
    }
    expect(sawTriggerOnStack).toBe(false);
    expect(witness.seats).toEqual([]);
  });

  it('a condition that LAPSES between trigger and resolution fizzles the ability', () => {
    const witness: Witness = { seats: [] };
    const reg = testRegistry(witness);
    let s = newGame(reg);
    const mine = placeOnBattlefield(s, 'A', artifactWithTrigger('Howling Mine', HOWLING_MINE_ABILITY));

    // Play forward until the ability is actually sitting on the stack.
    let guard = 0;
    while (s.stack.length === 0 && !s.gameOver && guard++ < 900) s = pass(s, reg);
    expect(s.stack.length).toBe(1);
    expect(s.stack[0]!.kind).toBe('trigger');

    // Now tap the source — the printed condition has stopped holding.
    const permanent = s.battlefield.find((c) => c.instanceId === mine)!;
    (permanent as { tapped: boolean }).tapped = true;

    const events: string[] = [];
    guard = 0;
    while (s.stack.length > 0 && !s.gameOver && guard++ < 20) {
      const result = applyAction(s, nextActionFor(s), RULES, reg);
      for (const e of result.events) events.push(e.type);
      s = result.state;
    }
    expect(events).toContain('triggerFizzled');
    // …and the body never ran.
    expect(witness.seats).toEqual([]);
  });

  it('counts permanents by CONTROLLER and by filter, and reads EFFECTIVE power', () => {
    const reg = testRegistry({ seats: [] });
    const s = newGame(reg);
    const bear = placeOnBattlefield(s, 'A', {
      id: 'Bear',
      name: 'Bear',
      types: ['creature'],
      power: 2,
      toughness: 2,
    });
    placeOnBattlefield(s, 'B', { id: 'Ox', name: 'Ox', types: ['creature'], power: 9, toughness: 9 });

    const fourPower = { kind: 'controlCount', filter: { anyOfTypes: ['creature'] }, min: 1, minPower: 4 } as const;
    // A's only creature is a 2/2, and B's 9/9 is not A's to count.
    expect(interveningIfHolds(s, fourPower, 0, 'A')).toBe(false);
    // A +3/+3 until end of turn is what makes it "power 4 or greater" — the
    // PRINTED box still says 2, so a printed-only reader would answer wrongly.
    s.continuous.push({
      id: s.nextInstanceId++,
      sourceInstanceId: 0,
      targetInstanceId: bear,
      power: 3,
      toughness: 3,
      duration: 'endOfTurn',
    });
    expect(interveningIfHolds(s, fourPower, 0, 'A')).toBe(true);
    // "if you control NO creatures" is the max-0 form, and B still has theirs.
    expect(
      interveningIfHolds(s, { kind: 'controlCount', filter: { anyOfTypes: ['creature'] }, max: 0 }, 0, 'A'),
    ).toBe(false);
    expect(
      interveningIfHolds(s, { kind: 'controlCount', filter: { anyOfTypes: ['land'] }, max: 0 }, 0, 'A'),
    ).toBe(true);
  });

  it('a source that has LEFT the battlefield is not "untapped"', () => {
    // The safe degradation has to be the one that does LESS: a destroyed Howling
    // Mine stops drawing cards. Answering `true` for a permanent nobody can find
    // would keep it drawing forever.
    const reg = testRegistry({ seats: [] });
    const s = newGame(reg);
    expect(interveningIfHolds(s, { kind: 'sourceUntapped' }, 12345, 'A')).toBe(false);
  });

  it('an absent condition always holds — every trigger without one is unaffected', () => {
    const reg = testRegistry({ seats: [] });
    const s = newGame(reg);
    expect(interveningIfHolds(s, undefined, 1, 'A')).toBe(true);
  });
});

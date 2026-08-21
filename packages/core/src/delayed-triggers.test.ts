/**
 * DELAYED TRIGGERED ABILITIES (CR 603.7) — `delayed.ts`.
 *
 * Tested on REAL PLAYED GAMES rather than on the matcher alone, because every
 * property that can silently be wrong is about survival across time:
 *
 *  - it fires at its named LATER moment, having been created during a resolution;
 *  - **it survives its source leaving the battlefield** — that is the whole
 *    reason the record lives on `GameState` and not on any object, and it is the
 *    one property a design that hung it off a permanent would fail;
 *  - it fires ONCE and then ceases to exist;
 *  - "the NEXT end step" really is the next one — an ability created DURING an
 *    end step waits for the following turn (CR 603.7e);
 *  - it survives the per-action clone, which is what `internal/clone.ts` is for.
 */

import { describe, expect, it } from 'vitest';
import {
  applyAction,
  cloneState,
  createDelayedTrigger,
  createGame,
  DEFAULT_RULES,
  defaultAnswerFor,
  delayedRemovalTargets,
  dumpState,
  serializeState,
  type CardDefinition,
  type GameAction,
  type GameState,
  type PlayerId,
  type RulesConfig,
} from './index.js';
import { createEffectRegistry, type EffectContext, type EffectRegistry } from './effects.js';
import { deckOf, landDef } from './test-fixtures.js';

const ISLAND = landDef('Island', 'U');

/** The turn's cleanup discard would erase the boards these tests read. */
const RULES: RulesConfig = { ...DEFAULT_RULES, maximumHandSize: Number.MAX_SAFE_INTEGER };

/** What the delayed bodies below record, so a test can say WHEN and WHOSE. */
interface Witness {
  /** One entry per delayed body that ran: the turn and step it ran in. */
  readonly fired: { turn: number; step: string; controller: PlayerId }[];
}

function testRegistry(witness: Witness): EffectRegistry {
  const reg = createEffectRegistry();
  // The body a delayed ability runs. Records WHEN it ran, and removes the
  // permanents its params name — the miniature of `sacrificeNamed`.
  reg.register('delayedRemove', (ctx: EffectContext) => {
    witness.fired.push({ turn: ctx.state.turnNumber, step: ctx.state.step, controller: ctx.controller });
    const ids = Array.isArray(ctx.params.instanceIds) ? (ctx.params.instanceIds as number[]) : [];
    for (const id of ids) {
      const index = ctx.state.battlefield.findIndex((c) => c.instanceId === id);
      if (index >= 0) ctx.state.battlefield.splice(index, 1);
    }
  });
  // An activated ability's body: make a token and schedule its sacrifice. This
  // is Kiki-Jiki in miniature, and the only shape that can prove the ability
  // outlives the object that made it.
  reg.register('tokenThenDelayedSacrifice', (ctx: EffectContext) => {
    const [id] = ctx.createTokens(TOKEN_DEF, 1);
    if (id === undefined) return;
    ctx.createDelayedTrigger({
      condition: { on: 'endStep', who: 'any' },
      effects: [{ primitive: 'delayedRemove', params: { instanceIds: [id] } }],
      label: 'Sacrifice it at the beginning of the next end step',
      removesFromBattlefield: [id],
    });
  });
  return reg;
}

const TOKEN_DEF: CardDefinition = {
  id: 'token:mirror',
  name: 'Mirror Token',
  types: ['creature'],
  power: 2,
  toughness: 2,
  keywords: { haste: true },
};

/** A permanent whose {T} ability makes a token and schedules its sacrifice. */
const MIRROR_BREAKER: CardDefinition = {
  id: 'mirror-breaker',
  name: 'Mirror Breaker',
  types: ['creature'],
  power: 2,
  toughness: 2,
  keywords: { haste: true },
  activated: [
    {
      cost: { tap: true },
      effects: [{ primitive: 'tokenThenDelayedSacrifice' }],
      label: '{T}: create a token, sacrifice it at the beginning of the next end step',
    },
  ],
};

function act(state: GameState, action: GameAction, reg: EffectRegistry): GameState {
  const result = applyAction(state, action, RULES, reg);
  const rejected = result.events.find((e) => e.type === 'actionRejected');
  if (rejected) throw new Error(`unexpected rejection: ${(rejected as { reason: string }).reason}`);
  return result.state;
}

/** The only thing a seat may legally do right now: answer, or pass. */
function nextActionFor(state: GameState): GameAction {
  const question = state.pendingChoice;
  return question
    ? { kind: 'answerChoice', player: question.chooser, choiceId: question.id, answer: defaultAnswerFor(question) }
    : { kind: 'passPriority', player: state.priorityPlayer };
}

function pass(state: GameState, reg: EffectRegistry): GameState {
  return act(state, nextActionFor(state), reg);
}

/** Pass (answering anything asked) until the turn counter reaches `target`. */
function playThroughTurn(state: GameState, target: number, reg: EffectRegistry, max = 900): GameState {
  let s = state;
  let guard = 0;
  while (s.turnNumber < target && !s.gameOver && guard++ < max) s = pass(s, reg);
  return s;
}

/** Pass until the game reaches `step` on the current turn (or runs out of room). */
function playToStep(state: GameState, step: GameState['step'], reg: EffectRegistry, max = 200): GameState {
  let s = state;
  let guard = 0;
  while (s.step !== step && !s.gameOver && guard++ < max) s = pass(s, reg);
  return s;
}

function placeOnBattlefield(state: GameState, controller: PlayerId, def: CardDefinition): number {
  const instanceId = state.nextInstanceId++;
  state.battlefield.push({
    instanceId,
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
  return instanceId;
}

function newGame(reg: EffectRegistry, seed = 11): GameState {
  return createGame({ seed, decks: { A: deckOf(ISLAND, 60), B: deckOf(ISLAND, 60) }, registry: reg }).state;
}

/** How many tokens named `Mirror Token` are on the board right now. */
function tokensOnBoard(state: GameState): number {
  return state.battlefield.filter((c) => c.def.name === TOKEN_DEF.name).length;
}

describe('a delayed triggered ability fires at its named later moment', () => {
  it('is created during a resolution and fires at the next end step, not before', () => {
    const witness: Witness = { fired: [] };
    const reg = testRegistry(witness);
    let s = newGame(reg);
    const source = placeOnBattlefield(s, 'A', MIRROR_BREAKER);
    s = playToStep(s, 'precombatMain', reg);
    s = act(s, { kind: 'activateAbility', player: 'A', instanceId: source, abilityIndex: 0 }, reg);
    // The ability is on the stack; resolve it.
    s = pass(s, reg);
    s = pass(s, reg);

    expect(tokensOnBoard(s)).toBe(1);
    // It is NOT on the stack and NOT on any permanent — it is a record on the
    // state, which is precisely what lets it outlive both.
    expect(s.delayedTriggers).toHaveLength(1);
    expect(witness.fired).toHaveLength(0);

    // Now let the turn reach its end step.
    s = playToStep(s, 'end', reg);
    s = pass(s, reg); // the delayed trigger goes on the stack and resolves
    s = pass(s, reg);

    expect(witness.fired).toHaveLength(1);
    expect(witness.fired[0]?.step).toBe('end');
    expect(tokensOnBoard(s)).toBe(0);
    // And it is GONE — the record is removed the moment it matched.
    expect(s.delayedTriggers).toBeUndefined();
  });

  it('SURVIVES ITS SOURCE LEAVING THE BATTLEFIELD — the whole reason it lives on the state', () => {
    const witness: Witness = { fired: [] };
    const reg = testRegistry(witness);
    let s = newGame(reg);
    const source = placeOnBattlefield(s, 'A', MIRROR_BREAKER);
    s = playToStep(s, 'precombatMain', reg);
    s = act(s, { kind: 'activateAbility', player: 'A', instanceId: source, abilityIndex: 0 }, reg);
    s = pass(s, reg);
    s = pass(s, reg);
    expect(tokensOnBoard(s)).toBe(1);

    // Destroy the source outright — as a Lightning Bolt in response would. Every
    // trigger this engine had before this feature was collected FROM the
    // battlefield, so a design that hung the delayed ability off the permanent
    // would silently lose it right here and the token would live forever: a
    // permanent hasty copy with no drawback, i.e. strictly better than printed.
    const at = s.battlefield.findIndex((c) => c.instanceId === source);
    s.battlefield.splice(at, 1);
    expect(s.battlefield.some((c) => c.instanceId === source)).toBe(false);

    s = playToStep(s, 'end', reg);
    s = pass(s, reg);
    s = pass(s, reg);

    expect(witness.fired).toHaveLength(1);
    expect(tokensOnBoard(s)).toBe(0);
  });

  it('fires ONCE — the next turn\'s end step does not run it again', () => {
    const witness: Witness = { fired: [] };
    const reg = testRegistry(witness);
    let s = newGame(reg);
    const source = placeOnBattlefield(s, 'A', MIRROR_BREAKER);
    s = playToStep(s, 'precombatMain', reg);
    s = act(s, { kind: 'activateAbility', player: 'A', instanceId: source, abilityIndex: 0 }, reg);
    s = pass(s, reg);
    s = pass(s, reg);

    const startTurn = s.turnNumber;
    s = playThroughTurn(s, startTurn + 3, reg);
    // Three more end steps have gone by; the ability ran in exactly one of them.
    expect(witness.fired).toHaveLength(1);
  });

  it('"the NEXT end step" waits for the FOLLOWING turn when created during one (CR 603.7e)', () => {
    const witness: Witness = { fired: [] };
    const reg = testRegistry(witness);
    let s = newGame(reg);
    const source = placeOnBattlefield(s, 'A', MIRROR_BREAKER);
    // Activate DURING the end step, so this turn's beginning-of-the-end-step has
    // already happened. Nothing in `delayed.ts` compares turn numbers to get
    // this right — the ability matches an EVENT, and that event is spent.
    s = playToStep(s, 'end', reg);
    const activatedOnTurn = s.turnNumber;
    s = act(s, { kind: 'activateAbility', player: 'A', instanceId: source, abilityIndex: 0 }, reg);
    s = pass(s, reg);
    s = pass(s, reg);
    expect(tokensOnBoard(s)).toBe(1);

    // Still nothing by the time this turn is over.
    s = playThroughTurn(s, activatedOnTurn + 1, reg);
    expect(witness.fired).toHaveLength(0);
    expect(tokensOnBoard(s)).toBe(1);

    // It fires in the NEXT turn's end step.
    s = playThroughTurn(s, activatedOnTurn + 2, reg);
    expect(witness.fired).toHaveLength(1);
    expect(witness.fired[0]?.turn).toBe(activatedOnTurn + 1);
    expect(tokensOnBoard(s)).toBe(0);
  });

  it('emits both halves of the pair — created, then fired', () => {
    const witness: Witness = { fired: [] };
    const reg = testRegistry(witness);
    let s = newGame(reg);
    const source = placeOnBattlefield(s, 'A', MIRROR_BREAKER);
    s = playToStep(s, 'precombatMain', reg);

    const activation = applyAction(
      s,
      { kind: 'activateAbility', player: 'A', instanceId: source, abilityIndex: 0 },
      RULES,
      reg,
    );
    s = activation.state;
    s = pass(s, reg);
    const resolution = applyAction(s, nextActionFor(s), RULES, reg);
    s = resolution.state;
    const created = [...activation.events, ...resolution.events].filter((e) => e.type === 'delayedTriggerCreated');
    expect(created).toHaveLength(1);

    // Pass until it fires, keeping every event — the firing happens on whichever
    // action carries the game across the beginning of the end step, and pinning
    // WHICH action that is would be pinning the turn machine, not this feature.
    const fired: { label: string }[] = [];
    for (let guard = 0; guard < 200 && fired.length === 0 && !s.gameOver; guard++) {
      const step = applyAction(s, nextActionFor(s), RULES, reg);
      s = step.state;
      for (const e of step.events) if (e.type === 'delayedTriggerFired') fired.push(e);
    }
    expect(fired).toHaveLength(1);
    // The label travels with it, so a log and an inspector can name the clause.
    expect(fired[0]?.label).toContain('Sacrifice');
  });
});

describe('the record itself', () => {
  it('survives the per-action clone, and one state cannot fire the other\'s', () => {
    const witness: Witness = { fired: [] };
    const reg = testRegistry(witness);
    const s = newGame(reg);
    createDelayedTrigger(s, {
      condition: { on: 'endStep', who: 'any' },
      effects: [{ primitive: 'delayedRemove', params: { instanceIds: [] } }],
      label: 'test',
      controller: 'A',
      sourceInstanceId: 1,
      removesFromBattlefield: [42],
    });

    const copy = cloneState(s);
    expect(copy.delayedTriggers).toHaveLength(1);
    // The ARRAY is copied, so removing from one leaves the other alone. This is
    // what stops a cloned state's firing from erasing the original's record.
    copy.delayedTriggers?.splice(0, 1);
    expect(s.delayedTriggers).toHaveLength(1);
    expect(copy.delayedTriggers).toHaveLength(0);
  });

  it('is absent — not empty — in a game that never creates one', () => {
    const reg = testRegistry({ fired: [] });
    const s = newGame(reg);
    expect(s.delayedTriggers).toBeUndefined();
    expect(cloneState(s).delayedTriggers).toBeUndefined();
    // The accessor the pilot reads is the shared frozen empty set, by reference.
    expect(delayedRemovalTargets(s)).toBe(delayedRemovalTargets(cloneState(s)));
  });

  it('names what it will remove, for the pilot', () => {
    const reg = testRegistry({ fired: [] });
    const s = newGame(reg);
    createDelayedTrigger(s, {
      condition: { on: 'endStep', who: 'any' },
      effects: [{ primitive: 'delayedRemove', params: { instanceIds: [7, 8] } }],
      label: 'Sacrifice them at the beginning of the next end step',
      controller: 'A',
      sourceInstanceId: 1,
      removesFromBattlefield: [7, 8],
    });
    const doomed = delayedRemovalTargets(s);
    expect(doomed.has(7)).toBe(true);
    expect(doomed.has(8)).toBe(true);
    expect(doomed.has(9)).toBe(false);
  });

  it('is visible to the inspector — a board with one is unreadable without it', () => {
    const reg = testRegistry({ fired: [] });
    const s = newGame(reg);
    createDelayedTrigger(s, {
      condition: { on: 'endStep', who: 'any' },
      effects: [{ primitive: 'delayedRemove', params: { instanceIds: [7] } }],
      label: 'Sacrifice it at the beginning of the next end step',
      controller: 'A',
      sourceInstanceId: 3,
      removesFromBattlefield: [7],
    });
    const snapshot = serializeState(s);
    expect(snapshot.delayedTriggers).toHaveLength(1);
    expect(snapshot.delayedTriggers?.[0]).toMatchObject({ controller: 'A', sourceInstanceId: 3, on: 'endStep' });
    expect(dumpState(s)).toContain('Sacrifice it at the beginning of the next end step');
  });
});

describe('"your next upkeep" reads the ABILITY\'s controller, not the source\'s', () => {
  it('a delayed upkeep ability owned by B fires on B\'s upkeep, not A\'s', () => {
    const witness: Witness = { fired: [] };
    const reg = testRegistry(witness);
    let s = newGame(reg);
    // Created by an effect A controls, but owned by B — the Pact shape, where
    // "your" is the delayed ability's own seat. A source on A's battlefield
    // cannot be what decides it.
    createDelayedTrigger(s, {
      condition: { on: 'upkeep', who: 'you' },
      effects: [{ primitive: 'delayedRemove', params: { instanceIds: [] } }],
      label: 'At the beginning of your next upkeep…',
      controller: 'B',
      sourceInstanceId: placeOnBattlefield(s, 'A', MIRROR_BREAKER),
    });
    const startTurn = s.turnNumber;
    const startingPlayer = s.activePlayer;

    s = playThroughTurn(s, startTurn + 1, reg);
    if (startingPlayer === 'A') {
      // A's own upkeep went by without it firing.
      expect(witness.fired).toHaveLength(0);
      s = playThroughTurn(s, startTurn + 2, reg);
    }
    expect(witness.fired).toHaveLength(1);
    expect(witness.fired[0]?.controller).toBe('B');
  });
});

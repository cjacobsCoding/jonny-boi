/**
 * COST MODIFICATION AT CAST TIME — `{X}` costs and kicker, played through real
 * games. The subsystem under test is the cast-time question step: casting a
 * spell with an {X} cost or a kicker parks a question (chooseNumber / payMana)
 * with NOTHING resolving, the ENGINE charges the extra cost exactly once as it
 * accepts the answer, and the chosen value / kicked flag rides the stack object
 * into the resolution frame so effects read it AFTER the spell has left the
 * stack.
 *
 * The failure modes each get a test because each fails silently when wrong:
 *  - X = 0 must be a legal, chargeless cast (Blaze for zero is a real cast);
 *  - a range beyond what the board can fund must never be offered, and an
 *    out-of-range answer must be refused, not clamped;
 *  - an UNAFFORDABLE kicker must never be offered as payable — the spell simply
 *    casts unkicked, without stopping the game;
 *  - the chosen X must be readable during resolution, i.e. after the stack
 *    object that carried it is gone.
 */

import { describe, expect, it } from 'vitest';
import {
  applyAction,
  createGame,
  DEFAULT_RULES,
  dumpState,
  enumerateChoiceAnswers,
  generateLegalActions,
  type CardDefinition,
  type ChoiceAnswer,
  type ChooseNumberChoice,
  type GameAction,
  type GameState,
  type InstanceId,
  type ManaCost,
  type PayManaChoice,
} from './index.js';
import { createEffectRegistry, type EffectRegistry } from './effects.js';
import { deckOf, landDef } from './test-fixtures.js';

const MOUNTAIN = landDef('Mountain', 'R');

/** The kicker cost the fixture prints, named rather than inline. */
const KICKER_COST: ManaCost = { generic: 1, R: 1 };

/** Life the kicked bonus grants — how a test proves the kicked half ran. */
const KICKED_LIFE = 4;

// --- primitives the fixtures are built from --------------------------------------

/**
 * A registry with two X/kicker-reading primitives in miniature. Core knows
 * nothing about Blaze; it knows `EffectContext.xValue` and `.kicked`, which is
 * the seam under test.
 */
function castModRegistry(): EffectRegistry {
  const reg = createEffectRegistry();
  // "~ deals X damage to the opponent" — reads the cast-time X during resolution.
  reg.register('xBurn', (ctx) => {
    const amount = ctx.xValue ?? 0;
    if (amount <= 0) return;
    const victim = ctx.controller === 'A' ? 'B' : 'A';
    ctx.state.players[victim].life -= amount;
    ctx.emit({ type: 'lifeChanged', player: victim, delta: -amount, to: ctx.state.players[victim].life });
  });
  // "If this spell was kicked, you gain 4 life."
  reg.register('kickedBonus', (ctx) => {
    if (ctx.kicked !== true) return;
    ctx.state.players[ctx.controller].life += KICKED_LIFE;
    ctx.emit({
      type: 'lifeChanged',
      player: ctx.controller,
      delta: KICKED_LIFE,
      to: ctx.state.players[ctx.controller].life,
    });
  });
  return reg;
}

// --- fixture cards ----------------------------------------------------------------

/** "{X}: ~ deals X damage" with a free base cost, so lands fund only X. */
const X_BURN: CardDefinition = {
  id: 'x-burn',
  name: 'X Burn',
  types: ['sorcery'],
  xCost: 1,
  effects: [{ primitive: 'xBurn' }],
};

/** The {X}{X} form — each point of X costs two generic. */
const DOUBLE_X_BURN: CardDefinition = { ...X_BURN, id: 'xx-burn', name: 'XX Burn', xCost: 2 };

/** "Kicker {1}{R}. If this spell was kicked, you gain 4 life." Free base cost. */
const KICKED_GIFT: CardDefinition = {
  id: 'kicked-gift',
  name: 'Kicked Gift',
  types: ['sorcery'],
  kicker: KICKER_COST,
  effects: [{ primitive: 'kickedBonus' }],
};

/** Both at once: X and a kicker, asked in that order. */
const X_AND_KICKER: CardDefinition = {
  id: 'x-and-kicker',
  name: 'X and Kicker',
  types: ['sorcery'],
  xCost: 1,
  kicker: KICKER_COST,
  effects: [{ primitive: 'xBurn' }, { primitive: 'kickedBonus' }],
};

// --- harness ----------------------------------------------------------------------

const SEED = 0xca57;

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

/** A fresh game already at A's first main phase, hands emptied. */
function gameAtMain(reg: EffectRegistry): GameState {
  const created = createGame({
    seed: SEED,
    startingPlayer: 'A',
    registry: reg,
    decks: { A: deckOf(MOUNTAIN, 40), B: deckOf(MOUNTAIN, 40) },
  });
  let state = created.state;
  let guard = 0;
  while (state.step !== 'precombatMain' && !state.gameOver && guard++ < 50) state = pass(state, reg);
  state.players.A.hand = [];
  state.players.B.hand = [];
  return state;
}

/** Put a fresh instance of `def` into A's hand; returns its instance id. */
function giveCard(state: GameState, def: CardDefinition): InstanceId {
  const instanceId = state.nextInstanceId++;
  state.players.A.hand.push({
    instanceId,
    def,
    controller: 'A',
    owner: 'A',
    zone: 'hand',
    tapped: false,
    summoningSick: false,
    damageMarked: 0,
    markedByDeathtouch: false,
    counters: {},
  });
  return instanceId;
}

/** Put `count` untapped Mountains onto A's battlefield. */
function giveLands(state: GameState, count: number): void {
  for (let i = 0; i < count; i++) {
    state.battlefield.push({
      instanceId: state.nextInstanceId++,
      def: MOUNTAIN,
      controller: 'A',
      owner: 'A',
      zone: 'battlefield',
      tapped: false,
      summoningSick: false,
      damageMarked: 0,
      markedByDeathtouch: false,
      counters: {},
    });
  }
}

function answer(state: GameState, reg: EffectRegistry, value: ChoiceAnswer): GameState {
  const choice = state.pendingChoice;
  if (!choice) throw new Error(`no choice pending:\n${dumpState(state)}`);
  return act(state, { kind: 'answerChoice', player: choice.chooser, choiceId: choice.id, answer: value }, reg);
}

/** Resolve the top of the stack: both players pass. */
function resolve(state: GameState, reg: EffectRegistry): GameState {
  return pass(pass(state, reg), reg);
}

function untappedLands(state: GameState): number {
  return state.battlefield.filter((c) => c.controller === 'A' && !c.tapped).length;
}

/** Cast a card A holds, with `lands` untapped Mountains on A's board. */
function cast(def: CardDefinition, lands: number, reg = castModRegistry()): { state: GameState; reg: EffectRegistry } {
  let state = gameAtMain(reg);
  const id = giveCard(state, def);
  giveLands(state, lands);
  state = act(state, { kind: 'castSpell', player: 'A', instanceId: id }, reg);
  return { state, reg };
}

// --- {X} costs --------------------------------------------------------------------

describe('an {X} cost asked at cast time', () => {
  it('parks a chooseNumber for the CASTER, ranged by what the board can actually fund', () => {
    const { state } = cast(X_BURN, 3);
    const choice = state.pendingChoice as ChooseNumberChoice | null;
    expect(choice?.kind).toBe('chooseNumber');
    expect(choice?.chooser).toBe('A');
    expect(choice?.min).toBe(0);
    expect(choice?.max).toBe(3); // three untapped Mountains, nothing floating
    expect(state.priorityPlayer).toBe('A');
    // The question freezes the game: only answering is legal.
    expect(generateLegalActions(state).every((a) => a.kind === 'answerChoice')).toBe(true);
    // The waiting lives on the stack object itself, and survived the action clone.
    const spell = state.stack[0];
    expect(spell?.kind === 'spell' && spell.awaitingCastChoice).toBe('x');
  });

  it('enumerates every fundable value, 0 first', () => {
    const { state } = cast(X_BURN, 2);
    expect(enumerateChoiceAnswers(state.pendingChoice!)).toEqual([
      { kind: 'chooseNumber', value: 0 },
      { kind: 'chooseNumber', value: 1 },
      { kind: 'chooseNumber', value: 2 },
    ]);
  });

  it('charges the chosen X once and the effect READS it after the spell left the stack', () => {
    const { state, reg } = cast(X_BURN, 3);
    let done = answer(state, reg, { kind: 'chooseNumber', value: 3 });
    expect(untappedLands(done)).toBe(0); // three lands tapped for X = 3
    expect(done.players.A.manaPool).toEqual({ W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 });
    expect(done.priorityPlayer).toBe('A'); // the caster kept priority
    done = resolve(done, reg);
    // The spell is IN THE GRAVEYARD — off the stack — and still burned for 3.
    expect(done.players.A.graveyard.map((c) => c.def.name)).toContain('X Burn');
    expect(done.players.B.life).toBe(DEFAULT_RULES.startingLife - 3);
  });

  it('X = 0 is a legal cast that charges nothing and deals nothing', () => {
    const { state, reg } = cast(X_BURN, 3);
    let done = answer(state, reg, { kind: 'chooseNumber', value: 0 });
    expect(untappedLands(done)).toBe(3); // not one land was taken
    done = resolve(done, reg);
    expect(done.players.B.life).toBe(DEFAULT_RULES.startingLife);
    expect(done.players.A.graveyard.map((c) => c.def.name)).toContain('X Burn');
  });

  it('refuses an X beyond the offered range instead of clamping it', () => {
    const { state, reg } = cast(X_BURN, 2);
    const choice = state.pendingChoice!;
    const result = applyAction(
      state,
      { kind: 'answerChoice', player: 'A', choiceId: choice.id, answer: { kind: 'chooseNumber', value: 5 } },
      DEFAULT_RULES,
      reg,
    );
    expect(result.events.some((e) => e.type === 'actionRejected')).toBe(true);
    // The question is still standing, exactly as it was.
    expect(result.state.pendingChoice?.id).toBe(choice.id);
  });

  it('with no mana beyond the base cost, X = 0 is recorded WITHOUT stopping the game', () => {
    const { state, reg } = cast(X_BURN, 0);
    expect(state.pendingChoice ?? null).toBeNull(); // one fundable value is not a decision
    const spell = state.stack[0];
    expect(spell?.kind === 'spell' && spell.xValue).toBe(0);
    const done = resolve(state, reg);
    expect(done.players.B.life).toBe(DEFAULT_RULES.startingLife);
  });

  it('{X}{X} charges two mana per point of X', () => {
    const { state, reg } = cast(DOUBLE_X_BURN, 4);
    const choice = state.pendingChoice as ChooseNumberChoice;
    expect(choice.max).toBe(2); // four Mountains fund X = 2 at two mana per point
    let done = answer(state, reg, { kind: 'chooseNumber', value: 2 });
    expect(untappedLands(done)).toBe(0);
    done = resolve(done, reg);
    expect(done.players.B.life).toBe(DEFAULT_RULES.startingLife - 2);
  });
});

// --- kicker -----------------------------------------------------------------------

describe('kicker asked at cast time', () => {
  it('parks an affordable payMana for the caster', () => {
    const { state } = cast(KICKED_GIFT, 2);
    const choice = state.pendingChoice as PayManaChoice | null;
    expect(choice?.kind).toBe('payMana');
    expect(choice?.chooser).toBe('A');
    expect(choice?.cost).toEqual(KICKER_COST);
    expect(choice?.affordable).toBe(true);
    const spell = state.stack[0];
    expect(spell?.kind === 'spell' && spell.awaitingCastChoice).toBe('kicker');
  });

  it('paying charges the kicker and the resolution sees kicked = true', () => {
    const { state, reg } = cast(KICKED_GIFT, 2);
    let done = answer(state, reg, { kind: 'payMana', pay: true });
    expect(untappedLands(done)).toBe(0); // {1}{R} took both Mountains
    const spell = done.stack[0];
    expect(spell?.kind === 'spell' && spell.kicked).toBe(true);
    done = resolve(done, reg);
    expect(done.players.A.life).toBe(DEFAULT_RULES.startingLife + KICKED_LIFE);
  });

  it('declining charges nothing and the kicked half never runs', () => {
    const { state, reg } = cast(KICKED_GIFT, 2);
    let done = answer(state, reg, { kind: 'payMana', pay: false });
    expect(untappedLands(done)).toBe(2);
    done = resolve(done, reg);
    expect(done.players.A.life).toBe(DEFAULT_RULES.startingLife);
  });

  it('an UNAFFORDABLE kicker is never offered: the spell casts unkicked without a question', () => {
    // One Mountain cannot produce {1}{R}.
    const { state, reg } = cast(KICKED_GIFT, 1);
    expect(state.pendingChoice ?? null).toBeNull();
    const spell = state.stack[0];
    expect(spell?.kind === 'spell' && spell.kicked).toBe(false);
    const done = resolve(state, reg);
    expect(done.players.A.life).toBe(DEFAULT_RULES.startingLife);
    expect(untappedLands(done)).toBe(1);
  });
});

// --- both on one card -------------------------------------------------------------

describe('a spell with an {X} cost AND a kicker', () => {
  it('asks X first, then the kicker, and both answers reach the resolution', () => {
    const { state, reg } = cast(X_AND_KICKER, 4);
    // X first (announcement order). Max is 4: the kicker is optional, so the
    // whole board is on offer for X.
    const xChoice = state.pendingChoice as ChooseNumberChoice;
    expect(xChoice.kind).toBe('chooseNumber');
    expect(xChoice.max).toBe(4);
    // Choose X = 2, leaving two Mountains — enough for the {1}{R} kicker.
    let done = answer(state, reg, { kind: 'chooseNumber', value: 2 });
    const kickerChoice = done.pendingChoice as PayManaChoice;
    expect(kickerChoice.kind).toBe('payMana');
    expect(kickerChoice.affordable).toBe(true);
    done = answer(done, reg, { kind: 'payMana', pay: true });
    expect(untappedLands(done)).toBe(0);
    done = resolve(done, reg);
    expect(done.players.B.life).toBe(DEFAULT_RULES.startingLife - 2); // X = 2 burn
    expect(done.players.A.life).toBe(DEFAULT_RULES.startingLife + KICKED_LIFE); // kicked
  });

  it('spending everything on X leaves the kicker unaffordable — and unasked', () => {
    const { state, reg } = cast(X_AND_KICKER, 3);
    // X = 3 drinks the whole board; the kicker question must then settle itself.
    let done = answer(state, reg, { kind: 'chooseNumber', value: 3 });
    expect(done.pendingChoice ?? null).toBeNull();
    const spell = done.stack[0];
    expect(spell?.kind === 'spell' && spell.kicked).toBe(false);
    done = resolve(done, reg);
    expect(done.players.B.life).toBe(DEFAULT_RULES.startingLife - 3);
    expect(done.players.A.life).toBe(DEFAULT_RULES.startingLife);
  });
});

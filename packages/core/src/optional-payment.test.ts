/**
 * OPTIONAL PAYMENT DURING RESOLUTION — "counter target spell **unless** its
 * controller pays {3}" (Mana Leak, Force Spike), played through real games.
 *
 * The mechanic is a fifth `PendingChoice` kind (`payMana`) rather than a `confirm`
 * with a cost written into the prompt, and the tests below are shaped around the
 * three things that distinction buys — each of which fails silently if it is got
 * wrong, which is why each has a test that would go red:
 *
 *  1. **The engine charges the mana, exactly once.** A resolving effect is re-run
 *     from the top every time it asks a further question, so a primitive that paid
 *     for itself would pay again on every later ask. `pays once even when the
 *     effect asks another question` is that test, and it is the reason payment
 *     lives in `applyAnswerChoice` instead of in the primitive.
 *  2. **A player who cannot pay is never asked.** Affordability is computed from
 *     the pool PLUS everything still untapped, so the question stops the game only
 *     when there is a real decision to make.
 *  3. **Agreeing to pay is not the same as paying.** The answer is validated
 *     against affordability and the payment is performed before the effect is told
 *     anything, so an effect can never act on mana that was not actually spent.
 */

import { describe, expect, it } from 'vitest';
import {
  applyAction,
  cloneState,
  createGame,
  DEFAULT_RULES,
  dumpState,
  enumerateChoiceAnswers,
  formatManaCost,
  generateLegalActions,
  serializeState,
  type CardDefinition,
  type ChoiceAnswer,
  type GameAction,
  type GameState,
  type InstanceId,
  type ManaCost,
  type PayManaChoice,
} from './index.js';
import { createEffectRegistry, type EffectRegistry } from './effects.js';
import { deckOf, giveHand, landDef } from './test-fixtures.js';

const ISLAND = landDef('Island', 'U');
const MOUNTAIN = landDef('Mountain', 'R');

/** The tax Mana Leak charges — the fixture's cost, named rather than inline. */
const LEAK_COST: ManaCost = { generic: 3 };

/** How much life the "second question" fixture gains, to prove it ran. */
const FOLLOW_UP_LIFE = 1;

// --- the primitives the fixture cards are built from ---------------------------------

/**
 * A registry holding the `cards` package's `counterUnlessPaid` in miniature: it
 * finds the targeted spell, offers its CONTROLLER the payment, and counters only
 * when they do not pay. Core knows nothing about Mana Leak; it knows about the
 * choice kind, which is the whole point.
 */
function paymentRegistry(): EffectRegistry {
  const reg = createEffectRegistry();

  reg.register('counterUnlessPaid', (ctx) => {
    const target = ctx.targets[0];
    const spell = ctx.state.stack.find((o) => o.instanceId === target);
    if (!spell || spell.kind !== 'spell') return;
    const paid = ctx.payOrDecline({
      chooser: spell.controller,
      cost: (ctx.params.unlessPaid as ManaCost | undefined) ?? LEAK_COST,
      prompt: `Pay ${formatManaCost((ctx.params.unlessPaid as ManaCost | undefined) ?? LEAK_COST)}`,
      valence: 'gain',
    });
    if (paid === undefined) return; // parked — nothing mutated
    if (paid) return; // paid: the spell lives
    const idx = ctx.state.stack.indexOf(spell);
    ctx.state.stack.splice(idx, 1);
    const card = spell.card;
    card.zone = 'graveyard';
    ctx.state.players[card.owner].graveyard.push(card);
    ctx.emit({ type: 'zoneChange', instanceId: card.instanceId, from: 'stack', to: 'graveyard' });
  });

  /**
   * Asks for a payment and THEN asks something else. The follow-up is what makes
   * the re-run observable: the payment must not be charged a second time when the
   * effect runs again to collect the second answer.
   */
  reg.register('payThenAsk', (ctx) => {
    const paid = ctx.payOrDecline({ cost: LEAK_COST, prompt: `Pay ${formatManaCost(LEAK_COST)}` });
    if (paid === undefined) return;
    const yes = ctx.confirm({ prompt: 'And also?' });
    if (yes === undefined) return;
    if (yes) ctx.state.players[ctx.controller].life += FOLLOW_UP_LIFE;
  });

  return reg;
}

// --- fixture cards --------------------------------------------------------------------

/** A free instant so a test can cast without first building a mana base. */
function freeInstant(id: string, effects: CardDefinition['effects']): CardDefinition {
  return { id, name: id, types: ['instant'], timing: 'instant', effects };
}

const MANA_LEAK = freeInstant('Mana Leak', [
  { primitive: 'counterUnlessPaid', params: { targets: 'spell', unlessPaid: LEAK_COST } },
]);

const PAY_THEN_ASK = freeInstant('Double Question', [{ primitive: 'payThenAsk' }]);

/**
 * The spell being countered. Free (so the victim's mana is only ever the tax) and
 * an INSTANT, because it has to be castable in the caster's main phase — which is
 * exactly when a counterspell is answered in a real game.
 */
const VICTIM = freeInstant('Opt', []);

// --- harness ---------------------------------------------------------------------------

const SEED = 0x5eed;

function act(state: GameState, action: GameAction, reg: EffectRegistry): GameState {
  const result = applyAction(state, action, DEFAULT_RULES, reg);
  const rejected = result.events.find((e) => e.type === 'actionRejected');
  if (rejected) throw new Error(`unexpected rejection: ${(rejected as { reason: string }).reason}\n${dumpState(state)}`);
  return result.state;
}

function pass(state: GameState, reg: EffectRegistry): GameState {
  return act(state, { kind: 'passPriority', player: state.priorityPlayer }, reg);
}

/** A fresh game already at the starting player's first main phase. */
function gameAtMain(reg: EffectRegistry): GameState {
  const created = createGame({
    seed: SEED,
    startingPlayer: 'A',
    registry: reg,
    decks: { A: deckOf(ISLAND, 40), B: deckOf(ISLAND, 40) },
  });
  let state = created.state;
  let guard = 0;
  while (state.step !== 'precombatMain' && !state.gameOver && guard++ < 50) state = pass(state, reg);
  return state;
}

/** Put `count` untapped, ready-to-tap lands onto a player's battlefield. */
function giveLands(state: GameState, player: 'A' | 'B', def: CardDefinition, count: number): InstanceId[] {
  const ids: InstanceId[] = [];
  for (let i = 0; i < count; i++) {
    const instanceId = state.nextInstanceId++;
    state.battlefield.push({
      instanceId,
      def,
      controller: player,
      owner: player,
      zone: 'battlefield',
      tapped: false,
      summoningSick: false,
      damageMarked: 0,
      markedByDeathtouch: false,
      counters: {},
    });
    ids.push(instanceId);
  }
  return ids;
}

function answer(state: GameState, reg: EffectRegistry, value: ChoiceAnswer): GameState {
  const choice = state.pendingChoice;
  if (!choice) throw new Error(`no choice pending:\n${dumpState(state)}`);
  return act(state, { kind: 'answerChoice', player: choice.chooser, choiceId: choice.id, answer: value }, reg);
}

/** Number of `player`'s untapped lands — "did the payment tap anything?". */
function untappedLands(state: GameState, player: 'A' | 'B'): number {
  return state.battlefield.filter((c) => c.controller === player && !c.tapped).length;
}

/**
 * B casts a creature; A answers with Mana Leak targeting it; both pass so the Leak
 * resolves. Returns the state with B's payment question parked (or already
 * settled, when B cannot pay).
 */
function leakGame(bLands: number): { state: GameState; reg: EffectRegistry; bear: InstanceId } {
  const reg = paymentRegistry();
  let state = gameAtMain(reg);
  state.players.A.hand = [];
  state.players.B.hand = [];
  const [leak] = giveHand(state, 'A', [MANA_LEAK]);
  const [bear] = giveHand(state, 'B', [VICTIM]);
  giveLands(state, 'B', ISLAND, bLands);

  // B is not the active player, so hand them priority first: A passes, B casts.
  state = pass(state, reg);
  state = act(state, { kind: 'castSpell', player: 'B', instanceId: bear!.instanceId }, reg);
  state = pass(state, reg); // B keeps priority after casting; passing hands it to A
  state = act(state, { kind: 'castSpell', player: 'A', instanceId: leak!.instanceId, targets: [bear!.instanceId] }, reg);
  state = pass(state, reg); // A passes with the Leak on top
  state = pass(state, reg); // B passes → the Leak resolves and asks
  return { state, reg, bear: bear!.instanceId };
}

// --- the question ------------------------------------------------------------------------

describe('a Mana-Leak-shaped card (counter target spell unless its controller pays {3})', () => {
  it('asks the SPELL’S CONTROLLER — not the caster — and hands them the floor', () => {
    const { state } = leakGame(3);

    const choice = state.pendingChoice as PayManaChoice | null;
    expect(choice?.kind).toBe('payMana');
    expect(choice?.chooser).toBe('B');
    expect(choice?.cost).toEqual(LEAK_COST);
    expect(choice?.affordable).toBe(true);
    expect(state.priorityPlayer).toBe('B');
    expect(generateLegalActions(state).every((a) => a.kind === 'answerChoice')).toBe(true);
  });

  it('offers exactly two answers while the cost is payable', () => {
    const { state } = leakGame(3);
    const answers = enumerateChoiceAnswers(state.pendingChoice!);
    expect(answers).toEqual([
      { kind: 'payMana', pay: true },
      { kind: 'payMana', pay: false },
    ]);
  });

  it('pays: the mana is spent, the lands are tapped, and the spell survives', () => {
    const { state, reg, bear } = leakGame(3);
    const done = answer(state, reg, { kind: 'payMana', pay: true });

    // Three lands tapped for exactly the three mana the cost wanted, and nothing
    // is left floating — the payment consumed what it produced.
    expect(untappedLands(done, 'B')).toBe(0);
    expect(done.players.B.manaPool).toEqual({ W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 });
    // The creature is still on the stack and the Leak is in its owner's graveyard.
    expect(done.stack.map((o) => o.instanceId)).toEqual([bear]);
    expect(done.players.A.graveyard.map((c) => c.def.name)).toContain('Mana Leak');
    expect(done.players.B.graveyard).toHaveLength(0);
  });

  it('declines: the spell is countered and NOT one point of mana is taken', () => {
    const { state, reg } = leakGame(3);
    const done = answer(state, reg, { kind: 'payMana', pay: false });

    expect(untappedLands(done, 'B')).toBe(3);
    expect(done.stack).toHaveLength(0);
    expect(done.players.B.graveyard.map((c) => c.def.name)).toContain('Opt');
  });

  it('says the payment happened in the log, with the cost that was charged', () => {
    const { state } = leakGame(3);
    const choice = state.pendingChoice!;
    const result = applyAction(
      state,
      { kind: 'answerChoice', player: 'B', choiceId: choice.id, answer: { kind: 'payMana', pay: true } },
      DEFAULT_RULES,
      paymentRegistry(),
    );
    const paid = result.events.find((e) => e.type === 'manaCostPaid');
    expect(paid).toEqual({ type: 'manaCostPaid', player: 'B', cost: LEAK_COST });
    // The taps are said out loud too, so a replay folding the log sees them.
    expect(result.events.filter((e) => e.type === 'tapped')).toHaveLength(3);
  });
});

// --- when paying is impossible ------------------------------------------------------------

describe('a payment nobody can make', () => {
  it('is never asked: the game does not stop, and the spell is countered', () => {
    const { state, reg } = leakGame(2); // two lands against a {3} tax

    expect(state.pendingChoice ?? null).toBeNull();
    expect(state.stack).toHaveLength(0);
    expect(state.players.B.graveyard.map((c) => c.def.name)).toContain('Opt');
    expect(untappedLands(state, 'B')).toBe(2);
    // Play carries on with whoever should have it, not with a wedged prompt.
    expect(generateLegalActions(state).some((a) => a.kind === 'passPriority')).toBe(true);
    void reg;
  });

  it('counts the floating pool as well as the untapped lands', () => {
    const reg = paymentRegistry();
    let state = gameAtMain(reg);
    state.players.A.hand = [];
    state.players.B.hand = [];
    const [leak] = giveHand(state, 'A', [MANA_LEAK]);
    const [bear] = giveHand(state, 'B', [VICTIM]);
    giveLands(state, 'B', ISLAND, 1);
    // Two mana already floating + one land = the {3} is payable.
    state.players.B.manaPool = { ...state.players.B.manaPool, U: 2 };

    state = pass(state, reg);
    state = act(state, { kind: 'castSpell', player: 'B', instanceId: bear!.instanceId }, reg);
    state = pass(state, reg);
    state = act(state, { kind: 'castSpell', player: 'A', instanceId: leak!.instanceId, targets: [bear!.instanceId] }, reg);
    state = pass(state, reg);
    state = pass(state, reg);

    const choice = state.pendingChoice as PayManaChoice | null;
    expect(choice?.affordable).toBe(true);
    const done = answer(state, reg, { kind: 'payMana', pay: true });
    // The floating mana was spent FIRST: only the one land had to be tapped.
    expect(untappedLands(done, 'B')).toBe(0);
    expect(done.stack.map((o) => o.instanceId)).toEqual([bear!.instanceId]);
  });

  it('rejects an answer that claims to pay a cost the board cannot produce', () => {
    const { state, reg } = leakGame(3);
    // Rewrite the parked choice as though the board could not pay, then insist.
    const rigged = cloneState(state);
    rigged.pendingChoice = { ...(rigged.pendingChoice as PayManaChoice), affordable: false };
    const before = JSON.stringify(serializeState(rigged));

    const result = applyAction(
      rigged,
      { kind: 'answerChoice', player: 'B', choiceId: rigged.pendingChoice!.id, answer: { kind: 'payMana', pay: true } },
      DEFAULT_RULES,
      reg,
    );

    expect(result.events.some((e) => e.type === 'actionRejected')).toBe(true);
    // Rejection is CLEAN: the question is still parked and nothing moved.
    expect(JSON.stringify(serializeState(result.state))).toBe(before);
  });
});

// --- the re-run trap ------------------------------------------------------------------------

describe('an effect that asks a second question after the payment', () => {
  function doubleQuestionGame(): { state: GameState; reg: EffectRegistry } {
    const reg = paymentRegistry();
    let state = gameAtMain(reg);
    state.players.A.hand = [];
    const [spell] = giveHand(state, 'A', [PAY_THEN_ASK]);
    giveLands(state, 'A', MOUNTAIN, 6);
    state = act(state, { kind: 'castSpell', player: 'A', instanceId: spell!.instanceId }, reg);
    state = pass(state, reg);
    state = pass(state, reg);
    return { state, reg };
  }

  it('pays ONCE, even though the effect is re-run to collect the second answer', () => {
    const { state, reg } = doubleQuestionGame();
    expect(state.pendingChoice?.kind).toBe('payMana');

    const asked = answer(state, reg, { kind: 'payMana', pay: true });
    // Three of the six lands paid the cost; the follow-up question is now parked.
    expect(untappedLands(asked, 'A')).toBe(3);
    expect(asked.pendingChoice?.kind).toBe('confirm');

    const done = answer(asked, reg, { kind: 'confirm', yes: true });
    // Still three: re-running the effect replayed the payment ANSWER, and the
    // engine did not charge for it again.
    expect(untappedLands(done, 'A')).toBe(3);
    expect(done.players.A.manaPool).toEqual({ W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 });
    // …and the rest of the effect genuinely ran.
    expect(done.players.A.life).toBe(DEFAULT_RULES.startingLife + FOLLOW_UP_LIFE);
  });
});

// --- purity + reproducibility -------------------------------------------------------------

describe('a parked payment as state', () => {
  it('survives a clone and a serialize, and answering does not mutate the input', () => {
    const { state, reg } = leakGame(3);
    const before = JSON.stringify(serializeState(state));
    const copy = cloneState(state);
    expect(JSON.stringify(serializeState(copy))).toBe(before);

    const done = answer(state, reg, { kind: 'payMana', pay: true });
    expect(JSON.stringify(serializeState(state))).toBe(before); // the input state is untouched
    expect(JSON.stringify(serializeState(done))).not.toBe(before);
  });

  it('replays byte-identically from the same seed and answers', () => {
    const play = (): string => {
      const { state, reg } = leakGame(3);
      return JSON.stringify(serializeState(answer(state, reg, { kind: 'payMana', pay: true })));
    };
    expect(play()).toBe(play());
  });

  it('taps the same lands whichever seat asks — the payment planner is the shared one', () => {
    // A payment plans through `planManaPayment`, the same function that funds a
    // cast, so a mixed board spends the least flexible source first rather than
    // whatever happens to come first on the battlefield.
    const reg = paymentRegistry();
    let state = gameAtMain(reg);
    state.players.A.hand = [];
    state.players.B.hand = [];
    const [leak] = giveHand(state, 'A', [MANA_LEAK]);
    const [bear] = giveHand(state, 'B', [VICTIM]);
    giveLands(state, 'B', ISLAND, 2);
    giveLands(state, 'B', MOUNTAIN, 2);

    state = pass(state, reg);
    state = act(state, { kind: 'castSpell', player: 'B', instanceId: bear!.instanceId }, reg);
    state = pass(state, reg);
    state = act(state, { kind: 'castSpell', player: 'A', instanceId: leak!.instanceId, targets: [bear!.instanceId] }, reg);
    state = pass(state, reg);
    state = pass(state, reg);
    const done = answer(state, reg, { kind: 'payMana', pay: true });

    // Exactly three of the four lands paid a generic {3}; one is left up.
    expect(untappedLands(done, 'B')).toBe(1);
    expect(done.stack.map((o) => o.instanceId)).toEqual([bear!.instanceId]);
  });
});

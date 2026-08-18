/**
 * SHOCKLANDS — "As ~ enters, you may pay 2 life. If you don't, it enters
 * tapped." — the pay-life question asked at LAND-PLAY time, the second moment
 * this engine asks with nothing resolving (trigger aiming was the first).
 *
 * The properties pinned here, ordered by how silently each would break:
 *  1. **The unpaid default is TAPPED everywhere.** `entersTapped` answers true
 *     for a shock definition, so any entry path that does not ask — a token
 *     copy, a future reanimation effect, a test fixture — can never produce a
 *     free untapped shockland. The asking paths override with the answer.
 *  2. **The engine charges the life, once, as the answer is accepted** — the
 *     same contract as `payMana`, with the same re-run reason behind it.
 *  3. **A player who cannot pay is never asked**: the land enters tapped and the
 *     game does not stop. Paying down to exactly zero IS legal (CR 118.4) and
 *     promptly lethal — that is the player's call, and the state-based actions
 *     settle it right after the payment.
 */

import { describe, expect, it } from 'vitest';
import {
  applyAction,
  cloneState,
  createGame,
  DEFAULT_RULES,
  dumpState,
  entersTapped,
  generateLegalActions,
  serializeState,
  type CardDefinition,
  type ChoiceAnswer,
  type GameAction,
  type GameState,
  type PayLifeChoice,
} from './index.js';
import { createEffectRegistry, type EffectRegistry } from './effects.js';
import { deckOf, giveHand, landDef } from './test-fixtures.js';

const ISLAND = landDef('Island', 'U');

/** The printed shock price. */
const SHOCK_LIFE = 2;

/** Blood-Crypt-shaped: taps for either colour, asks for 2 life on entry. */
const BLOOD_CRYPT: CardDefinition = {
  id: 'Blood Crypt',
  name: 'Blood Crypt',
  types: ['land'],
  producesOptions: [{ B: 1 }, { R: 1 }],
  entersTappedUnlessLifePaid: SHOCK_LIFE,
};

const SEED = 0xb100d;

function act(state: GameState, action: GameAction, reg: EffectRegistry): GameState {
  const result = applyAction(state, action, DEFAULT_RULES, reg);
  const rejected = result.events.find((e) => e.type === 'actionRejected');
  if (rejected) throw new Error(`unexpected rejection: ${(rejected as { reason: string }).reason}\n${dumpState(state)}`);
  return result.state;
}

function pass(state: GameState, reg: EffectRegistry): GameState {
  return act(state, { kind: 'passPriority', player: state.priorityPlayer }, reg);
}

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
  state.players.A.hand = [];
  state.players.B.hand = [];
  return state;
}

/** A's shockland in hand, played; returns the state with the question parked. */
function playShock(reg: EffectRegistry, life = DEFAULT_RULES.startingLife): { state: GameState; landId: number } {
  let state = gameAtMain(reg);
  state.players.A.life = life;
  const [land] = giveHand(state, 'A', [BLOOD_CRYPT]);
  state = act(state, { kind: 'playLand', player: 'A', instanceId: land!.instanceId }, reg);
  return { state, landId: land!.instanceId };
}

function answer(state: GameState, reg: EffectRegistry, value: ChoiceAnswer): GameState {
  const choice = state.pendingChoice;
  if (!choice) throw new Error(`no choice pending:\n${dumpState(state)}`);
  return act(state, { kind: 'answerChoice', player: choice.chooser, choiceId: choice.id, answer: value }, reg);
}

function theLand(state: GameState, landId: number) {
  const land = state.battlefield.find((c) => c.instanceId === landId);
  if (!land) throw new Error(`land ${landId} not on the battlefield\n${dumpState(state)}`);
  return land;
}

// --- the default is the unpaid branch, everywhere -----------------------------------

describe('the unpaid default', () => {
  it('entersTapped answers TRUE for a shock definition with no question asked', () => {
    // This is the guarantee that a path which cannot ask can never produce a
    // free untapped shockland — the direction that would play better than the
    // printed card.
    expect(entersTapped(BLOOD_CRYPT)).toBe(true);
    expect(entersTapped(BLOOD_CRYPT, { controller: 'A', battlefield: [] })).toBe(true);
  });
});

// --- the land-play question -----------------------------------------------------------

describe('playing a shockland with the life to pay', () => {
  it('parks a payLife question addressed to the player, land already entered', () => {
    const reg = createEffectRegistry();
    const { state, landId } = playShock(reg);

    const choice = state.pendingChoice as PayLifeChoice | null;
    expect(choice?.kind).toBe('payLife');
    expect(choice?.chooser).toBe('A');
    expect(choice?.amount).toBe(SHOCK_LIFE);
    expect(choice?.affordable).toBe(true);
    expect(choice?.sourceName).toBe('Blood Crypt');
    // The land is on the battlefield while the question stands, and answering is
    // the only legal move — nothing can observe or exploit the interim state.
    expect(theLand(state, landId).zone).toBe('battlefield');
    expect(generateLegalActions(state).every((a) => a.kind === 'answerChoice')).toBe(true);
  });

  it('pay: 2 life leaves, the land is untapped, and the turn continues', () => {
    const reg = createEffectRegistry();
    const { state, landId } = playShock(reg);
    const done = answer(state, reg, { kind: 'payLife', pay: true });

    expect(done.players.A.life).toBe(DEFAULT_RULES.startingLife - SHOCK_LIFE);
    expect(theLand(done, landId).tapped).toBe(false);
    expect(done.pendingChoice ?? null).toBeNull();
    // The land play never surrendered priority; its player still holds it.
    expect(done.priorityPlayer).toBe('A');
    // …and the land can actually be tapped for mana right now, which is the
    // whole point of having paid.
    expect(
      generateLegalActions(done).some((a) => a.kind === 'tapForMana' && a.instanceId === landId),
    ).toBe(true);
  });

  it('decline: the land is tapped and NOT one point of life is taken', () => {
    const reg = createEffectRegistry();
    const { state, landId } = playShock(reg);
    const done = answer(state, reg, { kind: 'payLife', pay: false });

    expect(done.players.A.life).toBe(DEFAULT_RULES.startingLife);
    expect(theLand(done, landId).tapped).toBe(true);
    expect(done.pendingChoice ?? null).toBeNull();
  });

  it('says the tapped-ness out loud only once the answer decides it', () => {
    const reg = createEffectRegistry();
    const { state } = playShock(reg);
    // No `tapped` event was emitted while the question stood…
    const choice = state.pendingChoice!;
    const result = applyAction(
      state,
      { kind: 'answerChoice', player: 'A', choiceId: choice.id, answer: { kind: 'payLife', pay: false } },
      DEFAULT_RULES,
      reg,
    );
    // …and the decline emits exactly one, so a replay folding the log shows the
    // land tapped without ever flickering.
    expect(result.events.filter((e) => e.type === 'tapped')).toHaveLength(1);
  });
});

// --- when paying is impossible or lethal ------------------------------------------------

describe('the edges of the life total', () => {
  it('never asks a player who cannot pay — the land just enters tapped', () => {
    const reg = createEffectRegistry();
    const { state, landId } = playShock(reg, SHOCK_LIFE - 1);

    expect(state.pendingChoice ?? null).toBeNull();
    expect(theLand(state, landId).tapped).toBe(true);
    expect(state.players.A.life).toBe(SHOCK_LIFE - 1);
  });

  it('paying down to exactly zero is legal, and it kills you', () => {
    // CR 118.4: life may be paid to zero. The choice is the player's; the
    // state-based actions collect immediately.
    const reg = createEffectRegistry();
    const { state } = playShock(reg, SHOCK_LIFE);
    expect((state.pendingChoice as PayLifeChoice).affordable).toBe(true);

    const done = answer(state, reg, { kind: 'payLife', pay: true });
    expect(done.players.A.life).toBe(0);
    expect(done.players.A.hasLost).toBe(true);
    expect(done.gameOver).toBe(true);
  });

  it('rejects an answer that claims to pay life the total does not hold', () => {
    const reg = createEffectRegistry();
    const { state } = playShock(reg);
    const rigged = cloneState(state);
    rigged.pendingChoice = { ...(rigged.pendingChoice as PayLifeChoice), affordable: false };
    const before = JSON.stringify(serializeState(rigged));

    const result = applyAction(
      rigged,
      { kind: 'answerChoice', player: 'A', choiceId: rigged.pendingChoice!.id, answer: { kind: 'payLife', pay: true } },
      DEFAULT_RULES,
      reg,
    );

    expect(result.events.some((e) => e.type === 'actionRejected')).toBe(true);
    expect(JSON.stringify(serializeState(result.state))).toBe(before);
  });
});

// --- purity ---------------------------------------------------------------------------------

describe('the parked payment as state', () => {
  it('survives a clone, and answering does not mutate the input', () => {
    const reg = createEffectRegistry();
    const { state } = playShock(reg);
    const before = JSON.stringify(serializeState(state));
    expect(JSON.stringify(serializeState(cloneState(state)))).toBe(before);

    answer(state, reg, { kind: 'payLife', pay: true });
    expect(JSON.stringify(serializeState(state))).toBe(before);
  });

  it('replays byte-identically from the same seed and answer', () => {
    const play = (): string => {
      const reg = createEffectRegistry();
      const { state } = playShock(reg);
      return JSON.stringify(serializeState(answer(state, reg, { kind: 'payLife', pay: true })));
    };
    expect(play()).toBe(play());
  });
});

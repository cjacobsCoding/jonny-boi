/**
 * THE MANDATORY ADDITIONAL CAST COST (CR 601.2h) — "As an additional cost to
 * cast this spell, sacrifice a creature / discard a card".
 *
 * It sits beside kicker and buyback in `askCostChoices`, and the whole reason it
 * is a separate field rather than another optional cost is the property this
 * file pins first: **it cannot be declined**. An optional cost a player cannot
 * pay leaves the spell castable without it; this one makes the cast ILLEGAL. Get
 * that wrong and Village Rites becomes a free two-card draw — a strictly better
 * card, silently.
 *
 * Four things are pinned here, each the one that would break most quietly:
 *   1. **Offer and accept agree.** The action generator does not offer a spell
 *      whose cost cannot be paid, and the cast path refuses the same spell if a
 *      caller builds the action by hand. One helper answers both.
 *   2. **Nothing is half-paid on a refusal.** A rejected cast leaves the mana
 *      pool and the hand exactly as they were.
 *   3. **The payment is a real zone change**, through the same funnel every
 *      other sacrifice and discard uses — which is what makes dies-triggers and
 *      the madness discard replacement see it.
 *   4. **`additionalCostPaid` survives the per-action clone** — the field-by-
 *      field `clone.ts` trap that flashback, card-grants and buyback all fell
 *      into. Without it the question is asked again and the caster pays twice.
 */

import { describe, expect, it } from 'vitest';
import {
  applyAction,
  cloneState,
  createGame,
  DEFAULT_RULES,
  dumpState,
  generateLegalActions,
  type CardDefinition,
  type GameAction,
  type GameState,
  type SpellStackObject,
} from './index.js';
import { createEffectRegistry, type EffectRegistry } from './effects.js';
import { deckOf, giveHand, landDef } from './test-fixtures.js';

const ISLAND = landDef('Island', 'U');
const SEED = 0x5ac1;

/** A spell whose script is observable, so "did it resolve?" has an answer. */
const NOTE_PRIMITIVE = 'noteResolved';

function makeRegistry(): { reg: EffectRegistry; resolved: string[] } {
  const resolved: string[] = [];
  const reg = createEffectRegistry();
  reg.register(NOTE_PRIMITIVE, (ctx) => {
    resolved.push(ctx.source?.def.name ?? '?');
  });
  return { reg, resolved };
}

const BEAR: CardDefinition = {
  id: 'bear',
  name: 'Bear',
  types: ['creature'],
  power: 2,
  toughness: 2,
  cost: { generic: 1, G: 1 },
};

const ROCK: CardDefinition = {
  id: 'rock',
  name: 'Rock',
  types: ['artifact'],
  cost: { generic: 2 },
};

/** Village Rites' shape: a free spell whose only price is a creature. */
const SAC_A_CREATURE: CardDefinition = {
  id: 'sac-a-creature',
  name: 'Village Rites',
  types: ['instant'],
  cost: { generic: 0 },
  additionalCost: { kind: 'sacrifice', filter: { anyOfTypes: ['creature'] }, label: 'Sacrifice a creature' },
  effects: [{ primitive: NOTE_PRIMITIVE }],
};

/** The union form — "sacrifice an artifact or creature". */
const SAC_ARTIFACT_OR_CREATURE: CardDefinition = {
  id: 'sac-artifact-or-creature',
  name: 'Deadly Dispute',
  types: ['instant'],
  cost: { generic: 0 },
  additionalCost: {
    kind: 'sacrifice',
    filter: { anyOfTypes: ['artifact', 'creature'] },
    label: 'Sacrifice an artifact or creature',
  },
  effects: [{ primitive: NOTE_PRIMITIVE }],
};

const DISCARD_A_CARD: CardDefinition = {
  id: 'discard-a-card',
  name: 'Thrill of Possibility',
  types: ['instant'],
  cost: { generic: 0 },
  additionalCost: { kind: 'discard', label: 'Discard a card' },
  effects: [{ primitive: NOTE_PRIMITIVE }],
};

const SAC_TWO_CREATURES: CardDefinition = {
  id: 'sac-two-creatures',
  name: 'Test Double Rites',
  types: ['instant'],
  cost: { generic: 0 },
  additionalCost: { kind: 'sacrifice', count: 2, filter: { anyOfTypes: ['creature'] }, label: 'Sacrifice two creatures' },
  effects: [{ primitive: NOTE_PRIMITIVE }],
};

function act(state: GameState, action: GameAction, reg: EffectRegistry): GameState {
  const result = applyAction(state, action, DEFAULT_RULES, reg);
  const rejected = result.events.find((e) => e.type === 'actionRejected');
  if (rejected) {
    throw new Error(`unexpected rejection: ${(rejected as { reason: string }).reason}\n${dumpState(state)}`);
  }
  return result.state;
}

function rejectionFor(state: GameState, action: GameAction, reg: EffectRegistry): string | undefined {
  const result = applyAction(state, action, DEFAULT_RULES, reg);
  const rejected = result.events.find((e) => e.type === 'actionRejected');
  return rejected ? (rejected as { reason: string }).reason : undefined;
}

function gameAtMain(reg: EffectRegistry): GameState {
  const { state } = createGame({
    seed: SEED,
    startingPlayer: 'A',
    registry: reg,
    decks: { A: deckOf(ISLAND, 40), B: deckOf(ISLAND, 40) },
  });
  let s = state;
  let guard = 0;
  while (s.step !== 'precombatMain' && !s.gameOver && guard++ < 100) {
    s = act(s, { kind: 'passPriority', player: s.priorityPlayer }, reg);
  }
  s.players.A.hand = [];
  s.players.B.hand = [];
  return s;
}

let syntheticId = 60_000;

function putOnBattlefield(state: GameState, def: CardDefinition): number {
  const instanceId = syntheticId++;
  state.battlefield.push({
    instanceId,
    def,
    controller: 'A',
    owner: 'A',
    zone: 'battlefield',
    tapped: false,
    summoningSick: false,
    damageMarked: 0,
    markedByDeathtouch: false,
    counters: {},
  });
  return instanceId;
}

function castOffersFor(state: GameState, instanceId: number): readonly GameAction[] {
  return generateLegalActions(state, DEFAULT_RULES).filter(
    (a) => a.kind === 'castSpell' && a.instanceId === instanceId,
  );
}

describe('a mandatory additional cost cannot be declined (CR 601.2h)', () => {
  it('is NOT OFFERED when there is nothing that could pay it', () => {
    const { reg } = makeRegistry();
    const state = gameAtMain(reg);
    const [card] = giveHand(state, 'A', [SAC_A_CREATURE]);
    expect(castOffersFor(state, card!.instanceId)).toEqual([]);
  });

  it('is REJECTED when a hand-built action tries it anyway, and nothing is half-paid', () => {
    const { reg, resolved } = makeRegistry();
    const state = gameAtMain(reg);
    const [card] = giveHand(state, 'A', [SAC_A_CREATURE]);
    const reason = rejectionFor(state, { kind: 'castSpell', player: 'A', instanceId: card!.instanceId }, reg);
    expect(reason).toMatch(/additional cost/i);
    expect(state.players.A.hand.map((c) => c.def.name)).toEqual(['Village Rites']);
    expect(state.stack).toHaveLength(0);
    expect(resolved).toEqual([]);
  });

  it('is offered the moment a legal payer exists', () => {
    const { reg } = makeRegistry();
    const state = gameAtMain(reg);
    const [card] = giveHand(state, 'A', [SAC_A_CREATURE]);
    putOnBattlefield(state, BEAR);
    expect(castOffersFor(state, card!.instanceId)).toHaveLength(1);
  });

  it('counts the filter, not the board — an artifact cannot pay "sacrifice a creature"', () => {
    const { reg } = makeRegistry();
    const state = gameAtMain(reg);
    const [rites] = giveHand(state, 'A', [SAC_A_CREATURE]);
    putOnBattlefield(state, ROCK);
    expect(castOffersFor(state, rites!.instanceId)).toEqual([]);

    // The same board DOES pay a union cost that names artifacts.
    const [dispute] = giveHand(state, 'A', [SAC_ARTIFACT_OR_CREATURE]);
    expect(castOffersFor(state, dispute!.instanceId)).toHaveLength(1);
  });

  it('needs as many payers as the cost prints', () => {
    const { reg } = makeRegistry();
    const state = gameAtMain(reg);
    const [card] = giveHand(state, 'A', [SAC_TWO_CREATURES]);
    putOnBattlefield(state, BEAR);
    expect(castOffersFor(state, card!.instanceId)).toEqual([]);
    putOnBattlefield(state, BEAR);
    expect(castOffersFor(state, card!.instanceId)).toHaveLength(1);
  });

  it('a DISCARD cost cannot be paid by the spell itself', () => {
    const { reg } = makeRegistry();
    const state = gameAtMain(reg);
    const [card] = giveHand(state, 'A', [DISCARD_A_CARD]);
    // A hand of exactly the spell: it is on the stack by the time the cost is
    // paid, so it is not one of its own candidates.
    expect(castOffersFor(state, card!.instanceId)).toEqual([]);
    giveHand(state, 'A', [ISLAND]);
    expect(castOffersFor(state, card!.instanceId)).toHaveLength(1);
  });
});

describe('paying a mandatory additional cost', () => {
  it('asks WHICH payer when there is a real choice, and moves nothing until answered', () => {
    const { reg } = makeRegistry();
    let state = gameAtMain(reg);
    const [card] = giveHand(state, 'A', [SAC_A_CREATURE]);
    const small = putOnBattlefield(state, BEAR);
    const big = putOnBattlefield(state, BEAR);

    state = act(state, { kind: 'castSpell', player: 'A', instanceId: card!.instanceId }, reg);
    const choice = state.pendingChoice;
    expect(choice?.kind).toBe('selectCards');
    expect(choice?.chooser).toBe('A');
    // Both creatures are still on the battlefield while the question stands.
    expect(state.battlefield.map((c) => c.instanceId).sort()).toEqual([small, big].sort());

    state = act(
      state,
      {
        kind: 'answerChoice',
        player: 'A',
        choiceId: choice!.id,
        answer: { kind: 'selectCards', instanceIds: [small] },
      },
      reg,
    );
    expect(state.battlefield.map((c) => c.instanceId)).toEqual([big]);
    expect(state.players.A.graveyard.map((c) => c.instanceId)).toEqual([small]);
    expect((state.stack[0] as SpellStackObject).additionalCostPaid).toBe(true);
    expect(state.pendingChoice ?? null).toBeNull();
  });

  it('settles the ONLY legal payment itself, without stopping the game', () => {
    const { reg } = makeRegistry();
    let state = gameAtMain(reg);
    const [card] = giveHand(state, 'A', [SAC_A_CREATURE]);
    const only = putOnBattlefield(state, BEAR);

    state = act(state, { kind: 'castSpell', player: 'A', instanceId: card!.instanceId }, reg);
    expect(state.pendingChoice ?? null).toBeNull();
    expect(state.players.A.graveyard.map((c) => c.instanceId)).toEqual([only]);
    expect((state.stack[0] as SpellStackObject).additionalCostPaid).toBe(true);
  });

  it('is paid BEFORE the spell resolves, and the spell still resolves', () => {
    const { reg, resolved } = makeRegistry();
    let state = gameAtMain(reg);
    const [card] = giveHand(state, 'A', [SAC_A_CREATURE]);
    putOnBattlefield(state, BEAR);
    state = act(state, { kind: 'castSpell', player: 'A', instanceId: card!.instanceId }, reg);
    expect(resolved).toEqual([]); // the cost is paid; the spell has not resolved
    let guard = 0;
    while (state.stack.length > 0 && !state.gameOver && guard++ < 20) {
      state = act(state, { kind: 'passPriority', player: state.priorityPlayer }, reg);
    }
    expect(resolved).toEqual(['Village Rites']);
  });

  it('a DISCARD cost really leaves the hand for the graveyard', () => {
    const { reg } = makeRegistry();
    let state = gameAtMain(reg);
    const [card] = giveHand(state, 'A', [DISCARD_A_CARD]);
    giveHand(state, 'A', [ISLAND]);
    state = act(state, { kind: 'castSpell', player: 'A', instanceId: card!.instanceId }, reg);
    expect(state.players.A.hand).toHaveLength(0);
    expect(state.players.A.graveyard.map((c) => c.def.name)).toEqual(['Island']);
  });

  it('survives the per-action clone (the field-by-field clone.ts trap)', () => {
    const { reg } = makeRegistry();
    let state = gameAtMain(reg);
    const [card] = giveHand(state, 'A', [SAC_A_CREATURE]);
    putOnBattlefield(state, BEAR);
    state = act(state, { kind: 'castSpell', player: 'A', instanceId: card!.instanceId }, reg);
    const cloned = cloneState(state);
    expect((cloned.stack[0] as SpellStackObject).additionalCostPaid).toBe(true);
  });
});

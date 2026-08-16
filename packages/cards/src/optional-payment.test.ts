/**
 * MANA LEAK, end to end: real Oracle text → the compiler → a real game.
 *
 * Two halves, because either one alone would let the card ship broken:
 *
 *  - the COMPILER half proves the printed sentence becomes `counterUnlessPaid`
 *    with the printed cost, and — just as important — that the sentences we
 *    cannot charge honestly (Rune Snag's cost derived from both graveyards, an
 *    {X} tax) keep reporting instead of quietly compiling to something cheaper;
 *  - the GAME half plays the compiled definition through the engine and asserts
 *    both branches actually happen: mana leaves the payer's board and the spell
 *    lives, or nothing is taken and the spell is countered.
 */

import { describe, expect, it } from 'vitest';
import type {
  CardDefinition,
  CardInstance,
  ChoiceAnswer,
  GameAction,
  GameState,
  PayManaChoice,
  PlayerId,
} from '@jonny-boi/core';
import { applyAction, createGame, DEFAULT_RULES, dumpState, generateLegalActions } from '@jonny-boi/core';
import { compileCard } from './compile/compile.js';
import { explainUnsupported } from './compile/rules.js';
import type { CompilableCard } from './compile/types.js';
import { buildRegistry } from './pool.js';
import { CARD_POOL } from '../data/pool.js';

type Registry = ReturnType<typeof buildRegistry>;

const SEED = 4242;
const DECK_SIZE = 40;

/** The tax Mana Leak charges, as the compiler should emit it. */
const LEAK_TAX = { generic: 3 };

// --- the compiler half ------------------------------------------------------------

function makeCard(overrides: Partial<CompilableCard> & { name: string }): CompilableCard {
  return {
    id: `test:${overrides.name}`,
    manaCost: { generic: 0, W: 0, U: 0, B: 0, R: 0, G: 0, C: 0, other: [] },
    typeLine: { supertypes: [], types: [], subtypes: [] },
    oracleText: '',
    power: null,
    toughness: null,
    keywords: [],
    ...overrides,
  };
}

/** A counterspell-shaped instant carrying `oracleText`. */
function counterCard(name: string, oracleText: string): CompilableCard {
  return makeCard({
    name,
    typeLine: { supertypes: [], types: ['Instant'], subtypes: [] },
    manaCost: { generic: 1, W: 0, U: 1, B: 0, R: 0, G: 0, C: 0, other: [] },
    oracleText,
  });
}

describe('compiling "counter target spell unless its controller pays {N}"', () => {
  it('compiles Mana Leak completely, with the printed tax', () => {
    const result = compileCard(counterCard('Mana Leak', 'Counter target spell unless its controller pays {3}.'));

    expect(result.status).toBe('complete');
    expect(result.definition.effects).toEqual([
      { primitive: 'counterUnlessPaid', params: { targets: 'spell', unlessPaid: LEAK_TAX } },
    ]);
    expect(result.definition.cost).toEqual({ generic: 1, U: 1 });
  });

  it('reads a coloured tax as printed, not as generic', () => {
    const result = compileCard(counterCard('Coloured Leak', 'Counter target spell unless its controller pays {1}{U}.'));

    expect(result.status).toBe('complete');
    expect(result.definition.effects).toEqual([
      { primitive: 'counterUnlessPaid', params: { targets: 'spell', unlessPaid: { generic: 1, U: 1 } } },
    ]);
  });

  it('REFUSES a tax derived from the board (Rune Snag) rather than charging the flat part', () => {
    const result = compileCard(
      counterCard(
        'Rune Snag',
        'Counter target spell unless its controller pays {2} plus an additional {2} for each card named Rune Snag in each graveyard.',
      ),
    );

    // Charging only the printed {2} would make the card strictly weaker than
    // printed, which is exactly the silent approximation the compiler forbids.
    expect(result.status).toBe('incomplete');
    expect(result.definition.effects ?? []).toHaveLength(0);
  });

  it('REFUSES an {X} tax — the engine cannot charge a variable cost', () => {
    const result = compileCard(counterCard('Condescend-ish', 'Counter target spell unless its controller pays {X}.'));
    expect(result.status).toBe('incomplete');
  });

  it('no longer advertises optional payment as a MISSING system', () => {
    // The hint drives the work queue (UNSUPPORTED-MECHANICS.md). Leaving it
    // claiming the system is missing would send the next agent to rebuild this.
    const hint = explainUnsupported('destroy target creature unless its controller pays {2}');
    expect(hint).toBe('an optional-payment template the compiler does not recognize yet');
  });
});

// --- the game half -----------------------------------------------------------------

const MANA_LEAK = compileCard(
  counterCard('Mana Leak', 'Counter target spell unless its controller pays {3}.'),
).definition;

/** A free instant with no effects — something to counter, castable in response. */
const VICTIM: CardDefinition = { id: 'test:Victim', name: 'Victim', types: ['instant'], timing: 'instant' };

function poolCard(name: string): CardDefinition {
  const card = CARD_POOL.find((c) => c.name === name);
  if (!card) throw new Error(`pool missing ${name}`);
  return card;
}

const ISLAND = poolCard('Island');

function act(state: GameState, action: GameAction, reg: Registry): GameState {
  const result = applyAction(state, action, DEFAULT_RULES, reg);
  const rejected = result.events.find((e) => e.type === 'actionRejected');
  if (rejected) throw new Error(`unexpected rejection: ${(rejected as { reason: string }).reason}\n${dumpState(state)}`);
  return result.state;
}

function pass(state: GameState, reg: Registry): GameState {
  return act(state, { kind: 'passPriority', player: state.priorityPlayer }, reg);
}

let syntheticId = 70_000;

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
    counters: {},
  };
}

/**
 * A game where B has cast something, A has answered with Mana Leak, and the Leak
 * has resolved — so B is being asked to pay (or has already been passed over,
 * when `bIslands` cannot cover the tax).
 */
function leakGame(bIslands: number): { state: GameState; reg: Registry; victim: CardInstance } {
  const reg = buildRegistry(CARD_POOL);
  const { state: created } = createGame({
    seed: SEED,
    startingPlayer: 'A',
    registry: reg,
    decks: {
      A: { cards: Array.from({ length: DECK_SIZE }, () => ISLAND) },
      B: { cards: Array.from({ length: DECK_SIZE }, () => ISLAND) },
    },
  });
  let state = created;
  let guard = 0;
  while (state.step !== 'precombatMain' && !state.gameOver && guard++ < 50) state = pass(state, reg);

  const leak = instance(MANA_LEAK, 'A', 'hand');
  const victim = instance(VICTIM, 'B', 'hand');
  state.players.A.hand = [leak];
  state.players.B.hand = [victim];
  // A's Leak costs {1}{U}; flooding A's pool keeps the test about the TAX.
  state.players.A.manaPool = { W: 0, U: 5, B: 0, R: 0, G: 0, C: 0 };
  for (let i = 0; i < bIslands; i++) state.battlefield.push(instance(ISLAND, 'B', 'battlefield'));

  state = pass(state, reg); // A passes so B may cast at instant speed
  state = act(state, { kind: 'castSpell', player: 'B', instanceId: victim.instanceId }, reg);
  state = pass(state, reg); // B passes, holding the floor no longer
  state = act(state, { kind: 'castSpell', player: 'A', instanceId: leak.instanceId, targets: [victim.instanceId] }, reg);
  state = pass(state, reg);
  state = pass(state, reg); // the Leak resolves and asks
  return { state, reg, victim };
}

function answer(state: GameState, reg: Registry, value: ChoiceAnswer): GameState {
  const choice = state.pendingChoice;
  if (!choice) throw new Error(`no choice pending:\n${dumpState(state)}`);
  return act(state, { kind: 'answerChoice', player: choice.chooser, choiceId: choice.id, answer: value }, reg);
}

function untappedLands(state: GameState, player: PlayerId): number {
  return state.battlefield.filter((c) => c.controller === player && !c.tapped).length;
}

describe('the compiled Mana Leak, played through the real engine', () => {
  it('asks the spell’s controller for the printed tax', () => {
    const { state } = leakGame(3);
    const choice = state.pendingChoice as PayManaChoice | null;

    expect(choice?.kind).toBe('payMana');
    expect(choice?.chooser).toBe('B');
    expect(choice?.cost).toEqual(LEAK_TAX);
    expect(choice?.prompt).toContain('{3}');
    expect(choice?.prompt).toContain('Mana Leak');
    expect(generateLegalActions(state).every((a) => a.kind === 'answerChoice')).toBe(true);
  });

  it('paying taps three lands and the spell resolves', () => {
    const { state, reg, victim } = leakGame(3);
    let done = answer(state, reg, { kind: 'payMana', pay: true });

    expect(untappedLands(done, 'B')).toBe(0);
    // The victim is still on the stack; letting it resolve puts it in the
    // graveyard the ordinary way rather than as a countered card.
    expect(done.stack.map((o) => o.instanceId)).toEqual([victim.instanceId]);
    done = pass(done, reg);
    done = pass(done, reg);
    expect(done.stack).toHaveLength(0);
    expect(done.players.B.graveyard.map((c) => c.def.name)).toEqual(['Victim']);
  });

  it('declining counters the spell and takes nothing', () => {
    const { state, reg } = leakGame(3);
    const done = answer(state, reg, { kind: 'payMana', pay: false });

    expect(untappedLands(done, 'B')).toBe(3);
    expect(done.stack).toHaveLength(0);
    expect(done.players.B.graveyard.map((c) => c.def.name)).toEqual(['Victim']);
    expect(done.players.A.graveyard.map((c) => c.def.name)).toEqual(['Mana Leak']);
  });

  it('never asks a player who cannot pay — it just counters', () => {
    const { state } = leakGame(1);

    expect(state.pendingChoice ?? null).toBeNull();
    expect(state.stack).toHaveLength(0);
    expect(state.players.B.graveyard.map((c) => c.def.name)).toEqual(['Victim']);
    expect(untappedLands(state, 'B')).toBe(1);
  });
});

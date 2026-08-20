/**
 * Mana-ability tests: WHO may tap for mana, and HOW MUCH one tap is worth.
 *
 * Two rules are pinned here, both of which the engine previously got wrong and
 * which together made a turn-one Birds of Paradise a five-mana rock:
 *
 *   1. **Rule 302.6 — summoning sickness gates `{T}` abilities.** A creature that
 *      entered this turn cannot pay a `{T}` cost, so a mana creature cannot tap
 *      the turn it lands (unless it has haste, printed *or granted*). Sickness
 *      does not mean "enters tapped"; it means the tap symbol is unavailable.
 *      Non-creature sources — lands, mana rocks — are never affected.
 *   2. **One activation yields one mode.** A *modal* source (`producesOptions`)
 *      adds the mana of exactly ONE chosen mode per tap, so Birds gives one mana
 *      of a color you pick — not one of every color. A *fixed-bundle* source
 *      (legacy `produces`) adds one of each listed entry, so Sol Ring's `['C','C']`
 *      is a genuine two-mana tap.
 */

import { describe, expect, it } from 'vitest';
import {
  applyAction,
  createGame,
  DEFAULT_RULES,
  generateLegalActions,
  manaModesOf,
  poolTotal,
  type CardDefinition,
  defaultAnswerFor,
  type GameAction,
  type GameState,
  type InstanceId,
  type PlayerId,
} from './index.js';
import { createEffectRegistry, type EffectContext, type EffectRegistry } from './effects.js';
import { deckOf, landDef } from './test-fixtures.js';

const ISLAND = landDef('Island', 'U');

/** Birds of Paradise's shape: five single-color modes, one chosen per tap. */
const ANY_COLOR_BIRD: CardDefinition = {
  id: 'AnyColorBird',
  name: 'Any-Color Bird',
  types: ['creature'],
  cost: { G: 1 },
  power: 0,
  toughness: 1,
  producesOptions: [{ W: 1 }, { U: 1 }, { B: 1 }, { R: 1 }, { G: 1 }],
};

/** The same source, but printed with haste — may tap the turn it enters. */
const HASTY_ELF: CardDefinition = {
  id: 'HastyElf',
  name: 'Hasty Elf',
  types: ['creature'],
  cost: { G: 1 },
  power: 1,
  toughness: 1,
  keywords: { haste: true },
  produces: ['G'],
};

/** Sol Ring's shape: a fixed bundle of two colorless on a single activation. */
const TWO_COLORLESS_ROCK: CardDefinition = {
  id: 'TwoColorlessRock',
  name: 'Two-Colorless Rock',
  types: ['artifact'],
  cost: { generic: 1 },
  produces: ['C', 'C'],
};

function testRegistry(): EffectRegistry {
  const reg = createEffectRegistry();
  reg.register('grantKeywordUntilEOT', (ctx: EffectContext) => {
    const keywords = (ctx.params.keywords as CardDefinition['keywords']) ?? {};
    const target = (ctx.targets[0] as InstanceId | undefined) ?? ctx.source.instanceId;
    ctx.addContinuousEffect({ target, keywords, duration: 'endOfTurn' });
  });
  return reg;
}

function act(state: GameState, action: GameAction, reg: EffectRegistry): GameState {
  const r = applyAction(state, action, DEFAULT_RULES, reg);
  const rejected = r.events.find((e) => e.type === 'actionRejected');
  if (rejected) throw new Error(`unexpected rejection: ${(rejected as { reason: string }).reason}`);
  return r.state;
}

function rejectionOf(state: GameState, action: GameAction, reg: EffectRegistry): string | undefined {
  const r = applyAction(state, action, DEFAULT_RULES, reg);
  const rejected = r.events.find((e) => e.type === 'actionRejected');
  return rejected ? (rejected as { reason: string }).reason : undefined;
}

/**
 * Pass priority — or, when a turn-based action has parked a question (the cleanup
 * step's discard down to maximum hand size, CR 514.1), ANSWER it. A seat with a
 * question outstanding may do nothing else, so a helper that only ever passes
 * would wedge the moment any rule stops to ask something.
 */
function pass(state: GameState, reg: EffectRegistry): GameState {
  const question = state.pendingChoice;
  if (question) {
    return act(state, {
      kind: 'answerChoice',
      player: question.chooser,
      choiceId: question.id,
      answer: defaultAnswerFor(question),
    }, reg);
  }
  return act(state, { kind: 'passPriority', player: state.priorityPlayer }, reg);
}

/**
 * Turn-runner: pass until the target, ANSWERING anything the game asks on the
 * way — CR 514.1's cleanup discard is a real question a turn now ends with. See
 * `pass` above: it answers whatever is asked, which is what a bare pass
 * loop can no longer do now that a turn ends with a question.
 */
function advanceToStep(state: GameState, target: string, reg: EffectRegistry, max = 400): GameState {
  let s = state;
  let g = 0;
  while (s.step !== target && !s.gameOver && g++ < max) s = pass(s, reg);
  return s;
}

function advanceUntilActive(state: GameState, player: PlayerId, reg: EffectRegistry, max = 800): GameState {
  let s = state;
  let g = 0;
  while (s.activePlayer !== player && !s.gameOver && g++ < max) s = pass(s, reg);
  return s;
}

function lib(): ReturnType<typeof deckOf> {
  return deckOf(ISLAND, 40);
}

/**
 * Put a permanent onto the battlefield SUMMONING SICK, exactly as one that just
 * resolved this turn would be. Everything here stays on turn 1 with A active, and
 * `beginTurn` only clears sickness at the START of a turn, so it stays sick.
 */
function placeSick(state: GameState, def: CardDefinition, controller: PlayerId): InstanceId {
  const id = state.nextInstanceId++;
  state.battlefield.push({
    instanceId: id,
    def,
    controller,
    owner: controller,
    zone: 'battlefield',
    tapped: false,
    summoningSick: true,
    damageMarked: 0,
    markedByDeathtouch: false,
    counters: {},
  });
  return id;
}

/** Every `tapForMana` action offered for one permanent, in mode order. */
function tapActionsFor(state: GameState, id: InstanceId): GameAction[] {
  return generateLegalActions(state).filter((a) => a.kind === 'tapForMana' && a.instanceId === id);
}

describe('summoning sickness gates {T} mana abilities (rule 302.6)', () => {
  it('a mana creature that entered this turn is NOT offered a tap-for-mana action', () => {
    const reg = testRegistry();
    const { state } = createGame({ seed: 1, decks: { A: lib(), B: lib() }, registry: reg });
    const birdId = placeSick(state, ANY_COLOR_BIRD, 'A');
    const s = advanceToStep(state, 'precombatMain', reg);

    expect(s.battlefield.find((c) => c.instanceId === birdId)!.summoningSick).toBe(true);
    expect(tapActionsFor(s, birdId)).toHaveLength(0);
  });

  it('and a directly-constructed tap of it is rejected for summoning sickness', () => {
    const reg = testRegistry();
    const { state } = createGame({ seed: 2, decks: { A: lib(), B: lib() }, registry: reg });
    const birdId = placeSick(state, ANY_COLOR_BIRD, 'A');
    const s = advanceToStep(state, 'precombatMain', reg);

    const reason = rejectionOf(s, { kind: 'tapForMana', player: 'A', instanceId: birdId }, reg);
    expect(reason).toMatch(/summoning sickness/i);
    // Rejected means rejected: it must not have been tapped nor produced mana.
    expect(s.battlefield.find((c) => c.instanceId === birdId)!.tapped).toBe(false);
    expect(poolTotal(s.players.A.manaPool)).toBe(0);
  });

  it('the same creature CAN tap for mana on its controller’s next turn', () => {
    const reg = testRegistry();
    const { state } = createGame({ seed: 3, decks: { A: lib(), B: lib() }, registry: reg });
    const birdId = placeSick(state, ANY_COLOR_BIRD, 'A');

    // Round the turn cycle back to A: sickness clears at the start of their turn.
    let s = advanceUntilActive(state, 'B', reg);
    s = advanceUntilActive(s, 'A', reg);
    s = advanceToStep(s, 'precombatMain', reg);

    expect(s.battlefield.find((c) => c.instanceId === birdId)!.summoningSick).toBe(false);
    expect(tapActionsFor(s, birdId).length).toBeGreaterThan(0);
    const tapped = act(s, { kind: 'tapForMana', player: 'A', instanceId: birdId, mode: 0 }, reg);
    expect(poolTotal(tapped.players.A.manaPool)).toBe(1);
  });

  it('PRINTED haste lets a mana creature tap the turn it enters', () => {
    const reg = testRegistry();
    const { state } = createGame({ seed: 4, decks: { A: lib(), B: lib() }, registry: reg });
    // Placed sick ON PURPOSE: entering with printed haste would clear the flag
    // anyway, so forcing it proves the gate consults haste, not just the flag.
    const elfId = placeSick(state, HASTY_ELF, 'A');
    const s = advanceToStep(state, 'precombatMain', reg);

    expect(tapActionsFor(s, elfId)).toHaveLength(1);
    const tapped = act(s, { kind: 'tapForMana', player: 'A', instanceId: elfId }, reg);
    expect(tapped.players.A.manaPool.G).toBe(1);
  });

  it('GRANTED haste (until-EOT) also lets a still-sick mana creature tap', () => {
    const reg = testRegistry();
    const { state } = createGame({ seed: 5, decks: { A: lib(), B: lib() }, registry: reg });
    const birdId = placeSick(state, ANY_COLOR_BIRD, 'A');
    const grant: CardDefinition = {
      id: 'GrantHaste',
      name: 'Grant Haste',
      types: ['instant'],
      timing: 'instant',
      cost: { generic: 0 },
      effects: [{ primitive: 'grantKeywordUntilEOT', params: { keywords: { haste: true } } }],
    };
    const grantId = state.nextInstanceId++;
    state.players.A.hand.push({
      instanceId: grantId,
      def: grant,
      controller: 'A',
      owner: 'A',
      zone: 'hand',
      tapped: false,
      summoningSick: false,
      damageMarked: 0,
      markedByDeathtouch: false,
      counters: {},
    });

    let s = advanceToStep(state, 'precombatMain', reg);
    expect(tapActionsFor(s, birdId)).toHaveLength(0); // control: sick, no grant yet

    s = act(s, { kind: 'castSpell', player: 'A', instanceId: grantId, targets: [birdId] }, reg);
    s = pass(s, reg);
    s = pass(s, reg); // resolve the grant

    // Still flagged sick — only the EFFECTIVE keyword set unlocks the tap.
    expect(s.battlefield.find((c) => c.instanceId === birdId)!.summoningSick).toBe(true);
    expect(tapActionsFor(s, birdId)).toHaveLength(ANY_COLOR_BIRD.producesOptions!.length);
    const tapped = act(s, { kind: 'tapForMana', player: 'A', instanceId: birdId, mode: 0 }, reg);
    expect(poolTotal(tapped.players.A.manaPool)).toBe(1);
  });

  it('NON-creature sources are unaffected: a rock that just entered taps immediately', () => {
    const reg = testRegistry();
    const { state } = createGame({ seed: 6, decks: { A: lib(), B: lib() }, registry: reg });
    const rockId = placeSick(state, TWO_COLORLESS_ROCK, 'A');
    const s = advanceToStep(state, 'precombatMain', reg);

    expect(tapActionsFor(s, rockId)).toHaveLength(1);
    const tapped = act(s, { kind: 'tapForMana', player: 'A', instanceId: rockId }, reg);
    expect(tapped.players.A.manaPool.C).toBe(2);
  });
});

describe('one activation yields exactly one mode', () => {
  /** An unsick modal source on A's battlefield, in A's precombat main. */
  function withReadyBird(seed: number): { reg: EffectRegistry; state: GameState; birdId: InstanceId } {
    const reg = testRegistry();
    const { state } = createGame({ seed, decks: { A: lib(), B: lib() }, registry: reg });
    const birdId = state.nextInstanceId++;
    state.battlefield.push({
      instanceId: birdId,
      def: ANY_COLOR_BIRD,
      controller: 'A',
      owner: 'A',
      zone: 'battlefield',
      tapped: false,
      summoningSick: false,
      damageMarked: 0,
      markedByDeathtouch: false,
      counters: {},
    });
    return { reg, state: advanceToStep(state, 'precombatMain', reg), birdId };
  }

  it('a modal source offers one action per mode, and each adds ONE mana', () => {
    const { reg, state, birdId } = withReadyBird(7);

    const taps = tapActionsFor(state, birdId);
    expect(taps).toHaveLength(5);
    expect(taps.map((a) => (a as { mode?: number }).mode)).toEqual([0, 1, 2, 3, 4]);

    // Mode 3 is {R}: exactly one red, and nothing else.
    const tapped = act(state, { kind: 'tapForMana', player: 'A', instanceId: birdId, mode: 3 }, reg);
    expect(tapped.players.A.manaPool.R).toBe(1);
    expect(poolTotal(tapped.players.A.manaPool)).toBe(1);
  });

  it('regression: tapping an any-color source does NOT add one of every color', () => {
    const { reg, state, birdId } = withReadyBird(8);
    const tapped = act(state, { kind: 'tapForMana', player: 'A', instanceId: birdId }, reg);
    // The old engine produced WUBRG (5) here.
    expect(poolTotal(tapped.players.A.manaPool)).toBe(1);
  });

  it('reports the produced mana as one manaAdded event of the chosen color', () => {
    const { state, birdId } = withReadyBird(9);
    const r = applyAction(
      state,
      { kind: 'tapForMana', player: 'A', instanceId: birdId, mode: 2 },
      DEFAULT_RULES,
      testRegistry(),
    );
    const added = r.events.filter((e) => e.type === 'manaAdded');
    expect(added).toEqual([{ type: 'manaAdded', player: 'A', color: 'B', amount: 1 }]);
  });

  it('an out-of-range mode is rejected, leaving the source untapped', () => {
    const { reg, state, birdId } = withReadyBird(10);
    const reason = rejectionOf(state, { kind: 'tapForMana', player: 'A', instanceId: birdId, mode: 9 }, reg);
    expect(reason).toMatch(/no mana mode/i);
    expect(state.battlefield.find((c) => c.instanceId === birdId)!.tapped).toBe(false);
  });
});

describe('manaModesOf normalises both authoring forms', () => {
  it('a fixed bundle collapses into a single mode with summed amounts', () => {
    expect(manaModesOf(TWO_COLORLESS_ROCK)).toEqual([{ C: 2 }]);
    expect(manaModesOf(landDef('Forest', 'G'))).toEqual([{ G: 1 }]);
  });

  it('a modal source keeps its modes verbatim', () => {
    expect(manaModesOf(ANY_COLOR_BIRD)).toEqual([{ W: 1 }, { U: 1 }, { B: 1 }, { R: 1 }, { G: 1 }]);
  });

  it('a non-source has no modes', () => {
    expect(manaModesOf({ id: 'x', name: 'Bear', types: ['creature'], power: 2, toughness: 2 })).toEqual([]);
  });
});

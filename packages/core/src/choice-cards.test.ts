/**
 * End-to-end proof of the player-choice system, played through REAL GAMES.
 *
 * Every fixture below is an inline `CardDefinition` shaped like a card the pool
 * currently has to stub out (`STUBBED_MECHANICS` in `packages/cards`) — Brainstorm,
 * Thoughtseize, Cryptic Command, a "you may", a library search. They are built only
 * from registered effect primitives plus the choice API, which is the point: if
 * these play correctly here, the same shapes work for the real cards, and core
 * still knows nothing about any specific card.
 *
 * Beyond "it works", the suite pins the properties everything downstream depends
 * on: purity and no shared references with a choice parked in state, byte-identical
 * replays from a seed, clean rejection of illegal/stale/wrong-seat answers, safe
 * degradation when a choice becomes impossible, and guaranteed termination.
 */

import { describe, expect, it } from 'vitest';
import {
  applyAction,
  cloneState,
  collectCardOptions,
  createGame,
  createRng,
  DEFAULT_RULES,
  dumpState,
  generateLegalActions,
  opponentOf,
  serializeState,
  type CardDefinition,
  type CardFilter,
  type ChoiceAnswer,
  type EffectContext,
  type GameAction,
  type GameEvent,
  type GameState,
  type InstanceId,
} from './index.js';
import { createEffectRegistry, type EffectRegistry } from './effects.js';
import { creatureDef, deckOf, giveHand, giveLibrary, landDef } from './test-fixtures.js';

const ISLAND = landDef('Island', 'U');

// --- the primitives the fixture cards are built from -------------------------------

/**
 * A registry of small, card-agnostic primitives. Each is exactly what the `cards`
 * package would register: it reads its params, asks its question through the
 * choice API, and returns immediately while the question is parked.
 */
function choiceRegistry(): EffectRegistry {
  const reg = createEffectRegistry();

  /** Draw N cards for the controller. */
  reg.register('drawCards', (ctx: EffectContext) => {
    const count = (ctx.params.count as number | undefined) ?? 1;
    const player = ctx.state.players[ctx.controller];
    for (let i = 0; i < count; i++) {
      const top = player.library.shift();
      if (!top) break;
      top.zone = 'hand';
      player.hand.push(top);
      ctx.emit({ type: 'drawCard', player: ctx.controller, instanceId: top.instanceId });
    }
  });

  /** Deal N damage to the controller's opponent. */
  reg.register('pingOpponent', (ctx: EffectContext) => {
    const amount = (ctx.params.amount as number | undefined) ?? 1;
    const victim = opponentOf(ctx.controller);
    const player = ctx.state.players[victim];
    player.life -= amount;
    ctx.emit({ type: 'lifeChanged', player: victim, delta: -amount, to: player.life });
  });

  /** Gain N life. */
  reg.register('gainLife', (ctx: EffectContext) => {
    const amount = (ctx.params.amount as number | undefined) ?? 1;
    const player = ctx.state.players[ctx.controller];
    player.life += amount;
    ctx.emit({ type: 'gainLife', player: ctx.controller, amount });
  });

  /**
   * BRAINSTORM's back half: put `count` cards from your hand on top of your
   * library **in an order you choose**. `ordered: true` makes the answer's order
   * the answer, so this needs no "arrange" choice kind of its own.
   */
  reg.register('putFromHandOnTop', (ctx: EffectContext) => {
    const count = (ctx.params.count as number | undefined) ?? 1;
    const candidates = collectCardOptions(ctx.state, 'hand', { controller: ctx.controller });
    const chosen = ctx.chooseCards({
      prompt: `Put ${count} card(s) from your hand on top of your library, in any order`,
      candidates,
      min: count,
      max: count,
      ordered: true,
      valence: 'loss',
      fromZone: 'hand',
    });
    if (!chosen) return; // parked — nothing mutated, we will be re-run
    const player = ctx.state.players[ctx.controller];
    // The FIRST chosen card ends up on top, so place them back-to-front.
    for (let i = chosen.length - 1; i >= 0; i--) {
      const id = chosen[i] as InstanceId;
      const index = player.hand.findIndex((c) => c.instanceId === id);
      if (index < 0) continue; // already gone — safe, never a throw
      const [card] = player.hand.splice(index, 1);
      if (!card) continue;
      card.zone = 'library';
      player.library.unshift(card);
      ctx.emit({ type: 'zoneChange', instanceId: card.instanceId, from: 'hand', to: 'library' });
    }
  });

  /**
   * THOUGHTSEIZE's shape: the OPPONENT chooses which of their own nonland cards to
   * discard. `chooser` is what makes it their decision, and the engine enforces it.
   */
  reg.register('opponentDiscardsChosen', (ctx: EffectContext) => {
    const victim = opponentOf(ctx.controller);
    const candidates = collectCardOptions(ctx.state, 'hand', {
      controller: victim,
      filter: { noneOfTypes: ['land'] },
    });
    const chosen = ctx.chooseCards({
      chooser: victim,
      prompt: 'Choose a nonland card to discard',
      candidates,
      min: 1,
      max: 1,
      valence: 'loss',
      fromZone: 'hand',
    });
    if (!chosen) return;
    const player = ctx.state.players[victim];
    for (const id of chosen) {
      const index = player.hand.findIndex((c) => c.instanceId === id);
      if (index < 0) continue;
      const [card] = player.hand.splice(index, 1);
      if (!card) continue;
      card.zone = 'graveyard';
      player.graveyard.push(card);
      ctx.emit({ type: 'zoneChange', instanceId: card.instanceId, from: 'hand', to: 'graveyard' });
    }
  });

  /**
   * CRYPTIC COMMAND's shape: choose K of the modes listed in params, then run the
   * chosen modes' effects inside this same resolution. One primitive serves every
   * modal card there will ever be — the modes are data on the card.
   */
  reg.register('modal', (ctx: EffectContext) => {
    const modes = (ctx.params.modes as ReadonlyArray<{ id: string; label: string; effects: CardDefinition['effects'] }>) ?? [];
    const count = (ctx.params.count as number | undefined) ?? 1;
    const chosen = ctx.chooseModes({
      prompt: `Choose ${count} —`,
      modes: modes.map((m) => ({ id: m.id, label: m.label })),
      min: count,
      max: count,
      valence: 'gain',
    });
    if (!chosen) return;
    const refs = chosen.flatMap((id) => modes.find((m) => m.id === id)?.effects ?? []);
    ctx.enqueueEffects(refs);
  });

  /** A "you may": ask, then run the params' effects only on a yes. */
  reg.register('mayDo', (ctx: EffectContext) => {
    const prompt = (ctx.params.prompt as string | undefined) ?? 'You may…';
    const yes = ctx.confirm({ prompt, valence: 'neutral' });
    if (yes === undefined) return;
    ctx.emit({ type: 'effectApplied', primitive: yes ? 'mayDo:yes' : 'mayDo:no', sourceInstanceId: ctx.source.instanceId });
    if (!yes) return;
    ctx.enqueueEffects((ctx.params.effects as CardDefinition['effects']) ?? []);
  });

  /**
   * PATH TO EXILE's tail: search your library for a card matching a filter, put it
   * in your hand, then shuffle. The shuffle runs off the state-carried seeded RNG,
   * so a search is as reproducible as everything else.
   */
  reg.register('searchLibrary', (ctx: EffectContext) => {
    const candidates = collectCardOptions(ctx.state, 'library', {
      controller: ctx.controller,
      filter: ctx.params.filter as CardFilter | undefined,
    });
    const chosen = ctx.chooseCards({
      prompt: 'Search your library for a card',
      candidates,
      min: 0,
      max: 1,
      valence: 'gain',
      fromZone: 'library',
    });
    if (!chosen) return;
    const player = ctx.state.players[ctx.controller];
    for (const id of chosen) {
      const index = player.library.findIndex((c) => c.instanceId === id);
      if (index < 0) continue;
      const [card] = player.library.splice(index, 1);
      if (!card) continue;
      card.zone = 'hand';
      player.hand.push(card);
      ctx.emit({ type: 'zoneChange', instanceId: card.instanceId, from: 'library', to: 'hand' });
    }
    ctx.shuffleLibrary(ctx.controller);
  });

  /** A primitive that asks a kind this build cannot represent (robustness fixture). */
  reg.register('asksUnknownKind', (ctx: EffectContext) => {
    const answer = ctx.ask({ kind: 'telepathy', chooser: ctx.controller, prompt: 'read my mind' } as never);
    if (!answer) return;
    ctx.emit({ type: 'effectApplied', primitive: 'shouldNotHappen', sourceInstanceId: ctx.source.instanceId });
  });

  /** A primitive that asks forever (ask-budget fixture). */
  reg.register('asksForever', (ctx: EffectContext) => {
    for (;;) {
      const yes = ctx.confirm({ prompt: 'again?' });
      if (yes === undefined) return;
    }
  });

  return reg;
}

// --- the fixture cards ---------------------------------------------------------------

/** A free instant (no cost) so tests can cast without a mana ritual. */
function freeInstant(id: string, effects: CardDefinition['effects']): CardDefinition {
  return { id, name: id, types: ['instant'], timing: 'instant', effects };
}

const BRAINSTORM = freeInstant('Brainstorm', [
  { primitive: 'drawCards', params: { count: 3 } },
  { primitive: 'putFromHandOnTop', params: { count: 2 } },
]);

const THOUGHTSEIZE = freeInstant('Thoughtseize', [{ primitive: 'opponentDiscardsChosen' }]);

const CRYPTIC_MODES = [
  { id: 'draw', label: 'Draw a card', effects: [{ primitive: 'drawCards', params: { count: 1 } }] },
  { id: 'burn', label: 'Deal 2 damage', effects: [{ primitive: 'pingOpponent', params: { amount: 2 } }] },
  { id: 'life', label: 'Gain 3 life', effects: [{ primitive: 'gainLife', params: { amount: 3 } }] },
  { id: 'burn2', label: 'Deal 1 damage', effects: [{ primitive: 'pingOpponent', params: { amount: 1 } }] },
] as const;

const CRYPTIC = freeInstant('Cryptic Command', [
  { primitive: 'modal', params: { count: 2, modes: CRYPTIC_MODES } },
]);

const MAY_DRAW = freeInstant('Optional Insight', [
  { primitive: 'mayDo', params: { prompt: 'You may draw a card', effects: [{ primitive: 'drawCards', params: { count: 1 } }] } },
]);

const SEARCH = freeInstant('Land Grant', [{ primitive: 'searchLibrary' }]);

const BEAR = creatureDef('Bear', 2, 2);
const OGRE = creatureDef('Ogre', 4, 4);

// --- harness -----------------------------------------------------------------------

const SEED = 0x5eed;

/** Apply an action, asserting the engine did not reject it. */
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
function gameAtMain(reg: EffectRegistry, seed = SEED): GameState {
  const created = createGame({
    seed,
    registry: reg,
    decks: { A: deckOf(ISLAND, 40), B: deckOf(ISLAND, 40) },
  });
  let state = created.state;
  let guard = 0;
  while (state.step !== 'precombatMain' && !state.gameOver && guard++ < 50) state = pass(state, reg);
  return state;
}

/** Cast the (free) card at `instanceId` and let both players pass so it resolves. */
function castAndResolve(state: GameState, instanceId: InstanceId, reg: EffectRegistry): GameState {
  let next = act(state, { kind: 'castSpell', player: state.priorityPlayer, instanceId }, reg);
  next = pass(next, reg); // caster passes
  next = pass(next, reg); // opponent passes → resolves
  return next;
}

/** Submit an answer to whatever is parked, asserting it is accepted. */
function answer(state: GameState, reg: EffectRegistry, value: ChoiceAnswer): GameState {
  const choice = state.pendingChoice;
  if (!choice) throw new Error(`no choice pending:\n${dumpState(state)}`);
  return act(state, { kind: 'answerChoice', player: choice.chooser, choiceId: choice.id, answer: value }, reg);
}

function names(cards: readonly { def: CardDefinition }[]): string[] {
  return cards.map((c) => c.def.name);
}

// --- Brainstorm ----------------------------------------------------------------------

describe('a Brainstorm-shaped card (draw 3, put 2 back on top in a chosen order)', () => {
  function brainstormGame(): { state: GameState; reg: EffectRegistry; spell: InstanceId } {
    const reg = choiceRegistry();
    const state = gameAtMain(reg);
    // A known library: the top three are distinguishable, so "which cards came back
    // and in what order" is actually observable.
    giveLibrary(state, 'A', [
      landDef('Top1', 'U'),
      landDef('Top2', 'U'),
      landDef('Top3', 'U'),
      ...Array.from({ length: 20 }, () => ISLAND),
    ]);
    state.players.A.hand = [];
    const [spell] = giveHand(state, 'A', [BRAINSTORM]);
    return { state, reg, spell: (spell as { instanceId: InstanceId }).instanceId };
  }

  it('draws three, then asks its controller to order two cards back onto the library', () => {
    const { state, reg, spell } = brainstormGame();
    const parked = castAndResolve(state, spell, reg);

    expect(parked.pendingChoice).toBeTruthy();
    const choice = parked.pendingChoice!;
    expect(choice.kind).toBe('selectCards');
    expect(choice.chooser).toBe('A');
    // The three drawn cards are the candidates — the spell itself is on the stack.
    expect(choice.kind === 'selectCards' && choice.candidates.map((c) => c.name).sort()).toEqual([
      'Top1',
      'Top2',
      'Top3',
    ]);
    expect(choice.kind === 'selectCards' && choice.ordered).toBe(true);
    expect(choice.min).toBe(2);
    expect(choice.max).toBe(2);
    // The chooser holds the floor and answering is the only thing the game accepts.
    expect(parked.priorityPlayer).toBe('A');
    expect(generateLegalActions(parked).every((a) => a.kind === 'answerChoice')).toBe(true);
  });

  it('puts the chosen cards back IN THE CHOSEN ORDER — first choice ends up on top', () => {
    const { state, reg, spell } = brainstormGame();
    const parked = castAndResolve(state, spell, reg);
    const choice = parked.pendingChoice!;
    const byName = (n: string): InstanceId =>
      (choice.kind === 'selectCards' ? choice.candidates.find((c) => c.name === n)!.instanceId : 0);

    // Deliberately NOT candidate order: Top3 first, then Top1.
    const done = answer(parked, reg, { kind: 'selectCards', instanceIds: [byName('Top3'), byName('Top1')] });

    expect(names(done.players.A.library).slice(0, 2)).toEqual(['Top3', 'Top1']);
    expect(names(done.players.A.hand)).toEqual(['Top2']);
    // The spell finished resolving: no question left, and it is in the graveyard.
    expect(done.pendingChoice ?? null).toBeNull();
    expect(done.resolution ?? null).toBeNull();
    expect(names(done.players.A.graveyard)).toContain('Brainstorm');
    expect(done.stack).toHaveLength(0);
    // Priority came back to the active player, as after any other resolution.
    expect(done.priorityPlayer).toBe(done.activePlayer);
  });

  it('reversing the answer reverses the library — the order really is the answer', () => {
    const { state, reg, spell } = brainstormGame();
    const parked = castAndResolve(state, spell, reg);
    const choice = parked.pendingChoice!;
    const byName = (n: string): InstanceId =>
      (choice.kind === 'selectCards' ? choice.candidates.find((c) => c.name === n)!.instanceId : 0);

    const done = answer(parked, reg, { kind: 'selectCards', instanceIds: [byName('Top1'), byName('Top3')] });
    expect(names(done.players.A.library).slice(0, 2)).toEqual(['Top1', 'Top3']);
  });
});

// --- Thoughtseize --------------------------------------------------------------------

describe('a Thoughtseize-shaped card (the OPPONENT chooses the discard)', () => {
  function thoughtseizeGame(): { state: GameState; reg: EffectRegistry; spell: InstanceId } {
    const reg = choiceRegistry();
    const state = gameAtMain(reg);
    state.players.A.hand = [];
    state.players.B.hand = [];
    giveHand(state, 'B', [BEAR, OGRE, ISLAND]);
    const [spell] = giveHand(state, 'A', [THOUGHTSEIZE]);
    return { state, reg, spell: (spell as { instanceId: InstanceId }).instanceId };
  }

  it('addresses the choice to the victim, not the caster, and hands them the floor', () => {
    const { state, reg, spell } = thoughtseizeGame();
    const parked = castAndResolve(state, spell, reg);

    const choice = parked.pendingChoice!;
    expect(choice.chooser).toBe('B');
    expect(parked.priorityPlayer).toBe('B');
    expect(generateLegalActions(parked).every((a) => a.player === 'B')).toBe(true);
    // The filter is honoured: the land in B's hand is not a legal discard.
    expect(choice.kind === 'selectCards' && choice.candidates.map((c) => c.name).sort()).toEqual(['Bear', 'Ogre']);
  });

  it('refuses an answer from the caster and keeps the question standing', () => {
    const { state, reg, spell } = thoughtseizeGame();
    const parked = castAndResolve(state, spell, reg);
    const choice = parked.pendingChoice!;
    const victimCard = choice.kind === 'selectCards' ? choice.candidates[0]!.instanceId : 0;

    const result = applyAction(
      parked,
      { kind: 'answerChoice', player: 'A', choiceId: choice.id, answer: { kind: 'selectCards', instanceIds: [victimCard] } },
      DEFAULT_RULES,
      reg,
    );
    expect(result.events.some((e) => e.type === 'actionRejected')).toBe(true);
    // Nothing moved, and B still owes an answer.
    expect(result.state.pendingChoice?.id).toBe(choice.id);
    expect(result.state.players.B.hand).toHaveLength(3);
    expect(result.state.players.B.graveyard).toHaveLength(0);
  });

  it('discards exactly the card the victim named', () => {
    const { state, reg, spell } = thoughtseizeGame();
    const parked = castAndResolve(state, spell, reg);
    const choice = parked.pendingChoice!;
    const ogre = choice.kind === 'selectCards' ? choice.candidates.find((c) => c.name === 'Ogre')!.instanceId : 0;

    const done = answer(parked, reg, { kind: 'selectCards', instanceIds: [ogre] });
    expect(names(done.players.B.graveyard)).toEqual(['Ogre']);
    expect(names(done.players.B.hand).sort()).toEqual(['Bear', 'Island']);
    // Priority returns to the ACTIVE player — the victim only borrowed the floor.
    expect(done.priorityPlayer).toBe(done.activePlayer);
  });

  it('auto-answers with nothing when the victim has no legal discard (empty hand)', () => {
    const reg = choiceRegistry();
    const state = gameAtMain(reg);
    state.players.A.hand = [];
    state.players.B.hand = []; // no nonland cards at all
    const [spell] = giveHand(state, 'A', [THOUGHTSEIZE]);

    const result = applyAction(
      castStep(state, (spell as { instanceId: InstanceId }).instanceId, reg),
      { kind: 'passPriority', player: 'B' },
      DEFAULT_RULES,
      reg,
    );
    // With zero candidates the choice has exactly one answer, so the engine takes
    // it rather than stopping the game — the spell resolves in one go.
    expect(result.state.pendingChoice ?? null).toBeNull();
    expect(result.events.some((e) => e.type === 'choiceAutoAnswered')).toBe(true);
    expect(names(result.state.players.A.graveyard)).toContain('Thoughtseize');
  });
});

/** Cast + the caster's own pass, leaving the opponent to pass next. */
function castStep(state: GameState, instanceId: InstanceId, reg: EffectRegistry): GameState {
  const cast = act(state, { kind: 'castSpell', player: state.priorityPlayer, instanceId }, reg);
  return pass(cast, reg);
}

// --- modal ---------------------------------------------------------------------------

describe('a modal "choose two" card', () => {
  function crypticGame(): { state: GameState; reg: EffectRegistry; spell: InstanceId } {
    const reg = choiceRegistry();
    const state = gameAtMain(reg);
    state.players.A.hand = [];
    const [spell] = giveHand(state, 'A', [CRYPTIC]);
    return { state, reg, spell: (spell as { instanceId: InstanceId }).instanceId };
  }

  it('offers all four modes and requires exactly two', () => {
    const { state, reg, spell } = crypticGame();
    const parked = castAndResolve(state, spell, reg);
    const choice = parked.pendingChoice!;
    expect(choice.kind).toBe('chooseModes');
    expect(choice.kind === 'chooseModes' && choice.modes.map((m) => m.id)).toEqual(['draw', 'burn', 'life', 'burn2']);
    expect([choice.min, choice.max]).toEqual([2, 2]);
  });

  it('runs exactly the chosen modes, in the same resolution', () => {
    const { state, reg, spell } = crypticGame();
    const parked = castAndResolve(state, spell, reg);
    const handBefore = parked.players.A.hand.length;
    const oppLifeBefore = parked.players.B.life;

    const done = answer(parked, reg, { kind: 'chooseModes', modeIds: ['draw', 'burn'] });

    expect(done.players.A.hand).toHaveLength(handBefore + 1);
    expect(done.players.B.life).toBe(oppLifeBefore - 2);
    expect(done.players.A.life).toBe(parked.players.A.life); // the life mode was NOT chosen
    expect(names(done.players.A.graveyard)).toContain('Cryptic Command');
  });

  it('rejects choosing the wrong number of modes, and an unlisted mode', () => {
    const { state, reg, spell } = crypticGame();
    const parked = castAndResolve(state, spell, reg);
    const id = parked.pendingChoice!.id;
    const send = (modeIds: string[]): readonly GameEvent[] =>
      applyAction(
        parked,
        { kind: 'answerChoice', player: 'A', choiceId: id, answer: { kind: 'chooseModes', modeIds } },
        DEFAULT_RULES,
        reg,
      ).events;

    expect(send(['draw']).some((e) => e.type === 'actionRejected')).toBe(true);
    expect(send(['draw', 'burn', 'life']).some((e) => e.type === 'actionRejected')).toBe(true);
    expect(send(['draw', 'draw']).some((e) => e.type === 'actionRejected')).toBe(true);
    expect(send(['draw', 'counterspell']).some((e) => e.type === 'actionRejected')).toBe(true);
  });
});

// --- "you may" -----------------------------------------------------------------------

describe('a "you may" card (both branches)', () => {
  function mayGame(): { state: GameState; reg: EffectRegistry; spell: InstanceId } {
    const reg = choiceRegistry();
    const state = gameAtMain(reg);
    state.players.A.hand = [];
    const [spell] = giveHand(state, 'A', [MAY_DRAW]);
    return { state, reg, spell: (spell as { instanceId: InstanceId }).instanceId };
  }

  it('yes draws the card', () => {
    const { state, reg, spell } = mayGame();
    const parked = castAndResolve(state, spell, reg);
    expect(parked.pendingChoice!.kind).toBe('confirm');

    const done = answer(parked, reg, { kind: 'confirm', yes: true });
    expect(done.players.A.hand).toHaveLength(1);
  });

  it('no declines it, and the spell still finishes resolving', () => {
    const { state, reg, spell } = mayGame();
    const parked = castAndResolve(state, spell, reg);

    const done = answer(parked, reg, { kind: 'confirm', yes: false });
    expect(done.players.A.hand).toHaveLength(0);
    expect(names(done.players.A.graveyard)).toContain('Optional Insight');
    expect(done.pendingChoice ?? null).toBeNull();
  });

  it('offers both branches as legal actions', () => {
    const { state, reg, spell } = mayGame();
    const parked = castAndResolve(state, spell, reg);
    const actions = generateLegalActions(parked);
    const yeses = actions.filter((a) => a.kind === 'answerChoice' && a.answer.kind === 'confirm' && a.answer.yes);
    const nos = actions.filter((a) => a.kind === 'answerChoice' && a.answer.kind === 'confirm' && !a.answer.yes);
    expect(yeses).toHaveLength(1);
    expect(nos).toHaveLength(1);
  });
});

// --- library search ------------------------------------------------------------------

describe('a search-your-library card', () => {
  function searchGame(seed = SEED): { state: GameState; reg: EffectRegistry; spell: InstanceId } {
    const reg = choiceRegistry();
    const state = gameAtMain(reg, seed);
    state.players.A.hand = [];
    giveLibrary(state, 'A', [
      landDef('Alpha', 'U'),
      landDef('Beta', 'U'),
      landDef('Gamma', 'U'),
      landDef('Delta', 'U'),
      landDef('Epsilon', 'U'),
      landDef('Zeta', 'U'),
    ]);
    const [spell] = giveHand(state, 'A', [SEARCH]);
    return { state, reg, spell: (spell as { instanceId: InstanceId }).instanceId };
  }

  it('offers the library as candidates and moves the chosen card to hand', () => {
    const { state, reg, spell } = searchGame();
    const parked = castAndResolve(state, spell, reg);
    const choice = parked.pendingChoice!;
    expect(choice.kind === 'selectCards' && choice.fromZone).toBe('library');
    expect(choice.min).toBe(0); // "you may" on a selection: 0..1
    expect(choice.max).toBe(1);

    const gamma = choice.kind === 'selectCards' ? choice.candidates.find((c) => c.name === 'Gamma')!.instanceId : 0;
    const done = answer(parked, reg, { kind: 'selectCards', instanceIds: [gamma] });

    expect(names(done.players.A.hand)).toEqual(['Gamma']);
    expect(names(done.players.A.library)).not.toContain('Gamma');
    expect(done.players.A.library).toHaveLength(5);
  });

  it('shuffles afterwards, and the shuffle is REPRODUCIBLE under a fixed seed', () => {
    const run = (seed: number): string[] => {
      const { state, reg, spell } = searchGame(seed);
      const parked = castAndResolve(state, spell, reg);
      const choice = parked.pendingChoice!;
      const alpha = choice.kind === 'selectCards' ? choice.candidates.find((c) => c.name === 'Alpha')!.instanceId : 0;
      return names(answer(parked, reg, { kind: 'selectCards', instanceIds: [alpha] }).players.A.library);
    };

    const first = run(SEED);
    expect(run(SEED)).toEqual(first); // same seed ⇒ same shuffle, every time
    // It really shuffled: the remaining cards are no longer in library order.
    expect(first.sort()).toEqual(['Beta', 'Delta', 'Epsilon', 'Gamma', 'Zeta']);
    expect(run(SEED + 1)).not.toEqual(first); // a different seed shuffles differently
  });

  it('lets the controller decline the search entirely (min 0)', () => {
    const { state, reg, spell } = searchGame();
    const parked = castAndResolve(state, spell, reg);
    const done = answer(parked, reg, { kind: 'selectCards', instanceIds: [] });
    expect(done.players.A.hand).toHaveLength(0);
    expect(done.players.A.library).toHaveLength(6);
  });
});

// --- purity, determinism, robustness, termination --------------------------------------

describe('purity and determinism with a choice parked in state', () => {
  function parkedGame(): { parked: GameState; reg: EffectRegistry } {
    const reg = choiceRegistry();
    const state = gameAtMain(reg);
    state.players.A.hand = [];
    const [spell] = giveHand(state, 'A', [CRYPTIC]);
    return { parked: castAndResolve(state, (spell as { instanceId: InstanceId }).instanceId, reg), reg };
  }

  it('applyAction does not mutate a state that holds a pending choice', () => {
    const { parked, reg } = parkedGame();
    const before = JSON.stringify(serializeState(parked));
    const beforeChoice = JSON.stringify(parked.pendingChoice);
    const beforeFrame = JSON.stringify(parked.resolution);

    applyAction(
      parked,
      { kind: 'answerChoice', player: 'A', choiceId: parked.pendingChoice!.id, answer: { kind: 'chooseModes', modeIds: ['draw', 'burn'] } },
      DEFAULT_RULES,
      reg,
    );

    expect(JSON.stringify(serializeState(parked))).toBe(before);
    expect(JSON.stringify(parked.pendingChoice)).toBe(beforeChoice);
    expect(JSON.stringify(parked.resolution)).toBe(beforeFrame);
  });

  it('a rejected answer leaves the previous state untouched and returns an unaliased copy', () => {
    const { parked, reg } = parkedGame();
    const result = applyAction(
      parked,
      { kind: 'answerChoice', player: 'A', choiceId: parked.pendingChoice!.id, answer: { kind: 'confirm', yes: true } },
      DEFAULT_RULES,
      reg,
    );
    expect(result.events.some((e) => e.type === 'actionRejected')).toBe(true);
    expect(result.state).not.toBe(parked);
    expect(result.state.pendingChoice).not.toBe(parked.pendingChoice);
    expect(result.state.pendingChoice?.id).toBe(parked.pendingChoice!.id);
  });

  it('cloneState deep-copies the choice and the suspended frame (no shared references)', () => {
    const { parked } = parkedGame();
    const copy = cloneState(parked);

    expect(copy.pendingChoice).not.toBe(parked.pendingChoice);
    expect(copy.pendingChoice).toEqual(parked.pendingChoice);
    expect(copy.resolution).not.toBe(parked.resolution);
    expect(copy.resolution!.effects).not.toBe(parked.resolution!.effects);
    expect(copy.resolution!.answers).not.toBe(parked.resolution!.answers);
    const original = parked.pendingChoice!;
    const cloned = copy.pendingChoice!;
    if (original.kind === 'chooseModes' && cloned.kind === 'chooseModes') {
      expect(cloned.modes).not.toBe(original.modes);
      expect(cloned.modes[0]).not.toBe(original.modes[0]);
    }
  });

  it('the answer stored in state and in the log does not alias the caller\'s action', () => {
    const { parked, reg } = parkedGame();
    const modeIds = ['draw', 'burn'];
    const action: GameAction = {
      kind: 'answerChoice',
      player: 'A',
      choiceId: parked.pendingChoice!.id,
      answer: { kind: 'chooseModes', modeIds },
    };
    const result = applyAction(parked, action, DEFAULT_RULES, reg);
    const logged = result.events.find((e) => e.type === 'choiceAnswered') as
      | Extract<GameEvent, { type: 'choiceAnswered' }>
      | undefined;
    expect(logged).toBeTruthy();
    expect(logged!.answer.kind === 'chooseModes' && logged!.answer.modeIds).not.toBe(modeIds);
    expect(logged!.answer).toEqual({ kind: 'chooseModes', modeIds: ['draw', 'burn'] });
  });

  it('same seed ⇒ identical choices and identical final state', () => {
    // A scripted driver: pick a legal action with a seeded RNG, so the whole game —
    // including every answer to every question — is a pure function of the seed.
    const play = (seed: number): { events: string; final: string } => {
      const reg = choiceRegistry();
      let state = gameAtMain(reg, seed);
      state.players.A.hand = [];
      giveHand(state, 'A', [BRAINSTORM, CRYPTIC, MAY_DRAW, SEARCH, THOUGHTSEIZE]);
      giveHand(state, 'B', [BEAR, OGRE]);
      const rng = createRng(seed);
      const log: GameEvent[] = [];
      for (let i = 0; i < 300 && !state.gameOver; i++) {
        const legal = generateLegalActions(state);
        if (legal.length === 0) break;
        const chosen = legal[rng.nextInt(legal.length)] as GameAction;
        const result = applyAction(state, chosen, DEFAULT_RULES, reg);
        state = result.state;
        log.push(...result.events);
      }
      return { events: JSON.stringify(log), final: JSON.stringify(serializeState(state)) };
    };

    const first = play(1234);
    expect(play(1234)).toEqual(first);
    expect(play(9876).events).not.toBe(first.events);
  });

  it('a game full of choice cards still terminates (never a state with no legal action)', () => {
    const reg = choiceRegistry();
    let state = gameAtMain(reg);
    giveHand(state, 'A', [BRAINSTORM, CRYPTIC, MAY_DRAW, SEARCH, THOUGHTSEIZE]);
    giveHand(state, 'B', [BRAINSTORM, CRYPTIC, THOUGHTSEIZE, BEAR]);
    const rng = createRng(7);

    let steps = 0;
    const MAX_STEPS = 4000;
    while (!state.gameOver && steps < MAX_STEPS) {
      const legal = generateLegalActions(state);
      // The invariant that makes hanging impossible: there is ALWAYS a move.
      expect(legal.length).toBeGreaterThan(0);
      state = applyAction(state, legal[rng.nextInt(legal.length)] as GameAction, DEFAULT_RULES, reg).state;
      steps++;
    }
    expect(state.gameOver).toBe(true);
    expect(state.pendingChoice ?? null).toBeNull();
  });
});

describe('robustness', () => {
  function parkedConfirm(): { parked: GameState; reg: EffectRegistry } {
    const reg = choiceRegistry();
    const state = gameAtMain(reg);
    state.players.A.hand = [];
    const [spell] = giveHand(state, 'A', [MAY_DRAW]);
    return { parked: castAndResolve(state, (spell as { instanceId: InstanceId }).instanceId, reg), reg };
  }

  it('rejects a stale answer (right shape, wrong choice id)', () => {
    const { parked, reg } = parkedConfirm();
    const result = applyAction(
      parked,
      { kind: 'answerChoice', player: 'A', choiceId: parked.pendingChoice!.id + 1, answer: { kind: 'confirm', yes: true } },
      DEFAULT_RULES,
      reg,
    );
    expect(result.events.some((e) => e.type === 'actionRejected')).toBe(true);
    expect(result.state.pendingChoice?.id).toBe(parked.pendingChoice!.id);
  });

  it('rejects a malformed answer without corrupting state', () => {
    const { parked, reg } = parkedConfirm();
    const result = applyAction(
      parked,
      { kind: 'answerChoice', player: 'A', choiceId: parked.pendingChoice!.id, answer: { kind: 'confirm', yes: 'maybe' } as never },
      DEFAULT_RULES,
      reg,
    );
    expect(result.events.some((e) => e.type === 'actionRejected')).toBe(true);
    expect(JSON.stringify(serializeState(result.state))).toBe(JSON.stringify(serializeState(parked)));
  });

  it('freezes every other action while a choice is parked', () => {
    const { parked, reg } = parkedConfirm();
    for (const action of [
      { kind: 'passPriority', player: 'A' } as GameAction,
      { kind: 'passPriority', player: 'B' } as GameAction,
      { kind: 'declareAttackers', player: 'A', attackers: [] } as GameAction,
    ]) {
      const result = applyAction(parked, action, DEFAULT_RULES, reg);
      expect(result.events.some((e) => e.type === 'actionRejected')).toBe(true);
      expect(result.state.pendingChoice?.id).toBe(parked.pendingChoice!.id);
    }
  });

  it('degrades an unknown choice kind to an event instead of crashing or hanging', () => {
    const reg = choiceRegistry();
    const state = gameAtMain(reg);
    state.players.A.hand = [];
    const card = freeInstant('Mind Reader', [{ primitive: 'asksUnknownKind' }, { primitive: 'gainLife', params: { amount: 4 } }]);
    const [spell] = giveHand(state, 'A', [card]);
    const lifeBefore = state.players.A.life;

    const done = castAndResolve(state, (spell as { instanceId: InstanceId }).instanceId, reg);

    expect(done.pendingChoice ?? null).toBeNull();
    expect(names(done.players.A.graveyard)).toContain('Mind Reader');
    // The unrepresentable question was abandoned; the REST of the card still ran.
    expect(done.players.A.life).toBe(lifeBefore + 4);
  });

  it('cuts off a primitive that asks without end, rather than wedging the game', () => {
    const reg = choiceRegistry();
    let state = gameAtMain(reg);
    state.players.A.hand = [];
    const card = freeInstant('Endless Question', [{ primitive: 'asksForever' }]);
    const [spell] = giveHand(state, 'A', [card]);
    state = castAndResolve(state, (spell as { instanceId: InstanceId }).instanceId, reg);

    // Answer whatever it asks; the engine's per-resolution budget ends it.
    let guard = 0;
    while (state.pendingChoice && guard++ < 200) {
      state = answer(state, reg, { kind: 'confirm', yes: true });
    }
    expect(state.pendingChoice ?? null).toBeNull();
    expect(guard).toBeLessThan(200);
    expect(names(state.players.A.graveyard)).toContain('Endless Question');
  });

  it('resolves safely when the chosen card has already left the zone', () => {
    // The victim names a card, but by the time the effect looks it is gone. The
    // primitive skips it; the resolution still completes cleanly.
    const reg = choiceRegistry();
    const state = gameAtMain(reg);
    state.players.A.hand = [];
    state.players.B.hand = [];
    giveHand(state, 'B', [BEAR, OGRE]);
    const [spell] = giveHand(state, 'A', [THOUGHTSEIZE]);
    const parked = castAndResolve(state, (spell as { instanceId: InstanceId }).instanceId, reg);
    const choice = parked.pendingChoice!;
    const bear = choice.kind === 'selectCards' ? choice.candidates.find((c) => c.name === 'Bear')!.instanceId : 0;

    // Simulate the card vanishing between question and answer.
    const tampered = cloneState(parked);
    tampered.players.B.hand = tampered.players.B.hand.filter((c) => c.instanceId !== bear);

    const done = act(
      tampered,
      { kind: 'answerChoice', player: 'B', choiceId: choice.id, answer: { kind: 'selectCards', instanceIds: [bear] } },
      reg,
    );
    expect(done.pendingChoice ?? null).toBeNull();
    expect(done.players.B.graveyard).toHaveLength(0);
    expect(names(done.players.A.graveyard)).toContain('Thoughtseize');
  });

  it('logs both halves of every choice for the replay/inspector', () => {
    const reg = choiceRegistry();
    const state = gameAtMain(reg);
    state.players.A.hand = [];
    const [spell] = giveHand(state, 'A', [MAY_DRAW]);
    const cast = act(state, { kind: 'castSpell', player: 'A', instanceId: (spell as { instanceId: InstanceId }).instanceId }, reg);
    const afterA = applyAction(cast, { kind: 'passPriority', player: 'A' }, DEFAULT_RULES, reg);
    const parkedResult = applyAction(afterA.state, { kind: 'passPriority', player: 'B' }, DEFAULT_RULES, reg);

    const asked = parkedResult.events.find((e) => e.type === 'choiceAsked') as
      | Extract<GameEvent, { type: 'choiceAsked' }>
      | undefined;
    expect(asked).toBeTruthy();
    expect(asked!.chooser).toBe('A');
    expect(asked!.choiceKind).toBe('confirm');
    expect(asked!.optionCount).toBe(2);

    const answered = applyAction(
      parkedResult.state,
      { kind: 'answerChoice', player: 'A', choiceId: asked!.choiceId, answer: { kind: 'confirm', yes: true } },
      DEFAULT_RULES,
      reg,
    );
    const answerEvent = answered.events.find((e) => e.type === 'choiceAnswered') as
      | Extract<GameEvent, { type: 'choiceAnswered' }>
      | undefined;
    expect(answerEvent).toBeTruthy();
    expect(answerEvent!.choiceId).toBe(asked!.choiceId);
    expect(answerEvent!.summary).toBe('yes');
  });

  it('surfaces the parked question in the inspector dump', () => {
    const reg = choiceRegistry();
    const state = gameAtMain(reg);
    state.players.A.hand = [];
    const [spell] = giveHand(state, 'A', [MAY_DRAW]);
    const parked = castAndResolve(state, (spell as { instanceId: InstanceId }).instanceId, reg);

    expect(serializeState(parked).pendingChoice?.chooser).toBe('A');
    expect(dumpState(parked)).toContain('awaiting confirm from A');
  });

  it('a choice-free game never touches the choice fields at all', () => {
    // The performance claim, asserted rather than asserted-at: nothing about the
    // machinery switches on unless a card actually asks something.
    const reg = choiceRegistry();
    let state = gameAtMain(reg);
    giveHand(state, 'A', [BEAR, OGRE]);
    const rng = createRng(11);
    for (let i = 0; i < 400 && !state.gameOver; i++) {
      const legal = generateLegalActions(state);
      if (legal.length === 0) break;
      state = applyAction(state, legal[rng.nextInt(legal.length)] as GameAction, DEFAULT_RULES, reg).state;
      expect(state.pendingChoice ?? null).toBeNull();
      expect(state.resolution ?? null).toBeNull();
    }
  });
});

describe('who answers is enforced across both seats', () => {
  it('the same primitive puts the question to whichever seat cast it', () => {
    const reg = choiceRegistry();
    let state = gameAtMain(reg);
    state.players.A.hand = [];
    state.players.B.hand = [];
    giveHand(state, 'A', [BEAR, OGRE]);
    const [spell] = giveHand(state, 'B', [THOUGHTSEIZE]);

    // B casts it at instant speed during A's main phase; A must choose.
    state = act(state, { kind: 'passPriority', player: 'A' }, reg);
    state = act(state, { kind: 'castSpell', player: 'B', instanceId: (spell as { instanceId: InstanceId }).instanceId }, reg);
    state = pass(state, reg);
    state = pass(state, reg);

    expect(state.pendingChoice!.chooser).toBe('A');
    expect(state.priorityPlayer).toBe('A');
    const done = answer(state, reg, {
      kind: 'selectCards',
      instanceIds: [state.pendingChoice!.kind === 'selectCards' ? state.pendingChoice!.candidates[0]!.instanceId : 0],
    });
    expect(done.players.A.graveyard).toHaveLength(1);
    // Priority went back to the ACTIVE player (A), not to the caster.
    expect(done.priorityPlayer).toBe(done.activePlayer);
  });
});

/**
 * Pilots answering player CHOICES.
 *
 * Two things have to be true for the choice system to be usable by the sim, and
 * both are asserted here. First, a pilot must ALWAYS have an answer — an
 * unanswered choice would hang a headless game, so every pilot answers every kind
 * from every position. Second, the answers must be sensible and DETERMINISTIC:
 * the lab's whole premise is that a win-rate delta means something, which it does
 * not if the AI throws away its best card or picks differently on a replay.
 *
 * The fixtures are inline card definitions again (the `ai` package may not depend
 * on `@jonny-boi/cards`), built from small primitives that ask through the choice
 * API — the same shapes as Brainstorm, Thoughtseize and a modal spell.
 */

import { describe, expect, it } from 'vitest';
import {
  applyAction,
  collectCardOptions,
  createGame,
  createRng,
  DEFAULT_RULES,
  generateLegalActions,
  normalizeChoiceRequest,
  opponentOf,
  serializeState,
  validateChoiceAnswer,
  type CardDefinition,
  type ChoiceRequest,
  type EffectContext,
  type EffectRegistry,
  type GameAction,
  type GameState,
  type InstanceId,
  type PendingChoice,
} from '@jonny-boi/core';
import { createEffectRegistry } from '@jonny-boi/core';
import type { EffectRef, ResolutionFrame } from '@jonny-boi/core';
import { answerChoiceHeuristically, cardValue, cardValueContext, safeFallbackAction } from './choices.js';
import { resolutionValueContext, valueOfEffects } from './effect-value.js';
import { createHeuristicPilot } from './heuristic.js';
import { createMctsPilot } from './mcts.js';
import { FAST_MCTS_CONFIG } from './mcts-config.js';
import { createRandomPilot } from './random.js';
import { DEFAULT_HEURISTIC_WEIGHTS } from './weights.js';
import { creatureDef, giveHand, landDef, putOnBattlefield, putOnStack } from './test-support.js';

const WEIGHTS = DEFAULT_HEURISTIC_WEIGHTS;
const SOURCE = { id: 7, sourceInstanceId: 1, sourceName: 'Test Card' };

/** Normalise a request the way the engine does, so tests see real parked choices. */
function park(request: ChoiceRequest): PendingChoice {
  const choice = normalizeChoiceRequest(request, SOURCE);
  if (!choice) throw new Error('expected a normalised choice');
  return choice;
}

// --- fixture cards ------------------------------------------------------------------

function choiceRegistry(): EffectRegistry {
  const reg = createEffectRegistry();
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
  reg.register('gainLife', (ctx: EffectContext) => {
    const amount = (ctx.params.amount as number | undefined) ?? 1;
    ctx.state.players[ctx.controller].life += amount;
    ctx.emit({ type: 'gainLife', player: ctx.controller, amount });
  });
  /** The opponent names one of their own nonland cards to discard. */
  reg.register('opponentDiscardsChosen', (ctx: EffectContext) => {
    const victim = opponentOf(ctx.controller);
    const chosen = ctx.chooseCards({
      chooser: victim,
      prompt: 'Choose a nonland card to discard',
      candidates: collectCardOptions(ctx.state, 'hand', { controller: victim, filter: { noneOfTypes: ['land'] } }),
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
  /** A "you may" whose payoff is drawing a card. */
  reg.register('mayDraw', (ctx: EffectContext) => {
    const yes = ctx.confirm({ prompt: 'You may draw a card', valence: 'gain' });
    if (yes === undefined) return;
    if (!yes) return;
    ctx.enqueueEffects([{ primitive: 'drawCards', params: { count: 1 } }]);
  });
  /** Choose N of the listed modes and run them. */
  reg.register('modal', (ctx: EffectContext) => {
    const modes = (ctx.params.modes as ReadonlyArray<{ id: string; label: string; effects: CardDefinition['effects'] }>) ?? [];
    const count = (ctx.params.count as number | undefined) ?? 1;
    const chosen = ctx.chooseModes({
      prompt: 'Choose two —',
      modes: modes.map((m) => ({ id: m.id, label: m.label })),
      min: count,
      max: count,
      valence: 'gain',
    });
    if (!chosen) return;
    ctx.enqueueEffects(chosen.flatMap((id) => modes.find((m) => m.id === id)?.effects ?? []));
  });
  return reg;
}

function freeInstant(id: string, effects: CardDefinition['effects']): CardDefinition {
  return { id, name: id, types: ['instant'], timing: 'instant', effects };
}

const DISCARD_SPELL = freeInstant('Thoughtseize', [{ primitive: 'opponentDiscardsChosen' }]);
const MAY_SPELL = freeInstant('Optional Insight', [{ primitive: 'mayDraw' }]);
const MODAL_SPELL = freeInstant('Cryptic Command', [
  {
    primitive: 'modal',
    params: {
      count: 2,
      modes: [
        { id: 'draw', label: 'Draw', effects: [{ primitive: 'drawCards', params: { count: 1 } }] },
        { id: 'life', label: 'Gain 3 life', effects: [{ primitive: 'gainLife', params: { amount: 3 } }] },
        { id: 'draw2', label: 'Draw again', effects: [{ primitive: 'drawCards', params: { count: 1 } }] },
      ],
    },
  },
]);

const ISLAND = landDef('Island', 'U');
const BEAR = creatureDef('Bear', 2, 2);
const DRAGON = creatureDef('Dragon', 6, 6, { cost: { generic: 6 } });

// --- card ranking ---------------------------------------------------------------------

describe('card ranking (what "my best / my worst card" means)', () => {
  function instances(state: GameState, defs: readonly CardDefinition[]) {
    return giveHand(state, 'A', defs);
  }

  it('ranks a big creature over a small one, and both over a land', () => {
    const state = newGame().state;
    const [dragon, bear, island] = instances(state, [DRAGON, BEAR, ISLAND]);
    expect(cardValue(dragon, WEIGHTS)).toBeGreaterThan(cardValue(bear, WEIGHTS));
    expect(cardValue(bear, WEIGHTS)).toBeGreaterThan(cardValue(island, WEIGHTS));
  });

  it('scores an unknown/vanished card as zero rather than throwing', () => {
    expect(cardValue(undefined, WEIGHTS)).toBe(0);
  });
});

// --- answering each kind ----------------------------------------------------------------

describe('the heuristic answers every choice kind sensibly', () => {
  function handChoice(valence: 'gain' | 'loss' | 'neutral', min = 1, max = min, ordered = false) {
    const state = newGame().state;
    state.players.A.hand = [];
    // A BUILT mana base, which is what makes "the land is the worst card in hand"
    // true. (Short of mana the ranking deliberately inverts — see the board-aware
    // ranking tests below.)
    putOnBattlefield(state, 'A', Array.from({ length: WEIGHTS.choiceLandsWanted }, () => ISLAND));
    const cards = giveHand(state, 'A', [BEAR, ISLAND, DRAGON]);
    const choice = park({
      kind: 'selectCards',
      chooser: 'A',
      prompt: 'pick',
      candidates: collectCardOptions(state, 'hand', { controller: 'A' }),
      min,
      max,
      ordered,
      valence,
    });
    return { state, choice, cards };
  }

  it('gives up its WORST card when being selected is a loss (a discard)', () => {
    const { state, choice } = handChoice('loss');
    const action = answerChoiceHeuristically(state, choice, WEIGHTS);
    expect(action.kind).toBe('answerChoice');
    if (action.kind !== 'answerChoice' || action.answer.kind !== 'selectCards') throw new Error('wrong shape');
    const picked = action.answer.instanceIds[0];
    expect(state.players.A.hand.find((c) => c.instanceId === picked)!.def.name).toBe('Island');
  });

  it('takes its BEST card when being selected is a gain (a graveyard return)', () => {
    const { state, choice } = handChoice('gain');
    const action = answerChoiceHeuristically(state, choice, WEIGHTS);
    if (action.kind !== 'answerChoice' || action.answer.kind !== 'selectCards') throw new Error('wrong shape');
    expect(state.players.A.hand.find((c) => c.instanceId === action.answer.instanceIds[0])!.def.name).toBe('Dragon');
  });

  it('takes as many as allowed on a gain, and as few as allowed on a loss', () => {
    const gain = handChoice('gain', 0, 3);
    const gainAction = answerChoiceHeuristically(gain.state, gain.choice, WEIGHTS);
    if (gainAction.kind !== 'answerChoice' || gainAction.answer.kind !== 'selectCards') throw new Error('wrong shape');
    expect(gainAction.answer.instanceIds).toHaveLength(3);

    const loss = handChoice('loss', 0, 3);
    const lossAction = answerChoiceHeuristically(loss.state, loss.choice, WEIGHTS);
    if (lossAction.kind !== 'answerChoice' || lossAction.answer.kind !== 'selectCards') throw new Error('wrong shape');
    expect(lossAction.answer.instanceIds).toHaveLength(0);
  });

  it('orders an ORDERED answer best-first (the card seen soonest is the good one)', () => {
    const { state, choice } = handChoice('loss', 2, 2, true);
    const action = answerChoiceHeuristically(state, choice, WEIGHTS);
    if (action.kind !== 'answerChoice' || action.answer.kind !== 'selectCards') throw new Error('wrong shape');
    const picked = action.answer.instanceIds.map((id) => state.players.A.hand.find((c) => c.instanceId === id)!.def.name);
    // Two worst cards go back (Bear + Island), best of those two first.
    expect(picked).toEqual(['Bear', 'Island']);
  });

  it('points a "loss" player choice at the opponent and a "gain" at itself', () => {
    const state = newGame().state;
    const loss = park({ kind: 'selectPlayers', chooser: 'A', prompt: 'who', candidates: ['A', 'B'], valence: 'loss' });
    const gain = park({ kind: 'selectPlayers', chooser: 'A', prompt: 'who', candidates: ['A', 'B'], valence: 'gain' });
    const lossAction = answerChoiceHeuristically(state, loss, WEIGHTS);
    const gainAction = answerChoiceHeuristically(state, gain, WEIGHTS);
    if (lossAction.kind !== 'answerChoice' || lossAction.answer.kind !== 'selectPlayers') throw new Error('wrong shape');
    if (gainAction.kind !== 'answerChoice' || gainAction.answer.kind !== 'selectPlayers') throw new Error('wrong shape');
    expect(lossAction.answer.players).toEqual(['B']);
    expect(gainAction.answer.players).toEqual(['A']);
  });

  it('takes the full allowance of modes', () => {
    const state = newGame().state;
    const choice = park({
      kind: 'chooseModes',
      chooser: 'A',
      prompt: 'choose two',
      modes: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }, { id: 'c', label: 'C' }],
      max: 2,
      valence: 'gain',
    });
    const action = answerChoiceHeuristically(state, choice, WEIGHTS);
    if (action.kind !== 'answerChoice' || action.answer.kind !== 'chooseModes') throw new Error('wrong shape');
    expect(action.answer.modeIds).toHaveLength(2);
    expect(validateChoiceAnswer(choice, action.answer).ok).toBe(true);
  });

  it('accepts a "you may" that helps it and declines one that costs it', () => {
    const state = newGame().state;
    const yes = answerChoiceHeuristically(state, park({ kind: 'confirm', chooser: 'A', prompt: '?', valence: 'gain' }), WEIGHTS);
    const no = answerChoiceHeuristically(state, park({ kind: 'confirm', chooser: 'A', prompt: '?', valence: 'loss' }), WEIGHTS);
    if (yes.kind !== 'answerChoice' || yes.answer.kind !== 'confirm') throw new Error('wrong shape');
    if (no.kind !== 'answerChoice' || no.answer.kind !== 'confirm') throw new Error('wrong shape');
    expect(yes.answer.yes).toBe(true);
    expect(no.answer.yes).toBe(false);
  });

  it('pays a tax that keeps its own spell, and never one it cannot afford', () => {
    const state = newGame().state;
    const payable = park({
      kind: 'payMana',
      chooser: 'A',
      prompt: 'Pay {3}',
      cost: { generic: 3 },
      affordable: true,
      valence: 'gain',
    });
    const broke = park({
      kind: 'payMana',
      chooser: 'A',
      prompt: 'Pay {3}',
      cost: { generic: 3 },
      affordable: false,
      valence: 'gain',
    });

    const paid = answerChoiceHeuristically(state, payable, WEIGHTS);
    const declined = answerChoiceHeuristically(state, broke, WEIGHTS);
    if (paid.kind !== 'answerChoice' || paid.answer.kind !== 'payMana') throw new Error('wrong shape');
    if (declined.kind !== 'answerChoice' || declined.answer.kind !== 'payMana') throw new Error('wrong shape');
    expect(paid.answer.pay).toBe(true);
    expect(declined.answer.pay).toBe(false);
    // Both must be answers the ENGINE would accept — "pay" is illegal when the
    // board cannot produce the cost, so this is the property, not the preference.
    expect(validateChoiceAnswer(payable, paid.answer).ok).toBe(true);
    expect(validateChoiceAnswer(broke, declined.answer).ok).toBe(true);
  });

  it('declines a payment somebody else is making it consider (a "loss" valence)', () => {
    const state = newGame().state;
    const choice = park({
      kind: 'payMana',
      chooser: 'A',
      prompt: 'Pay {1}',
      cost: { generic: 1 },
      affordable: true,
      valence: 'loss',
    });
    const action = answerChoiceHeuristically(state, choice, WEIGHTS);
    if (action.kind !== 'answerChoice' || action.answer.kind !== 'payMana') throw new Error('wrong shape');
    expect(action.answer.pay).toBe(false);
  });

  it('always addresses the answer to the choice\'s own chooser, never itself', () => {
    const state = newGame().state;
    state.players.B.hand = [];
    giveHand(state, 'B', [BEAR, DRAGON]);
    const choice = park({
      kind: 'selectCards',
      chooser: 'B',
      prompt: 'discard',
      candidates: collectCardOptions(state, 'hand', { controller: 'B' }),
      valence: 'loss',
    });
    const action = answerChoiceHeuristically(state, choice, WEIGHTS);
    expect(action.kind === 'answerChoice' && action.player).toBe('B');
    expect(action.kind === 'answerChoice' && action.choiceId).toBe(choice.id);
  });

  it('produces a LEGAL answer for every shape it can be handed', () => {
    const state = newGame().state;
    state.players.A.hand = [];
    giveHand(state, 'A', [BEAR, ISLAND, DRAGON, BEAR]);
    const candidates = collectCardOptions(state, 'hand', { controller: 'A' });
    for (const valence of ['gain', 'loss', 'neutral'] as const) {
      for (let min = 0; min <= 4; min++) {
        for (let max = min; max <= 4; max++) {
          for (const ordered of [false, true]) {
            const choice = park({ kind: 'selectCards', chooser: 'A', prompt: 'p', candidates, min, max, ordered, valence });
            const action = answerChoiceHeuristically(state, choice, WEIGHTS);
            if (action.kind !== 'answerChoice') throw new Error('wrong shape');
            expect(validateChoiceAnswer(choice, action.answer).ok).toBe(true);
          }
        }
      }
    }
  });
});

// --- modal spells: the pilot EVALUATES each mode ------------------------------------

/**
 * Cryptic Command's real four modes, authored exactly as the pool authors them
 * (registered primitive ids + params). The pilot must reach the right pick from
 * this data alone — it has no idea what "Cryptic Command" is.
 */
const CRYPTIC_MODES = [
  { id: 'counter', label: 'Counter target spell', effects: [{ primitive: 'counterSpell' }] },
  {
    id: 'bounce',
    label: "Return target permanent to its owner's hand",
    effects: [{ primitive: 'returnToHand' }],
  },
  {
    id: 'tapAll',
    label: 'Tap all creatures your opponents control',
    effects: [{ primitive: 'tapPermanents', params: { who: 'opponent', types: ['creature'] } }],
  },
  { id: 'draw', label: 'Draw a card', effects: [{ primitive: 'drawCards', params: { count: 1 } }] },
] as const;

const CRYPTIC_DEF: CardDefinition = freeInstant('Cryptic Command', [
  { primitive: 'modal', params: { count: 2, modes: CRYPTIC_MODES } },
]);

/**
 * Park a modal spell mid-resolution: the suspended frame carries the `modal` ref
 * (with its authored modes) and the targets the cast locked in, exactly as the
 * engine leaves it while the chooser is on the clock.
 */
function parkModal(
  state: GameState,
  opts: {
    readonly offer: readonly string[];
    readonly targets?: readonly (InstanceId | 'A' | 'B')[];
    /** A real modal spell says "choose exactly N", so `count` sets both bounds. */
    readonly count?: number;
    readonly min?: number;
    readonly max?: number;
    readonly valence?: 'gain' | 'loss' | 'neutral';
  },
): PendingChoice {
  const [card] = giveHand(state, 'A', [CRYPTIC_DEF]);
  const modalRef = (CRYPTIC_DEF.effects as readonly EffectRef[])[0] as EffectRef;
  const frame: ResolutionFrame = {
    origin: 'spell',
    controller: 'A',
    targets: [...(opts.targets ?? [])],
    effects: [modalRef],
    next: 0,
    answers: [],
    askCount: 0,
    card: card!,
    resolvesTo: 'graveyard',
  };
  state.resolution = frame;
  const count = opts.count ?? 2;
  const choice = park({
    kind: 'chooseModes',
    chooser: 'A',
    prompt: 'Choose two —',
    modes: CRYPTIC_MODES.filter((m) => opts.offer.includes(m.id)).map((m) => ({ id: m.id, label: m.label })),
    min: opts.min ?? count,
    max: opts.max ?? count,
    valence: opts.valence ?? 'gain',
  });
  state.pendingChoice = choice;
  return choice;
}

/** The mode ids the pilot picks for a parked modal choice. */
function chosenModes(state: GameState, choice: PendingChoice): readonly string[] {
  const action = answerChoiceHeuristically(state, choice, WEIGHTS);
  if (action.kind !== 'answerChoice' || action.answer.kind !== 'chooseModes') throw new Error('wrong shape');
  expect(validateChoiceAnswer(choice, action.answer).ok).toBe(true);
  return action.answer.modeIds;
}

describe('what a SOFT counter is worth ("unless its controller pays {3}")', () => {
  /** Price one effect ref against a board where B is casting a Dragon. */
  function priceAgainstDragon(ref: EffectRef, bLands: number): number {
    const state = newGame().state;
    const dragon = putOnStack(state, 'B', DRAGON);
    putOnBattlefield(state, 'B', Array.from({ length: bLands }, () => ISLAND));
    const context = resolutionValueContext(state, 'A', WEIGHTS, cardValueContext(state));
    return valueOfEffects([ref], { ...context, targets: [dragon.instanceId] });
  }

  const SOFT: EffectRef = { primitive: 'counterUnlessPaid', params: { unlessPaid: { generic: 3 } } };
  const HARD: EffectRef = { primitive: 'counterSpell' };

  it('is worth a full counter against a player who cannot pay the tax', () => {
    expect(priceAgainstDragon(SOFT, 2)).toBe(priceAgainstDragon(HARD, 2));
  });

  it('is worth LESS than a hard counter against a player who can', () => {
    const soft = priceAgainstDragon(SOFT, 5);
    const hard = priceAgainstDragon(HARD, 5);
    expect(soft).toBeLessThan(hard);
    // Still worth something — paying strips them of three mana.
    expect(soft).toBeGreaterThan(0);
    expect(soft).toBeCloseTo(hard * WEIGHTS.softCounterPayableFactor);
  });

  it('is a mistake to point at your OWN spell, exactly like a hard counter', () => {
    const state = newGame().state;
    const own = putOnStack(state, 'A', DRAGON);
    const context = resolutionValueContext(state, 'A', WEIGHTS, cardValueContext(state));
    expect(valueOfEffects([SOFT], { ...context, targets: [own.instanceId] })).toBeLessThan(0);
  });
});

describe('choosing modal-spell modes (scripted positions)', () => {
  it('DRAWS instead of bouncing a permanent that is not worth bouncing', () => {
    // The old pilot took the first two printed modes and bounced a Forest while
    // never drawing a card. Here: a land is the only bounce target, and the
    // opponent has a board worth tapping — so the two real modes are tap + draw.
    const state = newGame().state;
    const [forest] = putOnBattlefield(state, 'B', [landDef('Forest', 'G')]);
    putOnBattlefield(state, 'B', [BEAR, BEAR]);
    const choice = parkModal(state, { offer: ['bounce', 'tapAll', 'draw'], targets: [forest!.instanceId] });
    const picked = chosenModes(state, choice);
    expect(picked).toContain('draw');
    expect(picked).not.toContain('bounce');
  });

  it('BOUNCES instead of drawing when the target is a real threat', () => {
    const state = newGame().state;
    const [angel] = putOnBattlefield(state, 'B', [creatureDef('Serra Angel', 4, 4, { cost: { generic: 3, W: 2 } })]);
    const choice = parkModal(state, { offer: ['bounce', 'tapAll', 'draw'], targets: [angel!.instanceId] });
    expect(chosenModes(state, choice)).toEqual(['bounce', 'draw']);
  });

  it('COUNTERS the opponent’s spell and still draws (never bounces nothing)', () => {
    const state = newGame().state;
    const dragon = putOnStack(state, 'B', DRAGON);
    const choice = parkModal(state, { offer: ['counter', 'tapAll', 'draw'], targets: [dragon.instanceId] });
    expect(chosenModes(state, choice)).toEqual(['counter', 'draw']);
  });

  it('never points a mode at its OWN board', () => {
    const state = newGame().state;
    const [mine] = putOnBattlefield(state, 'A', [creatureDef('My Angel', 4, 4, { cost: { generic: 3, W: 2 } })]);
    putOnBattlefield(state, 'B', [BEAR, BEAR]);
    const choice = parkModal(state, { offer: ['bounce', 'tapAll', 'draw'], targets: [mine!.instanceId] });
    const picked = chosenModes(state, choice);
    expect(picked).not.toContain('bounce');
    expect(picked).toEqual(['tapAll', 'draw']);
  });

  it('never counters its OWN spell', () => {
    const state = newGame().state;
    const own = putOnStack(state, 'A', DRAGON);
    putOnBattlefield(state, 'B', [BEAR]);
    const choice = parkModal(state, { offer: ['counter', 'tapAll', 'draw'], targets: [own.instanceId] });
    expect(chosenModes(state, choice)).toEqual(['tapAll', 'draw']);
  });

  it('refuses to draw off a library that cannot pay (decking itself)', () => {
    const state = newGame().state;
    state.players.A.library = [];
    putOnBattlefield(state, 'B', [BEAR]);
    const choice = parkModal(state, { offer: ['tapAll', 'draw'], targets: [], count: 1 });
    expect(chosenModes(state, choice)).toEqual(['tapAll']);
  });

  it('takes FEWER modes than allowed when the extra ones would do nothing at all', () => {
    // Nothing on either board and nothing targeted: only "draw" does anything, so a
    // "choose up to two" takes exactly the one mode that is real.
    const state = newGame().state;
    const choice = parkModal(state, { offer: ['bounce', 'tapAll', 'draw'], min: 0, max: 2 });
    expect(chosenModes(state, choice)).toEqual(['draw']);
  });

  it('still names the required number of modes when every mode is bad', () => {
    const state = newGame().state;
    state.players.A.library = [];
    const [mine] = putOnBattlefield(state, 'A', [BEAR]);
    const choice = parkModal(state, { offer: ['bounce', 'draw'], targets: [mine!.instanceId], count: 2 });
    expect(chosenModes(state, choice)).toHaveLength(2);
  });

  it('on a LOSS valence it picks the WORST modes, and as few as allowed', () => {
    const state = newGame().state;
    const [angel] = putOnBattlefield(state, 'B', [creatureDef('Serra Angel', 4, 4, { cost: { generic: 3, W: 2 } })]);
    const choice = parkModal(state, {
      offer: ['bounce', 'tapAll', 'draw'],
      targets: [angel!.instanceId],
      count: 1,
      valence: 'loss',
    });
    // Tapping an already-untapped-but-worthless board is the emptiest of the three
    // (the Angel is the only creature, and bouncing/drawing both do real work).
    expect(chosenModes(state, choice)).toEqual(['tapAll']);
  });

  it('is deterministic: the same position always yields the same modes', () => {
    const build = () => {
      const state = newGame().state;
      const [angel] = putOnBattlefield(state, 'B', [creatureDef('Serra Angel', 4, 4, { cost: { generic: 3, W: 2 } })]);
      return { state, choice: parkModal(state, { offer: ['bounce', 'tapAll', 'draw'], targets: [angel!.instanceId] }) };
    };
    const first = build();
    const second = build();
    expect(chosenModes(second.state, second.choice)).toEqual(chosenModes(first.state, first.choice));
  });

  it('produces a LEGAL answer for every count and valence, with or without card data', () => {
    for (const valence of ['gain', 'loss', 'neutral'] as const) {
      for (let count = 0; count <= 3; count++) {
        const state = newGame().state;
        putOnBattlefield(state, 'B', [BEAR]);
        const choice = parkModal(state, { offer: ['bounce', 'tapAll', 'draw'], count, valence });
        expect(chosenModes(state, choice).length).toBeGreaterThanOrEqual(choice.min);
        // A choice whose card data cannot be read must still answer legally.
        state.resolution = null;
        expect(chosenModes(state, choice).length).toBeGreaterThanOrEqual(choice.min);
      }
    }
  });
});

// --- the card ranking is board-aware ------------------------------------------------

describe('what "my worst card" means depends on the board', () => {
  function discardFrom(defs: readonly CardDefinition[], landsInPlay: number): string {
    const state = newGame().state;
    state.players.A.hand = [];
    if (landsInPlay > 0) putOnBattlefield(state, 'A', Array.from({ length: landsInPlay }, () => ISLAND));
    giveHand(state, 'A', defs);
    const choice = park({
      kind: 'selectCards',
      chooser: 'A',
      prompt: 'discard',
      candidates: collectCardOptions(state, 'hand', { controller: 'A' }),
      valence: 'loss',
    });
    const action = answerChoiceHeuristically(state, choice, WEIGHTS);
    if (action.kind !== 'answerChoice' || action.answer.kind !== 'selectCards') throw new Error('wrong shape');
    const picked = action.answer.instanceIds[0];
    return state.players.A.hand.find((c) => c.instanceId === picked)!.def.name;
  }

  const CHEAP_SPELL = freeInstant('Cantrip', [{ primitive: 'drawCards', params: { count: 1 } }]);

  it('keeps the land and pitches a cheap spell while still short of mana', () => {
    expect(discardFrom([ISLAND, CHEAP_SPELL, DRAGON], 0)).toBe('Cantrip');
  });

  it('pitches the land once the mana is built', () => {
    expect(discardFrom([ISLAND, CHEAP_SPELL, DRAGON], WEIGHTS.choiceLandsWanted)).toBe('Island');
  });
});

describe('safeFallbackAction', () => {
  it('answers the parked choice rather than passing (which the engine would reject)', () => {
    const state = newGame().state;
    state.pendingChoice = park({ kind: 'confirm', chooser: 'B', prompt: '?' });
    const action = safeFallbackAction(state);
    expect(action.kind).toBe('answerChoice');
    expect(action.kind === 'answerChoice' && action.player).toBe('B');
  });

  it('passes priority when no choice is parked', () => {
    const state = newGame().state;
    expect(safeFallbackAction(state).kind).toBe('passPriority');
  });
});

// --- pilots in real games ----------------------------------------------------------------

function newGame(seed = 99, reg?: EffectRegistry) {
  return createGame({
    seed,
    registry: reg,
    decks: {
      A: { cards: Array.from({ length: 30 }, () => ISLAND) },
      B: { cards: Array.from({ length: 30 }, () => ISLAND) },
    },
  });
}

/** Drive a game with the given pilot, answering everything, until it ends or caps. */
function playOut(
  pilotId: 'heuristic' | 'random',
  seed: number,
  setUp: (state: GameState) => void,
  maxSteps = 3000,
): { final: string; actions: GameAction[]; rejections: number } {
  const reg = choiceRegistry();
  const pilot = pilotId === 'heuristic' ? createHeuristicPilot() : createRandomPilot();
  const created = newGame(seed, reg);
  let state = created.state;
  setUp(state);
  const rng = createRng(seed);
  const actions: GameAction[] = [];
  let rejections = 0;
  for (let i = 0; i < maxSteps && !state.gameOver; i++) {
    const legal = generateLegalActions(state);
    // The property that makes a headless game safe: there is always a move.
    expect(legal.length).toBeGreaterThan(0);
    const action = pilot.chooseAction({ view: state, legalActions: legal, rng, registry: reg, rulesConfig: DEFAULT_RULES });
    actions.push(action);
    const result = applyAction(state, action, DEFAULT_RULES, reg);
    if (result.events.some((e) => e.type === 'actionRejected')) rejections++;
    state = result.state;
  }
  return { final: JSON.stringify(serializeState(state)), actions, rejections };
}

/** Stock both hands with the choice-asking spells. */
function stockChoiceSpells(state: GameState): void {
  giveHand(state, 'A', [DISCARD_SPELL, MAY_SPELL, MODAL_SPELL, BEAR]);
  giveHand(state, 'B', [DISCARD_SPELL, MAY_SPELL, MODAL_SPELL, DRAGON]);
}

describe('a game full of choice-asking spells', () => {
  it('never rejects an action the heuristic pilot proposes', () => {
    const run = playOut('heuristic', 4242, stockChoiceSpells);
    expect(run.rejections).toBe(0);
    expect(run.actions.some((a) => a.kind === 'answerChoice')).toBe(true);
  });

  it('never rejects an action the random pilot proposes either', () => {
    const run = playOut('random', 4242, stockChoiceSpells);
    expect(run.rejections).toBe(0);
    expect(run.actions.some((a) => a.kind === 'answerChoice')).toBe(true);
  });

  it('is deterministic for the heuristic: same seed ⇒ identical choices and final state', () => {
    const first = playOut('heuristic', 31337, stockChoiceSpells);
    const second = playOut('heuristic', 31337, stockChoiceSpells);
    expect(JSON.stringify(second.actions)).toBe(JSON.stringify(first.actions));
    expect(second.final).toBe(first.final);
  });

  it('is deterministic for the random baseline too', () => {
    const first = playOut('random', 31337, stockChoiceSpells);
    const second = playOut('random', 31337, stockChoiceSpells);
    expect(JSON.stringify(second.actions)).toBe(JSON.stringify(first.actions));
    expect(second.final).toBe(first.final);
  });

  it('terminates across several seeds with both pilots', () => {
    for (const seed of [1, 2, 3]) {
      for (const pilot of ['heuristic', 'random'] as const) {
        const run = playOut(pilot, seed, stockChoiceSpells);
        expect(run.rejections).toBe(0);
      }
    }
  });
});

/** Cast the (free) spell and pass twice, leaving the game parked on its question. */
function parkedOnDiscard(reg: EffectRegistry): GameState {
  const created = newGame(5, reg);
  let state = created.state;
  state.players.A.hand = [];
  state.players.B.hand = [];
  const [spell] = giveHand(state, 'A', [DISCARD_SPELL]);
  giveHand(state, 'B', [DRAGON, BEAR]);
  let guard = 0;
  while (state.step !== 'precombatMain' && guard++ < 50) {
    state = applyAction(state, { kind: 'passPriority', player: state.priorityPlayer }, DEFAULT_RULES, reg).state;
  }
  const id = (spell as { instanceId: InstanceId }).instanceId;
  state = applyAction(state, { kind: 'castSpell', player: 'A', instanceId: id }, DEFAULT_RULES, reg).state;
  state = applyAction(state, { kind: 'passPriority', player: 'A' }, DEFAULT_RULES, reg).state;
  return applyAction(state, { kind: 'passPriority', player: 'B' }, DEFAULT_RULES, reg).state;
}

describe('the discard a pilot actually makes', () => {
  it('the victim throws away its cheapest card, not its best', () => {
    const reg = choiceRegistry();
    const state = parkedOnDiscard(reg);
    expect(state.pendingChoice?.chooser).toBe('B');

    const action = createHeuristicPilot().chooseAction({
      view: state,
      legalActions: generateLegalActions(state),
      rng: createRng(1),
      registry: reg,
      rulesConfig: DEFAULT_RULES,
    });
    const done = applyAction(state, action, DEFAULT_RULES, reg);
    expect(done.events.some((e) => e.type === 'actionRejected')).toBe(false);
    expect(done.state.players.B.graveyard.map((c) => c.def.name)).toEqual(['Bear']);
    expect(done.state.players.B.hand.map((c) => c.def.name)).toEqual(['Dragon']);
  });

  it('the look-ahead pilot answers too — it searches answers like any other action', () => {
    const reg = choiceRegistry();
    const state = parkedOnDiscard(reg);
    // A tiny search budget: this asserts MCTS handles the decision shape, not that
    // it out-plays the heuristic (that is `mcts.test.ts`'s job).
    const pilot = createMctsPilot({ ...FAST_MCTS_CONFIG, simulationsPerDecision: 8 });
    const decide = (): GameAction =>
      pilot.chooseAction({
        view: state,
        legalActions: generateLegalActions(state),
        rng: createRng(3),
        registry: reg,
        rulesConfig: DEFAULT_RULES,
      });

    const action = decide();
    expect(action.kind).toBe('answerChoice');
    expect(action.kind === 'answerChoice' && action.player).toBe('B');
    const done = applyAction(state, action, DEFAULT_RULES, reg);
    expect(done.events.some((e) => e.type === 'actionRejected')).toBe(false);
    // Same seed, same search, same answer.
    expect(JSON.stringify(decide())).toBe(JSON.stringify(action));
  });
});

/**
 * **"As ~ enters, choose a…"** (CR 614.1c) — the value a permanent NAMES as it
 * enters, and the readers that make it a card rather than a prompt.
 *
 * The properties pinned here, ordered by how silently each would break:
 *  1. **The unasked default is "nothing named", and nothing named MATCHES
 *     NOTHING.** Every path that cannot ask — reanimation, another card's "put
 *     it onto the battlefield", a token, a hand-built fixture — records no
 *     value, and every reader (the anthem filter, the mana mode, the type line)
 *     reads that as the empty set rather than as "no filter". This is the
 *     shockland's rule applied to a naming, and getting it backwards would turn
 *     a reanimated Adaptive Automaton into an anthem over the whole board.
 *  2. **The value SURVIVES.** It is copied by `cloneState` (the sim clones per
 *     action, so a dropped field would blank the card one action later — and
 *     blank it invisibly, because "nothing named" is a legal state) and it is
 *     CLEARED when the permanent leaves, because CR 400.7 makes the returning
 *     card a new object that names again.
 *  3. **A land can owe TWO questions** — Multiversal Passage names a basic land
 *     type and then offers to pay 2 life — and only one choice can be parked at
 *     a time, so the second must not be dropped.
 *  4. **The chooser is asked at all.** A naming with two or more options is a
 *     real decision and stops the game for it; one option is not a decision, and
 *     zero settles to "nothing named" without wedging the turn.
 */

import { describe, expect, it } from 'vitest';
import {
  applyAction,
  cloneState,
  createGame,
  chosenColorOf,
  chosenSubtypeOf,
  chosenPlayerOf,
  DEFAULT_RULES,
  defaultAnswerFor,
  dumpState,
  generateLegalActions,
  isTrivialChoice,
  manaModesOf,
  matchesCardFilter,
  normalizeChoiceRequest,
  NOTHING_CHOSEN,
  permanentHasSubtype,
  staticAppliesTo,
  validateChoiceAnswer,
  type CardDefinition,
  type CardInstance,
  type ChooseValueChoice,
  type ChoiceAnswer,
  type GameAction,
  type GameState,
} from './index.js';
import { createEffectRegistry, type EffectRegistry } from './effects.js';
import { resetInstanceForNewZone } from './internal/zones.js';
import { creatureDef, deckOf, giveHand, landDef } from './test-fixtures.js';

const PLAINS = landDef('Plains', 'W');
const SEED = 0xc4fe2;

/** The printed price on the one land that names AND charges (Multiversal Passage). */
const PASSAGE_LIFE = 2;

/** Coldsteel-Heart-shaped: names a colour, taps for whatever it named. */
const COLDSTEEL_HEART: CardDefinition = {
  id: 'Coldsteel Heart',
  name: 'Coldsteel Heart',
  types: ['artifact'],
  cost: { generic: 2 },
  entersTapped: true,
  asEntersChoice: { subject: 'color' },
  manaAbilities: [{ chosenColor: true, label: 'Add one mana of the chosen color' }],
};

/** A land that names a colour — the engine's land-play asking path. */
const NAMING_LAND: CardDefinition = {
  id: 'Naming Land',
  name: 'Naming Land',
  types: ['land'],
  asEntersChoice: { subject: 'color' },
  manaAbilities: [{ chosenColor: true }],
};

/** A land that names a basic land type AND then offers to pay life, like Multiversal Passage. */
const TWO_QUESTION_LAND: CardDefinition = {
  ...NAMING_LAND,
  id: 'Two Question Land',
  name: 'Two Question Land',
  asEntersChoice: { subject: 'basicLandType' },
  entersTappedUnlessLifePaid: PASSAGE_LIFE,
};

/** Adaptive-Automaton-shaped: names a type, IS that type, pumps others of it. */
const ADAPTIVE_AUTOMATON: CardDefinition = {
  ...creatureDef('Adaptive Automaton', 2, 2, { cost: { generic: 3 } }),
  subtypes: ['construct'],
  asEntersChoice: { subject: 'creatureType' },
  isChosenSubtype: true,
  statics: [
    {
      affects: { anyOfTypes: ['creature'], controller: 'you', excludeSource: true, ofChosenSubtype: true },
      power: 1,
      toughness: 1,
      label: 'Other creatures you control of the chosen type get +1/+1',
    },
  ],
};

const GOBLIN = { ...creatureDef('Goblin Piker', 2, 1), subtypes: ['goblin'] };
const ELF = { ...creatureDef('Llanowar Elf', 1, 1), subtypes: ['elf'] };

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

function gameAtMain(reg: EffectRegistry): GameState {
  const created = createGame({
    seed: SEED,
    startingPlayer: 'A',
    registry: reg,
    decks: { A: deckOf(PLAINS, 40), B: deckOf(PLAINS, 40) },
  });
  let state = created.state;
  let guard = 0;
  while (state.step !== 'precombatMain' && !state.gameOver && guard++ < 50) state = pass(state, reg);
  state.players.A.hand = [];
  state.players.B.hand = [];
  return state;
}

function answer(state: GameState, reg: EffectRegistry, value: ChoiceAnswer): GameState {
  const choice = state.pendingChoice;
  if (!choice) throw new Error(`no choice pending:\n${dumpState(state)}`);
  return act(state, { kind: 'answerChoice', player: choice.chooser, choiceId: choice.id, answer: value }, reg);
}

function onBattlefield(state: GameState, instanceId: number): CardInstance {
  const found = state.battlefield.find((c) => c.instanceId === instanceId);
  if (!found) throw new Error(`${instanceId} is not on the battlefield\n${dumpState(state)}`);
  return found;
}

/** Play `def` as a land from A's hand; returns the state and the instance id. */
function playLand(reg: EffectRegistry, def: CardDefinition): { state: GameState; landId: number } {
  let state = gameAtMain(reg);
  const [land] = giveHand(state, 'A', [def]);
  state = act(state, { kind: 'playLand', player: 'A', instanceId: land!.instanceId }, reg);
  return { state, landId: land!.instanceId };
}

// --- 1. the unasked default -----------------------------------------------------------

describe('the unasked default: nothing named matches nothing', () => {
  /** A permanent built by hand — exactly what a reanimation or a token produces. */
  function unnamed(def: CardDefinition, instanceId = 1): CardInstance {
    return {
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
      attachedTo: null,
    };
  }

  it('an anthem from a source that named nothing reaches NOTHING, not everything', () => {
    const lord = unnamed(ADAPTIVE_AUTOMATON, 1);
    const goblin = unnamed(GOBLIN, 2);
    const ability = ADAPTIVE_AUTOMATON.statics![0]!;
    expect(lord.chosenAsEntered).toBeUndefined();
    expect(staticAppliesTo(ability, lord, goblin)).toBe(false);

    // …and the moment it DOES name that type, the same call is true. Both halves
    // matter: a filter that never matches is as wrong as one that always does.
    lord.chosenAsEntered = 'goblin';
    expect(staticAppliesTo(ability, lord, goblin)).toBe(true);
    expect(staticAppliesTo(ability, lord, unnamed(ELF, 3))).toBe(false);
  });

  it('"is the chosen type in addition to its other types" adds nothing until something is named', () => {
    const lord = unnamed(ADAPTIVE_AUTOMATON, 1);
    expect(permanentHasSubtype(lord, 'construct')).toBe(true); // printed, always
    expect(permanentHasSubtype(lord, 'goblin')).toBe(false);
    lord.chosenAsEntered = 'goblin';
    expect(permanentHasSubtype(lord, 'goblin')).toBe(true);
    // The shared card FILTER reads the same answer, which is what lets a second
    // lord see the first one as a Goblin.
    expect(matchesCardFilter(lord, { anyOfSubtypes: ['goblin'] })).toBe(true);
  });

  it('an explicitly EMPTY naming is the same as an absent one', () => {
    const lord = unnamed(ADAPTIVE_AUTOMATON, 1);
    lord.chosenAsEntered = NOTHING_CHOSEN;
    expect(chosenSubtypeOf(lord)).toBeUndefined();
    expect(permanentHasSubtype(lord, 'goblin')).toBe(false);
    expect(staticAppliesTo(ADAPTIVE_AUTOMATON.statics![0]!, lord, unnamed(GOBLIN, 2))).toBe(false);
  });

  it('a chosen-colour mana source that named nothing offers no mode at all', () => {
    const reg = createEffectRegistry();
    const state = gameAtMain(reg);
    const heart = unnamed({ ...COLDSTEEL_HEART, entersTapped: false }, 900);
    state.battlefield.push(heart);
    // The definition still declares five modes — the mode LIST is a property of
    // the definition, deliberately (see `ManaAbility.chosenColor`) — but not one
    // of them is offered on this board.
    expect(manaModesOf(heart.def)).toHaveLength(5);
    expect(generateLegalActions(state).filter((a) => a.kind === 'tapForMana')).toHaveLength(0);

    heart.chosenAsEntered = 'U';
    const offered = generateLegalActions(state).filter((a) => a.kind === 'tapForMana');
    expect(offered).toHaveLength(1);
    // …and it is the BLUE mode, not merely "a" mode.
    const blueMode = manaModesOf(heart.def).findIndex((mode) => (mode.U ?? 0) > 0);
    expect((offered[0] as { mode: number }).mode).toBe(blueMode);
  });

  it('the reader guards reject a value of the wrong shape rather than trusting it', () => {
    const lord = unnamed(ADAPTIVE_AUTOMATON, 1);
    lord.chosenAsEntered = 'goblin';
    expect(chosenColorOf(lord)).toBeUndefined();
    expect(chosenPlayerOf(lord)).toBeUndefined();
    lord.chosenAsEntered = 'B';
    expect(chosenColorOf(lord)).toBe('B');
  });
});

// --- 2. the choice kind's own contract ------------------------------------------------

describe('the chooseValue kind', () => {
  const source = { id: 7, sourceInstanceId: 1, sourceName: 'Cavern of Souls' };
  const request = {
    kind: 'chooseValue',
    chooser: 'A',
    prompt: 'name one',
    subject: 'creatureType',
    options: [
      { value: 'Goblin', label: 'Goblin' },
      { value: 'Elf', label: 'Elf' },
    ],
  } as const;

  it('names exactly one value, and naming NOTHING is always legal', () => {
    const choice = normalizeChoiceRequest(request, source) as ChooseValueChoice;
    expect(choice.min).toBe(1);
    expect(choice.max).toBe(1);
    expect(validateChoiceAnswer(choice, { kind: 'chooseValue', value: 'Goblin' }).ok).toBe(true);
    expect(validateChoiceAnswer(choice, { kind: 'chooseValue', value: NOTHING_CHOSEN }).ok).toBe(true);
    expect(validateChoiceAnswer(choice, { kind: 'chooseValue', value: 'Sliver' }).ok).toBe(false);
  });

  it('degrades to NOTHING, never to the first option', () => {
    // The whole safety argument: a degraded Cavern of Souls must not silently
    // acquire a working creature type.
    const choice = normalizeChoiceRequest(request, source) as ChooseValueChoice;
    expect(defaultAnswerFor(choice)).toEqual({ kind: 'chooseValue', value: NOTHING_CHOSEN });
    expect(isTrivialChoice(choice)).toBe(false);
  });

  it('one option is not a decision; zero options settles to nothing', () => {
    const one = normalizeChoiceRequest(
      { ...request, options: [{ value: 'Goblin', label: 'Goblin' }] },
      source,
    ) as ChooseValueChoice;
    expect(isTrivialChoice(one)).toBe(true);
    expect(defaultAnswerFor(one)).toEqual({ kind: 'chooseValue', value: 'Goblin' });

    const none = normalizeChoiceRequest({ ...request, options: [] }, source) as ChooseValueChoice;
    expect(isTrivialChoice(none)).toBe(true);
    expect(defaultAnswerFor(none)).toEqual({ kind: 'chooseValue', value: NOTHING_CHOSEN });
  });
});

// --- 3. the land-play asking path -----------------------------------------------------

describe('a land naming a value as it enters', () => {
  it('parks the naming, and answering it records the value on THAT permanent', () => {
    const reg = createEffectRegistry();
    const { state, landId } = playLand(reg, NAMING_LAND);
    const choice = state.pendingChoice as ChooseValueChoice | null;
    expect(choice?.kind).toBe('chooseValue');
    expect(choice?.subject).toBe('color');
    expect(choice?.chooser).toBe('A');
    expect(choice?.context).toBe('asEnters');
    expect(choice?.appliesToInstanceId).toBe(landId);
    // Five colours, never colourless: "choose a color" is one of five (CR 105.1).
    expect(choice?.options.map((o) => o.value)).toEqual(['W', 'U', 'B', 'R', 'G']);
    // Answering is the only legal move while the question stands.
    expect(generateLegalActions(state).every((a) => a.kind === 'answerChoice')).toBe(true);

    const done = answer(state, reg, { kind: 'chooseValue', value: 'R' });
    expect(onBattlefield(done, landId).chosenAsEntered).toBe('R');
    expect(done.pendingChoice ?? null).toBeNull();
    // The land play never surrendered priority.
    expect(done.priorityPlayer).toBe('A');
  });

  it('announces the named value publicly — it is said at the table, not whispered', () => {
    const reg = createEffectRegistry();
    const { state, landId } = playLand(reg, NAMING_LAND);
    const result = applyAction(
      state,
      {
        kind: 'answerChoice',
        player: 'A',
        choiceId: state.pendingChoice!.id,
        answer: { kind: 'chooseValue', value: 'G' },
      },
      DEFAULT_RULES,
      reg,
    );
    const announced = result.events.find((e) => e.type === 'chosenAsEnters');
    expect(announced).toMatchObject({ instanceId: landId, subject: 'color', value: 'G', described: 'green' });
  });

  it('asks the NAMING and THEN the payment — one land, two questions, neither dropped', () => {
    const reg = createEffectRegistry();
    const { state, landId } = playLand(reg, TWO_QUESTION_LAND);
    expect(state.pendingChoice?.kind).toBe('chooseValue');

    const named = answer(state, reg, { kind: 'chooseValue', value: 'Island' });
    expect(onBattlefield(named, landId).chosenAsEntered).toBe('Island');
    // The second question is now standing, not lost.
    expect(named.pendingChoice?.kind).toBe('payLife');

    const paid = answer(named, reg, { kind: 'payLife', pay: true });
    expect(paid.players.A.life).toBe(DEFAULT_RULES.startingLife - PASSAGE_LIFE);
    expect(onBattlefield(paid, landId).tapped).toBe(false);
    expect(onBattlefield(paid, landId).chosenAsEntered).toBe('Island');
  });

  it('declining the second question still leaves the first answer standing', () => {
    const reg = createEffectRegistry();
    const { state, landId } = playLand(reg, TWO_QUESTION_LAND);
    const named = answer(state, reg, { kind: 'chooseValue', value: 'Swamp' });
    const declined = answer(named, reg, { kind: 'payLife', pay: false });
    expect(onBattlefield(declined, landId).tapped).toBe(true);
    expect(onBattlefield(declined, landId).chosenAsEntered).toBe('Swamp');
  });

  it('naming NOTHING is accepted, reads as nothing, and does NOT ask again', () => {
    const reg = createEffectRegistry();
    const { state, landId } = playLand(reg, NAMING_LAND);
    const done = answer(state, reg, { kind: 'chooseValue', value: NOTHING_CHOSEN });
    const land = onBattlefield(done, landId);
    // Recorded as the empty string, not left absent: the land-play path asks its
    // questions in a STEP function that re-enters after every answer, so an
    // absent value here would re-raise the same question forever — and the
    // engine's own degraded answer names nothing, so it would spin.
    expect(land.chosenAsEntered).toBe(NOTHING_CHOSEN);
    expect(chosenColorOf(land)).toBeUndefined();
    expect(done.pendingChoice ?? null).toBeNull();
    // …and the mana ability reads it as nothing, so the land taps for nothing.
    expect(generateLegalActions(done).filter((a) => a.kind === 'tapForMana')).toHaveLength(0);
  });
});

// --- 4. the named value is OBSERVABLE ------------------------------------------------

describe('the debug surface', () => {
  it('the state dump shows what a permanent named', () => {
    const reg = createEffectRegistry();
    const { state } = playLand(reg, NAMING_LAND);
    // Before the answer there is nothing to show, and the row is unchanged.
    expect(dumpState(state)).not.toContain('named:');
    const done = answer(state, reg, { kind: 'chooseValue', value: 'R' });
    // An anthem that "isn't working" is unreadable in a dump without this.
    expect(dumpState(done)).toContain('named:R');
  });
});

// --- 5. the value survives, and is cleared when it should be --------------------------

describe('the named value persists', () => {
  it('cloneState copies it — a dropped field would blank the card one action later', () => {
    const reg = createEffectRegistry();
    const { state, landId } = playLand(reg, NAMING_LAND);
    const named = answer(state, reg, { kind: 'chooseValue', value: 'B' });
    const copy = cloneState(named);
    expect(onBattlefield(copy, landId).chosenAsEntered).toBe('B');
    // …and it is a copy, not the same object: mutating one must not move the other.
    onBattlefield(copy, landId).chosenAsEntered = 'W';
    expect(onBattlefield(named, landId).chosenAsEntered).toBe('B');
  });

  it('is CLEARED when the permanent leaves the battlefield (CR 400.7: a new object)', () => {
    const reg = createEffectRegistry();
    const { state, landId } = playLand(reg, NAMING_LAND);
    const named = answer(state, reg, { kind: 'chooseValue', value: 'B' });
    const land = onBattlefield(named, landId);
    expect(land.chosenAsEntered).toBe('B');

    // Leaving the battlefield is what resets it, and the reset runs at the ONE
    // chokepoint every zone change passes through — so this calls that, rather
    // than picking a particular removal spell and testing it instead.
    resetInstanceForNewZone(land);
    expect(land.chosenAsEntered).toBeUndefined();
  });
});

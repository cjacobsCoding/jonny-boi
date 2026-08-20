/**
 * CAST-TIME CHOICE, part two: MODAL SPELLS, MODAL DOUBLE-FACED CARDS,
 * MULTIKICKER, and the {X}/life forms of a FLASHBACK cost.
 *
 * All four extend the same seam the {X}/kicker system opened (`cast-cost.test.ts`):
 * a question parked while the spell is being ANNOUNCED, with nothing resolving,
 * settled by the engine before anybody gets priority to respond.
 *
 * Each system's silent-failure mode gets its own test, because each is invisible
 * when wrong:
 *  - **modes chosen at cast, not on resolution.** A modal spell whose modes were
 *    picked at resolution would let its controller watch the opponent's response
 *    first — strictly better than the printed card, and nothing would look broken.
 *  - **per-mode targets.** Two chosen modes point at two DIFFERENT objects, which
 *    one frame-wide target list cannot express; get it wrong and both modes hit
 *    the same victim, quietly.
 *  - **printed order.** Chosen modes resolve as printed, not as picked (CR
 *    601.2b), and the difference is observable whenever mode one changes whether
 *    mode two can happen.
 *  - **"up to N" with N = 0, and same-mode-twice counting.** A count is the whole
 *    answer for a repeats choice; a set would silently collapse three picks to one.
 *  - **multikicker ×0** is the printed default and must charge nothing, and a
 *    count the board cannot fund must never be offered.
 *  - **X-flashback exiles correctly.** Flashback's exile replacement follows the
 *    CAST, and the X question must read the FLASHBACK cost's X, not the printed
 *    cost's (a card can print both).
 *  - **the clone trap.** Every field added to a stack object or an instance is
 *    dropped by `internal/clone.ts` unless it is copied there BY NAME, and the
 *    clone happens at every action boundary — so a dropped field looks like a
 *    spell that forgot its own announcement one action later.
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
  type ChoiceAnswer,
  type ChooseModesChoice,
  type ChooseNumberChoice,
  type GameAction,
  type GameState,
  type InstanceId,
  type SelectTargetsChoice,
} from './index.js';
import { createEffectRegistry, type EffectRegistry } from './effects.js';
import { deckOf, landDef } from './test-fixtures.js';

const MOUNTAIN = landDef('Mountain', 'R');
const ISLAND = landDef('Island', 'U');

/** How much life the "gain life" mode grants — named so no bare number appears. */
const MODE_LIFE_GAIN = 3;
/** Damage the "burn" mode deals. */
const MODE_DAMAGE = 2;

// --- primitives the fixtures are built from ---------------------------------------

/**
 * A miniature registry. Core knows nothing about any card here; it knows
 * `EffectContext.targets`, `.kickCount` and `.kicked`, which are the seams under
 * test. Every primitive records what it was pointed at, so a test can prove that
 * two modes of one spell hit two different objects.
 */
function modalRegistry(): { reg: EffectRegistry; hits: Array<{ primitive: string; target: unknown }> } {
  const reg = createEffectRegistry();
  const hits: Array<{ primitive: string; target: unknown }> = [];

  reg.register('tapTargetPermanent', (ctx) => {
    const target = ctx.targets[0];
    hits.push({ primitive: 'tapTargetPermanent', target });
    const permanent = ctx.state.battlefield.find((c) => c.instanceId === target);
    if (!permanent || permanent.tapped) return;
    permanent.tapped = true;
    ctx.emit({ type: 'tapped', instanceId: permanent.instanceId });
  });

  reg.register('burnTarget', (ctx) => {
    const target = ctx.targets[0];
    hits.push({ primitive: 'burnTarget', target });
    const permanent = ctx.state.battlefield.find((c) => c.instanceId === target);
    if (!permanent) return;
    permanent.damageMarked += MODE_DAMAGE;
    ctx.emit({
      type: 'damageDealt',
      sourceInstanceId: ctx.source.instanceId,
      targetInstanceId: permanent.instanceId,
      amount: MODE_DAMAGE,
    });
  });

  reg.register('gainLife', (ctx) => {
    hits.push({ primitive: 'gainLife', target: undefined });
    const player = ctx.state.players[ctx.controller];
    player.life += MODE_LIFE_GAIN;
    ctx.emit({ type: 'lifeChanged', player: ctx.controller, delta: MODE_LIFE_GAIN, to: player.life });
  });

  // "…for each time it was kicked" — reads the multikicker count, and after the
  // spell has become a permanent, the count recorded on the instance.
  reg.register('lifePerKick', (ctx) => {
    const times = ctx.kickCount ?? (ctx.kicked === true ? 1 : (ctx.source.timesKicked ?? 0));
    hits.push({ primitive: 'lifePerKick', target: times });
    if (times <= 0) return;
    const player = ctx.state.players[ctx.controller];
    player.life += times;
    ctx.emit({ type: 'lifeChanged', player: ctx.controller, delta: times, to: player.life });
  });

  return { reg, hits };
}

// --- fixture cards ------------------------------------------------------------------

/** A permanent the modes can be aimed at. */
// Toughness 3 on purpose: the burn mode deals 2, so a damaged creature SURVIVES
// and a test can read the damage it took instead of finding an empty battlefield.
const BEAR: CardDefinition = { id: 'bear', name: 'Bear', types: ['creature'], power: 2, toughness: 3 };

/**
 * "Choose two — • Tap target permanent • ~ deals 2 damage to target creature
 * • You gain 3 life." Two targeting modes and one target-free one, which is what
 * makes it able to prove per-mode aiming.
 */
const COMMAND: CardDefinition = {
  id: 'command',
  name: 'Test Command',
  types: ['instant'],
  modal: {
    min: 2,
    max: 2,
    modes: [
      {
        id: 'tap',
        label: 'Tap target permanent',
        targets: 'permanent',
        effects: [{ primitive: 'tapTargetPermanent' }],
      },
      {
        id: 'burn',
        label: 'Deal 2 damage to target creature',
        targets: 'creature',
        effects: [{ primitive: 'burnTarget' }],
      },
      { id: 'life', label: 'You gain 3 life', effects: [{ primitive: 'gainLife' }] },
    ],
  },
};

/** "Choose up to two —", whose floor is zero modes. */
const UP_TO_TWO: CardDefinition = {
  ...COMMAND,
  id: 'up-to-two',
  name: 'Up To Two',
  modal: { ...COMMAND.modal!, min: 0, max: 2 },
};

/** "Choose two. You may choose the same mode more than once." */
const CONFLUENCE: CardDefinition = {
  id: 'confluence',
  name: 'Test Confluence',
  types: ['instant'],
  modal: {
    min: 2,
    max: 2,
    allowRepeats: true,
    modes: [
      { id: 'life', label: 'You gain 3 life', effects: [{ primitive: 'gainLife' }] },
      {
        id: 'burn',
        label: 'Deal 2 damage to target creature',
        targets: 'creature',
        effects: [{ primitive: 'burnTarget' }],
      },
    ],
  },
};

/** "Multikicker {1}. You gain 1 life for each time this spell was kicked." */
const MULTIKICKED: CardDefinition = {
  id: 'multikicked',
  name: 'Multikicked Gift',
  types: ['sorcery'],
  multikicker: { generic: 1 },
  effects: [{ primitive: 'lifePerKick' }],
};

/** A multikicked PERMANENT: the count must survive onto the battlefield. */
const MULTIKICKED_CREATURE: CardDefinition = {
  id: 'multikicked-creature',
  name: 'Multikicked Beast',
  types: ['creature'],
  power: 1,
  toughness: 1,
  multikicker: { generic: 1 },
};

/** "Flashback {X}{R}" — the X is the FLASHBACK cost's, not the printed cost's. */
const X_FLASHBACK: CardDefinition = {
  id: 'x-flashback',
  name: 'X Flashback',
  types: ['sorcery'],
  cost: { R: 1 },
  flashback: { R: 1 },
  flashbackXCost: 1,
  effects: [{ primitive: 'gainLife' }],
};

/** "Flashback—{R}, Pay 3 life." */
const LIFE_FLASHBACK: CardDefinition = {
  id: 'life-flashback',
  name: 'Life Flashback',
  types: ['sorcery'],
  cost: { R: 1 },
  flashback: { R: 1 },
  flashbackLifeCost: 3,
  effects: [{ primitive: 'gainLife' }],
};

/** A modal DFC: an instant front, a land back. Both halves are really played. */
const MDFC: CardDefinition = {
  id: 'mdfc',
  name: 'Rebirth',
  types: ['instant'],
  cost: { R: 1 },
  effects: [{ primitive: 'gainLife' }],
  backFaceCastable: true,
  backFace: {
    id: 'mdfc#back',
    name: 'Mire',
    types: ['land'],
    isBackFace: true,
    produces: ['R'],
    entersTapped: true,
  },
};

/** A TRANSFORMING DFC — its back face must stay uncastable (CR 712.8b). */
const TRANSFORM_DFC: CardDefinition = {
  id: 'transform-dfc',
  name: 'Delver',
  types: ['creature'],
  cost: { U: 1 },
  power: 1,
  toughness: 1,
  backFace: { id: 'transform-dfc#back', name: 'Aberration', types: ['creature'], power: 3, toughness: 2, isBackFace: true },
};

// --- harness ------------------------------------------------------------------------

const SEED = 0x0d1a;

function act(state: GameState, action: GameAction, reg: EffectRegistry): GameState {
  const result = applyAction(state, action, DEFAULT_RULES, reg);
  const rejected = result.events.find((e) => e.type === 'actionRejected');
  if (rejected) {
    throw new Error(`unexpected rejection: ${(rejected as { reason: string }).reason}\n${dumpState(state)}`);
  }
  return result.state;
}

/** Apply an action EXPECTING a rejection; returns the reason. */
function rejectionOf(state: GameState, action: GameAction, reg: EffectRegistry): string {
  const result = applyAction(state, action, DEFAULT_RULES, reg);
  const rejected = result.events.find((e) => e.type === 'actionRejected');
  if (!rejected) throw new Error(`expected a rejection\n${dumpState(result.state)}`);
  return (rejected as { reason: string }).reason;
}

function pass(state: GameState, reg: EffectRegistry): GameState {
  return act(state, { kind: 'passPriority', player: state.priorityPlayer }, reg);
}

function gameAtMain(reg: EffectRegistry, land: CardDefinition = MOUNTAIN): GameState {
  const created = createGame({
    seed: SEED,
    startingPlayer: 'A',
    registry: reg,
    decks: { A: deckOf(land, 40), B: deckOf(land, 40) },
  });
  let state = created.state;
  let guard = 0;
  while (state.step !== 'precombatMain' && !state.gameOver && guard++ < 50) state = pass(state, reg);
  state.players.A.hand = [];
  state.players.B.hand = [];
  return state;
}

function newInstance(state: GameState, def: CardDefinition, player: 'A' | 'B', zone: 'hand' | 'battlefield' | 'graveyard') {
  const card = {
    instanceId: state.nextInstanceId++,
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
  if (zone === 'battlefield') state.battlefield.push(card);
  else state.players[player][zone].push(card);
  return card;
}

/** Put `count` untapped lands onto A's battlefield. */
function giveLands(state: GameState, count: number, land: CardDefinition = MOUNTAIN): void {
  for (let i = 0; i < count; i++) newInstance(state, land, 'A', 'battlefield');
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

/** The modal spell currently on the stack (there is only ever one under test). */
function spellOnStack(state: GameState) {
  const object = state.stack.find((o) => o.kind === 'spell');
  return object?.kind === 'spell' ? object : undefined;
}

// --- modal spells: announced at cast --------------------------------------------------

describe('a modal spell announces its modes AS IT IS CAST', () => {
  it('parks the mode question with nothing resolving, and freezes the game on it', () => {
    const { reg } = modalRegistry();
    let state = gameAtMain(reg);
    giveLands(state, 4);
    newInstance(state, BEAR, 'B', 'battlefield');
    const spell = newInstance(state, COMMAND, 'A', 'hand');
    state = act(state, { kind: 'castSpell', player: 'A', instanceId: spell.instanceId }, reg);

    const choice = state.pendingChoice as ChooseModesChoice | null;
    expect(choice?.kind).toBe('chooseModes');
    expect(choice?.chooser).toBe('A');
    expect([choice?.min, choice?.max]).toEqual([2, 2]);
    // Nothing is resolving: the spell is on the stack, mid-announcement.
    expect(state.resolution).toBeFalsy();
    expect(state.stack).toHaveLength(1);
    // And the only legal action is answering, so the opponent cannot respond
    // "around" a half-announced spell.
    expect(generateLegalActions(state).every((a) => a.kind === 'answerChoice')).toBe(true);
    expect(spellOnStack(state)?.awaitingCastChoice).toBe('modes');
  });

  it('offers only modes it could legally announce, and clamps the count to them', () => {
    const { reg } = modalRegistry();
    let state = gameAtMain(reg);
    giveLands(state, 4);
    // No creature anywhere, so the burn mode has nothing to point at. The tap
    // mode can still name a land.
    const spell = newInstance(state, COMMAND, 'A', 'hand');
    state = act(state, { kind: 'castSpell', player: 'A', instanceId: spell.instanceId }, reg);

    // Exactly two modes are announceable, and the card says "choose two" — one
    // legal answer, so the engine takes it instead of stopping the game to
    // collect the inevitable, and the burn mode simply never happened.
    expect(spellOnStack(state)?.modePicks?.map((p) => p.modeId)).toEqual(['tap', 'life']);
    // What IS still being asked is where the tap mode points (four lands are
    // legal permanents) — the next question in the cast pipeline.
    expect(state.pendingChoice?.kind).toBe('selectTargets');
  });

  it('cannot be cast at all when it can announce no mode', () => {
    const { reg } = modalRegistry();
    const state = gameAtMain(reg);
    giveLands(state, 4);
    // A card whose every mode needs a creature, on a board with none.
    const creatureOnly: CardDefinition = {
      ...COMMAND,
      id: 'creature-only',
      name: 'Creature Only',
      modal: { min: 1, max: 1, modes: [COMMAND.modal!.modes[1]!] },
    };
    const spell = newInstance(state, creatureOnly, 'A', 'hand');

    // Not offered…
    expect(
      generateLegalActions(state).some((a) => a.kind === 'castSpell' && a.instanceId === spell.instanceId),
    ).toBe(false);
    // …and not accepted either: offer and accept judge by the same helper.
    expect(rejectionOf(state, { kind: 'castSpell', player: 'A', instanceId: spell.instanceId }, reg)).toContain(
      'no mode you could legally choose',
    );
  });

  it('refuses a whole-card target: a modal spell aims per mode', () => {
    const { reg } = modalRegistry();
    const state = gameAtMain(reg);
    giveLands(state, 4);
    const bear = newInstance(state, BEAR, 'B', 'battlefield');
    const spell = newInstance(state, COMMAND, 'A', 'hand');

    expect(
      rejectionOf(
        state,
        { kind: 'castSpell', player: 'A', instanceId: spell.instanceId, targets: [bear.instanceId] },
        reg,
      ),
    ).toContain('per mode');
  });

  it('aims each chosen mode SEPARATELY, and the two modes hit two different objects', () => {
    const { reg, hits } = modalRegistry();
    let state = gameAtMain(reg);
    giveLands(state, 4);
    const bear = newInstance(state, BEAR, 'B', 'battlefield');
    const otherBear = newInstance(state, BEAR, 'B', 'battlefield');
    const spell = newInstance(state, COMMAND, 'A', 'hand');
    state = act(state, { kind: 'castSpell', player: 'A', instanceId: spell.instanceId }, reg);
    state = answer(state, reg, { kind: 'chooseModes', modeIds: ['tap', 'burn'] });

    // Question one: where does the TAP mode point? (Lands are legal permanents,
    // so this is a real choice.)
    const tapAim = state.pendingChoice as SelectTargetsChoice;
    expect(tapAim.kind).toBe('selectTargets');
    expect(tapAim.restriction).toBe('permanent');
    state = answer(state, reg, { kind: 'selectTargets', targets: [bear.instanceId] });

    // Question two: where does the BURN mode point? A different question, and a
    // different answer.
    const burnAim = state.pendingChoice as SelectTargetsChoice;
    expect(burnAim.kind).toBe('selectTargets');
    expect(burnAim.restriction).toBe('creature');
    state = answer(state, reg, { kind: 'selectTargets', targets: [otherBear.instanceId] });

    // Fully announced, still unresolved, caster still holding priority.
    expect(state.pendingChoice).toBeNull();
    expect(state.stack).toHaveLength(1);
    expect(state.priorityPlayer).toBe('A');

    state = resolve(state, reg);
    expect(hits).toEqual([
      { primitive: 'tapTargetPermanent', target: bear.instanceId },
      { primitive: 'burnTarget', target: otherBear.instanceId },
    ]);
    expect(state.battlefield.find((c) => c.instanceId === bear.instanceId)?.tapped).toBe(true);
    expect(state.battlefield.find((c) => c.instanceId === otherBear.instanceId)?.damageMarked).toBe(MODE_DAMAGE);
  });

  it('resolves chosen modes in PRINTED order, not the order they were picked', () => {
    const { reg, hits } = modalRegistry();
    let state = gameAtMain(reg);
    giveLands(state, 4);
    newInstance(state, BEAR, 'B', 'battlefield');
    const spell = newInstance(state, COMMAND, 'A', 'hand');
    state = act(state, { kind: 'castSpell', player: 'A', instanceId: spell.instanceId }, reg);
    // Picked life-then-tap; the card prints tap (mode 1) before life (mode 3).
    state = answer(state, reg, { kind: 'chooseModes', modeIds: ['life', 'tap'] });
    expect(spellOnStack(state)?.modePicks?.map((p) => p.modeId)).toEqual(['tap', 'life']);
    state = answer(state, reg, { kind: 'selectTargets', targets: [state.battlefield[0]!.instanceId] });
    state = resolve(state, reg);
    expect(hits.map((h) => h.primitive)).toEqual(['tapTargetPermanent', 'gainLife']);
  });

  it('a mode whose target became illegal does nothing — its sibling still resolves', () => {
    const { reg, hits } = modalRegistry();
    let state = gameAtMain(reg);
    giveLands(state, 4);
    const bear = newInstance(state, BEAR, 'B', 'battlefield');
    const spell = newInstance(state, COMMAND, 'A', 'hand');
    state = act(state, { kind: 'castSpell', player: 'A', instanceId: spell.instanceId }, reg);
    state = answer(state, reg, { kind: 'chooseModes', modeIds: ['burn', 'life'] });
    // Only one creature, so the burn mode was aimed at it automatically. Now it
    // leaves before the spell resolves (CR 608.2b).
    state.battlefield = state.battlefield.filter((c) => c.instanceId !== bear.instanceId);

    state = resolve(state, reg);
    expect(hits.map((h) => h.primitive)).toEqual(['gainLife']);
    expect(state.players.A.life).toBe(DEFAULT_RULES.startingLife + MODE_LIFE_GAIN);
  });

  it('"choose up to two" with ZERO modes chosen resolves as a spell that does nothing', () => {
    const { reg, hits } = modalRegistry();
    let state = gameAtMain(reg);
    giveLands(state, 4);
    newInstance(state, BEAR, 'B', 'battlefield');
    const spell = newInstance(state, UP_TO_TWO, 'A', 'hand');
    state = act(state, { kind: 'castSpell', player: 'A', instanceId: spell.instanceId }, reg);
    expect((state.pendingChoice as ChooseModesChoice).min).toBe(0);

    state = answer(state, reg, { kind: 'chooseModes', modeIds: [] });
    expect(state.pendingChoice).toBeNull();
    state = resolve(state, reg);

    expect(hits).toEqual([]);
    // It still went to the graveyard — a spell that chose nothing still resolved.
    expect(state.players.A.graveyard.some((c) => c.instanceId === spell.instanceId)).toBe(true);
  });

  it('counts a repeated mode ONCE PER PICK — the same mode twice happens twice', () => {
    const { reg, hits } = modalRegistry();
    let state = gameAtMain(reg);
    giveLands(state, 4);
    // A creature exists, so BOTH modes are announceable and the pick is a real
    // question (with one announceable mode, "choose two" would have exactly one
    // legal answer and the engine would settle it).
    newInstance(state, BEAR, 'B', 'battlefield');
    const spell = newInstance(state, CONFLUENCE, 'A', 'hand');
    state = act(state, { kind: 'castSpell', player: 'A', instanceId: spell.instanceId }, reg);

    const choice = state.pendingChoice as ChooseModesChoice;
    expect(choice.allowRepeats).toBe(true);
    state = answer(state, reg, { kind: 'chooseModes', modeIds: ['life', 'life'] });
    expect(spellOnStack(state)?.modePicks?.map((p) => p.modeId)).toEqual(['life', 'life']);

    state = resolve(state, reg);
    expect(hits.map((h) => h.primitive)).toEqual(['gainLife', 'gainLife']);
    expect(state.players.A.life).toBe(DEFAULT_RULES.startingLife + MODE_LIFE_GAIN * 2);
  });

  it('rejects a repeated pick on a choice that does not allow repeats', () => {
    const { reg } = modalRegistry();
    let state = gameAtMain(reg);
    giveLands(state, 4);
    newInstance(state, BEAR, 'B', 'battlefield');
    const spell = newInstance(state, COMMAND, 'A', 'hand');
    state = act(state, { kind: 'castSpell', player: 'A', instanceId: spell.instanceId }, reg);
    const choice = state.pendingChoice!;

    expect(
      rejectionOf(
        state,
        { kind: 'answerChoice', player: 'A', choiceId: choice.id, answer: { kind: 'chooseModes', modeIds: ['life', 'life'] } },
        reg,
      ),
    ).toContain('more than once');
  });
});

// --- modal DFCs -----------------------------------------------------------------------

describe('a modal double-faced card is cast (or played) as either face', () => {
  it('offers both halves, and the land half is a LAND PLAY', () => {
    const { reg } = modalRegistry();
    let state = gameAtMain(reg);
    giveLands(state, 2);
    const card = newInstance(state, MDFC, 'A', 'hand');
    // The cast offer is gated on the floating pool (as every cast offer is), so
    // float the mana the front face costs before asking what is on the menu.
    state = act(state, { kind: 'tapForMana', player: 'A', instanceId: state.battlefield[0]!.instanceId }, reg);

    const actions = generateLegalActions(state);
    expect(actions.some((a) => a.kind === 'castSpell' && a.instanceId === card.instanceId && a.face === undefined)).toBe(
      true,
    );
    expect(actions.some((a) => a.kind === 'playLand' && a.instanceId === card.instanceId && a.face === 'back')).toBe(
      true,
    );
    // The FRONT is not a land and the BACK is not a spell — neither wrong offer exists.
    expect(actions.some((a) => a.kind === 'playLand' && a.face === undefined && a.instanceId === card.instanceId)).toBe(
      false,
    );
    expect(actions.some((a) => a.kind === 'castSpell' && a.face === 'back')).toBe(false);
  });

  it('playing the back face uses the LAND DROP and enters as that face', () => {
    const { reg } = modalRegistry();
    let state = gameAtMain(reg);
    const card = newInstance(state, MDFC, 'A', 'hand');
    state = act(state, { kind: 'playLand', player: 'A', instanceId: card.instanceId, face: 'back' }, reg);

    const played = state.battlefield.find((c) => c.instanceId === card.instanceId)!;
    expect(played.def.name).toBe('Mire');
    expect(played.tapped).toBe(true); // the back face's own "enters tapped"
    expect(state.players.A.landsPlayedThisTurn).toBe(1);
    // The way back to the front is kept, exactly as a transform keeps it.
    expect(played.printedDef?.name).toBe('Rebirth');
  });

  it('casting the back face of a TRANSFORMING DFC is refused (CR 712.8b)', () => {
    const { reg } = modalRegistry();
    const state = gameAtMain(reg, ISLAND);
    giveLands(state, 3, ISLAND);
    const card = newInstance(state, TRANSFORM_DFC, 'A', 'hand');

    expect(generateLegalActions(state).some((a) => a.kind === 'castSpell' && a.face === 'back')).toBe(false);
    expect(
      rejectionOf(state, { kind: 'castSpell', player: 'A', instanceId: card.instanceId, face: 'back' }, reg),
    ).toContain('no castable back face');
  });

  it('a back-face spell reverts to its front face as it leaves the stack (CR 712.8a)', () => {
    const { reg } = modalRegistry();
    // A card whose BACK is the spell, so a back-face cast resolves to a graveyard.
    const spellBack: CardDefinition = {
      id: 'spell-back',
      name: 'Front Land',
      types: ['land'],
      backFaceCastable: true,
      backFace: { id: 'spell-back#back', name: 'Back Spell', types: ['sorcery'], cost: { R: 1 }, isBackFace: true, effects: [{ primitive: 'gainLife' }] },
    };
    let state = gameAtMain(reg);
    giveLands(state, 2);
    const card = newInstance(state, spellBack, 'A', 'hand');
    state = act(state, { kind: 'tapForMana', player: 'A', instanceId: state.battlefield[0]!.instanceId }, reg);
    state = act(state, { kind: 'castSpell', player: 'A', instanceId: card.instanceId, face: 'back' }, reg);
    expect(spellOnStack(state)?.card.def.name).toBe('Back Spell');

    state = resolve(state, reg);
    const inGraveyard = state.players.A.graveyard.find((c) => c.instanceId === card.instanceId)!;
    expect(inGraveyard.def.name).toBe('Front Land');
    expect(state.players.A.life).toBe(DEFAULT_RULES.startingLife + MODE_LIFE_GAIN);
  });
});

// --- multikicker ------------------------------------------------------------------------

describe('multikicker asks HOW MANY, not whether', () => {
  it('parks a chooseNumber ranged by what the board can fund', () => {
    const { reg } = modalRegistry();
    let state = gameAtMain(reg);
    giveLands(state, 3);
    const spell = newInstance(state, MULTIKICKED, 'A', 'hand');
    state = act(state, { kind: 'castSpell', player: 'A', instanceId: spell.instanceId }, reg);

    const choice = state.pendingChoice as ChooseNumberChoice;
    expect(choice.kind).toBe('chooseNumber');
    expect([choice.min, choice.max]).toEqual([0, 3]);
    expect(spellOnStack(state)?.awaitingCastChoice).toBe('multikicker');
  });

  it('charges the count exactly once, and the effect reads it', () => {
    const { reg } = modalRegistry();
    let state = gameAtMain(reg);
    giveLands(state, 3);
    const spell = newInstance(state, MULTIKICKED, 'A', 'hand');
    state = act(state, { kind: 'castSpell', player: 'A', instanceId: spell.instanceId }, reg);
    state = answer(state, reg, { kind: 'chooseNumber', value: 2 });

    expect(spellOnStack(state)?.kickCount).toBe(2);
    // Any positive count also sets `kicked`, so an "if this spell was kicked"
    // rider reads multikicker correctly.
    expect(spellOnStack(state)?.kicked).toBe(true);
    // Two lands paid for it, one is left.
    expect(state.battlefield.filter((c) => c.controller === 'A' && !c.tapped)).toHaveLength(1);

    state = resolve(state, reg);
    expect(state.players.A.life).toBe(DEFAULT_RULES.startingLife + 2);
  });

  it('×0 is the printed default: nothing is charged and nothing is kicked', () => {
    const { reg } = modalRegistry();
    let state = gameAtMain(reg);
    giveLands(state, 3);
    const spell = newInstance(state, MULTIKICKED, 'A', 'hand');
    state = act(state, { kind: 'castSpell', player: 'A', instanceId: spell.instanceId }, reg);
    state = answer(state, reg, { kind: 'chooseNumber', value: 0 });

    expect(spellOnStack(state)?.kickCount).toBe(0);
    expect(spellOnStack(state)?.kicked).toBeUndefined();
    expect(state.battlefield.filter((c) => c.controller === 'A' && !c.tapped)).toHaveLength(3);

    state = resolve(state, reg);
    expect(state.players.A.life).toBe(DEFAULT_RULES.startingLife);
  });

  it('is never ASKED on a board that cannot fund even one kick', () => {
    const { reg } = modalRegistry();
    let state = gameAtMain(reg);
    // No lands at all: 0..0 is not a decision, so the game does not stop.
    const spell = newInstance(state, MULTIKICKED, 'A', 'hand');
    state = act(state, { kind: 'castSpell', player: 'A', instanceId: spell.instanceId }, reg);

    expect(state.pendingChoice).toBeFalsy();
    expect(spellOnStack(state)?.kickCount).toBe(0);
  });

  it('refuses a count the board cannot pay for, rather than clamping it', () => {
    const { reg } = modalRegistry();
    let state = gameAtMain(reg);
    giveLands(state, 2);
    const spell = newInstance(state, MULTIKICKED, 'A', 'hand');
    state = act(state, { kind: 'castSpell', player: 'A', instanceId: spell.instanceId }, reg);
    const choice = state.pendingChoice!;

    expect(
      rejectionOf(
        state,
        { kind: 'answerChoice', player: 'A', choiceId: choice.id, answer: { kind: 'chooseNumber', value: 5 } },
        reg,
      ),
    ).toContain('between 0 and 2');
  });

  it('records the count on the PERMANENT a kicked creature becomes', () => {
    const { reg } = modalRegistry();
    let state = gameAtMain(reg);
    giveLands(state, 3);
    const spell = newInstance(state, MULTIKICKED_CREATURE, 'A', 'hand');
    state = act(state, { kind: 'castSpell', player: 'A', instanceId: spell.instanceId }, reg);
    state = answer(state, reg, { kind: 'chooseNumber', value: 2 });
    state = resolve(state, reg);

    // The resolution frame is gone; an ETB trigger resolving now would still be
    // able to read how many times the spell was kicked.
    expect(state.battlefield.find((c) => c.instanceId === spell.instanceId)?.timesKicked).toBe(2);
  });
});

// --- flashback {X} / life ---------------------------------------------------------------

describe('flashback costs with an {X} or a life rider', () => {
  it('asks the X off the FLASHBACK cost, and exiles the card on resolution', () => {
    const { reg } = modalRegistry();
    let state = gameAtMain(reg);
    giveLands(state, 3);
    const card = newInstance(state, X_FLASHBACK, 'A', 'graveyard');
    state = act(state, { kind: 'tapForMana', player: 'A', instanceId: state.battlefield[0]!.instanceId }, reg);
    state = act(
      state,
      { kind: 'castSpell', player: 'A', instanceId: card.instanceId, fromZone: 'graveyard' },
      reg,
    );

    const choice = state.pendingChoice as ChooseNumberChoice;
    expect(choice.kind).toBe('chooseNumber');
    // Two untapped lands left after the {R} base flashback cost.
    expect(choice.max).toBe(2);
    state = answer(state, reg, { kind: 'chooseNumber', value: 2 });
    state = resolve(state, reg);

    // CR 702.34a: a spell cast from the graveyard is EXILED as it leaves the stack.
    expect(state.players.A.exile.some((c) => c.instanceId === card.instanceId)).toBe(true);
    expect(state.players.A.graveyard.some((c) => c.instanceId === card.instanceId)).toBe(false);
  });

  it('charges the life rider with the mana, and refuses the cast without the life', () => {
    const { reg } = modalRegistry();
    let state = gameAtMain(reg);
    giveLands(state, 2);
    const card = newInstance(state, LIFE_FLASHBACK, 'A', 'graveyard');
    state = act(state, { kind: 'tapForMana', player: 'A', instanceId: state.battlefield[0]!.instanceId }, reg);
    const before = state.players.A.life;
    state = act(
      state,
      { kind: 'castSpell', player: 'A', instanceId: card.instanceId, fromZone: 'graveyard' },
      reg,
    );
    expect(state.players.A.life).toBe(before - 3);

    // With too little life it is neither offered nor accepted.
    const broke = gameAtMain(reg);
    giveLands(broke, 2);
    const other = newInstance(broke, LIFE_FLASHBACK, 'A', 'graveyard');
    broke.players.A.life = 2;
    const tapped = act(broke, { kind: 'tapForMana', player: 'A', instanceId: broke.battlefield[0]!.instanceId }, reg);
    expect(
      generateLegalActions(tapped).some((a) => a.kind === 'castSpell' && a.fromZone === 'graveyard'),
    ).toBe(false);
    expect(
      rejectionOf(
        tapped,
        { kind: 'castSpell', player: 'A', instanceId: other.instanceId, fromZone: 'graveyard' },
        reg,
      ),
    ).toContain('life to pay this flashback cost');
  });

  it('a printed {X} cost is NOT charged on a flashback cast — the flashback cost is', () => {
    const { reg } = modalRegistry();
    // Prints {X} normally, but its flashback cost has no X at all.
    const bothForms: CardDefinition = { ...X_FLASHBACK, id: 'both', name: 'Both', xCost: 3, flashbackXCost: 0 };
    let state = gameAtMain(reg);
    giveLands(state, 3);
    const card = newInstance(state, bothForms, 'A', 'graveyard');
    state = act(state, { kind: 'tapForMana', player: 'A', instanceId: state.battlefield[0]!.instanceId }, reg);
    state = act(
      state,
      { kind: 'castSpell', player: 'A', instanceId: card.instanceId, fromZone: 'graveyard' },
      reg,
    );

    // No X question: the FLASHBACK cost prints none, whatever the front says.
    expect(state.pendingChoice).toBeFalsy();
  });
});

// --- the clone trap ---------------------------------------------------------------------

describe('every cast-time field survives the clone at each action boundary', () => {
  it('keeps modePicks (with their aims), kickCount and timesKicked across a clone', () => {
    const { reg } = modalRegistry();
    let state = gameAtMain(reg);
    giveLands(state, 4);
    const bear = newInstance(state, BEAR, 'B', 'battlefield');
    const spell = newInstance(state, COMMAND, 'A', 'hand');
    state = act(state, { kind: 'castSpell', player: 'A', instanceId: spell.instanceId }, reg);
    state = answer(state, reg, { kind: 'chooseModes', modeIds: ['tap', 'burn'] });
    state = answer(state, reg, { kind: 'selectTargets', targets: [bear.instanceId] });

    const before = spellOnStack(state)!;
    const cloned = spellOnStack(cloneState(state))!;
    expect(cloned.modePicks).toEqual(before.modePicks);
    expect(cloned.awaitingCastChoice).toBe(before.awaitingCastChoice);
    // Deep-copied, not aliased: writing an aim into the clone must not reach the
    // original (a look-ahead search does exactly this, every ply).
    expect(cloned.modePicks![0]!.targets).not.toBe(before.modePicks![0]!.targets);
  });

  it('a two-mode cast survives being driven entirely through applyAction clones', () => {
    // `applyAction` clones the whole state on EVERY action, so this test would
    // fail outright if any of the new fields were missing from `clone.ts` — the
    // spell would forget its own announcement between two answers.
    const { reg, hits } = modalRegistry();
    let state = gameAtMain(reg);
    giveLands(state, 4);
    const bear = newInstance(state, BEAR, 'B', 'battlefield');
    const otherBear = newInstance(state, BEAR, 'B', 'battlefield');
    const spell = newInstance(state, COMMAND, 'A', 'hand');
    state = act(state, { kind: 'castSpell', player: 'A', instanceId: spell.instanceId }, reg);
    state = answer(state, reg, { kind: 'chooseModes', modeIds: ['tap', 'burn'] });
    state = answer(state, reg, { kind: 'selectTargets', targets: [bear.instanceId] });
    state = answer(state, reg, { kind: 'selectTargets', targets: [otherBear.instanceId] });
    state = resolve(state, reg);

    expect(hits).toEqual([
      { primitive: 'tapTargetPermanent', target: bear.instanceId },
      { primitive: 'burnTarget', target: otherBear.instanceId },
    ]);
  });

  it('keeps kickCount and the permanent count across a clone', () => {
    const { reg } = modalRegistry();
    let state = gameAtMain(reg);
    giveLands(state, 3);
    const spell = newInstance(state, MULTIKICKED_CREATURE, 'A', 'hand');
    state = act(state, { kind: 'castSpell', player: 'A', instanceId: spell.instanceId }, reg);
    state = answer(state, reg, { kind: 'chooseNumber', value: 2 });
    expect(spellOnStack(cloneState(state))?.kickCount).toBe(2);

    state = resolve(state, reg);
    const cloned = cloneState(state).battlefield.find((c) => c.instanceId === spell.instanceId);
    expect(cloned?.timesKicked).toBe(2);
  });

  it('clears timesKicked when the permanent leaves the battlefield (CR 400.7)', () => {
    const { reg } = modalRegistry();
    let state = gameAtMain(reg);
    giveLands(state, 3);
    const spell = newInstance(state, MULTIKICKED_CREATURE, 'A', 'hand');
    state = act(state, { kind: 'castSpell', player: 'A', instanceId: spell.instanceId }, reg);
    state = answer(state, reg, { kind: 'chooseNumber', value: 2 });
    state = resolve(state, reg);

    const permanent = state.battlefield.find((c) => c.instanceId === spell.instanceId)!;
    // Lethal damage; the SBA pass moves it to the graveyard.
    permanent.damageMarked = 99;
    state = pass(state, reg);
    expect(state.players.A.graveyard.find((c) => c.instanceId === spell.instanceId)?.timesKicked).toBeUndefined();
  });
});

/** A modal spell's announced modes are PUBLIC — the log says so. */
describe('the event log records the announcement', () => {
  it('emits modesChosen and modeTargetChosen as the cast is finished', () => {
    const { reg } = modalRegistry();
    let state = gameAtMain(reg);
    giveLands(state, 4);
    const bear = newInstance(state, BEAR, 'B', 'battlefield');
    const spell = newInstance(state, COMMAND, 'A', 'hand');
    state = act(state, { kind: 'castSpell', player: 'A', instanceId: spell.instanceId }, reg);
    const choice = state.pendingChoice!;
    const result = applyAction(
      state,
      {
        kind: 'answerChoice',
        player: 'A',
        choiceId: choice.id,
        answer: { kind: 'chooseModes', modeIds: ['tap', 'life'] },
      },
      DEFAULT_RULES,
      reg,
    );

    const announced = result.events.find((e) => e.type === 'modesChosen');
    expect(announced).toBeDefined();
    expect(announced && 'modes' in announced ? announced.modes : []).toEqual([
      'Tap target permanent',
      'You gain 3 life',
    ]);

    // Aiming is its OWN action (four lands and a Bear make it a real choice), so
    // its event lands in that action's log, not this one.
    const aiming = result.state.pendingChoice!;
    const aimed = applyAction(
      result.state,
      {
        kind: 'answerChoice',
        player: 'A',
        choiceId: aiming.id,
        answer: { kind: 'selectTargets', targets: [bear.instanceId] },
      },
      DEFAULT_RULES,
      reg,
    );
    const aimEvent = aimed.events.find((e) => e.type === 'modeTargetChosen');
    expect(aimEvent && 'targets' in aimEvent ? aimEvent.targets : []).toContain(bear.instanceId);
  });
});

/** Cast-time questions are pure data — no `InstanceId` leaks into this file. */
export type _Unused = InstanceId;

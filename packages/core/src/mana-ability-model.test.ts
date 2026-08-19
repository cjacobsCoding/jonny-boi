/**
 * THE RICH MANA-ABILITY MODEL — a mana source that prints more than a colour
 * bundle.
 *
 * Core used to model every mana source as a fixed list of colour bundles: one
 * tap, off the stack, no cost beyond the tap, no rider, no condition. Four whole
 * classes of real card need that model to grow, and each one has a way of being
 * *almost* right that this file exists to refuse:
 *
 *   1. **A RIDER** ("~ deals 1 damage to you") must actually happen. A pain land
 *      whose damage is silently dropped is a strictly better card than the one
 *      printed, and every deck containing four of them would simulate too well.
 *      It must also be DAMAGE, not a cost: the land is still usable at 1 life.
 *   2. **An ADDITIONAL COST** must be charged, and must gate the offer. A filter
 *      land that does not consume its input is two free mana.
 *   3. **AN ACTIVATION RESTRICTION** must make the source INVISIBLE to the
 *      payment planner, not merely refuse after the fact. A planner that counts
 *      an unavailable source funds spells that cannot be cast.
 *   4. **BOARD-DERIVED COLOURS** must be a function of the live board and must be
 *      recomputed, never frozen onto the shared definition.
 *
 * Mana abilities do not use the stack (CR 605.3a), so none of this may become an
 * activated ability — that would make a pain land respondable. The tests below
 * therefore drive `tapForMana` and assert the stack stays empty.
 */

import { describe, expect, it } from 'vitest';
import {
  applyAction,
  createGame,
  DEFAULT_RULES,
  generateLegalActions,
  manaModesOf,
  planManaPayment,
  type CardDefinition,
  type GameAction,
  type GameState,
  type InstanceId,
  type PlayerId,
} from './index.js';
import { createEffectRegistry, type EffectRegistry } from './effects.js';
import { deckOf, landDef } from './test-fixtures.js';

// Land TYPES matter here: an activation restriction reads them ("Activate only
// if you control an Island"), and `landDef` does not print any.
const ISLAND: CardDefinition = { ...landDef('Island', 'U'), subtypes: ['island'] };
const PLAINS: CardDefinition = { ...landDef('Plains', 'W'), subtypes: ['plains'] };

/** Adarkar Wastes: a colourless mode, plus a painful two-colour mode. */
const PAIN_LAND: CardDefinition = {
  id: 'PainLand',
  name: 'Pain Land',
  types: ['land'],
  manaAbilities: [
    { produces: [{ C: 1 }] },
    { produces: [{ W: 1 }, { U: 1 }], rider: { damageToController: 1 } },
  ],
};

/** Mana Confluence: any colour, for a life. */
const CONFLUENCE: CardDefinition = {
  id: 'Confluence',
  name: 'Confluence',
  types: ['land'],
  manaAbilities: [
    { produces: [{ W: 1 }, { U: 1 }, { B: 1 }, { R: 1 }, { G: 1 }], cost: { life: 1 } },
  ],
};

/** Mystic Gate: {C} for free, or {W/U} in for two white/blue out. */
const FILTER_LAND: CardDefinition = {
  id: 'FilterLand',
  name: 'Filter Land',
  types: ['land'],
  manaAbilities: [
    { produces: [{ C: 1 }] },
    {
      produces: [{ W: 2 }, { W: 1, U: 1 }, { U: 2 }],
      cost: { mana: { hybrid: [['W', 'U']] } },
    },
  ],
};

/** Nimbus Maze's white half: {W}, but only while you control an Island. */
const MAZE: CardDefinition = {
  id: 'Maze',
  name: 'Maze',
  types: ['land'],
  manaAbilities: [
    { produces: [{ C: 1 }] },
    { produces: [{ W: 1 }], restriction: { controlsSubtype: ['island'] } },
  ],
};

/** Mox Opal: metalcraft gates any colour. */
const METAL_MOX: CardDefinition = {
  id: 'MetalMox',
  name: 'Metal Mox',
  types: ['artifact'],
  cost: {},
  manaAbilities: [
    {
      produces: [{ W: 1 }, { U: 1 }, { B: 1 }, { R: 1 }, { G: 1 }],
      restriction: { controlsTypeAtLeast: { type: 'artifact', count: 3 } },
    },
  ],
};

/** Reflecting Pool: any TYPE a land you control could produce (so {C} counts). */
const POOL: CardDefinition = {
  id: 'Pool',
  name: 'Pool',
  types: ['land'],
  manaAbilities: [{ derivedColors: 'landsYouControl', derivedIncludesColorless: true }],
};

/** Exotic Orchard: any COLOR a land an opponent controls could produce. */
const ORCHARD: CardDefinition = {
  id: 'Orchard',
  name: 'Orchard',
  types: ['land'],
  manaAbilities: [{ derivedColors: 'landsOpponentsControl' }],
};

function registry(): EffectRegistry {
  return createEffectRegistry();
}

function act(state: GameState, action: GameAction): GameState {
  const r = applyAction(state, action, DEFAULT_RULES, registry());
  const rejected = r.events.find((e) => e.type === 'actionRejected');
  if (rejected) throw new Error(`unexpected rejection: ${(rejected as { reason: string }).reason}`);
  return r.state;
}

function rejectionOf(state: GameState, action: GameAction): string | undefined {
  const r = applyAction(state, action, DEFAULT_RULES, registry());
  const rejected = r.events.find((e) => e.type === 'actionRejected');
  return rejected ? (rejected as { reason: string }).reason : undefined;
}

function eventsOf(state: GameState, action: GameAction) {
  return applyAction(state, action, DEFAULT_RULES, registry()).events;
}

function newGame(): GameState {
  const { state } = createGame({
    seed: 7,
    decks: { A: deckOf(ISLAND, 40), B: deckOf(ISLAND, 40) },
    registry: registry(),
  });
  return state;
}

/** Put a permanent onto the battlefield untapped and ready (never sick — lands). */
function place(state: GameState, def: CardDefinition, controller: PlayerId): InstanceId {
  const id = state.nextInstanceId++;
  state.battlefield.push({
    instanceId: id,
    def,
    controller,
    owner: controller,
    zone: 'battlefield',
    tapped: false,
    summoningSick: false,
    damageMarked: 0,
    markedByDeathtouch: false,
    counters: {},
  });
  return id;
}

/** Every `tapForMana` mode currently offered for one permanent. */
function offeredModes(state: GameState, id: InstanceId): number[] {
  return generateLegalActions(state)
    .filter((a): a is Extract<GameAction, { kind: 'tapForMana' }> => a.kind === 'tapForMana' && a.instanceId === id)
    .map((a) => a.mode ?? 0);
}

describe('mana ability: a RIDER', () => {
  it('a pain land actually deals the damage, and it is damage rather than life loss', () => {
    const s = newGame();
    const land = place(s, PAIN_LAND, 'A');
    const before = s.players.A.life;
    const events = eventsOf(s, { kind: 'tapForMana', player: 'A', instanceId: land, mode: 1 });
    const damage = events.find((e) => e.type === 'damageDealt');
    expect(damage).toMatchObject({ source: land, target: 'A', amount: 1, combat: false });
    const after = applyAction(s, { kind: 'tapForMana', player: 'A', instanceId: land, mode: 1 }, DEFAULT_RULES, registry());
    expect(after.state.players.A.life).toBe(before - 1);
    // The mana still arrives: the rider is not a replacement for the ability.
    expect(after.state.players.A.manaPool.W).toBe(1);
    // CR 605.3a — a mana ability never uses the stack, whatever else it prints.
    expect(after.state.stack).toHaveLength(0);
  });

  it('the painless mode of the same land costs nothing', () => {
    const s = newGame();
    const land = place(s, PAIN_LAND, 'A');
    const after = act(s, { kind: 'tapForMana', player: 'A', instanceId: land, mode: 0 });
    expect(after.players.A.life).toBe(s.players.A.life);
    expect(after.players.A.manaPool.C).toBe(1);
  });

  it('is a RIDER, not a cost: the land is still usable at 1 life, and kills you', () => {
    const s = newGame();
    const land = place(s, PAIN_LAND, 'A');
    s.players.A.life = 1;
    // Offered — a rider never gates the activation the way a cost does.
    expect(offeredModes(s, land)).toContain(1);
    const after = act(s, { kind: 'tapForMana', player: 'A', instanceId: land, mode: 1 });
    expect(after.players.A.life).toBe(0);
    // Paying yourself to death is legal and lethal; the SBA pass settles it here
    // rather than leaving a corpse holding priority.
    expect(after.gameOver).toBe(true);
  });
});

describe('mana ability: an ADDITIONAL COST', () => {
  it('a life cost is charged, and gates the offer when the life is not there', () => {
    const s = newGame();
    const land = place(s, CONFLUENCE, 'A');
    s.players.A.life = 3;
    const after = act(s, { kind: 'tapForMana', player: 'A', instanceId: land, mode: 2 });
    expect(after.players.A.life).toBe(2);
    expect(after.players.A.manaPool.B).toBe(1);

    // CR 118.4: life pays down to zero and no further, so at exactly 0 the
    // ability is not offered at all — and is refused if asked for anyway.
    const broke = newGame();
    const broke2 = place(broke, CONFLUENCE, 'A');
    broke.players.A.life = 0;
    expect(offeredModes(broke, broke2)).toEqual([]);
    expect(rejectionOf(broke, { kind: 'tapForMana', player: 'A', instanceId: broke2, mode: 0 })).toMatch(
      /enough life/,
    );
  });

  it('a filter land REQUIRES its input mana: unoffered on an empty pool, offered once it is floating', () => {
    const s = newGame();
    const filter = place(s, FILTER_LAND, 'A');
    // Only the free colourless mode is available with nothing floating.
    expect(offeredModes(s, filter)).toEqual([0]);

    const withInput = newGame();
    const filter2 = place(withInput, FILTER_LAND, 'A');
    withInput.players.A.manaPool = { ...withInput.players.A.manaPool, U: 1 };
    expect(offeredModes(withInput, filter2)).toEqual([0, 1, 2, 3]);

    // And it FILTERS: the {U} is consumed, two mana arrive.
    const after = act(withInput, { kind: 'tapForMana', player: 'A', instanceId: filter2, mode: 1 });
    expect(after.players.A.manaPool.U).toBe(0);
    expect(after.players.A.manaPool.W).toBe(2);
  });

  it('the planner funds a cost THROUGH a filter land once the input is floating', () => {
    const s = newGame();
    const filter = place(s, FILTER_LAND, 'A');
    s.players.A.manaPool = { ...s.players.A.manaPool, U: 1 };
    // {W}{W} is unpayable from one floating {U} alone; it is payable by filtering.
    const plan = planManaPayment(s, 'A', { W: 2 }, generateLegalActions(s));
    expect(plan?.map((tap) => tap.instanceId)).toEqual([filter]);
    let live = s;
    for (const tap of plan ?? []) {
      live = act(live, { kind: 'tapForMana', player: 'A', instanceId: tap.instanceId, mode: tap.mode });
    }
    expect(live.players.A.manaPool.W).toBe(2);
    expect(live.players.A.manaPool.U).toBe(0);
  });

  it('KNOWN REACH LIMIT: a filter land is not offered before its input is floating', () => {
    // This pins a real, deliberate consequence rather than a wish. The offer gate
    // for a mana ability's mana component is the FLOATING pool — the same gate
    // `unpayableActivationReason` puts on every other activated ability in this
    // engine — so with an empty pool the filter mode does not exist yet, and the
    // one-shot planner therefore cannot chain Island → filter land inside a single
    // plan. A player (or pilot) reaches it by tapping the funding land first,
    // which is the printed play pattern; what is lost is only the planner's
    // ability to SEE that line while answering "can I afford this?".
    const s = newGame();
    place(s, ISLAND, 'A');
    const filter = place(s, FILTER_LAND, 'A');
    expect(offeredModes(s, filter)).toEqual([0]);
    expect(planManaPayment(s, 'A', { W: 2 }, generateLegalActions(s))).toBeUndefined();
  });
});

describe('mana ability: an ACTIVATION RESTRICTION', () => {
  it('an unmet restriction makes the mode invisible to the offer AND to the planner', () => {
    const s = newGame();
    const maze = place(s, MAZE, 'A');
    expect(offeredModes(s, maze)).toEqual([0]);
    // The planner is built from the offers, so it cannot fund {W} either — the
    // whole point: a source that is unavailable must not be counted on.
    expect(planManaPayment(s, 'A', { W: 1 }, generateLegalActions(s))).toBeUndefined();
    // Refused outright if a client sends it anyway.
    expect(rejectionOf(s, { kind: 'tapForMana', player: 'A', instanceId: maze, mode: 1 })).toBeDefined();
  });

  it('the same mode becomes available the moment the condition is met', () => {
    const s = newGame();
    const maze = place(s, MAZE, 'A');
    place(s, ISLAND, 'A');
    expect(offeredModes(s, maze)).toEqual([0, 1]);
    const plan = planManaPayment(s, 'A', { W: 1 }, generateLegalActions(s));
    expect(plan?.map((tap) => tap.instanceId)).toEqual([maze]);
  });

  it('reads only permanents YOU control', () => {
    const s = newGame();
    const maze = place(s, MAZE, 'A');
    place(s, ISLAND, 'B');
    expect(offeredModes(s, maze)).toEqual([0]);
  });

  it('counts permanents for a metalcraft-style threshold', () => {
    const s = newGame();
    const mox = place(s, METAL_MOX, 'A');
    expect(offeredModes(s, mox)).toEqual([]);
    place(s, METAL_MOX, 'A');
    place(s, METAL_MOX, 'A');
    // Three artifacts on the board now — every mox sees the threshold.
    expect(offeredModes(s, mox)).toEqual([0, 1, 2, 3, 4]);
  });
});

describe('mana ability: BOARD-DERIVED COLOURS', () => {
  it('offers exactly the colours the named lands could produce, and moves with the board', () => {
    const s = newGame();
    const pool = place(s, POOL, 'A');
    // Nothing else on the board: nothing to copy.
    expect(offeredModes(s, pool)).toEqual([]);
    place(s, ISLAND, 'A');
    // Modes are indexed W,U,B,R,G,C — only {U} is derivable.
    expect(offeredModes(s, pool)).toEqual([1]);
    place(s, PLAINS, 'A');
    expect(offeredModes(s, pool)).toEqual([0, 1]);
  });

  it('"any color" never reaches colorless even when a colorless land is there', () => {
    const s = newGame();
    const orchard = place(s, ORCHARD, 'A');
    place(s, landDef('Wastes', 'C'), 'B');
    expect(offeredModes(s, orchard)).toEqual([]);

    // …while "any type" does, which is the one printed word that separates
    // Reflecting Pool from Exotic Orchard.
    const other = newGame();
    const pool = place(other, POOL, 'A');
    place(other, landDef('Wastes', 'C'), 'A');
    expect(offeredModes(other, pool)).toEqual([5]);
  });

  it('reads the OTHER side for an opponent-facing derivation', () => {
    const s = newGame();
    const orchard = place(s, ORCHARD, 'A');
    place(s, ISLAND, 'A');
    expect(offeredModes(s, orchard)).toEqual([]);
    place(s, PLAINS, 'B');
    expect(offeredModes(s, orchard)).toEqual([0]);
  });

  it('two derived sources read each other as producing nothing rather than looping', () => {
    const s = newGame();
    const first = place(s, POOL, 'A');
    place(s, POOL, 'A');
    expect(offeredModes(s, first)).toEqual([]);
  });

  it('the mode list keeps its shape whatever the board says', () => {
    // The mode index is part of the action; a list whose LENGTH moved with the
    // board would make the same action number mean different colours to the
    // generator, the planner and the apply path.
    expect(manaModesOf(POOL)).toHaveLength(6);
    expect(manaModesOf(ORCHARD)).toHaveLength(6);
  });
});

describe('the plain sources are untouched', () => {
  it('a land with no rich ability offers no extras and still taps', () => {
    const s = newGame();
    const island = place(s, ISLAND, 'A');
    expect(offeredModes(s, island)).toEqual([0]);
    const after = act(s, { kind: 'tapForMana', player: 'A', instanceId: island });
    expect(after.players.A.manaPool.U).toBe(1);
    expect(after.players.A.life).toBe(s.players.A.life);
  });
});

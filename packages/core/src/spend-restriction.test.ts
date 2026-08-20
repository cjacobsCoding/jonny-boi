/**
 * **THE SPEND RESTRICTION on produced mana** — "Spend this mana only to cast a
 * creature spell" (Ancient Ziggurat, Somberwald Sage, Eldrazi Temple, Giada,
 * Power Depot).
 *
 * The other four mana-ability shapes decorate the SOURCE. This one colours the
 * MANA, and every way of getting it *almost* right prints a different card —
 * which is what this file exists to refuse:
 *
 *  1. **A restriction that vanishes into the pool** makes Ancient Ziggurat a
 *     strictly better land than the printed one. Any payment path that forgets to
 *     ask is this bug: casting, activating, cycling, a mana ability's own cost,
 *     and the "unless its controller pays {3}" tax are all tested here.
 *  2. **A restriction that outlives its purpose** makes it strictly worse. The
 *     mana must actually PAY for the creature spell it was made for.
 *  3. **Restricted mana that cannot be spent must still empty at end of step**,
 *     like any other mana, and must not silently vanish before then. A pool that
 *     quietly drops what it cannot use is a pool that hides a rules bug.
 *  4. **A clone that drops the restriction** re-opens (1) at every action
 *     boundary — see `clone.test.ts`, which owns that one.
 *  5. **The payment planner must never propose an illegal payment**, and must
 *     prefer to spend the restricted mana FIRST when it legally can: it is the
 *     least flexible resource on the board.
 */

import { describe, expect, it } from 'vitest';
import {
  applyAction,
  canPay,
  createGame,
  DEFAULT_RULES,
  emptyPool,
  generateLegalActions,
  payCost,
  planManaPayment,
  poolTotal,
  restrictedTotal,
  spendPurposeFor,
  usableMana,
  type CardDefinition,
  type GameAction,
  type GameState,
  type InstanceId,
  type ManaSpendRestriction,
  type PlayerId,
} from './index.js';
import { createEffectRegistry, type EffectRegistry } from './effects.js';
import { deckOf, landDef } from './test-fixtures.js';

/** "Spend this mana only to cast a creature spell." */
const CREATURES_ONLY: ManaSpendRestriction = {
  label: 'only to cast a creature spell',
  allow: [{ purpose: 'cast', types: ['creature'] }],
};

/** Power Depot: "…cast artifact spells or activate abilities of artifacts." */
const ARTIFACTS_AND_THEIR_ABILITIES: ManaSpendRestriction = {
  label: 'only to cast artifact spells or activate abilities of artifacts',
  allow: [
    { purpose: 'cast', types: ['artifact'] },
    { purpose: 'activate', types: ['artifact'] },
  ],
};

/** Haven of the Spirit Dragon: "…cast a Dragon creature spell." */
const DRAGONS_ONLY: ManaSpendRestriction = {
  label: 'only to cast a Dragon creature spell',
  allow: [{ purpose: 'cast', types: ['creature'], subtypes: ['dragon'] }],
};

/** Ancient Ziggurat: any colour, creature spells only. */
const ZIGGURAT: CardDefinition = {
  id: 'Ziggurat',
  name: 'Ancient Ziggurat',
  types: ['land'],
  manaAbilities: [
    {
      produces: [{ W: 1 }, { U: 1 }, { B: 1 }, { R: 1 }, { G: 1 }],
      spendRestriction: CREATURES_ONLY,
    },
  ],
};

/** Somberwald Sage: three of one colour, creature spells only. */
const SAGE: CardDefinition = {
  id: 'Sage',
  name: 'Somberwald Sage',
  types: ['creature'],
  power: 1,
  toughness: 1,
  cost: { generic: 2, G: 1 },
  manaAbilities: [{ produces: [{ G: 3 }], spendRestriction: CREATURES_ONLY }],
};

/** Power Depot's restricted mode, on an artifact so its own abilities qualify. */
const DEPOT: CardDefinition = {
  id: 'Depot',
  name: 'Power Depot',
  types: ['artifact', 'land'],
  manaAbilities: [
    { produces: [{ C: 1 }] },
    { produces: [{ G: 1 }], spendRestriction: ARTIFACTS_AND_THEIR_ABILITIES },
  ],
};

const BEAR: CardDefinition = {
  id: 'Bear',
  name: 'Grizzly Bears',
  types: ['creature'],
  subtypes: ['Bear'],
  power: 2,
  toughness: 2,
  cost: { generic: 1, G: 1 },
};

const DRAGON: CardDefinition = {
  id: 'Dragon',
  name: 'Shivan Dragon',
  types: ['creature'],
  subtypes: ['Dragon'],
  power: 5,
  toughness: 5,
  cost: { generic: 1, G: 1 },
};

const BOLT: CardDefinition = {
  id: 'Bolt',
  name: 'Lightning Bolt',
  types: ['instant'],
  cost: { generic: 1, G: 1 },
  effects: [],
};

/** An artifact with a plain mana-costed activated ability. */
const ENGINE: CardDefinition = {
  id: 'Engine',
  name: 'Artifact Engine',
  types: ['artifact'],
  cost: { generic: 1 },
  activated: [{ label: 'Engine', cost: { mana: { G: 1 } }, effects: [] }],
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

function newGame(): GameState {
  const { state } = createGame({
    seed: 11,
    decks: { A: deckOf(landDef('Forest', 'G'), 40), B: deckOf(landDef('Forest', 'G'), 40) },
    registry: registry(),
  });
  return state;
}

/** Pass priority until the given step, so sorcery-speed casts are legal. */
function advanceToStep(state: GameState, target: string, max = 400): GameState {
  let s = state;
  let guard = 0;
  while (s.step !== target && !s.gameOver && guard++ < max) {
    s = act(s, { kind: 'passPriority', player: s.priorityPlayer });
  }
  return s;
}

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

function putInHand(state: GameState, def: CardDefinition, controller: PlayerId): InstanceId {
  const id = state.nextInstanceId++;
  state.players[controller].hand.push({
    instanceId: id,
    def,
    controller,
    owner: controller,
    zone: 'hand',
    tapped: false,
    summoningSick: false,
    damageMarked: 0,
    markedByDeathtouch: false,
    counters: {},
  });
  return id;
}

/** Whether a cast of this instance is currently offered by the engine. */
function castOffered(state: GameState, id: InstanceId): boolean {
  return generateLegalActions(state).some((a) => a.kind === 'castSpell' && a.instanceId === id);
}

// ---------------------------------------------------------------------------

describe('the pool carries the restriction', () => {
  it('tapping a restricted source records the restriction, and the event says so', () => {
    const s = newGame();
    const land = place(s, ZIGGURAT, 'A');
    const r = applyAction(
      s,
      { kind: 'tapForMana', player: 'A', instanceId: land, mode: 4 },
      DEFAULT_RULES,
      registry(),
    );
    const pool = r.state.players.A.manaPool;
    expect(pool.G).toBe(1);
    expect(restrictedTotal(pool)).toBe(1);
    expect(r.events).toContainEqual({
      type: 'manaAdded',
      player: 'A',
      color: 'G',
      amount: 1,
      spendRestriction: 'only to cast a creature spell',
    });
  });

  it('an ordinary source leaves the pool a plain six-colour record — the hot-path shape', () => {
    const s = newGame();
    const forest = place(s, landDef('Forest', 'G'), 'A');
    const after = act(s, { kind: 'tapForMana', player: 'A', instanceId: forest });
    // The `undefined` is the whole hot-path contract: `canPay`/`payCost` short
    // circuit on it. An empty array here would put a length check on the
    // engine's hottest read to describe something that is not there.
    expect(after.players.A.manaPool.restricted).toBeUndefined();
  });
});

describe('a restricted mana pays for what it was printed for, and nothing else', () => {
  it('funds the creature spell', () => {
    const base = newGame();
    const zig = place(base, ZIGGURAT, 'A');
    const forest = place(base, landDef('Forest', 'G'), 'A');
    const bear = putInHand(base, BEAR, 'A');
    const s = advanceToStep(base, 'precombatMain');
    let state = act(s, { kind: 'tapForMana', player: 'A', instanceId: forest });
    state = act(state, { kind: 'tapForMana', player: 'A', instanceId: zig, mode: 4 });
    expect(poolTotal(state.players.A.manaPool)).toBe(2);
    state = act(state, { kind: 'castSpell', player: 'A', instanceId: bear });
    expect(state.stack).toHaveLength(1);
    expect(poolTotal(state.players.A.manaPool)).toBe(0);
  });

  it('does NOT fund an instant — the cast is neither offered nor accepted', () => {
    const base = newGame();
    const zig = place(base, ZIGGURAT, 'A');
    const forest = place(base, landDef('Forest', 'G'), 'A');
    const bolt = putInHand(base, BOLT, 'A');
    const s = advanceToStep(base, 'precombatMain');
    let state = act(s, { kind: 'tapForMana', player: 'A', instanceId: forest });
    state = act(state, { kind: 'tapForMana', player: 'A', instanceId: zig, mode: 4 });
    // Two mana floating, the cost is {1}{G} — and the spell is still unaffordable
    // because one of those two may only pay for a creature.
    expect(poolTotal(state.players.A.manaPool)).toBe(2);
    expect(castOffered(state, bolt)).toBe(false);
    expect(rejectionOf(state, { kind: 'castSpell', player: 'A', instanceId: bolt })).toBe(
      'insufficient mana to cast this spell',
    );
  });

  it('a subtype restriction reads the printed subtype', () => {
    const pool = { ...emptyPool(), G: 1, restricted: [{ color: 'G' as const, amount: 1, restriction: DRAGONS_ONLY }] };
    expect(canPay(pool, { G: 1 }, spendPurposeFor(DRAGON, 'cast'))).toBe(true);
    expect(canPay(pool, { G: 1 }, spendPurposeFor(BEAR, 'cast'))).toBe(false);
  });

  it('a purpose that was never asked for cannot spend restricted mana', () => {
    // The conservative default. A caller that forgets to say what the mana is for
    // gets a PESSIMISTIC answer, never an illegal one.
    const pool = { ...emptyPool(), G: 1, restricted: [{ color: 'G' as const, amount: 1, restriction: CREATURES_ONLY }] };
    expect(canPay(pool, { G: 1 })).toBe(false);
    expect(usableMana(pool, 'G', undefined)).toBe(0);
    expect(usableMana(pool, 'G', spendPurposeFor(BEAR, 'cast'))).toBe(1);
  });
});

describe('cast versus activate are different questions', () => {
  it("Power Depot's mana activates an artifact's ability", () => {
    const s = newGame();
    const depot = place(s, DEPOT, 'A');
    const engine = place(s, ENGINE, 'A');
    let state = act(s, { kind: 'tapForMana', player: 'A', instanceId: depot, mode: 1 });
    expect(restrictedTotal(state.players.A.manaPool)).toBe(1);
    state = act(state, { kind: 'activateAbility', player: 'A', instanceId: engine, abilityIndex: 0 });
    expect(poolTotal(state.players.A.manaPool)).toBe(0);
  });

  it('creature-spell mana does NOT activate an ability, even of a creature', () => {
    const s = newGame();
    const zig = place(s, ZIGGURAT, 'A');
    const engine = place(s, ENGINE, 'A');
    const state = act(s, { kind: 'tapForMana', player: 'A', instanceId: zig, mode: 4 });
    expect(
      rejectionOf(state, { kind: 'activateAbility', player: 'A', instanceId: engine, abilityIndex: 0 }),
    ).toBe('insufficient mana for that ability');
  });
});

describe('restricted mana that cannot be spent still behaves like mana', () => {
  it('is counted by poolTotal, and empties at end of step rather than vanishing early', () => {
    const base = newGame();
    const zig = place(base, ZIGGURAT, 'A');
    const s = advanceToStep(base, 'precombatMain');
    let state = act(s, { kind: 'tapForMana', player: 'A', instanceId: zig, mode: 4 });
    expect(poolTotal(state.players.A.manaPool)).toBe(1);

    // Nothing in hand it could pay for — but it must NOT disappear while the step
    // is still running. A pool that quietly drops what it cannot use is hiding a
    // rules bug, and it is also how a player loses the chance to change their mind.
    state = act(state, { kind: 'passPriority', player: state.priorityPlayer });
    expect(poolTotal(state.players.A.manaPool)).toBe(1);

    // The step ends, and it drains exactly like ordinary mana — with the event.
    const r = applyAction(
      state,
      { kind: 'passPriority', player: state.priorityPlayer },
      DEFAULT_RULES,
      registry(),
    );
    expect(r.events.some((e) => e.type === 'manaPoolEmptied' && e.player === 'A')).toBe(true);
    expect(poolTotal(r.state.players.A.manaPool)).toBe(0);
    expect(restrictedTotal(r.state.players.A.manaPool)).toBe(0);
  });

  it('cannot pay a cost demanded by a resolving effect ("unless its controller pays")', () => {
    // Neither a cast nor an activation, so no printed restriction permits it.
    const pool = { ...emptyPool(), G: 2, restricted: [{ color: 'G' as const, amount: 2, restriction: CREATURES_ONLY }] };
    expect(canPay(pool, { generic: 2 })).toBe(false);
  });
});

describe('payment spends the restricted mana first', () => {
  it('a cost payable either way takes the restricted mana, keeping the flexible one', () => {
    const pool = {
      ...emptyPool(),
      G: 2,
      restricted: [{ color: 'G' as const, amount: 1, restriction: CREATURES_ONLY }],
    };
    const paid = payCost(pool, { G: 1 }, spendPurposeFor(BEAR, 'cast'));
    expect(paid.ok).toBe(true);
    if (!paid.ok) return;
    expect(paid.pool.G).toBe(1);
    // The parcel is gone: it is the mana that was spent, so what remains is the
    // unrestricted mana — which can still pay for anything.
    expect(restrictedTotal(paid.pool)).toBe(0);
    expect(paid.pool.restricted).toBeUndefined();
  });

  it('generic pips prefer the colour holding restricted mana', () => {
    const pool = {
      ...emptyPool(),
      C: 1,
      G: 1,
      restricted: [{ color: 'G' as const, amount: 1, restriction: CREATURES_ONLY }],
    };
    // Generic is normally spent colourless-first. With a restricted G on the
    // table, the G goes instead — it is the mana that would otherwise be stranded.
    const paid = payCost(pool, { generic: 1 }, spendPurposeFor(BEAR, 'cast'));
    expect(paid.ok).toBe(true);
    if (!paid.ok) return;
    expect(paid.pool.G).toBe(0);
    expect(paid.pool.C).toBe(1);
  });

  it('a partly-spendable parcel keeps its remainder', () => {
    const pool = {
      ...emptyPool(),
      G: 3,
      restricted: [{ color: 'G' as const, amount: 3, restriction: CREATURES_ONLY }],
    };
    const paid = payCost(pool, { generic: 1, G: 1 }, spendPurposeFor(BEAR, 'cast'));
    expect(paid.ok).toBe(true);
    if (!paid.ok) return;
    expect(paid.pool.G).toBe(1);
    expect(restrictedTotal(paid.pool)).toBe(1);
  });
});

describe('the payment planner', () => {
  function planFor(state: GameState, def: CardDefinition, kind: 'cast' | 'activate' = 'cast') {
    return planManaPayment(
      state,
      'A',
      def.cost ?? {},
      generateLegalActions(state),
      spendPurposeFor(def, kind),
    );
  }

  it('never plans a tap whose mana this payment could not legally spend', () => {
    const s = newGame();
    place(s, ZIGGURAT, 'A');
    place(s, ZIGGURAT, 'A');
    // Two Ziggurats and a Lightning Bolt: the board makes two mana and the spell
    // costs two, and it is still unfundable. A planner that counted them would
    // hand back a plan the engine then rejects.
    expect(planFor(s, BOLT)).toBeUndefined();
  });

  it('funds a creature spell from the same two Ziggurats', () => {
    const s = newGame();
    place(s, ZIGGURAT, 'A');
    place(s, ZIGGURAT, 'A');
    const plan = planFor(s, BEAR);
    expect(plan).toHaveLength(2);
  });

  it('spends the restricted source BEFORE an equally useful unrestricted one', () => {
    const s = newGame();
    const zig = place(s, ZIGGURAT, 'A');
    place(s, landDef('Forest', 'G'), 'A');
    place(s, landDef('Forest2', 'G'), 'A');
    // {1}{G} from two Forests and a Ziggurat. All three close the same shortfall,
    // so the tie-break decides — and the Ziggurat is the least flexible resource
    // on the board even though it is the one that makes five colours.
    const plan = planFor(s, BEAR);
    expect(plan).toBeDefined();
    expect(plan?.map((tap) => tap.instanceId)).toContain(zig);
  });

  it('still prefers not to kill its controller: pain outranks least-flexible', () => {
    const s = newGame();
    const painful: CardDefinition = {
      id: 'PainfulZiggurat',
      name: 'Painful Ziggurat',
      types: ['land'],
      manaAbilities: [
        {
          produces: [{ G: 1 }],
          rider: { damageToController: 1 },
          spendRestriction: CREATURES_ONLY,
        },
      ],
    };
    place(s, painful, 'A');
    const forest = place(s, landDef('Forest', 'G'), 'A');
    const plan = planManaPayment(
      s,
      'A',
      { G: 1 },
      generateLegalActions(s),
      spendPurposeFor(BEAR, 'cast'),
    );
    expect(plan?.map((tap) => tap.instanceId)).toEqual([forest]);
  });
});

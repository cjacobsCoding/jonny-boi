/**
 * THE ABILITY THAT GIVES BACK EXACTLY WHAT IT TAKES — DESIGN §3.141.
 *
 * `mana-exchange.ts` states the rule: a pure mana exchange is worth nothing when
 * the pool it would leave behind is the pool it started from. This file holds
 * BOTH halves of that claim to account, because only one of them is the bug:
 *
 *  1. the no-op really stops — eight deep-tier games were one turn spent
 *     activating Bog Initiate ~665 times (`soak.test.ts` pins the game itself);
 *  2. **the colour fix really still happens** — the same `{1}: Add {B}` on a red
 *     pool is a genuine fix, and a rule that killed it would be a silent strength
 *     regression wearing a bug fix's clothes. That half is the one a careless
 *     "never activate a mana ability twice" would have broken, so it is driven
 *     end-to-end through the real pilot rather than asserted on the predicate.
 *
 * The last block is the CLASS guard: it reads the shipped card pool rather than a
 * fixture, so the card printed tomorrow that re-opens this shape fails here
 * instead of in a 2,000-game soak nobody runs.
 */

import { describe, expect, it } from 'vitest';
import {
  applyAction,
  createGame,
  createRng,
  emptyPool,
  generateLegalActions,
  type ActivatedAbility,
  type CardDefinition,
  type CardInstance,
  type DeckList,
  type GameAction,
  type GameState,
  type ManaColor,
  type ManaPool,
} from '@jonny-boi/core';
import { buildRegistry, loadCardPool } from '@jonny-boi/cards';
import { createHeuristicPilot } from './heuristic.js';
import { manaExchangeIsNoOp, manaExchangeIsNoOpOnceFunded, pureManaExchange } from './mana-exchange.js';
import { giveHand, landDef } from './test-support.js';

/** Bog Initiate's printed ability (Invasion) — the card the runaway was made of. */
const BOG_INITIATE: CardDefinition = {
  id: 'bog-initiate',
  name: 'Bog Initiate',
  types: ['creature'],
  cost: { generic: 1, B: 1 },
  power: 1,
  toughness: 1,
  activated: [
    {
      cost: { mana: { generic: 1 } },
      effects: [{ primitive: 'addMana', params: { mana: ['B'] } }],
      label: '{1}: add {b}',
    },
  ],
};

/**
 * Agent of Stromgald's `{R}: Add {B}` — the pool's OTHER rider-free mana
 * exchange, and the counter-example this rule has to survive. It can never be a
 * no-op: the `{B}` it makes cannot pay the `{R}` it costs, so the exchange always
 * moves the pool and the pilot must always be allowed to take it.
 */
const AGENT_OF_STROMGALD: CardDefinition = {
  id: 'agent-of-stromgald',
  name: 'Agent of Stromgald',
  types: ['creature'],
  cost: { generic: 1, B: 1 },
  power: 1,
  toughness: 1,
  activated: [
    {
      cost: { mana: { R: 1 } },
      effects: [{ primitive: 'addMana', params: { mana: ['B'] } }],
      label: '{r}: add {b}',
    },
  ],
};

/** A `{T}` rider makes an ability self-limiting — out of scope by construction. */
const TAPPED_FILTER: CardDefinition = {
  id: 'tapped-filter',
  name: 'Tapped Filter',
  types: ['artifact'],
  cost: { generic: 2 },
  activated: [
    {
      cost: { mana: { generic: 1 }, tap: true },
      effects: [{ primitive: 'addMana', params: { mana: ['B'] } }],
      label: '{1}, {t}: add {b}',
    },
  ],
};

/** A ritual: same generic cost, strictly more mana back. Never a no-op. */
const RITUAL: CardDefinition = {
  id: 'ritual-rock',
  name: 'Ritual Rock',
  types: ['artifact'],
  cost: { generic: 2 },
  activated: [
    {
      cost: { mana: { generic: 1 } },
      effects: [{ primitive: 'addMana', params: { mana: ['B', 'B'] } }],
      label: '{1}: add {b}{b}',
    },
  ],
};

/**
 * Basalt Monolith: `{T}: Add {C}{C}{C}` and `{3}: Untap Basalt Monolith` — the
 * SECOND shape of the same runaway. The untap adds no mana, so the credit-side
 * scorer never sees a mana payoff; it sees an untap, and pays the {3} by tapping
 * the Monolith it is about to untap. Soak seed 165826623 did that 523 times in
 * one turn. Read as an exchange, the "produced" side is what the tap makes.
 */
const BASALT_MONOLITH: CardDefinition = {
  id: 'basalt-monolith',
  name: 'Basalt Monolith',
  types: ['artifact'],
  cost: { generic: 3 },
  produces: ['C', 'C', 'C'],
  activated: [
    {
      cost: { mana: { generic: 3 } },
      effects: [{ primitive: 'untapSelf', params: {} }],
      label: '{3}: untap ~',
    },
  ],
};

/** An untap that costs LESS than the tap makes: a real mana engine, never a no-op. */
const GENEROUS_MONOLITH: CardDefinition = {
  ...BASALT_MONOLITH,
  id: 'generous-monolith',
  name: 'Generous Monolith',
  activated: [
    {
      cost: { mana: { generic: 2 } },
      effects: [{ primitive: 'untapSelf', params: {} }],
      label: '{2}: untap ~',
    },
  ],
};

/** A coloured rock with a generic untap: the tap FIXES a colourless pool once. */
const EMERALD_MONOLITH: CardDefinition = {
  ...BASALT_MONOLITH,
  id: 'emerald-monolith',
  name: 'Emerald Monolith',
  produces: ['G', 'G', 'G'],
};

/** An untap on a source whose tap is a CHOICE — not the fixed-bundle shape; no ruling. */
const CHOOSY_MONOLITH: CardDefinition = {
  ...BASALT_MONOLITH,
  id: 'choosy-monolith',
  name: 'Choosy Monolith',
  produces: undefined,
  producesOptions: [{ C: 3 }, { G: 3 }] as CardDefinition['producesOptions'],
};

function poolOf(counts: Partial<Record<ManaColor, number>>): ManaPool {
  return { ...emptyPool(), ...counts };
}

const abilityOf = (def: CardDefinition): ActivatedAbility => def.activated![0]!;

// ---------------------------------------------------------------------------
// The rule itself, as a table. A row is (card, pool, verdict) — adding the next
// shape is a ROW, not a branch.
// ---------------------------------------------------------------------------

describe('a pure mana exchange is worthless exactly when it changes nothing', () => {
  const ROWS: ReadonlyArray<{
    readonly what: string;
    readonly def: CardDefinition;
    readonly pool: ManaPool;
    readonly noOp: boolean;
  }> = [
    {
      what: 'Bog Initiate on an all-black pool — it pays {1} with the {B} it makes back',
      def: BOG_INITIATE,
      pool: poolOf({ B: 1 }),
      noOp: true,
    },
    {
      what: 'Bog Initiate on a red pool — {R} becomes {B}, which is the whole point of a filter',
      def: BOG_INITIATE,
      pool: poolOf({ R: 1 }),
      noOp: false,
    },
    {
      /*
       * A row that was written the other way round first, and the code was right.
       * Core spends generic in C,W,U,B,R,G order, so the `{1}` eats the BLACK —
       * the very mana the ability is about to remake — and the red is never
       * touched. The exchange really does nothing here, and it is only knowable
       * because the prediction runs core's own `payCost` rather than a second
       * opinion about which pip a generic cost takes.
       */
      what: 'Bog Initiate on {B}{R} — the generic pip eats the BLACK it is about to remake',
      def: BOG_INITIATE,
      pool: poolOf({ B: 1, R: 1 }),
      noOp: true,
    },
    {
      what: 'Bog Initiate on an empty pool — unpayable, which is not this rule to answer',
      def: BOG_INITIATE,
      pool: emptyPool(),
      noOp: false,
    },
    {
      what: 'Agent of Stromgald can never fund itself — {B} does not buy {R}',
      def: AGENT_OF_STROMGALD,
      pool: poolOf({ R: 1 }),
      noOp: false,
    },
    {
      what: 'Agent of Stromgald on black mana — unpayable, still not a no-op',
      def: AGENT_OF_STROMGALD,
      pool: poolOf({ B: 2 }),
      noOp: false,
    },
    {
      what: 'a {T} rider is self-limiting — never judged here',
      def: TAPPED_FILTER,
      pool: poolOf({ B: 1 }),
      noOp: false,
    },
    {
      what: 'a ritual grows the pool',
      def: RITUAL,
      pool: poolOf({ B: 1 }),
      noOp: false,
    },
    // ---- the untap-self shape (Basalt Monolith, soak seed 165826623) ----------
    {
      what: 'Basalt Monolith with its own {C}{C}{C} floating — pay 3, untap, tap for 3: identical',
      def: BASALT_MONOLITH,
      pool: poolOf({ C: 3 }),
      noOp: true,
    },
    {
      what: 'Basalt Monolith on {C}{C}{C}{G} — the generic eats the colourless, the pool returns',
      def: BASALT_MONOLITH,
      pool: poolOf({ C: 3, G: 1 }),
      noOp: true,
    },
    {
      what: 'Basalt Monolith on an empty pool — unpayable as offered; the FUNDED check owns that',
      def: BASALT_MONOLITH,
      pool: emptyPool(),
      noOp: false,
    },
    {
      what: 'an untap cheaper than the tap it buys back grows the pool — a real engine, allowed',
      def: GENEROUS_MONOLITH,
      pool: poolOf({ C: 2 }),
      noOp: false,
    },
    {
      what: 'a green rock untapped with colourless mana turns {C}{C}{C} into {G}{G}{G} — a fix, allowed',
      def: EMERALD_MONOLITH,
      pool: poolOf({ C: 3 }),
      noOp: false,
    },
    {
      what: 'the same green rock a second time, on the green it just made — identical, refused',
      def: EMERALD_MONOLITH,
      pool: poolOf({ G: 3 }),
      noOp: true,
    },
    {
      what: 'a source whose tap is a choice is not the fixed-bundle shape — no ruling',
      def: CHOOSY_MONOLITH,
      pool: poolOf({ C: 3 }),
      noOp: false,
    },
  ];

  for (const row of ROWS) {
    it(row.what, () => {
      expect(manaExchangeIsNoOp(abilityOf(row.def), row.def, row.pool)).toBe(row.noOp);
    });
  }

  it('FUNDED by its own tap — the exact loop: nothing floating, the plan taps the Monolith to untap it', () => {
    // This is where seed 165826623 lived. The pool is empty, so the offered
    // check cannot rule; the funding plan is "tap Basalt Monolith for {C}{C}{C}",
    // and after paying the {3} out of that the pool is empty again and the
    // Monolith is untapped — the state it started in.
    // The plan's source must be ON the board: the predictor looks the tap up to
    // check for a spend restriction, and a source it cannot find is "cannot
    // predict", which is (correctly) never a no-op.
    const view = {
      players: { A: { manaPool: emptyPool() } },
      battlefield: [{ instanceId: 1, def: BASALT_MONOLITH }],
    } as unknown as Parameters<typeof manaExchangeIsNoOpOnceFunded>[2];
    const plan = [{ instanceId: 1, production: { C: 3 } }] as unknown as Parameters<typeof manaExchangeIsNoOpOnceFunded>[4];
    expect(manaExchangeIsNoOpOnceFunded(abilityOf(BASALT_MONOLITH), BASALT_MONOLITH, view, 'A', plan)).toBe(true);
    // The control: the cheaper untap nets a mana every cycle, so it is not refused.
    expect(manaExchangeIsNoOpOnceFunded(abilityOf(GENEROUS_MONOLITH), GENEROUS_MONOLITH, view, 'A', plan)).toBe(false);
  });

  it('declines to rule on a pool carrying restricted mana', () => {
    // Equal colour counts do NOT mean an identical pool when some of it may only
    // be spent on a creature spell: turning restricted mana into unrestricted
    // mana is a real gain. The predicate says so rather than guessing.
    const restricted: ManaPool = {
      ...poolOf({ B: 1 }),
      restricted: [{ color: 'B', amount: 1, restriction: { types: ['creature'] } }],
    };
    expect(manaExchangeIsNoOp(abilityOf(BOG_INITIATE), BOG_INITIATE, restricted)).toBe(false);
    // …and the same colour counts WITHOUT the parcels are the no-op they look like,
    // so the row above is the parcels talking and not a typo in the pool.
    expect(manaExchangeIsNoOp(abilityOf(BOG_INITIATE), BOG_INITIATE, poolOf({ B: 1 }))).toBe(true);
  });

  it('declines to rule when the caller could not predict the pool', () => {
    expect(manaExchangeIsNoOp(abilityOf(BOG_INITIATE), BOG_INITIATE, undefined)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The pilot, driven for real.
// ---------------------------------------------------------------------------

function stubDeck(): DeckList {
  return { cards: Array.from({ length: 30 }, (_, i) => landDef(`L${i}`, 'R')) };
}

/** A's precombat main, `board` settled in play, `hand` in hand, nothing on the stack. */
function position(board: readonly CardDefinition[], hand: readonly CardDefinition[]): GameState {
  const { state } = createGame({ seed: 11, decks: { A: stubDeck(), B: stubDeck() } });
  state.step = 'precombatMain';
  state.activePlayer = 'A';
  state.priorityPlayer = 'A';
  state.stack = [];
  state.players.A.hand = [];
  state.players.B.hand = [];
  state.players.A.landsPlayedThisTurn = 1;
  const placed = giveHand(state, 'A', [...board]);
  state.players.A.hand = [];
  for (const card of placed) {
    card.zone = 'battlefield';
    card.summoningSick = false;
    state.battlefield.push(card as CardInstance);
  }
  giveHand(state, 'A', [...hand]);
  return state;
}

/**
 * Play the position forward with the pilot on BOTH seats, and stop when the step
 * ends.
 *
 * Both seats, because an activated ability goes on the STACK (CR 602.2a): a
 * driver that only ever answers for A leaves the ability sitting there, no mana
 * is ever added, and a test asserting "the filter produced black" fails for a
 * reason that has nothing to do with the pilot. That is how this helper was first
 * written, and it is exactly the "green for the wrong reason" shape inverted.
 *
 * One step, because a mana pool empties at end of step (CR 500.4): let the driver
 * run into the next one and the pilot legitimately taps and filters again, so a
 * bound on activations would be counting steps rather than counting the loop.
 * The runaway was always inside ONE main phase.
 */
function drive(start: GameState, plies: number): { state: GameState; actions: GameAction[] } {
  // The REAL primitive bodies, not `createTestRegistry()`: that fixture registry
  // knows only `dealDamage`, so a mana ability resolved through it silently adds
  // nothing and a test asserting on the pool then fails for a reason that has
  // nothing to do with the pilot — which is exactly how the first draft of this
  // file failed. A fixture that resolves a primitive it is about to assert on
  // needs the body that really runs, not a registry that shrugs.
  const reg = buildRegistry();
  const pilot = createHeuristicPilot();
  let state = start;
  const step = state.step;
  const turn = state.turnNumber;
  const actions: GameAction[] = [];
  for (let i = 0; i < plies; i++) {
    if (state.gameOver || state.step !== step || state.turnNumber !== turn) break;
    const legal = generateLegalActions(state);
    const action = pilot.chooseAction({ view: state, legalActions: legal, rng: createRng(4) });
    actions.push(action);
    const result = applyAction(state, action, undefined, reg);
    if (result.events.some((e) => e.type === 'actionRejected')) break;
    state = result.state;
  }
  return { state, actions };
}

/** How many abilities the seat under test activated — never the opponent's. */
const activationsOf = (actions: readonly GameAction[]) =>
  actions.filter((a) => a.kind === 'activateAbility' && a.player === 'A').length;

/** A black removal spell: castable only with {B}, which a red board cannot make. */
const BLACK_SPELL: CardDefinition = {
  id: 'black-spell',
  name: 'Black Spell',
  types: ['sorcery'],
  cost: { B: 1 },
  effects: [{ primitive: 'dealDamage', params: { amount: 2, targets: 'any' } }],
};

describe('the pilot still fixes its colours — the half a blanket ban would break', () => {
  it('turns a Mountain into black mana through Bog Initiate', () => {
    // The ONLY black source here is the Initiate's filter. A pilot that refuses
    // the exchange has no way to make black mana at all, so this fails loudly for
    // a rule that over-reaches.
    const { state, actions } = drive(
      position([BOG_INITIATE, landDef('Mountain', 'R')], [BLACK_SPELL]),
      20,
    );
    expect(
      activationsOf(actions),
      `the pilot never used the filter: ${actions.map((a) => a.kind).join(', ')}`,
    ).toBeGreaterThan(0);
    // …and the black mana is really there, or was really spent on the spell.
    const madeBlack = state.players.A.manaPool.B > 0 || actions.some((a) => a.kind === 'castSpell');
    expect(madeBlack, 'the filter was activated but no black mana came of it').toBe(true);
  });

  it('uses Agent of Stromgald, whose exchange can never be a no-op', () => {
    const { actions } = drive(
      position([AGENT_OF_STROMGALD, landDef('Mountain', 'R')], [BLACK_SPELL]),
      20,
    );
    expect(activationsOf(actions), 'a colour-locked filter was refused').toBeGreaterThan(0);
  });
});

describe('the pilot stops when the exchange cannot change anything', () => {
  it('never activates Bog Initiate on a board that only makes black', () => {
    // The §3.141 runaway, in miniature: a Swamp, the Initiate, and nothing worth
    // casting. Before the fix the pilot tapped the Swamp and then activated for
    // ever; every ply here must be something else.
    const { actions } = drive(position([BOG_INITIATE, landDef('Swamp', 'B')], []), 40);
    expect(
      activationsOf(actions),
      `the exchange was taken anyway: ${actions.map((a) => a.kind).join(', ')}`,
    ).toBe(0);
    /*
     * AND IT DOES NOT TAP THE SWAMP EITHER — an assertion the sabotage pass added,
     * because without it this row was fully GREEN with `poolAfterPlan` ignoring
     * the plan. The funded path plans the taps BEFORE it judges, so a guard asked
     * about the PRE-tap pool finds the cost unpayable, rules "not a no-op", and
     * emits the tap; the offered path then refuses the activation on the next
     * decision. Net effect: no loop, but a land spent on nothing, the mana
     * stranded at end of step (CR 500.4) and a real spell left a source short.
     * "The loop stopped" and "the pilot plays well" are different claims, and this
     * row now makes both.
     */
    expect(
      actions.filter((a) => a.kind === 'tapForMana' && a.player === 'A').length,
      `a land was tapped to fund an activation the pilot then refused: ${actions
        .map((a) => a.kind)
        .join(', ')}`,
    ).toBe(0);
  });

  it('stops after the fixes it can actually make, rather than cycling on them', () => {
    // Two Mountains: the pilot may convert red into black (twice at most — one per
    // red mana), and then the pool is all black and the exchange is dead. A BOUND
    // is exactly what the bug lacked: it managed 665 activations in one turn.
    const { actions } = drive(
      position([BOG_INITIATE, landDef('M1', 'R'), landDef('M2', 'R')], []),
      60,
    );
    expect(
      activationsOf(actions),
      `the exchange never ran out: ${actions.map((a) => a.kind).join(', ')}`,
    ).toBeLessThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------------
// The class, read off the shipped pool.
// ---------------------------------------------------------------------------

describe('the shape, not the card — measured against the real pool', () => {
  const pool = loadCardPool({ onWarn: () => {} });

  it('recognises exactly the rider-free mana-producing activations', () => {
    const riderFree: string[] = [];
    const recognised: string[] = [];
    for (const card of pool.cards) {
      for (const ability of card.activated ?? []) {
        // EVERY effect, not merely SOME — a rider-free `{1}: Add {B}, gain 1
        // life` is not a pure exchange (a life is not mana), and spelling this
        // half as `some` would fail the equality below the day such a card is
        // printed, for a disagreement that was only ever in this test.
        if (!ability.effects.every((e) => e.primitive === 'addMana')) continue;
        if (ability.effects.length === 0) continue;
        const cost = ability.cost;
        const free =
          cost.mana !== undefined &&
          !cost.tap &&
          !cost.sacrificeSelf &&
          !cost.sacrificeAnother &&
          cost.life === undefined &&
          cost.loyalty === undefined;
        if (free) riderFree.push(`${card.name} :: ${ability.label}`);
        if (pureManaExchange(ability)) recognised.push(`${card.name} :: ${ability.label}`);
      }
    }
    // The exclusions in `pureManaExchange` and the exclusions spelled out here are
    // two renderings of one rule; a divergence means the predicate has quietly
    // stopped meaning what its doc says.
    expect(recognised.sort()).toEqual(riderFree.sort());
    // And the class is not empty — a predicate that recognised NOTHING would pass
    // the equality above while guarding no card at all.
    expect(recognised.length, 'the pool prints no pure mana exchange at all').toBeGreaterThan(0);
  });

  it('every pure exchange in the pool is bounded — it cannot repeat on its own output', () => {
    // THE GUARD FOR THE WHOLE CLASS. An exchange whose output pays its own cost
    // can be taken for ever unless the pilot refuses it, so on a pool made of
    // exactly its own output it must either be unpayable (Agent of Stromgald:
    // {B} does not buy {R}) or be ruled a no-op. Anything else is a card with Bog
    // Initiate's shape, and it fails HERE, in a millisecond, instead of in a
    // 2,000-game soak nobody runs.
    const unbounded: string[] = [];
    for (const card of pool.cards) {
      for (const ability of card.activated ?? []) {
        const exchange = pureManaExchange(ability);
        if (!exchange) continue;
        let own = emptyPool();
        for (const color of exchange.produced) own = { ...own, [color]: own[color] + 1 };
        if (!payable(own, ability)) continue; // cannot fund itself: bounded already
        if (!manaExchangeIsNoOp(ability, card, own)) {
          unbounded.push(`${card.name} :: ${ability.label}`);
        }
      }
    }
    expect(unbounded, 'an unbounded self-funding mana exchange is in the pool').toEqual([]);
  });
});

/** Whether this pool can pay the ability's mana cost at all. */
function payable(p: ManaPool, ability: ActivatedAbility): boolean {
  const cost = ability.cost.mana;
  if (!cost) return false;
  let spare = 0;
  for (const color of ['W', 'U', 'B', 'R', 'G', 'C'] as const) {
    const need = cost[color] ?? 0;
    if (p[color] < need) return false;
    spare += p[color] - need;
  }
  return spare >= (cost.generic ?? 0);
}

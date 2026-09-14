/**
 * GRANTED MANA ABILITIES REACH THE MANA SYSTEM (DESIGN §3.143 wave 3, GAP-G).
 *
 * ## The bug this file exists for
 * Wave 2 (GAP-14) made a granted ACTIVATED ability reach `generateLegalActions`.
 * It did not make a granted MANA ability reach the MANA system, because that
 * system asks a different question: `pushManaTapActions`, `applyTapForMana` and
 * `planManaPayment` all read the PRINTED `manaAbilities` / `produces` of the
 * definition. Citanul Hierophants' "Creatures you control have '{T}: Add {G}'"
 * therefore arrived as an ordinary activated ability and was offered as an
 * `activateAbility` — which
 *
 *   - puts a MANA ability on the stack, which CR 605.3a says never happens (it
 *     cannot be responded to, and it can be activated WHILE paying a cost, which
 *     is the only way a mana ability is usually used at all);
 *   - is invisible to `planManaPayment`, which plans `tapForMana` actions and
 *     nothing else. So every pilot and the app's auto-tap could not spend the
 *     mana at all, and the lab's win rates were wrong for every deck playing one.
 *
 * ## What was actually measured (rule 11 — report the honest number)
 * Three cards in the 2026-09-11 pool grant a mana ability: Citanul Hierophants,
 * Sachi (Daughter of Seshiro) and Basal Sliver. THIRTY-SEVEN more PRINT one as an
 * `activated` ability rather than as a `manaAbilities` entry (Blood Pet, Crystal
 * Vein, Composite Golem, the Ramos cycle, the sac-lands …) and are on the same
 * wrong path for the same reason. They are deliberately NOT moved here: the AI
 * lane scores them on the activated path (`packages/ai/src/mana-exchange.ts`,
 * DESIGN §3.141, whose own end-to-end tests COUNT `activateAbility` actions), so
 * moving them is a cross-lane edit. The sweep at the bottom of this file keeps
 * that population measured and visible rather than remembered.
 *
 * ## Why the tests here are shaped the way they are
 * The lesson of the first two waves of this section is that a green test proves
 * nothing about REACH. So nothing here asserts that an accessor returns a value:
 * every claim is driven through the real engine on a real pool card — the action
 * menu a seat plays from, the apply path, and the payment planner a pilot funds
 * its spells with.
 */

import { describe, expect, it } from 'vitest';
import { buildRegistry, loadCardPool } from '@jonny-boi/cards';

import type { ActivatedAbility, CardDefinition } from './card.js';
import { effectiveManaExtrasOf, effectiveManaModesOf, manaAbilityFromActivated } from './card.js';
import type { GameAction } from './actions.js';
import { applyAction, createGame, generateLegalActions } from './engine.js';
import { planManaPayment, tapActionFor } from './mana-plan.js';
import type { CardInstance, GameState, InstanceId } from './state.js';
import { creatureDef, deckOf, landDef } from './test-fixtures.js';

const POOL = loadCardPool({ onWarn: () => {} });
const REGISTRY = buildRegistry();

const FOREST = landDef('Forest', 'G');
const BEAR = creatureDef('bear', 2, 2);

/** A creature that PRINTS a mana ability, so printed and granted modes coexist. */
const ELF: CardDefinition = {
  id: 'test-mana-elf',
  name: 'Test Elf',
  types: ['creature'],
  cost: { G: 1 },
  power: 1,
  toughness: 1,
  produces: ['G'],
};

/** The compiled pool card with this printed name. Fails loudly if it moved. */
function poolCard(name: string): CardDefinition {
  const found = POOL.cards.find((card) => card.name === name);
  expect(found, `${name} is no longer in the compiled pool — pick another witness`).toBeDefined();
  return found as CardDefinition;
}

/** A bare board with nothing on it, ready to have permanents placed. */
function emptyBoard(seed = 11): GameState {
  const created = createGame({ seed, decks: { A: deckOf(FOREST, 20), B: deckOf(FOREST, 20) } });
  const state = created.state;
  state.battlefield = [];
  return state;
}

function place(
  state: GameState,
  def: CardDefinition,
  controller: 'A' | 'B' = 'A',
  tapped = false,
): CardInstance {
  const inst: CardInstance = {
    instanceId: state.nextInstanceId++,
    def,
    controller,
    owner: controller,
    zone: 'battlefield',
    tapped,
    summoningSick: false,
    damageMarked: 0,
    markedByDeathtouch: false,
    counters: {},
    attachedTo: null,
  };
  state.battlefield.push(inst);
  return inst;
}

/** Every action the menu offers that names `id`. */
function actionsFor(state: GameState, id: InstanceId): readonly GameAction[] {
  return generateLegalActions(state).filter(
    (action) => 'instanceId' in action && (action as { instanceId: InstanceId }).instanceId === id,
  );
}

/* -------------------------------------------------------------------------- */
/* Citanul Hierophants — the whole path, end to end                            */
/* -------------------------------------------------------------------------- */

describe('a STATIC that grants a mana ability (Citanul Hierophants)', () => {
  it('offers the granted mana as a tapForMana — and NOT as an activateAbility', () => {
    const state = emptyBoard();
    place(state, poolCard('Citanul Hierophants'));
    const bear = place(state, BEAR);

    const offered = actionsFor(state, bear.instanceId);
    expect(
      offered.map((action) => action.kind),
      'a mana ability offered as an activateAbility uses the stack, which CR 605.3a forbids',
    ).toEqual(['tapForMana']);
    expect(offered[0]).toMatchObject({ kind: 'tapForMana', player: 'A', instanceId: bear.instanceId, mode: 0 });
  });

  it('really produces the mana, without the stack, in ONE action', () => {
    const state = emptyBoard();
    place(state, poolCard('Citanul Hierophants'));
    const bear = place(state, BEAR);

    const tap = actionsFor(state, bear.instanceId)[0] as GameAction;
    const result = applyAction(state, tap, undefined, REGISTRY);

    expect(result.state.players.A.manaPool.G, 'the tap added no mana').toBe(1);
    expect(result.state.stack.length, 'a mana ability must never use the stack').toBe(0);
    const tapped = result.state.battlefield.find((c) => c.instanceId === bear.instanceId);
    expect(tapped?.tapped, '{T} in the granted cost must actually tap the creature').toBe(true);
  });

  it('is SPENDABLE by auto-tap — the half no pilot could reach before', () => {
    const state = emptyBoard();
    place(state, poolCard('Citanul Hierophants'));
    const bear = place(state, BEAR);

    const legal = generateLegalActions(state);
    expect(
      legal.some((action) => action.kind === 'tapForMana' && action.instanceId === bear.instanceId),
      'the bear is the witness: it must be one of the sources the planner may pick',
    ).toBe(true);

    const plan = planManaPayment(state, 'A', { G: 1 }, legal);
    expect(plan, 'the planner declined a payment the board can obviously make').toBeDefined();
    expect(plan).toHaveLength(1);
    // The CLAIM is that the payment was funded entirely by GRANTED mana. Asserted
    // that way rather than by naming one of the two creatures, because Citanul
    // Hierophants grants to "creatures you control" and is itself one of them —
    // pinning the planner's tie-break would be pinning something this test does
    // not care about.
    const source = state.battlefield.find((c) => c.instanceId === (plan as NonNullable<typeof plan>)[0]!.instanceId);
    expect(effectiveManaModesOf(source?.def as CardDefinition, undefined)).toEqual([]);

    // …and the action the plan builds is one the engine actually accepts.
    const applied = applyAction(state, tapActionFor('A', (plan as NonNullable<typeof plan>)[0]!), undefined, REGISTRY);
    expect(applied.state.players.A.manaPool.G).toBe(1);
  });

  it('takes the mana away again the instant the granting permanent leaves', () => {
    // The lifetime is DERIVED, so this is really a check that the fix smuggled in
    // no stored grant — the same guard `statics-granted-activated.test.ts` makes
    // for the ability itself, made here for the MANA.
    const state = emptyBoard();
    const lord = place(state, poolCard('Citanul Hierophants'));
    const bear = place(state, BEAR);
    expect(actionsFor(state, bear.instanceId)).toHaveLength(1);

    state.battlefield = state.battlefield.filter((c) => c.instanceId !== lord.instanceId);
    expect(actionsFor(state, bear.instanceId)).toEqual([]);
  });

  it('a PRINTED mana source keeps mode 0 and takes the grant as mode 1', () => {
    // PRINTED FIRST, then granted — the ordering rule `effectiveActivated` uses,
    // so a mode index a seat is looking at does not shift when a grant appears.
    const state = emptyBoard();
    place(state, poolCard('Citanul Hierophants'));
    const elf = place(state, ELF);

    const modes = actionsFor(state, elf.instanceId)
      .filter((action) => action.kind === 'tapForMana')
      .map((action) => (action as { mode?: number }).mode ?? 0);
    expect(modes).toEqual([0, 1]);

    // Both readers of the mode index must agree on its LENGTH as well as its
    // order — a planner reading a shorter list drops the granted tap silently.
    const granted: readonly ActivatedAbility[] = (poolCard('Citanul Hierophants').statics ?? [])[0]!
      .activated as readonly ActivatedAbility[];
    expect(effectiveManaModesOf(ELF, granted)).toHaveLength(2);
    expect(effectiveManaExtrasOf(ELF, granted)).toHaveLength(2);
  });

  it('refuses an activateAbility that names the granted mana ability anyway', () => {
    // The offer path omits it; a hostile or stale client can still send one, and
    // the two paths must not disagree about which of them owns the ability.
    const state = emptyBoard();
    place(state, poolCard('Citanul Hierophants'));
    const bear = place(state, BEAR);

    const result = applyAction(
      state,
      { kind: 'activateAbility', player: 'A', instanceId: bear.instanceId, abilityIndex: 0 },
      undefined,
      REGISTRY,
    );
    expect(result.state.players.A.manaPool.G).toBe(0);
    expect(result.state.stack.length).toBe(0);
    expect(result.events.map((event) => event.type)).toContain('actionRejected');
  });
});

/* -------------------------------------------------------------------------- */
/* Basal Sliver — a granted ability whose cost prints no {T}                    */
/* -------------------------------------------------------------------------- */

describe('a granted mana ability with NO {T} in its cost (Basal Sliver)', () => {
  it('is offered on a TAPPED host, because being tapped cannot stop it', () => {
    const state = emptyBoard();
    place(state, poolCard('Basal Sliver'));
    const metallic = place(state, poolCard('Metallic Sliver'), 'A', true);

    const offered = actionsFor(state, metallic.instanceId);
    expect(offered.map((action) => action.kind)).toEqual(['tapForMana']);
  });

  it('pays by sacrificing the host and adds both pips', () => {
    const state = emptyBoard();
    place(state, poolCard('Basal Sliver'));
    const metallic = place(state, poolCard('Metallic Sliver'));

    const tap = actionsFor(state, metallic.instanceId)[0] as GameAction;
    const result = applyAction(state, tap, undefined, REGISTRY);

    expect(result.state.players.A.manaPool.B).toBe(2);
    expect(
      result.state.battlefield.some((c) => c.instanceId === metallic.instanceId),
      'Sacrifice ~ must actually sacrifice the host',
    ).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* The closed table itself                                                     */
/* -------------------------------------------------------------------------- */

describe('manaAbilityFromActivated is a CLOSED table that REPORTS rather than guessing', () => {
  const addG = { primitive: 'addMana', params: { mana: ['G'] } } as const;

  const refused: readonly (readonly [string, ActivatedAbility])[] = [
    ['an effect the table does not list', { cost: {}, effects: [addG, { primitive: 'drawCards' }], label: 'x' }],
    ['nothing at all', { cost: {}, effects: [], label: 'x' }],
    ['a loyalty cost (CR 605.1a)', { cost: { loyalty: -2 }, effects: [addG], label: 'x' }],
    ['a sorcery-speed restriction', { cost: {}, effects: [addG], timing: 'sorcery', label: 'x' }],
    ['a "sacrifice two" cost', { cost: { sacrificeCount: 2, sacrificeAnother: {} }, effects: [addG], label: 'x' }],
    [
      'a sacrifice cost that the source itself may pay',
      { cost: { sacrificeAnother: {} }, effects: [addG], label: 'x' },
    ],
    [
      'a symbol outside the colour palette',
      { cost: {}, effects: [{ primitive: 'addMana', params: { mana: ['Q'] } }], label: 'x' },
    ],
    ['no symbol list at all', { cost: {}, effects: [{ primitive: 'addMana', params: {} }], label: 'x' }],
  ];

  it.each(refused)('refuses %s', (_what, ability) => {
    expect(manaAbilityFromActivated(ability)).toBeUndefined();
  });

  it('accepts the two shapes the pool actually grants, and reads the cost correctly', () => {
    const tapForG = manaAbilityFromActivated({ cost: { tap: true }, effects: [addG], label: '{t}: add {g}' });
    expect(tapForG?.produces).toEqual([{ G: 1 }]);
    expect(tapForG?.cost?.noTap, '{T} is in the cost, so this taps').toBeUndefined();

    const sacForBB = manaAbilityFromActivated({
      cost: { sacrificeSelf: true },
      effects: [{ primitive: 'addMana', params: { mana: ['B', 'B'] } }],
      label: 'sac: add {b}{b}',
    });
    expect(sacForBB?.produces).toEqual([{ B: 2 }]);
    expect(sacForBB?.cost, 'no {T} printed ⇒ noTap is the opt-out that must be set').toEqual({
      sacrificeSelf: true,
      noTap: true,
    });
  });

  it('answers the same object identically every time (the memo cannot drift)', () => {
    const ability: ActivatedAbility = { cost: { tap: true }, effects: [addG], label: '{t}: add {g}' };
    expect(manaAbilityFromActivated(ability)).toBe(manaAbilityFromActivated(ability));
  });
});

/* -------------------------------------------------------------------------- */
/* The pool sweep — and the measured sibling class                             */
/* -------------------------------------------------------------------------- */

/**
 * Every activated ability the compiled pool GRANTS through a static, with the
 * subtypes the grant's own filter names — so the sweep below can build a witness
 * the grant actually reaches instead of guessing at one. (No attachment in the
 * pool grants a mana ability today; one that did would not appear here, and the
 * population assertion below is what would notice.)
 */
function grantedAbilitiesInPool(): readonly {
  readonly card: CardDefinition;
  readonly where: string;
  readonly ability: ActivatedAbility;
  readonly subtypes: readonly string[];
}[] {
  const out: { card: CardDefinition; where: string; ability: ActivatedAbility; subtypes: readonly string[] }[] = [];
  for (const card of POOL.cards) {
    for (const ability of card.statics ?? []) {
      for (const granted of ability.activated ?? []) {
        out.push({
          card,
          where: `${card.name} (static)`,
          ability: granted,
          subtypes: (ability.affects?.anyOfSubtypes ?? []).map((subtype) => subtype.toLowerCase()),
        });
      }
    }
  }
  return out;
}

describe('the real card pool', () => {
  const grantedMana = grantedAbilitiesInPool().filter(
    (entry) => manaAbilityFromActivated(entry.ability) !== undefined,
  );

  it('finds the population this fix is for (never vacuously green)', () => {
    // Measured on the 2026-09-11 pool: Citanul Hierophants, Sachi and Basal
    // Sliver. The floor is deliberately below that so a pool edit cannot fail
    // this for no reason, but it can never pass on an empty list.
    expect(
      grantedMana.map((entry) => entry.where),
      'no granted mana ability found in the pool — the sweep is looking in the wrong place',
    ).toContain('Citanul Hierophants (static)');
    expect(grantedMana.length).toBeGreaterThanOrEqual(3);
  });

  it('every one of them is offered as a tapForMana on a real board', () => {
    // The CLASS guard: adding a card that grants a mana ability cannot land on the
    // broken path, because this drives each one through the actual action menu.
    const unreachable: string[] = [];
    for (const entry of grantedMana) {
      const state = emptyBoard();
      place(state, entry.card);
      // The witness carries exactly the subtypes THIS grant's filter names, read
      // from the card's own data rather than typed in here — a grant added for a
      // new tribe is then swept without editing this file.
      const witness = place(state, {
        ...BEAR,
        id: 'sweep-witness',
        name: 'Sweep Witness',
        subtypes: entry.subtypes,
      });
      const kinds = new Set(actionsFor(state, witness.instanceId).map((action) => action.kind));
      if (!kinds.has('tapForMana')) unreachable.push(entry.where);
    }
    expect(unreachable, 'these grant mana that no seat can tap for').toEqual([]);
  });
});

describe('📌 the measured sibling class, deliberately left where it is', () => {
  /**
   * A PRINTED activated ability that only adds mana is the same shape on the same
   * wrong path (it uses the stack; `planManaPayment` cannot spend it). It is not
   * moved in this edit because `packages/ai`'s §3.141 mana-exchange rule reads
   * those abilities on the activated path and its end-to-end tests COUNT
   * `activateAbility` actions — a cross-lane change, not a core one.
   *
   * This is here so the class stays MEASURED rather than remembered, and so the
   * day the AI lane moves with it, the converter is already known to cover the
   * population rather than a sample of it.
   */
  const printedManaOnly = POOL.cards.flatMap((card) =>
    (card.activated ?? [])
      .filter((ability) => ability.effects.every((effect) => effect.primitive === 'addMana'))
      .filter((ability) => ability.effects.length > 0)
      .map((ability) => ({ name: card.name, ability })),
  );

  it('is still there, and this file knows how big it is', () => {
    // 37 on the 2026-09-11 pool. A floor rather than an equality so a pool edit
    // does not fail it, but it can never pass on an empty list — which is the way
    // a "we left this on purpose" note normally rots into a lie.
    expect(printedManaOnly.length).toBeGreaterThanOrEqual(30);
  });

  it('and the converter already covers the part of it that is representable', () => {
    const convertible = printedManaOnly.filter(
      (entry) => manaAbilityFromActivated(entry.ability) !== undefined,
    );
    // Everything except the "sacrifice an artifact" shapes, whose cost may be paid
    // by the source itself — a `ManaAbilityCost.sacrificeAnother` never can, so the
    // table REFUSES them rather than quietly changing what the card costs.
    expect(convertible.length).toBeGreaterThanOrEqual(30);
  });
});

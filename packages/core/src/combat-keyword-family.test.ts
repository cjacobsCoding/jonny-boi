/**
 * THE COMBAT KEYWORD FAMILY (DESIGN §3.107) — the rules that are NOT triggers:
 * shadow, landwalk, "can block only creatures with flying", "can't be blocked
 * by more than one creature", split second, and the attack-declaration rules
 * ("attacks each combat if able", "can't attack unless defending player
 * controls an Island"). The trigger-shaped members (exalted, flanking, rampage,
 * the self-pump combat triggers) live in `combat-subject-triggers.test.ts`.
 *
 * Every board here is the printed card's own situation, named after it, and
 * every rule is exercised through the engine's real legality functions — never
 * through a model of the rule.
 *
 * ⚠️ THE FAILURE THESE PREVENT IS NOT A MISSED BLOCK OR ATTACK. A single
 * illegal pair rejects the WHOLE `declareBlockers`; an omitted required
 * attacker rejects the WHOLE `declareAttackers`. Each rule is therefore also
 * mirrored in the pilot (`packages/ai/src/attack-requirements.test.ts`).
 */

import { describe, expect, it } from 'vitest';
import type { CardDefinition, KeywordFlags } from './card.js';
import { blockerCountAllowed, canBlock, illegalBlockDeclaration } from './internal/combat.js';
import { indexContinuous } from './internal/continuous.js';
import { effectiveKeywords, mergeKeywordGrant } from './internal/stats.js';
import { forcedBlockAssignment } from './internal/block-solver.js';
import { generateLegalActions } from './engine.js';
import type { CardInstance, GameState } from './state.js';
import { creatureDef, giveHand, landDef } from './test-fixtures.js';
import {
  act,
  advanceTo,
  eventsNamed,
  actWithEvents,
  newGame,
  onBattlefield,
  pass,
  putOnBattlefield,
  registryWith,
  rejectionOf,
} from './conformance/harness.js';
import { SPLIT_SECOND_REJECTION, splitSecondOnStack } from './split-second.js';
import { attackDeclarationProblem, requiredAttackerIds } from './attack-requirements.js';

const registry = registryWith({ noop: () => {} });

const BEAR = creatureDef('Bear', 2, 2);
const FLIER = creatureDef('Flier', 2, 2, { keywords: { flying: true } });

/** The printed cards, as definitions carrying exactly their keyword payloads. */
const DAUTHI_MERCENARY = creatureDef('Dauthi Mercenary', 2, 1, { keywords: { shadow: true } });
const PALE_BEARS = creatureDef('Pale Bears', 2, 2, { keywords: { landwalk: [{ kind: 'subtype', subtype: 'island' }] } });
const AYUMI = creatureDef('Ayumi, the Last Visitor', 7, 3, { keywords: { landwalk: [{ kind: 'legendary' }] } });
const DRYAD_SOPHISTICATE = creatureDef('Dryad Sophisticate', 2, 1, { keywords: { landwalk: [{ kind: 'nonbasic' }] } });
const WELKIN_TERN = creatureDef('Welkin Tern', 2, 1, {
  keywords: { flying: true, blockOnly: { attackerMustHaveAnyOf: ['flying'] } },
});
const NORWOOD_RIDERS = creatureDef('Norwood Riders', 3, 3, { keywords: { maxBlockers: 1 } });
const GOBLIN_BRIGAND = creatureDef('Goblin Brigand', 2, 2, { keywords: { mustAttack: true } });
const SEA_MONSTER = creatureDef('Sea Monster', 6, 6, {
  keywords: { cantAttackUnlessDefenderControls: [{ kind: 'subtype', subtype: 'island' }] },
});

/** A land with the Island SUBTYPE — landwalk reads the type line, not the name. */
const ISLAND: CardDefinition = { ...landDef('Island', 'U'), subtypes: ['Island'] };
const MOUNTAIN: CardDefinition = { ...landDef('Mountain', 'R'), subtypes: ['Mountain'] };
/** A dual printing the Island subtype — an Island for landwalk, as printed. */
const TROPICAL_ISLAND: CardDefinition = { ...landDef('Tropical Island', 'U'), subtypes: ['Forest', 'Island'] };
/** A legendary land, for legendary landwalk. */
const LEGENDARY_LAND: CardDefinition = { ...landDef('Urza\'s Saga', 'C'), legendary: true };
/** A BASIC Island: the basic supertype is what nonbasic landwalk reads. */
const BASIC_ISLAND: CardDefinition = { ...ISLAND, basic: true };

/** A game at A's declare-attackers step with the given creatures already on the board. */
function atDeclareAttackers(mine: readonly CardDefinition[], theirs: readonly CardDefinition[] = []): {
  readonly state: GameState;
  readonly mine: readonly CardInstance[];
  readonly theirs: readonly CardInstance[];
} {
  const state = newGame({ registry });
  const placedMine = mine.map((def) => putOnBattlefield(state, 'A', def));
  const placedTheirs = theirs.map((def) => putOnBattlefield(state, 'B', def));
  const declare = advanceTo(state, 'declareAttackers', registry);
  return { state: declare, mine: placedMine, theirs: placedTheirs };
}

// --- shadow (CR 702.28b) -------------------------------------------------------------

describe('shadow — can block or be blocked by only creatures with shadow', () => {
  function pair(attackerDef: CardDefinition, blockerDef: CardDefinition): boolean {
    const state = newGame();
    const attacker = putOnBattlefield(state, 'A', attackerDef);
    const blocker = putOnBattlefield(state, 'B', blockerDef);
    return canBlock(attacker, blocker, indexContinuous(state), state.battlefield);
  }

  it('a Dauthi Mercenary is unblockable by a creature without shadow', () => {
    expect(pair(DAUTHI_MERCENARY, BEAR)).toBe(false);
  });

  it('a Dauthi Mercenary is blocked by another shadow creature', () => {
    expect(pair(DAUTHI_MERCENARY, DAUTHI_MERCENARY)).toBe(true);
  });

  it('⚠️ the rule is SYMMETRIC: a shadow creature cannot block a creature without shadow', () => {
    // CR 702.28b's second half, and the half an evasion-only implementation
    // forgets: a Soltari Foot Soldier is not a wall.
    expect(pair(BEAR, DAUTHI_MERCENARY)).toBe(false);
  });

  it('flying and reach are no substitute for shadow', () => {
    expect(pair(DAUTHI_MERCENARY, FLIER)).toBe(false);
  });
});

// --- landwalk (CR 702.18b) -----------------------------------------------------------

describe('landwalk — unblockable while the DEFENDING player controls the named land', () => {
  function blockable(attackerDef: CardDefinition, lands: ReadonlyArray<readonly [CardDefinition, 'A' | 'B']>): boolean {
    const state = newGame();
    const attacker = putOnBattlefield(state, 'A', attackerDef);
    const blocker = putOnBattlefield(state, 'B', BEAR);
    for (const [land, controller] of lands) putOnBattlefield(state, controller, land);
    return canBlock(attacker, blocker, indexContinuous(state), state.battlefield);
  }

  it('Pale Bears cannot be blocked while the defender controls an Island', () => {
    expect(blockable(PALE_BEARS, [[ISLAND, 'B']])).toBe(false);
  });

  it('Pale Bears CAN be blocked when the defender controls no Island', () => {
    expect(blockable(PALE_BEARS, [[MOUNTAIN, 'B']])).toBe(true);
    expect(blockable(PALE_BEARS, [])).toBe(true);
  });

  it('⚠️ it is the DEFENDER\'s lands that count, not the attacker\'s', () => {
    // An islandwalker whose own controller has Islands is not unblockable.
    expect(blockable(PALE_BEARS, [[ISLAND, 'A']])).toBe(true);
  });

  it('a dual land with the Island subtype is an Island (Tropical Island)', () => {
    expect(blockable(PALE_BEARS, [[TROPICAL_ISLAND, 'B']])).toBe(false);
  });

  it('legendary landwalk reads the legendary supertype (Ayumi, the Last Visitor)', () => {
    expect(blockable(AYUMI, [[LEGENDARY_LAND, 'B']])).toBe(false);
    expect(blockable(AYUMI, [[ISLAND, 'B']])).toBe(true);
  });

  it('nonbasic landwalk reads the basic supertype (Dryad Sophisticate)', () => {
    expect(blockable(DRYAD_SOPHISTICATE, [[TROPICAL_ISLAND, 'B']])).toBe(false);
    expect(blockable(DRYAD_SOPHISTICATE, [[BASIC_ISLAND, 'B']])).toBe(true);
  });

  it('a caller that passes no battlefield is asserting the defender has no lands', () => {
    // The documented default — every real caller passes the live board.
    const state = newGame();
    const attacker = putOnBattlefield(state, 'A', PALE_BEARS);
    const blocker = putOnBattlefield(state, 'B', BEAR);
    putOnBattlefield(state, 'B', ISLAND);
    expect(canBlock(attacker, blocker, indexContinuous(state))).toBe(true);
    expect(canBlock(attacker, blocker, indexContinuous(state), state.battlefield)).toBe(false);
  });

  it('"if able" agrees with the pair check: an islandwalking lure facing an Island requires nothing', () => {
    // The solver's "able to block" must read the same board the pair check
    // reads, or it would demand a block the engine then refuses.
    const state = newGame();
    const lure = putOnBattlefield(state, 'A', creatureDef('Walking Lure', 2, 2, {
      keywords: { mustBeBlocked: true, landwalk: [{ kind: 'subtype', subtype: 'island' }] },
    }));
    const bear = putOnBattlefield(state, 'B', BEAR);
    putOnBattlefield(state, 'B', ISLAND);
    const index = indexContinuous(state);
    expect(forcedBlockAssignment([lure], [bear], index, state.battlefield)).toBeUndefined();
    expect(illegalBlockDeclaration([lure], [], index, [bear], state.battlefield)).toBeUndefined();
  });

  it('the engine refuses the block in a real declaration', () => {
    const { state, mine, theirs } = atDeclareAttackers([PALE_BEARS], [BEAR, ISLAND]);
    const attacked = act(state, { kind: 'declareAttackers', player: 'A', attackers: [mine[0]!.instanceId] }, registry);
    const blockers = advanceTo(attacked, 'declareBlockers', registry);
    const defending = blockers.priorityPlayer === 'B' ? blockers : pass(blockers, registry);
    expect(
      rejectionOf(
        defending,
        { kind: 'declareBlockers', player: 'B', blocks: [{ blocker: theirs[0]!.instanceId, attacker: mine[0]!.instanceId }] },
        registry,
      ),
    ).toMatch(/cannot block/);
  });
});

// --- "can block only creatures with flying" (CR 509.1b) ------------------------------

describe('"~ can block only creatures with flying" — the BLOCKER\'s own restriction', () => {
  function pair(attackerDef: CardDefinition): boolean {
    const state = newGame();
    const attacker = putOnBattlefield(state, 'A', attackerDef);
    const tern = putOnBattlefield(state, 'B', WELKIN_TERN);
    return canBlock(attacker, tern, indexContinuous(state), state.battlefield);
  }

  it('a Welkin Tern may block a flier', () => {
    expect(pair(FLIER)).toBe(true);
  });

  it('a Welkin Tern may NOT block a ground creature', () => {
    expect(pair(BEAR)).toBe(false);
  });
});

// --- "can't be blocked by more than one creature" (CR 509.1b) ------------------------

describe('"~ can\'t be blocked by more than one creature" — the dual of menace', () => {
  it('one blocker stands, two are refused, none is fine', () => {
    const state = newGame();
    const riders = putOnBattlefield(state, 'A', NORWOOD_RIDERS);
    const one = putOnBattlefield(state, 'B', BEAR);
    const two = putOnBattlefield(state, 'B', BEAR);
    const index = indexContinuous(state);
    const defenders = [one, two];
    expect(illegalBlockDeclaration([riders], [], index, defenders, state.battlefield)).toBeUndefined();
    expect(
      illegalBlockDeclaration([riders], [{ blocker: one.instanceId, attacker: riders.instanceId }], index, defenders, state.battlefield),
    ).toBeUndefined();
    expect(
      illegalBlockDeclaration(
        [riders],
        [
          { blocker: one.instanceId, attacker: riders.instanceId },
          { blocker: two.instanceId, attacker: riders.instanceId },
        ],
        index,
        defenders,
        state.battlefield,
      ),
    ).toMatch(/more than one creature/);
  });
});


/*
 * THE COUNT RULE, ASKED THE WAY AN AI HAS TO ASK IT (DESIGN §3.141).
 *
 * `illegalBlockDeclaration` judges a FINISHED declaration, which is the wrong
 * shape for a pilot deciding whether to put N blockers somewhere — so every AI
 * that needed the answer built its own, and every copy was this rule minus a
 * bound. `blockerCountAllowed` is the same two reads, exported, so there is one
 * answer to "may exactly N block this?" and the AI and the engine share it.
 */
describe('blockerCountAllowed — one predicate, both bounds of CR 509.1b', () => {
  function allowed(def: CardDefinition, count: number): boolean {
    const state = newGame();
    const attacker = putOnBattlefield(state, 'A', def);
    return blockerCountAllowed(attacker, count, indexContinuous(state));
  }
  const MENACER = creatureDef('Menacer', 3, 3, { keywords: { menace: true } });
  const PATHRAZER = creatureDef('Pathrazer of Ulamog', 4, 4, { keywords: { minBlockers: 3 } });
  const BOTH = creatureDef('Locked Out', 3, 3, { keywords: { menace: true, maxBlockers: 1 } });

  it('an unconstrained creature allows any count, zero included', () => {
    for (const n of [0, 1, 2, 3]) expect(allowed(BEAR, n)).toBe(true);
  });

  it('the CAP is a real answer, not the absence of a minimum', () => {
    // The exact hole the pilot's minimum-only mirror had: Norwood Riders (and
    // Bristling Boar) report no minimum, and the mirror read that as "anything
    // goes" — so the gang search paired two blockers onto them.
    expect(allowed(NORWOOD_RIDERS, 0)).toBe(true);
    expect(allowed(NORWOOD_RIDERS, 1)).toBe(true);
    expect(allowed(NORWOOD_RIDERS, 2)).toBe(false);
  });

  it('the MINIMUM is a size, not a boolean', () => {
    expect(allowed(MENACER, 1)).toBe(false);
    expect(allowed(MENACER, 2)).toBe(true);
    // Pathrazer and a menacing 2/2 are NOT the same case — the defect that put
    // two blockers on a three-requirement attacker (§3.121).
    expect(allowed(PATHRAZER, 2)).toBe(false);
    expect(allowed(PATHRAZER, 3)).toBe(true);
  });

  it('a cap and a minimum together leave NO legal block at all', () => {
    expect(allowed(BOTH, 0)).toBe(true);
    expect(allowed(BOTH, 1)).toBe(false);
    expect(allowed(BOTH, 2)).toBe(false);
  });

  it('agrees with the judge that decides the real declaration', () => {
    // The two must never disagree: they are the same rule, and this is the test
    // that fails if one of them is edited alone.
    const state = newGame();
    const riders = putOnBattlefield(state, 'A', NORWOOD_RIDERS);
    const one = putOnBattlefield(state, 'B', BEAR);
    const two = putOnBattlefield(state, 'B', BEAR);
    const index = indexContinuous(state);
    const blocks = [
      { blocker: one.instanceId, attacker: riders.instanceId },
      { blocker: two.instanceId, attacker: riders.instanceId },
    ];
    expect(blockerCountAllowed(riders, blocks.length, index)).toBe(false);
    expect(
      illegalBlockDeclaration([riders], blocks, index, [one, two], state.battlefield),
    ).toMatch(/more than one creature/);
  });
});

// --- the keyword-merge rules ---------------------------------------------------------

describe('the family\'s payloads merge by their own rules (one rule, both merge paths)', () => {
  it('landwalk lists UNION without duplicates', () => {
    const merged = mergeKeywordGrant(
      { landwalk: [{ kind: 'subtype', subtype: 'island' }] },
      { landwalk: [{ kind: 'subtype', subtype: 'island' }, { kind: 'subtype', subtype: 'swamp' }] },
    );
    expect(merged.landwalk).toEqual([
      { kind: 'subtype', subtype: 'island' },
      { kind: 'subtype', subtype: 'swamp' },
    ]);
  });

  it('a blocker cap takes the MINIMUM — the stricter cap is in force', () => {
    expect(mergeKeywordGrant({ maxBlockers: 2 }, { maxBlockers: 1 }).maxBlockers).toBe(1);
    expect(mergeKeywordGrant({ maxBlockers: 1 }, { maxBlockers: 3 }).maxBlockers).toBe(1);
  });

  it('"can block only" lists INTERSECT — the one attacker must satisfy both lines', () => {
    const merged = mergeKeywordGrant(
      { blockOnly: { attackerMustHaveAnyOf: ['flying', 'reach'] } },
      { blockOnly: { attackerMustHaveAnyOf: ['flying'] } },
    );
    expect(merged.blockOnly?.attackerMustHaveAnyOf).toEqual(['flying']);
  });

  it('a GRANTED landwalk reaches the effective keyword set through the continuous layer', () => {
    // The `grantInto` half of the same rule: a walk granted until end of turn is
    // read by `canBlock` exactly as a printed one.
    const state = newGame();
    const bear = putOnBattlefield(state, 'A', BEAR);
    const blocker = putOnBattlefield(state, 'B', BEAR);
    putOnBattlefield(state, 'B', ISLAND);
    const grant: KeywordFlags = { landwalk: [{ kind: 'subtype', subtype: 'island' }] };
    state.continuous.push({
      id: state.nextInstanceId++,
      targetInstanceId: bear.instanceId,
      sourceInstanceId: bear.instanceId,
      duration: 'endOfTurn',
      power: 0,
      toughness: 0,
      keywords: grant,
    });
    const index = indexContinuous(state);
    expect(effectiveKeywords(bear, index.get(bear.instanceId)).landwalk).toEqual(grant.landwalk);
    expect(canBlock(bear, blocker, index, state.battlefield)).toBe(false);
  });
});

// --- split second (CR 702.61) --------------------------------------------------------

describe('split second — while the spell is on the stack, nobody casts or activates', () => {
  const SUDDEN_SHOCK: CardDefinition = {
    id: 'sudden-shock',
    name: 'Sudden Shock',
    types: ['instant'],
    cost: { R: 1 },
    keywords: { splitSecond: true },
    effects: [{ primitive: 'noop' }],
  };
  const PLAIN_SHOCK: CardDefinition = { ...SUDDEN_SHOCK, id: 'shock', name: 'Shock', keywords: {} };
  const RESPONSE: CardDefinition = { id: 'response', name: 'Response', types: ['instant'], cost: { R: 1 }, effects: [{ primitive: 'noop' }] };
  const PINGER = creatureDef('Pinger', 1, 1, { keywords: {} });
  const PINGER_WITH_ABILITY: CardDefinition = {
    ...PINGER,
    activated: [{ cost: { tap: true }, effects: [{ primitive: 'noop' }], label: 'ping' }],
  };

  /** A casts `spell` with priority; returns the state with the spell on the stack. */
  function castByA(spell: CardDefinition): { readonly state: GameState; readonly response: CardInstance } {
    const state = advanceTo(newGame({ registry }), 'precombatMain', registry);
    state.players.A.hand = [];
    state.players.B.hand = [];
    const [card] = giveHand(state, 'A', [spell]);
    const [response] = giveHand(state, 'A', [RESPONSE]);
    const land = putOnBattlefield(state, 'A', MOUNTAIN);
    putOnBattlefield(state, 'A', MOUNTAIN);
    putOnBattlefield(state, 'A', PINGER_WITH_ABILITY);
    let s = act(state, { kind: 'tapForMana', player: 'A', instanceId: land.instanceId }, registry);
    s = act(s, { kind: 'castSpell', player: 'A', instanceId: card!.instanceId }, registry);
    return { state: s, response: response! };
  }

  it('the offer pass withdraws casts and non-mana activations, and keeps mana and passing', () => {
    const { state } = castByA(SUDDEN_SHOCK);
    expect(splitSecondOnStack(state)).toBe(true);
    const kinds = new Set(generateLegalActions(state).map((a) => a.kind));
    expect(kinds.has('castSpell')).toBe(false);
    expect(kinds.has('activateAbility')).toBe(false);
    expect(kinds.has('cycleCard')).toBe(false);
    expect(kinds.has('passPriority')).toBe(true);
    // The untapped Mountain's mana ability is still offered (CR 702.61b).
    expect(kinds.has('tapForMana')).toBe(true);
  });

  it('the apply path refuses a cast and an activation that bypassed the menu', () => {
    const { state, response } = castByA(SUDDEN_SHOCK);
    const untapped = state.battlefield.find((p) => p.def.name === 'Mountain' && !p.tapped)!;
    const withMana = act(state, { kind: 'tapForMana', player: 'A', instanceId: untapped.instanceId }, registry);
    expect(
      rejectionOf(withMana, { kind: 'castSpell', player: 'A', instanceId: response.instanceId }, registry),
    ).toBe(SPLIT_SECOND_REJECTION);
    const pinger = withMana.battlefield.find((p) => p.def.name === 'Pinger')!;
    expect(
      rejectionOf(withMana, { kind: 'activateAbility', player: 'A', instanceId: pinger.instanceId, abilityIndex: 0 }, registry),
    ).toBe(SPLIT_SECOND_REJECTION);
  });

  it('the lock is the SPELL\'s, not the stack\'s: an ordinary spell locks nothing', () => {
    const { state } = castByA(PLAIN_SHOCK);
    expect(splitSecondOnStack(state)).toBe(false);
    const withMana = act(
      state,
      { kind: 'tapForMana', player: 'A', instanceId: state.battlefield.find((p) => p.def.name === 'Mountain' && !p.tapped)!.instanceId },
      registry,
    );
    expect(generateLegalActions(withMana).some((a) => a.kind === 'castSpell')).toBe(true);
    expect(generateLegalActions(withMana).some((a) => a.kind === 'activateAbility')).toBe(true);
  });

  it('the lock lifts the moment the spell resolves', () => {
    const { state } = castByA(SUDDEN_SHOCK);
    const resolved = pass(pass(state, registry), registry);
    expect(resolved.stack).toHaveLength(0);
    expect(splitSecondOnStack(resolved)).toBe(false);
  });
});

// --- attack requirements and restrictions (CR 508.1c/d) ------------------------------

describe('"~ attacks each combat if able" — an attack REQUIREMENT (CR 508.1d)', () => {
  it('a declaration that leaves a Goblin Brigand home is illegal', () => {
    const { state, mine } = atDeclareAttackers([GOBLIN_BRIGAND, BEAR]);
    const [brigand, bear] = mine as [CardInstance, CardInstance];
    expect(rejectionOf(state, { kind: 'declareAttackers', player: 'A', attackers: [bear.instanceId] }, registry)).toMatch(
      /Goblin Brigand attacks each combat if able/,
    );
    expect(rejectionOf(state, { kind: 'declareAttackers', player: 'A', attackers: [] }, registry)).toMatch(
      /Goblin Brigand/,
    );
    expect(
      rejectionOf(state, { kind: 'declareAttackers', player: 'A', attackers: [bear.instanceId, brigand.instanceId] }, registry),
    ).toBeUndefined();
  });

  it('passing the step declares exactly the required creatures, through the real commit', () => {
    const { state, mine } = atDeclareAttackers([GOBLIN_BRIGAND, BEAR]);
    const [brigand, bear] = mine as [CardInstance, CardInstance];
    // Both players pass with nothing declared: the engine performs the forced
    // minimum itself rather than skipping the step or refusing the pass.
    const afterA = pass(state, registry);
    const { state: afterB, events } = actWithEvents(afterA, { kind: 'passPriority', player: afterA.priorityPlayer }, registry);
    expect(afterB.step).toBe('declareAttackers');
    expect(afterB.combat?.attackersDeclared).toBe(true);
    expect(afterB.combat?.attackers).toEqual([brigand.instanceId]);
    expect(eventsNamed(events, 'attackersDeclared')).toHaveLength(1);
    // The forced declaration is a real one: the Brigand tapped, the Bear did not.
    expect(onBattlefield(afterB, brigand.instanceId)?.tapped).toBe(true);
    expect(onBattlefield(afterB, bear.instanceId)?.tapped).toBe(false);
    // …and priority is the active player's again, with attackers declared.
    expect(afterB.priorityPlayer).toBe('A');
    // The combat then proceeds normally into declare-blockers.
    expect(advanceTo(afterB, 'declareBlockers', registry).combat?.attackers).toEqual([brigand.instanceId]);
  });

  it('"if able" is real: a tapped Brigand requires nothing, and the step passes empty', () => {
    const state = newGame({ registry });
    putOnBattlefield(state, 'A', GOBLIN_BRIGAND, { tapped: true });
    const declare = advanceTo(state, 'declareAttackers', registry);
    expect(requiredAttackerIds(declare, indexContinuous(declare), 'B')).toHaveLength(0);
    const after = pass(pass(declare, registry), registry);
    // ⚠️ The step is END OF COMBAT, not declare-blockers: nothing was declared,
    // and CR 508.8 skips the declare-blockers and combat-damage steps when no
    // creature attacks (§3.119, bug report 20260901_205742 — the defender was
    // being asked to declare blocks against nothing). What this test is ABOUT
    // is unchanged and still asserted: a tapped Brigand forces no declaration.
    expect(after.step).toBe('endCombat');
    expect(after.combat?.attackers).toEqual([]);
  });

  it('a summoning-sick Brigand is not able either', () => {
    const state = newGame({ registry });
    putOnBattlefield(state, 'A', GOBLIN_BRIGAND, { summoningSick: true });
    const declare = advanceTo(state, 'declareAttackers', registry);
    expect(requiredAttackerIds(declare, indexContinuous(declare), 'B')).toHaveLength(0);
  });

  it('an ordinary board pays nothing: no requirement, no forced declaration', () => {
    const { state } = atDeclareAttackers([BEAR]);
    const after = pass(pass(state, registry), registry);
    // End of combat, for the CR 508.8 reason above (§3.119). The point of this
    // test — an unrequired Bear is never declared for the player — is unchanged.
    expect(after.step).toBe('endCombat');
    expect(after.combat?.attackers).toEqual([]);
  });
});

describe('"~ can\'t attack unless defending player controls an Island" — an attack RESTRICTION (CR 508.1c)', () => {
  it('a Sea Monster is not offered, and is refused, while the defender controls no Island', () => {
    const { state, mine } = atDeclareAttackers([SEA_MONSTER], [MOUNTAIN]);
    expect(generateLegalActions(state).some((a) => a.kind === 'declareAttackers')).toBe(false);
    expect(rejectionOf(state, { kind: 'declareAttackers', player: 'A', attackers: [mine[0]!.instanceId] }, registry)).toMatch(
      /can't attack unless defending player controls an Island/,
    );
  });

  it('a Sea Monster attacks once the defender controls an Island', () => {
    const { state, mine } = atDeclareAttackers([SEA_MONSTER], [ISLAND]);
    const offered = generateLegalActions(state).find((a) => a.kind === 'declareAttackers');
    expect(offered).toBeDefined();
    expect(rejectionOf(state, { kind: 'declareAttackers', player: 'A', attackers: [mine[0]!.instanceId] }, registry)).toBeUndefined();
  });

  it('⚠️ the ATTACKER\'s own Islands do not count', () => {
    const { state } = atDeclareAttackers([SEA_MONSTER, ISLAND], [MOUNTAIN]);
    expect(generateLegalActions(state).some((a) => a.kind === 'declareAttackers')).toBe(false);
  });

  it('a required creature that cannot attack is not required — the two halves read one predicate', () => {
    const state = newGame({ registry });
    const both = putOnBattlefield(state, 'A', creatureDef('Bound Brigand', 2, 2, {
      keywords: { mustAttack: true, cantAttackUnlessDefenderControls: [{ kind: 'subtype', subtype: 'island' }] },
    }));
    const declare = advanceTo(state, 'declareAttackers', registry);
    const index = indexContinuous(declare);
    expect(attackDeclarationProblem(both, effectiveKeywords(both), 'B', declare.battlefield)).toMatch(/Island/);
    expect(requiredAttackerIds(declare, index, 'B')).toHaveLength(0);
  });
});

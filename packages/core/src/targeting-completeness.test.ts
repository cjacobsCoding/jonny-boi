/**
 * RESTRICTION-WORD COMPLETENESS — the §3.49 invariant for the §3.40 class.
 *
 * A restriction word has FIVE homes: the `TargetRestriction` union, the
 * `isTargetRestriction` validator, `isLegalTarget`, the enumerator behind
 * `legalTargetsFor`, and `describeRestriction`. §3.40 was a word given four of
 * the five — the validator miss made `restrictionOfEffects` read the declared
 * word back as `undefined`, the engine offered the activation never, and the
 * gap wore the costume of an AI limitation for a whole release.
 *
 * None of the ~5,300 tests could see it, because each tested a word it KNEW.
 * This file quantifies over `ALL_TARGET_RESTRICTIONS` — the union's runtime
 * form, which `satisfies Record<TargetRestriction, true>` pins to the type in
 * both directions at compile time — so the NEXT word added to the union fails
 * here until every home knows it, without this file ever learning its name:
 *
 *  1. the validator accepts every member (and rejects junk);
 *  2. `restrictionOfEffects` round-trips every member through a declared
 *     `targets` param — the exact read §3.40 broke;
 *  3. `describeRestriction` gives every member a distinct English name;
 *  4. OFFER/LEGALITY AGREEMENT on a zoo board: for every member, the set the
 *     enumerator offers EQUALS the set the legality check accepts, over a
 *     universe holding a candidate of every kind. A word unhandled by the
 *     enumerator offers nothing while the legality fallthrough still accepts
 *     creatures; a word unhandled by the legality check accepts creatures it
 *     never offered — either way the sets split and this goes red.
 *  5. COVERAGE: the zoo is built so every member has at least one legal
 *     candidate — an enumerator that silently returns `[]` for a member
 *     cannot hide behind an empty board.
 *
 * The zoo is hand-authored core data (no cards-package import — core must not
 * depend on it): one permanent of every targetable kind, both graveyards
 * stocked, and a stack holding both spell kinds and both trigger origins for
 * both players.
 */
import { describe, expect, it } from 'vitest';
import type { CardDefinition, GameState, InstanceId, PlayerId } from './index.js';
import { createGame, PLAYER_IDS } from './index.js';
import {
  ALL_TARGET_RESTRICTIONS,
  DEFAULT_TARGET_RESTRICTION,
  describeRestriction,
  isLegalTarget,
  isTargetRestriction,
  legalTargetsFor,
  restrictionOfEffects,
  TARGET_RESTRICTION_PARAM,
  type TargetRestriction,
} from './targeting.js';
import { creatureDef, landDef, spellDef } from './test-fixtures.js';

// --- the zoo -------------------------------------------------------------------------

/** Hand-authored defs, one per targetable kind the restrictions distinguish. */
const BEAR = creatureDef('zoo-bear', 2, 2);
const ANGEL = { ...creatureDef('zoo-angel', 4, 4), subtypes: ['angel'] } as CardDefinition;
const HEXPROOF_BEAR = creatureDef('zoo-hexproof', 1, 3, { keywords: { hexproof: true } });
const ARTIFACT: CardDefinition = { id: 'zoo-artifact', name: 'zoo-artifact', types: ['artifact'] };
const ENCHANTMENT: CardDefinition = { id: 'zoo-enchantment', name: 'zoo-enchantment', types: ['enchantment'] };
const LAND = landDef('zoo-land', 'G');
const WALKER: CardDefinition = { id: 'zoo-walker', name: 'zoo-walker', types: ['planeswalker'], loyalty: 3 };
const BATTLE: CardDefinition = { id: 'zoo-battle', name: 'zoo-battle', types: ['battle'], defense: 3 };
const INSTANT = spellDef('zoo-instant', 'instant', []);
const SORCERY = spellDef('zoo-sorcery', 'sorcery', []);

/** Everything a target reference can be on this state, players included. */
function candidateUniverse(state: GameState): readonly (InstanceId | PlayerId)[] {
  const refs: (InstanceId | PlayerId)[] = [...PLAYER_IDS];
  for (const permanent of state.battlefield) refs.push(permanent.instanceId);
  for (const player of PLAYER_IDS) {
    for (const card of state.players[player].graveyard) refs.push(card.instanceId);
  }
  for (const object of state.stack) refs.push(object.instanceId);
  // One id that names NOTHING — legal for no restriction, offered by none.
  refs.push(999_999 as InstanceId);
  return refs;
}

function placePermanent(state: GameState, def: CardDefinition, controller: PlayerId): InstanceId {
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
    attachedTo: null,
    counters: {},
  });
  return id;
}

function putInGraveyard(state: GameState, def: CardDefinition, owner: PlayerId): InstanceId {
  const id = state.nextInstanceId++;
  state.players[owner].graveyard.push({
    instanceId: id,
    def,
    controller: owner,
    owner,
    zone: 'graveyard',
    tapped: false,
    summoningSick: false,
    damageMarked: 0,
    markedByDeathtouch: false,
    counters: {},
  });
  return id;
}

function putSpellOnStack(state: GameState, def: CardDefinition, controller: PlayerId): InstanceId {
  const id = state.nextInstanceId++;
  state.stack.push({
    kind: 'spell',
    instanceId: id,
    card: {
      instanceId: id,
      def,
      controller,
      owner: controller,
      zone: 'stack',
      tapped: false,
      summoningSick: false,
      damageMarked: 0,
      markedByDeathtouch: false,
      counters: {},
    },
    controller,
    resolvesTo: def.types.includes('instant') || def.types.includes('sorcery') ? 'graveyard' : 'battlefield',
    targets: [],
  });
  return id;
}

function putTriggerOnStack(
  state: GameState,
  controller: PlayerId,
  sourceInstanceId: InstanceId,
  origin?: 'activated',
): InstanceId {
  const id = state.nextInstanceId++;
  state.stack.push({
    kind: 'trigger',
    instanceId: id,
    sourceInstanceId,
    controller,
    effects: [],
    targets: [],
    label: origin === 'activated' ? 'zoo activated ability' : 'zoo triggered ability',
    ...(origin === 'activated' ? { origin } : {}),
  });
  return id;
}

/**
 * A board holding at least one legal candidate for EVERY restriction: creatures
 * (angel and non-angel, yours and theirs), an artifact, an enchantment, a land,
 * a planeswalker, a battle, both graveyards stocked with a creature card and an
 * instant/sorcery card, and a stack carrying an instant spell, a creature
 * spell, and both trigger origins for both players.
 *
 * `withProtectedCreature` adds an opponent-controlled hexproof creature — kept
 * OUT of the main zoo so the universal agreement sweep measures restriction
 * handling alone, and brought in by the known-divergence pin below.
 */
function buildZoo(withProtectedCreature = false): GameState {
  const { state } = createGame({
    seed: 4901,
    decks: {
      A: { cards: Array.from({ length: 40 }, () => LAND) },
      B: { cards: Array.from({ length: 40 }, () => LAND) },
    },
  });
  placePermanent(state, BEAR, 'A');
  placePermanent(state, ANGEL, 'A');
  placePermanent(state, ARTIFACT, 'A');
  placePermanent(state, ENCHANTMENT, 'A');
  placePermanent(state, LAND, 'A');
  placePermanent(state, WALKER, 'A');
  placePermanent(state, BATTLE, 'A');
  placePermanent(state, BEAR, 'B');
  placePermanent(state, ARTIFACT, 'B');
  placePermanent(state, LAND, 'B');
  if (withProtectedCreature) placePermanent(state, HEXPROOF_BEAR, 'B');
  putInGraveyard(state, INSTANT, 'A');
  putInGraveyard(state, BEAR, 'A');
  putInGraveyard(state, SORCERY, 'B');
  putInGraveyard(state, BEAR, 'B');
  const aSpellSource = putSpellOnStack(state, INSTANT, 'A');
  putSpellOnStack(state, BEAR, 'A');
  putSpellOnStack(state, INSTANT, 'B');
  putTriggerOnStack(state, 'A', aSpellSource);
  putTriggerOnStack(state, 'A', aSpellSource, 'activated');
  putTriggerOnStack(state, 'B', aSpellSource);
  return state;
}

/** The two target sets whose agreement IS the invariant, as sorted keys. */
function offerAndLegal(
  state: GameState,
  restriction: TargetRestriction,
  controller: PlayerId | undefined,
): { offered: string[]; legal: string[] } {
  const offered = [...legalTargetsFor(state, restriction, controller)].map(String).sort();
  const legal = candidateUniverse(state)
    .filter((ref) => isLegalTarget(state, restriction, ref, controller))
    .map(String)
    .sort();
  return { offered, legal };
}

// --- 1–3: the three list-shaped homes --------------------------------------------------

describe('every restriction word is known to every home (§3.40 class)', () => {
  it('the validator accepts every member of the union', () => {
    for (const word of ALL_TARGET_RESTRICTIONS) {
      expect(isTargetRestriction(word), `isTargetRestriction('${word}')`).toBe(true);
    }
  });

  it('the validator rejects what is NOT a member', () => {
    for (const junk of ['', 'creatures', 'zzz-not-a-restriction', 'ANY', 42, null, undefined, {}]) {
      expect(isTargetRestriction(junk), `isTargetRestriction(${String(junk)})`).toBe(false);
    }
  });

  it('a declared restriction reads back through restrictionOfEffects — the read §3.40 broke', () => {
    for (const word of ALL_TARGET_RESTRICTIONS) {
      const readBack = restrictionOfEffects([
        { primitive: 'zoo-any-primitive', params: { [TARGET_RESTRICTION_PARAM]: word } },
      ]);
      if (word === DEFAULT_TARGET_RESTRICTION) {
        // 'any' is the default and deliberately not policed (see targeting.ts).
        expect(readBack, `'${word}' is the default`).toBeUndefined();
      } else {
        expect(readBack, `targets: '${word}' must not read back as undefined`).toBe(word);
      }
    }
  });

  it('every member has its own plain-English description', () => {
    const seen = new Map<string, TargetRestriction>();
    for (const word of ALL_TARGET_RESTRICTIONS) {
      const description = describeRestriction(word);
      expect(typeof description, `describeRestriction('${word}')`).toBe('string');
      expect(description.length, `describeRestriction('${word}') is empty`).toBeGreaterThan(0);
      const clash = seen.get(description);
      expect(clash, `'${word}' and '${clash}' share the description "${description}"`).toBeUndefined();
      seen.set(description, word);
    }
  });
});

// --- 4–5: the two behavioural homes, checked against each other ------------------------

describe('offer/legality agreement on the zoo board (§3.36/§3.40 class)', () => {
  it('for every member and every actor, the enumerator and the legality check name the SAME set', () => {
    const zoo = buildZoo();
    for (const word of ALL_TARGET_RESTRICTIONS) {
      for (const controller of ['A', 'B', undefined] as const) {
        const { offered, legal } = offerAndLegal(zoo, word, controller);
        expect(
          offered,
          `'${word}' (controller: ${controller ?? 'unknown'}) — offered ${JSON.stringify(offered)} vs legal ${JSON.stringify(legal)}`,
        ).toEqual(legal);
      }
    }
  });

  it('every member has at least one legal candidate here — an empty menu cannot hide a hole', () => {
    const zoo = buildZoo();
    for (const word of ALL_TARGET_RESTRICTIONS) {
      const offered = legalTargetsFor(zoo, word, 'A');
      expect(offered.length, `'${word}' found nothing to target on a board built to feed it`).toBeGreaterThan(0);
    }
  });
});

// --- a live divergence this invariant found, pinned until it is fixed ------------------

describe('known divergence (found by this invariant, not fixed by it)', () => {
  /**
   * ⚠️ REAL DEFECT, deliberately pinned as `it.fails` rather than papered over:
   * `isLegalTarget('creatureOnBattlefieldOrInGraveyard')` answers the
   * battlefield half WITHOUT the `isTargetableBy` gate, so an OPPONENT'S
   * hexproof creature is accepted by the legality check while the enumerator
   * (correctly) never offers it. A consumer that builds its own action — the
   * apply path re-checks through the same `isLegalTarget` — can therefore aim
   * Angel of Serenity's trigger at a hexproof creature the printed rules
   * protect (CR 115.1c).
   *
   * Fixing it is a one-line core change (route that branch's battlefield half
   * through `isTargetableBy`), which is out of §3.49's test-only scope. When
   * someone makes that fix, THIS `it.fails` flips red and must be promoted to
   * a plain `it` inside the agreement sweep above (drop `withProtectedCreature`
   * special-casing and fold the hexproof creature into the main zoo).
   */
  it.fails('two-zone creature targeting honours hexproof on the battlefield half', () => {
    const zoo = buildZoo(true);
    const { offered, legal } = offerAndLegal(zoo, 'creatureOnBattlefieldOrInGraveyard', 'A');
    expect(offered).toEqual(legal);
  });

  it('the OTHER members agree even with a protected creature on the board', () => {
    const zoo = buildZoo(true);
    for (const word of ALL_TARGET_RESTRICTIONS) {
      if (word === 'creatureOnBattlefieldOrInGraveyard') continue; // pinned above
      for (const controller of ['A', 'B', undefined] as const) {
        const { offered, legal } = offerAndLegal(zoo, word, controller);
        expect(offered, `'${word}' (controller: ${controller ?? 'unknown'})`).toEqual(legal);
      }
    }
  });
});

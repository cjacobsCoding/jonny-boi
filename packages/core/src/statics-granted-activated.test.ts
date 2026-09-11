/**
 * GRANTED ACTIVATED ABILITIES REACH THE BOARD (§3.143 wave 2, GAP-14).
 *
 * ## The bug this file exists for
 * `modificationIsInert` decided whether a continuous modification was worth
 * folding, and it consulted `power`, `toughness` and `keywords` — but not
 * `activated`. A modification whose ENTIRE content is a granted activated
 * ability ("Enchanted creature has \"{T}: …\"", "All Slivers have \"…\"") was
 * therefore judged inert and thrown away before `indexContinuous` ever looked
 * at it. Twenty-eight cards in the shipped pool granted nothing at all, on
 * every board, in every sim, and the win rates the lab produced were wrong for
 * all of them.
 *
 * ## Why nothing caught it
 * Every existing test for a grant used a fixture that ALSO moved a number or
 * granted a keyword, so the modification survived the gate for a reason that
 * had nothing to do with the ability. The unit tests were green and the feature
 * was absent — which is the whole failure shape this wave is closing.
 *
 * So the guards here are deliberately not unit tests of a predicate:
 *
 *  1. **The real pool, swept.** Every card whose only modification content is a
 *     granted activated ability is found from the compiled pool and asserted
 *     non-inert. Adding such a card cannot quietly land on the broken path, and
 *     the sweep prints its own population so it can never pass vacuously.
 *  2. **The engine, end to end.** Two of those cards are put on a real board and
 *     the granted ability must appear in `generateLegalActions` — the menu every
 *     seat plays from. "The accessor returns it" is not the claim; "a player can
 *     actually activate it" is.
 *  3. **Exhaustive by construction.** `modificationIsInert` reads a table keyed
 *     by `keyof Required<PermanentModification>`, so a fifth field stops the
 *     BUILD until it is given a row. This file pins the runtime half: each field
 *     alone is enough to make a modification live.
 */

import { describe, expect, it } from 'vitest';
import { loadCardPool } from '@jonny-boi/cards';

import type { CardDefinition, GameState, InstanceId, PermanentModification } from './index.js';
import {
  attachTo,
  createGame,
  effectiveActivated,
  generateLegalActions,
  indexContinuous,
  modificationIsInert,
  NO_MOD,
} from './index.js';
import type { CardInstance } from './state.js';
// The live-example table is a SHIPPED compile-time proof, imported from the
// module it guards rather than re-declared here — see its doc comment.
import { MODIFICATION_LIVE_EXAMPLES } from './statics.js';
import { creatureDef, deckOf, landDef } from './test-fixtures.js';

/* -------------------------------------------------------------------------- */
/* The pool sweep                                                              */
/* -------------------------------------------------------------------------- */

/** One modification in the pool, with enough context to name it in a failure. */
interface PoolModification {
  /** `"Presence of Gond (attachment)"` — what a failing assertion should print. */
  readonly where: string;
  readonly card: CardDefinition;
  readonly modifies: PermanentModification;
}

const POOL = loadCardPool({ onWarn: () => {} });

/** Every continuous modification the compiled pool declares, statics and attachments alike. */
function poolModifications(): readonly PoolModification[] {
  const out: PoolModification[] = [];
  for (const card of POOL.cards) {
    for (const ability of card.statics ?? []) {
      out.push({ where: `${card.name} (static)`, card, modifies: ability });
    }
    const attachment = card.attachment?.modifies;
    if (attachment !== undefined) {
      out.push({ where: `${card.name} (attachment)`, card, modifies: attachment });
    }
  }
  return out;
}

/**
 * A modification whose ONLY content is a granted activated ability — the exact
 * population GAP-14 silently discarded. Written as "carries an ability AND
 * nothing else would save it" rather than as a call to `modificationIsInert`,
 * because the function under test cannot be its own oracle.
 */
function grantsAbilityAndNothingElse(mod: PermanentModification): boolean {
  if (mod.activated === undefined || mod.activated.length === 0) return false;
  if ((mod.power ?? 0) !== 0 || (mod.toughness ?? 0) !== 0) return false;
  const kw = mod.keywords;
  if (kw === undefined) return true;
  for (const key in kw) {
    if ((kw as Record<string, unknown>)[key]) return false;
  }
  return true;
}

describe('the real card pool — a grant-only modification is LIVE, not inert', () => {
  const activatedOnly = poolModifications().filter((entry) =>
    grantsAbilityAndNothingElse(entry.modifies),
  );

  it('the sweep finds the population it is guarding (never vacuously green)', () => {
    // Measured, not assumed: 28 cards on the 2026-09-11 pool — 12 statics ("All
    // Slivers have …", Citanul Hierophants, Bootleggers' Stash) and 16
    // attachments (Presence of Gond, Viridian Longbow, Splinter Twin, …). The
    // floor is deliberately well under that so the guard survives a pool edit,
    // but it can never pass on an empty list, which is how a sweep dies quietly.
    expect(
      activatedOnly.length,
      'no grant-only modification found in the pool — the sweep is looking in the wrong place',
    ).toBeGreaterThan(10);
  });

  it('names the two the engine test below actually plays, so the sweep and the board agree', () => {
    const named = new Set(activatedOnly.map((entry) => entry.where));
    expect(named).toContain('Presence of Gond (attachment)');
    expect(named).toContain('Darkheart Sliver (static)');
  });

  it('every one of them survives the inertness gate', () => {
    const discarded = activatedOnly
      .filter((entry) => modificationIsInert(entry.modifies))
      .map((entry) => entry.where);
    // Each name here is a card that grants NOTHING on a real board.
    expect(discarded).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/* The engine, end to end                                                      */
/* -------------------------------------------------------------------------- */

const FOREST = landDef('Forest', 'G');
const BEAR = creatureDef('bear', 2, 2);

/** The compiled pool card with this printed name. Fails loudly if it moved. */
function poolCard(name: string): CardDefinition {
  const found = POOL.cards.find((card) => card.name === name);
  expect(found, `${name} is no longer in the compiled pool — pick another witness`).toBeDefined();
  return found as CardDefinition;
}

/** A bare board, ready to have permanents placed on it. */
function emptyBoard(): GameState {
  const created = createGame({ seed: 11, decks: { A: deckOf(FOREST, 20), B: deckOf(FOREST, 20) } });
  const state = created.state;
  state.battlefield = [];
  return state;
}

/** Put a permanent on the battlefield under `controller`, untapped and ready. */
function place(state: GameState, def: CardDefinition, controller: 'A' | 'B' = 'A'): CardInstance {
  const inst: CardInstance = {
    instanceId: state.nextInstanceId++,
    def,
    controller,
    owner: controller,
    zone: 'battlefield',
    tapped: false,
    summoningSick: false,
    damageMarked: 0,
    markedByDeathtouch: false,
    counters: {},
    attachedTo: null,
  };
  state.battlefield.push(inst);
  return inst;
}

/** The abilities a permanent HAS right now, read the way the engine reads them. */
function abilitiesOf(state: GameState, id: InstanceId): readonly { readonly label?: string }[] {
  const perm = state.battlefield.find((c) => c.instanceId === id) as CardInstance;
  return effectiveActivated(perm, indexContinuous(state).get(id) ?? NO_MOD);
}

/** Whether the action menu offers an activation of `id` at `abilityIndex`. */
function offersActivation(state: GameState, id: InstanceId, abilityIndex: number): boolean {
  return generateLegalActions(state).some(
    (action) =>
      action.kind === 'activateAbility' &&
      action.instanceId === id &&
      action.abilityIndex === abilityIndex,
  );
}

describe('an AURA that grants only an ability (Presence of Gond)', () => {
  it('gives its host the ability, and the engine offers it', () => {
    const state = emptyBoard();
    const bear = place(state, BEAR);
    const aura = place(state, poolCard('Presence of Gond'));
    expect(attachTo(state, aura, bear.instanceId, () => {})).toBe(true);

    const abilities = abilitiesOf(state, bear.instanceId);
    expect(
      abilities.map((ability) => ability.label),
      'the bear prints none, so the granted token ability is the whole list',
    ).toEqual(['{t}: create a 1/1 green elf warrior creature token']);
    expect(
      offersActivation(state, bear.instanceId, 0),
      'the ability exists on paper but no seat can reach it',
    ).toBe(true);
  });

  it('and takes it away again the instant the Aura leaves', () => {
    // The lifetime is DERIVED (see the statics.ts header), so this is really a
    // check that the fix did not smuggle in a stored grant.
    const state = emptyBoard();
    const bear = place(state, BEAR);
    const aura = place(state, poolCard('Presence of Gond'));
    attachTo(state, aura, bear.instanceId, () => {});
    state.battlefield = state.battlefield.filter((c) => c.instanceId !== aura.instanceId);

    expect(abilitiesOf(state, bear.instanceId)).toEqual([]);
    expect(offersActivation(state, bear.instanceId, 0)).toBe(false);
  });
});

describe('a STATIC that grants only an ability (Darkheart Sliver)', () => {
  it('gives every Sliver on the board the ability, and the engine offers it', () => {
    const state = emptyBoard();
    place(state, poolCard('Darkheart Sliver'));
    const metallic = place(state, poolCard('Metallic Sliver'));

    const abilities = abilitiesOf(state, metallic.instanceId);
    expect(abilities.map((ability) => ability.label)).toEqual(['Sacrifice ~: you gain 3 life']);
    expect(
      offersActivation(state, metallic.instanceId, 0),
      'a Sliver lord that grants nothing is a lord with no ability at all',
    ).toBe(true);
  });

  it('reaches nothing that is not a Sliver', () => {
    const state = emptyBoard();
    place(state, poolCard('Darkheart Sliver'));
    const bear = place(state, BEAR);

    expect(abilitiesOf(state, bear.instanceId)).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/* The inertness table itself                                                  */
/* -------------------------------------------------------------------------- */

describe('modificationIsInert consults EVERY field', () => {
  /**
   * The rows come from `MODIFICATION_LIVE_EXAMPLES` in SHIPPED source, not from
   * a list retyped here, and that is the whole mechanism: the mapped type over
   * `Required<PermanentModification>` makes a fifth field a COMPILE error until
   * it has a row, and this loop then makes that row a RUNTIME obligation on
   * `modificationIsInert`. Neither half is enough alone — a list living in this
   * file would simply not grow when the interface did, and `tsc` cannot see that
   * a function ignores a field.
   */
  const fields = Object.entries(MODIFICATION_LIVE_EXAMPLES);

  it('the table covers every field of PermanentModification', () => {
    // Belt and braces for the mapped type, which the BUILD checks but which a
    // reader of this file cannot see. `activated` is the row that was missing.
    expect(fields.map(([field]) => field).sort()).toEqual([
      'activated',
      'keywords',
      'power',
      'toughness',
    ]);
  });

  it.each(fields)('a modification live only in %s is NOT inert', (_field, mod) => {
    expect(modificationIsInert(mod)).toBe(false);
  });

  it('a modification carrying nothing at all still IS inert', () => {
    // The whole point of the gate: an empty declaration must stay free.
    expect(modificationIsInert({})).toBe(true);
    expect(modificationIsInert({ power: 0, toughness: 0, keywords: {}, activated: [] })).toBe(true);
  });
});

/**
 * **A SPEND RESTRICTION on produced mana** — "Spend this mana only to cast a
 * creature spell" (Ancient Ziggurat, Somberwald Sage, Eldrazi Temple, Giada).
 *
 * ## Why this is its own system rather than one more `ManaAbility` field
 * The four shapes the mana-ability model already carries — an additional cost, a
 * rider, an "Activate only if…", board-derived colours — all decorate the
 * SOURCE, and are therefore answered by looking at the permanent being tapped.
 * This one decorates the MANA. Once the mana has been added the source is gone
 * from the question entirely: what remains is a pool holding some mana that may
 * pay for anything and some that may not, and the only place that distinction
 * can live is the pool itself.
 *
 * ## The shape of the answer, and why it is not a matching problem
 * A restriction is a PREDICATE over the thing being paid for, written as data (a
 * disjunction of clauses — the printed "or" of "cast artifact spells **or**
 * activate abilities of artifacts"). Crucially, ONE payment funds ONE thing: a
 * `payCost` call pays for a single spell or a single ability, so every pip in it
 * shares the same {@link ManaSpendPurpose}. Each mana in the pool is therefore
 * either usable for this whole payment or usable for none of it — there is no
 * per-pip assignment to search over.
 *
 * That collapses what looks like a bipartite matching problem into a
 * SUBTRACTION: compute, per colour, how much of the pool this purpose may not
 * touch, hide it, and run the payment algorithm that already exists on what is
 * left. Linear in the number of restricted parcels, no search, no exponential
 * blow-up, and — because it is the same algorithm — no second opinion about what
 * a hybrid symbol or a generic pip costs.
 *
 * ## Why the vocabulary is primitive strings rather than a `CardDefinition`
 * `mana.ts` may not import `card.ts` (card.ts imports mana.ts, and a runtime
 * cycle between the two hottest modules in the engine is not worth the
 * convenience). So a purpose is a small, FLAT descriptor of the object being
 * paid for, built once per definition and memoized by `spendPurposeFor` in
 * card.ts. This module imports nothing at runtime at all.
 */

import type { ManaColor } from './mana.js';

/** What a payment is FOR. A mana ability's own cost is an `'activate'`. */
export type ManaSpendKind = 'cast' | 'activate';

/**
 * The object a payment is being made for, reduced to what a restriction can ask
 * about. Built by `spendPurposeFor` (card.ts) and memoized per definition, so a
 * payment on a board that has restricted mana costs one WeakMap lookup rather
 * than an allocation.
 *
 * `types` and `subtypes` are LOWERCASED, because the printed restrictions this
 * matches are read out of lowercased Oracle text by the compiler; case-folding
 * here would run on the payment path instead of once per definition.
 */
export interface ManaSpendPurpose {
  readonly kind: ManaSpendKind;
  /** Lowercased printed card types — 'creature', 'artifact', 'land', … */
  readonly types: readonly string[];
  /** Lowercased printed subtypes — 'dragon', 'eldrazi', 'angel', … */
  readonly subtypes: readonly string[];
  /** Whether the object is legendary ("only to cast a legendary spell"). */
  readonly legendary: boolean;
  /** The object's colours, from its printed pips. Empty means colourless. */
  readonly colors: readonly ManaColor[];
}

/**
 * ONE thing a restricted mana may be spent on. Every field that is PRESENT must
 * hold (they AND together); a field listing several options is satisfied by ANY
 * of them.
 *
 * A clause always names its {@link ManaSpendKind}, because the printed
 * restrictions distinguish the two and getting it wrong in either direction is a
 * different card: Ancient Ziggurat's mana may not activate an ability, while
 * Power Depot's explicitly may.
 */
export interface ManaSpendClause {
  readonly purpose: ManaSpendKind;
  /** "a creature spell" / "artifact spells" — any listed printed type. */
  readonly types?: readonly string[];
  /** "a Dragon spell" / "colorless Eldrazi spells" — any listed printed subtype. */
  readonly subtypes?: readonly string[];
  /** "a legendary spell". */
  readonly legendary?: boolean;
  /** "colorless Eldrazi spells" — the object must have no colour at all. */
  readonly colorless?: boolean;
  /** The object must be at least one of these colours. */
  readonly colors?: readonly ManaColor[];
  /**
   * "…of the chosen type" — Cavern of Souls, Unclaimed Territory, Secluded
   * Courtyard, whose restriction names the creature type the SOURCE itself
   * chose as it entered (`CardInstance.chosenAsEntered`, core's as-enters seam).
   *
   * A DECLARATION, never an answer. The clause on the card definition is shared
   * and immutable, so it cannot hold one permanent's choice; the value is
   * substituted by {@link resolveSpendRestriction} at the moment the mana is
   * MADE, which is the only moment at which both the source and its choice are
   * in hand. What lands in the pool is therefore always a concrete restriction,
   * and no payment path ever has to look a permanent up.
   */
  readonly subtypeChosenBySource?: boolean;
}

/**
 * The restriction printed on a mana ability, carried by every mana that ability
 * adds. DATA, never a per-card branch: `allow` is the printed "or", so
 * "cast artifact spells or activate abilities of artifacts" is two clauses and
 * nothing in the engine knows the name Power Depot.
 */
export interface ManaSpendRestriction {
  /** Printed wording, for the log, the inspector and the About page. */
  readonly label: string;
  /** Satisfied when ANY clause matches. An EMPTY list can never be spent. */
  readonly allow: readonly ManaSpendClause[];
}

/**
 * A parcel of restricted mana floating in a pool.
 *
 * Parcels are IMMUTABLE and are replaced rather than edited, which is what lets
 * `clonePool` copy the array by value and share the parcel objects: a cloned
 * state that later spends restricted mana builds new parcels, so the original
 * cannot observe the change. See `internal/clone.ts` and its test.
 */
export interface RestrictedMana {
  readonly color: ManaColor;
  readonly amount: number;
  readonly restriction: ManaSpendRestriction;
}

/**
 * Substitute the SOURCE's as-entered choice into a printed restriction, giving
 * the concrete restriction the produced mana will carry.
 *
 * Called once per activation of a chosen-type mana ability — never on a payment
 * path. Returns the printed object UNCHANGED (by identity) when no clause names
 * a chosen type, which is every card but three, so the shared frozen restriction
 * keeps being shared.
 *
 * `chosen === undefined` means the permanent named nothing (it declined, or the
 * question was never asked). Those clauses are then DROPPED rather than widened:
 * an unnamed type matches nothing, never everything. A restriction whose every
 * clause drops has an empty `allow`, which is mana that can pay for nothing —
 * faithful, and the safe direction. Widening would hand a Cavern that named
 * nothing the best mana on the board.
 */
export function resolveSpendRestriction(
  restriction: ManaSpendRestriction,
  chosen: string | undefined,
): ManaSpendRestriction {
  if (!restrictionNamesChosenSubtype(restriction)) return restriction;
  const allow: ManaSpendClause[] = [];
  for (const clause of restriction.allow) {
    if (clause.subtypeChosenBySource !== true) {
      allow.push(clause);
      continue;
    }
    if (chosen === undefined) continue;
    const lowered = chosen.toLowerCase();
    const subtypes = clause.subtypes === undefined ? [lowered] : [...clause.subtypes, lowered];
    const { subtypeChosenBySource: _dropped, ...rest } = clause;
    allow.push({ ...rest, subtypes });
  }
  const named = chosen === undefined ? 'nothing' : chosen;
  return { label: `${restriction.label} (${named})`, allow };
}

/** Whether any clause defers to the source's as-entered choice. */
export function restrictionNamesChosenSubtype(restriction: ManaSpendRestriction): boolean {
  for (const clause of restriction.allow) {
    if (clause.subtypeChosenBySource === true) return true;
  }
  return false;
}

/** Whether one clause is satisfied by the object being paid for. */
function clauseAllows(clause: ManaSpendClause, purpose: ManaSpendPurpose): boolean {
  if (clause.purpose !== purpose.kind) return false;
  const types = clause.types;
  if (types !== undefined && !anyOf(types, purpose.types)) return false;
  const subtypes = clause.subtypes;
  if (subtypes !== undefined && !anyOf(subtypes, purpose.subtypes)) return false;
  // An UNRESOLVED chosen-type clause matches nothing. It should never reach a
  // payment — `resolveSpendRestriction` substitutes at production time — but if
  // one ever did, matching everything would be the expensive direction of wrong.
  if (clause.subtypeChosenBySource === true) return false;
  if (clause.legendary === true && !purpose.legendary) return false;
  if (clause.colorless === true && purpose.colors.length > 0) return false;
  const colors = clause.colors;
  if (colors !== undefined && !anyOf(colors, purpose.colors)) return false;
  return true;
}

/** Whether any of `wanted` appears in `have`. Indexed — no iterator allocation. */
function anyOf<T>(wanted: readonly T[], have: readonly T[]): boolean {
  for (let i = 0; i < wanted.length; i++) {
    if (have.includes(wanted[i] as T)) return true;
  }
  return false;
}

/**
 * Whether mana carrying `restriction` may be spent on `purpose`.
 *
 * **`purpose === undefined` means NO**, and that default is load-bearing. A
 * caller that asks "can this pool pay {2}{G}?" without saying what for cannot be
 * told yes about restricted mana, because the honest answer depends on the
 * question it did not ask. Answering conservatively makes a forgotten purpose
 * produce a payment that is merely PESSIMISTIC — the engine declines to offer a
 * cast it could have offered — instead of an ILLEGAL one, which is the failure
 * that would poison a verdict.
 */
export function restrictionAllows(
  restriction: ManaSpendRestriction,
  purpose: ManaSpendPurpose | undefined,
): boolean {
  if (purpose === undefined) return false;
  const allow = restriction.allow;
  for (let i = 0; i < allow.length; i++) {
    if (clauseAllows(allow[i] as ManaSpendClause, purpose)) return true;
  }
  return false;
}

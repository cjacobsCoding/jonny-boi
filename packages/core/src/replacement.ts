/**
 * REPLACEMENT AND PREVENTION EFFECTS (CR 614 / CR 615) — the card-facing
 * declaration half. The engine half is `internal/replacement.ts`.
 *
 * A replacement effect never goes on the stack and never "happens": it watches
 * for an event that *would* happen and changes what happens instead. Three
 * printed families share one shape underneath, which is why this is one layer
 * and not three special cases:
 *
 *   - **counters** — "If one or more +1/+1 counters would be put on a creature
 *     you control, that many **plus one** are put on it instead" (Hardened
 *     Scales, Corpsejack Menace, Doubling Season's counter half).
 *   - **damage** — "If a source you control would deal damage to a permanent or
 *     player, it deals **double** that damage instead" (Gratuitous Violence,
 *     Fiery Emancipation, Torbran's "plus 2"), and its mirror image, PREVENTION
 *     ("prevent all combat damage that would be dealt this turn" — every fog).
 *   - **draws** — "If you would draw a card …, draw two cards instead", "if you
 *     would draw a card while your library has no cards in it, you **win the
 *     game** instead" (Laboratory Maniac).
 *
 * The three differ only in WHAT is being replaced. They share the applicability
 * filter ({@link ReplacementApplies}), the modification ({@link ReplacementOutcome}),
 * the CR 614.5 once-per-event rule and the CR 616.1 ordering — all of which live
 * in exactly one place, `internal/replacement.ts`.
 *
 * ## Two lifetimes, one vocabulary
 *  1. **Printed on a permanent** — `CardDefinition.replacements`, a static
 *     ability that is live for exactly as long as its source is on the
 *     battlefield. DERIVED, never stored, for the same reason anthems are
 *     (`internal/continuous.ts`): the moment the source leaves, the next scan of
 *     `state.battlefield` no longer sees it, so nothing can go stale.
 *  2. **Floating** — a `FloatingReplacement` record in `GameState.replacements`,
 *     created by a resolving spell or ability (a fog, a "prevent the next 3
 *     damage" shield) and expiring in cleanup like any until-end-of-turn effect.
 *     A SHIELD carries `remaining`, is consumed as it prevents, and is DELETED
 *     from the list the moment it is spent — deletion, not a zeroed counter, is
 *     what makes "a spent shield cannot resurrect" structural rather than
 *     remembered.
 *
 * ## What is deliberately NOT here
 * This models replacement effects that change a **quantity** (or prevent the
 * event outright). Replacement effects that change WHERE an object goes ("if it
 * would die, exile it instead"), that create different objects ("twice that many
 * tokens"), or that substitute a whole different action ("instead, that player
 * skips that draw and you draw a card") are a different vocabulary and are
 * REPORTED by the compiler, never approximated.
 */

import type { CardFilter } from './choices.js';
import type { CardDefinition } from './card.js';
import { PLUS_ONE_COUNTER } from './internal/stats.js';
import type { StaticControllerScope } from './statics.js';
import type { InstanceId, PlayerId } from './state.js';

/**
 * The event families a replacement effect can watch. Closed on purpose: the
 * compiler can only pattern-match a printed "if … would …" clause onto one of
 * these, so a wording naming anything else reports rather than compiling into
 * a watcher for an event the engine never raises.
 */
export type ReplacementEventKind = 'damage' | 'counters' | 'draw';

/**
 * Every event kind, in canonical order — the closed vocabulary itself, exported
 * so a test can assert the compiler and the engine agree on it.
 */
export const REPLACEMENT_EVENT_KINDS: readonly ReplacementEventKind[] = Object.freeze([
  'damage',
  'counters',
  'draw',
]);

/**
 * WHICH events a replacement effect applies to. One record for all three kinds
 * rather than three filter languages: a kind simply does not read the fields
 * that are meaningless to it (a draw has no `combat` flag, damage has no
 * `counterKind`), exactly as {@link CardFilter} is shared by searches, discards,
 * anthems and attachment hosts.
 *
 * Every controller scope is read relative to the ability's OWN controller, the
 * same convention `StaticAffects.controller` uses — "you" is the permanent's
 * controller, not the affected player.
 */
export interface ReplacementApplies {
  // --- the SOURCE of the event (damage only) --------------------------------
  /**
   * Whose source it must be. "If **a source you control** would deal damage…"
   * (Gratuitous Violence, Torbran) vs the symmetric form with no such tail
   * (Dictate of the Twin Gods), which is `'any'`.
   */
  readonly sourceController?: StaticControllerScope;
  /**
   * What the source must be. "**a red** source" (Torbran) is
   * `{ anyOfColors: ['R'] }`; "**a creature** you control" (Gratuitous Violence)
   * is `{ anyOfTypes: ['creature'] }`. Absent ⇒ any source.
   */
  readonly sourceFilter?: CardFilter;
  /**
   * `true` ⇒ combat damage only (every fog, Dolmen Gate). `false` ⇒ NONCOMBAT
   * damage only (Solphim, Crystal Barricade). Absent ⇒ both, which is what a
   * clause that does not print the word means.
   */
  readonly combat?: boolean;

  // --- WHO/WHAT the event happens to (damage + counters + draw) --------------
  /**
   * Whose object it must happen to — "to **an opponent** or a permanent **an
   * opponent** controls" (Torbran, Twinflame Tyrant), "on a creature **you
   * control**" (Hardened Scales), "if **you** would draw a card". A player
   * recipient is its own controller.
   */
  readonly recipientController?: StaticControllerScope;
  /** What the affected PERMANENT must be ("a creature", "an artifact or creature"). */
  readonly recipientFilter?: CardFilter;
  /** Narrow to damage dealt to a player, or to a permanent. Absent ⇒ either. */
  readonly recipientKind?: 'player' | 'permanent';
  /**
   * Narrow to ONE named object — how a targeted shield ("prevent the next 3
   * damage that would be dealt to target creature") knows what it guards.
   * Absent ⇒ every object the rest of the filter admits.
   */
  readonly recipientIs?: InstanceId | PlayerId;
  /**
   * The printed word "**other**" — "if damage would be dealt to ANOTHER
   * creature you control" (Vigor, Crystal Barricade). Excludes the ability's own
   * source, exactly as `StaticAffects.excludeSource` does.
   */
  readonly excludeSource?: boolean;
  /**
   * Only damage dealt to a creature that is currently ATTACKING (Dolmen Gate,
   * Iroas). Read off `GameState.combat`, which is the only place that fact
   * exists — a `CardFilter` deliberately cannot express it.
   */
  readonly recipientAttacking?: boolean;

  // --- counters -------------------------------------------------------------
  /**
   * The counter kind this watches (`'+1/+1'`). Absent ⇒ every kind, which is
   * what Doubling Season's "one or more counters" says and what Hardened
   * Scales's "+1/+1 counters" does not.
   */
  readonly counterKind?: string;

  // --- draws ----------------------------------------------------------------
  /**
   * Laboratory Maniac's "while your library has no cards in it" — the draw is
   * replaced only when there is nothing to draw.
   */
  readonly requiresEmptyLibrary?: boolean;
  /**
   * The printed exception "except the first one you draw in each of your draw
   * steps" (Teferi's Ageless Insight, Alhammarret's Archive, Notion Thief).
   * Implemented EXACTLY, not approximately: the engine records the turn fact
   * `drewInOwnDrawStep` as the first draw-step draw happens, so the second and
   * every later draw in that step IS replaced.
   */
  readonly exceptFirstDrawEachDrawStep?: boolean;
}

/**
 * WHAT the replacement does to the event it applies to.
 *
 * Ordering inside ONE outcome is fixed and documented: `times` first, then
 * `plus`. No printed card sets both — the field pair exists because the two
 * printed templates ("twice that many", "that many plus one") are genuinely
 * different arithmetic and collapsing them onto one field would make Hardened
 * Scales and Corpsejack Menace the same card.
 */
export interface ReplacementOutcome {
  /** "that many **plus one**" / "that much damage **plus 2**". */
  readonly plus?: number;
  /** "twice that many" / "triple that damage". Applied BEFORE {@link plus}. */
  readonly times?: number;
  /** "**prevent** that damage" / "prevent ALL combat damage …". */
  readonly preventAll?: boolean;
  /**
   * "prevent the **next N** damage" — a SHIELD. Only meaningful on a
   * {@link FloatingReplacement}, whose `remaining` it initialises; a shield is
   * consumed as it prevents and removed from the state the moment it is spent.
   */
  readonly preventUpTo?: number;
  /** "prevent **half** that damage, **rounded up**" (Gisela). */
  readonly preventHalfRoundedUp?: boolean;
  /**
   * "you **win the game** instead" (Laboratory Maniac) — draw events only. The
   * draw does not happen; the drawing player wins.
   */
  readonly winGame?: boolean;
}

/**
 * One replacement effect PRINTED on a card — live for exactly as long as its
 * source permanent is on the battlefield (or, for an emblem, forever).
 *
 * A card may declare several: Gisela prints a doubling clause and a prevention
 * clause and they are two entries, evaluated independently, exactly as two
 * static abilities would be.
 */
export interface ReplacementAbility {
  /** Which event family this watches. */
  readonly event: ReplacementEventKind;
  /** Which events of that family it applies to. */
  readonly applies: ReplacementApplies;
  /** What it does to them. */
  readonly outcome: ReplacementOutcome;
  /** Human-readable label for the inspector / event log. Never read by the rules. */
  readonly label?: string;
}

/** Shared empty list so a definition with no replacement ability allocates nothing. */
const NO_REPLACEMENT_ABILITIES: readonly ReplacementAbility[] = Object.freeze([]);

/**
 * The replacement abilities a definition declares, always as a list. One
 * accessor so "does this card replace anything?" has a single answer everywhere
 * — the same shape, and the same reason, as {@link staticsOf}.
 */
export function replacementsOf(def: CardDefinition): readonly ReplacementAbility[] {
  const declared = def.replacements;
  return declared !== undefined && declared.length > 0 ? declared : NO_REPLACEMENT_ABILITIES;
}

/**
 * Whether an outcome changes anything at all. A declaration that neither scales,
 * adds, nor prevents is inert and is skipped once at index time rather than
 * re-tested against every event — the discipline `staticIsInert` established.
 *
 * `times: 1` and `plus: 0` are inert on purpose: they are what a mis-parsed
 * "that many … instead" would produce, and an inert entry is cheaper AND safer
 * than one that participates in ordering while changing nothing.
 */
export function replacementIsInert(ability: ReplacementAbility): boolean {
  const outcome = ability.outcome;
  if (outcome.preventAll === true) return false;
  if (outcome.preventHalfRoundedUp === true) return false;
  if (outcome.winGame === true) return false;
  if ((outcome.preventUpTo ?? 0) > 0) return false;
  if ((outcome.plus ?? 0) !== 0) return false;
  if ((outcome.times ?? 1) !== 1) return false;
  return true;
}

/**
 * Whether the affected player prefers a LARGER quantity for this event kind —
 * the one-line objective behind the CR 616.1 ordering decision (see
 * `internal/replacement.ts`). Damage is bad for whoever takes it; a `+1/+1`
 * counter is good for whoever's permanent it lands on; every other counter kind
 * (`-1/-1` above all) is not.
 */
export function affectedPlayerPrefersMore(kind: ReplacementEventKind, counterKind?: string): boolean {
  if (kind === 'counters') return counterKind === PLUS_ONE_COUNTER;
  // A bigger draw is a bigger draw; damage is damage.
  return kind === 'draw';
}

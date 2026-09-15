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
 *   - **tokens** — "If an effect would create one or more tokens under your
 *     control, it creates **twice that many** of those tokens instead"
 *     (Doubling Season's other half, Parallel Lives, Anointed Procession,
 *     Mondrak, Elspeth Storm Slayer).
 *   - **life gain** — "If you would gain life, you gain **twice that much**
 *     life instead" (Rhox Faithmender, Boon Reflection, Alhammarret's Archive),
 *     "…that much life **plus 1** instead" (Knight of Dawn's Light), "that
 *     player gains **no** life instead" (Sulfuric Vortex).
 *
 * ## Why "tokens" needed no new rule, only a fourth kind
 * It scales a QUANTITY — how many of the tokens the effect was already going to
 * create — which is the one thing this layer does. It reads no field
 * {@link ReplacementApplies} did not already have (the affected player is the
 * one the tokens are created under, so `recipientController` says "under **your**
 * control" and a clause without that tail is the symmetric card), it terminates
 * by the same CR 614.5 bitmask, and it is ordered by the same CR 616.1 search.
 * The only genuinely new line is `affectedPlayerPrefersMore`'s answer, below.
 * A printed clause that creates a DIFFERENT object instead ("those tokens plus
 * an additional Food token" — Peregrin Took; "instead create one of each" —
 * Academy Manufactor) is not a quantity and is reported, not approximated.
 *
 * ## Why "life gain" needed no new rule either, only a fifth kind
 * Like the token count it scales a QUANTITY, and like a draw it happens to a
 * PLAYER rather than to a permanent — so it reads the recipient half of
 * {@link ReplacementApplies} and none of the source half, adds no field, and is
 * ordered by the same CR 616.1 search. What it DID need is that the two places
 * that gain life ask ONE question: see `life.ts`, which is the `untap.ts`
 * model — two mechanisms (a resolving effect, and LIFELINK on the combat-damage
 * path), one question.
 *
 * They differ only in WHAT is being replaced. They share the applicability
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
 * would die, exile it instead"), or that substitute a whole different action ("instead, that player
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
export type ReplacementEventKind = 'damage' | 'counters' | 'draw' | 'tokens' | 'lifegain';

/**
 * WHICH ONE OBJECT a side of an event is pinned to, when the printed clause
 * names the ability's own permanent rather than describing a class of them.
 *
 * Closed on purpose, and read by BOTH sides of a damage event
 * ({@link ReplacementApplies.recipientAnchor} and
 * {@link ReplacementApplies.dealerAnchor}) — one vocabulary, because "which
 * object does `~` mean?" is one question and two answers to it would eventually
 * disagree (rule 12). Adding "the creature it's blocking" is a ROW here, never
 * an `if` on one side.
 *
 *  - `'source'` — the ability's own permanent. The printed word is `~`: "prevent
 *    all combat damage that would be dealt to and dealt by ~" (Fog Bank),
 *    "prevent all damage that would be dealt to ~" (Cho-Manno, Dawn Elemental).
 *    It is the exact mirror of {@link ReplacementApplies.excludeSource}, which
 *    is how the printed word "another" is already written.
 *  - `'attached'` — the permanent the source is ATTACHED to, read off
 *    `CardInstance.attachedTo`. The printed words are "enchanted creature"
 *    (Gaseous Form, Muzzle, Temporal Isolation) and "equipped creature"
 *    (General's Kabuto). An unattached source anchors to nothing and the
 *    ability simply does not apply — which is what an Aura in the graveyard
 *    should do, and it falls out of the lookup rather than needing a rule.
 */
export type ReplacementAnchor = 'source' | 'attached';

/**
 * Every anchor, in canonical order — exported so a test can assert the compiler
 * and the engine agree on the closed set, exactly as
 * {@link REPLACEMENT_EVENT_KINDS} does for the event kinds.
 */
export const REPLACEMENT_ANCHORS: readonly ReplacementAnchor[] = Object.freeze(['source', 'attached']);

/**
 * Every event kind, in canonical order — the closed vocabulary itself, exported
 * so a test can assert the compiler and the engine agree on it.
 */
export const REPLACEMENT_EVENT_KINDS: readonly ReplacementEventKind[] = Object.freeze([
  'damage',
  'counters',
  'draw',
  // "If one or more tokens would be created under your control, twice that
  // many…" (Anointed Procession, Parallel Lives, Doubling Season's token half,
  // Mondrak). MULTIPLICATIVE outcomes only: token creation runs one funnel call
  // per token, and `times` composes per call while `plus` would compound per
  // token instead of per batch — so the compiler refuses a "plus" wording
  // rather than mis-counting it.
  'tokens',
  // "If you would gain life, you gain twice that much life instead" (Rhox
  // Faithmender, Boon Reflection, Alhammarret's Archive, The Wind Crystal),
  // "…that much life plus 1 instead" (Knight of Dawn's Light), "…that player
  // gains no life instead" (Sulfuric Vortex, `times: 0`).
  //
  // ⚠️ GAIN ONLY, and the asymmetry is deliberate rather than an omission.
  // Life LOSS is a different event (CR 118.3 keeps them apart, and so does
  // `triggers.ts`: `gainLife` is its own event and a loss is a signed
  // `lifeChanged`), and every printed loss-replacement in the corpus also
  // carries a condition this layer has no field for — "during your turn"
  // (Bloodletter of Aclazotz). Compiling those as a gain would be exactly the
  // approximation the pool rule forbids, so `lifeloss` is REPORTED with its
  // number (§3.151) rather than folded in here.
  //
  // The affected player is the one GAINING, so `recipientController` says "if
  // **you** would gain life" and a clause with no such tail ("if **a player**
  // would gain life" — Sulfuric Vortex) is the symmetric card. A life event
  // happens to a PLAYER and never to a permanent, so `recipientFilter`,
  // `recipientAttacking` and the whole source half are meaningless to it and
  // are never read — the same way a draw does not read `combat`.
  'lifegain',
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
   * The DEALER pinned to ONE object — the printed "…damage that would be dealt
   * **by ~**" (Fog Bank) or "**by enchanted creature**" (Muzzle, Temporal
   * Isolation, Defang). Narrows the same side {@link sourceController} and
   * {@link sourceFilter} describe by class, and composes with them as one more
   * AND clause.
   *
   * This is the half that made the two-directional shield a ROW rather than a
   * special case: Fog Bank sets `dealerAnchor` on one entry and
   * {@link recipientAnchor} on another, and neither entry knows the other exists.
   */
  readonly dealerAnchor?: ReplacementAnchor;
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
   * The RECIPIENT pinned to ONE object the ability can name without knowing an
   * instance id at compile time — "damage that would be dealt **to ~**"
   * (Cho-Manno, Dawn Elemental, Guard Gomazoa, Seraph of the Sword) or "**to
   * enchanted creature**" (Inviolability).
   *
   * Distinct from {@link recipientIs}, and the distinction is the whole reason
   * both exist: `recipientIs` is a RESOLVED id, minted when a targeted shield
   * resolves and stored on a floating record. An anchor is resolved FRESH on
   * every event, so a printed static travels with its permanent and an Aura
   * that moves host guards the new one — which is what the card says, and what
   * a baked id could not do.
   */
  readonly recipientAnchor?: ReplacementAnchor;
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
  // LIFE GAIN is the fifth answer and it is the same shape as the draw and the
  // token count: the affected player is the one gaining, and more life is
  // better for them. `times: 0` (Sulfuric Vortex's "gains no life instead")
  // does not change that — CR 616.1 asks what the AFFECTED player wants, not
  // what the ability's controller wants, and the ordering search then picks the
  // order that gives them most of it.
  if (kind === 'lifegain') return true;
  // A bigger draw is a bigger draw; damage is damage. MORE TOKENS is the fourth
  // answer, and it is the same shape as the draw: the affected player is the one
  // the tokens are created UNDER, and every printed token-count replacement is a
  // card that player chose to play for exactly this. (Symmetric doublers exist —
  // Primal Vigor — and this still answers for whoever is being asked, which is
  // what CR 616.1 says: the order is the AFFECTED player's, not the ability
  // controller's.)
  return kind === 'draw' || kind === 'tokens';
}

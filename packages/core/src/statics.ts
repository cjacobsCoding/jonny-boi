/**
 * Static ("anthem") abilities SEAM — a permanent that CONTINUOUSLY modifies OTHER
 * permanents for as long as it is on the battlefield. "Creatures you control get
 * +1/+1"; "Other Goblins you control have haste"; "Creatures your opponents control
 * get -1/-0".
 *
 * ## Why this exists
 * Without it a go-wide/token deck's creatures can never scale, so "wide" strategies
 * simulate systematically weaker than they really are — and every deck verdict the
 * lab produces inherits that bias. This is a fidelity gap, not a nice-to-have.
 *
 * ## It is DATA, not a class (DESIGN §1.2 composition over inheritance)
 * A card declares `CardDefinition.statics` — a list of {@link StaticAbility}, each
 * one a **filter** (which permanents it touches) plus a **modification** (P/T delta
 * and/or granted keywords). There is no anthem subclass, and core never names a card.
 *
 * ## Lifetime is DERIVED, never stored
 * A static is not pushed into `GameState.continuous` when its source resolves.
 * Instead every "effective value" read re-derives the active statics from the
 * permanents currently on the battlefield (see `internal/continuous.ts`
 * `indexContinuous`). That single choice makes the lifetime exactly right for free:
 * the instant the source is destroyed / exiled / bounced — including mid-combat,
 * between the damage step and state-based actions — it is no longer in
 * `state.battlefield`, so the very next read no longer sees its modification and a
 * creature kept alive only by an anthem dies to SBAs immediately. There is nothing
 * to clean up, nothing to expire, and no window in which a stale buff can survive
 * its source.
 *
 * ## The filter matches PRINTED characteristics only
 * {@link StaticAffects} looks at controller, card types, subtypes, name and mana
 * value — characteristics that **no static in this model can change**. That is a
 * deliberate constraint: it means one non-iterative pass over the battlefield is
 * exact, with no layer-dependency loop to resolve (MTG's CR 613.8). A filter that
 * could read modified P/T or granted keywords would need a fixpoint; if such a card
 * is ever needed, it must be designed then, not approximated now.
 *
 * ## Stacking
 * Every matching static contributes additively (P/T deltas sum, keyword grants OR
 * together), and they stack with until-end-of-turn continuous effects and +1/+1
 * counters. See `internal/stats.ts` for the documented layering order.
 */

import type { CardInstance } from './state.js';
import type { KeywordFlags } from './card.js';
import type { CardFilter } from './choices.js';
import { matchesCardFilter } from './choices.js';

/**
 * Whose permanents a static reaches, relative to the source's controller.
 *   - `you`      : permanents its controller controls ("creatures you control").
 *   - `opponent` : permanents the other player controls.
 *   - `any`      : everybody's ("all creatures get +1/+1" — a symmetric anthem).
 */
export type StaticControllerScope = 'you' | 'opponent' | 'any';

/**
 * The scope assumed when a static does not say otherwise. The overwhelming majority
 * of printed anthems are "creatures YOU control", so that is the default — but a
 * card author is encouraged to write it explicitly, because a symmetric or punitive
 * anthem that forgets the field would silently become a friendly one.
 */
export const DEFAULT_STATIC_SCOPE: StaticControllerScope = 'you';

/**
 * Which permanents a static ability applies to. Extends the shared
 * {@link CardFilter} vocabulary (types / name / mana value, plus subtypes) rather
 * than inventing a second filter language, and adds the two things only a
 * battlefield-relative static needs: whose permanents count, and whether the source
 * itself is included.
 */
export interface StaticAffects extends CardFilter {
  /** Whose permanents this reaches. Defaults to {@link DEFAULT_STATIC_SCOPE}. */
  readonly controller?: StaticControllerScope;
  /**
   * Set for the printed word "**other**" — "OTHER creatures you control get +1/+1"
   * pumps the team but not the lord itself. Omit (or `false`) for the plain form,
   * which DOES include the source when the source matches the rest of the filter.
   *
   * Getting this backwards is the classic anthem bug, so it is a distinct, named
   * flag rather than something inferred.
   */
  readonly excludeSource?: boolean;
  /**
   * Set for the printed phrase "with a **+1/+1 counter** on it" — the static
   * reaches only permanents currently carrying at least one counter of this
   * kind ("Creatures you control with +1/+1 counters on them can't be
   * blocked").
   *
   * This is the ONE non-printed characteristic a static filter may read, and it
   * is safe for the reason the doc comment above gives: counters are instance
   * STATE, not a characteristic any static in this model can change, so reading
   * them creates no layer-dependency loop (CR 613.8) and the single
   * non-iterative pass over the battlefield stays exact.
   */
  readonly hasCounterKind?: string;
}

/**
 * WHAT a continuous modification does to a permanent, with no statement about
 * *which* permanents receive it or for *how long*.
 *
 * Split out because three lifetimes now say the same thing: a static ability
 * ("creatures you control get +1/+1"), an attachment's grant to its host
 * ("enchanted creature gets +2/+0 and has trample" — see `attachments.ts`), and an
 * until-end-of-turn `ContinuousEffect`. They differ only in scope and lifetime, so
 * the *modification* is one shape and one inertness test rather than three that can
 * drift apart.
 */
export interface PermanentModification {
  /** Power delta added to every affected permanent. Omit for none. */
  readonly power?: number;
  /** Toughness delta added to every affected permanent. Omit for none. */
  readonly toughness?: number;
  /** Keyword abilities granted to every affected permanent. Omit for none. */
  readonly keywords?: KeywordFlags;
}

/**
 * One static ability on a card: what it affects, and how it modifies it.
 *
 * A card may declare several (a lord that pumps AND grants a keyword to a different
 * set is two entries), and each is evaluated independently.
 */
export interface StaticAbility extends PermanentModification {
  /** Which permanents this modifies. */
  readonly affects: StaticAffects;
  /**
   * Optional human-readable label for the inspector / event log ("Anthem: creatures
   * you control get +1/+1"). Never read by the rules.
   */
  readonly label?: string;
}

/** Shared empty list so a definition with no statics allocates nothing. */
const NO_STATICS: readonly StaticAbility[] = Object.freeze([]);

/**
 * The static abilities a definition declares, always as a list. One accessor so
 * "does this card have statics" has a single answer everywhere.
 */
export function staticsOf(def: CardInstance['def']): readonly StaticAbility[] {
  const declared = def.statics;
  return declared && declared.length > 0 ? declared : NO_STATICS;
}

/**
 * Whether `ability`, emanating from `source`, applies to `candidate`.
 *
 * Both permanents are assumed to be on the battlefield — the caller iterates
 * `state.battlefield`, which is what makes the lifetime automatic.
 */
export function staticAppliesTo(ability: StaticAbility, source: CardInstance, candidate: CardInstance): boolean {
  const affects = ability.affects;
  // "Other" first: it is the cheapest check and the one most likely to exclude.
  if (affects.excludeSource === true && candidate.instanceId === source.instanceId) return false;
  const scope = affects.controller ?? DEFAULT_STATIC_SCOPE;
  if (scope === 'you') {
    if (candidate.controller !== source.controller) return false;
  } else if (scope === 'opponent') {
    if (candidate.controller === source.controller) return false;
  }
  if (affects.hasCounterKind !== undefined && (candidate.counters[affects.hasCounterKind] ?? 0) <= 0) {
    return false;
  }
  return matchesCardFilter(candidate, affects);
}

/**
 * Whether a modification actually changes anything — a declaration of `{}` (no
 * delta, no keywords) is inert and can be skipped without changing behavior.
 *
 * Shared by statics and by attachments, which is the point: an aura that grants
 * nothing and an anthem that grants nothing cost the layering pass the same
 * nothing.
 */
export function modificationIsInert(mod: PermanentModification): boolean {
  if ((mod.power ?? 0) !== 0 || (mod.toughness ?? 0) !== 0) return false;
  const kw = mod.keywords;
  if (!kw) return true;
  for (const key in kw) {
    if ((kw as Record<string, unknown>)[key]) return false;
  }
  return true;
}

/** Whether a static ability changes anything. See {@link modificationIsInert}. */
export function staticIsInert(ability: StaticAbility): boolean {
  return modificationIsInert(ability);
}

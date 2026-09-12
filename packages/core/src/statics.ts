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
 * ## The filter matches characteristics NO STATIC CAN CHANGE
 * {@link StaticAffects} looks at controller, card types, subtypes, name and mana
 * value — plus two pieces of instance STATE that no continuous effect in this
 * model can touch either: the counters on a permanent
 * ({@link StaticAffects.hasCounterKind}) and the value the SOURCE named as it
 * entered ({@link StaticAffects.ofChosenSubtype} / `ofChosenColor`). That is a
 * deliberate constraint: it means one non-iterative pass over the battlefield is
 * exact, with no layer-dependency loop to resolve (MTG's CR 613.8).
 *
 * ## The ONE exception, and why it is still one pass
 * Three fields DO read a value the layer system produces — the filter bounds
 * {@link StaticAffects.maxEffectivePower} / `maxEffectivePowerOrToughness`
 * (Tetsuko, Delney) and the grant bound {@link StaticAbility.blockBoundFromSourcePower}
 * (Champion of Lambholt). They are answered in a SECOND, settled pass that runs
 * after every P/T layer has folded, and every one of them may grant KEYWORDS
 * ONLY. That restriction is the whole proof: the settled pass reads powers and
 * writes keywords, and nothing that produces a power reads a keyword, so its
 * output can never change its own input and one extra pass is already the
 * fixpoint. A filter that could read GRANTED KEYWORDS would not have that
 * property and would need a real CR 613.8 dependency ordering; if such a card is
 * ever needed, it must be designed then, not approximated now.
 *
 * ## Stacking
 * Every matching static contributes additively (P/T deltas sum, keyword grants OR
 * together), and they stack with until-end-of-turn continuous effects and +1/+1
 * counters. See `internal/stats.ts` for the documented layering order.
 */

import type { CardInstance } from './state.js';
import type { KeywordFlags } from './card.js';
import { colorsOfDefinition, permanentHasSubtype } from './card.js';
import type { ActivatedAbility } from './card.js';
import type { CardFilter } from './choices.js';
import { matchesCardFilter } from './choices.js';
import { chosenColorOf, chosenSubtypeOf } from './as-enters.js';

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
   * §3.110 — the static reaches ONLY its own source: a self-conditional ability
   * printed on the permanent it modifies. Unleash's "**it can't block as long
   * as it has a +1/+1 counter on it**" (CR 702.98a) is this flag beside
   * {@link hasCounterKind}. The mirror of {@link excludeSource}, and a distinct
   * named flag for the same reason: an unscoped self-static would hand the
   * restriction to every creature on the source's side of the table.
   */
  readonly onlySource?: boolean;
  /**
   * Set for the printed phrase "with a **+1/+1 counter** on it" — the static
   * reaches only permanents currently carrying at least one counter of this
   * kind ("Creatures you control with +1/+1 counters on them can't be
   * blocked").
   *
   * This is ONE of the two non-printed characteristics a static filter may read
   * (see {@link ofChosenSubtype} for the other), and it is safe for the reason
   * the doc comment above gives: counters are instance STATE, not a
   * characteristic any static in this model can change, so reading them creates
   * no layer-dependency loop (CR 613.8) and the single non-iterative pass over
   * the battlefield stays exact.
   */
  readonly hasCounterKind?: string;
  /**
   * Set for the printed words "**of the chosen type**" — "creatures you control
   * of the chosen type get +1/+1" (Adaptive Automaton, Patchwork Banner, Icon of
   * Ancestry). The static reaches only permanents carrying the subtype its own
   * SOURCE named as it entered (`CardInstance.chosenAsEntered`).
   *
   * **A source that named nothing reaches nothing.** That is the whole safety
   * argument for the unasked-entry default: a reanimated Adaptive Automaton is
   * an anthem over the empty set, never over every creature. Never read an
   * absent value as "no filter".
   *
   * Safe against a layer loop for the same reason `hasCounterKind` is: the named
   * value is instance state written once as the source entered, and no
   * continuous effect in this engine can change it.
   */
  readonly ofChosenSubtype?: boolean;
  /**
   * Set for the printed words "**of the chosen color**" — "creatures you control
   * of the chosen color get +1/+0" (Heraldic Banner), "creatures of the chosen
   * color get +1/+1" (Gauntlet of Power). Same source-named reading, same
   * matches-nothing rule when nothing was named, as {@link ofChosenSubtype}.
   */
  readonly ofChosenColor?: boolean;
  /**
   * An EFFECTIVE-power ceiling — the printed "creatures you control **with
   * power 2 or less**" (Delney, Streetwise Lookout) — and its
   * power-or-toughness sibling ("**with power or toughness 1 or less**",
   * Tetsuko Umezawa, Fugitive).
   *
   * ⚠️ These are the ONE part of a static filter that reads a value the layer
   * system itself produces, so they carry a hard rule enforced in
   * `indexContinuous`: a static using them may grant KEYWORDS ONLY, never a
   * P/T delta. The pass then stays exact and non-iterative — every P/T layer
   * settles first, and these statics fold in afterwards against the settled
   * numbers, so an anthem correctly lifts a creature OUT of "power 2 or less"
   * and nothing can depend on its own output (CR 613.8's dependency, in the
   * one shape the pool actually prints).
   */
  readonly maxEffectivePower?: number;
  /** As {@link maxEffectivePower}, satisfied when EITHER stat is within it. */
  readonly maxEffectivePowerOrToughness?: number;
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
  /**
   * ACTIVATED abilities granted to every affected permanent — the printed
   * quoted form: "Enchanted creature **has \"{T}: Add one mana of any
   * color.\"**" (Paradise Mantle), "All Slivers **have \"{T}: …\"**", "Lands
   * you control **have \"{T}: Add one mana of any color.\"**" (Chromatic
   * Lantern), "Creatures you control **have \"{T}: Add one mana of any
   * color.\"**" (Cryptolith Rite).
   *
   * The SAME {@link ActivatedAbility} shape a card prints on itself, which is
   * the whole point: the ability is compiled by the compiler's ordinary
   * activated-ability parser, and the engine activates it through the ordinary
   * activation path. Granting is a matter of WHERE the ability list comes
   * from, not of a second kind of ability.
   *
   * Read through `effectiveActivated` — printed abilities first, then granted
   * ones — so an ability INDEX stays stable while the grant lasts.
   */
  readonly activated?: readonly ActivatedAbility[];
}

/**
 * WHICH bound of a granted `BlockRestriction` is filled in from the STATIC
 * SOURCE'S OWN settled power rather than from a printed number.
 *
 * A CLOSED table, named by the printings it serves, for the reason every other
 * closed table here is closed: a comparison outside it is a selector core
 * cannot read, and the card must keep REPORTING rather than compile into a
 * restriction that means something narrower or wider than its printed line.
 *   - `minBlockerPower` — "Creatures with power **less than** this creature's
 *     power can't block creatures you control" (Champion of Lambholt). A legal
 *     blocker needs power at least the source's, so the source's power IS the
 *     minimum.
 *   - `maxBlockerPower` — the mirror, "power **greater than** …". Carried as
 *     its own row so a compiler reading the printed comparison names the
 *     direction it read; one field with an inferred direction is how a rule
 *     silently maps one wording onto the other's meaning.
 */
export type SourcePowerBlockBound = 'minBlockerPower' | 'maxBlockerPower';

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
   * §3.146 — the granted block restriction's bound is **this static's own
   * source's EFFECTIVE POWER**, not a printed number: "Creatures with power
   * less than this creature's power can't block creatures you control"
   * (Champion of Lambholt, whose power climbs by a +1/+1 counter every time
   * another creature enters).
   *
   * ⚠️ Like {@link StaticAffects.maxEffectivePower} this reads a value the
   * layer system itself produces, and it carries the SAME hard rule, enforced
   * in `indexContinuous` and pinned by a pool-wide guard: a static using it may
   * grant KEYWORDS ONLY, never a P/T delta. The source's power is read in the
   * settled-P/T pass, after every P/T layer has folded, and what that pass
   * writes is a keyword — which nothing that produces a power reads. So the
   * single non-iterative pass stays exact and there is no CR 613.8 dependency
   * loop even when two such creatures read each other's power
   * (`effective-pt-statics.test.ts` pins the fixpoint).
   *
   * The source's power is *derived*, never stored, exactly like every other
   * static: destroy the Champion mid-combat and the very next index build no
   * longer carries the restriction.
   */
  readonly blockBoundFromSourcePower?: SourcePowerBlockBound;
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
  // §3.110 — a self-only static reaches nothing but its source (unleash).
  if (affects.onlySource === true && candidate.instanceId !== source.instanceId) return false;
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
  // "of the chosen type / color" — read off the SOURCE, applied to the candidate.
  // A source that named nothing matches nothing (see the field docs): the guard
  // is written as an early `false` rather than as a skipped filter precisely so
  // an unnamed value can never widen the anthem to the whole board.
  if (affects.ofChosenSubtype === true) {
    const named = chosenSubtypeOf(source);
    if (named === undefined || !permanentHasSubtype(candidate, named)) return false;
  }
  if (affects.ofChosenColor === true) {
    const named = chosenColorOf(source);
    if (named === undefined || !colorsOfDefinition(candidate.def).includes(named)) return false;
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
  // A source-power bound IS a modification even with no keywords declared beside
  // it: the restriction it grants is COMPUTED in the settled-P/T pass rather
  // than printed here, so the generic inertness test cannot see it. Judging it
  // inert would skip the ability before it was ever deferred — the card would
  // compile 'complete' and do nothing, which is this project's signature failure.
  if (ability.blockBoundFromSourcePower !== undefined) return false;
  return modificationIsInert(ability);
}

/**
 * TARGET LEGALITY — what a spell is *allowed* to point at (DESIGN §2 card seam).
 *
 * Why this exists: the engine used to accept any target for any spell, so a card
 * printed "deals 3 damage to target **player or planeswalker**" played as if it
 * read "any target", and a 1-mana "4 damage to target **creature**" played as a
 * 1-mana 4-damage any-target spell. Both are *strictly better than printed*, and
 * a card that plays better than printed silently corrupts every A/B verdict that
 * includes it. The project rule is **faithful or not at all**.
 *
 * The restriction is DATA, not code: an effect ref carries
 * `params.targets: 'any' | 'creature' | 'player'`, exactly like every other
 * tunable a primitive reads. Core stays primitive-agnostic — it never asks *which*
 * primitive an effect is, only whether the ref declares a target restriction under
 * the one reserved param name {@link TARGET_RESTRICTION_PARAM}. That keeps this a
 * convention on the card seam (any present or future targeting primitive inherits
 * it for free) rather than a hard-coded list of primitive ids in the engine.
 *
 * The restriction is enforced in THREE places, which is what makes it real:
 *   1. **Offer** — `generateLegalActions` enumerates a restricted spell's casts
 *      one per *legal* target, and offers none at all when the board has no legal
 *      target (a spell with no legal target cannot be cast).
 *   2. **Reject** — `applyCastSpell` refuses a submitted target that breaks the
 *      restriction, so a pilot or a UI that builds its own action cannot cheat.
 *   3. **Resolve** — the primitive itself re-checks (`cards/primitives.ts`), so a
 *      target that became illegal between cast and resolution does nothing.
 *
 * A definition that declares NO restriction is left completely alone (that is what
 * "defaults to unrestricted" means for legality): counterspells target a stack
 * object, pumps target their own source, and policing those here would break them.
 */

import type { CardDefinition, EffectRef } from './card.js';
import { isCreature } from './card.js';
import { isPlaneswalker } from './card.js';
import type { CardInstance, GameState, InstanceId, PlayerId } from './state.js';
import { PLAYER_IDS } from './state.js';
import { indexContinuous, NO_MOD } from './internal/continuous.js';
import { effectiveKeywords } from './internal/stats.js';

/**
 * What a targeted effect may point at.
 *
 * - `'any'` — MTG's "any target": a creature, a player, **or a planeswalker**
 *   (CR 115.4 — since planeswalkers exist in this engine, "any target" includes
 *   them, exactly as the printed reminder text says).
 * - `'creature'` — "target creature" only. Never a player's face, never a walker.
 * - `'player'` — "target player" only. Never a creature or a planeswalker.
 * - `'spell'` — "target spell": an object on the stack. Its point is the *timing*
 *   rule rather than the aim — a counterspell with an empty stack has no legal
 *   target and therefore **cannot be cast at all**. Without it, "Counter target
 *   spell. You gain 3 life." was castable into an empty stack for a free three
 *   life, which is strictly better than the printed card.
 */
export type TargetRestriction =
  | 'any'
  | 'creature'
  | 'player'
  | 'spell'
  /** "target artifact" — an artifact permanent, never a creature or a face. */
  | 'artifact'
  /**
   * "target opponent" — a player who ISN'T the caster.
   *
   * This one is unlike the others: legality depends on WHO is casting, not only
   * on the board. Every checker therefore takes an optional `controller`, and
   * when it is absent an opponent-target is treated as ILLEGAL rather than
   * guessed. Being unable to cast is a safe failure; letting a spell point at
   * its own caster would make it strictly more permissive than printed, which is
   * the exact infidelity this module exists to prevent.
   */
  | 'opponent'
  /**
   * "target creature you control" — the aim of every printed `Equip {N}`
   * ability ("Attach to target creature you control").
   *
   * Like `'opponent'`, legality depends on WHO is acting rather than only on the
   * board, so an absent `controller` makes it ILLEGAL rather than guessed. It
   * exists as its own restriction instead of being approximated by `'creature'`
   * for the usual reason: offering an Equipment every creature on the table lets
   * a pilot spend mana equipping the opponent's board, which is a card playing
   * differently from its printed text.
   */
  | 'creatureYouControl'
  /**
   * "target player or planeswalker" — a face or a walker, never a creature.
   * Lava Spike's printed line. Its own restriction (not `'player'`) because
   * flattening it would make the card NARROWER than printed now that
   * planeswalkers exist — the same infidelity this module polices, in the other
   * direction.
   */
  | 'playerOrPlaneswalker'
  /** "target creature or planeswalker" — a permanent of either kind, never a face. */
  | 'creatureOrPlaneswalker';

/**
 * The reserved effect-param name carrying a {@link TargetRestriction}. One name,
 * read identically by core's legality checks, the primitives, and both AI pilots —
 * so "what may this spell target" has exactly one answer in the codebase.
 */
export const TARGET_RESTRICTION_PARAM = 'targets';

/**
 * The restriction assumed when a targeting effect declares none: unrestricted
 * "any target". Keeping this the default is what leaves every already-authored
 * card (Lightning Bolt, Shock, Searing Spear) behaving exactly as before.
 */
export const DEFAULT_TARGET_RESTRICTION: TargetRestriction = 'any';

/** Whether an arbitrary value is a valid restriction word. */
export function isTargetRestriction(value: unknown): value is TargetRestriction {
  return (
    value === 'any' ||
    value === 'creature' ||
    value === 'player' ||
    value === 'spell' ||
    value === 'artifact' ||
    value === 'opponent' ||
    value === 'creatureYouControl' ||
    value === 'playerOrPlaneswalker' ||
    value === 'creatureOrPlaneswalker'
  );
}

/**
 * Memo for {@link targetRestrictionOf}. Card definitions are immutable and shared
 * (the pool is frozen; every instance points at the same object), and this is read
 * for every card in hand on every `generateLegalActions` — the engine's hottest
 * read. Scanning the effect list each time put allocation on the sim's hot path.
 *
 * `null` is memoized too: "this definition declares no restriction" is the common
 * answer and must not be recomputed either.
 */
const RESTRICTION_MEMO = new WeakMap<CardDefinition, TargetRestriction | null>();

/**
 * The target restriction core ENFORCES for a definition, or `undefined` when
 * there is none to enforce.
 *
 * When several effects declare one — "deals N damage to target creature and you
 * gain N life" is two refs but one target — the NARROWEST wins, because every
 * effect of a single spell points at the same chosen target and the printed card
 * can only be as permissive as its strictest clause.
 *
 * `'any'` (declared or defaulted) deliberately yields `undefined`, i.e. core does
 * not police it. Two reasons, and they point the same way:
 *   - *Nothing to enforce.* "Any target" excludes only things nobody targets
 *     anyway (a land, a card in a graveyard), and the primitive already refuses
 *     those at resolution. There is no way to play an "any target" spell as
 *     better than printed.
 *   - *Cost.* Enforcing it would make `generateLegalActions` enumerate one cast
 *     per creature-plus-player for every burn spell in hand, on the engine's
 *     hottest loop and straight into the search's branching factor — a real
 *     throughput regression (DESIGN §1.6) bought with no fidelity.
 * So an already-authored unrestricted card behaves exactly as it always has, and
 * only a card whose printed text is genuinely NARROWER than "any target" changes.
 */
export function targetRestrictionOf(def: CardDefinition): TargetRestriction | undefined {
  const memoized = RESTRICTION_MEMO.get(def);
  if (memoized !== undefined) return memoized ?? undefined;
  // Only a restriction NARROWER than the default is enforceable, so an explicit
  // `targets: 'any'` reads the same as declaring nothing at all (see above).
  const found = restrictionOfEffects(def.effects ?? []) ?? null;
  RESTRICTION_MEMO.set(def, found);
  return found ?? undefined;
}

/** Whether a target reference is a player (the two seats) rather than a permanent. */
export function isPlayerTarget(target: InstanceId | PlayerId): target is PlayerId {
  return target === 'A' || target === 'B';
}

/**
 * Whether `target` satisfies `restriction` on the current board. A permanent id
 * must name a **creature currently on the battlefield** — an id that has died, or
 * one naming a land, is not a legal creature target.
 */
export function isLegalTarget(
  state: GameState,
  restriction: TargetRestriction,
  target: InstanceId | PlayerId,
  controller?: PlayerId,
): boolean {
  if (isPlayerTarget(target)) {
    if (restriction === 'opponent') {
      // Unknown caster ⇒ illegal, never "probably fine" (see the type's note).
      return controller !== undefined && target !== controller;
    }
    return restriction === 'any' || restriction === 'player' || restriction === 'playerOrPlaneswalker';
  }
  if (restriction === 'player' || restriction === 'opponent') return false;
  if (restriction === 'spell') {
    // A *spell* on the stack — never a triggered ability, which is also a stack
    // object but is not a spell and cannot be countered by "counter target spell".
    return state.stack.some((object) => object.kind === 'spell' && object.instanceId === target);
  }
  const permanent = state.battlefield.find((c) => c.instanceId === target);
  if (!permanent) return false;
  if (!isTargetableBy(state, permanent, controller)) return false;
  if (restriction === 'artifact') return permanent.def.types.includes('artifact');
  // "Target player or planeswalker": a permanent target must be a walker.
  if (restriction === 'playerOrPlaneswalker') return isPlaneswalker(permanent.def);
  // "Any target" and "creature or planeswalker" accept a walker permanent too.
  if (restriction === 'any' || restriction === 'creatureOrPlaneswalker') {
    return isCreature(permanent.def) || isPlaneswalker(permanent.def);
  }
  if (restriction === 'creatureYouControl') {
    // Unknown actor ⇒ illegal, never "probably mine" (see the type's note).
    if (controller === undefined || permanent.controller !== controller) return false;
  }
  return isCreature(permanent.def);
}

/**
 * Whether `permanent` may be targeted at all by `caster` — the hexproof/shroud
 * check, applied before any restriction so it holds for every targeting effect
 * rather than each one remembering it.
 *
 * Shroud blocks everyone. Hexproof blocks only opponents, so it needs the
 * caster; with an UNKNOWN caster a hexproof permanent is treated as untargetable
 * — the conservative direction, since guessing the other way would let an
 * opponent's spell through a protection the card really has.
 *
 * Granted keywords are read through the continuous layer, so a creature given
 * hexproof by an aura or a pump is protected too.
 */
function isTargetableBy(
  state: GameState,
  permanent: CardInstance,
  caster: PlayerId | undefined,
): boolean {
  // PERFORMANCE: this runs for every candidate target of every castable spell on
  // the engine's hottest loop, and `indexContinuous` walks the whole effect list.
  // The overwhelmingly common board has no continuous effects and no printed
  // hexproof, so both are checked cheaply first and the index is built only when
  // a grant could actually exist.
  const printed = permanent.def.keywords;
  if (state.continuous.length === 0) {
    if (printed?.shroud === true) return false;
    if (printed?.hexproof === true) return caster !== undefined && caster === permanent.controller;
    return true;
  }
  const keywords = effectiveKeywords(
    permanent,
    indexContinuous(state).get(permanent.instanceId) ?? NO_MOD,
  );
  if (keywords.shroud === true) return false;
  if (keywords.hexproof === true) return caster !== undefined && caster === permanent.controller;
  return true;
}

/**
 * Every target that satisfies `restriction` right now: both players (a player may
 * legally be targeted by their own burn) and/or every creature on the battlefield,
 * whoever controls it. This is the menu `generateLegalActions` offers, so a
 * consumer that only ever picks from the offered actions physically cannot choose
 * an illegal target.
 */
export function legalTargetsFor(
  state: GameState,
  restriction: TargetRestriction,
  controller?: PlayerId,
): readonly (InstanceId | PlayerId)[] {
  if (restriction === 'spell') {
    return state.stack.filter((object) => object.kind === 'spell').map((object) => object.instanceId);
  }
  const targets: (InstanceId | PlayerId)[] = [];
  if (restriction === 'any' || restriction === 'player' || restriction === 'playerOrPlaneswalker') {
    targets.push(...PLAYER_IDS);
  }
  if (restriction === 'opponent') {
    // With no caster there is no such thing as "an opponent", so nothing is
    // offered and the spell simply cannot be cast — the safe direction.
    if (controller !== undefined) {
      targets.push(...PLAYER_IDS.filter((player) => player !== controller));
    }
  }
  // A hexproof/shroud permanent is never OFFERED, so a consumer picking only
  // from this menu cannot try an illegal target in the first place.
  if (restriction === 'any' || restriction === 'creature' || restriction === 'creatureOrPlaneswalker') {
    // "Any target" (and "creature or planeswalker") includes planeswalkers —
    // CR 115.4 — so a walker on the battlefield is a real member of this menu.
    const walkersToo = restriction !== 'creature';
    for (const permanent of state.battlefield) {
      const kindOk = isCreature(permanent.def) || (walkersToo && isPlaneswalker(permanent.def));
      if (kindOk && isTargetableBy(state, permanent, controller)) {
        targets.push(permanent.instanceId);
      }
    }
  }
  if (restriction === 'playerOrPlaneswalker') {
    for (const permanent of state.battlefield) {
      if (isPlaneswalker(permanent.def) && isTargetableBy(state, permanent, controller)) {
        targets.push(permanent.instanceId);
      }
    }
  }
  if (restriction === 'creatureYouControl' && controller !== undefined) {
    for (const permanent of state.battlefield) {
      if (
        permanent.controller === controller &&
        isCreature(permanent.def) &&
        isTargetableBy(state, permanent, controller)
      ) {
        targets.push(permanent.instanceId);
      }
    }
  }
  if (restriction === 'artifact') {
    for (const permanent of state.battlefield) {
      if (permanent.def.types.includes('artifact') && isTargetableBy(state, permanent, controller)) {
        targets.push(permanent.instanceId);
      }
    }
  }
  return targets;
}

/**
 * The reason a cast's targets are illegal, or `undefined` when they are fine.
 * Returned as a message so `applyAction`'s rejection says *why* — a silent
 * rejection is how a pilot ends up spinning on an action it cannot understand.
 *
 * A restricted spell must name **exactly one** target: every card the restriction
 * exists for is single-target, and accepting a target-less cast would let the
 * spell resolve as a free no-op instead of being an illegal play.
 */
export function illegalTargetReason(
  state: GameState,
  def: CardDefinition,
  targets: ReadonlyArray<InstanceId | PlayerId>,
  controller?: PlayerId,
): string | undefined {
  const restriction = targetRestrictionOf(def);
  if (restriction === undefined) return undefined; // unrestricted — not policed
  if (targets.length !== 1) {
    return `${def.name} targets exactly one ${describeRestriction(restriction)}`;
  }
  const target = targets[0]!;
  if (!isLegalTarget(state, restriction, target, controller)) {
    return `${def.name} can only target ${describeRestriction(restriction)}`;
  }
  return undefined;
}

/**
 * The same legality check as {@link illegalTargetReason}, but over a bare list
 * of effects rather than a whole card.
 *
 * An ACTIVATED ability has its own effects and therefore its own targeting
 * rules, independent of the spell script printed on the same card. `label` names
 * the thing being activated so a rejection reads as a sentence.
 */
export function illegalTargetReasonForEffects(
  state: GameState,
  label: string,
  effects: readonly EffectRef[],
  targets: ReadonlyArray<InstanceId | PlayerId>,
  controller?: PlayerId,
): string | undefined {
  const restriction = restrictionOfEffects(effects);
  if (restriction === undefined) return undefined; // unrestricted — not policed
  if (targets.length !== 1) {
    return `${label} targets exactly one ${describeRestriction(restriction)}`;
  }
  if (!isLegalTarget(state, restriction, targets[0]!, controller)) {
    return `${label} can only target ${describeRestriction(restriction)}`;
  }
  return undefined;
}

/** First narrower-than-default restriction declared by any of these effects. */
export function restrictionOfEffects(
  effects: readonly EffectRef[],
): TargetRestriction | undefined {
  for (const ref of effects) {
    const declared = ref.params?.[TARGET_RESTRICTION_PARAM];
    if (!isTargetRestriction(declared) || declared === DEFAULT_TARGET_RESTRICTION) continue;
    return declared;
  }
  return undefined;
}

/** Plain-English name of a restriction, for rejection messages and UI. */
export function describeRestriction(restriction: TargetRestriction): string {
  switch (restriction) {
    case 'creature':
      return 'a creature';
    case 'player':
      return 'a player';
    case 'spell':
      return 'a spell on the stack';
    case 'artifact':
      return 'an artifact';
    case 'opponent':
      return 'an opponent';
    case 'creatureYouControl':
      return 'a creature you control';
    case 'playerOrPlaneswalker':
      return 'a player or a planeswalker';
    case 'creatureOrPlaneswalker':
      return 'a creature or a planeswalker';
    case 'any':
      return 'any target (a creature, a player, or a planeswalker)';
  }
}

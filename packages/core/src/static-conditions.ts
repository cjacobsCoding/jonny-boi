/**
 * WHEN A STATIC ABILITY IS ON — the printed "as long as …" (DESIGN §3.169).
 *
 * > "Threshold — Krosan Beast gets +7/+7 as long as seven or more cards are in
 * > your graveyard." · "Skyhunter Cub gets +1/+1 and has flying as long as it's
 * > equipped." · "Indomitable Archangel: Metalcraft — Artifacts you control have
 * > shroud as long as you control three or more artifacts."
 *
 * A static ability that is switched on and off by a fact about the game — not
 * by which permanents it reaches ({@link StaticAffects} says that) but by whether
 * it applies at all right now. The condition is a CLOSED union, for the reason
 * every table in this engine is closed: a condition the engine cannot decide
 * must make its card REPORT, never compile to a static that is silently always
 * on (a strictly better card) or always off (a dead one).
 *
 * ## Why the single continuous pass stays exact
 *
 * `indexContinuous` folds every static in one pass (plus one settled-P/T pass
 * for keyword-only statics that read effective power), and that is exact only
 * because nothing a static WRITES is something a static READS. Every condition
 * here keeps that promise. A condition reads:
 *  - a graveyard's size or the printed types of the cards in it — zone state;
 *  - the count of permanents matching a PRINTED filter (types, subtypes,
 *    colours) — no static in this model changes a permanent's types or colours,
 *    so the count is the same before and after the pass;
 *  - the SOURCE's own instance state — tapped, attacking, what is attached to
 *    it — none of which any static writes;
 *  - a life total.
 * Never effective power, toughness or a granted keyword: a condition on those
 * would need the pass's own output as input, and would belong in the settled
 * pass with the same keyword-only rule `readsSettledStats` enforces. The
 * pool-wide guard for that rule is where such a condition would be caught.
 */
import type { CardFilter } from './choices.js';
import type { DerivedCountName } from './card.js';
import { permanentHasSubtype } from './card.js';
import {
  countPermanentsMatching,
  evaluateDerivedCount,
  type DerivedCountScope,
  type PermanentStateFilter,
} from './derived.js';
import type { CardInstance, GameState } from './state.js';

/** The discriminator the compiler writes for a filtered count — the same word `ManaAmountSource` uses. */
export const STATIC_COUNT_PERMANENTS_MATCHING = 'permanentsMatching';

/**
 * A number the board or a zone decides — the SAME two shapes the derived-value
 * and mana-amount vocabularies use, so "artifacts you control" means one set
 * to a pump, a mana ability and a condition alike.
 */
export type StaticCountSource =
  | { readonly countOf: DerivedCountName }
  | {
      readonly countOf: typeof STATIC_COUNT_PERMANENTS_MATCHING;
      readonly filter: CardFilter;
      readonly scope: DerivedCountScope;
      readonly permanentState?: PermanentStateFilter;
    };

/** What an attachment on the source has to be for "~ is equipped" / "~ is enchanted". */
export type AttachedBy = 'Equipment' | 'Aura';

export type StaticCondition =
  /**
   * "as long as there are seven or more cards in your graveyard" (threshold),
   * "as long as you control three or more artifacts" (metalcraft), "as long as
   * you control another Elf". `excludeSource` is the printed "another": the
   * source is not counted, so a lone Elf does not control another Elf.
   */
  | {
      readonly kind: 'countAtLeast';
      readonly count: StaticCountSource;
      readonly min: number;
      readonly excludeSource?: boolean;
    }
  /** "as long as ~ is equipped" / "as long as it's enchanted". */
  | { readonly kind: 'sourceAttached'; readonly by: AttachedBy }
  /** "as long as ~ is untapped" (Static Orb) / "as long as ~ is tapped". */
  | { readonly kind: 'sourceTapped'; readonly tapped: boolean }
  /** "as long as it's attacking" (Kor Scythemaster). */
  | { readonly kind: 'sourceAttacking' }
  /** "as long as you have 5 or less life" (Gavony Ironwright). */
  | { readonly kind: 'lifeAtMost'; readonly max: number }
  /**
   * §3.173 — "during your turn, ~ has first strike" (Fresh-Faced Recruit,
   * Duelist of Deep Faith), "as long as it's your turn" (Faithful Pikemaster),
   * "~ gets +2/+2 during your turn" (Skophos Reaver): on while the source's
   * controller is the active player. Read live, so it switches off the moment
   * the turn passes — which is what makes the Recruit a 2/1 on the block.
   */
  | { readonly kind: 'yourTurn' };

/** The value of a count source, relative to the static's SOURCE. */
export function staticCountValue(
  state: GameState,
  source: CardInstance,
  count: StaticCountSource,
): number {
  if (count.countOf === STATIC_COUNT_PERMANENTS_MATCHING) {
    return countPermanentsMatching(
      state,
      count.filter,
      count.scope,
      source.controller,
      count.permanentState,
    );
  }
  return evaluateDerivedCount(state, count.countOf, source.controller);
}

/**
 * Does the source itself fall inside a count? Asked for the printed "another":
 * the count is taken over the board and the source removed from it when it
 * would have been counted — the same question `countPermanentsMatching` asks of
 * every permanent, asked of one.
 */
function sourceCountsToward(
  state: GameState,
  source: CardInstance,
  count: StaticCountSource,
): boolean {
  if (count.countOf !== STATIC_COUNT_PERMANENTS_MATCHING) return false;
  if (count.scope === 'opponents') return false;
  // A one-permanent battlefield view: exactly the filter the whole count uses.
  const alone: GameState = { ...state, battlefield: [source] };
  return (
    countPermanentsMatching(
      alone,
      count.filter,
      count.scope,
      source.controller,
      count.permanentState,
    ) === 1
  );
}

/** Is anything attached to the source of the given attachment kind? */
function sourceHasAttachment(state: GameState, source: CardInstance, by: AttachedBy): boolean {
  const battlefield = state.battlefield;
  for (let i = 0; i < battlefield.length; i++) {
    const perm = battlefield[i]!;
    if (perm.attachedTo !== source.instanceId) continue;
    if (permanentHasSubtype(perm, by)) return true;
  }
  return false;
}

/**
 * Whether the condition holds RIGHT NOW for this source. Pure: reads the
 * state, writes nothing, allocates nothing on the common paths.
 */
export function staticConditionHolds(
  state: GameState,
  source: CardInstance,
  condition: StaticCondition,
): boolean {
  switch (condition.kind) {
    case 'countAtLeast': {
      let value = staticCountValue(state, source, condition.count);
      if (condition.excludeSource === true && sourceCountsToward(state, source, condition.count))
        value -= 1;
      return value >= condition.min;
    }
    case 'sourceAttached':
      return sourceHasAttachment(state, source, condition.by);
    case 'sourceTapped':
      return (source.tapped === true) === condition.tapped;
    case 'sourceAttacking':
      return state.combat !== null && state.combat.attackers.includes(source.instanceId);
    case 'lifeAtMost':
      return state.players[source.controller].life <= condition.max;
    case 'yourTurn':
      return state.activePlayer === source.controller;
  }
}

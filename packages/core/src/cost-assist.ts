/**
 * COST ASSISTANCE — the mechanics that let something other than mana pay part of
 * a spell's cost: **Convoke** (CR 702.51), **Improvise** (CR 702.126) and
 * **Delve** (CR 702.66).
 *
 * All three are one shape wearing three names, which is why they are one table
 * and one planner rather than three implementations that would drift:
 *
 *   - a RESOURCE the caster owns (an untapped creature, an untapped artifact, a
 *     card in the graveyard),
 *   - CONSUMED in a particular way (tapped, tapped, exiled),
 *   - each paying ONE mana toward this spell's cost.
 *
 * The only real difference is what a single resource may pay for. A convoking
 * creature pays "{1} or one mana of that creature's color", so it can cover a
 * coloured pip; an improvising artifact and a delved card pay generic only. That
 * is one boolean in the table, not a branch in the planner.
 *
 * ⚠️ **THE ASSIST IS THE MINIMUM THAT MAKES THE SPELL PAYABLE, NEVER THE
 * MAXIMUM.** Every one of these mechanics is optional ("you MAY tap any number
 * of untapped creatures"), so tapping fewer is always a legal choice — and the
 * resources are not free. A convoked creature cannot block this turn and a
 * delved card is gone from the graveyard for good. A planner that consumed
 * everything it could would be obeying the rules and throwing the game.
 *
 * ⚠️ **HYBRID PIPS ARE LEFT TO REAL MANA.** A `{G/W}` pip really can be paid by
 * a green or a white convoking creature, and this planner does not try: it
 * covers generic and single-colour pips and lets the pool answer for the rest.
 * That is a POLICY, not an approximation of the rules — declining to convoke a
 * pip and paying mana for it instead is a legal choice the caster is always
 * allowed to make, so the engine plays a legal game that is occasionally more
 * conservative than a perfect pilot. It can never play BETTER than the card.
 */

import { colorsOfDefinition, type CardDefinition } from './card.js';
import { canPay, MANA_COLORS, type ManaColor, type ManaCost, type ManaPool } from './mana.js';
import type { CardInstance, GameState, InstanceId, PlayerId } from './state.js';

/** The three printed names for "something other than mana helps pay". */
export type CostAssistKind = 'convoke' | 'improvise' | 'delve';

/** Where a kind's resources live, which decides how they are found and consumed. */
export type CostAssistSource = 'battlefield' | 'graveyard';

interface CostAssistSpec {
  /** Which zone the resources are taken from. */
  readonly source: CostAssistSource;
  /** A battlefield resource must have this card type; a graveyard one is any card. */
  readonly type?: string;
  /**
   * Whether ONE resource can pay a coloured pip. Convoke's creature pays "{1} or
   * one mana of that creature's color"; improvise and delve pay generic only.
   */
  readonly paysColors: boolean;
  /** What happens to the resource — the word the event log uses. */
  readonly consumption: 'tapped' | 'exiled';
}

/**
 * The closed table. A fourth mechanic of this shape is a ROW, not a code change;
 * a kind outside it cannot be written, because the compiler's own field is typed
 * by these keys.
 */
export const COST_ASSISTS: Readonly<Record<CostAssistKind, CostAssistSpec>> = Object.freeze({
  convoke: { source: 'battlefield', type: 'creature', paysColors: true, consumption: 'tapped' },
  improvise: { source: 'battlefield', type: 'artifact', paysColors: false, consumption: 'tapped' },
  delve: { source: 'graveyard', paysColors: false, consumption: 'exiled' },
});

/** What an assist will consume, and the cost the mana pool must still cover. */
export interface CostAssistPlan {
  readonly kind: CostAssistKind;
  /** The permanents to tap, or the graveyard cards to exile, in a stable order. */
  readonly consumed: readonly InstanceId[];
  /** The cost left for real mana once the assist has paid its share. */
  readonly remaining: ManaCost;
}

/** One resource, with the colours it could pay a pip of. */
interface Resource {
  readonly instanceId: InstanceId;
  readonly colors: readonly ManaColor[];
}

/**
 * The resources `caster` could spend, in the stable order the zone stores them.
 *
 * Order matters for determinism, not for quality: a replay must consume the same
 * creatures as the original game, and zone order is the only ordering both sides
 * of a replay agree on.
 */
function resourcesFor(state: GameState, caster: PlayerId, spec: CostAssistSpec): Resource[] {
  const found: Resource[] = [];
  if (spec.source === 'battlefield') {
    for (const permanent of state.battlefield) {
      if (permanent.controller !== caster) continue;
      if (permanent.tapped) continue;
      if (spec.type !== undefined && !hasType(permanent, spec.type)) continue;
      found.push({
        instanceId: permanent.instanceId,
        colors: spec.paysColors ? colorsOfDefinition(permanent.def) : NO_COLORS,
      });
    }
    return found;
  }
  for (const card of state.players[caster]?.graveyard ?? []) {
    found.push({ instanceId: card.instanceId, colors: NO_COLORS });
  }
  return found;
}

const NO_COLORS: readonly ManaColor[] = Object.freeze([]);

function hasType(permanent: CardInstance, type: string): boolean {
  const types = permanent.def.types;
  for (let i = 0; i < types.length; i++) {
    if ((types[i] as string).toLowerCase() === type) return true;
  }
  return false;
}

/** `cost` with one pip of `color` removed, or one generic when `color` is null. */
function withoutOne(cost: ManaCost, color: ManaColor | null): ManaCost {
  if (color === null) {
    const generic = (cost.generic ?? 0) - 1;
    const { generic: _dropped, ...rest } = cost;
    return generic > 0 ? { ...rest, generic } : rest;
  }
  const left = (cost[color] ?? 0) - 1;
  const next: Record<string, unknown> = { ...cost };
  if (left > 0) next[color] = left;
  else delete next[color];
  return next as ManaCost;
}

/**
 * The cheapest assist that makes `cost` payable from `pool`, or undefined when
 * none is needed or none is enough.
 *
 * `undefined` covers three different situations on purpose, because the caller
 * treats them identically: the card has no assist, the pool already pays, or no
 * legal assist closes the gap. Only the middle one is common, and returning a
 * plan there would tap creatures for a spell that needed no help.
 *
 * The payability question is never answered here — it is delegated to `canPay`,
 * the single authority, on every step. A second opinion computed locally is
 * exactly how a planner ends up offering a cast the pay path then refuses.
 */
export function planCostAssist(
  state: GameState,
  caster: PlayerId,
  def: CardDefinition,
  cost: ManaCost | undefined,
  pool: ManaPool,
): CostAssistPlan | undefined {
  const kind = def.costAssist;
  if (kind === undefined || cost === undefined) return undefined;
  if (canPay(pool, cost)) return undefined;
  const spec = COST_ASSISTS[kind];
  const available = resourcesFor(state, caster, spec);
  if (available.length === 0) return undefined;

  const spent = new Set<InstanceId>();
  const consumed: InstanceId[] = [];
  let remaining = cost;

  // 1. COLOURED PIPS THE POOL CANNOT COVER. Assigned first because only a
  //    resource of that exact colour can pay them — spending a green creature on
  //    generic and then finding the {G} unpayable is the classic ordering bug.
  if (spec.paysColors) {
    for (const color of MANA_COLORS) {
      let short = (remaining[color] ?? 0) - pool[color];
      while (short > 0) {
        const helper = available.find(
          (resource) => !spent.has(resource.instanceId) && resource.colors.includes(color),
        );
        if (helper === undefined) break;
        spent.add(helper.instanceId);
        consumed.push(helper.instanceId);
        remaining = withoutOne(remaining, color);
        short -= 1;
      }
    }
  }

  // 2. WHATEVER IS STILL UNPAYABLE, one generic at a time, asking `canPay` after
  //    each step so the loop stops at the MINIMUM rather than at the maximum.
  while (!canPay(pool, remaining)) {
    if ((remaining.generic ?? 0) <= 0) return undefined;
    const helper = available.find((resource) => !spent.has(resource.instanceId));
    if (helper === undefined) return undefined;
    spent.add(helper.instanceId);
    consumed.push(helper.instanceId);
    remaining = withoutOne(remaining, null);
  }

  return consumed.length === 0 ? undefined : { kind, consumed, remaining };
}

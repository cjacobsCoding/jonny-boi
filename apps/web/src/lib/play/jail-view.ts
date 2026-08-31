/**
 * JAILED-CARD grouping (pure, DOM-free, unit-tested) — the §3.57 render model
 * for "Banisher Priest should visually have the card it exiled trapped
 * underneath itself, with the top peeking out from behind".
 *
 * The DATA already exists on every exiled card: `CardInstance.exiledUntilLeavesBy`
 * (a core field since §3.56) names the jailer's instance id, and exile zones are
 * public in every view (hotseat state and the online masked view both carry the
 * full instances). This module only GROUPS: exiled cards in → per-jailer stacks
 * out. Rendering stays in the tile component.
 *
 * An exiled card whose jailer is NOT on the battlefield is not tucked anywhere —
 * either the link outlived its jailer for a frame mid-resolution, or the card
 * was exiled plainly. It simply stays in the exile count, which is the safe,
 * truthful fallback (rule 6: degrade, never invent).
 */
import type { InstanceId } from '@jonny-boi/core';

/** What the tile needs to draw one tucked prisoner. */
export interface JailedCardView {
  readonly instanceId: InstanceId;
  /** The card definition id, for art lookup (a token may resolve to no art). */
  readonly cardId: string;
  readonly name: string;
}

/** The exiled-card facts the grouping reads — a flat shape both views can feed. */
export interface JailSourceCard extends JailedCardView {
  /** The jailer's instance id, when this exile is an until-it-leaves jail. */
  readonly exiledUntilLeavesBy?: InstanceId | undefined;
}

/**
 * Group exiled cards under the jailer that holds them. Only jailers currently
 * on the battlefield get a stack (see the module doc for why); within one
 * jailer, prisoners keep exile order, so the stack reads oldest-first exactly
 * as the zone does.
 */
export function groupJailedByJailer(
  exiled: readonly JailSourceCard[],
  onBattlefield: ReadonlySet<InstanceId>,
): ReadonlyMap<InstanceId, readonly JailedCardView[]> {
  const byJailer = new Map<InstanceId, JailedCardView[]>();
  for (const card of exiled) {
    const jailer = card.exiledUntilLeavesBy;
    if (jailer === undefined || !onBattlefield.has(jailer)) continue;
    const stack = byJailer.get(jailer);
    const view: JailedCardView = { instanceId: card.instanceId, cardId: card.cardId, name: card.name };
    if (stack) stack.push(view);
    else byJailer.set(jailer, [view]);
  }
  return byJailer;
}

/**
 * The instance fields the grouping needs, read off a `CardInstance`-shaped
 * object. Typed structurally rather than importing `CardInstance`, so both the
 * hotseat's engine instances and the online masked view's instances feed it
 * without a cast.
 */
export interface InstanceLike {
  readonly instanceId: InstanceId;
  readonly def: { readonly id: string; readonly name: string };
  readonly exiledUntilLeavesBy?: InstanceId | undefined;
}

/** Adapt zone instances to the grouping's flat shape. */
export function jailSourcesOf(instances: readonly InstanceLike[]): readonly JailSourceCard[] {
  return instances.map((inst) => ({
    instanceId: inst.instanceId,
    cardId: inst.def.id,
    name: inst.def.name,
    exiledUntilLeavesBy: inst.exiledUntilLeavesBy,
  }));
}

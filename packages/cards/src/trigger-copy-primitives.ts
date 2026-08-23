/**
 * COPY A TRIGGERED ABILITY (CR 707.10) — Strionic Resonator.
 *
 * "{2}, {T}: Copy target triggered ability you control. You may choose new
 * targets for the copy."
 *
 * The stack holds two kinds of object and `copy-primitives.ts` handles the other
 * one. A SPELL copy is the harder problem: it carries a card, a printed face, a
 * cast announcement, modes, kicks, an X. A TRIGGER on the stack is already just
 * the resolved shape of an ability — a controller, a source, a list of effect
 * refs and the targets it was aimed at — so copying one is copying that record.
 *
 * That is exactly why this lives beside the spell copier rather than inside it:
 * a shared function would have to branch on `kind` at every line, and the two
 * halves share no field beyond `instanceId` and `controller`.
 *
 * ⚠️ The copy is NOT a card and never becomes one. It resolves, does what the
 * ability does, and is gone — it is never put into a graveyard, never counted by
 * anything that counts cards, and the permanent that originally triggered may
 * already have left the battlefield. `sourceInstanceId` is copied verbatim so
 * "this creature" inside the ability still refers to the same object the
 * original was about (CR 707.10a — a copy has the same characteristics).
 */
import type { EffectContext, EffectPrimitive, InstanceId, PlayerId } from '@jonny-boi/core';
import { describeRestriction, isLegalTarget, legalTargetsFor, restrictionOfEffects } from '@jonny-boi/core';
import { intParam } from './effect-helpers.js';

/** The trigger this effect's first target names, if it is still on the stack. */
function targetedTriggerOnStack(ctx: EffectContext) {
  const target = ctx.targets[0];
  if (target === undefined || target === 'A' || target === 'B') return undefined;
  const object = ctx.state.stack.find((o) => o.instanceId === target);
  return object && object.kind === 'trigger' ? object : undefined;
}

/**
 * "You may choose new targets for the copy" for a TRIGGER copy.
 *
 * Mirrors `retargetCopy` in `copy-primitives.ts`, including the part that took a
 * soak run to find: declining must stay reachable even when the inherited target
 * has left the stack, or the copy is FORCED onto a remaining candidate and two
 * copy effects aimed at each other never terminate. Here `min` drops to 0 in
 * exactly that case, and an empty answer keeps the aim the copy inherited.
 *
 * Returns the targets for the copy, or `undefined` when a question has parked
 * (the caller must then abandon without touching the stack).
 */
function retargetTriggerCopy(
  ctx: EffectContext,
  effects: readonly { readonly primitive: string; readonly params?: Readonly<Record<string, unknown>> }[],
  current: readonly (InstanceId | PlayerId)[],
): readonly (InstanceId | PlayerId)[] | undefined {
  const restriction = restrictionOfEffects(effects as never);
  // An ability that targets nothing has nothing to re-aim. Asking anyway would
  // put a question on screen whose only answer is "no targets".
  if (restriction === undefined || current.length === 0) return current;

  const candidates = legalTargetsFor(ctx.state, restriction, ctx.controller).filter((ref) =>
    isLegalTarget(ctx.state, restriction, ref, ctx.controller),
  );
  if (candidates.length === 0) return current;
  // Nothing to decide: the only legal target is the one it already points at.
  if (candidates.length === 1 && current.length === 1 && candidates[0] === current[0]) return current;

  const keepIsLegal = current.every((ref) => candidates.includes(ref));
  const answer = ctx.ask({
    kind: 'selectTargets',
    chooser: ctx.controller,
    prompt: `Choose new targets for the copied ability? (${describeRestriction(restriction)})`,
    candidates: candidates.map((ref) => targetOptionFor(ctx, ref)),
    restriction,
    // Same count rule as a spell copy: never more than the ability already aims.
    min: keepIsLegal ? current.length : 0,
    max: current.length,
  });
  if (answer === undefined) return undefined; // parked — caller abandons
  if (answer.kind !== 'selectTargets') return current;
  // Declined — the copy keeps the aim it inherited, legal or not.
  return answer.targets.length === 0 ? current : answer.targets;
}

/** Describe one candidate for the re-aim question's option list. */
function targetOptionFor(
  ctx: EffectContext,
  ref: InstanceId | PlayerId,
): { readonly ref: InstanceId | PlayerId; readonly name: string; readonly controller: PlayerId } {
  if (ref === 'A' || ref === 'B') return { ref, name: `Player ${ref}`, controller: ref };
  for (const permanent of ctx.state.battlefield) {
    if (permanent.instanceId === ref) {
      return { ref, name: permanent.def.name, controller: permanent.controller };
    }
  }
  for (const object of ctx.state.stack) {
    if (object.kind === 'spell' && object.instanceId === ref) {
      return { ref, name: object.card.def.name, controller: object.controller };
    }
  }
  return { ref, name: `#${ref}`, controller: ctx.controller };
}

/**
 * `copyTriggeredAbility` — put a copy of the targeted trigger on the stack.
 *
 * The copy goes ABOVE the original, so it resolves first, which is what a copy
 * does. `params.count` makes more than one (nothing in the pool needs it yet;
 * the parameter exists because the spell copier has it and the two should not
 * disagree about what "copy" means).
 */
export const copyTriggeredAbility: EffectPrimitive = (ctx) => {
  const original = targetedTriggerOnStack(ctx);
  // Already resolved or countered — fizzle, the same resolution-time re-check
  // every targeting primitive in this package makes.
  if (!original) return;
  if (!isLegalTarget(ctx.state, 'triggeredAbilityYouControl', original.instanceId, ctx.controller)) return;
  const count = Math.max(0, intParam(ctx, 'count', 1));

  // BUILT FIRST, PUSHED LAST — `ctx.ask` can park this resolution, and a parked
  // ref is re-run from the top, so anything pushed before the last question is
  // answered would be pushed again on every re-entry. Same discipline as
  // `copySpell`.
  const copies: (typeof original)[] = [];
  for (let i = 0; i < count; i++) {
    const targets = retargetTriggerCopy(ctx, original.effects as never, original.targets);
    if (targets === undefined) return; // parked — abandon without mutating
    copies.push({
      ...original,
      instanceId: ctx.state.nextInstanceId++,
      targets: [...targets],
      label: `${original.label} (copy)`,
    });
  }

  for (const copy of copies) {
    ctx.state.stack.push(copy);
    ctx.emit({
      type: 'triggerCopied',
      instanceId: copy.instanceId,
      copiedInstanceId: original.instanceId,
      controller: copy.controller,
      label: copy.label,
    });
  }
};

/** The primitives this module contributes to the shared registry. */
export const TRIGGER_COPY_PRIMITIVES: Readonly<Record<string, EffectPrimitive>> = Object.freeze({
  copyTriggeredAbility,
});

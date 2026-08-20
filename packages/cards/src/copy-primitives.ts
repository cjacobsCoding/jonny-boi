/**
 * The COPY-CREATING primitives — a copy of a spell on the stack (CR 707.10) and
 * a token copy of a permanent (CR 707.2 + CR 111).
 *
 * They live together, and apart from `./primitives`, for one reason: both create
 * an object that is **not a card**, and both get everything they know about what
 * a copy IS from core's single `copiableDefOf` answer. Nothing here decides what
 * copying gives you; core does, once, for the as-enters copy and these two alike.
 *
 * ## Ask first, then mutate
 * The same contract as `./choice-primitives`, and `copySpell` leans on it harder
 * than anything else in the package: it asks up to one question PER AIMED SLOT
 * of the copy it is about to make. Every one of those asks may park, and the
 * engine then re-runs this ref from the top with the answers replayed — so the
 * copy is built as a local value and only pushed onto the stack once every
 * question has an answer. Push first and a parked re-aim would leave a second
 * copy on the stack for every question asked.
 */

import type {
  CardInstance,
  EffectContext,
  EffectPrimitive,
  InstanceId,
  PlayerId,
  SpellStackObject,
  TargetRestriction,
} from '@jonny-boi/core';
import {
  describeRestriction,
  isLegalTarget,
  legalTargetsFor,
  makeSpellCopy,
  spellCopyAimAt,
  spellCopyAimRestriction,
  spellCopyAimSlots,
  tokenCopyDefOf,
  withSpellCopyAim,
} from '@jonny-boi/core';
import type { CopyExceptions } from '@jonny-boi/core';
import { intParam, restrictionParam, targetedSpellOnStack } from './effect-helpers.js';

/**
 * `copySpell` — "Copy target instant or sorcery spell. You may choose new
 * targets for the copy." (Reverberate, Fork, Narset's Reversal, Twincast.)
 *
 * Params:
 *  - `count`     — how many copies (default 1). "Copy it twice" is a count, not
 *                  a second primitive; each copy is aimed on its own, because
 *                  each is a separate object with its own targets.
 *  - `mayRetarget` — whether the printed text grants the "you may choose new
 *                  targets" permission (default TRUE, because every printed copy
 *                  effect in Magic that this compiler can read grants it). A card
 *                  that does not say it keeps the original's aim, and the
 *                  question is never asked.
 *  - `targets`   — the target restriction, read by core at cast time. Present so
 *                  the ref declares it in the one reserved param name every other
 *                  targeting primitive uses.
 *
 * The copies go on the stack ABOVE the original, so they resolve first — which
 * is what a copy does, and what makes Narset's Reversal work at all (the copy
 * resolves; the original has already been returned to its owner's hand by the
 * time it would have).
 */
export const copySpell: EffectPrimitive = (ctx) => {
  const original = targetedSpellOnStack(ctx);
  // Illegal or already gone → fizzle, the same re-check every targeting
  // primitive in this package makes at resolution.
  if (!original) return;
  if (!isLegalTarget(ctx.state, restrictionParam(ctx), original.instanceId, ctx.controller, ctx.source.def)) return;
  const count = Math.max(0, intParam(ctx, 'count', 1));
  const mayRetarget = ctx.params.mayRetarget !== false;

  // BUILT FIRST, PUSHED LAST. Every `ask` below can park the resolution, and a
  // parked ref is re-run from the top — so anything pushed before the last
  // question is answered would be pushed again on every re-entry.
  const copies: SpellStackObject[] = [];
  for (let i = 0; i < count; i++) {
    let copy = makeSpellCopy(ctx.state, original, ctx.controller);
    if (mayRetarget) {
      const aimed = retargetCopy(ctx, copy);
      // A parked question: abandon this whole invocation without touching the
      // stack. The engine re-runs it, `frame.answers` replays what has already
      // been decided, and execution reaches this point again with an answer.
      if (aimed === undefined) return;
      copy = aimed;
    }
    copies.push(copy);
  }

  for (const copy of copies) {
    ctx.state.stack.push(copy);
    ctx.emit({
      type: 'spellCopied',
      instanceId: copy.instanceId,
      copiedInstanceId: original.instanceId,
      controller: copy.controller,
      name: copy.card.def.name,
    });
  }
};

/**
 * "You may choose new targets for the copy" (CR 707.10), asked once per AIMED
 * SLOT — the frame-wide target for an ordinary spell, and one per announced mode
 * for a modal one.
 *
 * Returns the re-aimed copy, or `undefined` when a question has parked (the
 * caller must then abandon without mutating anything).
 *
 * A slot whose restriction cannot be read is LEFT ALONE rather than offered
 * unrestricted, and a slot with only its current target available is not asked
 * about at all. Both are the same direction: the copy keeps the original's aim,
 * which can never play better than the printed card.
 */
function retargetCopy(ctx: EffectContext, copy: SpellStackObject): SpellStackObject | undefined {
  let aimed = copy;
  for (const slot of spellCopyAimSlots(copy)) {
    const restriction = spellCopyAimRestriction(aimed, slot);
    if (restriction === undefined) continue;
    const current = spellCopyAimAt(aimed, slot);
    const candidates = legalTargetsFor(ctx.state, restriction, ctx.controller, aimed.card.def).filter(
      // The copy is on nobody's stack yet, so it cannot be offered itself; the
      // ORIGINAL still is, and re-aiming a copy of a counterspell at the spell
      // that copied it is a real and legal play.
      (ref) => isLegalTarget(ctx.state, restriction, ref, ctx.controller, aimed.card.def),
    );
    if (candidates.length === 0) continue;
    // Nothing to decide: the only legal target is the one it already points at.
    if (candidates.length === 1 && current.length === 1 && candidates[0] === current[0]) continue;
    const answer = ctx.ask({
      kind: 'selectTargets',
      chooser: ctx.controller,
      prompt: `Choose new targets for the copy of ${aimed.card.def.name}? (${describeRestriction(restriction)})`,
      candidates: candidates.map((ref) => targetOptionFor(ctx, ref)),
      restriction,
      // Exactly as many as the slot already aims (CR 707.10 — the copy has the
      // SAME targets; "choose new targets" changes what they are, never how
      // many). Declining is expressed by re-choosing the same object, which is
      // what a player physically does in paper.
      min: current.length,
      max: current.length,
    });
    if (answer === undefined) return undefined; // parked — caller abandons
    if (answer.kind !== 'selectTargets') continue;
    aimed = withSpellCopyAim(aimed, slot, answer.targets);
  }
  return aimed;
}

/**
 * Describe one target for the re-aim question's option list.
 *
 * Written here rather than reaching for the engine's private `targetOptionFor`
 * because a primitive has no engine access: it sees a `GameState` and must
 * answer from it. The three zones a re-aimable target can be in are the
 * battlefield, the stack (a copy of a counterspell) and a seat.
 */
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
 * `createTokenCopy` — "Create a token that's a copy of target creature."
 * (Rite of Replication, Kiki-Jiki, Helm of the Host, Cackling Counterpart.)
 *
 * Params:
 *  - `count`       — how many tokens (default 1).
 *  - `kickedCount` — how many instead when the spell was KICKED. Rite of
 *                    Replication's "if this spell was kicked, create five of
 *                    those tokens instead" is this one number, read off the
 *                    cast-time decision that rode the stack object into the
 *                    resolution — not a second effect ref guarded by `ifKicked`,
 *                    because the printed sentence replaces the count rather than
 *                    adding an effect.
 *  - `except`      — the printed "except …" tail, in core's {@link CopyExceptions}
 *                    shape, exactly as the as-enters copy's is. One authoring
 *                    vocabulary for both, so "except it has haste" means the same
 *                    thing whichever kind of copy prints it.
 *  - `targets`     — the target restriction.
 *
 * What it copies is `copiableDefOf` (CR 707.2), so a token copy of a 1/1 wearing
 * three +1/+1 counters is a **1/1**, a token copy of a transformed permanent is
 * its FRONT face, and a token copy of a Clone is whatever the Clone copies.
 *
 * TOKEN-NESS IS NOT SET HERE. `ctx.createToken` stamps it on the definition, so
 * an object built from another card's copiable values is still a token — it
 * answers "yes" to every nontoken filter, and it ceases to exist when it leaves
 * the battlefield (CR 704.5d). One place, not two.
 */
export const createTokenCopy: EffectPrimitive = (ctx) => {
  const source = copySourceFor(ctx);
  if (!source) return;
  const kickedCount = intParam(ctx, 'kickedCount', 0);
  // "If this spell was kicked, create FIVE of those tokens INSTEAD" — a
  // replacement of the count, which is why this is a max and not a sum.
  const count = kickedCount > 0 && ctx.kicked === true ? kickedCount : Math.max(0, intParam(ctx, 'count', 1));
  const def = tokenCopyDefOf(source, exceptParam(ctx));
  for (let i = 0; i < count; i++) {
    const instanceId = ctx.createToken(def);
    // Said out loud, and NOT folded into `tokenCreated` (which `createToken`
    // emits for this object like any other, so every ETB trigger sees the entry
    // unchanged): this is the only record of WHICH board object the token is a
    // copy of.
    ctx.emit({
      type: 'tokenCopyCreated',
      instanceId,
      copiedInstanceId: source.instanceId,
      controller: ctx.controller,
      name: def.name,
    });
  }
};

/**
 * What `createTokenCopy` copies: the targeted permanent, or — when the card
 * names no target — the permanent this effect's source is ATTACHED TO.
 *
 * The second case is Helm of the Host's "a copy of equipped creature", which
 * points at its host rather than at a target. Reusing `attachedTo` is what makes
 * that a data answer instead of a second primitive, and it is the same field the
 * equipped-creature trigger family already reads.
 */
function copySourceFor(ctx: EffectContext): CardInstance | undefined {
  if (ctx.params.equipped === true) {
    const host = ctx.source.attachedTo;
    if (host == null) return undefined;
    return ctx.state.battlefield.find((c) => c.instanceId === host);
  }
  const target = ctx.targets[0];
  if (target === undefined || target === 'A' || target === 'B') return undefined;
  const restriction: TargetRestriction = restrictionParam(ctx);
  if (!isLegalTarget(ctx.state, restriction, target, ctx.controller, ctx.source.def)) return undefined;
  return ctx.state.battlefield.find((c) => c.instanceId === target);
}

/**
 * The `except` param as a {@link CopyExceptions}, validated shallowly and
 * narrowed to the fields a TOKEN copy can honour.
 *
 * `entersTapped`, `extraCounters` and `extraLoyalty` are deliberately carried
 * too: they mean exactly what they mean for an as-enters copy, and a token
 * enters the battlefield through the same shared accessors. A malformed entry is
 * dropped rather than thrown on (DESIGN §1.6 robust) — the compiler never emits
 * one, so this guards hand-authored data.
 */
function exceptParam(ctx: EffectContext): CopyExceptions | undefined {
  const raw = ctx.params.except;
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  return raw as CopyExceptions;
}

/**
 * `returnSpellToHand` — "…then return it to its owner's hand" (Narset's
 * Reversal), applied to the SPELL this effect targets.
 *
 * Its own primitive rather than a flag on `copySpell`, because it is its own
 * printed sentence and could appear without a copy at all. It is deliberately
 * NOT `counterSpell`: a spell returned to its owner's hand was not countered, so
 * "this spell can't be countered" does not stop it and no counter trigger sees
 * it. Nothing else in the engine could express that difference.
 *
 * A copy of a spell has no hand to go to, so returning one CEASES IT TO EXIST
 * (CR 704.5e) — the same rule every other exit from the stack asks, through the
 * same one function.
 */
export const returnSpellToHand: EffectPrimitive = (ctx) => {
  const spell = targetedSpellOnStack(ctx);
  if (!spell) return;
  const index = ctx.state.stack.indexOf(spell);
  if (index < 0) return;
  ctx.state.stack.splice(index, 1);
  const card = spell.card;
  if (spell.isSpellCopy === true) {
    ctx.emit({ type: 'spellCopyCeasedToExist', instanceId: card.instanceId, name: card.def.name });
    return;
  }
  card.zone = 'hand';
  ctx.state.players[card.owner].hand.push(card);
  ctx.emit({ type: 'zoneChange', instanceId: card.instanceId, from: 'stack', to: 'hand' });
};

/** The primitives this module contributes to the shared registry. */
export const COPY_PRIMITIVES: Readonly<Record<string, EffectPrimitive>> = Object.freeze({
  copySpell,
  createTokenCopy,
  returnSpellToHand,
});

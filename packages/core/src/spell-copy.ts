/**
 * A COPY OF A SPELL ON THE STACK (CR 707.10) — the object that is not a card.
 *
 * `copy.ts` copies ONTO something that already exists: a Clone entering the
 * battlefield swaps its own `def`, and it therefore inherits a card, an owner
 * and a zone to go home to. This file CREATES the copy, and what it creates has
 * none of those things.
 *
 * ## Why this could not be bolted onto the as-enters path
 * `SpellStackObject.resolvesTo` offers battlefield / graveyard / exile / hand,
 * and `spellLeaveDestination` answers with one of them at both exits from the
 * stack (a resolution, and a counter). **Every one of those exits leaves a CARD
 * in a zone.** A copy of a spell is not a card: CR 704.5e says a copy of a spell
 * in any zone other than the stack ceases to exist. Take any of the four exits
 * and the game gains a phantom card that delirium counts, that Tarmogoyf reads,
 * that flashback could recast and that "return target creature card from your
 * graveyard" could target — a whole card, from nowhere, every time a Reverberate
 * resolves. That is the reason this system was reported by name instead of
 * approximated, and it is the one thing here that had to be got right.
 *
 * ## How it is got right: one fact, asked at one place
 * {@link SpellStackObject.isSpellCopy} is set on the object, and
 * `spellLeaveDestination` — which BOTH exits already ask, in two different
 * packages — answers `'ceaseToExist'` for it **before every other rule**. So a
 * copy of a flashback cast is not exiled, a copy of a bought-back spell does not
 * return to a hand, and a copy that is countered does not reach a graveyard.
 * There is no `if (copy)` at any call site to forget, because the destination is
 * a value in a return type that every caller must handle to type-check.
 *
 * A copy that resolves to the BATTLEFIELD (a copied permanent spell) is the one
 * case that does keep an object, and it keeps it as a **TOKEN** — see
 * `finishSpellResolution`, which stamps token-ness for exactly this reason. A
 * token then ceases to exist by the token rule (CR 704.5d) the moment it leaves
 * the battlefield, so that exit leaves no phantom either.
 *
 * ## Everything chosen for the spell comes with the copy (CR 707.10)
 * A copy copies the spell's characteristics **and all the decisions made for
 * it** — its targets, the value of X, whether it was kicked and how many times,
 * and a modal spell's announced modes with each mode's own aim. Those live on
 * the STACK OBJECT, which is why {@link makeSpellCopy} takes one rather than a
 * card: copy a Blaze cast for X=5 and the copy deals five.
 *
 * ## "You may choose new targets for the copy"
 * The one decision the copy's controller may CHANGE (CR 707.10). It is an aiming
 * moment at a time the engine had none: targets are chosen as a spell is cast or
 * as a trigger goes on the stack, and nothing aimed an object the engine itself
 * had just created. It happens inside the copying spell's RESOLUTION, so the
 * question is asked through the ordinary resolution channel and the suspend /
 * resume machinery carries it — no new transport, and it replays from a seed.
 * {@link spellCopyAimSlots} is what makes that work for a modal copy too: the
 * slots are the announced modes, each re-aimed on its own.
 */

import { copiableDefOf } from './copy.js';
import { modeById } from './modal.js';
import type { CardInstance, GameState, InstanceId, PlayerId, SpellStackObject } from './state.js';
import { NO_COUNTERS } from './state.js';
import type { TargetRestriction } from './targeting.js';
import { DEFAULT_TARGET_RESTRICTION, targetRestrictionOf } from './targeting.js';

/** The shared empty aim list — frozen, so nothing can write through it. */
const NO_TARGETS_AIMED: readonly (InstanceId | PlayerId)[] = Object.freeze([]);

/**
 * The slot number that means "the stack object's own frame-wide `targets`".
 *
 * Deliberately not a valid `modePicks` index, so a caller that mixed the two up
 * indexes nothing rather than silently re-aiming the wrong mode — the same class
 * of bug `ResolutionFrame.effectTargets`' parallel-array note warns about.
 */
export const MODELESS_AIM_SLOT = -1;

const ONLY_MODELESS_SLOT: readonly number[] = Object.freeze([MODELESS_AIM_SLOT]);
const NO_AIM_SLOTS: readonly number[] = Object.freeze([]);

/**
 * **CR 707.10 — build a copy of `original` to put onto the stack.**
 *
 * The copy is an ordinary {@link SpellStackObject}, and that is the design: a
 * copy of a spell IS a spell. It can be countered, it is a legal "target spell",
 * and it resolves through the very same code — so there is no second resolution
 * path to keep in step, exactly as swapping `def` gave the as-enters copy no
 * second characteristic path. Only two things differ, and both follow from it
 * not being a card:
 *
 *  1. its {@link CardInstance} is MINTED here — a fresh `instanceId`, `zone:
 *     'stack'`, and the ORIGINAL's copiable values as its definition. It was
 *     never in anybody's library, which is what keeps every consumer that maps
 *     an instance id back to a decklist row (`paired-arms.ts`) from mistaking it
 *     for one; that consumer's conservative "an id I cannot place" branch is
 *     what makes it sound, and a test pins the id being new;
 *  2. {@link SpellStackObject.isSpellCopy} is set, which is what makes
 *     `spellLeaveDestination` answer `'ceaseToExist'` at every exit.
 *
 * What deliberately does NOT come across is the bookkeeping of a CAST, because a
 * copy is not cast (CR 707.10): `castFrom` (whose only job is to exile a
 * flashback CARD), `boughtBack` (which returns a CARD to a hand),
 * `additionalCostPaid` (nothing was paid for this object) and
 * `awaitingCastChoice` (nothing is being announced). None of them could change
 * where the copy goes in any case — `isSpellCopy` outranks all of them — so
 * carrying them would only state a falsehood about the copy in the state a UI
 * and a replay both read.
 *
 * PURE of the stack: the caller pushes. That lets the AI and a UI price what a
 * copy would be without creating one, the same discipline `copyResultDef` keeps.
 */
export function makeSpellCopy(
  state: GameState,
  original: SpellStackObject,
  controller: PlayerId,
): SpellStackObject {
  const instanceId = state.nextInstanceId++;
  const card: CardInstance = {
    instanceId,
    // CR 707.2 through the one shared answer: a copy of a TRANSFORMED permanent
    // spell is its front face, and a copy of something that is itself a copy is
    // what THAT copies. Asking `copiableDefOf` rather than reading
    // `original.card.def` is what makes both true here with no second rule.
    def: copyDefinitionFor(original),
    // The copy's controller is whoever the effect creating it says — usually the
    // COPYING spell's controller, which is not the original's (Reverberate can
    // copy an opponent's spell, and the copy is yours).
    controller,
    // A copy has no owner in the CR sense: nobody owns it, because it is not a
    // card. `owner` is a required field that every zone move reads, and this
    // object never makes one — it ceases to exist instead. Setting it equal to
    // the controller is what keeps "whose graveyard?" from ever being asked
    // about an object that has no answer.
    owner: controller,
    zone: 'stack',
    tapped: false,
    summoningSick: false,
    damageMarked: 0,
    markedByDeathtouch: false,
    counters: NO_COUNTERS,
  };
  return {
    kind: 'spell',
    instanceId,
    card,
    controller,
    resolvesTo: original.resolvesTo,
    targets: [...original.targets],
    isSpellCopy: true,
    ...(original.xValue !== undefined ? { xValue: original.xValue } : {}),
    ...(original.kicked !== undefined ? { kicked: original.kicked } : {}),
    ...(original.kickCount !== undefined ? { kickCount: original.kickCount } : {}),
    // Deep-copied for the same reason `internal/clone.ts` deep-copies it: a
    // pick's `targets` array is written into when a mode is re-aimed, and a
    // shared array would let re-aiming the COPY silently re-aim the ORIGINAL —
    // a spell the copier does not control.
    ...(original.modePicks !== undefined
      ? {
          modePicks: original.modePicks.map((pick) => ({
            modeId: pick.modeId,
            ...(pick.targets !== undefined ? { targets: [...pick.targets] } : {}),
          })),
        }
      : {}),
  };
}

/**
 * The copy's definition — the original's copiable values, plus token-ness when
 * the copy is of a PERMANENT spell.
 *
 * A copy of a permanent spell is the one copy that keeps an object after it
 * resolves, and what it keeps is a **TOKEN**: it is not a card, so the thing it
 * puts onto the battlefield cannot be one. Stamping that on the DEFINITION is
 * both the smallest change and the most robust one — a definition field survives
 * the per-action clone by construction (`internal/clone.ts` shares `def` by
 * reference and says so), so unlike a new instance or stack-object field there
 * is no line for a field-by-field copy to forget. It also makes the object
 * honest while it is still on the stack, which it is: a copy of a creature spell
 * is not a creature CARD at any point in its life.
 *
 * The consequence that matters is the one at the far end: the permanent it
 * becomes ceases to exist when it leaves the battlefield (CR 704.5d), through
 * the same two funnels every other token uses. So neither exit — resolving into
 * play, or dying afterwards — can leave a card behind.
 */
function copyDefinitionFor(original: SpellStackObject) {
  const copied = copiableDefOf(original.card);
  if (original.resolvesTo !== 'battlefield' || copied.isToken === true) return copied;
  return { ...copied, isToken: true } as const;
}

/**
 * The aimed SLOTS of a copy — the places "you may choose new targets for the
 * copy" (CR 707.10) can point somewhere else.
 *
 * A modal spell aims per ANNOUNCED MODE ("Counter target spell" and "Return
 * target permanent to its owner's hand", chosen together, point at two different
 * objects), so its slots are its picks; everything else has the one frame-wide
 * target list, named by {@link MODELESS_AIM_SLOT}. Returned as INDICES rather
 * than as targets so an answer is written back to exactly the slot the question
 * was asked about.
 *
 * A slot with no target is not offered: "you may choose new targets" is
 * permission to change an aim, not to add one. The copy has the same targets the
 * original does (CR 707.10), and how many there are is a characteristic of the
 * spell rather than a decision anybody gets to revisit.
 */
export function spellCopyAimSlots(copy: SpellStackObject): readonly number[] {
  if (copy.modePicks !== undefined) {
    const slots: number[] = [];
    for (let i = 0; i < copy.modePicks.length; i++) {
      const targets = copy.modePicks[i]?.targets;
      if (targets !== undefined && targets.length > 0) slots.push(i);
    }
    return slots;
  }
  return copy.targets.length > 0 ? ONLY_MODELESS_SLOT : NO_AIM_SLOTS;
}

/** What `slot` currently points at (see {@link spellCopyAimSlots}). */
export function spellCopyAimAt(copy: SpellStackObject, slot: number): readonly (InstanceId | PlayerId)[] {
  if (slot === MODELESS_AIM_SLOT) return copy.targets;
  return copy.modePicks?.[slot]?.targets ?? NO_TARGETS_AIMED;
}

/**
 * What `slot` may be re-aimed at — the printed restriction of the thing being
 * aimed, which is the SPELL's for the frame-wide slot and the MODE's for a
 * mode's.
 *
 * `undefined` means "this slot declares no restriction", which the caller must
 * treat as unaimable rather than as unrestricted: a copy whose restriction
 * cannot be read must keep the original's targets, and that is the direction
 * that can never play better than the printed card.
 */
export function spellCopyAimRestriction(copy: SpellStackObject, slot: number): TargetRestriction | undefined {
  if (slot === MODELESS_AIM_SLOT) {
    // ⚠️ `targetRestrictionOf` deliberately answers `undefined` for a spell whose
    // effect declares the DEFAULT restriction, because "any target" is left
    // unpoliced on the cast path for cost reasons (see its own note). Read
    // literally that would mean Lightning Bolt — the single most-copied card in
    // Magic — could never be re-aimed, so the default is restored here. It is a
    // restoration and not a guess: a slot is only offered when the copy already
    // AIMS somewhere, so the spell provably targets, and `'any'` is precisely
    // the set the engine let it be cast at in the first place.
    return targetRestrictionOf(copy.card.def) ?? DEFAULT_TARGET_RESTRICTION;
  }
  const pick = copy.modePicks?.[slot];
  if (pick === undefined) return undefined;
  // A MODE's restriction needs no such fallback: it is explicit data, where
  // present means "this mode names exactly one target of this shape" and `'any'`
  // is meaningful (see `SpellMode.targets`). Absent means the mode is
  // target-free, and a target-free mode is never offered a slot.
  return modeById(copy.card.def, pick.modeId)?.targets;
}

/**
 * Re-aim one slot of a copy, returning the stack object with the new aim.
 *
 * A NEW object rather than a mutation: `SpellStackObject`'s fields are
 * `readonly` and the stack is a plain array the caller splices — the same shape
 * the engine's own `patchSpellOnStack` uses, kept here so both copy paths agree
 * on what re-aiming means.
 */
export function withSpellCopyAim(
  copy: SpellStackObject,
  slot: number,
  targets: readonly (InstanceId | PlayerId)[],
): SpellStackObject {
  if (slot === MODELESS_AIM_SLOT) return { ...copy, targets: [...targets] };
  if (copy.modePicks === undefined) return copy;
  return {
    ...copy,
    modePicks: copy.modePicks.map((pick, index) =>
      index === slot ? { modeId: pick.modeId, targets: [...targets] } : pick,
    ),
  };
}

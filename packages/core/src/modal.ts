/**
 * MODAL SPELLS — "Choose one —", "Choose one or both —", "Choose two", "Choose
 * up to three", and "Choose two. You may choose the same mode more than once."
 *
 * ## Where the decision happens, and why it matters
 * Modes are chosen as the spell is CAST (CR 601.2b), and each chosen mode's
 * targets are chosen at cast too (CR 601.2c) — *before* anything resolves and
 * before the opponent gets priority to respond. That timing is the whole card:
 * a Cryptic Command whose modes were picked on resolution would let its
 * controller see the opponent's response first, which is strictly better than
 * the printed card. So this module's job is to answer, at CAST time, "which
 * modes may be announced?" and "what may each announced mode point at?".
 *
 * ## The choosability rule (the half that is easy to get wrong)
 * You may only announce a mode you could legally announce (CR 601.2b/601.2c
 * together): a mode that needs a target needs a LEGAL target to exist. So
 * "Counter target spell" simply is not on the menu with an empty stack, and a
 * modal spell that cannot seat any mode cannot be cast at all. Both directions
 * are enforced here and read by the same two callers that must never disagree —
 * `generateLegalActions` (the offer) and `applyCastSpell` (the accept).
 *
 * Everything here is a pure read over a definition plus the board. It never
 * mutates, and it holds no opinion about how the questions are asked — that is
 * the engine's cast-time choice pipeline, which parks a `chooseModes` question
 * and then one `selectTargets` question per targeting pick.
 */

import type { CardDefinition, EffectRef, ModalSpec, SpellMode } from './card.js';
import type { GameState, InstanceId, ModePick, PlayerId } from './state.js';
import { isLegalTarget, legalTargetsFor } from './targeting.js';

/**
 * The modal header of a definition, or `undefined` when the card is not modal.
 * A spec with no modes is treated as NOT modal: a "Choose one —" with nothing
 * under it is a malformed record, and reading it as a modal spell would park a
 * question with no answers.
 */
export function modalSpecOf(def: CardDefinition): ModalSpec | undefined {
  const spec = def.modal;
  if (!spec || spec.modes.length === 0) return undefined;
  return spec;
}

/**
 * Whether `mode` may be announced right now — i.e. whether the target it names
 * exists on this board. A target-free mode is always choosable.
 *
 * `source` is the spell being cast, passed so protection is judged against the
 * real source exactly as the engine will judge it at resolution.
 */
export function modeIsChoosable(
  state: GameState,
  mode: SpellMode,
  caster: PlayerId,
  source: CardDefinition,
): boolean {
  if (mode.targets === undefined) return true;
  return legalTargetsFor(state, mode.targets, caster, source).length > 0;
}

/** The modes of `def` that may be announced right now, in PRINTED order. */
export function choosableModes(
  state: GameState,
  def: CardDefinition,
  caster: PlayerId,
): readonly SpellMode[] {
  const spec = modalSpecOf(def);
  if (!spec) return [];
  return spec.modes.filter((mode) => modeIsChoosable(state, mode, caster, def));
}

/** What one cast will be asked to choose: the clamped counts + the live menu. */
export interface ModeCounts {
  readonly min: number;
  readonly max: number;
  readonly choosable: readonly SpellMode[];
}

/**
 * How many modes this cast will actually be asked to choose — the printed
 * `min`/`max` clamped to what is choosable on this board.
 *
 * The clamp is what makes "Choose two —" playable with only one legal mode
 * left: MTG's own rule (CR 601.2b) is that you choose as many as you can, so a
 * Cryptic Command with nothing to counter and nothing to bounce still resolves
 * as the best legal version of itself rather than being uncastable. Repeats are
 * the exception — when the same mode may be chosen more than once, ONE
 * choosable mode already satisfies any printed count.
 */
export function modeCountsFor(
  state: GameState,
  def: CardDefinition,
  caster: PlayerId,
): ModeCounts | undefined {
  const spec = modalSpecOf(def);
  if (!spec) return undefined;
  const choosable = choosableModes(state, def, caster);
  const ceiling =
    spec.allowRepeats && choosable.length > 0 ? spec.max : Math.min(spec.max, choosable.length);
  const max = Math.max(0, ceiling);
  const min = Math.max(0, Math.min(spec.min, max));
  return { min, max, choosable };
}

/**
 * Whether a modal spell can be cast at all right now: it must be able to
 * announce at least one mode.
 *
 * A "Choose up to two" with nothing choosable is deliberately NOT castable
 * either — announcing zero modes is a spell that does nothing, and offering it
 * would let a pilot burn a card and its mana on a guaranteed blank.
 */
export function modalSpellIsCastable(state: GameState, def: CardDefinition, caster: PlayerId): boolean {
  const counts = modeCountsFor(state, def, caster);
  if (!counts) return true; // not modal — nothing for this rule to say
  return counts.max > 0;
}

/** The printed mode with this id, or `undefined`. */
export function modeById(def: CardDefinition, modeId: string): SpellMode | undefined {
  return modalSpecOf(def)?.modes.find((mode) => mode.id === modeId);
}

/**
 * Order a set of announced mode ids into the PICKS the stack object carries:
 * printed order, one entry per pick.
 *
 * Printed order, not answer order, is how MTG resolves a modal spell (CR
 * 601.2b) — and it is observable: a Cryptic Command that counters and then
 * draws is a different card from one that draws and then counters, when the
 * countered spell was the one about to make you discard.
 */
export function orderPicks(def: CardDefinition, chosenIds: readonly string[]): ModePick[] {
  const spec = modalSpecOf(def);
  if (!spec) return [];
  const counts = new Map<string, number>();
  for (const id of chosenIds) counts.set(id, (counts.get(id) ?? 0) + 1);
  const picks: ModePick[] = [];
  for (const mode of spec.modes) {
    const times = counts.get(mode.id) ?? 0;
    for (let i = 0; i < times; i++) picks.push({ modeId: mode.id });
  }
  return picks;
}

/**
 * The index of the first pick still waiting for its target, or `-1` when every
 * pick is aimed. Picks are aimed in printed order, which is also the order they
 * will resolve in — so a human aiming a two-mode Command answers the questions
 * in the order the card reads.
 */
export function nextUnaimedPick(def: CardDefinition, picks: readonly ModePick[]): number {
  for (let i = 0; i < picks.length; i++) {
    const pick = picks[i] as ModePick;
    if (pick.targets !== undefined) continue;
    const mode = modeById(def, pick.modeId);
    if (mode?.targets !== undefined) return i;
  }
  return -1;
}

/**
 * Whether an aimed pick is STILL legal — re-checked as the spell resolves, the
 * same way a spell's own targets are. A mode whose target has died or become
 * untargetable simply does nothing (CR 608.2b: the rest of the spell still
 * resolves), which is why this returns a verdict rather than fizzling the whole
 * spell.
 */
export function pickTargetIsLegal(
  state: GameState,
  def: CardDefinition,
  pick: ModePick,
  caster: PlayerId,
): boolean {
  const mode = modeById(def, pick.modeId);
  if (!mode || mode.targets === undefined) return true;
  const target = pick.targets?.[0];
  if (target === undefined) return false;
  return isLegalTarget(state, mode.targets, target, caster, def);
}

/** A modal spell's picks, flattened into what a resolution frame runs. */
export interface ModalResolution {
  readonly effects: EffectRef[];
  readonly effectTargets: Array<ReadonlyArray<InstanceId | PlayerId> | undefined>;
}

/**
 * Flatten announced picks into the effect refs + per-effect targets a
 * resolution runs: printed order, each mode's effects carrying that mode's own
 * chosen target.
 *
 * A pick whose target is no longer legal contributes NOTHING (its mode does not
 * happen) while its siblings still resolve — the printed behaviour of a modal
 * spell one of whose targets left.
 */
export function picksToResolution(
  state: GameState,
  def: CardDefinition,
  picks: readonly ModePick[],
  caster: PlayerId,
): ModalResolution {
  const effects: EffectRef[] = [];
  const effectTargets: Array<ReadonlyArray<InstanceId | PlayerId> | undefined> = [];
  for (const pick of picks) {
    const mode = modeById(def, pick.modeId);
    if (!mode) continue;
    if (!pickTargetIsLegal(state, def, pick, caster)) continue;
    for (const ref of mode.effects) {
      effects.push(ref);
      effectTargets.push(pick.targets ? [...pick.targets] : undefined);
    }
  }
  return { effects, effectTargets };
}

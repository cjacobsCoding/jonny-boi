/**
 * "YOU MAY <do something to> TARGET <thing>" — asked as ONE question (pure,
 * unit-tested).
 *
 * Bug report 20260901_205339: *"Conjurers closet asks me to choose a create to
 * exile then asks me if I want to exile a creature - thats backwards, fix it"*.
 *
 * The engine is CORRECT and stays untouched. CR 603.3d chooses a triggered
 * ability's targets as it goes on the stack, and CR 601.2 style "you may" is
 * decided when the ability RESOLVES — so a "you may exile target creature"
 * trigger genuinely asks in that order, and a client that reversed it would be
 * lying about the game (the target is locked in before the opponent gets a
 * chance to respond, which is a real difference and not a cosmetic one).
 *
 * What was wrong is the PRESENTATION: two modal prompts, the first demanding a
 * choice the player might not want to make at all, the second asking whether
 * they wanted it — after the fact. So the board folds them: the target prompt
 * carries a DECLINE button, and taking it answers the target question with the
 * engine's own default and then answers the coming "may" question NO, without
 * the second modal ever appearing. Both engine questions are still asked and
 * answered, in the order the rules require; the player is asked once.
 *
 * The signal is DATA, never the prompt's wording: a trigger qualifies when the
 * permanent that asked prints a trigger whose effects are gated by the
 * `mayEffects` primitive (which is exactly what "you may" compiles to). Sniffing
 * the label for "you may" would break on the next card that phrases it
 * differently, and would fire on a card that merely mentions the words.
 */
import type { CardDefinition, PendingChoice } from '@jonny-boi/core';

/**
 * The primitive a compiled "you may …" clause resolves through. One name, read
 * here and asserted against the real pool in the tests, so a rename in the
 * cards package cannot silently switch this rule off.
 */
export const MAY_PRIMITIVE = 'mayEffects';

/** Whether any of this definition's triggers gate their effects behind "you may". */
export function hasOptionalTrigger(def: CardDefinition | undefined): boolean {
  if (!def) return false;
  for (const trigger of def.triggers ?? []) {
    for (const ref of trigger.effects ?? []) {
      if (ref.primitive === MAY_PRIMITIVE) return true;
    }
  }
  return false;
}

/**
 * The decline button's label for a parked choice, or null when the choice is not
 * an optional trigger's target question.
 *
 * `sourceDef` is the definition of the permanent that asked — looked up by the
 * caller from `choice.sourceInstanceId`, because only the board can resolve an
 * instance id.
 */
export function optionalTargetDecline(
  choice: PendingChoice,
  sourceDef: CardDefinition | undefined,
): string | null {
  // Only a TARGET question, and only a mandatory one: a choice that already
  // allows picking none (`min === 0`, Angel of Serenity's "up to three") has a
  // decline path of its own and must not grow a second one.
  if (choice.kind !== 'selectTargets' || choice.min === 0) return null;
  if (!hasOptionalTrigger(sourceDef)) return null;
  return `Don’t use ${choice.sourceName}`;
}

/**
 * Whether a parked `confirm` is the "may" question belonging to a decline the
 * player already made — matched on the ASKING PERMANENT, which is the one thing
 * both questions of one trigger share.
 *
 * The board answers it NO automatically. It is deliberately narrow: a confirm
 * from any other source, or after the decline has been consumed, is presented
 * to the player as usual.
 */
export function isDeclinedMayQuestion(choice: PendingChoice, declinedSource: number | null): boolean {
  return choice.kind === 'confirm' && declinedSource !== null && choice.sourceInstanceId === declinedSource;
}

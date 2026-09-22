/**
 * WHAT THE SUGGEST SEARCH IS ABOUT TO DO, in one line (§3.136, §3.181).
 *
 * The focus panel is collapsed by default, so this line is the only thing
 * standing between a user and a ten-thousand-game run that searched something
 * other than what they meant. It therefore has to say BOTH sides of the swap —
 * what may go out, and what may come in — and it has to keep saying the cut side
 * exactly as §3.136 said it, because that wording is what existing behaviour
 * looks like on screen and a silent change to it would read as a regression.
 *
 * ## Why the single-in-card case gets words rather than a count
 *
 * Caleb asked for this feature like this:
 *
 * > "cut some card from the deck (try different ones) in order to get a
 * > different specific card into the deck?"
 *
 * "1 card" is a true description of that focus and a useless one — it is the
 * count of a set, not the question being asked. When exactly one card may come
 * in, the search genuinely IS "what should I cut to fit this card in", so the
 * line says that, naming the card. A user who set the focus for that reason
 * reads their own intent back.
 *
 * Pure and dependency-free: a string in, a string out, so the wording is pinned
 * by tests rather than by a screenshot.
 */

/** How many copies a candidate swap moves — the §3.136 scope control. */
export type FocusCopies = number | 'playset';

export interface SuggestFocusSummaryInput {
  /** Cards the search may cut. Empty = the whole deck. */
  readonly cutCount: number;
  /** Cards the search may bring in. Empty = the whole pool. */
  readonly inCount: number;
  /** The single in-card's name, when `inCount` is 1. */
  readonly soleInName?: string | undefined;
  readonly copies: FocusCopies;
}

function cards(n: number): string {
  return `${n} card${n === 1 ? '' : 's'}`;
}

function copiesText(copies: FocusCopies): string {
  return copies === 'playset' ? 'whole playsets' : `${copies} cop${copies === 1 ? 'y' : 'ies'}`;
}

/**
 * The bit before the copies clause: which cards may leave, and which may arrive.
 *
 * The five rows are the five genuinely different questions the two restrictions
 * can express. A sixth case would be a new row here, not a new branch at the
 * call site.
 */
function scopeText(input: SuggestFocusSummaryInput): string {
  const { cutCount, inCount, soleInName } = input;
  const cutSide = cutCount === 0 ? 'whole deck' : cards(cutCount);

  // No bring-in focus: say exactly what §3.136 always said.
  if (inCount === 0) return cutSide;

  // One card may come in — the question has a plain-English form, so use it.
  if (inCount === 1 && soleInName !== undefined && soleInName !== '') {
    return cutCount === 0
      ? `what to cut to fit ${soleInName} in`
      : `what to cut from ${cards(cutCount)} to fit ${soleInName} in`;
  }

  // Both sides restricted: the search is the CROSS PRODUCT, and the swap count
  // is the honest size of it — the number a user is really deciding about.
  if (cutCount > 0) {
    return `${cards(cutCount)} → ${cards(inCount)} (${cutCount * inCount} swaps)`;
  }
  return `whole deck → ${cards(inCount)} to bring in`;
}

/** The summary shown beside "Focus the search", always prefixed with an em dash. */
export function suggestFocusSummary(input: SuggestFocusSummaryInput): string {
  return `— ${scopeText(input)}, ${copiesText(input.copies)}`;
}

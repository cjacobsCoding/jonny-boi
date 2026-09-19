/**
 * WHICH "HOW MANY COPIES" CHOICES MAKE SENSE FOR THIS CUT — pure (DESIGN §3.165).
 *
 * > "in Lab -> A/B Swap, when you test out swap from one card to another, if
 * > there is only one copy of the card in the deck, it shouldn't give all those
 * > options to swap 1, 2, 3, ect- that makes no sense"
 *
 * The scope menu used to list every scope regardless of the line: a 1-of
 * offered "the whole playset", "a single copy", "exactly 2", "exactly 3" and
 * "exactly 4", four of which meant the same one copy (`copiesForScope` clamps
 * into the line). This is the ONE place the menu is derived from the line
 * count, so the panels cannot disagree about it:
 *
 *  - a 1-of has exactly one choice, the copy;
 *  - an N-of offers the playset (all N), the single copy, and every exact
 *    count strictly between — "exactly 2" is only a choice when the line holds
 *    more than two, because at two it IS the playset;
 *  - no line (nothing picked yet) offers the two named questions, which is
 *    what the menu always showed before a card was chosen.
 */
import type { SwapScope } from '@jonny-boi/sim';

export interface SwapScopeOption {
  readonly scope: SwapScope;
  /** The `<option>` value — the named scope, or the count as a string. */
  readonly value: string;
  readonly label: string;
}

/** The `<option>` value a scope is written as, and read back from. */
export function scopeOptionValue(scope: SwapScope): string {
  return typeof scope === 'string' ? scope : String(scope.copies);
}

/** The scope an `<option>` value means — the inverse of {@link scopeOptionValue}. */
export function scopeFromOptionValue(value: string): SwapScope {
  if (value === 'playset' || value === 'one') return value;
  const copies = Number(value);
  return { copies: Number.isFinite(copies) && copies >= 1 ? Math.trunc(copies) : 1 };
}

export function swapScopeOptions(lineCount: number | undefined): readonly SwapScopeOption[] {
  if (lineCount === undefined) {
    return [
      { scope: 'playset', value: 'playset', label: 'The whole playset — does this card belong at all?' },
      { scope: 'one', value: 'one', label: 'A single copy — is the last copy earning its slot?' },
    ];
  }
  const count = Math.max(1, Math.trunc(lineCount));
  if (count === 1) {
    return [{ scope: 'one', value: 'one', label: 'The only copy — it is a 1-of' }];
  }
  const options: SwapScopeOption[] = [
    { scope: 'playset', value: 'playset', label: `All ${count} copies — does this card belong at all?` },
    { scope: 'one', value: 'one', label: 'A single copy — is the last copy earning its slot?' },
  ];
  for (let copies = 2; copies < count; copies++) {
    options.push({ scope: { copies }, value: String(copies), label: `Exactly ${copies} of the ${count}` });
  }
  return options;
}

/**
 * The scope to show once the line changes: the current one when the new menu
 * still offers it, else the menu's first entry — so picking a 1-of after a
 * 4-of cannot leave "exactly 3" selected on a line of one.
 */
export function reconcileScope(current: SwapScope, options: readonly SwapScopeOption[]): SwapScope {
  const value = scopeOptionValue(current);
  return options.some((option) => option.value === value) ? current : (options[0]?.scope ?? 'one');
}

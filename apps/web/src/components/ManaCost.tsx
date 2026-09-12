import type { ReactElement } from 'react';
import type { ManaCost as ManaCostType } from '@jonny-boi/data-tools';
import { manaPips } from '../lib/cards.js';

/** WUBRG/C pip codes get a colored CSS class; anything else is the "other" pip. */
const COLORED_PIPS = new Set(['W', 'U', 'B', 'R', 'G', 'C']);

/**
 * Render a mana cost as round colored pips (DRY: the one place mana symbols are
 * drawn). Generic numbers render as a single grey numeric pip; colored symbols
 * use the named WUBRG identity tokens; every COMPOUND symbol — `{G/W}`, `{2/W}`,
 * `{B/P}`, `{S}`, `{X}` — falls back to a labeled "other" pip carrying the
 * printed text, so no cost information is silently dropped.
 *
 * It reads the DISPLAY cost (`@jonny-boi/data-tools`), whose `other` is a list of
 * STRINGS — the printed symbol without its braces — and never core's component
 * objects. Both producers now agree on that dialect: the Scryfall parser records
 * the symbol verbatim, and `cards/enginePool.ts` prints core's components through
 * `formatManaCost` before handing them over (§3.143). Anything that ever fed an
 * object in here would render as "[object Object]" with no type error to catch
 * it, which is exactly why `cards.test.ts` pins the pip text.
 */
export function ManaCost({ cost }: { cost: ManaCostType }): ReactElement | null {
  const pips = manaPips(cost);
  if (pips.length === 0) return null;
  return (
    <span className="mana-cost" aria-label="Mana cost">
      {pips.map((pip, index) => {
        const isNumeric = /^\d+$/.test(pip);
        const className = isNumeric
          ? 'pip pip--generic'
          : COLORED_PIPS.has(pip)
            ? `pip pip--${pip}`
            : 'pip pip--other';
        return (
          <span key={`${pip}-${index}`} className={className} aria-hidden="true">
            {pip}
          </span>
        );
      })}
    </span>
  );
}

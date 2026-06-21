import type { ReactElement } from 'react';
import type { ManaCost as ManaCostType } from '@jonny-boi/data-tools';
import { manaPips } from '../lib/cards.js';

/** WUBRG/C pip codes get a colored CSS class; anything else is the "other" pip. */
const COLORED_PIPS = new Set(['W', 'U', 'B', 'R', 'G', 'C']);

/**
 * Render a mana cost as round colored pips (DRY: the one place mana symbols are
 * drawn). Generic numbers render as a single grey numeric pip; colored symbols
 * use the named WUBRG identity tokens; hybrid/Phyrexian/X fall back to a labeled
 * "other" pip so no cost information is silently dropped.
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

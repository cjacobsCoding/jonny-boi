import type { ReactElement } from 'react';
import type { ManaCurveBar } from '../lib/deck.js';

/**
 * A lightweight CSS bar chart of the mana curve — no chart library (DESIGN.md
 * §performance: keep the bundle light). Bar heights scale to the busiest bucket.
 */
export function ManaCurveChart({ bars }: { bars: ManaCurveBar[] }): ReactElement {
  const max = Math.max(1, ...bars.map((bar) => bar.count));
  return (
    <div className="mana-curve" role="img" aria-label="Mana curve by mana value">
      {bars.map((bar) => {
        const heightPct = (bar.count / max) * 100;
        return (
          <div className="mana-curve__col" key={bar.bucket}>
            <span className="mana-curve__value">{bar.count}</span>
            <div
              className={`mana-curve__bar${bar.count === 0 ? ' mana-curve__bar--empty' : ''}`}
              style={{ height: `${Math.max(heightPct, bar.count > 0 ? 6 : 2)}%` }}
            />
            <span className="mana-curve__label">{bar.label}</span>
          </div>
        );
      })}
    </div>
  );
}

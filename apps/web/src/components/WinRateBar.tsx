import type { ReactElement } from 'react';
import type { ProportionCI } from '@jonny-boi/sim';
import { pct } from '../lib/sim-format.js';

/**
 * A horizontal win-rate bar with the Wilson 95% CI drawn as a lighter band, and
 * a 50% reference tick. Pure CSS (no chart lib — DESIGN performance note),
 * reusing the app's accent gradient like the mana-curve chart does.
 */
export function WinRateBar({ ci, label }: { ci: ProportionCI; label?: string }): ReactElement {
  const fill = clampPct(ci.p);
  const low = clampPct(ci.low);
  const high = clampPct(ci.high);
  return (
    <div
      className="winrate-bar"
      role="img"
      aria-label={`${label ? `${label}: ` : ''}win rate ${pct(ci.p)}, 95% CI ${pct(ci.low)} to ${pct(ci.high)}`}
    >
      <div className="winrate-bar__track">
        <div className="winrate-bar__fill" style={{ width: `${fill}%` }} />
        <div
          className="winrate-bar__ci"
          style={{ left: `${low}%`, width: `${Math.max(high - low, 0)}%` }}
        />
        <div className="winrate-bar__mid" />
      </div>
      <span className="winrate-bar__value">{pct(ci.p)}</span>
    </div>
  );
}

function clampPct(p: number): number {
  return Math.max(0, Math.min(100, p * 100));
}

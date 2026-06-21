import type { ReactElement } from 'react';

/**
 * A labeled range slider for a sim tuning knob (games-per-run, candidate cap).
 * The numeric value reads live so the user sees the speed-vs-confidence trade.
 */
export function RunSlider({
  label,
  value,
  min,
  max,
  step,
  disabled,
  onChange,
  hint,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  disabled?: boolean;
  onChange: (value: number) => void;
  hint?: string;
}): ReactElement {
  return (
    <label className="run-slider">
      <span className="run-slider__label">
        {label}
        <strong>{value}</strong>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(Number(e.target.value))}
        aria-label={label}
      />
      {hint && <span className="run-slider__hint">{hint}</span>}
    </label>
  );
}

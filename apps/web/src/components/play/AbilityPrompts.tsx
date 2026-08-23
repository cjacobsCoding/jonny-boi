import type { ReactElement } from 'react';
import type { InstanceId, PlayerId } from '@jonny-boi/core';
import type { AbilityOption } from '../../lib/play/session.js';

/**
 * The two activated-ability dialogs (which ability of this permanent? / which
 * target for it?), extracted from the hotseat board so the ONLINE board renders
 * the identical prompts — one loyalty-ability UI, not two that drift. Both lists
 * come exclusively from engine/server offers, so a used-this-turn or unpayable
 * ability is simply absent rather than disabled.
 */

/** "Activate which ability of X?" — one button per engine-offered ability. */
export function AbilityMenuPrompt({
  sourceName,
  options,
  onChoose,
  onCancel,
}: {
  sourceName: string;
  options: readonly AbilityOption[];
  onChoose: (opt: AbilityOption) => void;
  onCancel: () => void;
}): ReactElement {
  return (
    <div className="target-prompt" role="dialog" aria-label="Choose an ability to activate">
      <div className="target-prompt__card">
        <div className="target-prompt__title">Activate which ability of {sourceName}?</div>
        <div className="target-prompt__options">
          {options.map((opt) => (
            <button key={opt.abilityIndex} type="button" className="btn" onClick={() => onChoose(opt)}>
              {opt.label}
            </button>
          ))}
        </div>
        <button type="button" className="btn btn--ghost" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}

/** The chosen ability's targets — one button per engine-offered legal target. */
export function AbilityTargetPrompt({
  ability,
  onPick,
  onCancel,
}: {
  ability: AbilityOption;
  onPick: (target: InstanceId | PlayerId) => void;
  onCancel: () => void;
}): ReactElement {
  return (
    <div className="target-prompt" role="dialog" aria-label="Choose a target for the ability">
      <div className="target-prompt__card">
        <div className="target-prompt__title">
          {ability.sourceName} — {ability.label} Choose a target.
        </div>
        <div className="target-prompt__options">
          {(ability.targets ?? []).map((choice) => (
            <button
              key={typeof choice.target === 'string' ? `p:${choice.target}` : `i:${choice.target}`}
              type="button"
              className="btn"
              onClick={() => onPick(choice.target)}
            >
              {choice.label}
            </button>
          ))}
        </div>
        <button type="button" className="btn btn--ghost" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}

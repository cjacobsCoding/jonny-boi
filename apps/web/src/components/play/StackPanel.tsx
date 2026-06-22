import type { ReactElement } from 'react';
import type { InstanceId, PlayerId } from '@jonny-boi/core';
import type { StackView } from '../../lib/play/view-model.js';

/**
 * The stack: spells/triggers waiting to resolve, top-first (the order the view-model
 * already supplies). Shows each object's name, who controls it, and a readable target
 * summary so the responding player understands what they're reacting to. Empty stack
 * renders nothing (the caller decides whether to show a placeholder).
 */
export function StackPanel({
  stack,
  names,
  nameOf,
}: {
  stack: readonly StackView[];
  names: Readonly<Record<PlayerId, string>>;
  nameOf: (id: InstanceId) => string;
}): ReactElement | null {
  if (stack.length === 0) return null;

  const describeTargets = (targets: readonly (InstanceId | PlayerId)[]): string => {
    if (targets.length === 0) return '';
    const parts = targets.map((t) => (t === 'A' || t === 'B' ? names[t] : nameOf(t)));
    return ` → ${parts.join(', ')}`;
  };

  return (
    <div className="stack-panel" aria-label="The stack">
      <div className="stack-panel__title">Stack (resolves top-down)</div>
      <ol className="stack-panel__list">
        {stack.map((obj, i) => (
          <li key={obj.instanceId} className={`stack-item${i === 0 ? ' stack-item--top' : ''}`}>
            <span className="stack-item__kind">{obj.kind === 'trigger' ? 'Trigger' : 'Spell'}</span>
            <span className="stack-item__name">{obj.name}</span>
            <span className="stack-item__ctrl">({names[obj.controller]})</span>
            <span className="stack-item__targets">{describeTargets(obj.targets)}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}

/**
 * THE COMBAT-DECLARATION TRIGGER (DESIGN §3.103).
 *
 * `blocksOrBecomesBlocked` is the event bushido is printed as (CR 702.45a), and
 * the event flanking and rampage will ride when their payloads exist. Both
 * halves are one event because no printed card separates them: an object either
 * took part in a block or it did not.
 *
 * These drive `matchTriggers` directly rather than staging a full combat. The
 * semantics worth pinning are all in the matcher — which objects the event is
 * about, and how MANY times one declaration fires — and a matcher test states
 * them without a board large enough to hide them.
 */

import { describe, expect, it } from 'vitest';
import { matchTriggers, type TriggerSource, type TriggeredAbility } from './triggers.js';
import type { GameEvent } from './events.js';

const BUSHIDO: TriggeredAbility = {
  condition: { on: 'blocksOrBecomesBlocked' },
  effects: [{ primitive: 'pumpUntilEndOfTurn', params: { power: 1, toughness: 1 } }],
  label: 'Bushido 1',
};

/** A trigger source standing for one creature on the battlefield. */
function source(instanceId: number): TriggerSource {
  return { instanceId, controller: 'A', name: `Creature ${instanceId}`, triggers: [BUSHIDO] };
}

/** The event one declare-blockers produces, from (blocker, attacker) pairs. */
function declared(...blocks: Array<[number, number]>): GameEvent {
  return {
    type: 'blockersDeclared',
    blocks: blocks.map(([blocker, attacker]) => ({ blocker, attacker })),
  } as GameEvent;
}

/** How many times the given creature's bushido fired on that declaration. */
function fires(instanceId: number, event: GameEvent): number {
  return matchTriggers([source(instanceId)], event).length;
}

describe('blocksOrBecomesBlocked — which objects the declaration is about', () => {
  it('fires for the creature that BLOCKED', () => {
    expect(fires(10, declared([10, 20]))).toBe(1);
  });

  it('fires for the creature that BECAME BLOCKED', () => {
    expect(fires(20, declared([10, 20]))).toBe(1);
  });

  it('does NOT fire for an attacker nobody blocked', () => {
    // The whole point of the keyword is that it pays off only in a real fight.
    expect(fires(99, declared([10, 20]))).toBe(0);
  });

  it('does NOT fire for a creature that sat the combat out', () => {
    expect(fires(77, declared([10, 20], [11, 21]))).toBe(0);
  });

  it('does not fire on an EMPTY declaration', () => {
    // Declaring no blocks still emits the event; nothing became blocked.
    expect(fires(20, declared())).toBe(0);
  });
});

describe('blocksOrBecomesBlocked — one declaration is ONE fire', () => {
  it('⚠️ a triple-blocked attacker fires ONCE, not once per blocker', () => {
    // CR 509.1h: "becomes blocked" is a single event however many creatures
    // were declared. Firing per blocker would silently make bushido scale with
    // the defender's board — a card playing STRONGER than printed, which biases
    // an A/B verdict exactly as badly as one playing weaker.
    expect(fires(20, declared([10, 20], [11, 20], [12, 20]))).toBe(1);
  });

  it('each participant fires its own once', () => {
    const event = declared([10, 20], [11, 20]);
    expect(fires(10, event)).toBe(1);
    expect(fires(11, event)).toBe(1);
    expect(fires(20, event)).toBe(1);
  });

  it('fires once for a creature that appears in several unrelated pairs', () => {
    // Defensive: the engine maps blocker -> attacker, so a blocker cannot
    // legally appear twice. If a future multi-block ever lets it, the count
    // must still be one.
    expect(fires(10, declared([10, 20], [10, 21]))).toBe(1);
  });
});

describe('blocksOrBecomesBlocked — it watches nothing else', () => {
  it('ignores the ATTACK declaration', () => {
    // The sibling event. A bushido that fired on attacks would pump every
    // attacker whether or not it was ever blocked.
    const attack = { type: 'attackersDeclared', attackers: [10, 20] } as unknown as GameEvent;
    expect(matchTriggers([source(10)], attack)).toHaveLength(0);
  });
});

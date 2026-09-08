/**
 * §3.133 — "the computer plays instant and sorcery spells and I have no idea
 * what they played… what they are targeting with their spells". These pin the
 * fold that answers it: the opponent's plays, with their targets, read off the
 * ACCEPTED ACTIONS (which carry targets) rather than the event log (which does
 * not), so the note survives a stack that resolved in one auto-passed burst.
 */
import { describe, expect, it } from 'vitest';
import type { GameAction, InstanceId, PlayerId } from '@jonny-boi/core';
import { describeNote, describeOpponentActions } from './opponent-actions.js';

const VIEWER: PlayerId = 'A';
const NAMES: Record<string, string> = { 9: 'Lightning Strike', 5: 'Grizzly Bears', 7: 'Sol Ring', A: 'Player 1', B: 'Computer' };
const label = (ref: InstanceId | PlayerId): string => NAMES[String(ref)] ?? `#${ref}`;

function fold(actions: readonly GameAction[], viewer: PlayerId = VIEWER) {
  return describeOpponentActions(actions, { viewer, startIndex: 0, label });
}

describe('describeOpponentActions', () => {
  it('names the opponent’s spell AND what it targeted', () => {
    const notes = fold([{ kind: 'castSpell', player: 'B', instanceId: 9, targets: [5] }]);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ kind: 'cast', name: 'Lightning Strike', targets: ['Grizzly Bears'] });
    expect(describeNote(notes[0]!)).toBe('cast Lightning Strike → Grizzly Bears');
  });

  it('resolves a PLAYER target to their seat name', () => {
    const notes = fold([{ kind: 'castSpell', player: 'B', instanceId: 9, targets: ['A'] }]);
    expect(describeNote(notes[0]!)).toBe('cast Lightning Strike → Player 1');
  });

  it('an untargeted spell reads without an arrow', () => {
    const notes = fold([{ kind: 'castSpell', player: 'B', instanceId: 9 }]);
    expect(describeNote(notes[0]!)).toBe('cast Lightning Strike');
  });

  it('reports an activated ability too, with its own verb', () => {
    const notes = fold([{ kind: 'activateAbility', player: 'B', instanceId: 7, abilityIndex: 0, targets: [5] }]);
    expect(notes[0]).toMatchObject({ kind: 'ability', name: 'Sol Ring' });
    expect(describeNote(notes[0]!)).toBe('activated Sol Ring → Grizzly Bears');
  });

  it('YOUR OWN plays are not news, and neither is a land drop', () => {
    expect(fold([{ kind: 'castSpell', player: 'A', instanceId: 9, targets: [5] }])).toEqual([]);
    expect(fold([{ kind: 'playLand', player: 'B', instanceId: 3 }])).toEqual([]);
    expect(fold([{ kind: 'passPriority', player: 'B' }])).toEqual([]);
  });

  it('keys are offset by startIndex so two batches never collide', () => {
    const batch: GameAction[] = [
      { kind: 'passPriority', player: 'B' },
      { kind: 'castSpell', player: 'B', instanceId: 9, targets: [5] },
    ];
    const notes = describeOpponentActions(batch, { viewer: VIEWER, startIndex: 40, label });
    expect(notes[0]!.key).toBe('41');
  });

  it('a turn of several plays reads in the order it happened', () => {
    const notes = fold([
      { kind: 'castSpell', player: 'B', instanceId: 7 },
      { kind: 'activateAbility', player: 'B', instanceId: 7, abilityIndex: 0 },
      { kind: 'castSpell', player: 'B', instanceId: 9, targets: ['A'] },
    ]);
    expect(notes.map((n) => n.kind)).toEqual(['cast', 'ability', 'cast']);
  });
});

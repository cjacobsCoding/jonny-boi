/**
 * §3.57 — the owner/zone label rules for every picker row, including the
 * hidden-information discipline: labels are a pure function of what the choice
 * (or the PUBLIC board) already carries, and the online masked path can never
 * even reach the label builder for a question addressed to the other seat.
 */
import { describe, expect, it } from 'vitest';
import type { CardOption, PlayerId, TargetOption } from '@jonny-boi/core';
import type { MaskedGameView } from '@jonny-boi/protocol';
import {
  annotateCardOptions,
  annotateTargetOptions,
  describeCastTarget,
  describeTargetSetWithOwners,
  formatOwnerZone,
  makeRefIndex,
  ownerLabel,
  type KnownRef,
} from './option-labels.js';
import { onlineChoiceView } from '../online/pending-choice.js';

const NAMES: Readonly<Record<PlayerId, string>> = { A: 'Caleb', B: 'Computer' };

function card(id: number, name: string, zone: string, controller: PlayerId): CardOption {
  return { instanceId: id, cardId: `c${id}`, name, zone: zone as CardOption['zone'], controller };
}

function target(ref: number | PlayerId, name: string, controller: PlayerId): TargetOption {
  return { ref, name, controller };
}

describe('ownerLabel', () => {
  it('is "yours" for the chooser and possessive for the other seat', () => {
    expect(ownerLabel('A', 'A', NAMES)).toBe('yours');
    expect(ownerLabel('B', 'A', NAMES)).toBe('Computer’s');
    expect(ownerLabel('A', 'B', NAMES)).toBe('Caleb’s');
  });

  it('handles names already ending in s without a double-s', () => {
    expect(ownerLabel('B', 'A', { A: 'Caleb', B: 'Silas' })).toBe('Silas’');
  });
});

describe('annotateCardOptions (selectCards rows — the Angel of Serenity report)', () => {
  it('single-zone candidates carry the owner but leave the zone to the requirement line', () => {
    const notes = annotateCardOptions(
      [card(1, 'Bear', 'graveyard', 'A'), card(2, 'Wolf', 'graveyard', 'B')],
      'A',
      NAMES,
    );
    expect(notes).toEqual([{ owner: 'yours' }, { owner: 'Computer’s' }]);
  });

  it('zone-spanning candidates say the zone on every row', () => {
    const notes = annotateCardOptions(
      [
        card(1, 'Bear', 'battlefield', 'B'),
        card(2, 'Wolf', 'graveyard', 'A'),
        card(3, 'Elk', 'graveyard', 'B'),
      ],
      'A',
      NAMES,
    );
    expect(notes).toEqual([
      { owner: 'Computer’s', zone: 'battlefield' },
      { owner: 'yours', zone: 'graveyard' },
      { owner: 'Computer’s', zone: 'graveyard' },
    ]);
  });

  it('formats as "owner · zone" for the meta line', () => {
    expect(formatOwnerZone({ owner: 'yours', zone: 'graveyard' })).toBe('yours · graveyard');
    expect(formatOwnerZone({ owner: 'yours' })).toBe('yours');
  });
});

describe('annotateTargetOptions (selectTargets rows — the Acidic Slime report)', () => {
  it('every instance row carries the owner; player rows stay "(player)"', () => {
    const notes = annotateTargetOptions(
      [target(7, 'Wall', 'A'), target(8, 'Forest', 'B'), target('B', 'Computer', 'B')],
      'A',
      NAMES,
    );
    expect(notes).toEqual([{ owner: 'yours' }, { owner: 'Computer’s' }, 'player']);
  });

  it('adds zones when candidates span zones (Angel of Serenity trigger)', () => {
    const zoneOf = (ref: number | PlayerId): string | undefined =>
      ref === 7 ? 'battlefield' : ref === 9 ? 'graveyard' : undefined;
    const notes = annotateTargetOptions(
      [target(7, 'Bear', 'B'), target(9, 'Wolf', 'A')],
      'A',
      NAMES,
      zoneOf,
    );
    expect(notes).toEqual([
      { owner: 'Computer’s', zone: 'battlefield' },
      { owner: 'yours', zone: 'graveyard' },
    ]);
  });

  it('says a non-battlefield zone even when it is the only zone (Mortuary Mire)', () => {
    const notes = annotateTargetOptions([target(9, 'Wolf', 'A')], 'A', NAMES, () => 'graveyard');
    expect(notes).toEqual([{ owner: 'yours', zone: 'graveyard' }]);
  });

  it('an all-battlefield list stays unlabeled by zone (owner is the ask)', () => {
    const notes = annotateTargetOptions(
      [target(7, 'Bear', 'B'), target(8, 'Elk', 'A')],
      'A',
      NAMES,
      () => 'battlefield',
    );
    expect(notes).toEqual([{ owner: 'Computer’s' }, { owner: 'yours' }]);
  });

  it('without a zone resolver only owners are annotated (never a guess)', () => {
    const notes = annotateTargetOptions([target(7, 'Bear', 'B')], 'A', NAMES);
    expect(notes).toEqual([{ owner: 'Computer’s' }]);
  });
});

describe('describeCastTarget (the hotseat cast prompt)', () => {
  it('labels creatures and walkers with their owner', () => {
    expect(
      describeCastTarget({ kind: 'creature', instanceId: 4, name: 'Bear', controller: 'B' }, 'A', NAMES),
    ).toBe('Bear (Computer’s)');
    expect(
      describeCastTarget({ kind: 'planeswalker', instanceId: 5, name: 'Liliana', controller: 'A' }, 'A', NAMES),
    ).toBe('Liliana (yours)');
  });

  it('labels players and stack spells', () => {
    expect(describeCastTarget({ kind: 'player', player: 'B', name: 'Computer' }, 'A', NAMES)).toBe(
      'Computer (player)',
    );
    expect(
      describeCastTarget({ kind: 'spell', instanceId: 6, name: 'Shock', controller: 'B' }, 'A', NAMES),
    ).toBe('Shock (Computer’s · stack)');
  });
});

describe('makeRefIndex (public-zone lookup)', () => {
  const refs: KnownRef[] = [
    { instanceId: 1, name: 'Bear', controller: 'A', zone: 'battlefield' },
    { instanceId: 2, name: 'Slime', controller: 'B', zone: 'graveyard' },
  ];
  const index = makeRefIndex(refs, 'A', NAMES);

  it('describes with owner, adding the zone only off the battlefield', () => {
    expect(index.describe(1)).toBe('Bear (yours)');
    expect(index.describe(2)).toBe('Slime (Computer’s · graveyard)');
    expect(index.describe('B')).toBe('Computer (player)');
  });

  it('degrades an unknown id to a placeholder — it can never leak what it was not given', () => {
    // Instance 99 stands for an opponent-hand card the public board never lists.
    expect(index.describe(99)).toBe('#99');
    expect(index.zoneOf(99)).toBeUndefined();
    expect(index.ownerOf(99)).toBeUndefined();
  });

  it('describes whole target sets for the online cast prompt', () => {
    expect(describeTargetSetWithOwners([2, 'B'], index)).toBe(
      'Slime (Computer’s · graveyard), Computer (player)',
    );
    expect(describeTargetSetWithOwners([], index)).toBe('No target');
  });
});

describe('the ONLINE masked path cannot reach the label builder for the other seat', () => {
  it('a redacted choice yields no answerable question — and its waiting line names no candidate', () => {
    const view = {
      viewer: 'B',
      pendingChoice: {
        redacted: true,
        id: 3,
        chooser: 'A',
        kind: 'selectCards',
        sourceName: 'Angel of Serenity',
      },
    } as unknown as MaskedGameView;
    const { answerable, waitingText } = onlineChoiceView(view, NAMES);
    // No full question → nothing to annotate: the label builder is unreachable.
    expect(answerable).toBeNull();
    // The waiting line carries the asker and the card — never a candidate name.
    expect(waitingText).toBe('Waiting for Caleb to answer Angel of Serenity…');
  });
});

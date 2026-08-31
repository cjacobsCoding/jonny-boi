/**
 * The mana picker's pure half (§3.60) — what is still owed, how a row reads, and
 * the rule that decides whether the player is asked at all.
 *
 * The last of those is the one worth pinning hardest: a picker that opens when
 * there is nothing to pick is a nag, and a nag is how a helpful prompt becomes
 * the setting everybody turns off.
 */
import { describe, expect, it } from 'vitest';
import { emptyPool, type ManaCost, type ManaPool, type PlayerId } from '@jonny-boi/core';
import {
  FUNDED_TEXT,
  isFullyFunded,
  manaPickerRows,
  manaStillNeeded,
  stillNeededText,
  type ManaPickerSource,
} from './mana-picker.js';
import { MANA_CHOICE_DEFAULT, shouldAskForMana } from './mana-choice-pref.js';

const pool = (amounts: Partial<ManaPool> = {}): ManaPool => ({ ...emptyPool(), ...amounts });
const NAMES: Readonly<Record<PlayerId, string>> = { A: 'Caleb', B: 'Computer' };

describe('manaStillNeeded', () => {
  it('owes the whole cost against an empty pool', () => {
    expect(manaStillNeeded(emptyPool(), { generic: 1, G: 1 })).toEqual({ generic: 1, G: 1 });
  });

  it('counts a coloured pip down as its own colour arrives', () => {
    expect(manaStillNeeded(pool({ G: 1 }), { G: 2 })).toEqual({ G: 1 });
    expect(manaStillNeeded(pool({ G: 2 }), { G: 2 })).toEqual({});
  });

  it('lets spare colour pay the generic, but never the other way round', () => {
    expect(manaStillNeeded(pool({ G: 3 }), { generic: 2 })).toEqual({});
    expect(manaStillNeeded(pool({ G: 1 }), { generic: 2 })).toEqual({ generic: 1 });
    // Colourless cannot pay a green pip.
    expect(manaStillNeeded(pool({ C: 2 }), { G: 1 })).toEqual({ G: 1 });
  });

  it('pays coloured pips before generic out of the same colour', () => {
    // {1}{G} against exactly {G}{G}: one pays the pip, the other the generic.
    expect(manaStillNeeded(pool({ G: 2 }), { generic: 1, G: 1 })).toEqual({});
    // One green short: the pip is covered, the generic is not.
    expect(manaStillNeeded(pool({ G: 1 }), { generic: 1, G: 1 })).toEqual({ generic: 1 });
  });

  it('lets either half of a hybrid symbol pay it', () => {
    const hybrid: ManaCost = { hybrid: [['G', 'W']] };
    expect(manaStillNeeded(pool({ G: 1 }), hybrid)).toEqual({});
    expect(manaStillNeeded(pool({ W: 1 }), hybrid)).toEqual({});
    expect(manaStillNeeded(pool({ U: 1 }), hybrid)).toEqual({ hybrid: [['G', 'W']] });
  });

  it('reads as fully funded only when nothing at all is owed', () => {
    expect(isFullyFunded({})).toBe(true);
    expect(isFullyFunded({ generic: 1 })).toBe(false);
    expect(isFullyFunded({ G: 1 })).toBe(false);
    expect(isFullyFunded({ hybrid: [['G', 'W']] })).toBe(false);
  });

  it('renders the readout the prompt shows', () => {
    expect(stillNeededText({ generic: 1, G: 1 })).toBe('Still needed: {1}{G}');
    expect(stillNeededText({})).toBe(FUNDED_TEXT);
  });
});

describe('manaPickerRows', () => {
  const forest: ManaPickerSource = {
    instanceId: 1,
    name: 'Forest',
    controller: 'A',
    options: [{ instanceId: 1, mode: undefined, colors: ['G'], label: 'G' }],
  };
  const bird: ManaPickerSource = {
    instanceId: 2,
    name: 'Birds of Paradise',
    controller: 'A',
    options: [
      { instanceId: 2, mode: 0, colors: ['W'], label: 'W' },
      { instanceId: 2, mode: 1, colors: ['U'], label: 'U' },
    ],
  };

  it('labels a row with its name, §3.57 owner note, and what it makes', () => {
    const [row] = manaPickerRows([forest], new Set(), 'A', NAMES);
    expect(row?.label).toBe('Forest (yours) — G');
  });

  it('collapses a modal source to one "any colour" row that will ask', () => {
    const [row] = manaPickerRows([bird], new Set(), 'A', NAMES);
    expect(row?.label).toBe('Birds of Paradise (yours) — any colour');
    expect(row?.modal).toBe(true);
    expect(row?.mode).toBeUndefined();
  });

  it('keeps a spent row in place rather than deleting it under the player', () => {
    const rows = manaPickerRows([forest, bird], new Set([1]), 'A', NAMES);
    expect(rows.map((r) => r.instanceId)).toEqual([1, 2]);
    expect(rows[0]?.spent).toBe(true);
    expect(rows[1]?.spent).toBe(false);
  });

  it('drops a source with no offered mode at all', () => {
    expect(manaPickerRows([{ ...forest, options: [] }], new Set(), 'A', NAMES)).toEqual([]);
  });
});

describe('shouldAskForMana — the nag guard', () => {
  it('defaults to auto-tap, exactly as the board behaved before §3.60', () => {
    expect(MANA_CHOICE_DEFAULT).toBe(false);
    expect(shouldAskForMana({ always: false, requested: false, choiceExists: true })).toBe(false);
  });

  it('asks when the player asked always and there is a real choice', () => {
    expect(shouldAskForMana({ always: true, requested: false, choiceExists: true })).toBe(true);
  });

  it('asks for this one cast when the player requested it', () => {
    expect(shouldAskForMana({ always: false, requested: true, choiceExists: true })).toBe(true);
  });

  it('NEVER asks when there is no genuine choice — not even on an explicit request', () => {
    // The hard gate. A picker offering one button is worse than no picker, and
    // an explicit per-cast request is not a reason to show one.
    expect(shouldAskForMana({ always: true, requested: true, choiceExists: false })).toBe(false);
    expect(shouldAskForMana({ always: false, requested: true, choiceExists: false })).toBe(false);
  });
});

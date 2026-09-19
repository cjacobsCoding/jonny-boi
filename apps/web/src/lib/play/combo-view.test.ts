/** The combo prompt's view model and the Play rules (DESIGN §3.177) — pure. */
import { describe, expect, it } from 'vitest';
import { COMBO_REPEAT_CAP, COMBO_REPEAT_DEFAULT, DEFAULT_RULES, type ComboWindow } from '@jonny-boi/core';
import { comboCycleInstanceIds, comboPromptView, parseRepeatCount } from './combo-view.js';
import { playRulesFor } from './combo-rules.js';

const WINDOW: ComboWindow = {
  owner: 'A',
  loop: {
    player: 'A',
    key: 'k',
    cycle: [
      { kind: 'activateAbility', player: 'A', instanceId: 5, abilityIndex: 0 },
      { kind: 'passPriority', player: 'A' },
      { kind: 'passPriority', player: 'B' },
      // Aimed at the first piece, from the second — and a cost payer.
      { kind: 'activateAbility', player: 'A', instanceId: 7, abilityIndex: 0, targets: [5], costInstanceIds: [9] },
      { kind: 'passPriority', player: 'A' },
      { kind: 'passPriority', player: 'B' },
      // A recorded answer names a card too; its choice id is not a card.
      { kind: 'answerChoice', player: 'A', choiceId: 4242, answer: { kind: 'selectCards', instanceIds: [12] } },
    ],
    deltas: [
      { key: 'life|A|', kind: 'life', player: 'A', delta: 1, label: '+1 life' },
      { key: 'tokens|A|sap', kind: 'tokens', player: 'A', delta: 1, label: '+1 Saproling' },
    ],
  },
  resume: { priorityPlayer: 'A', consecutivePasses: 0 },
};

describe('comboCycleInstanceIds', () => {
  it('names every card the cycle touches once, in first-seen order, and never a choice id or a count', () => {
    expect(comboCycleInstanceIds(WINDOW.loop)).toEqual([5, 7, 9, 12]);
  });
});

describe('comboPromptView', () => {
  it('turns the window into names, phrases and the field bounds', () => {
    const view = comboPromptView(WINDOW, (id) => `card#${id}`);
    expect(view.owner).toBe('A');
    expect(view.cards).toEqual([
      { instanceId: 5, name: 'card#5' },
      { instanceId: 7, name: 'card#7' },
      { instanceId: 9, name: 'card#9' },
      { instanceId: 12, name: 'card#12' },
    ]);
    expect(view.cycleLength).toBe(7);
    expect(view.changes).toEqual(['+1 life', '+1 Saproling']);
    expect(view.summary).toBe('+1 life, +1 Saproling per cycle');
    expect(view.defaultTimes).toBe(COMBO_REPEAT_DEFAULT);
    expect(view.cap).toBe(COMBO_REPEAT_CAP);
  });
});

describe('parseRepeatCount', () => {
  it('accepts a whole number from 1 to the cap and refuses everything else', () => {
    expect(parseRepeatCount('1')).toBe(1);
    expect(parseRepeatCount(' 250 ')).toBe(250);
    expect(parseRepeatCount(String(COMBO_REPEAT_CAP))).toBe(COMBO_REPEAT_CAP);
    expect(parseRepeatCount('0')).toBeNull();
    expect(parseRepeatCount(String(COMBO_REPEAT_CAP + 1))).toBeNull();
    expect(parseRepeatCount('2.5')).toBeNull();
    expect(parseRepeatCount('-3')).toBeNull();
    expect(parseRepeatCount('')).toBeNull();
    expect(parseRepeatCount('ten')).toBeNull();
    expect(parseRepeatCount('1e3')).toBeNull();
  });
});

describe('playRulesFor — which seats the engine watches', () => {
  it('pass-and-play watches both seats; Solo watches only the human one; the engine default watches none', () => {
    expect(playRulesFor(undefined).comboDetectionSeats).toEqual(['A', 'B']);
    expect(playRulesFor('B').comboDetectionSeats).toEqual(['A']);
    expect(playRulesFor('A').comboDetectionSeats).toEqual(['B']);
    expect(DEFAULT_RULES.comboDetectionSeats).toEqual([]);
    // Everything else is the engine default, untouched.
    const { comboDetectionSeats: _seats, ...rest } = playRulesFor('B');
    const { comboDetectionSeats: _none, ...defaults } = DEFAULT_RULES;
    expect(rest).toEqual(defaults);
  });
});

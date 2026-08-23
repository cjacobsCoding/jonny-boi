import { describe, expect, it } from 'vitest';
import type { CardOption, PendingChoice, PlayerId } from '@jonny-boi/core';
import { validateChoiceAnswer } from '@jonny-boi/core';
import {
  choicePromptView,
  clearDraft,
  draftStatus,
  draftToAnswer,
  draftValues,
  emptyDraft,
  isChoiceForViewer,
  orderBadge,
  setConfirm,
  setPayLife,
  setPayMana,
  toggleOption,
  waitingForChoiceText,
  zoneLabel,
} from './choice-view.js';

const NAMES: Readonly<Record<PlayerId, string>> = { A: 'Alice', B: 'Bob' };

function card(instanceId: number, name: string): CardOption {
  return { instanceId, cardId: `c${instanceId}`, name, zone: 'hand', controller: 'A' };
}

/** Base fields every parked choice carries (see core's `PendingChoiceBase`). */
const BASE = {
  id: 7,
  chooser: 'A' as PlayerId,
  prompt: 'Choose a card',
  valence: 'neutral' as const,
  sourceInstanceId: 99,
  sourceName: 'Brainstorm',
};

function selectCards(over: Partial<Extract<PendingChoice, { kind: 'selectCards' }>> = {}): PendingChoice {
  return {
    ...BASE,
    kind: 'selectCards',
    candidates: [card(1, 'Island'), card(2, 'Ponder'), card(3, 'Opt')],
    ordered: false,
    min: 1,
    max: 1,
    ...over,
  } as PendingChoice;
}

describe('choice-view — selection drafting', () => {
  it('starts empty and appends picks in click order', () => {
    const choice = selectCards({ min: 2, max: 2 });
    let draft = emptyDraft(choice);
    expect(draftValues(draft)).toEqual([]);
    draft = toggleOption(choice, draft, 3);
    draft = toggleOption(choice, draft, 1);
    expect(draftValues(draft)).toEqual([3, 1]);
  });

  it('deselects on a second click and closes the gap in the order', () => {
    const choice = selectCards({ min: 0, max: 3, ordered: true });
    let draft = emptyDraft(choice);
    for (const id of [1, 2, 3]) draft = toggleOption(choice, draft, id);
    draft = toggleOption(choice, draft, 2);
    expect(draftValues(draft)).toEqual([1, 3]);
    expect(orderBadge(choice, draft, 3)).toBe(2);
  });

  it('replaces the pick for a single-select choice (radio behaviour)', () => {
    const choice = selectCards({ min: 1, max: 1 });
    let draft = toggleOption(choice, emptyDraft(choice), 1);
    draft = toggleOption(choice, draft, 2);
    expect(draftValues(draft)).toEqual([2]);
  });

  it('refuses to exceed max on a multi-select choice', () => {
    const choice = selectCards({ min: 2, max: 2 });
    let draft = emptyDraft(choice);
    for (const id of [1, 2, 3]) draft = toggleOption(choice, draft, id);
    expect(draftValues(draft)).toEqual([1, 2]);
  });

  it('numbers picks only when the choice is ordered', () => {
    const unordered = selectCards({ min: 2, max: 2 });
    const ordered = selectCards({ min: 2, max: 2, ordered: true });
    const d1 = toggleOption(unordered, emptyDraft(unordered), 2);
    const d2 = toggleOption(ordered, emptyDraft(ordered), 2);
    expect(orderBadge(unordered, d1, 2)).toBeUndefined();
    expect(orderBadge(ordered, d2, 2)).toBe(1);
    expect(orderBadge(ordered, d2, 1)).toBeUndefined();
  });
});

describe('choice-view — the submit gate agrees with the engine', () => {
  it('blocks submission until the minimum is met', () => {
    const choice = selectCards({ min: 2, max: 2 });
    const empty = draftStatus(choice, emptyDraft(choice));
    expect(empty.canSubmit).toBe(false);
    const one = draftStatus(choice, toggleOption(choice, emptyDraft(choice), 1));
    expect(one.canSubmit).toBe(false);
    let full = toggleOption(choice, emptyDraft(choice), 1);
    full = toggleOption(choice, full, 2);
    expect(draftStatus(choice, full).canSubmit).toBe(true);
  });

  it('never produces an answer the engine would reject', () => {
    const cases: PendingChoice[] = [
      selectCards({ min: 0, max: 2 }),
      selectCards({ min: 1, max: 1 }),
      selectCards({ min: 3, max: 3, ordered: true }),
      { ...BASE, kind: 'selectPlayers', candidates: ['A', 'B'], min: 1, max: 1 } as PendingChoice,
      {
        ...BASE,
        kind: 'chooseModes',
        modes: [
          { id: 'm1', label: 'Draw a card' },
          { id: 'm2', label: 'Gain 3 life' },
          { id: 'm3', label: 'Deal 2 damage' },
        ],
        min: 2,
        max: 2,
      } as PendingChoice,
      { ...BASE, kind: 'confirm', min: 1, max: 1 } as PendingChoice,
    ];
    for (const choice of cases) {
      // Click every option in turn; at no point may a submittable draft be illegal.
      let draft = emptyDraft(choice);
      const values =
        choice.kind === 'selectCards'
          ? choice.candidates.map((c) => c.instanceId)
          : choice.kind === 'selectPlayers'
            ? choice.candidates
            : choice.kind === 'chooseModes'
              ? choice.modes.map((m) => m.id)
              : [];
      for (const v of values) {
        draft = toggleOption(choice, draft, v);
        const status = draftStatus(choice, draft);
        if (status.canSubmit) {
          expect(validateChoiceAnswer(choice, status.answer!)).toEqual({ ok: true });
        }
      }
      if (choice.kind === 'confirm') {
        for (const yes of [true, false]) {
          const status = draftStatus(choice, setConfirm(draft, yes));
          expect(status.canSubmit).toBe(true);
          expect(validateChoiceAnswer(choice, status.answer!)).toEqual({ ok: true });
        }
      }
    }
  });

  it('preserves pick order in the submitted answer for an ordered choice', () => {
    const choice = selectCards({ min: 3, max: 3, ordered: true });
    let draft = emptyDraft(choice);
    for (const id of [3, 1, 2]) draft = toggleOption(choice, draft, id);
    const status = draftStatus(choice, draft);
    expect(status.canSubmit).toBe(true);
    expect(status.answer).toEqual({ kind: 'selectCards', instanceIds: [3, 1, 2] });
  });

  it('leaves a yes/no unsubmittable until one is picked', () => {
    const choice = { ...BASE, kind: 'confirm', min: 1, max: 1 } as PendingChoice;
    const draft = emptyDraft(choice);
    expect(draftToAnswer(draft)).toBeNull();
    expect(draftStatus(choice, draft).canSubmit).toBe(false);
    expect(draftStatus(choice, setConfirm(draft, false)).answer).toEqual({ kind: 'confirm', yes: false });
  });

  it('supports "may": declining submits an empty, legal answer', () => {
    const choice = selectCards({ min: 0, max: 2 });
    const picked = toggleOption(choice, emptyDraft(choice), 1);
    const declined = clearDraft(choice, picked);
    const status = draftStatus(choice, declined);
    expect(status.canSubmit).toBe(true);
    expect(status.answer).toEqual({ kind: 'selectCards', instanceIds: [] });
  });

  it('does not offer a decline for a mandatory choice', () => {
    expect(choicePromptView(selectCards({ min: 1, max: 1 }), NAMES).optional).toBe(false);
    expect(choicePromptView(selectCards({ min: 0, max: 2 }), NAMES).optional).toBe(true);
  });
});

function payMana(over: Partial<Extract<PendingChoice, { kind: 'payMana' }>> = {}): PendingChoice {
  return {
    ...BASE,
    kind: 'payMana',
    prompt: 'Pay {3} or Mana Leak counters Opt',
    sourceName: 'Mana Leak',
    cost: { generic: 3 },
    affordable: true,
    min: 1,
    max: 1,
    ...over,
  } as PendingChoice;
}

describe('choice-view — a pay/decline choice', () => {
  it('is undecided until one of the two is pressed, then submits that answer', () => {
    const choice = payMana();
    const draft = emptyDraft(choice);
    expect(draftToAnswer(draft)).toBeNull();
    expect(draftStatus(choice, draft).canSubmit).toBe(false);
    expect(draftStatus(choice, draft).hint).toContain('pay');

    for (const pay of [true, false]) {
      const status = draftStatus(choice, setPayMana(draft, pay));
      expect(status.answer).toEqual({ kind: 'payMana', pay });
      expect(status.canSubmit).toBe(true);
      expect(validateChoiceAnswer(choice, status.answer!)).toEqual({ ok: true });
    }
  });

  it('agrees with the ENGINE that paying an unaffordable cost cannot be submitted', () => {
    const choice = payMana({ affordable: false });
    const status = draftStatus(choice, setPayMana(emptyDraft(choice), true));
    expect(status.canSubmit).toBe(false);
    // Declining stays available, so the prompt can always be answered.
    expect(draftStatus(choice, setPayMana(emptyDraft(choice), false)).canSubmit).toBe(true);
  });

  it('spells out the cost, and says so when the board cannot produce it', () => {
    expect(choicePromptView(payMana(), NAMES).requirement).toContain('Pay {3}');
    expect(choicePromptView(payMana({ affordable: false }), NAMES).requirement).toContain('cannot produce {3}');
    // It is not a selection: there is nothing to "choose none" of.
    expect(choicePromptView(payMana(), NAMES).optional).toBe(false);
  });

  it('ignores selection gestures — it is a two-button question', () => {
    const choice = payMana();
    const draft = setPayMana(emptyDraft(choice), true);
    expect(toggleOption(choice, draft, 1)).toBe(draft);
    expect(clearDraft(choice, draft)).toBe(draft);
    expect(draftValues(draft)).toEqual([]);
    // The yes/no setter and the pay/decline setter do not cross-talk.
    expect(setConfirm(draft, false)).toBe(draft);
  });
});

function payLife(over: Partial<Extract<PendingChoice, { kind: 'payLife' }>> = {}): PendingChoice {
  return {
    ...BASE,
    kind: 'payLife',
    prompt: 'Pay 2 life, or Blood Crypt enters tapped',
    sourceName: 'Blood Crypt',
    amount: 2,
    affordable: true,
    min: 1,
    max: 1,
    ...over,
  } as PendingChoice;
}

describe('choice-view — a pay-life choice (a shockland)', () => {
  it('is undecided until pressed, then submits pay or decline', () => {
    const choice = payLife();
    const draft = emptyDraft(choice);
    expect(draftToAnswer(draft)).toBeNull();
    expect(draftStatus(choice, draft).canSubmit).toBe(false);

    for (const pay of [true, false]) {
      const status = draftStatus(choice, setPayLife(draft, pay));
      expect(status.answer).toEqual({ kind: 'payLife', pay });
      expect(status.canSubmit).toBe(true);
      expect(validateChoiceAnswer(choice, status.answer!)).toEqual({ ok: true });
    }
  });

  it('agrees with the engine that paying unaffordable life cannot be submitted', () => {
    const choice = payLife({ affordable: false });
    expect(draftStatus(choice, setPayLife(emptyDraft(choice), true)).canSubmit).toBe(false);
    expect(draftStatus(choice, setPayLife(emptyDraft(choice), false)).canSubmit).toBe(true);
  });

  it('spells out the price and the tapped consequence', () => {
    expect(choicePromptView(payLife(), NAMES).requirement).toContain('Pay 2 life');
    expect(choicePromptView(payLife(), NAMES).requirement).toContain('tapped');
    expect(choicePromptView(payLife({ affordable: false }), NAMES).requirement).toContain('do not have');
    expect(choicePromptView(payLife(), NAMES).optional).toBe(false);
  });

  it('ignores selection gestures and the other binary setter', () => {
    const choice = payLife();
    const draft = setPayLife(emptyDraft(choice), true);
    expect(toggleOption(choice, draft, 1)).toBe(draft);
    expect(clearDraft(choice, draft)).toBe(draft);
    expect(setConfirm(draft, false)).toBe(draft);
    expect(setPayMana(draft, false)).toBe(draft);
  });
});

function selectTargets(over: Partial<Extract<PendingChoice, { kind: 'selectTargets' }>> = {}): PendingChoice {
  return {
    ...BASE,
    kind: 'selectTargets',
    prompt: 'Choose a creature for Enters: deals 2 damage',
    sourceName: 'Flametongue Kavu',
    candidates: [
      { ref: 11, name: 'Grizzly Bears', controller: 'B' },
      { ref: 12, name: 'Wall of Omens', controller: 'B' },
    ],
    restriction: 'creature',
    min: 1,
    max: 1,
    ...over,
  } as PendingChoice;
}

describe('choice-view — aiming a triggered ability', () => {
  it('drafts a target the same way a card selection drafts a card', () => {
    const choice = selectTargets();
    let draft = emptyDraft(choice);
    expect(draftStatus(choice, draft).canSubmit).toBe(false);

    draft = toggleOption(choice, draft, 12);
    const status = draftStatus(choice, draft);
    expect(status.answer).toEqual({ kind: 'selectTargets', targets: [12] });
    expect(status.canSubmit).toBe(true);
    expect(validateChoiceAnswer(choice, status.answer!)).toEqual({ ok: true });
  });

  it('replaces the pick rather than stacking a second one (a single-target ability)', () => {
    const choice = selectTargets();
    let draft = toggleOption(choice, emptyDraft(choice), 11);
    draft = toggleOption(choice, draft, 12);
    expect(draftValues(draft)).toEqual([12]);
  });

  it('says what may be pointed at, and offers no "choose none"', () => {
    // A target is mandatory: an ability with no legal target never reaches a
    // human at all (the engine removes it from the stack), so a decline button
    // here would offer an answer the rules do not have.
    const view = choicePromptView(selectTargets(), NAMES);
    expect(view.requirement).toContain('a creature');
    expect(view.requirement).toContain('Flametongue Kavu');
    expect(view.optional).toBe(false);
  });
});

describe('choice-view — prompt copy + viewer gating', () => {
  it('names the chooser, the source and the count rule', () => {
    const view = choicePromptView(selectCards({ min: 2, max: 2, fromZone: 'graveyard' }), NAMES);
    expect(view.chooserName).toBe('Alice');
    expect(view.sourceName).toBe('Brainstorm');
    expect(view.requirement).toContain('exactly 2 cards');
    expect(view.requirement).toContain('graveyard');
  });

  it('spells out an optional and a ranged requirement', () => {
    expect(choicePromptView(selectCards({ min: 0, max: 2 }), NAMES).requirement).toContain('up to 2 cards');
    expect(choicePromptView(selectCards({ min: 1, max: 3 }), NAMES).requirement).toContain('1–3 cards');
  });

  it('announces that order matters only for an ordered choice', () => {
    expect(choicePromptView(selectCards({ min: 2, max: 2, ordered: true }), NAMES).requirement).toContain('order');
    expect(choicePromptView(selectCards({ min: 2, max: 2 }), NAMES).requirement).not.toContain('order');
  });

  it('only the chooser may be shown the candidates', () => {
    const choice = selectCards();
    expect(isChoiceForViewer(choice, 'A')).toBe(true);
    expect(isChoiceForViewer(choice, 'B')).toBe(false);
    // The line the other seat sees names nobody's cards.
    const waiting = waitingForChoiceText(choice, NAMES);
    expect(waiting).toContain('Alice');
    for (const c of choice.kind === 'selectCards' ? choice.candidates : []) {
      expect(waiting).not.toContain(c.name);
    }
  });

  it('degrades an unknown zone to its raw id', () => {
    expect(zoneLabel('graveyard')).toBe('graveyard');
    expect(zoneLabel('somewhere-new')).toBe('somewhere-new');
    expect(zoneLabel(undefined)).toBeUndefined();
  });
});

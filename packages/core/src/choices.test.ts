/**
 * Unit tests for the choice VALUE layer (choices.ts) — the normalisation,
 * validation, filtering and enumeration that the engine's suspend/resume machinery
 * is built on. The end-to-end proof that real card shapes play correctly lives in
 * `choice-cards.test.ts`; this file pins the invariants underneath it, above all
 * the one that makes hanging impossible: `0 <= min <= max <= optionCount`, so a
 * legal answer always exists and the offered action list is never empty.
 */

import { describe, expect, it } from 'vitest';
import {
  cardOption,
  choiceOptionCount,
  cloneChoiceAnswer,
  collectCardOptions,
  createGame,
  defaultAnswerFor,
  describeChoiceAnswer,
  enumerateChoiceAnswers,
  isTrivialChoice,
  matchesCardFilter,
  MAX_ENUMERATED_CHOICE_ANSWERS,
  normalizeChoiceRequest,
  validateChoiceAnswer,
  type CardOption,
  type ChoiceRequest,
  type GameState,
  type PendingChoice,
  type SelectCardsRequest,
} from './index.js';
import { creatureDef, deckOf, giveHand, giveLibrary, landDef } from './test-fixtures.js';

const ISLAND = landDef('Island', 'U');
const SOURCE = { id: 1, sourceInstanceId: 99, sourceName: 'Test Card' };

function options(count: number): CardOption[] {
  return Array.from({ length: count }, (_, i) => ({
    instanceId: 100 + i,
    cardId: `card-${i}`,
    name: `Card ${i}`,
    zone: 'hand' as const,
    controller: 'A' as const,
  }));
}

function selectCards(request: Partial<SelectCardsRequest> & { candidates: readonly CardOption[] }): PendingChoice {
  const normalized = normalizeChoiceRequest(
    { kind: 'selectCards', chooser: 'A', prompt: 'pick', ...request } as ChoiceRequest,
    SOURCE,
  );
  if (!normalized) throw new Error('expected a normalised choice');
  return normalized;
}

function freshState(): GameState {
  return createGame({ seed: 42, decks: { A: deckOf(ISLAND, 20), B: deckOf(ISLAND, 20) } }).state;
}

// --- normalisation ------------------------------------------------------------------

describe('normalizeChoiceRequest', () => {
  it('defaults to exactly one when neither bound is given', () => {
    const choice = selectCards({ candidates: options(4) });
    expect([choice.min, choice.max]).toEqual([1, 1]);
  });

  it('reads `max` alone as "exactly that many" and `min:0` as "up to"', () => {
    expect([selectCards({ candidates: options(4), max: 2 }).min, selectCards({ candidates: options(4), max: 2 }).max]).toEqual([2, 2]);
    const upTo = selectCards({ candidates: options(4), min: 0, max: 2 });
    expect([upTo.min, upTo.max]).toEqual([0, 2]);
  });

  it('clamps both bounds to the options actually available — the no-hang invariant', () => {
    const choice = selectCards({ candidates: options(1), min: 3, max: 5 });
    expect(choice.max).toBe(1);
    expect(choice.min).toBe(1);
    const none = selectCards({ candidates: [], min: 2, max: 2 });
    expect([none.min, none.max]).toEqual([0, 0]);
  });

  it('never produces a choice whose default answer is illegal, across many shapes', () => {
    for (let count = 0; count < 6; count++) {
      for (let min = 0; min < 8; min++) {
        for (let max = min; max < 8; max++) {
          const choice = selectCards({ candidates: options(count), min, max });
          expect(choice.min).toBeLessThanOrEqual(choice.max);
          expect(choice.max).toBeLessThanOrEqual(count);
          expect(validateChoiceAnswer(choice, defaultAnswerFor(choice)).ok).toBe(true);
          expect(enumerateChoiceAnswers(choice).length).toBeGreaterThan(0);
        }
      }
    }
  });

  it('returns null for a kind it does not know, rather than throwing', () => {
    expect(normalizeChoiceRequest({ kind: 'telepathy', chooser: 'A', prompt: '?' } as never, SOURCE)).toBeNull();
  });

  it('carries chooser, prompt, valence and provenance through', () => {
    const choice = selectCards({ candidates: options(2), chooser: 'B', prompt: 'discard', valence: 'loss' });
    expect(choice.chooser).toBe('B');
    expect(choice.prompt).toBe('discard');
    expect(choice.valence).toBe('loss');
    expect(choice.sourceName).toBe('Test Card');
    expect(choice.sourceInstanceId).toBe(99);
    expect(choice.id).toBe(1);
  });

  it('copies the candidate list so the request cannot mutate the parked choice', () => {
    const candidates = options(2);
    const choice = selectCards({ candidates });
    candidates.push(...options(1));
    expect(choice.kind === 'selectCards' && choice.candidates).toHaveLength(2);
  });
});

// --- validation ----------------------------------------------------------------------

describe('validateChoiceAnswer', () => {
  const choice = selectCards({ candidates: options(3), min: 1, max: 2 });
  const ids = options(3).map((o) => o.instanceId);

  it('accepts any legal selection', () => {
    expect(validateChoiceAnswer(choice, { kind: 'selectCards', instanceIds: [ids[0]!] }).ok).toBe(true);
    expect(validateChoiceAnswer(choice, { kind: 'selectCards', instanceIds: [ids[2]!, ids[0]!] }).ok).toBe(true);
  });

  it('rejects too few, too many, duplicates, and unoffered options', () => {
    expect(validateChoiceAnswer(choice, { kind: 'selectCards', instanceIds: [] }).ok).toBe(false);
    expect(validateChoiceAnswer(choice, { kind: 'selectCards', instanceIds: ids }).ok).toBe(false);
    expect(validateChoiceAnswer(choice, { kind: 'selectCards', instanceIds: [ids[0]!, ids[0]!] }).ok).toBe(false);
    expect(validateChoiceAnswer(choice, { kind: 'selectCards', instanceIds: [12345] }).ok).toBe(false);
  });

  it('rejects an answer of the wrong kind and a non-answer', () => {
    expect(validateChoiceAnswer(choice, { kind: 'confirm', yes: true }).ok).toBe(false);
    expect(validateChoiceAnswer(choice, null as never).ok).toBe(false);
    expect(validateChoiceAnswer(choice, { kind: 'selectCards', instanceIds: 'nope' } as never).ok).toBe(false);
  });

  it('requires a boolean for a yes/no', () => {
    const confirm = normalizeChoiceRequest({ kind: 'confirm', chooser: 'A', prompt: 'may?' }, SOURCE)!;
    expect(validateChoiceAnswer(confirm, { kind: 'confirm', yes: true }).ok).toBe(true);
    expect(validateChoiceAnswer(confirm, { kind: 'confirm', yes: 'yes' } as never).ok).toBe(false);
  });

  it('validates modes and players the same way', () => {
    const modes = normalizeChoiceRequest(
      { kind: 'chooseModes', chooser: 'A', prompt: 'choose two', modes: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }, { id: 'c', label: 'C' }], max: 2 },
      SOURCE,
    )!;
    expect(validateChoiceAnswer(modes, { kind: 'chooseModes', modeIds: ['a', 'c'] }).ok).toBe(true);
    expect(validateChoiceAnswer(modes, { kind: 'chooseModes', modeIds: ['a'] }).ok).toBe(false);
    expect(validateChoiceAnswer(modes, { kind: 'chooseModes', modeIds: ['a', 'z'] }).ok).toBe(false);

    const players = normalizeChoiceRequest({ kind: 'selectPlayers', chooser: 'A', prompt: 'who', candidates: ['A', 'B'] }, SOURCE)!;
    expect(validateChoiceAnswer(players, { kind: 'selectPlayers', players: ['B'] }).ok).toBe(true);
    expect(validateChoiceAnswer(players, { kind: 'selectPlayers', players: ['A', 'B'] }).ok).toBe(false);
  });
});

// --- trivial choices + enumeration -----------------------------------------------------

describe('isTrivialChoice', () => {
  it('is true when there is exactly one legal answer', () => {
    expect(isTrivialChoice(selectCards({ candidates: [], min: 1, max: 1 }))).toBe(true); // clamped to 0..0
    expect(isTrivialChoice(selectCards({ candidates: options(2), min: 2, max: 2 }))).toBe(true); // take them all
  });

  it('is false when the player has a real decision', () => {
    expect(isTrivialChoice(selectCards({ candidates: options(3), min: 1, max: 1 }))).toBe(false);
    expect(isTrivialChoice(selectCards({ candidates: options(2), min: 0, max: 2 }))).toBe(false);
    expect(isTrivialChoice(normalizeChoiceRequest({ kind: 'confirm', chooser: 'A', prompt: '?' }, SOURCE)!)).toBe(false);
  });

  it('is false for an ORDERED pick of several — the order is still a decision', () => {
    expect(isTrivialChoice(selectCards({ candidates: options(2), min: 2, max: 2, ordered: true }))).toBe(false);
    // …but one card has only one arrangement.
    expect(isTrivialChoice(selectCards({ candidates: options(1), min: 1, max: 1, ordered: true }))).toBe(true);
  });
});

describe('enumerateChoiceAnswers', () => {
  it('offers both branches of a yes/no', () => {
    const confirm = normalizeChoiceRequest({ kind: 'confirm', chooser: 'A', prompt: '?' }, SOURCE)!;
    expect(enumerateChoiceAnswers(confirm)).toEqual([
      { kind: 'confirm', yes: true },
      { kind: 'confirm', yes: false },
    ]);
  });

  it('offers every legal subset when there are few candidates', () => {
    const choice = selectCards({ candidates: options(3), min: 1, max: 1 });
    expect(enumerateChoiceAnswers(choice)).toHaveLength(3);
    const upToTwo = selectCards({ candidates: options(3), min: 0, max: 2 });
    // {} + 3 singles + 3 pairs
    expect(enumerateChoiceAnswers(upToTwo)).toHaveLength(7);
  });

  it('stays BOUNDED on a wide choice, and never returns nothing', () => {
    const wide = selectCards({ candidates: options(20), min: 0, max: 20 });
    const answers = enumerateChoiceAnswers(wide);
    expect(answers.length).toBeLessThanOrEqual(MAX_ENUMERATED_CHOICE_ANSWERS);
    expect(answers.length).toBeGreaterThan(0);
    for (const answer of answers) expect(validateChoiceAnswer(wide, answer).ok).toBe(true);
  });

  it('is deterministic — the same choice always enumerates in the same order', () => {
    const choice = selectCards({ candidates: options(6), min: 1, max: 3 });
    expect(JSON.stringify(enumerateChoiceAnswers(choice))).toBe(JSON.stringify(enumerateChoiceAnswers(choice)));
  });
});

// --- filters + candidate collection ------------------------------------------------------

describe('CardFilter', () => {
  const bear = { def: creatureDef('Bear', 2, 2, { cost: { generic: 2 } }) } as never;
  const island = { def: ISLAND } as never;

  it('filters by type, and "nonland" is `noneOfTypes`', () => {
    expect(matchesCardFilter(bear, { anyOfTypes: ['creature'] })).toBe(true);
    expect(matchesCardFilter(island, { anyOfTypes: ['creature'] })).toBe(false);
    expect(matchesCardFilter(island, { noneOfTypes: ['land'] })).toBe(false);
    expect(matchesCardFilter(bear, { noneOfTypes: ['land'] })).toBe(true);
  });

  it('filters by name and by mana value', () => {
    expect(matchesCardFilter(bear, { nameEquals: 'Bear' })).toBe(true);
    expect(matchesCardFilter(bear, { nameEquals: 'Ogre' })).toBe(false);
    expect(matchesCardFilter(bear, { maxManaValue: 1 })).toBe(false);
    expect(matchesCardFilter(bear, { minManaValue: 2, maxManaValue: 3 })).toBe(true);
    expect(matchesCardFilter(island, { maxManaValue: 0 })).toBe(true); // a land costs nothing
  });

  it('an absent filter matches everything', () => {
    expect(matchesCardFilter(bear)).toBe(true);
  });
});

describe('collectCardOptions', () => {
  it('gathers one player\'s hand, filtered', () => {
    const state = freshState();
    state.players.A.hand = [];
    giveHand(state, 'A', [creatureDef('Bear', 2, 2), ISLAND, creatureDef('Ogre', 4, 4)]);
    const nonland = collectCardOptions(state, 'hand', { controller: 'A', filter: { noneOfTypes: ['land'] } });
    expect(nonland.map((o) => o.name)).toEqual(['Bear', 'Ogre']);
    expect(nonland[0]!.zone).toBe('hand');
    expect(nonland[0]!.controller).toBe('A');
  });

  it('takes the TOP N of a library in order (this is "look at the top three")', () => {
    const state = freshState();
    giveLibrary(state, 'A', [landDef('One', 'U'), landDef('Two', 'U'), landDef('Three', 'U'), landDef('Four', 'U')]);
    const top = collectCardOptions(state, 'library', { controller: 'A', limit: 3, fromTop: true });
    expect(top.map((o) => o.name)).toEqual(['One', 'Two', 'Three']);
  });

  it('scans the battlefield by controller', () => {
    const state = freshState();
    state.battlefield = [
      { ...cardStub(creatureDef('Mine', 1, 1), 'A'), instanceId: 501 },
      { ...cardStub(creatureDef('Theirs', 1, 1), 'B'), instanceId: 502 },
    ];
    expect(collectCardOptions(state, 'battlefield', { controller: 'A' }).map((o) => o.name)).toEqual(['Mine']);
    expect(collectCardOptions(state, 'battlefield')).toHaveLength(2);
  });

  it('returns an empty list for a zone with nothing in it — a valid, answerable choice', () => {
    const state = freshState();
    state.players.A.graveyard = [];
    const empty = collectCardOptions(state, 'graveyard', { controller: 'A' });
    expect(empty).toEqual([]);
    const choice = selectCards({ candidates: empty, min: 1, max: 1 });
    expect(isTrivialChoice(choice)).toBe(true);
    expect(validateChoiceAnswer(choice, defaultAnswerFor(choice)).ok).toBe(true);
  });
});

function cardStub(def: ReturnType<typeof creatureDef>, controller: 'A' | 'B') {
  return {
    instanceId: 0,
    def,
    controller,
    owner: controller,
    zone: 'battlefield' as const,
    tapped: false,
    summoningSick: false,
    damageMarked: 0,
    markedByDeathtouch: false,
    counters: {},
  };
}

// --- small helpers -------------------------------------------------------------------

describe('answer helpers', () => {
  it('cloneChoiceAnswer breaks aliasing for every kind', () => {
    const ids = [1, 2];
    const copy = cloneChoiceAnswer({ kind: 'selectCards', instanceIds: ids });
    expect(copy).toEqual({ kind: 'selectCards', instanceIds: [1, 2] });
    expect(copy.kind === 'selectCards' && copy.instanceIds).not.toBe(ids);

    const modes = ['a'];
    const modeCopy = cloneChoiceAnswer({ kind: 'chooseModes', modeIds: modes });
    expect(modeCopy.kind === 'chooseModes' && modeCopy.modeIds).not.toBe(modes);

    const players: Array<'A' | 'B'> = ['B'];
    const playerCopy = cloneChoiceAnswer({ kind: 'selectPlayers', players });
    expect(playerCopy.kind === 'selectPlayers' && playerCopy.players).not.toBe(players);
  });

  it('describeChoiceAnswer renders every kind, including the empty selection', () => {
    expect(describeChoiceAnswer({ kind: 'confirm', yes: true })).toBe('yes');
    expect(describeChoiceAnswer({ kind: 'selectCards', instanceIds: [] })).toBe('no cards');
    expect(describeChoiceAnswer({ kind: 'selectCards', instanceIds: [7, 8] })).toBe('cards [7, 8]');
    expect(describeChoiceAnswer({ kind: 'chooseModes', modeIds: ['draw'] })).toBe('modes [draw]');
    expect(describeChoiceAnswer({ kind: 'selectPlayers', players: ['B'] })).toBe('players [B]');
  });

  it('choiceOptionCount reports what was offered', () => {
    expect(choiceOptionCount(selectCards({ candidates: options(5) }))).toBe(5);
    expect(choiceOptionCount(normalizeChoiceRequest({ kind: 'confirm', chooser: 'A', prompt: '?' }, SOURCE)!)).toBe(2);
  });

  it('cardOption snapshots identity, name, zone and controller for the UI', () => {
    const state = freshState();
    state.players.A.hand = [];
    const [card] = giveHand(state, 'A', [creatureDef('Bear', 2, 2)]);
    expect(cardOption(card!)).toEqual({
      instanceId: card!.instanceId,
      cardId: 'Bear',
      name: 'Bear',
      zone: 'hand',
      controller: 'A',
    });
  });
});

/**
 * THE UNSUPPORTED-CARD GATE — one question, one answer, everywhere.
 *
 * A deck may legally CONTAIN a card the engine cannot play: the browser, the deck
 * builder and the proxy printer are all still useful, and the card pool is about to
 * grow to every card Scryfall knows, most of which have no engine definition yet.
 * What must never happen is that such a deck is PLAYED or SIMULATED, because the
 * unsupported cards behave as blanks: the game is quietly not the game you built,
 * and an A/B verdict on a blank-riddled deck is confidently wrong.
 *
 * So the rule is: **a deck is playable only if every card in it resolves to a real
 * engine definition**, and every surface that starts a game asks the SAME function
 * and shows the SAME words. Three surfaces used to answer it three ways —
 *
 *   - Play  (`validateChoice`)  → the sim's `unknown card "<uuid>"`, by id, no name
 *   - Lab   (`validateHero`)    → named the card but not what it needed
 *   - Builder (`assessDeckHealth`) → named both, and blocked nothing
 *
 * — and only the third was correct, which is why this file pins all three together.
 * The divergence test at the bottom is the guard: it fails if they drift apart
 * again, which is the only reason the first two were ever wrong.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { CardDefinition } from '@jonny-boi/core';
import type { NormalizedCard } from '@jonny-boi/data-tools';
import {
  clearImportedCards,
  registerImportedCards,
} from '../decklist/importedCards.js';
import { assessDeckHealth, describeDeckHealth } from '../decklist/deckHealth.js';
import { validateHero } from '../heroValidation.js';
import {
  invalidateHotseatPool,
  startHotseatGame,
  validateChoice,
  type DeckChoice,
} from './setup.js';
import type { Deck as WebDeck } from '../deck.js';

/** A card the compiler could not finish: it is in the store, it has no definition. */
const BROKEN_ID = 'test-unsupported-0000-0000-00000000cafe';
const BROKEN_NAME = 'Untranslatable Oracle';
const BROKEN_SYSTEM = 'a "you may / choose" template the compiler does not recognize yet';
const BROKEN_RECORD = {
  id: BROKEN_ID,
  name: BROKEN_NAME,
  typeLine: 'Creature — Test',
  manaCost: { generic: 1, W: 0, U: 0, B: 0, R: 0, G: 1, C: 0, other: [] },
} as unknown as NormalizedCard;

/** A card that DID compile — the control, so a green is not "everything is refused". */
const FINE_ID = 'test-supported-0000-0000-00000000beef';
const FINE_NAME = 'Perfectly Ordinary Bear';
const FINE_DEF: CardDefinition = {
  id: FINE_ID,
  name: FINE_NAME,
  types: ['creature'],
  cost: { generic: 1, G: 1 },
  power: 2,
  toughness: 2,
};
const FINE_RECORD = {
  id: FINE_ID,
  name: FINE_NAME,
  typeLine: 'Creature — Bear',
  manaCost: { generic: 1, W: 0, U: 0, B: 0, R: 0, G: 1, C: 0, other: [] },
} as unknown as NormalizedCard;

/**
 * An id NOTHING knows: not curated, not imported, not displayable.
 *
 * This is the shape the all-of-Scryfall pool creates by the thousand — a card you
 * can browse and add to a deck whose text the engine has never been taught. It is
 * tested here because it is the row the old code got wrong in the most dangerous
 * direction: deck health said "playable" for any id it had never heard of.
 */
const STRANGER_ID = 'test-stranger-0000-0000-0000000000ff';

const FOREST_NAME = 'Forest';

/** A legal 60-card deck: `count` copies of `cardId`, padded with basic Forest. */
function deckWith(cardId: string, count: number): WebDeck {
  return {
    id: 'deck-under-test',
    name: 'Deck under test',
    updatedAt: new Date(0).toISOString(),
    cards: [
      { cardId, count },
      { cardId: FOREST_NAME, count: 60 - count },
    ],
  } as unknown as WebDeck;
}

/** The all-curated control deck: 60 Forest, which the engine plays perfectly. */
function forestDeck(): WebDeck {
  return {
    id: 'deck-control',
    name: 'Control deck',
    updatedAt: new Date(0).toISOString(),
    cards: [{ cardId: FOREST_NAME, count: 60 }],
  } as unknown as WebDeck;
}

function choiceOf(deck: WebDeck): DeckChoice {
  return { source: 'saved', deck };
}

/** Deck-health entries for a web deck — the shape the funnel takes. */
function entriesOf(deck: WebDeck): { cardId: string; count: number }[] {
  return deck.cards.map((c) => ({ cardId: c.cardId, count: c.count }));
}

beforeEach(() => {
  clearImportedCards();
  invalidateHotseatPool();
});

describe('a deck holding a card the compiler could not finish', () => {
  beforeEach(() => {
    registerImportedCards([
      { card: BROKEN_RECORD, missing: [{ text: 'you may draw a card', missingEngineSystem: BROKEN_SYSTEM }] },
    ]);
    invalidateHotseatPool();
  });

  it('is refused by PLAY, naming the card and what it needs', () => {
    const problems = validateChoice(choiceOf(deckWith(BROKEN_ID, 4)));
    expect(problems.length, 'play must refuse it').toBeGreaterThan(0);
    const said = problems.join(' ');
    expect(said, 'name the card, never make him hunt through 60 lines').toContain(BROKEN_NAME);
    expect(said, 'say what the engine is missing').toContain(BROKEN_SYSTEM);
    expect(said, 'a bare uuid is not an explanation').not.toContain(BROKEN_ID);
  });

  it('cannot be started even if a caller ignores the problems', () => {
    // The gate is not advisory: `startHotseatGame` must not hand back a game.
    const started = startHotseatGame({
      choiceA: choiceOf(deckWith(BROKEN_ID, 4)),
      choiceB: choiceOf(forestDeck()),
      seed: 1234,
      startingPlayer: 'A',
    });
    expect(started.ok, 'an unsupported deck must never reach the engine').toBe(false);
  });

  it('is refused by the LAB, naming the card and what it needs', () => {
    const problems = validateHero(deckWith(BROKEN_ID, 4) as unknown as Parameters<typeof validateHero>[0]);
    expect(problems.length, 'the lab must refuse it').toBeGreaterThan(0);
    const said = problems.join(' ');
    expect(said).toContain(BROKEN_NAME);
    expect(said, 'the lab used to name the card but not the gap').toContain(BROKEN_SYSTEM);
  });

  it('is reported by deck health with the copy count', () => {
    const health = assessDeckHealth(entriesOf(deckWith(BROKEN_ID, 4)));
    expect(health.playable).toBe(false);
    expect(health.affectedCopies).toBe(4);
    expect(describeDeckHealth(health)).toContain(BROKEN_SYSTEM);
  });
});

describe('a deck that is short AND holds an unsupported card', () => {
  // His transcribed deck, exactly: 47 cards, five of them unsupported. The
  // support refusal used to come back ALONE, so he would fix five cards and only
  // then learn the deck was thirteen short. The sim's own validator cannot be
  // asked here — it counts only the cards it resolved and would say 42 — so the
  // size rule is judged over every entry and added in the sim's own words.
  const SHORT = 47;
  function shortDeck(): WebDeck {
    return {
      id: 'deck-short',
      name: 'Short and unsupported',
      updatedAt: new Date(0).toISOString(),
      cards: [
        { cardId: BROKEN_ID, count: 4 },
        { cardId: FOREST_NAME, count: SHORT - 4 },
      ],
    } as unknown as WebDeck;
  }

  beforeEach(() => {
    registerImportedCards([
      { card: BROKEN_RECORD, missing: [{ text: 'x', missingEngineSystem: BROKEN_SYSTEM }] },
    ]);
    invalidateHotseatPool();
  });

  it('PLAY says both — the unsupported card and the true size', () => {
    const said = validateChoice(choiceOf(shortDeck())).join(' ');
    expect(said).toContain(BROKEN_NAME);
    expect(said, 'the size is the WHOLE deck, unsupported copies included').toContain(`deck size ${SHORT} is below the minimum of 60`);
    expect(said, 'never the count of resolved cards only').not.toContain(`deck size ${SHORT - 4}`);
  });

  it('the LAB says both, in the same words', () => {
    const said = validateHero(shortDeck() as unknown as Parameters<typeof validateHero>[0]).join(' ');
    expect(said).toContain(BROKEN_NAME);
    expect(said).toContain(`deck size ${SHORT} is below the minimum of 60`);
  });

  it('a FULL deck with an unsupported card says nothing about size', () => {
    const said = validateChoice(choiceOf(deckWith(BROKEN_ID, 4))).join(' ');
    expect(said).toContain(BROKEN_NAME);
    expect(said).not.toMatch(/deck size/);
  });
});

describe('a deck holding a card the engine has simply never been taught', () => {
  // No import entry, no curated definition — the all-of-Scryfall case. The old
  // deck-health rule ("unsupported only if the import store says so") called this
  // PLAYABLE, which is the single most dangerous answer available.
  it('is not playable, even though nothing knows why', () => {
    const health = assessDeckHealth(entriesOf(deckWith(STRANGER_ID, 4)));
    expect(health.playable, 'an id the engine cannot resolve is never playable').toBe(false);
    expect(health.affectedCopies).toBe(4);
  });

  it('is refused by play, and says something a person can act on', () => {
    const problems = validateChoice(choiceOf(deckWith(STRANGER_ID, 4)));
    expect(problems.length).toBeGreaterThan(0);
    expect(problems.join(' ')).toMatch(/can.t be played|not playable|unknown card/i);
  });
});

describe('the control — a deck the engine fully supports', () => {
  it('passes every surface', () => {
    expect(assessDeckHealth(entriesOf(forestDeck())).playable, 'deck health').toBe(true);
    expect(validateChoice(choiceOf(forestDeck())), 'play').toEqual([]);
    expect(
      validateHero(forestDeck() as unknown as Parameters<typeof validateHero>[0]),
      'lab',
    ).toEqual([]);
  });

  it('still passes once a genuinely playable import is in it', () => {
    registerImportedCards([{ card: FINE_RECORD, definition: FINE_DEF }]);
    invalidateHotseatPool();
    const deck = deckWith(FINE_ID, 4);
    expect(assessDeckHealth(entriesOf(deck)).playable, 'deck health').toBe(true);
    expect(validateChoice(choiceOf(deck)), 'play').toEqual([]);
  });
});

describe('the three surfaces never disagree', () => {
  /**
   * The guard for the defect class, not the defect: every case below is asked of
   * all three entry points, and a mismatch fails. Two places that answer the same
   * question WILL eventually answer it differently, and the bug gets attributed to
   * neither — so the divergence itself is what is pinned.
   */
  const cases: ReadonlyArray<{
    readonly what: string;
    readonly setUp: () => void;
    readonly deck: () => WebDeck;
    readonly playable: boolean;
  }> = [
    { what: 'all curated', setUp: () => {}, deck: forestDeck, playable: true },
    {
      what: 'a playable import',
      setUp: () => registerImportedCards([{ card: FINE_RECORD, definition: FINE_DEF }]),
      deck: () => deckWith(FINE_ID, 4),
      playable: true,
    },
    {
      what: 'an import that failed to compile',
      setUp: () =>
        registerImportedCards([
          { card: BROKEN_RECORD, missing: [{ text: 'x', missingEngineSystem: BROKEN_SYSTEM }] },
        ]),
      deck: () => deckWith(BROKEN_ID, 4),
      playable: false,
    },
    {
      what: 'a card nothing knows',
      setUp: () => {},
      deck: () => deckWith(STRANGER_ID, 4),
      playable: false,
    },
  ];

  for (const c of cases) {
    it(`agrees on ${c.what}`, () => {
      c.setUp();
      invalidateHotseatPool();
      const deck = c.deck();
      const health = assessDeckHealth(entriesOf(deck)).playable;
      const play = validateChoice(choiceOf(deck)).length === 0;
      const lab =
        validateHero(deck as unknown as Parameters<typeof validateHero>[0]).length === 0;
      expect(
        { health, play, lab },
        `all three must say ${c.playable} for ${c.what}`,
      ).toEqual({ health: c.playable, play: c.playable, lab: c.playable });
    });
  }
});

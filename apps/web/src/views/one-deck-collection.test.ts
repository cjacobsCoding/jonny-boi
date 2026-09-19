/**
 * THERE IS ONE COLLECTION OF HIS DECKS, AND IT IS EDITABLE.
 *
 * ## The defect
 *
 * > "yo why is there a 'your paper decks' and 'your decks' - this is dumb. I
 * > just want one collection of decks and I must be able to edit all of them,
 * > regardless of whether scanned in. And you can ditch the Acidic Angels deck
 * > with 59 cards, not sure why its missing one"
 *
 * He asked for his physical decks to be in the app. What shipped was a SECOND,
 * separate, read-only region — "Your paper decks" — above the collection his
 * decks already lived in, with its own badge, its own origin and its own
 * legality rules. Three regions of decks in one panel, two of them claiming to
 * be his.
 *
 * ## Why this is a MARKUP test
 *
 * The same reason `builtin-deck-identity.test.ts` is one: every unit test passed
 * while the second region shipped, because a unit test can ask whether the data
 * exists and never what the panel LOOKS LIKE. This renders the regions and
 * asserts the thing he could see and no test could: how many collections of his
 * decks there are, and that a deck with something wrong with it says so.
 *
 * It is the cheap half of the claim. The expensive half — a cold profile, a real
 * Chrome, his decks actually arriving and an edit actually surviving a reload —
 * is `scripts/verify-one-deck-collection.mjs`, because nine pieces of work in
 * this repo have been built, tested, green and unreachable, and not one of the
 * nine was caught by a test.
 */
import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { GauntletDecks, SavedDecks } from './DeckBuilderView.js';
import { DECK_ORIGINS, DECK_ORIGIN_ATTR } from '../lib/decklist/deckOrigin.js';
import { PAPER_SEEDS, planSeeding } from '../lib/decklist/paperDecks.js';
import type { Deck } from '../lib/deck.js';
import type { DecksApi } from '../lib/useDecks.js';

/** A `DecksApi` holding exactly these decks, with the first one active. */
function api(decks: Deck[]): DecksApi {
  return {
    decks,
    activeDeck: decks[0] ?? null,
    selectDeck: () => {},
    newDeck: () => {},
    deleteDeck: () => {},
    renameActive: () => {},
    addCard: () => {},
    removeCard: () => {},
    removeUnresolvedCard: () => {},
    dismissRevisionNote: () => {},
    setEntryPrinting: () => {},
    replaceActive: () => {},
    importDeck: () => {},
    updateDeck: () => {},
  };
}

/** The collection, as the builder renders it for a cold profile. */
function seededCollection(): Deck[] {
  return planSeeding([], new Set()).decks;
}

function savedMarkup(decks: Deck[]): string {
  return renderToStaticMarkup(createElement(SavedDecks, { decks: api(decks) }));
}

function builtinMarkup(decks: Deck[]): string {
  return renderToStaticMarkup(createElement(GauntletDecks, { decks: api(decks) }));
}

/** How many times `needle` occurs in `haystack`. */
function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

/**
 * The markup as a reader sees it.
 *
 * `renderToStaticMarkup` escapes text, so "Thune's Life" arrives as
 * `Thune&#x27;s Life` and a naive `toContain` on a deck NAME fails for a reason
 * that has nothing to do with the claim. Decoding is the honest fix; asserting
 * on the escaped spelling would make the test unreadable and would break again
 * the first time a deck picked up an ampersand.
 */
function text(html: string): string {
  return html
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

describe('ONE collection of his decks — not two', () => {
  it('renders exactly one "Your decks" heading', () => {
    const html = savedMarkup(seededCollection());
    expect(occurrences(html, DECK_ORIGINS.mine.groupLabel)).toBe(1);
  });

  it('says the word "paper" nowhere at all', () => {
    // The literal thing he read on screen. Checked across BOTH regions, because
    // the old one sat between them and a check on either alone would miss it.
    const html = text(savedMarkup(seededCollection()) + builtinMarkup(seededCollection()));
    expect(html.toLowerCase()).not.toContain('paper deck');
    expect(html.toLowerCase()).not.toContain('your paper');
  });

  it('has no third deck origin to render', () => {
    // The mechanism, not just the wording: a third origin is what let a third
    // region exist. Two nouns — reference data he does not own, and his decks.
    expect(Object.keys(DECK_ORIGINS).sort()).toEqual(['builtin', 'mine']);
  });

  it('marks every transcribed deck as HIS, like any other deck of his', () => {
    const html = savedMarkup(seededCollection());
    const mine = occurrences(html, `${DECK_ORIGIN_ATTR}="mine"`);
    expect(mine).toBe(PAPER_SEEDS.length);
    expect(html).not.toContain(`${DECK_ORIGIN_ATTR}="builtin"`);
    // No badge of any kind on his own decks — badging everything you own is
    // noise, and the distinction is only carried by what is NOT yours.
    expect(html).not.toContain(DECK_ORIGINS.builtin.badge);
  });

  it('lists his transcribed decks by the names he gave them', () => {
    const html = text(savedMarkup(seededCollection()));
    for (const seed of PAPER_SEEDS) {
      expect(html, `${seed.deck.name} is not in the collection`).toContain(seed.deck.name);
    }
  });

  it('still keeps the BUILT-IN gauntlet out of his collection', () => {
    // The one line that must NOT be blurred: those are the meta field the Lab
    // measures every verdict against, he does not own them, and rendering them
    // alongside his is DESIGN §3.35.
    const html = savedMarkup(seededCollection());
    expect(html).not.toContain('Selesnya Blink');
    expect(builtinMarkup([])).toContain('Selesnya Blink');
  });
});

describe('a deck that is short or incomplete says so in its row', () => {
  it('prints the reason under the deck name', () => {
    const short: Deck = {
      id: 'short',
      name: 'Tamiyo + Jace Surge',
      cards: [{ cardId: 'x', count: 36 }],
      updatedAt: '2026-01-01T00:00:00.000Z',
      unresolved: [{ name: 'Axebane Guardian', count: 4 }],
    };
    const html = text(savedMarkup([short]));
    expect(html).toContain('saved-deck__problems');
    expect(html).toContain('Axebane Guardian');
    expect(html).toContain('36 of 40 cards');
  });

  it('prints NOTHING for a deck that is fine — silence has to mean something', () => {
    // A line under every deck saying "60 cards, fine" trains the eye to skip the
    // line, which is how the deck that went short stops being noticed.
    const fine: Deck = {
      id: 'fine',
      name: 'Mono Red',
      cards: [{ cardId: 'x', count: 60 }],
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
    expect(savedMarkup([fine])).not.toContain('saved-deck__problems');
  });
});

/**
 * A BUILT-IN DECK MUST NOT RENDER LIKE ONE OF YOUR OWN.
 *
 * ## The defect
 *
 * > "I renamed the Selesnya Blink deck to Acidic Angels, which apparently just
 * > DUPLICATED the deck and left a 'Selesnya Blink' deck behind."
 *
 * Nothing duplicated. Selesnya Blink is one of the six BUILT-IN gauntlet decks;
 * it is permanently listed in the deck builder with a "Copy to my decks" button.
 * The user copied it, renamed the copy, and the built-in stayed exactly where it
 * had always been — reading, to him, as a leftover duplicate. `gauntlet-decks.css`
 * had said out loud that this was on purpose: the list "reuses `.saved-decks` …
 * so it sits visually with the user's own decks rather than looking like a new
 * region."
 *
 * ## Why the guard is a MARKUP test
 *
 * Every existing test passed while this shipped, because none of them could see
 * what a row LOOKS LIKE. This one renders both lists and asserts the thing the
 * user could not do: tell them apart. Following the `jail-tile.test.ts` /
 * `gauntlet-row-owner.test.ts` idiom — a static render, asserting what the markup
 * SAYS.
 *
 * ## What it pins
 *
 *  1. a built-in row carries the origin marker and the badge;
 *  2. one of YOUR decks carries neither — the marker's value is 'mine';
 *  3. a built-in deck you have ALREADY COPIED says so, and names your copy;
 *  4. an uncopied one still offers the copy button (the guard must not be
 *     satisfiable by never offering to copy anything);
 *  5. the two lists do not share a container class, which is the specific
 *     mechanism by which they became indistinguishable.
 */
import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { GauntletDecks, SavedDecks } from './DeckBuilderView.js';
import { gauntletDecks } from '../lib/decklist/gauntletDecks.js';
import { DECK_ORIGINS, DECK_ORIGIN_ATTR } from '../lib/decklist/deckOrigin.js';
import type { Deck } from '../lib/deck.js';
import type { DecksApi } from '../lib/useDecks.js';

/** The built-in deck named in the report — the one this whole fix is about. */
const BUILTIN = 'Selesnya Blink';
/** What the user renamed his copy to. A name match would go blind right here. */
const RENAMED_COPY = 'Acidic Angels';

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

/** One deck of the user's own. `copiedFrom` present iff it came from a built-in. */
function myDeck(name: string, copiedFrom?: string): Deck {
  const deck: Deck = {
    id: `local-${name}`,
    name,
    cards: [{ cardId: 'card-1', count: 60 }],
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  if (copiedFrom) deck.copiedFrom = copiedFrom;
  return deck;
}

const builtinMarker = `${DECK_ORIGIN_ATTR}="builtin"`;
const mineMarker = `${DECK_ORIGIN_ATTR}="mine"`;

/** The built-in list, rendered against the given saved decks. */
function builtinMarkup(decks: Deck[]): string {
  return renderToStaticMarkup(createElement(GauntletDecks, { decks: api(decks) }));
}

/** The user's own list. */
function savedMarkup(decks: Deck[]): string {
  return renderToStaticMarkup(createElement(SavedDecks, { decks: api(decks) }));
}

describe('a built-in deck is distinguishable from one of your own', () => {
  it('marks every built-in row as built-in', () => {
    const html = builtinMarkup([myDeck('My Deck')]);
    const marked = html.split(builtinMarker).length - 1;
    // Every one of them, not just the first — the ambiguity was a whole column.
    expect(marked, 'each built-in row must carry the origin marker').toBe(
      gauntletDecks().length,
    );
    expect(html).toContain(DECK_ORIGINS.builtin.badge);
  });

  it("does NOT mark one of the user's own decks as built-in", () => {
    // The other half of the claim: the marker has to DISCRIMINATE. A guard that
    // only checked the built-in side would pass if every row were badged.
    const html = savedMarkup([myDeck('My Deck'), myDeck(RENAMED_COPY, BUILTIN)]);
    expect(html).not.toContain(builtinMarker);
    expect(html).not.toContain(DECK_ORIGINS.builtin.badge);
    expect(html).toContain(mineMarker);
  });

  it('never renders the two lists into the same container class', () => {
    // The literal mechanism of the defect: the built-in list reused
    // `.saved-decks`, the user's own container. Two lists, one look.
    expect(builtinMarkup([myDeck('My Deck')])).not.toContain('class="saved-decks"');
    expect(savedMarkup([myDeck('My Deck')])).toContain('class="saved-decks"');
  });

  it('offers to copy a built-in deck you have not copied', () => {
    // Pinned so the "already copied" assertion below cannot be satisfied by
    // simply never showing a copy button at all.
    expect(builtinMarkup([myDeck('My Deck')])).toContain('Copy to my decks');
  });
});

describe('a built-in deck you already copied says so', () => {
  it('reports the copy and names it, even after the copy was renamed', () => {
    const html = builtinMarkup([myDeck(RENAMED_COPY, BUILTIN)]);
    expect(html).toContain('Already copied');
    // Names the COPY, which after a rename is the only handle the user has on
    // it. This exact sentence is what the bug report was missing.
    expect(html).toContain(RENAMED_COPY);
    expect(html).toContain('Open my copy');
  });

  it('does not keep dangling the plain copy button for that deck', () => {
    // Six built-ins, one of them copied: five still offer "Copy to my decks",
    // and the copied one offers "Copy again" instead.
    const html = builtinMarkup([myDeck(RENAMED_COPY, BUILTIN)]);
    const stillOffered = html.split('Copy to my decks').length - 1;
    expect(stillOffered).toBe(gauntletDecks().length - 1);
    expect(html).toContain('Copy again');
  });

  it('says nothing about a copy of a DIFFERENT built-in deck', () => {
    // Provenance is per-deck. A copy of Mono-Red must not mark Selesnya Blink.
    const other = gauntletDecks().find((d) => d.name !== BUILTIN)!;
    const html = builtinMarkup([myDeck('My Red Thing', other.name)]);
    const copied = html.split('Already copied').length - 1;
    expect(copied, 'exactly one built-in deck has been copied').toBe(1);
  });

  it('counts multiple copies rather than naming one of them as the only one', () => {
    const html = builtinMarkup([
      { ...myDeck(RENAMED_COPY, BUILTIN), updatedAt: '2026-02-01T00:00:00.000Z' },
      myDeck('Blink v2', BUILTIN),
    ]);
    expect(html).toContain('Already copied 2×');
    // Newest first, so "yours" points at the one they were just working on.
    expect(html).toContain(RENAMED_COPY);
  });
});

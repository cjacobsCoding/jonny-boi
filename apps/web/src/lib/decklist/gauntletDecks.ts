/**
 * The GAUNTLET DECKS, as things you can look at and build from.
 *
 * The six meta decks the Lab tests against are bundled sim data. Until now they
 * only existed inside the Lab and the play-setup dropdown: you could be beaten by
 * one without ever seeing its list, and you certainly could not open one up and
 * tune it — which is the entire premise of a deck-tuning lab.
 *
 * The awkward part is that the two deck formats disagree on what a card id IS.
 * Sim decks reference cards by NAME (`'Llanowar Elves'`) because they are authored
 * by hand; web decks reference the Scryfall UUID, because that is what the card
 * pool and every UI surface key on. So copying one into your decks is a real
 * resolution step, not a cast — and a name the pool doesn't know has to be
 * REPORTED rather than silently dropped, or you would get a 56-card "copy" of a
 * 60-card deck and no idea why.
 */

import { SAMPLE_DECKS, type Deck as SimDeck } from '@jonny-boi/sim';
import type { NormalizedCard } from '@jonny-boi/data-tools/pure';
import { allAvailableCards } from '../cards.js';
import { createDeck, type Deck } from '../deck.js';

/** A gauntlet deck as the builder lists it. */
export interface GauntletDeckSummary {
  readonly name: string;
  readonly archetype: string;
  /** Total cards, so the list can show "60 cards" without re-deriving it. */
  readonly size: number;
  /** The underlying sim deck, for copying. */
  readonly deck: SimDeck;
}

/** What copying a gauntlet deck produced. */
export interface GauntletCopy {
  /** An editable deck, owned by the user, with UUID card ids. */
  readonly deck: Deck;
  /**
   * Card names the pool could not resolve, so they are NOT in the copy. Empty in
   * the normal case; non-empty means the copy is genuinely short and the UI must
   * say so rather than hand back a quietly incomplete deck.
   */
  readonly unresolved: readonly string[];
}

/** Total cards in a sim deck. */
function simDeckSize(deck: SimDeck): number {
  return deck.cards.reduce((total, entry) => total + entry.count, 0);
}

/** Every gauntlet deck, with the numbers the builder shows. */
export function gauntletDecks(): readonly GauntletDeckSummary[] {
  return SAMPLE_DECKS.map((deck) => ({
    name: deck.name,
    archetype: deck.archetype,
    size: simDeckSize(deck),
    deck,
  }));
}

/** Case- and space-insensitive key, so "llanowar  elves" still matches. */
function nameKey(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Index the available pool by name. Built per call because the pool grows at
 * runtime (imported and à-la-carte cards), and a stale index would make a card
 * the user just added look unresolvable.
 */
function poolByName(): Map<string, NormalizedCard> {
  const index = new Map<string, NormalizedCard>();
  for (const card of allAvailableCards()) {
    index.set(nameKey(card.name), card);
    // Split / double-faced cards are listed under the combined "A // B" name but
    // authored decks name the front face, so index both.
    const front = card.name.split(' // ')[0];
    if (front) index.set(nameKey(front), card);
  }
  return index;
}

/**
 * Copy a BUNDLED sim deck into an editable deck of your own.
 *
 * A copy, not a reference: the bundled deck is immutable build data, and the
 * point of copying is to change it. The name is suffixed so it does not read as
 * the canonical gauntlet list once you have tuned it.
 *
 * ⚠️ This is THE name → pool resolution funnel for every bundled deck, not only
 * the gauntlet ones: `ownerDecks.ts` resolves the owner's paper decks through it
 * too, and reads the same `unresolved` to report what the pool cannot supply.
 * Keep it deck-source-agnostic — a second resolver would be a second answer to
 * one question, and the two would eventually disagree (CLAUDE.md rule 12). The
 * `Gauntlet` in the name is history; the behaviour is not gauntlet-specific.
 */
export function copyGauntletDeck(sample: SimDeck, nameSuffix = ' (copy)'): GauntletCopy {
  const index = poolByName();
  const unresolved: string[] = [];
  const cards: Deck['cards'] = [];

  for (const entry of sample.cards) {
    const card = index.get(nameKey(entry.cardId));
    if (!card) {
      unresolved.push(entry.cardId);
      continue;
    }
    // Merge duplicates rather than emitting two entries for one card.
    const existing = cards.find((c) => c.cardId === card.id);
    if (existing) existing.count += entry.count;
    else cards.push({ cardId: card.id, count: entry.count, name: card.name });
  }

  // `copiedFrom` is stamped here, at the ONE place a copy is minted, so the
  // built-in list can tell "you already have this" without guessing from the
  // name — which is precisely what the user then renames.
  const deck: Deck = { ...createDeck(`${sample.name}${nameSuffix}`), cards, copiedFrom: sample.name };
  return { deck, unresolved };
}

/**
 * Prefix marking a deck id as a gauntlet deck rather than one of the user's.
 * Stable across reloads, so a hero selection survives a refresh.
 */
export const GAUNTLET_DECK_ID_PREFIX = 'gauntlet:';

/** Whether a deck id refers to a bundled gauntlet deck. */
export function isGauntletDeckId(id: string): boolean {
  return id.startsWith(GAUNTLET_DECK_ID_PREFIX);
}

let heroCache: readonly Deck[] | undefined;

/**
 * The gauntlet decks as ordinary `Deck`s, so they can be SELECTED anywhere a deck
 * is selected — in particular as the Lab's hero.
 *
 * They are decks; there was never a reason you could only ever test your own list
 * against them and never test one of them. Wanting to know how the field's own
 * decks stack up against each other is the obvious first question to ask a lab.
 *
 * Unlike {@link copyGauntletDeck} these keep the EXACT deck name — the Lab
 * excludes the hero from the opponent list by name, so a suffix here would make a
 * deck fight itself.
 */
export function gauntletHeroDecks(): readonly Deck[] {
  if (heroCache) return heroCache;
  heroCache = SAMPLE_DECKS.map((sample) => ({
    ...copyGauntletDeck(sample, '').deck,
    id: `${GAUNTLET_DECK_ID_PREFIX}${sample.name}`,
  }));
  return heroCache;
}

/**
 * The user's decks that came from a given built-in deck, newest first.
 *
 * Hero decks are excluded by id: {@link gauntletHeroDecks} runs the same copy
 * path, so they carry `copiedFrom` too, and counting them would report that you
 * had already copied every built-in deck before you had copied any.
 */
export function copiesOfGauntletDeck(
  gauntletName: string,
  decks: readonly Deck[],
): readonly Deck[] {
  return decks
    .filter((deck) => !isGauntletDeckId(deck.id) && deck.copiedFrom === gauntletName)
    .slice()
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/**
 * What the built-in list says about a deck the user has already copied.
 *
 * Names the COPY, not the original: the copy is the thing they can open, and
 * after a rename its name is the only handle they have on it. The bug this
 * answers read, in full, "I renamed the Selesnya Blink deck to Acidic Angels,
 * which apparently just DUPLICATED the deck" — this sentence is the one that
 * would have prevented it.
 */
export function describeExistingCopies(copies: readonly Deck[]): string {
  const newest = copies[0];
  if (!newest) return '';
  if (copies.length === 1) return `Already copied — yours is “${newest.name}”.`;
  return `Already copied ${copies.length}× — newest is “${newest.name}”.`;
}

/** A one-line summary of a copy, for the toast/message after copying. */
export function describeGauntletCopy(copy: GauntletCopy): string {
  const size = copy.deck.cards.reduce((total, entry) => total + entry.count, 0);
  if (copy.unresolved.length === 0) {
    return `Copied “${copy.deck.name}” — ${size} cards, ready to edit.`;
  }
  return (
    `Copied “${copy.deck.name}” — ${size} cards. ` +
    `${copy.unresolved.length} could not be resolved and were left out: ${copy.unresolved.join(', ')}.`
  );
}

/**
 * DECK HEALTH — is this deck actually playable, and if not, which cards break it?
 *
 * A deck may legally contain cards whose printed text the engine cannot play yet
 * (deck import keeps them on purpose — a pasted list is a real deck). That is
 * fine for browsing and proxy printing, and NOT fine to play or simulate without
 * saying so: the deck would quietly behave as if those cards were blanks, and a
 * blank card in an A/B test silently corrupts the verdict.
 *
 * So every surface that shows a deck asks here, and shows the answer. The rule is
 * one line: a deck is `unplayable` if ANY card in it has no engine definition.
 * There is no "mostly fine" — a 59-of-60 deck is still a deck that does not do
 * what it says.
 */

import { unsupportedReason } from './importedCards.js';
import { getCard } from '../cards.js';

/** One card in a deck that the engine cannot play. */
export interface UnplayableCard {
  readonly cardId: string;
  readonly name: string;
  /** The engine systems its text needs, de-duplicated. */
  readonly missingSystems: readonly string[];
  /** Copies of it in the deck (a 4-of is a bigger hole than a 1-of). */
  readonly count: number;
}

/** Whether a deck can be played/simulated faithfully, and why not. */
export interface DeckHealth {
  /** True when every card in the deck has a real engine definition. */
  readonly playable: boolean;
  /** The offending cards, most-copies first. Empty when `playable`. */
  readonly unplayable: readonly UnplayableCard[];
  /** Total copies affected — the size of the hole in the deck. */
  readonly affectedCopies: number;
}

/** The shape of a deck entry this reads (id + copies). Structural on purpose. */
export interface DeckHealthEntry {
  readonly cardId: string;
  readonly count: number;
}

/** A healthy verdict, shared so callers can compare cheaply. */
const HEALTHY: DeckHealth = Object.freeze({ playable: true, unplayable: [], affectedCopies: 0 });

/**
 * Assess a deck. Cards in the curated pool are always playable; imported cards
 * are playable exactly when they compiled to a definition, which
 * {@link unsupportedReason} reports.
 */
export function assessDeckHealth(entries: readonly DeckHealthEntry[]): DeckHealth {
  const unplayable: UnplayableCard[] = [];
  let affectedCopies = 0;

  for (const entry of entries) {
    const clauses = unsupportedReason(entry.cardId);
    if (!clauses) continue; // playable, or not an imported card at all
    const card = getCard(entry.cardId);
    const systems = [...new Set(clauses.map((c) => c.missingEngineSystem))];
    unplayable.push({
      cardId: entry.cardId,
      name: card?.name ?? entry.cardId,
      missingSystems: systems,
      count: entry.count,
    });
    affectedCopies += entry.count;
  }

  if (unplayable.length === 0) return HEALTHY;
  unplayable.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  return { playable: false, unplayable, affectedCopies };
}

/**
 * A short badge label for a deck list ("2 cards not playable"), or undefined
 * when the deck is fine and should carry no badge at all.
 */
export function deckHealthBadge(health: DeckHealth): string | undefined {
  if (health.playable) return undefined;
  const n = health.unplayable.length;
  return `${n} card${n === 1 ? '' : 's'} not playable`;
}

/**
 * The full explanation, for a tooltip or a warning panel. Names the cards,
 * because "this deck has unsupported cards" leaves the user hunting through 60
 * lines to find which.
 */
export function describeDeckHealth(health: DeckHealth): string {
  if (health.playable) return 'Every card in this deck is fully playable.';
  const parts = health.unplayable.map(
    (c) => `${c.count}× ${c.name} (needs ${c.missingSystems.join(', ')})`,
  );
  return `This deck is only partly functional — ${health.affectedCopies} card copies can't be played: ${parts.join('; ')}.`;
}

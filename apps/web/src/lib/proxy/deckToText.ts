/**
 * Turn a saved {@link Deck} (cardId + count entries) into a decklist string the
 * Proxies textarea can consume. Card ids resolve to names against the bundled
 * card pool; unknown ids are skipped gracefully.
 */

import type { Deck } from '../deck.js';
import { getCard } from '../cards.js';

/** Render a saved deck as `N Card Name` lines (one per stack). */
export function deckToDecklist(deck: Deck): string {
  const lines: string[] = [];
  for (const entry of deck.cards) {
    const card = getCard(entry.cardId);
    if (!card) continue;
    lines.push(`${entry.count} ${card.name}`);
  }
  return lines.join('\n');
}

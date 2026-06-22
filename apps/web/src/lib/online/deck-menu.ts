/**
 * Build the deck-choice menu (the player's saved decks + the bundled sample decks)
 * shared by the online lobby. Mirrors the hotseat `SetupScreen` menu so a player
 * picks from the SAME set of decks in both modes (DRY of the option list).
 */
import { SAMPLE_DECKS } from '@jonny-boi/sim';
import type { DecksApi } from '../useDecks.js';
import { deckSize } from '../deck.js';
import type { DeckChoice } from '../play/setup.js';

/** A flat menu item combining a label, a stable key, and the resolved choice. */
export interface DeckMenuItem {
  readonly key: string;
  readonly label: string;
  readonly choice: DeckChoice;
}

/** Saved decks (non-empty) first, then the sample gauntlet decks. */
export function buildDeckMenu(decks: DecksApi): DeckMenuItem[] {
  const saved: DeckMenuItem[] = decks.decks
    .filter((d) => deckSize(d) > 0)
    .map((d) => ({
      key: `saved:${d.id}`,
      label: `${d.name} · ${deckSize(d)} cards (yours)`,
      choice: { source: 'saved', deck: d },
    }));
  const samples: DeckMenuItem[] = SAMPLE_DECKS.map((d) => ({
    key: `sample:${d.name}`,
    label: `${d.name} · sample`,
    choice: { source: 'sample', deck: d },
  }));
  return [...saved, ...samples];
}

/**
 * Lookup of the curated pool's hand-authored engine definitions by card name.
 *
 * Import prefers these over anything the Oracle compiler produces: they were
 * written and reviewed against this engine specifically, so where a human and
 * the compiler disagree, the human wins.
 */

import type { CardDefinition } from '@jonny-boi/core';
import { CARD_POOL } from '@jonny-boi/cards';

/** Case- and whitespace-insensitive key, matching the Scryfall name matcher. */
function key(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, ' ');
}

const byName = new Map<string, CardDefinition>(
  CARD_POOL.map((card) => [key(card.name), card]),
);

/** The curated engine definition for a card name, if the pool has one. */
export function poolDefinitionByName(name: string): CardDefinition | undefined {
  return byName.get(key(name));
}

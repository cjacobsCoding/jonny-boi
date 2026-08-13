/**
 * Deck-import resolution: parsed decklist lines → real, playable cards.
 *
 * This is where "import any deck" meets "every card must actually work". For
 * each name we either
 *
 *   1. find it in the curated pool — it already has a hand-authored, reviewed
 *      engine definition, which always wins; or
 *   2. fetch it from Scryfall and run the Oracle compiler over it. A card whose
 *      every printed ability compiles becomes genuinely playable; or
 *   3. report it as BLOCKED, naming the engine systems its text would need; or
 *   4. report it as not found (a typo, or a card Scryfall doesn't know).
 *
 * Nothing is approximated. A blocked card is never quietly imported as a
 * do-nothing body — the UI shows exactly what is missing, because a silently
 * wrong card would poison the A/B verdicts the whole lab exists to produce.
 */

import type { CardDefinition } from '@jonny-boi/core';
import type { UnsupportedClause } from '@jonny-boi/cards';
import { compileCard } from '@jonny-boi/cards';
import type { NormalizedCard, RawScryfallCard } from '@jonny-boi/data-tools/pure';
import { normalizeCard } from '@jonny-boi/data-tools/pure';
import { allCards } from '../cards.js';
import { poolDefinitionByName } from './poolDefinitions.js';
import type { DeckLineEntry, DeckSection } from './parse.js';
import {
  fetchCardCollection,
  normalizeName,
  type CollectionProgress,
  type FetchLike,
} from '../scryfall/collection.js';

/** How an imported line ended up. */
export type ImportStatus =
  /** Already in the curated pool, with its hand-authored definition. */
  | 'pool'
  /** Fetched from Scryfall and fully compiled — genuinely playable. */
  | 'compiled'
  /** Fetched, but its text needs engine systems we do not have yet. */
  | 'blocked'
  /** Scryfall has no card by this name. */
  | 'notFound';

/** One resolved decklist line. */
export interface ResolvedLine {
  readonly name: string;
  readonly qty: number;
  readonly section: DeckSection;
  readonly status: ImportStatus;
  /** Display record (art, cost, type line, Oracle text). Absent when not found. */
  readonly card?: NormalizedCard;
  /** Engine definition — present exactly when the card is playable. */
  readonly definition?: CardDefinition;
  /** What the engine still needs. Present exactly when `status` is `'blocked'`. */
  readonly missing?: readonly UnsupportedClause[];
}

/** The full outcome of resolving a decklist. */
export interface ImportPlan {
  readonly lines: readonly ResolvedLine[];
  readonly deckName?: string;
  /** Copy counts (not distinct names) — what "60 cards" means to a player. */
  readonly counts: {
    readonly total: number;
    readonly playable: number;
    readonly blocked: number;
    readonly notFound: number;
  };
}

/** True when a resolved line can be put in a deck and played. */
export function isPlayable(line: ResolvedLine): boolean {
  return line.status === 'pool' || line.status === 'compiled';
}

/** Index the curated pool's display records by normalized name. */
const poolCardsByName = new Map<string, NormalizedCard>(
  allCards.map((card) => [normalizeName(card.name), card]),
);

/**
 * Resolve parsed decklist entries into an import plan.
 *
 * @param entries Parsed decklist lines (see `./parse.ts`).
 * @param fetchImpl Injected `fetch`, so this is testable with no network.
 * @param options.onProgress Called as Scryfall batches complete, for the UI.
 * @param options.deckName Name to carry onto the created deck.
 */
export async function resolveDecklist(
  entries: readonly DeckLineEntry[],
  fetchImpl: FetchLike,
  options: {
    readonly onProgress?: (progress: CollectionProgress) => void;
    readonly deckName?: string;
  } = {},
): Promise<ImportPlan> {
  // Split into "already curated" and "needs fetching" by name.
  const needsFetch = new Map<string, { name: string; set?: string }>();
  for (const entry of entries) {
    const key = normalizeName(entry.name);
    if (poolCardsByName.has(key) || needsFetch.has(key)) continue;
    needsFetch.set(key, entry.set ? { name: entry.name, set: entry.set } : { name: entry.name });
  }

  const fetched = new Map<string, NormalizedCard>();
  const notFound = new Set<string>();

  if (needsFetch.size > 0) {
    const result = await fetchCardCollection([...needsFetch.values()], fetchImpl, {
      ...(options.onProgress ? { onProgress: options.onProgress } : {}),
    });
    for (const raw of result.cards) {
      const card = normalizeCard(raw as RawScryfallCard);
      fetched.set(normalizeName(card.name), card);
      // A double-faced card is requested by its front-face name but comes back
      // with the combined "Front // Back" name — index both so the line matches.
      const front = card.name.split(' // ')[0];
      if (front) fetched.set(normalizeName(front), card);
    }
    for (const miss of result.notFound) notFound.add(normalizeName(miss));
  }

  // Compile each fetched card once, then reuse across every line naming it.
  const compiled = new Map<string, { definition?: CardDefinition; missing?: readonly UnsupportedClause[] }>();
  for (const [key, card] of fetched) {
    if (compiled.has(key)) continue;
    const result = compileCard(card);
    compiled.set(
      key,
      result.status === 'complete'
        ? { definition: result.definition }
        : { missing: result.missing },
    );
  }

  const lines: ResolvedLine[] = entries.map((entry) => {
    const key = normalizeName(entry.name);

    const poolCard = poolCardsByName.get(key);
    if (poolCard) {
      const definition = poolDefinitionByName(poolCard.name);
      // A pool card always has a hand-authored definition; if one ever went
      // missing we report it rather than silently importing an inert card.
      return definition
        ? { name: entry.name, qty: entry.qty, section: entry.section, status: 'pool', card: poolCard, definition }
        : {
            name: entry.name,
            qty: entry.qty,
            section: entry.section,
            status: 'blocked',
            card: poolCard,
            missing: [{ text: poolCard.name, missingEngineSystem: 'a rules definition for this pool card' }],
          };
    }

    const card = fetched.get(key);
    if (!card) {
      return { name: entry.name, qty: entry.qty, section: entry.section, status: 'notFound' };
    }

    const outcome = compiled.get(key);
    if (outcome?.definition) {
      return {
        name: entry.name,
        qty: entry.qty,
        section: entry.section,
        status: 'compiled',
        card,
        definition: outcome.definition,
      };
    }
    return {
      name: entry.name,
      qty: entry.qty,
      section: entry.section,
      status: 'blocked',
      card,
      missing: outcome?.missing ?? [],
    };
  });

  return {
    lines,
    ...(options.deckName ? { deckName: options.deckName } : {}),
    counts: countCopies(lines),
  };
}

/** Count copies (not distinct names) by outcome. */
function countCopies(lines: readonly ResolvedLine[]): ImportPlan['counts'] {
  let playable = 0;
  let blocked = 0;
  let missing = 0;
  let total = 0;
  for (const line of lines) {
    total += line.qty;
    if (isPlayable(line)) playable += line.qty;
    else if (line.status === 'blocked') blocked += line.qty;
    else missing += line.qty;
  }
  return { total, playable, blocked, notFound: missing };
}

/**
 * Group a plan's blocked cards by the engine system they need — the "what would
 * it take to play this deck" summary, and the project's real to-do list.
 */
export function blockedByEngineSystem(
  plan: ImportPlan,
): Array<{ system: string; cards: string[] }> {
  const bySystem = new Map<string, Set<string>>();
  for (const line of plan.lines) {
    if (line.status !== 'blocked') continue;
    for (const gap of line.missing ?? []) {
      const cards = bySystem.get(gap.missingEngineSystem) ?? new Set<string>();
      cards.add(line.name);
      bySystem.set(gap.missingEngineSystem, cards);
    }
  }
  return [...bySystem.entries()]
    .map(([system, cards]) => ({ system, cards: [...cards].sort() }))
    .sort((a, b) => b.cards.length - a.cards.length || a.system.localeCompare(b.system));
}

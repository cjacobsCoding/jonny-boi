/**
 * DECK HEALTH — is this deck actually playable, and if not, which cards break it?
 *
 * A deck may legally contain cards whose printed text the engine cannot play yet
 * (deck import keeps them on purpose — a pasted list is a real deck, and the card
 * pool holds far more cards than the engine has been taught). That is fine for
 * browsing, editing and proxy printing, and NOT fine to play or simulate without
 * saying so: the deck would quietly behave as if those cards were blanks, and a
 * blank card in an A/B test silently corrupts the verdict.
 *
 * So this is THE answer to "can this deck be played?", and every surface that
 * starts a game asks it — Play, the Lab, the Match viewer and the deck builder
 * badge. They used to answer it three different ways (the sim's raw
 * `unknown card "<uuid>"` in Play; the card's name but not its gap in the Lab;
 * the full story, blocking nothing, in the builder), which is how a deck could be
 * refused by one surface and started by another.
 *
 * The rule is one line: a deck is `unplayable` if ANY card in it fails to resolve
 * to a real engine definition. There is no "mostly fine" — a 59-of-60 deck is
 * still a deck that does not do what it says.
 */

import { unsupportedReason } from './importedCards.js';
import { getCard } from '../cards.js';
import { loadCardPool } from '../sim-pool.js';

/** One card in a deck that the engine cannot play. */
export interface UnplayableCard {
  readonly cardId: string;
  readonly name: string;
  /** The engine systems its text needs, de-duplicated. Empty when unknown. */
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
 * Said of a card that resolves to nothing at all and that nothing can name. Reads
 * as the tail of "needs …", like every `missingEngineSystem` the compiler emits.
 */
const NO_DEFINITION = 'an engine definition — this card has not been taught to the engine yet';

/**
 * WHY A CARD IS UNPLAYABLE — a closed, ordered table. Adding a case is a ROW.
 *
 * Read top to bottom; the first row that answers, answers. `undefined` means
 * "this row has nothing to say, ask the next one", and the last row always
 * answers, so a card can never fall out of the bottom and be assumed fine.
 *
 * ⚠️ The last row is the one that matters most and is the easiest to get wrong.
 * It used to be missing entirely: an id that was in neither the engine pool nor
 * the import store was reported PLAYABLE, on the reasoning that only imported
 * cards can be unsupported. That reasoning expires the moment the browsable pool
 * is bigger than the playable one — which is the whole direction of this project
 * — and it fails in the single most dangerous direction: a deck full of cards the
 * engine has never heard of, reported healthy, played as blanks.
 */
const UNPLAYABLE_REASONS: ReadonlyArray<{
  /** Why this row exists, for the next reader. */
  readonly row: string;
  /** Undefined = no verdict from this row. Null = playable. */
  readonly verdict: (cardId: string) => readonly string[] | null | undefined;
}> = Object.freeze([
  {
    row: 'the engine can resolve it — by id or by name, exactly as the sim does',
    verdict: (cardId) => (resolves(cardId) ? null : undefined),
  },
  {
    row: 'an imported card the compiler could not finish: it knows precisely why',
    verdict: (cardId) => {
      const clauses = unsupportedReason(cardId);
      if (!clauses) return undefined;
      const systems = [...new Set(clauses.map((c) => c.missingEngineSystem))];
      return systems.length > 0 ? systems : [NO_DEFINITION];
    },
  },
  {
    row: 'anything else: no definition, and no account of what is missing',
    verdict: () => [NO_DEFINITION],
  },
]);

/**
 * Does this entry resolve to a real, playable definition?
 *
 * By id THEN by name, because that is what `sim/deck.ts: resolveCard` does and
 * the two must not disagree: saved decks key cards by Scryfall uuid, while the
 * bundled sample and gauntlet decks key them by name. A health check that only
 * knew ids would report every bundled deck unplayable.
 *
 * The pool is the LOCAL play pool — curated cards plus every import that compiled
 * — and it is memoized and rebuilt when the import store changes, so this stays
 * cheap enough to call per card, per render.
 */
function resolves(cardId: string): boolean {
  const pool = loadCardPool();
  return pool.get(cardId) !== undefined || pool.getByName(cardId) !== undefined;
}

/** The card's display name, falling back to the raw id only when nothing knows it. */
function nameOf(cardId: string): string {
  return getCard(cardId)?.name ?? cardId;
}

/** Assess a deck: every card must resolve to an engine definition, or it is out. */
export function assessDeckHealth(entries: readonly DeckHealthEntry[]): DeckHealth {
  const unplayable: UnplayableCard[] = [];
  let affectedCopies = 0;

  for (const entry of entries) {
    const missingSystems = whyUnplayable(entry.cardId);
    if (!missingSystems) continue;
    unplayable.push({
      cardId: entry.cardId,
      name: nameOf(entry.cardId),
      missingSystems,
      count: entry.count,
    });
    affectedCopies += entry.count;
  }

  if (unplayable.length === 0) return HEALTHY;
  unplayable.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  return { playable: false, unplayable, affectedCopies };
}

/**
 * Why one card cannot be played, or `undefined` when it can. The single place
 * that reads {@link UNPLAYABLE_REASONS}, so every caller gets the same verdict.
 */
export function whyUnplayable(cardId: string): readonly string[] | undefined {
  for (const rule of UNPLAYABLE_REASONS) {
    const verdict = rule.verdict(cardId);
    if (verdict === undefined) continue;
    return verdict === null ? undefined : verdict;
  }
  // Unreachable: the last row always answers. Reported rather than assumed.
  return [NO_DEFINITION];
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
 * The full explanation, for a tooltip, a warning panel, or the reason a game
 * refused to start. Names the cards, because "this deck has unsupported cards"
 * leaves the user hunting through 60 lines to find which — and names what each
 * one needs, because the next question is always "what's missing?".
 */
export function describeDeckHealth(health: DeckHealth): string {
  if (health.playable) return 'Every card in this deck is fully playable.';
  const parts = health.unplayable.map(
    (c) => `${c.count}× ${c.name} (needs ${c.missingSystems.join(', ')})`,
  );
  const n = health.unplayable.length;
  const copies = health.affectedCopies;
  return (
    `This deck can’t be played or tested yet — ${n} card${n === 1 ? '' : 's'} ` +
    `(${copies} cop${copies === 1 ? 'y' : 'ies'}) ` +
    `${n === 1 ? 'uses' : 'use'} mechanics the engine doesn’t support: ${parts.join('; ')}. ` +
    `Swap ${n === 1 ? 'it' : 'them'} out to run the deck — everything else about it is fine.`
  );
}

/**
 * The gate, as user-facing lines: empty when the deck may be played or simulated.
 *
 * This is what Play, the Lab and the Match viewer call. It returns the SAME words
 * to all three on purpose — the same deck must not be refused in one place and
 * explained differently in another.
 */
export function deckHealthProblems(entries: readonly DeckHealthEntry[]): string[] {
  const health = assessDeckHealth(entries);
  return health.playable ? [] : [describeDeckHealth(health)];
}

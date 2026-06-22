/**
 * Hotseat game setup: turn two deck selections (a saved web deck OR a bundled
 * sample deck) into a validated, ready-to-play core game. Reuses the sim's
 * `loadDeck`/`validateDeck` (DRY — we do NOT reinvent shuffling/library building)
 * and the `cards` registry so spells resolve.
 *
 * A deck choice is identified by a `DeckChoice`. We resolve it to the sim's `Deck`
 * shape, validate it against the curated pool, and (when both are legal) hand the
 * two libraries to the engine's `createGame`, which shuffles with the seeded RNG
 * and draws opening hands. Illegal decks return structured problems the UI shows as
 * a friendly message — never a thrown stack trace (DESIGN §6 robustness).
 */
import { createGame, type EngineResult } from '@jonny-boi/core';
import { buildRegistry, loadCardPool, type CardPool } from '@jonny-boi/cards';
import { loadDeck, validateDeck, type Deck as SimDeck } from '@jonny-boi/sim';
import type { Deck as WebDeck } from '../deck.js';
import { toSimPayload } from '../sim-format.js';

let cachedPool: CardPool | null = null;

/** The curated pool, memoized; stubbed-mechanic warnings are intentionally silenced. */
export function hotseatPool(): CardPool {
  if (!cachedPool) cachedPool = loadCardPool({ onWarn: () => {} });
  return cachedPool;
}

/** A deck the player picked for a seat: either one of their saved decks or a sample. */
export type DeckChoice =
  | { readonly source: 'saved'; readonly deck: WebDeck }
  | { readonly source: 'sample'; readonly deck: SimDeck };

/** Resolve a deck choice to the sim's `Deck` shape (the loader's input). */
export function toSimDeck(choice: DeckChoice): SimDeck {
  if (choice.source === 'sample') return choice.deck;
  // A saved web deck → sim payload (cardId = Scryfall UUID, resolved by the pool).
  return toSimPayload(choice.deck) as SimDeck;
}

/** The display name of a deck choice. */
export function deckChoiceName(choice: DeckChoice): string {
  return choice.deck.name;
}

/** Validate a deck choice against the curated pool; empty array = legal. */
export function validateChoice(choice: DeckChoice): string[] {
  return validateDeck(toSimDeck(choice), hotseatPool());
}

/** Inputs to start a hotseat game. */
export interface HotseatSetup {
  readonly choiceA: DeckChoice;
  readonly choiceB: DeckChoice;
  readonly seed: number;
  /** Who takes the first turn. */
  readonly startingPlayer: 'A' | 'B';
}

/** A successfully started game plus the registry needed to drive it. */
export interface StartedGame {
  readonly created: EngineResult;
  readonly registry: ReturnType<typeof buildRegistry>;
}

/** A setup failure: which seat(s) had problems and the human-readable reasons. */
export interface SetupProblems {
  readonly a: readonly string[];
  readonly b: readonly string[];
}

/** True when neither seat has any setup problem. */
export function isLegalSetup(problems: SetupProblems): boolean {
  return problems.a.length === 0 && problems.b.length === 0;
}

/** Validate both seats' decks without starting a game. */
export function validateSetup(setup: HotseatSetup): SetupProblems {
  return { a: validateChoice(setup.choiceA), b: validateChoice(setup.choiceB) };
}

/**
 * Build and start the game. Throws nothing on illegal decks: returns either a
 * started game or the structured problems. The registry is fresh per game (no
 * shared global — mirrors `getCardWithRegistry`).
 */
export function startHotseatGame(setup: HotseatSetup): { ok: true; game: StartedGame } | { ok: false; problems: SetupProblems } {
  const problems = validateSetup(setup);
  if (!isLegalSetup(problems)) return { ok: false, problems };

  const pool = hotseatPool();
  const registry = buildRegistry();
  const loadedA = loadDeck(toSimDeck(setup.choiceA), pool);
  const loadedB = loadDeck(toSimDeck(setup.choiceB), pool);

  const created = createGame({
    seed: setup.seed,
    startingPlayer: setup.startingPlayer,
    registry,
    decks: {
      A: { cards: loadedA.library },
      B: { cards: loadedB.library },
    },
  });

  return { ok: true, game: { created, registry } };
}

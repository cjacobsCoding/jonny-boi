/**
 * Hotseat game setup: turn two deck selections (a saved web deck OR a bundled
 * sample deck) into a validated, ready-to-play core game. Reuses the sim's
 * `loadDeck`/`validateDeck` (DRY — we do NOT reinvent shuffling/library building)
 * and the `cards` registry so spells resolve.
 *
 * A deck choice is identified by a `DeckChoice`. We resolve it to the sim's `Deck`
 * shape, validate it against the curated pool PLUS the player's imported cards, and (when both are legal) hand the
 * two libraries to the engine's `createGame`, which shuffles with the seeded RNG
 * and draws opening hands. Illegal decks return structured problems the UI shows as
 * a friendly message — never a thrown stack trace (DESIGN §6 robustness).
 */
import { createGame, type EngineResult } from '@jonny-boi/core';
import { buildRegistry, loadCardPool, type CardPool } from '@jonny-boi/cards';
import { loadDeck, validateDeck, type Deck as SimDeck } from '@jonny-boi/sim';
import type { Deck as WebDeck } from '../deck.js';
import { toSimPayload } from '../sim-format.js';
import { importedCard, importedDefinitions, subscribeToImportedCards } from '../decklist/importedCards.js';

let cachedPool: CardPool | null = null;

/**
 * The pool every LOCAL play path validates and plays from: the curated cards PLUS
 * the player's own imported ones.
 *
 * ⚠️ **The `extraCards` seam existed for exactly this and was never wired up.**
 * `importedDefinitions()`'s own doc says it is "for `loadCardPool({ extraCards })`",
 * and this function passed nothing — so a saved deck holding any scanned or pasted
 * card failed with `unknown card "<uuid>" (not in the pool by id or name)` and the
 * deck could not be played AT ALL. The app imports the card, compiles it, shows it
 * in the browser, puts it in the deck builder, calls it playable in deck health,
 * and then refused to play it. A 60-card scanned deck reported "deck size 52"
 * because eight copies of two imported cards silently failed to resolve.
 *
 * Unplayable imports cannot sneak in: `importedDefinitions()` returns only entries
 * that COMPILED, and `loadCardPool` drops any extra whose id collides with a
 * curated card, so the curated definition always wins.
 *
 * Memoized, and invalidated when the store changes — importing a card mid-session
 * must not require a reload to play it.
 */
export function hotseatPool(): CardPool {
  if (!cachedPool) {
    cachedPool = loadCardPool({ onWarn: () => {}, extraCards: importedDefinitions() });
  }
  return cachedPool;
}

/** Drop the memo so the next `hotseatPool()` sees newly imported cards. */
export function invalidateHotseatPool(): void {
  cachedPool = null;
}

// Subscribed once at module load: the store is a singleton and so is the memo, so
// one subscription keeps them in step for the life of the page.
subscribeToImportedCards(invalidateHotseatPool);

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

/**
 * Validate a deck choice for LOCAL play (Solo, pass-and-play): curated cards plus
 * the player's imported ones. Empty array = legal.
 */
export function validateChoice(choice: DeckChoice): string[] {
  return validateDeck(toSimDeck(choice), hotseatPool());
}

let cachedCuratedPool: CardPool | null = null;

/** The CURATED-ONLY pool — what the game SERVER knows. */
function curatedOnlyPool(): CardPool {
  if (!cachedCuratedPool) cachedCuratedPool = loadCardPool({ onWarn: () => {} });
  return cachedCuratedPool;
}

/**
 * Validate a deck choice for ONLINE play, which is a DIFFERENT question.
 *
 * ⚠️ The server rebuilds every deck from its OWN curated pool and the wire format
 * carries only `{ cardId, count }` — no definitions. So an imported card cannot be
 * played online no matter what this client can do with it, and validating online
 * against the local pool would hand back a FALSE "ready": the lobby would say yes
 * and the server would then refuse the deck with `invalidDeck`, which is a worse
 * failure than saying no here, because it happens later and further away.
 *
 * The message names the CARD rather than echoing a raw UUID at somebody who has no
 * way to look it up — the store knows the name even when the curated pool does not.
 */
export function validateChoiceForOnline(choice: DeckChoice): string[] {
  return validateDeck(toSimDeck(choice), curatedOnlyPool()).map(explainOnlineProblem);
}

/** Rewrite "unknown card <uuid>" as the card's name when we imported it ourselves. */
function explainOnlineProblem(reason: string): string {
  const match = /^unknown card "([^"]+)"/.exec(reason);
  if (!match) return reason;
  const id = match[1] as string;
  const known = importedCard(id);
  if (!known) return reason;
  return `${known.name} is one of your imported cards — online play only supports the built-in card pool, so it can't be used in an online game yet.`;
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

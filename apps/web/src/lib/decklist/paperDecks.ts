/**
 * HIS PAPER DECKS BECOME HIS DECKS — seeded once into the ONE collection, then
 * his outright.
 *
 * ## The design mistake this file undoes
 *
 * He asked for his physical decks to be in the app. They arrived as a second,
 * separate, read-only region called "Your paper decks", sitting above "Your
 * decks", with their own badge, their own origin and their own legality rules.
 * His verdict:
 *
 * > *"yo why is there a 'your paper decks' and 'your decks' - this is dumb. I
 * > just want one collection of decks and I must be able to edit all of them,
 * > regardless of whether scanned in."*
 *
 * He is right, and the rule is general: **how a deck GOT here is not a kind of
 * deck.** Scanned, transcribed, imported, pasted, built card by card — all of
 * them produce a deck he owns and can edit. The only thing that is genuinely a
 * different noun is the BUILT-IN GAUNTLET, which is reference data the Lab
 * measures every verdict against and which he does not own; that line stays
 * exactly where it is, because blurring it is what produced the fork bug
 * (DESIGN §3.35).
 *
 * So there is no `owner` origin any more, no paper region, and nothing here
 * renders. This module does one thing: on a profile that has never been given a
 * particular transcription, it mints that transcription as an ORDINARY saved
 * deck and hands it to `useDecks`. From that moment the deck is indistinguishable
 * from one he built by hand — rename it, edit it, delete it, play it.
 *
 * ## ⚠️ SEEDING IS ADD-ONLY. THAT IS THE WHOLE SAFETY ARGUMENT.
 *
 * Deck storage has already cost this user real decks once: a silent
 * `localStorage` quota failure, plus a `loadDecks` that returned `[]` for both
 * "nothing stored" and "stored but unreadable" and then wrote a starter deck on
 * top of the unreadable blob (`docs/PLAY-HISTORY-AND-STORAGE.md` §1). And this
 * feature's own first revision seeded a 59-card *Acidic Angels* that duplicated
 * a correct 60-card *Acidic Angels* he already owned:
 *
 * > *"You say Acidic Angel deck is gone - but its not and dont scare me like
 * > that - because the correct 60 card version of it was already in my decks."*
 *
 * Therefore, structurally and not by convention:
 *
 *  1. **{@link planSeeding} is pure and returns `[...existing, ...minted]`.** It
 *     has no code path that filters, replaces, renames, merges or reorders an
 *     existing deck — the existing array's elements come out by identity. There
 *     is no "deduplicate" step and there must never be one.
 *  2. **A seed whose NAME he is already using is skipped, and his is left
 *     alone.** Never suffixed, never merged, never replaced. His deck wins, and
 *     the skip is recorded so it does not ask again on the next load.
 *  3. **A seed is attempted at most once per profile.** The ledger is what makes
 *     that true across reloads, and it is written only AFTER the decks
 *     themselves are safely stored — see {@link recordSettledSeeds}.
 *
 * ## Why the ledger, rather than "seed when storage is empty"
 *
 * He has been using the app for weeks, so his storage is not empty and a
 * first-run-only seed would never reach him. And a seed keyed only on "is a deck
 * with this id present?" would RESURRECT a deck he deliberately deleted, which
 * is its own violation of the rule above. The ledger records that a seed has been
 * SETTLED — delivered or deliberately skipped — so deleting a seeded deck makes
 * it stay deleted, exactly like any other deck of his.
 *
 * ## The pool moves under these decks, on purpose
 *
 * A name is unresolved because the compiler does not carry that card YET. So a
 * minted deck records the names it could not resolve (`Deck.unresolved`) and
 * {@link reconcileUnresolved} folds each one into the deck the moment the pool
 * learns it. That resolution runs through `copyGauntletDeck` — the ONE bundled
 * deck → pool funnel — in both directions, so "what is missing" has a single
 * answer (CLAUDE.md rule 12).
 */

import { OWNER_DECK_ENTRIES, type Deck as SimDeck } from '@jonny-boi/sim';
import { copyGauntletDeck } from './gauntletDecks.js';
import { newDeckId, type Deck, type UnresolvedCard } from '../deck.js';
import { SEEDED_DECKS_STORAGE_KEY } from '../config.js';
import { writeStorage } from '../persistence/write.js';

/** Why a seed is not going to be offered again. A closed set — see the ledger. */
export type SeedOutcome =
  /** Minted into his collection as an ordinary deck of his own. */
  | 'seeded'
  /** He already had a deck by that name. His was left exactly as it was. */
  | 'name-in-use';

/** One settled seed, as the ledger stores it. */
export interface SettledSeed {
  readonly id: string;
  readonly outcome: SeedOutcome;
}

/** One transcription the app can seed, with the stable key it is tracked by. */
export interface PaperSeed {
  /**
   * Stable across renames of the DECK, because it is derived from the
   * transcription's path and not from its title. He renaming his copy must not
   * make the app think it was never delivered.
   */
  readonly id: string;
  readonly deck: SimDeck;
  /** Repo-relative path to the `.txt` the list came from, for the record. */
  readonly source: string;
}

/** Turn `docs/decks/thunes-life.txt` into `thunes-life`. */
function seedIdFromSource(source: string): string {
  return source.replace(/^.*\//, '').replace(/\.txt$/i, '');
}

/**
 * Every transcription the app knows how to seed.
 *
 * Derived from the sim registry rather than re-listed, so adding one of his
 * decks stays a single data edit in `packages/sim/data/owner-decks/`
 * (CLAUDE.md rule 2) and cannot be half-done.
 */
export const PAPER_SEEDS: readonly PaperSeed[] = OWNER_DECK_ENTRIES.map((entry) => ({
  id: seedIdFromSource(entry.source),
  deck: entry.deck,
  source: entry.source,
}));

/** Case- and space-insensitive deck-name key, so "  thune's  life" collides. */
function nameKey(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * The deck id a seed mints, stable per profile.
 *
 * Deterministic so that a ledger write that fails (quota, private mode) cannot
 * produce a duplicate on the next load: {@link planSeeding} also refuses to mint
 * an id that is already in the collection. Belt and braces, because the cost of
 * being wrong here is a duplicate of one of his decks.
 */
export function seedDeckId(seed: PaperSeed): string {
  return `paper-${seed.id}`;
}

/**
 * Mint one transcription as a deck of his own.
 *
 * Resolution goes through `copyGauntletDeck`, the one name → pool funnel, and
 * whatever it could not resolve is carried on the deck as {@link
 * Deck.unresolved} rather than dropped — a 49-card deck arriving as 36 cards
 * with no explanation is the failure his own words name.
 *
 * `copiedFrom` is deliberately stripped. It means "this is a copy of the BUILT-IN
 * deck called X", it is what the gauntlet list reads to say *you already copied
 * this*, and one of his decks is not a copy of anything.
 */
export function mintSeedDeck(seed: PaperSeed): Deck {
  const copy = copyGauntletDeck(seed.deck, '');
  const missingCounts = new Map<string, number>();
  for (const entry of seed.deck.cards) {
    if (!copy.unresolved.includes(entry.cardId)) continue;
    missingCounts.set(entry.cardId, (missingCounts.get(entry.cardId) ?? 0) + entry.count);
  }
  const unresolved: UnresolvedCard[] = [...missingCounts].map(([name, count]) => ({ name, count }));
  const deck: Deck = {
    id: seedDeckId(seed),
    name: seed.deck.name,
    cards: copy.deck.cards,
    updatedAt: new Date().toISOString(),
  };
  if (unresolved.length > 0) deck.unresolved = unresolved;
  return deck;
}

/** What one pass of seeding decided. */
export interface SeedPlan {
  /** The collection AFTER seeding: every existing deck, by identity, plus any new ones. */
  readonly decks: Deck[];
  /** Seeds that are now settled and must never be attempted again. */
  readonly settled: SettledSeed[];
  /** True when nothing was added — the caller can skip a write entirely. */
  readonly unchanged: boolean;
}

/**
 * Decide what to seed, without touching anything.
 *
 * ⚠️ Read the return value: `decks` is `[...existing, ...minted]`. Every deck he
 * already had is in the output, in its original order, as the SAME OBJECT. There
 * is no filter, no map and no replace anywhere in this function, and there must
 * never be one — that is the property the guard test asserts by object identity
 * rather than by deep equality, because a `.map()` that returns equal copies
 * would pass a value check while quietly rewriting his collection.
 *
 * @param existing decks already in his collection, as loaded from storage
 * @param settledIds seed ids the ledger says have already been dealt with
 */
export function planSeeding(
  existing: readonly Deck[],
  settledIds: ReadonlySet<string>,
): SeedPlan {
  const minted: Deck[] = [];
  const settled: SettledSeed[] = [];
  const takenNames = new Set(existing.map((deck) => nameKey(deck.name)));
  const takenIds = new Set(existing.map((deck) => deck.id));

  for (const seed of PAPER_SEEDS) {
    if (settledIds.has(seed.id)) continue;
    // The id belt: a ledger write that failed last time leaves the deck present
    // and the seed unsettled, and minting again would duplicate it.
    if (takenIds.has(seedDeckId(seed))) {
      settled.push({ id: seed.id, outcome: 'seeded' });
      continue;
    }
    // ⚠️ HIS NAME WINS. He owns a deck called this; that deck is his data and
    // this function's job is over. Not suffixed to "(paper)", not merged into,
    // not replaced — skipped, and recorded so it is not asked again.
    if (takenNames.has(nameKey(seed.deck.name))) {
      settled.push({ id: seed.id, outcome: 'name-in-use' });
      continue;
    }
    const deck = mintSeedDeck(seed);
    minted.push(deck);
    takenNames.add(nameKey(deck.name));
    takenIds.add(deck.id);
    settled.push({ id: seed.id, outcome: 'seeded' });
  }

  return {
    decks: minted.length === 0 ? [...existing] : [...existing, ...minted],
    settled,
    unchanged: minted.length === 0,
  };
}

/**
 * Fold any card the pool has since learned into the decks waiting for it.
 *
 * Runs over the WHOLE collection because a deck with a wish-list can come from
 * anywhere; a deck without one is returned by identity and is never rewritten.
 *
 * ⚠️ Strictly additive, in both directions: it can add cards to `cards` and
 * remove names from `unresolved`, and it has no path that removes a card or
 * changes a count he set. The resolution itself is `copyGauntletDeck` — the same
 * funnel that produced the wish-list — so a name resolves here exactly when it
 * would have resolved at mint time.
 *
 * Returns the same ARRAY when nothing moved, so a load that changes nothing
 * costs no storage write.
 */
export function reconcileUnresolved(decks: readonly Deck[]): Deck[] {
  let changed = false;
  const next = decks.map((deck) => {
    const wishlist = deck.unresolved ?? [];
    if (wishlist.length === 0) return deck;
    // A throwaway sim deck whose "cards" are the names still wanted, so the one
    // bundled-deck resolver answers this exactly as it answered it at mint time.
    const pending: SimDeck = {
      name: deck.name,
      archetype: '',
      cards: wishlist.map((entry) => ({ cardId: entry.name, count: entry.count })),
    };
    const copy = copyGauntletDeck(pending, '');
    if (copy.deck.cards.length === 0) return deck;

    changed = true;
    const cards = deck.cards.map((entry) => ({ ...entry }));
    for (const found of copy.deck.cards) {
      const existing = cards.find((entry) => entry.cardId === found.cardId);
      // Counts are ADDED rather than replaced: the wish-list says how many the
      // paper deck holds, and anything already in `cards` is a copy he has.
      // The pathological case (more than four in total) is reported by
      // `validateDeck` like any other illegal deck rather than silently capped.
      if (existing) existing.count += found.count;
      else cards.push({ ...found });
    }
    const stillMissing = wishlist.filter((entry) => copy.unresolved.includes(entry.name));
    const updated: Deck = { ...deck, cards, updatedAt: new Date().toISOString() };
    if (stillMissing.length > 0) updated.unresolved = stillMissing;
    else delete updated.unresolved;
    return updated;
  });
  return changed ? next : [...decks];
}

/**
 * Which seeds this profile has already settled.
 *
 * A read that fails or finds nonsense answers "none settled", which is the safe
 * direction: the worst it can do is re-attempt a seed, and both guards in
 * {@link planSeeding} — the stable id and his own deck names — stop that from
 * producing a duplicate.
 */
export function loadSettledSeeds(): Set<string> {
  let raw: string | null;
  try {
    raw = localStorage.getItem(SEEDED_DECKS_STORAGE_KEY);
  } catch {
    return new Set();
  }
  if (!raw) return new Set();
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    const ids = new Set<string>();
    for (const item of parsed) {
      if (typeof item === 'object' && item !== null) {
        const id = (item as Record<string, unknown>).id;
        if (typeof id === 'string' && id) ids.add(id);
      }
    }
    return ids;
  } catch {
    return new Set();
  }
}

/**
 * Record settled seeds, merging with whatever is already there.
 *
 * ⚠️ **Call this only after the decks themselves are safely stored.** If the
 * ledger were written first and the deck write then failed on quota, the seed
 * would be marked delivered and the deck would be gone — the precise shape of
 * the failure that lost him two imported decks. Written second, a failed deck
 * write simply means the next load tries again.
 *
 * `quiet`: a failure here costs him nothing he can see and nothing he could act
 * on — the decks are already saved, and the only consequence is that the next
 * load re-runs a seeding pass that both guards then turn into a no-op. A banner
 * for it would sit next to the deck-save banner it fails alongside.
 */
export function recordSettledSeeds(settled: readonly SettledSeed[]): void {
  if (settled.length === 0) return;
  const byId = new Map<string, SettledSeed>();
  for (const id of loadSettledSeeds()) byId.set(id, { id, outcome: 'seeded' });
  for (const entry of settled) byId.set(entry.id, entry);
  writeStorage(
    'seeded-decks',
    SEEDED_DECKS_STORAGE_KEY,
    JSON.stringify([...byId.values()]),
    { quiet: true },
  );
}

/** A fresh deck id, re-exported so the seeder's callers need only this module. */
export { newDeckId };

/**
 * Deck model + pure deck logic: add/remove with the 4-of rule, grouping by type,
 * the mana curve, validation, and the JSON export/import shape.
 *
 * The export shape is intentionally `{ name, cards: [{ cardId, count }] }` where
 * `cardId` is the **Scryfall UUID** (`NormalizedCard.id`). This is the contract
 * `packages/sim` will consume decks through, so keep it stable.
 */
import type { NormalizedCard } from '@jonny-boi/data-tools';
import { getCard, isBasicLand, primaryType } from './cards.js';
import { isEntryPrinting, type EntryPrinting } from './printings/entryPrinting.js';
import { whyUnplayable } from './decklist/deckHealth.js';
import {
  MAX_COPIES_PER_CARD,
  MIN_DECK_SIZE,
  MANA_CURVE_BUCKETS,
  MANA_CURVE_MAX_BUCKET,
} from './config.js';

/** One stack of identical cards in a deck. */
export interface DeckEntry {
  /** Scryfall UUID of the card (matches `NormalizedCard.id`). */
  cardId: string;
  /** Number of copies in the deck. */
  count: number;
  /**
   * The card's name as it was known WHEN THE ENTRY WAS MADE — a tombstone, not
   * a second source of truth. `cardId` still identifies the card; this is only
   * ever read when that id no longer resolves.
   *
   * A saved deck used to be `{ cardId, count }` and nothing else, so an entry
   * whose id left the pool became unexplainable: the deck refused to start with
   * `unknown card "f413a83d-…"`, and there was no way — for the user OR for us —
   * to learn which card that was. The name is knowable at every point an entry
   * is created (import resolved it, the pool grid was showing it), and throwing
   * it away is what made the failure permanent. Optional because decks saved
   * before this field existed do not have it, and a missing name must degrade to
   * the old message rather than to a lie.
   */
  name?: string;
  /**
   * A non-default Scryfall PRINTING chosen for this slot — art only, never
   * identity. Absent means "the pool's printing", which is what every deck saved
   * before this field existed says, so old decks need no migration.
   *
   * It is art-only on purpose: `cardId` still decides what the card IS, so the
   * sim, the engine and the 4-of rule are all untouched by a printing choice.
   * See `printings/entryPrinting.ts` for why the image URL lives here.
   */
  printing?: EntryPrinting;
}

/**
 * A card the deck is known to contain that the pool CANNOT SUPPLY YET, kept by
 * name because there is no id to keep.
 *
 * `DeckEntry.name` is a tombstone for an id that stopped resolving;
 * this is the opposite case — a card that never resolved in the first place,
 * because the compiler does not carry it. The two are different questions and a
 * single field could not answer both: an unresolved name has no `cardId` at all,
 * so it cannot be a `DeckEntry` without inventing one.
 */
export interface UnresolvedCard {
  /** The card's printed name, as the transcription or decklist spelled it. */
  readonly name: string;
  /** Copies the deck should hold. A 4-of is a bigger hole than a 1-of. */
  readonly count: number;
}

/** A saved deck. `id` is a local UUID; `cardId`s reference the card pool. */
export interface Deck {
  id: string;
  name: string;
  cards: DeckEntry[];
  /** ISO timestamp of the last edit, for sorting the saved-deck list. */
  updatedAt: string;
  /**
   * Cards this deck should hold that the pool could not supply when it was
   * created. Absent on every deck built from the pool by hand — you cannot add a
   * card the app does not have — which is what every deck saved before this
   * field existed says, so old decks need no migration.
   *
   * ⚠️ This is the PERSISTED form of `GauntletCopy.unresolved`, not a second
   * answer to "what is missing" (CLAUDE.md rule 12). It is written once by the
   * one resolver that produces it, and re-read by that same resolver as the pool
   * grows — see `decklist/paperDecks.ts#reconcileUnresolved`, which folds a name
   * into `cards` the moment the compiler learns it.
   *
   * It exists because dropping those names silently is the exact failure Caleb
   * named: *"a deck that resolves to a handful of lands is not a deck."* Without
   * it, a 49-card paper deck would arrive as 36 cards and read as a deck HE had
   * built badly, rather than as a deck the app could not fully supply.
   */
  unresolved?: UnresolvedCard[];
  /**
   * For a deck made by copying a BUILT-IN gauntlet deck: that deck's name.
   * Absent on decks built from scratch or imported, which is what every deck
   * saved before this field existed says — so old decks need no migration.
   *
   * Provenance, not identity: it is never read to decide what the deck IS. It
   * exists so the built-in list can say "you already have a copy of this, it is
   * called X" instead of offering the same "Copy to my decks" button forever.
   * That is the whole reason it is stored rather than derived from the name —
   * the bug that prompted it was a user RENAMING their copy, and a name match
   * would have gone blind at exactly that moment.
   */
  copiedFrom?: string;
}

/**
 * The portable export/import shape (sim-compatible — cardId = Scryfall UUID).
 *
 * `printing` rides along OPTIONALLY: the sim reads `cardId` and `count` and
 * ignores the rest, so carrying it keeps the contract stable while making an
 * export/import round-trip lossless. Dropping it would quietly throw away every
 * art choice in the deck the first time someone copied the JSON.
 */
export interface DeckExport {
  name: string;
  cards: Array<{ cardId: string; count: number; name?: string; printing?: EntryPrinting }>;
}

/** Generate a stable-enough local id for a new deck. */
export function newDeckId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  // Fallback for environments without crypto.randomUUID.
  return `deck-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Create an empty deck with the given name. */
export function createDeck(name: string): Deck {
  return { id: newDeckId(), name, cards: [], updatedAt: new Date().toISOString() };
}

/** Total number of cards across all entries. */
export function deckSize(deck: Deck): number {
  return deck.cards.reduce((sum, entry) => sum + entry.count, 0);
}

/** Find the count of a given card in the deck (0 if absent). */
export function countOf(deck: Deck, cardId: string): number {
  return deck.cards.find((entry) => entry.cardId === cardId)?.count ?? 0;
}

/**
 * The maximum copies allowed for a specific card: unlimited (represented as
 * `Infinity`) for basic lands, otherwise {@link MAX_COPIES_PER_CARD}.
 */
export function maxCopiesFor(card: NormalizedCard): number {
  return isBasicLand(card) ? Number.POSITIVE_INFINITY : MAX_COPIES_PER_CARD;
}

/**
 * Add one copy of a card, respecting the per-card copy limit. Returns a new deck
 * (immutable update); returns the same deck unchanged if at the limit or the
 * card is unknown.
 */
export function addCard(deck: Deck, card: NormalizedCard): Deck {
  const limit = maxCopiesFor(card);
  const current = countOf(deck, card.id);
  if (current >= limit) return deck;
  const existing = deck.cards.find((entry) => entry.cardId === card.id);
  const cards = existing
    ? deck.cards.map((entry) =>
        entry.cardId === card.id ? { ...entry, count: entry.count + 1 } : entry,
      )
    : [...deck.cards, { cardId: card.id, count: 1, name: card.name }];
  return { ...deck, cards, updatedAt: new Date().toISOString() };
}

/**
 * Remove one copy of a card. Returns a new deck; drops the entry entirely when
 * its count hits zero. No-op if the card isn't present.
 */
export function removeCard(deck: Deck, cardId: string): Deck {
  const existing = deck.cards.find((entry) => entry.cardId === cardId);
  if (!existing) return deck;
  const cards =
    existing.count <= 1
      ? deck.cards.filter((entry) => entry.cardId !== cardId)
      : deck.cards.map((entry) =>
          entry.cardId === cardId ? { ...entry, count: entry.count - 1 } : entry,
        );
  return { ...deck, cards, updatedAt: new Date().toISOString() };
}

/**
 * Drop a card the pool cannot supply from the deck's wish-list.
 *
 * Editability has to reach these too. They are the one part of a seeded deck he
 * cannot delete with the ordinary stepper — there is no card in the grid to step
 * down — so without this a transcription error, or a card he has simply decided
 * not to play, would sit in his deck's row forever telling him something is
 * missing that he does not want. *"I must be able to edit all of them."*
 *
 * Returns the same deck unchanged when the name is not on the list, so a
 * double-click cannot bump `updatedAt` on a deck nothing happened to.
 */
export function removeUnresolved(deck: Deck, name: string): Deck {
  const missing = deck.unresolved ?? [];
  const remaining = missing.filter((entry) => entry.name !== name);
  if (remaining.length === missing.length) return deck;
  const next: Deck = { ...deck, updatedAt: new Date().toISOString() };
  if (remaining.length > 0) next.unresolved = remaining;
  // Deleted rather than left as `[]`: an empty array and an absent field mean
  // the same thing, and a deck that stores both shapes makes every reader decide
  // which it is looking at.
  else delete next.unresolved;
  return next;
}

/** A resolved deck entry paired with its card record (skips unknown ids). */
export interface ResolvedEntry {
  card: NormalizedCard;
  count: number;
  /** The slot's chosen printing, when it is not on the pool's default art. */
  printing?: EntryPrinting;
}

/** Resolve a deck's entries to card records, dropping ids not in the pool. */
export function resolveEntries(deck: Deck): ResolvedEntry[] {
  const resolved: ResolvedEntry[] = [];
  for (const entry of deck.cards) {
    const card = getCard(entry.cardId);
    if (!card) continue;
    const item: ResolvedEntry = { card, count: entry.count };
    if (entry.printing) item.printing = entry.printing;
    resolved.push(item);
  }
  return resolved;
}

/** A named group of resolved entries (e.g. all creatures), for the deck list. */
export interface DeckGroup {
  type: string;
  entries: ResolvedEntry[];
  count: number;
}

/** Order groups are displayed in (anything else falls to the end, alpha). */
const GROUP_ORDER = [
  'Creature',
  'Planeswalker',
  'Instant',
  'Sorcery',
  'Artifact',
  'Enchantment',
  'Land',
];

/** Group a deck's resolved entries by primary card type, in a stable order. */
export function groupByType(deck: Deck): DeckGroup[] {
  const buckets = new Map<string, ResolvedEntry[]>();
  for (const resolved of resolveEntries(deck)) {
    const type = primaryType(resolved.card);
    const list = buckets.get(type) ?? [];
    list.push(resolved);
    buckets.set(type, list);
  }
  const groups: DeckGroup[] = [];
  for (const [type, entries] of buckets) {
    entries.sort(
      (a, b) => a.card.cmc - b.card.cmc || a.card.name.localeCompare(b.card.name),
    );
    groups.push({
      type,
      entries,
      count: entries.reduce((sum, e) => sum + e.count, 0),
    });
  }
  groups.sort((a, b) => {
    const ai = GROUP_ORDER.indexOf(a.type);
    const bi = GROUP_ORDER.indexOf(b.type);
    const ar = ai === -1 ? GROUP_ORDER.length : ai;
    const br = bi === -1 ? GROUP_ORDER.length : bi;
    return ar - br || a.type.localeCompare(b.type);
  });
  return groups;
}

/** One bar of the mana curve: a CMC bucket and how many cards fall in it. */
export interface ManaCurveBar {
  /** The bucket's mana value (the top bucket folds in everything above it). */
  bucket: number;
  /** Display label, e.g. "7+" for the top bucket. */
  label: string;
  /** Number of (non-land) cards in this bucket, counting copies. */
  count: number;
}

/**
 * Compute the mana curve: a count of non-land cards per CMC bucket. Lands are
 * excluded because their mana value isn't a meaningful curve point. Everything
 * at or above {@link MANA_CURVE_MAX_BUCKET} folds into the top bar.
 */
export function manaCurve(deck: Deck): ManaCurveBar[] {
  const counts = new Map<number, number>(MANA_CURVE_BUCKETS.map((b) => [b, 0]));
  for (const { card, count } of resolveEntries(deck)) {
    if (card.typeLine.types.includes('Land')) continue;
    const bucket = Math.min(Math.floor(card.cmc), MANA_CURVE_MAX_BUCKET);
    counts.set(bucket, (counts.get(bucket) ?? 0) + count);
  }
  return MANA_CURVE_BUCKETS.map((bucket) => ({
    bucket,
    label: bucket === MANA_CURVE_MAX_BUCKET ? `${bucket}+` : String(bucket),
    count: counts.get(bucket) ?? 0,
  }));
}

/**
 * A validation issue: a human-readable message and how much it blocks.
 *
 * `unsupported` is its own severity because it is neither a rules violation nor
 * a nit: the deck is perfectly legal, it just contains a card our engine cannot
 * play yet. It blocks simulation only, and it names the card and the missing
 * system so the gap is actionable rather than mysterious.
 */
export interface DeckIssue {
  message: string;
  severity: 'error' | 'warning' | 'unsupported';
}

/** Join names for prose: "a", "a and b", "a, b, and c". */
function formatList(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(', ')}, and ${items[items.length - 1]}`;
}

/**
 * What to say about a deck entry whose card id no longer resolves.
 *
 * Never a bare uuid. A deck that will not start is bad; a deck that will not
 * start and cannot tell you WHICH of its sixty cards is at fault is a dead end —
 * the reported symptom was `unknown card "f413a83d-a40d-434c-b20a-4c707c0527fa"`,
 * which no player can act on. When the entry recorded a name we lead with it and
 * keep the id for a bug report. When it did not (a deck saved before
 * `DeckEntry.name` existed), we say the name is unrecoverable rather than
 * pretending, and point at the fix that is actually available: re-import.
 */
export function describeMissingCard(entry: DeckEntry): string {
  const copies = `${entry.count} cop${entry.count === 1 ? 'y' : 'ies'}`;
  return entry.name
    ? `“${entry.name}” (${copies}) isn’t in the card pool — re-import it or swap it out. [id ${entry.cardId}]`
    : `A card in this deck (${copies}) isn’t in the pool, and this deck was saved before names were recorded, so it can only be identified by id ${entry.cardId} — re-import the deck to name it.`;
}

/*
 * ⚠️ `hasUnsupportedCards` and `unsupportedCardNames` used to live here, each
 * asking the import store directly whether a deck was playable. They were the
 * second and third answers to a question `decklist/deckHealth.ts` already owned,
 * and they were the WEAKER answers: they knew only about imported cards, and
 * `unsupportedCardNames` told you which card was holding the deck up but never
 * what it needed. Ask `assessDeckHealth` / `whyUnplayable` / `deckHealthProblems`.
 */

/**
 * Validate a deck against the curated-pool rules: the per-card 4-of limit
 * (basics exempt), the minimum deck size, and whether every card can actually be
 * simulated. Pure; returns a list of issues (empty when the deck is legal).
 *
 * An imported card the engine cannot play yet is reported BY NAME with the
 * system it needs. It is a legal card in a legal deck — you can edit it, print
 * it, and count it — it just blocks the Lab, and you should never have to guess
 * which of your 60 cards is the one holding you up.
 */
export function validateDeck(deck: Deck): DeckIssue[] {
  const issues: DeckIssue[] = [];
  for (const entry of deck.cards) {
    const card = getCard(entry.cardId);
    if (!card) {
      issues.push({ message: describeMissingCard(entry), severity: 'warning' });
      continue;
    }

    // The SAME verdict the play/lab gate uses, so a card cannot be flagged here
    // and quietly accepted there (or the reverse, which is worse).
    const systems = whyUnplayable(entry.cardId);
    if (systems) {
      issues.push({
        message: systems.length
          ? `${card.name} can't be simulated yet — the engine needs ${formatList(systems)}.`
          : `${card.name} can't be simulated yet.`,
        severity: 'unsupported',
      });
    }
    const limit = maxCopiesFor(card);
    if (entry.count > limit) {
      issues.push({
        message: `${card.name}: ${entry.count} copies exceeds the limit of ${limit}.`,
        severity: 'error',
      });
    }
  }
  for (const missing of deck.unresolved ?? []) {
    issues.push({
      message:
        `${missing.count}× ${missing.name} — the card pool doesn’t carry this card yet, ` +
        `so it isn’t in the deck. It will be added automatically when the pool does.`,
      severity: 'warning',
    });
  }
  const size = deckSize(deck);
  if (size < MIN_DECK_SIZE) {
    issues.push({
      message: `Deck has ${size} cards; a Constructed deck needs at least ${MIN_DECK_SIZE}.`,
      severity: 'warning',
    });
  }
  return issues;
}

/** Copies of cards this deck should hold that the pool cannot supply yet. */
export function unresolvedCopies(deck: Deck): number {
  return (deck.unresolved ?? []).reduce((sum, missing) => sum + missing.count, 0);
}

/**
 * ONE SENTENCE SAYING WHAT IS WRONG WITH THIS DECK — or `''` when nothing is.
 *
 * ## Why the deck ROW needs its own sentence
 *
 * `validateDeck` already answers this, but it answers it as a LIST, for the one
 * deck that is open in the builder. The collection is a list of every deck he
 * has, and his complaint about the previous design was that a deck can be short
 * or incomplete without the list saying so — *"a deck that resolves to a handful
 * of lands is not a deck."* So this is the same facts, in a row-sized shape.
 *
 * ⚠️ Not a second source of truth: both this and `validateDeck` read `cards` and
 * `unresolved` and nothing else, and `deck.test.ts` pins that a deck this calls
 * fine has no blocking issue and vice versa. Adding a third thing that can be
 * wrong with a deck means adding it in both, in one edit.
 */
export function describeDeckProblems(deck: Deck): string {
  const parts: string[] = [];
  const missing = deck.unresolved ?? [];
  const size = deckSize(deck);
  if (missing.length > 0) {
    const copies = unresolvedCopies(deck);
    const named = missing.map((m) => `${m.count} ${m.name}`).join(', ');
    parts.push(
      `${size} of ${size + copies} cards — the pool doesn’t carry ` +
        `${missing.length} name${missing.length === 1 ? '' : 's'} yet ` +
        `(${copies} card${copies === 1 ? '' : 's'}): ${named}.`,
    );
  }
  if (size < MIN_DECK_SIZE) {
    // Said even when cards are missing, because they are different problems with
    // different fixes: the pool will supply the first on its own, and only he
    // can fix the second. An earlier version printed only the first, and a deck
    // that would STILL be short at full resolution looked like it was one pool
    // update away from being playable.
    parts.push(`Only ${size} cards — a Constructed deck needs ${MIN_DECK_SIZE}.`);
  }
  return parts.join(' ');
}

/** Convert a deck to its portable export shape (sim-compatible). */
export function toExport(deck: Deck): DeckExport {
  return {
    name: deck.name,
    cards: deck.cards.map((entry) => {
      const exported: DeckExport['cards'][number] = {
        cardId: entry.cardId,
        count: entry.count,
      };
      // Only present when actually chosen, so a deck with no custom art exports
      // byte-for-byte the JSON it always did.
      // The name goes with it: an exported deck is the copy that travels to
      // another machine, and it is exactly the copy most likely to meet a pool
      // that lacks one of its cards.
      if (entry.name) exported.name = entry.name;
      if (entry.printing) exported.printing = entry.printing;
      return exported;
    }),
  };
}

/**
 * Parse a {@link DeckExport} (e.g. pasted/imported JSON) into a fresh Deck.
 * Robust to malformed input: throws a descriptive error rather than producing a
 * corrupt deck, so callers can show a friendly message instead of white-screening.
 */
export function fromExport(data: unknown): Deck {
  if (typeof data !== 'object' || data === null) {
    throw new Error('Deck JSON must be an object.');
  }
  const record = data as Record<string, unknown>;
  const name = typeof record.name === 'string' && record.name.trim() ? record.name : 'Imported Deck';
  if (!Array.isArray(record.cards)) {
    throw new Error('Deck JSON must have a "cards" array.');
  }
  const cards: DeckEntry[] = [];
  for (const raw of record.cards) {
    if (typeof raw !== 'object' || raw === null) continue;
    const entry = raw as Record<string, unknown>;
    const cardId = entry.cardId;
    const count = entry.count;
    if (typeof cardId === 'string' && typeof count === 'number' && count > 0) {
      const parsed: DeckEntry = { cardId, count: Math.floor(count) };
      // Prefer the name the pool knows NOW over the one in the file: the file's
      // is a tombstone for an id we cannot resolve, and if we can resolve it the
      // pool is the better authority. Falling back to the file's is the whole
      // point — that is the case where the id is about to go unexplainable.
      const known = getCard(cardId)?.name;
      const recorded = typeof entry.name === 'string' && entry.name.trim() ? entry.name : undefined;
      const resolvedName = known ?? recorded;
      if (resolvedName) parsed.name = resolvedName;
      // A malformed printing is dropped, not rejected: the deck itself is fine,
      // and losing an art choice must never cost you the import (rule 6).
      if (isEntryPrinting(entry.printing)) parsed.printing = entry.printing;
      cards.push(parsed);
    }
  }
  return { id: newDeckId(), name, cards, updatedAt: new Date().toISOString() };
}

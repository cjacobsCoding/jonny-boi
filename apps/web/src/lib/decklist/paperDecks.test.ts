/**
 * SEEDING MUST NOT BE ABLE TO TOUCH A DECK HE ALREADY HAS.
 *
 * ## The two defects this file stands between
 *
 * 1. **His decks have been lost once already.** A silent `localStorage` quota
 *    failure, plus a `loadDecks` that returned `[]` for both "nothing stored"
 *    and "stored but unreadable" and then wrote a starter deck over the
 *    unreadable blob (`docs/PLAY-HISTORY-AND-STORAGE.md` §1).
 * 2. **A seed duplicated a deck he already owned.** The first revision of this
 *    feature shipped a 59-card *Acidic Angels*. He already had a correct 60-card
 *    *Acidic Angels* — the copy of the built-in *Selesnya Blink* he renamed,
 *    which is what surfaced the fork bug (§3.35). His reaction to hearing it had
 *    been "deleted": *"dont scare me like that - because the correct 60 card
 *    version of it was already in my decks."*
 *
 * ## Why these assertions are about IDENTITY, not equality
 *
 * The dangerous rewrite is the one that looks fine. A `planSeeding` that did
 * `existing.map((d) => ({ ...d }))` would pass every deep-equality check in this
 * file while silently rebuilding his whole collection — and a field-dropping
 * `map` is exactly how `copiedFrom` nearly went missing at the storage boundary.
 * So the add-only property is pinned with `toBe` on the object reference: his
 * deck must come out of the seeder as *the same object* that went in.
 *
 * The other half is the ledger. Idempotence across reloads, a deleted deck
 * staying deleted, and an edit surviving are all one question — "has this seed
 * been settled?" — and each is asserted by running a second pass with the first
 * pass's own output.
 */
import { describe, expect, it } from 'vitest';

import {
  PAPER_SEEDS,
  mintSeedDeck,
  planSeeding,
  reconcileUnresolved,
  seedDeckId,
} from './paperDecks.js';
import { allAvailableCards } from '../cards.js';
import {
  deckSize,
  describeDeckProblems,
  removeUnresolved,
  unresolvedCopies,
  validateDeck,
  type Deck,
} from '../deck.js';
import { MIN_DECK_SIZE } from '../config.js';

/** Ids settled by a plan — what the ledger would hold on the next load. */
function settledIds(settled: readonly { id: string }[]): Set<string> {
  return new Set(settled.map((entry) => entry.id));
}

/** One deck of his own, of a given name and size. */
function hisDeck(name: string, id = `his-${name}`, copies = 60): Deck {
  return {
    id,
    name,
    cards: [{ cardId: 'his-card', count: copies }],
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

/**
 * A card name the pool really carries, read from the pool rather than typed.
 *
 * A hardcoded name would make the reconcile test a hostage of the card
 * campaign: the pool grows and shrinks between waves, and a test that goes red
 * because a card MOVED is a test nobody reads. Split names are skipped because
 * the resolver indexes them under both halves and the assertion here is about
 * the plain case.
 */
const POOL_CARD = allAvailableCards().find((card) => !card.name.includes(' // '))!;

describe('the seeds are the transcriptions, and Acidic Angels is not one', () => {
  it('has at least one seed — the sweep below cannot go vacuous', () => {
    expect(PAPER_SEEDS.length).toBeGreaterThan(0);
  });

  it('does not seed a deck called Acidic Angels', () => {
    // He owns one. Nothing in this app may mint a second.
    expect(PAPER_SEEDS.map((seed) => seed.deck.name)).not.toContain('Acidic Angels');
  });

  it('gives every seed a stable id that does not come from its name', () => {
    // He renames his copy; the ledger must still know it was delivered.
    for (const seed of PAPER_SEEDS) {
      expect(seed.id, seed.source).toMatch(/^[a-z0-9-]+$/);
      expect(seed.id).not.toBe(seed.deck.name);
    }
    expect(new Set(PAPER_SEEDS.map((s) => s.id)).size).toBe(PAPER_SEEDS.length);
  });
});

describe('a minted deck is an ordinary deck of his', () => {
  it('carries no built-in provenance — it is not a copy of anything', () => {
    for (const seed of PAPER_SEEDS) {
      // `copiedFrom` means "a copy of the BUILT-IN called X" and is what the
      // gauntlet list reads to say "you already copied this". One of his decks
      // is not a copy of a reference deck.
      expect(mintSeedDeck(seed).copiedFrom, seed.deck.name).toBeUndefined();
    }
  });

  it('accounts for every transcribed card — resolved plus still-missing', () => {
    for (const seed of PAPER_SEEDS) {
      const deck = mintSeedDeck(seed);
      const transcribed = seed.deck.cards.reduce((sum, entry) => sum + entry.count, 0);
      // Nothing is silently dropped. That is the whole reason `unresolved`
      // exists: "a deck that resolves to a handful of lands is not a deck."
      expect(deckSize(deck) + unresolvedCopies(deck), seed.deck.name).toBe(transcribed);
    }
  });

  it('names what the pool cannot supply, with counts', () => {
    for (const seed of PAPER_SEEDS) {
      const deck = mintSeedDeck(seed);
      for (const missing of deck.unresolved ?? []) {
        expect(missing.name, seed.deck.name).toBeTruthy();
        expect(missing.count, missing.name).toBeGreaterThan(0);
        // The name must be one the transcription actually asked for.
        expect(seed.deck.cards.map((c) => c.cardId)).toContain(missing.name);
      }
    }
  });
});

describe('SEEDING IS ADD-ONLY — his decks come out as the objects that went in', () => {
  it('returns every existing deck by IDENTITY, in order', () => {
    // ⚠️ The load-bearing test of this whole change. `toBe` on the reference,
    // not `toEqual` on the value: a `.map()` that returns equal copies would
    // satisfy a value check while rewriting his entire collection.
    const mine = [hisDeck('Acidic Angels'), hisDeck('Jank Pile'), hisDeck('Mono Red')];
    const plan = planSeeding(mine, new Set());
    for (const [index, deck] of mine.entries()) {
      expect(plan.decks[index], `${deck.name} was rebuilt rather than kept`).toBe(deck);
    }
  });

  it('never removes a deck — the collection only ever grows', () => {
    const mine = [hisDeck('Acidic Angels')];
    const plan = planSeeding(mine, new Set());
    expect(plan.decks.length).toBe(mine.length + PAPER_SEEDS.length);
    expect(plan.decks.map((d) => d.name)).toContain('Acidic Angels');
  });

  it('leaves his 60-card Acidic Angels exactly as it was', () => {
    // Named explicitly because it is the deck he was frightened about. Nothing
    // here collides with it, and the assertion is that nothing NEAR it moved:
    // same object, same name, same size, and exactly one of it.
    const his = hisDeck('Acidic Angels', 'his-acidic', 60);
    const plan = planSeeding([his], new Set());
    const found = plan.decks.filter((d) => d.name === 'Acidic Angels');
    expect(found).toHaveLength(1);
    expect(found[0]).toBe(his);
    expect(deckSize(found[0]!)).toBe(60);
  });
});

describe('a seed whose NAME he already uses is skipped, and his is left alone', () => {
  const seed = PAPER_SEEDS[0]!;

  it('mints nothing for that seed', () => {
    const his = hisDeck(seed.deck.name, 'his-own-copy', 60);
    const plan = planSeeding([his], new Set());
    const sameName = plan.decks.filter((d) => d.name === seed.deck.name);
    // Not suffixed to "(paper)", not merged into, not replaced. One deck, his.
    expect(sameName).toHaveLength(1);
    expect(sameName[0]).toBe(his);
    expect(plan.decks.map((d) => d.id)).not.toContain(seedDeckId(seed));
  });

  it('records the skip so it is not asked again on the next load', () => {
    const his = hisDeck(seed.deck.name, 'his-own-copy', 60);
    const plan = planSeeding([his], new Set());
    expect(plan.settled.find((s) => s.id === seed.id)?.outcome).toBe('name-in-use');
  });

  it('matches his name ignoring case and spacing', () => {
    // He typed it; it will not match byte for byte. A collision check that only
    // caught the exact string would put a near-duplicate next to his deck.
    const sloppy = `  ${seed.deck.name.toUpperCase().replace(/ /g, '   ')}  `;
    const his = hisDeck(sloppy, 'his-own-copy', 60);
    const plan = planSeeding([his], new Set());
    expect(plan.decks.map((d) => d.id)).not.toContain(seedDeckId(seed));
    expect(plan.decks[0]).toBe(his);
  });

  it('still seeds the OTHER transcriptions — one collision is not a veto', () => {
    const his = hisDeck(seed.deck.name, 'his-own-copy', 60);
    const plan = planSeeding([his], new Set());
    for (const other of PAPER_SEEDS.filter((s) => s.id !== seed.id)) {
      expect(plan.decks.map((d) => d.id), other.deck.name).toContain(seedDeckId(other));
    }
  });
});

describe('seeding is idempotent, and survives what he does next', () => {
  it('a second pass with the ledger adds nothing', () => {
    const first = planSeeding([], new Set());
    expect(first.unchanged).toBe(false);
    const second = planSeeding(first.decks, settledIds(first.settled));
    expect(second.unchanged).toBe(true);
    expect(second.decks).toHaveLength(first.decks.length);
    for (const [index, deck] of first.decks.entries()) {
      expect(second.decks[index]).toBe(deck);
    }
  });

  it('AN EDIT HE MAKES SURVIVES the next load', () => {
    const first = planSeeding([], new Set());
    const edited: Deck[] = first.decks.map((deck) => ({
      ...deck,
      name: `${deck.name} (tuned)`,
      cards: [...deck.cards, { cardId: POOL_CARD.id, count: 3, name: POOL_CARD.name }],
      updatedAt: '2026-09-16T00:00:00.000Z',
    }));
    const second = planSeeding(edited, settledIds(first.settled));
    expect(second.unchanged).toBe(true);
    for (const [index, deck] of edited.entries()) {
      // Same object, so the rename and the added cards are untouched.
      expect(second.decks[index]).toBe(deck);
      expect(second.decks[index]!.name).toContain('(tuned)');
    }
  });

  it('A DECK HE DELETED STAYS DELETED', () => {
    // The reason the ledger exists at all. An "is a deck with this id present?"
    // check would resurrect it on the very next load, which is its own way of
    // overriding what he did with his collection.
    const first = planSeeding([], new Set());
    const afterDeletingEverything = planSeeding([], settledIds(first.settled));
    expect(afterDeletingEverything.decks).toHaveLength(0);
    expect(afterDeletingEverything.unchanged).toBe(true);
  });

  it('does not duplicate when the LEDGER write was the thing that failed', () => {
    // Quota, private mode, a cleared key: the deck is on disk and the ledger is
    // not. Without the stable-id belt this mints a second copy every load.
    const first = planSeeding([], new Set());
    const ledgerLost = planSeeding(first.decks, new Set());
    expect(ledgerLost.unchanged).toBe(true);
    expect(ledgerLost.decks).toHaveLength(first.decks.length);
    // …and it repairs the ledger rather than leaving it to happen again.
    expect(ledgerLost.settled.every((s) => s.outcome === 'seeded')).toBe(true);
  });
});

describe('the pool moves under a seeded deck, and only ever upward', () => {
  it('leaves a deck with nothing missing completely alone', () => {
    const plain = hisDeck('Jank Pile');
    const [out] = reconcileUnresolved([plain]);
    expect(out).toBe(plain);
  });

  it('leaves a deck whose cards are STILL missing alone', () => {
    const waiting: Deck = {
      ...hisDeck('Waiting'),
      unresolved: [{ name: 'A Card That Does Not Exist Anywhere', count: 4 }],
    };
    const [out] = reconcileUnresolved([waiting]);
    expect(out).toBe(waiting);
  });

  it('folds in a card the pool has since learned, without losing anything', () => {
    const before: Deck = {
      ...hisDeck('Learning', 'learning', 40),
      unresolved: [
        { name: POOL_CARD.name, count: 3 },
        { name: 'Still Not A Real Card', count: 2 },
      ],
    };
    const [after] = reconcileUnresolved([before]);
    expect(after).not.toBe(before);
    // The card arrived…
    expect(after!.cards.find((e) => e.cardId === POOL_CARD.id)?.count).toBe(3);
    // …the cards he already had are untouched…
    expect(after!.cards.find((e) => e.cardId === 'his-card')?.count).toBe(40);
    // …and what is still missing is still reported, not quietly forgotten.
    expect(after!.unresolved).toEqual([{ name: 'Still Not A Real Card', count: 2 }]);
  });

  it('clears the wish-list entirely once nothing is left on it', () => {
    const before: Deck = {
      ...hisDeck('Completing', 'completing', 57),
      unresolved: [{ name: POOL_CARD.name, count: 3 }],
    };
    const [after] = reconcileUnresolved([before]);
    // Deleted, not left as `[]`: two shapes for one meaning is two readers.
    expect(after!.unresolved).toBeUndefined();
    expect(describeDeckProblems(after!)).toBe('');
  });

  it('returns the same array when nothing moved, so no write is provoked', () => {
    const decks = [hisDeck('A'), hisDeck('B')];
    const out = reconcileUnresolved(decks);
    for (const [index, deck] of decks.entries()) expect(out[index]).toBe(deck);
  });
});

describe('a deck that is not right SAYS SO', () => {
  it('says nothing at all about a deck that is fine', () => {
    expect(describeDeckProblems(hisDeck('Fine', 'fine', MIN_DECK_SIZE))).toBe('');
  });

  it('names the missing cards, with counts, and both totals', () => {
    const short: Deck = {
      ...hisDeck('Short', 'short', 36),
      unresolved: [
        { name: 'Axebane Guardian', count: 4 },
        { name: 'Craterhoof Behemoth', count: 2 },
      ],
    };
    const said = describeDeckProblems(short);
    expect(said).toContain('36 of 42 cards');
    expect(said).toContain('4 Axebane Guardian');
    expect(said).toContain('2 Craterhoof Behemoth');
    // Two names, six cards — different sizes of problem, said as different
    // numbers, because "2 missing" and "6 missing" were once one sentence.
    expect(said).toContain('2 names');
    expect(said).toContain('6 cards');
  });

  it('says short-of-sixty SEPARATELY from missing cards', () => {
    // Different problems with different fixes: the pool supplies the first on
    // its own, and only he can fix the second. Saying only the first made a
    // deck that would still be short at full resolution look one pool update
    // away from playable.
    const short: Deck = {
      ...hisDeck('Still Short', 'still-short', 36),
      unresolved: [{ name: 'Axebane Guardian', count: 4 }],
    };
    expect(describeDeckProblems(short)).toContain(`needs ${MIN_DECK_SIZE}`);
  });

  it('agrees with validateDeck — the two read the same two fields', () => {
    const short: Deck = {
      ...hisDeck('Short', 'short', 36),
      unresolved: [{ name: 'Axebane Guardian', count: 4 }],
    };
    const issues = validateDeck(short).map((i) => i.message).join(' ');
    expect(issues).toContain('Axebane Guardian');
    expect(issues).toContain(String(MIN_DECK_SIZE));
    // …and a deck this calls fine raises no size or wish-list issue either.
    const fine = hisDeck('Fine', 'fine', MIN_DECK_SIZE);
    expect(describeDeckProblems(fine)).toBe('');
    expect(validateDeck(fine).filter((i) => /needs at least|doesn’t carry/.test(i.message))).toEqual(
      [],
    );
  });
});

describe('a missing card is editable too', () => {
  const deck: Deck = {
    ...hisDeck('Editable', 'editable', 36),
    unresolved: [
      { name: 'Axebane Guardian', count: 4 },
      { name: 'Primal Surge', count: 2 },
    ],
  };

  it('can be dropped from the deck', () => {
    const after = removeUnresolved(deck, 'Axebane Guardian');
    expect(after.unresolved).toEqual([{ name: 'Primal Surge', count: 2 }]);
    // It removes the WISH, never a card he has.
    expect(after.cards).toEqual(deck.cards);
  });

  it('drops the field once the last one is gone', () => {
    const empty = removeUnresolved(removeUnresolved(deck, 'Axebane Guardian'), 'Primal Surge');
    expect(empty.unresolved).toBeUndefined();
  });

  it('is a no-op for a name that is not on the list', () => {
    // So a double-click cannot bump `updatedAt` on a deck nothing happened to.
    expect(removeUnresolved(deck, 'Nothing Like This')).toBe(deck);
  });
});

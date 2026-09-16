/**
 * THE OWNER'S DECKS ARE STILL HIS DECKS — and they are still not the gauntlet.
 *
 * ## Why a divergence guard and not just unit tests
 *
 * These three lists exist twice on purpose: as prose transcriptions in
 * `docs/decks/*.txt`, which is where the owner reads and corrects them, and as
 * `Deck` data in `packages/sim/data/owner-decks/`, which is what the app plays.
 * Two places answering one question will eventually answer it differently
 * (CLAUDE.md rule 12), and here the divergence would be invisible: a decklist
 * with a wrong count or a subtly wrong name looks completely normal in a diff.
 *
 * ⚠️ These names have been wrong TWICE, and each time it cost real time — once a
 * whole deck was filed under another deck's name, so "Acidic Angels is complete"
 * was an answer about the wrong deck. That is the class this file closes: the
 * `.txt` is the source of truth and this test re-reads it, so a typo in either
 * copy fails rather than quietly becoming the decklist.
 *
 * ## And the gauntlet stays the gauntlet
 *
 * `SAMPLE_DECKS` IS the §3.8 meta gauntlet every A/B verdict is measured
 * against, and its spread was tuned deliberately. Adding personal decks to it
 * would silently redefine the field every recorded baseline refers to. The
 * disjointness assertions below are the guard that keeps the two registries from
 * being merged by a well-meaning future edit.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { SAMPLE_DECKS } from '../data/decks/index.js';
import {
  OWNER_DECKS,
  OWNER_DECK_ENTRIES,
  ownerDeckRules,
  transcribedSize,
} from '../data/owner-decks/index.js';
import { DEFAULT_DECK_RULES } from './config.js';

/** Repo root, from this file: `packages/sim/src/` → three levels up. */
const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

/**
 * THE THREE DECKS, BY NAME, AND WHAT EACH ONE IS.
 *
 * Spelled out here rather than derived from the registry, because a test that
 * reads the registry to decide what the registry should contain cannot fail when
 * a deck goes missing — which is precisely the failure this pins. The `tell` of
 * each is from `docs/decks/README.md`: a card that appears in that deck and in
 * no other, so a deck filed under the wrong name fails by content and not only
 * by string.
 */
const EXPECTED = Object.freeze([
  Object.freeze({
    name: 'Acidic Angels',
    source: 'docs/decks/acidic-angels.txt',
    names: 16,
    cards: 59,
    tell: ['Acidic Slime', 'Angel of Serenity'],
  }),
  Object.freeze({
    name: "Thune's Life",
    source: 'docs/decks/thunes-life.txt',
    names: 22,
    cards: 65,
    tell: ['Archangel of Thune', 'Soul Warden', 'Rhox Faithmender'],
  }),
  Object.freeze({
    name: 'Tamiyo + Jace Surge',
    source: 'docs/decks/tamiyo-jace-surge.txt',
    names: 17,
    cards: 49,
    tell: ['Tamiyo, the Moon Sage', 'Jace, Architect of Thought'],
  }),
]);

/**
 * Read one transcription into `{ count, name }` lines.
 *
 * ⚠️ Split on `/\r?\n/`, never on `'\n'`. Committed text in this repo is CRLF on
 * disk and LF in git with no `.gitattributes` — a guard that assumes one of them
 * false-alarms on every Windows checkout (CLAUDE.md, "CRLF trap").
 */
function readTranscription(relativePath: string): readonly { count: number; name: string }[] {
  const text = readFileSync(resolve(REPO_ROOT, relativePath), 'utf8');
  const lines: { count: number; name: string }[] = [];
  for (const raw of text.split(/\r?\n/)) {
    // Trailing `// …` notes mark which cards compile; they are annotation, not
    // decklist. A WHOLE-line comment is dropped by the same strip.
    const line = raw.replace(/\/\/.*$/, '').trim();
    if (line === '') continue;
    const match = /^(\d+)\s+(\S.*)$/.exec(line);
    // Anything else in one of these files is a transcription error worth
    // failing on, not a line to skip quietly.
    expect(match, `unparseable line in ${relativePath}: "${raw}"`).not.toBeNull();
    lines.push({ count: Number(match![1]), name: match![2]!.trim() });
  }
  return lines;
}

describe("the owner's decks are registered", () => {
  it('holds all three, by their real names', () => {
    for (const expected of EXPECTED) {
      const deck = OWNER_DECKS.find((d) => d.name === expected.name);
      expect(deck, `"${expected.name}" is missing from OWNER_DECKS`).toBeDefined();
    }
  });

  it('is the deck it says it is, not another deck under the same name', () => {
    // The failure this catches actually happened: the lifegain photo deck was
    // filed as "Acidic Angels" for a day. A name check alone would have passed.
    for (const expected of EXPECTED) {
      const deck = OWNER_DECKS.find((d) => d.name === expected.name)!;
      const names = deck.cards.map((c) => c.cardId);
      for (const tell of expected.tell) {
        expect(names, `${expected.name} must contain ${tell}`).toContain(tell);
      }
    }
  });

  it('is the right size, in names and in cards', () => {
    for (const expected of EXPECTED) {
      const deck = OWNER_DECKS.find((d) => d.name === expected.name)!;
      expect(deck.cards.length, `${expected.name}: distinct names`).toBe(expected.names);
      expect(transcribedSize(deck), `${expected.name}: total cards`).toBe(expected.cards);
    }
  });

  it('names one card per line — no name appears twice in a deck', () => {
    // A duplicated line would double a count without changing the total the
    // eye checks, and `loadDeck` counts copies per CARD, so a 2+2 split would
    // sail past the 4-of check as two legal pairs.
    for (const deck of OWNER_DECKS) {
      const names = deck.cards.map((c) => c.cardId);
      expect(new Set(names).size, `${deck.name} lists a card twice`).toBe(names.length);
    }
  });
});

describe('each list still matches the transcription it came from', () => {
  for (const expected of EXPECTED) {
    it(`${expected.name} matches ${expected.source}`, () => {
      const deck = OWNER_DECKS.find((d) => d.name === expected.name)!;
      const transcribed = readTranscription(expected.source);
      // Compared as a whole rather than card by card: ORDER is part of the
      // transcription (it is the physical reading order of the piles), and a
      // set comparison would let two lines swap places unnoticed.
      expect(deck.cards.map((c) => ({ count: c.count, name: c.cardId }))).toEqual(
        transcribed.map((line) => ({ count: line.count, name: line.name })),
      );
    });
  }

  it('every registry entry declares a source that exists', () => {
    for (const entry of OWNER_DECK_ENTRIES) {
      expect(() => readTranscription(entry.source), entry.deck.name).not.toThrow();
    }
  });
});

describe('the owner decks are NOT the gauntlet', () => {
  it('shares no deck with SAMPLE_DECKS', () => {
    // By identity AND by name. Identity catches an entry appended to the
    // gauntlet array; name catches a copy pasted into it.
    const gauntletNames = new Set(SAMPLE_DECKS.map((d) => d.name));
    for (const deck of OWNER_DECKS) {
      expect(gauntletNames.has(deck.name), `${deck.name} leaked into the gauntlet`).toBe(false);
      expect(SAMPLE_DECKS).not.toContain(deck);
    }
  });

  it('leaves the gauntlet at the size its baselines were recorded against', () => {
    // A gauntlet matchup is seeded by the opponent's INDEX, so a deck added or
    // moved reseeds every row after it. Nine is the number every recorded A/B
    // baseline on this branch refers to.
    expect(SAMPLE_DECKS).toHaveLength(9);
  });
});

describe('paper-deck legality rules', () => {
  it('sets the minimum to the deck it actually is', () => {
    for (const deck of OWNER_DECKS) {
      expect(ownerDeckRules(deck).minDeckSize, deck.name).toBe(transcribedSize(deck));
    }
  });

  it('cannot be gamed into passing a short deck', () => {
    // The minimum is DERIVED from the transcription, never chosen — so it can
    // only ever say "all of it is here", never "this is close enough".
    const acidic = OWNER_DECKS.find((d) => d.name === 'Acidic Angels')!;
    expect(ownerDeckRules(acidic).minDeckSize).toBe(59);
    expect(ownerDeckRules(acidic).minDeckSize).toBeLessThan(DEFAULT_DECK_RULES.minDeckSize);
    // …and a deck that is over the constructed minimum is held to its own,
    // HIGHER, size rather than being let through at 60.
    const thunes = OWNER_DECKS.find((d) => d.name === "Thune's Life")!;
    expect(ownerDeckRules(thunes).minDeckSize).toBeGreaterThan(DEFAULT_DECK_RULES.minDeckSize);
  });

  it('relaxes nothing else', () => {
    for (const deck of OWNER_DECKS) {
      const rules = ownerDeckRules(deck);
      expect(rules.maxCopiesNonBasic).toBe(DEFAULT_DECK_RULES.maxCopiesNonBasic);
      expect(rules.unlimitedCopies).toBe(DEFAULT_DECK_RULES.unlimitedCopies);
    }
  });

  it('the transcriptions themselves respect the 4-of rule', () => {
    for (const deck of OWNER_DECKS) {
      for (const entry of deck.cards) {
        if (DEFAULT_DECK_RULES.unlimitedCopies.has(entry.cardId)) continue;
        expect(entry.count, `${deck.name}: ${entry.cardId}`).toBeLessThanOrEqual(
          DEFAULT_DECK_RULES.maxCopiesNonBasic,
        );
      }
    }
  });
});

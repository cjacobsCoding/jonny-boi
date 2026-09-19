/**
 * THE OWNER'S DECKS ARE STILL HIS DECKS — and they are still not the gauntlet.
 *
 * ## Why a divergence guard and not just unit tests
 *
 * These lists exist twice on purpose: as prose transcriptions in
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
 * ## And ACIDIC ANGELS IS NOT ONE OF THEM
 *
 * It was, for one revision, as a 59-card transcription. Caleb already owned a
 * correct 60-card *Acidic Angels* in the app — the copy of the built-in
 * *Selesnya Blink* he renamed, which is what surfaced the fork bug (§3.35). The
 * seed was a worse duplicate of a deck he already had, and his reaction to being
 * told it had been "deleted" is the reason the guard below is by NAME and
 * unconditional: *"dont scare me like that - because the correct 60 card version
 * of it was already in my decks."* Nothing in this repo may seed that name
 * again. His own copy lives in his browser and no code here can reach it.
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
  applyDeckRevisions,
  currentOwnerDeck,
  transcribedSize,
} from '../data/owner-decks/index.js';
import { DEFAULT_DECK_RULES } from './config.js';
// The PUBLIC surface, as the web app imports it. A namespace import rather than
// a dynamic one inside the test: `await import('./index.js')` pulls in the whole
// package the first time it runs, which took 5 s and blew vitest's default
// timeout whenever this file ran ALONE — a check that goes red for a reason
// unrelated to what it asserts is worse than no check.
import * as simPublicSurface from './index.js';

/** Repo root, from this file: `packages/sim/src/` → three levels up. */
const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

/**
 * THE DECKS, BY NAME, AND WHAT EACH ONE IS.
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
    name: "Thune's Life",
    source: 'docs/decks/thunes-life.txt',
    names: 22,
    cards: 65,
    tell: ['Archangel of Thune', 'Soul Warden', 'Rhox Faithmender'],
    // §3.162 — the six he asked for by name, two of each, as ONE dated revision.
    revisions: [{ id: '2026-09-18-his-six', names: 6, cards: 12 }],
    /** The deck as it stands today: the transcription plus every revision. */
    currentCards: 77,
  }),
  Object.freeze({
    name: 'Tamiyo + Jace Surge',
    source: 'docs/decks/tamiyo-jace-surge.txt',
    names: 17,
    cards: 49,
    tell: ['Tamiyo, the Moon Sage', 'Jace, Architect of Thought'],
    revisions: [],
    currentCards: 49,
  }),
]);

/**
 * Read one transcription into `{ count, name }` lines.
 *
 * ⚠️ Split on `/\r?\n/`, never on `'\n'`. Committed text in this repo is CRLF on
 * disk and LF in git with no `.gitattributes` — a guard that assumes one of them
 * false-alarms on every Windows checkout (CLAUDE.md, "CRLF trap").
 */
interface TranscribedLine {
  readonly count: number;
  readonly name: string;
}

/** A `// revision <id> — <note>` block: the header's id and its `+N Name` lines. */
interface TranscribedRevision {
  readonly id: string;
  readonly adds: TranscribedLine[];
}

interface Transcription {
  /** The plain `N Name` lines — the deck as transcribed. */
  readonly base: TranscribedLine[];
  /** The `// revision` blocks, in file order (§3.162). */
  readonly revisions: TranscribedRevision[];
}

/** Read one transcription into its base lines and its revision blocks. */
function readTranscription(relativePath: string): Transcription {
  return readTranscriptionText(readFileSync(resolve(REPO_ROOT, relativePath), 'utf8'), relativePath);
}

/**
 * ⚠️ Split on `/\r?\n/`, never on `'\n'`. Committed text in this repo is CRLF on
 * disk and LF in git with no `.gitattributes` — a guard that assumes one of them
 * false-alarms on every Windows checkout (CLAUDE.md, "CRLF trap").
 */
function readTranscriptionText(text: string, label: string): Transcription {
  const base: TranscribedLine[] = [];
  const revisions: TranscribedRevision[] = [];
  for (const raw of text.split(/\r?\n/)) {
    // A revision HEADER is the one comment that is data: it opens a block whose
    // "+N Name" lines belong to it. Every other `// …` is annotation and is
    // stripped — trailing notes on a card line and whole-line comments alike.
    const header = /^\/\/\s*revision\s+(\S+)\s+[—-]\s*(.*)$/.exec(raw.trim());
    if (header) {
      revisions.push({ id: header[1]!, adds: [] });
      continue;
    }
    const line = raw.replace(/\/\/.*$/, '').trim();
    if (line === '') continue;
    const add = /^\+(\d+)\s+(\S.*)$/.exec(line);
    if (add) {
      const open = revisions[revisions.length - 1];
      // A "+N" line before any header has no revision to belong to.
      expect(open, `"+N" line outside a revision block in ${label}: "${raw}"`).toBeDefined();
      open!.adds.push({ count: Number(add[1]), name: add[2]!.trim() });
      continue;
    }
    const match = /^(\d+)\s+(\S.*)$/.exec(line);
    // Anything else in one of these files is a transcription error worth
    // failing on, not a line to skip quietly.
    expect(match, `unparseable line in ${label}: "${raw}"`).not.toBeNull();
    // A plain line AFTER a revision block would silently belong to the base
    // list while reading as part of the revision — refused.
    expect(revisions.length, `base line "${raw}" after a revision block in ${label}`).toBe(0);
    base.push({ count: Number(match![1]), name: match![2]!.trim() });
  }
  return { base, revisions };
}

describe("the owner's decks are registered", () => {
  it('holds every one of them, by their real names', () => {
    for (const expected of EXPECTED) {
      const deck = OWNER_DECKS.find((d) => d.name === expected.name);
      expect(deck, `"${expected.name}" is missing from OWNER_DECKS`).toBeDefined();
    }
    // The registry holds EXACTLY these. A test that only checks the expected
    // decks are present cannot fail when an extra one is seeded, and seeding a
    // deck he did not ask for is the defect this whole change exists to undo.
    expect(OWNER_DECKS.map((d) => d.name).sort()).toEqual(
      EXPECTED.map((e) => e.name).slice().sort(),
    );
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
      const entry = OWNER_DECK_ENTRIES.find((e) => e.deck === deck)!;
      expect(transcribedSize(currentOwnerDeck(entry)), `${expected.name}: cards today, revisions in`).toBe(
        expected.currentCards,
      );
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
        transcribed.base.map((line) => ({ count: line.count, name: line.name })),
      );
    });

    it(`${expected.name}'s revisions match the \`// revision\` blocks of ${expected.source}`, () => {
      const entry = OWNER_DECK_ENTRIES.find((e) => e.deck.name === expected.name)!;
      const transcribed = readTranscription(expected.source);
      // Same whole-block comparison: id, order and counts, or the mirror drifted.
      expect(
        entry.revisions.map((r) => ({ id: r.id, adds: r.adds.map((a) => ({ count: a.count, name: a.cardId })) })),
      ).toEqual(transcribed.revisions);
      // And the shape this file's EXPECTED pins, so a revision cannot be added
      // to the .txt and the data without a human writing down what it is.
      expect(
        entry.revisions.map((r) => ({ id: r.id, names: r.adds.length, cards: r.adds.reduce((n, a) => n + a.count, 0) })),
      ).toEqual(expected.revisions);
    });
  }

  it('the revision grammar is read the way the block is written', () => {
    const parsed = readTranscriptionText(
      [
        '// a note',
        '4 Forest // compiles',
        '',
        '// revision 2026-01-01-test — "his words"',
        '+2 Grizzly Bears',
        '+1 Forest',
      ].join('\r\n'),
      'inline',
    );
    expect(parsed.base).toEqual([{ count: 4, name: 'Forest' }]);
    expect(parsed.revisions).toEqual([
      { id: '2026-01-01-test', adds: [{ count: 2, name: 'Grizzly Bears' }, { count: 1, name: 'Forest' }] },
    ]);
  });

  it('every registry entry declares a source that exists', () => {
    for (const entry of OWNER_DECK_ENTRIES) {
      expect(() => readTranscription(entry.source), entry.deck.name).not.toThrow();
    }
  });
});

describe('a revision is ADD-ONLY (§3.162)', () => {
  it('raises counts and appends names, and never lowers, drops or reorders', () => {
    for (const entry of OWNER_DECK_ENTRIES) {
      const before = entry.deck;
      const after = currentOwnerDeck(entry);
      // Every transcribed line is still there, in its place, at least as large.
      before.cards.forEach((line, i) => {
        expect(after.cards[i]?.cardId, `${entry.deck.name}: line ${i} kept in order`).toBe(line.cardId);
        expect(after.cards[i]!.count, `${entry.deck.name}: ${line.cardId} count`).toBeGreaterThanOrEqual(line.count);
      });
      expect(after.cards.length).toBeGreaterThanOrEqual(before.cards.length);
      // The input is not mutated.
      expect(transcribedSize(before)).toBe(EXPECTED.find((e) => e.name === entry.deck.name)!.cards);
      // The additions are exactly the revisions' lines, no more and no less.
      const added = transcribedSize(after) - transcribedSize(before);
      const asked = entry.revisions.reduce((n, r) => n + r.adds.reduce((m, a) => m + a.count, 0), 0);
      expect(added, `${entry.deck.name}: cards added`).toBe(asked);
    }
  });

  it('sums a name the deck already holds rather than listing it twice', () => {
    const revised = applyDeckRevisions(
      { name: 'probe', archetype: '', cards: [{ cardId: 'Forest', count: 3 }] },
      [{ id: 'r', date: '2026-01-01', note: '', adds: [{ cardId: 'Forest', count: 1 }, { cardId: 'Plains', count: 2 }] }],
    );
    expect(revised.cards).toEqual([{ cardId: 'Forest', count: 4 }, { cardId: 'Plains', count: 2 }]);
  });

  it('with no revisions, returns the very same deck', () => {
    const deck = { name: 'probe', archetype: '', cards: [{ cardId: 'Forest', count: 3 }] };
    expect(applyDeckRevisions(deck, [])).toBe(deck);
  });

  it('the revised decks respect the 4-of rule too', () => {
    for (const entry of OWNER_DECK_ENTRIES) {
      for (const line of currentOwnerDeck(entry).cards) {
        if (DEFAULT_DECK_RULES.unlimitedCopies.has(line.cardId)) continue;
        expect(line.count, `${entry.deck.name}: ${line.cardId}`).toBeLessThanOrEqual(DEFAULT_DECK_RULES.maxCopiesNonBasic);
      }
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

describe('a seeded deck gets NO special legality rules', () => {
  it('exports no per-deck rules function at all', () => {
    // `ownerDeckRules` set a deck's legal minimum to its own transcribed size,
    // so a 59-card list could report itself legal. It existed for exactly one
    // deck, and that deck is no longer seeded. Asserted on the PUBLIC surface
    // rather than by reading this module, because the web app imports from the
    // package root and that is the surface a re-add would reappear on.
    const exported = Object.keys(simPublicSurface);
    // Not vacuous: the surface really is loaded and really does carry the decks.
    expect(exported).toContain('OWNER_DECKS');
    expect(exported).not.toContain('ownerDeckRules');
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

  it('is held to the ordinary constructed minimum, and one deck is short of it', () => {
    // Not a defect to fix here, and not something to paper over with a special
    // rule: Tamiyo + Jace Surge is 49 cards as transcribed. It seeds at 49, its
    // row says it is short, and he can now add the eleven himself — which is
    // what "one collection, all editable" bought.
    const short = OWNER_DECKS.filter((d) => transcribedSize(d) < DEFAULT_DECK_RULES.minDeckSize);
    expect(short.map((d) => d.name)).toEqual(['Tamiyo + Jace Surge']);
  });
});

describe('ACIDIC ANGELS IS NOT SEEDED — and must never be again', () => {
  /**
   * ⚠️ Unconditional and by NAME. He owns a correct 60-card *Acidic Angels*
   * already, in his browser, made long before any of this. The seed was a
   * 59-card duplicate of it. Re-adding the name would put a second, worse deck
   * of that name back beside his — and the web seeder additionally refuses any
   * seed whose name he already uses (`paperDecks.ts`), so this is the first of
   * two locks rather than the only one.
   */
  const BANNED = 'Acidic Angels';

  it('is absent from the registry', () => {
    expect(OWNER_DECKS.map((d) => d.name)).not.toContain(BANNED);
    expect(OWNER_DECK_ENTRIES.map((e) => e.source)).not.toContain(
      'docs/decks/acidic-angels.txt',
    );
  });

  it('is absent from the gauntlet too, so nothing else ships that name', () => {
    expect(SAMPLE_DECKS.map((d) => d.name)).not.toContain(BANNED);
  });

  it('no seeded deck carries its tell — a rename would not smuggle it back', () => {
    // Content, not just the label. The deck's tell is Acidic Slime + Angel of
    // Serenity; the same list under another name is still the same duplicate.
    for (const deck of OWNER_DECKS) {
      const names = deck.cards.map((c) => c.cardId);
      const tells = ['Acidic Slime', 'Angel of Serenity'].filter((t) => names.includes(t));
      expect(tells, `${deck.name} looks like ${BANNED}`).not.toHaveLength(2);
    }
  });
});

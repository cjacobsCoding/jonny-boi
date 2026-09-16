/**
 * THE OWNER CAN FIND HIS DECKS, AND THEY TELL HIM THE TRUTH ABOUT THEMSELVES.
 *
 * Three claims, and they fail for three different reasons on purpose:
 *
 *   1. THE DECKS ARE REACHABLE. They are in the builder's list and in the deck
 *      picker every play surface uses. A deck that exists in a registry and not
 *      in a menu cannot be played at all, whatever the engine can do with it —
 *      the exact shape of failure this feature was written to end.
 *   2. A SHORT DECK SAYS SO, AND NAMES THE CARDS. Two of the three reference
 *      cards the compiled pool does not carry yet. Handing back a 26-card
 *      "deck" without saying which 23 cards are missing is the failure his own
 *      words name: *a deck that resolves to a handful of lands is not a deck.*
 *   3. THE COMPLETE ONE IS ACTUALLY PLAYABLE. Not "validates", not "renders" —
 *      `startHotseatGame` returns a started game whose library is his 59 cards.
 *
 * ## Why the numbers are FLOORS and not equalities
 *
 * These lists are 2012–13 Standard and the all-cards campaign adds the families
 * that hold their missing cards one at a time, so every count here moves UPWARD
 * on its own. Pinning equality would turn every card the campaign lands into a
 * red test in a lane that had nothing to do with it. A floor fails on the thing
 * that is actually a regression — a name that stopped resolving — and lets good
 * news through. Acidic Angels is pinned at COMPLETE, which is a floor that
 * happens to also be the ceiling, and so can never drop silently.
 */

import { describe, expect, it } from 'vitest';
import { OWNER_DECKS, type Deck as SimDeck } from '@jonny-boi/sim';
import {
  describeCompleteness,
  describeShortfall,
  isComplete,
  ownerDeckSummaries,
} from './ownerDecks.js';
import { buildDeckMenu, menuItemsOfOrigin } from './deckMenu.js';
import { DECK_ORIGINS } from './deckOrigin.js';
import { startHotseatGame, validateChoice } from '../play/setup.js';
import type { DecksApi } from '../useDecks.js';

/** A `DecksApi` with nothing saved — the app a first-time visitor opens. */
const NO_SAVED_DECKS = { decks: [] } as unknown as DecksApi;

/**
 * WHAT EACH DECK RESOLVED TO WHEN THIS WAS WRITTEN, and where the number is from.
 *
 * Measured on 2026-09-15 against the pool shipped on `main` — 5,651 cards, which
 * is some way behind the compiler (a pool refresh to ~6,900 is in flight on
 * another branch and will raise two of these). Method: `ownerDeckSummaries()`,
 * which resolves through the same `copyGauntletDeck` funnel the app's Copy
 * button uses, so this is the number the user sees and not a proxy for it.
 *
 * `atLeastNames` is a FLOOR. `mustBeComplete` is the stronger claim, and it is
 * true of exactly one deck today.
 */
const RESOLUTION_BASELINE = Object.freeze([
  Object.freeze({
    name: 'Acidic Angels',
    names: 16,
    atLeastNames: 16,
    mustBeComplete: true,
    // The blink deck. 16 of 16 on `main` — this one has been whole for a while,
    // and the app must never ship a state in which it is not.
  }),
  Object.freeze({
    name: "Thune's Life",
    names: 22,
    atLeastNames: 14,
    mustBeComplete: false,
    // 14/22 against the SHIPPED pool. The compiler already handles all 22
    // (docs/decks/README.md), so this becomes 22/22 when the refreshed pool
    // lands — a rise this floor is designed to let through without a red test.
  }),
  Object.freeze({
    name: 'Tamiyo + Jace Surge',
    names: 17,
    atLeastNames: 8,
    mustBeComplete: false,
    // 8/17 against the SHIPPED pool. The known ceiling is 12/17 even after the
    // refresh: Axebane Guardian, Craterhoof Behemoth, Primal Surge and BOTH
    // planeswalkers the deck is named after are still being built.
  }),
]);

function summaryFor(name: string) {
  const found = ownerDeckSummaries().find((s) => s.name === name);
  expect(found, `"${name}" is not in ownerDeckSummaries()`).toBeDefined();
  return found!;
}

function ownerDeck(name: string): SimDeck {
  const found = OWNER_DECKS.find((d) => d.name === name);
  expect(found, `"${name}" is not in OWNER_DECKS`).toBeDefined();
  return found!;
}

describe("the owner's decks are in the app", () => {
  it('lists all three, by their real names', () => {
    const listed = ownerDeckSummaries().map((s) => s.name);
    for (const expected of RESOLUTION_BASELINE) {
      expect(listed, `"${expected.name}" is missing from the builder's list`).toContain(
        expected.name,
      );
    }
  });

  it('offers all three in the deck picker every play surface uses', () => {
    // Being in a registry is not being playable. This is the last link in the
    // chain and the one that was missing: the lists existed, in the repo, as
    // .txt files nothing in the app ever read.
    const paper = menuItemsOfOrigin(buildDeckMenu(NO_SAVED_DECKS), 'owner');
    expect(paper).toHaveLength(OWNER_DECKS.length);
    for (const expected of RESOLUTION_BASELINE) {
      const item = paper.find((i) => i.label.startsWith(expected.name));
      expect(item, `"${expected.name}" cannot be chosen in the lobby`).toBeDefined();
      expect(item!.choice.source).toBe('owner');
      expect(item!.label).toContain(DECK_ORIGINS.owner.labelSuffix);
    }
  });

  it("marks them as PAPER — not as built-in, and not as the user's own", () => {
    // Three kinds of deck now share one panel. The last time two of them were
    // indistinguishable a user filed a bug saying the app had duplicated his
    // deck; the marker has to DISCRIMINATE, so this checks both directions.
    const menu = buildDeckMenu(NO_SAVED_DECKS);
    for (const item of menuItemsOfOrigin(menu, 'owner')) {
      expect(item.origin).toBe('owner');
    }
    const paperNames = new Set(OWNER_DECKS.map((d) => d.name));
    for (const item of menuItemsOfOrigin(menu, 'builtin')) {
      expect(paperNames.has(item.choice.deck.name)).toBe(false);
    }
  });
});

describe('what each deck resolves to', () => {
  for (const expected of RESOLUTION_BASELINE) {
    it(`${expected.name}: at least ${expected.atLeastNames} of ${expected.names} names`, () => {
      const summary = summaryFor(expected.name);
      expect(summary.names).toBe(expected.names);
      // Printed on every run so the number is VISIBLE rather than implied — the
      // whole point of a floor is that movement upward is silent otherwise.
      console.log(
        `  ${expected.name}: ${summary.resolvedNames}/${summary.names} names, ` +
          `${summary.resolvedSize}/${summary.transcribedSize} cards` +
          (summary.missing.length > 0 ? ` — missing ${summary.missing.join(', ')}` : ''),
      );
      expect(
        summary.resolvedNames,
        `${expected.name} resolves FEWER names than it used to — a card stopped ` +
          `resolving, which is a regression, not the pool catching up`,
      ).toBeGreaterThanOrEqual(expected.atLeastNames);
      if (expected.mustBeComplete) {
        expect(summary.missing, `${expected.name} must be complete`).toEqual([]);
      }
    });
  }

  it('Acidic Angels is complete, and stays complete', () => {
    // The one hard pin. It is his first scanned deck, it has been whole for a
    // while, and it is the deck the app must be able to sit down and play.
    const summary = summaryFor('Acidic Angels');
    expect(summary.missing).toEqual([]);
    expect(isComplete(summary)).toBe(true);
    expect(summary.resolvedSize).toBe(summary.transcribedSize);
    expect(summary.resolvedSize).toBe(59);
  });

  it('never claims a deck resolved to more cards than it holds', () => {
    for (const summary of ownerDeckSummaries()) {
      expect(summary.resolvedSize, summary.name).toBeLessThanOrEqual(summary.transcribedSize);
      expect(summary.resolvedNames, summary.name).toBeLessThanOrEqual(summary.names);
    }
  });
});

describe('a short deck says so, and names the cards', () => {
  it('names every missing card, with how many copies it costs', () => {
    const short = ownerDeckSummaries().filter((s) => !isComplete(s));
    // If this is ever empty the assertions below would pass vacuously, and the
    // loudest report in the feature would be untested.
    expect(short.length, 'no owner deck is short — re-point this test').toBeGreaterThan(0);
    for (const summary of short) {
      const sentence = describeShortfall(summary);
      expect(sentence).not.toBe('');
      for (const missing of summary.missing) {
        expect(sentence, `${summary.name} must name ${missing}`).toContain(missing);
      }
      // The SIZE of the hole, not only the list — "nine names" and "23 of its
      // 49 cards" are different sizes of problem and the row conveys the second.
      expect(sentence).toContain(`${summary.resolvedSize} of ${summary.transcribedSize} cards`);
      expect(sentence).toContain('Incomplete');
    }
  });

  it('says nothing alarming about a deck that is whole', () => {
    // The other half: the report has to DISCRIMINATE. A warning on every row
    // trains the eye to skip all of them.
    const summary = summaryFor('Acidic Angels');
    expect(describeShortfall(summary)).toBe('');
    expect(describeCompleteness(summary)).toContain('All 16 cards are in the pool');
  });

  it('refuses to start a short deck, naming what is missing', () => {
    const short = ownerDeckSummaries().find((s) => !isComplete(s))!;
    const problems = validateChoice({ source: 'owner', deck: short.deck });
    expect(problems.length).toBeGreaterThan(0);
    // The setup screen renders these verbatim, so the card names have to be IN
    // them — "deck size 26 is below the minimum" alone would send him looking
    // for a bug in the importer.
    const joined = problems.join(' | ');
    for (const missing of short.missing) {
      const name = missing.replace(/^\d+ /, '');
      expect(joined, `the refusal must name ${name}`).toContain(name);
    }
  });
});

describe('the complete deck can actually be played', () => {
  it('validates as legal at its own 59 cards', () => {
    // 59, not 60. A paper deck has already been built; the question is whether
    // the app can deal out the thing that exists, not whether it could have
    // been built to a constructed floor. See DECK_CHOICE_RULES in play/setup.ts.
    expect(validateChoice({ source: 'owner', deck: ownerDeck('Acidic Angels') })).toEqual([]);
  });

  it('starts a game whose library IS his deck', () => {
    const deck = ownerDeck('Acidic Angels');
    const result = startHotseatGame({
      choiceA: { source: 'owner', deck },
      choiceB: { source: 'owner', deck },
      seed: 1234,
      startingPlayer: 'A',
    });
    expect(result.ok, 'his deck must be able to start a game').toBe(true);
    if (!result.ok) return;
    const state = result.game.created.state;
    // Hand + library together, because the engine has already drawn the opening
    // hand by the time `createGame` returns: counting the library alone would
    // report 52 and look like eight cards had gone missing.
    const dealt = state.players.A.library.length + state.players.A.hand.length;
    expect(dealt).toBe(59);
  });

  it('a deck that is NOT whole cannot start one', () => {
    // The discriminator for the claim above: if `startHotseatGame` accepted
    // anything, "his deck starts a game" would not be a fact about his deck.
    const short = ownerDeckSummaries().find((s) => !isComplete(s))!;
    const result = startHotseatGame({
      choiceA: { source: 'owner', deck: short.deck },
      choiceB: { source: 'owner', deck: ownerDeck('Acidic Angels') },
      seed: 1234,
      startingPlayer: 'A',
    });
    expect(result.ok).toBe(false);
  });
});

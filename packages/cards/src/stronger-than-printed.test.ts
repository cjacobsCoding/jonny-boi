/**
 * NO POOL CARD MAY PLAY STRONGER THAN IT PRINTS.
 *
 * ## The half of the pool rule that was never guarded
 *
 * Every existing guard in this package checks one direction: a card must not
 * play WEAKER than its printed text (`pool-mechanics`, `fidelity`, the round
 * trip). The other direction had no check at all, and it is worth exactly as
 * much: an A/B verdict is corrupted just as badly by a card that is secretly
 * better as by one that is secretly worse, and `'complete'` says nothing about
 * either.
 *
 * The defect that proved it: Scryfall stamps a bare `"Hexproof"` in the keyword
 * list beside `"Hexproof from"`, and the keyword sweep mapped the bare word to
 * `hexproof: true` before any evidence check — which would have put fourteen
 * cards into the pool **untargetable by every opponent spell of every colour**
 * while their printed text only protects them from one. That one was caught by
 * a lane reading the compiler; nothing would have caught the next one.
 *
 * ## What this asserts
 *
 * For every card in the shipped pool, every keyword FLAG it carries must have
 * the corresponding word in the card's own printed Oracle text. A flag with no
 * printed word is the engine being more generous than the card.
 *
 * It reads printed text from the committed index — the same second, independent
 * source `expanded-pool.test.ts` uses to bound what the compiler was allowed to
 * build. Two readings that share code cannot disagree, and a guard that cannot
 * disagree is not a guard.
 *
 * ## What it deliberately does NOT cover
 *
 * Only the flags on `CardDefinition.keywords` — the card's OWN printed
 * abilities. A keyword arriving from a static, an Aura's `attachment.modifies`
 * or a grant is not on this field and is not this test's question: those are
 * printed on the GRANTING card and are checked against its text instead.
 */
import { describe, expect, it } from 'vitest';
import type { CardDefinition } from '@jonny-boi/core';
import { CARD_POOL } from '../data/pool.js';
import CARD_INDEX from '../../data-tools/data/card-index.json' with { type: 'json' };

/**
 * Flag → the words whose presence in the printed text justifies it.
 *
 * A TABLE, and a CLOSED one: a keyword flag with no row here is reported by the
 * coverage test below rather than being waved through, because a flag nobody
 * decided about is exactly how the hexproof defect would have shipped.
 *
 * Several rows carry more than one spelling because the printed wording and the
 * keyword name genuinely differ — "can't be blocked" is how unblockable is
 * printed, and evergreen reminder text is not relied on anywhere.
 */
const PRINTED_EVIDENCE: Readonly<Record<string, readonly string[]>> = Object.freeze({
  flying: ['flying'],
  trample: ['trample'],
  lifelink: ['lifelink'],
  deathtouch: ['deathtouch'],
  hexproof: ['hexproof'],
  shroud: ['shroud'],
  menace: ['menace'],
  vigilance: ['vigilance'],
  reach: ['reach'],
  firstStrike: ['first strike'],
  doubleStrike: ['double strike'],
  indestructible: ['indestructible'],
  defender: ['defender'],
  haste: ['haste'],
  flash: ['flash'],
  intimidate: ['intimidate'],
  skulk: ['skulk'],
  fear: ['fear'],
  shadow: ['shadow'],
  horsemanship: ['horsemanship'],
  infect: ['infect'],
  wither: ['wither'],
  myriad: ['myriad'],
  flanking: ['flanking'],
  splitSecond: ['split second'],
  // --- the rows printed as a SENTENCE, never as a keyword ---------------------
  // Each spelling here was read off the cards that carry the flag, not guessed:
  // a row invented from a remembered wording matches no real card and makes the
  // sweep silently vacuous for that flag, which is §3.57's dead rule exactly.
  unblockable: ["can't be blocked", 'cannot be blocked'],
  doesNotUntap: ["doesn't untap", 'does not untap'],
  mustAttack: ['attacks each combat if able', 'attacks each turn if able'],
  cantBlock: ["can't block"],
  blockedByAllAble: ['all creatures able to block', 'must be blocked by all'],
  mustBeBlocked: ['must be blocked', 'is blocked by'],
});

/**
 * Printed text for a pool card, reachable by EVERY name the card goes by.
 *
 * ⚠️ BOTH FACES, and the front-face name as well as the combined one. The index
 * files a two-faced card under "Barkchannel Pathway // Tidechannel Pathway"
 * while the pool stores the FRONT half, so a lookup that knows only one of them
 * reports "no printed text" for every modal DFC in the pool — 56 cards when
 * this was written. A sweep that silently skips 56 cards is the kind of missing
 * denominator this repo has been bitten by, which is why the coverage test
 * below asserts NOT-CHECKED is zero rather than trusting it.
 */
const PRINTED_BY_NAME = new Map<string, string>();
for (const card of (
  CARD_INDEX as {
    cards: { name: string; oracleText?: string; faces?: { name?: string; oracleText?: string }[] }[];
  }
).cards) {
  // An EMPTY string is a real answer, not a missing one: a vanilla creature
  // prints no text, and a vanilla creature carrying `flying: true` is precisely
  // the defect this file exists for. Skipping empties would exempt 343 cards.
  const whole = [card.oracleText, ...(card.faces ?? []).map((f) => f.oracleText)]
    .filter((t): t is string => typeof t === 'string')
    .join(' | ')
    .toLowerCase();
  if (!PRINTED_BY_NAME.has(card.name)) PRINTED_BY_NAME.set(card.name, whole);
  for (const face of card.faces ?? []) {
    if (face.name !== undefined && !PRINTED_BY_NAME.has(face.name)) {
      PRINTED_BY_NAME.set(face.name, whole);
    }
  }
}

interface Overreach {
  readonly card: string;
  readonly flag: string;
}

/** Every flag `def` carries that its printed `text` does not justify. */
function overreachesIn(def: CardDefinition, text: string): Overreach[] {
  const found: Overreach[] = [];
  for (const [flag, value] of Object.entries(def.keywords ?? {})) {
    if (value !== true) continue;
    const evidence = PRINTED_EVIDENCE[flag];
    if (evidence === undefined) continue; // reported by the coverage test instead
    if (!evidence.some((word) => text.includes(word))) found.push({ card: def.name, flag });
  }
  return found;
}

describe('no pool card plays stronger than it prints', () => {
  it('every pool card’s printed text is reachable — NOT CHECKED is not PASS', () => {
    const unreachable = CARD_POOL.filter((c) => PRINTED_BY_NAME.get(c.name) === undefined);
    expect(CARD_POOL.length, 'the pool is empty — nothing below means anything').toBeGreaterThan(0);
    expect(
      unreachable.map((c) => c.name),
      'these pool cards have no printed text under any of their names, so the sweep below never ' +
        'looked at them. Reach them (both faces, front name AND combined name) rather than ' +
        'letting the denominator shrink silently.',
    ).toEqual([]);
  });

  it('no card carries a keyword flag its printed text does not print', () => {
    const overreach = CARD_POOL.flatMap((def) => {
      const text = PRINTED_BY_NAME.get(def.name);
      return text === undefined ? [] : overreachesIn(def, text);
    });
    expect(
      overreach.map((o) => `${o.card} carries ${o.flag}, which its printed text never prints`),
      'A card that plays STRONGER than printed corrupts an A/B verdict exactly as much as one ' +
        'playing weaker, and nothing else in this package checks that direction. The defect this ' +
        'guards: Scryfall stamps a bare "Hexproof" beside "Hexproof from", and mapping the bare ' +
        'word to hexproof: true would have made 14 cards untargetable by every opponent spell of ' +
        'every colour. Narrow the compiled flag — never widen the table to match it.',
    ).toEqual([]);
  });

  it('every keyword flag the pool actually uses has a row in the evidence table', () => {
    // The table is CLOSED: a flag with no row is waved through by the sweep
    // above, so it must be reported HERE rather than passing unnoticed.
    const used = new Set<string>();
    for (const def of CARD_POOL) {
      for (const [flag, value] of Object.entries(def.keywords ?? {})) {
        if (value === true) used.add(flag);
      }
    }
    expect(used.size, 'no pool card carries any keyword flag — the sweep would be vacuous').toBeGreaterThan(5);
    const unrowed = [...used].filter((flag) => PRINTED_EVIDENCE[flag] === undefined);
    expect(
      unrowed,
      'these keyword flags are carried by pool cards but have no printed-evidence row, so nothing ' +
        'checks them for overreach. Add a row naming the printed wording that justifies the flag.',
    ).toEqual([]);
  });

  it('the sweep actually catches an overreaching card — watch it go red', () => {
    // Without this, a matcher broken into never matching anything would report
    // a clean pool forever. Two synthetic cards: one lies, one does not.
    const liar = { name: 'Vanilla Bear', keywords: { flying: true } } as unknown as CardDefinition;
    expect(overreachesIn(liar, '')).toEqual([{ card: 'Vanilla Bear', flag: 'flying' }]);

    const honest = { name: 'Real Flier', keywords: { flying: true } } as unknown as CardDefinition;
    expect(overreachesIn(honest, 'flying')).toEqual([]);

    // And the printed-as-a-sentence rows are matched on the sentence.
    const sneaky = { name: 'Fake Ninja', keywords: { unblockable: true } } as unknown as CardDefinition;
    expect(overreachesIn(sneaky, 'whenever this creature attacks')).toEqual([
      { card: 'Fake Ninja', flag: 'unblockable' },
    ]);
    expect(overreachesIn(sneaky, "this creature can't be blocked.")).toEqual([]);
  });
});

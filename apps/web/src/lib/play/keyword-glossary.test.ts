/**
 * THE GUARDS THAT KEEP THE GLOSSARY HONEST AS THE ENGINE AND THE POOL GROW.
 *
 * A glossary is the kind of table that rots invisibly: core gains a keyword, the
 * pool gains a mechanic, and the only symptom is a hover that shows nothing —
 * which looks exactly like a hover the player did not trigger. So the row list
 * is not asserted from memory here; it is RE-DERIVED from the two sources it was
 * built from, the same way `compile/rule-coverage.test.ts` re-derives its
 * coverage rather than trusting a list:
 *
 *  - `packages/core/src/card.ts` — every key of `interface KeywordFlags`;
 *  - `packages/core/src/conformance/rules-manifest.ts` — `KEYWORD_RULES`, so a
 *    CR citation here cannot fork from the one the conformance suite enforces;
 *  - `apps/web/src/data/card-index.json` — every keyword the pool actually
 *    prints. No card count is written down here: this file used to say
 *    "5,651-card pool" long after the refresh took it past 6,900, which is the
 *    stale-comment defect CLAUDE.md calls a bug with a blast radius. The size is
 *    asserted from the JSON instead.
 *
 * CRLF trap (CLAUDE.md): these files are CRLF on a Windows checkout and LF in
 * git, so every read normalises newlines before matching.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  GLOSSARY_AFFIX_RULES,
  GLOSSARY_TERM_KINDS,
  KEYWORD_FLAG_GLOSSARY,
  KEYWORD_GLOSSARY,
  POOL_TERMS_WITHOUT_GLOSSARY,
  glossaryEntry,
  glossaryForFlag,
  normalizeGlossaryTerm,
  unexplainedPoolTerms,
  type GlossaryKey,
} from './keyword-glossary.js';

/** Read a repo file relative to THIS file, newline- and comment-agnostic. */
function readSource(relativePath: string): string {
  const raw = readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), 'utf8');
  // Comments go too, so a keyword named only in prose can never satisfy an
  // assertion about the code.
  return raw.replace(/\r\n/gu, '\n').replace(/\/\*[\s\S]*?\*\//gu, '');
}

/** The body of a top-level `{ … }` block introduced by `opener`. */
function blockBody(source: string, opener: string): string {
  const start = source.indexOf(opener);
  expect(start, `could not find "${opener}" — did the source move?`).toBeGreaterThanOrEqual(0);
  const from = start + opener.length;
  const end = source.indexOf('\n}', from);
  expect(end, `could not find the end of "${opener}"`).toBeGreaterThan(from);
  return source.slice(from, end);
}

const CORE_CARD_TS = readSource('../../../../../packages/core/src/card.ts');
const CORE_MANIFEST_TS = readSource(
  '../../../../../packages/core/src/conformance/rules-manifest.ts',
);

/** Every key of `interface KeywordFlags`, re-derived from core's source. */
const ENGINE_KEYWORD_FLAGS: readonly string[] = [
  ...blockBody(CORE_CARD_TS, 'export interface KeywordFlags {').matchAll(
    /^ {2}readonly (\w+)\?:/gmu,
  ),
].map((match) => match[1] as string);

/** `KEYWORD_RULES`, re-derived from the conformance manifest's source. */
const ENGINE_KEYWORD_RULES: ReadonlyMap<string, string> = new Map(
  [
    ...blockBody(CORE_MANIFEST_TS, 'export const KEYWORD_RULES: KeywordRules = {').matchAll(
      /^ {2}(\w+): '([^']+)'/gmu,
    ),
  ].map((match) => [match[1] as string, match[2] as string]),
);

interface CardIndexEntry {
  readonly keywords?: readonly string[];
}
const CARD_INDEX = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../data/card-index.json', import.meta.url)), 'utf8'),
) as { readonly cards: Readonly<Record<string, CardIndexEntry>> };

/** Every distinct keyword the pool prints, as Scryfall reports it. */
const POOL_KEYWORDS: readonly string[] = [
  ...new Set(Object.values(CARD_INDEX.cards).flatMap((card) => card.keywords ?? [])),
].sort();

describe('the engine vocabulary is covered — no keyword can ship without words', () => {
  it('re-derived both sources, and they are not empty (the parse itself works)', () => {
    // If a refactor moved either block, every assertion below would vacuously
    // pass. Pin the parse first.
    expect(ENGINE_KEYWORD_FLAGS.length).toBeGreaterThan(30);
    expect(ENGINE_KEYWORD_RULES.size).toBe(ENGINE_KEYWORD_FLAGS.length);
    expect(POOL_KEYWORDS.length).toBeGreaterThan(50);
  });

  it('every KeywordFlags key core declares has a glossary row', () => {
    const covered = new Set(Object.keys(KEYWORD_FLAG_GLOSSARY));
    const missing = ENGINE_KEYWORD_FLAGS.filter((flag) => !covered.has(flag));
    expect(missing, 'core gained a keyword; give it a glossary row').toEqual([]);
  });

  it('no glossary row claims a KeywordFlags key core does not declare', () => {
    const declared = new Set(ENGINE_KEYWORD_FLAGS);
    const stale = Object.keys(KEYWORD_FLAG_GLOSSARY).filter((flag) => !declared.has(flag));
    expect(stale, 'core dropped a keyword; drop its row too').toEqual([]);
  });

  it('every flag maps to a row that exists, and glossaryForFlag is total', () => {
    for (const flag of ENGINE_KEYWORD_FLAGS) {
      const key = KEYWORD_FLAG_GLOSSARY[flag as keyof typeof KEYWORD_FLAG_GLOSSARY];
      expect(KEYWORD_GLOSSARY[key], `${flag} → ${key}`).toBeDefined();
      const entry = glossaryForFlag(flag as keyof typeof KEYWORD_FLAG_GLOSSARY);
      expect(entry.text.length, `${flag} has an empty explanation`).toBeGreaterThan(20);
    }
  });
});

describe('CR citations cannot fork from the conformance manifest', () => {
  it('a row that names a flag cites exactly the rule KEYWORD_RULES names', () => {
    const divergent: string[] = [];
    for (const [key, entry] of Object.entries(KEYWORD_GLOSSARY)) {
      if (entry.flag === undefined || entry.rule === undefined) continue;
      // Several flags legitimately share one row (fear/intimidate/skulk are all
      // `blockRestriction`); only a row whose OWN key is the flag's mapped row
      // is claiming to be that flag's citation.
      if (KEYWORD_FLAG_GLOSSARY[entry.flag] !== key) continue;
      const expected = ENGINE_KEYWORD_RULES.get(entry.flag);
      if (entry.rule !== expected) divergent.push(`${key}: ${entry.rule} vs manifest ${expected}`);
    }
    expect(divergent).toEqual([]);
  });

  it('a row with no engine flag cites no rule number at all', () => {
    // The citation discipline stated in the module doc: this repo has already
    // corrected 24 wrong CR references, and its own surviving prose cites for
    // CR 701 contradict each other. A row we cannot source from the enforced
    // table carries no number rather than a guessed one.
    const guessed = Object.entries(KEYWORD_GLOSSARY)
      .filter(([, entry]) => entry.flag === undefined && entry.rule !== undefined)
      .map(([key]) => key);
    expect(guessed).toEqual([]);
  });
});

describe('the pool is covered — every printed keyword resolves or is a declared gap', () => {
  it('resolves every keyword the pool prints', () => {
    // No card count in the title on purpose: it was "5,651-card" here while the
    // pool held 6,944, which is the same stale-number defect CLAUDE.md warns
    // about. The size is asserted below, from the JSON.
    const unexplained = unexplainedPoolTerms(POOL_KEYWORDS);
    expect(unexplained, 'the pool prints a keyword with no glossary row').toEqual([]);
  });

  it('re-derived the pool from the index, so the assertion above is not vacuous', () => {
    expect(Object.keys(CARD_INDEX.cards).length).toBeGreaterThan(5000);
    expect(POOL_KEYWORDS.length).toBeGreaterThan(100);
  });

  it('every declared gap is still a term the pool actually prints', () => {
    // A gap list that outlives its reason reads like a known limitation and is
    // really just stale. This fails when a card leaves the pool.
    const printed = new Set(POOL_KEYWORDS);
    const stale = Object.keys(POOL_TERMS_WITHOUT_GLOSSARY).filter((term) => !printed.has(term));
    expect(stale).toEqual([]);
  });

  it('every declared gap states a reason', () => {
    for (const [term, reason] of Object.entries(POOL_TERMS_WITHOUT_GLOSSARY)) {
      expect(reason.length, `${term} is excluded with no reason`).toBeGreaterThan(40);
    }
  });
});

describe('the guard fires where the pool actually changes, not only here', () => {
  // The 44-term gap did not get through because nobody wrote the assertion above
  // — it was written, and it passed for weeks, then failed on a branch belonging
  // to someone who had not touched the pool. What was missing was a check at the
  // moment of the edit. These two tests pin that wiring so it cannot be removed
  // silently; without them "it fires sooner" is a sentence in a commit message.

  it('the card-index generator runs the coverage gate', () => {
    const generator = readSource('../../../scripts/build-card-index.mjs');
    expect(
      generator,
      'build-card-index.mjs no longer calls the glossary gate — a pool refresh can lose tooltips silently again',
    ).toContain('check-glossary-coverage.mjs');
  });

  it('the gate and this test give the SAME answer, over the same table', async () => {
    // One answer to one question (rule 12). The gate strips the TypeScript and
    // calls the real `unexplainedPoolTerms`; if it ever answered from its own
    // copy of the rules, or from a different card index, this is where the fork
    // shows up.
    const { checkGlossaryCoverage } = await import('../../../scripts/check-glossary-coverage.mjs');
    const result = await checkGlossaryCoverage();
    expect(result.printedTermCount).toBe(POOL_KEYWORDS.length);
    expect(result.unexplained).toEqual(unexplainedPoolTerms(POOL_KEYWORDS));
  });
});

describe('normalizeGlossaryTerm — one normaliser for both vocabularies', () => {
  it('folds rules-text spelling and engine flag spelling onto one key', () => {
    expect(normalizeGlossaryTerm('First strike')).toBe(normalizeGlossaryTerm('firstStrike'));
    expect(normalizeGlossaryTerm('FIRST STRIKE')).toBe(normalizeGlossaryTerm('firstStrike'));
    expect(normalizeGlossaryTerm('Split second')).toBe(normalizeGlossaryTerm('splitSecond'));
    expect(normalizeGlossaryTerm('Living weapon')).toBe(normalizeGlossaryTerm('livingWeapon'));
    expect(normalizeGlossaryTerm('Cumulative upkeep')).toBe(
      normalizeGlossaryTerm('cumulativeUpkeep'),
    );
  });

  it('strips a cost or a value so "Ward {2}" and "Toxic 1" reach their rows', () => {
    // A GENERIC cost is the easy half. The coloured half is the one that bit:
    // "Cycling {1}{U}" stripped symbol-by-symbol leaves "cycling1u", and no
    // amount of trailing-digit removal recovers it, because the coloured pip is
    // last. Every shape of printed cost is checked here for that reason.
    expect(normalizeGlossaryTerm('Ward {2}')).toBe('ward');
    expect(normalizeGlossaryTerm('Cycling {1}{U}')).toBe('cycling');
    expect(normalizeGlossaryTerm('Flashback {3}{U}{U}')).toBe('flashback');
    expect(normalizeGlossaryTerm('Equip {3}')).toBe('equip');
    expect(normalizeGlossaryTerm('Kicker {2}{R}')).toBe('kicker');
    expect(normalizeGlossaryTerm('Buyback {X}')).toBe('buyback');
    expect(normalizeGlossaryTerm('Cumulative upkeep {1}{W}')).toBe('cumulativeupkeep');
    // Values printed with no braces at all.
    expect(normalizeGlossaryTerm('Toxic 1')).toBe('toxic');
    expect(normalizeGlossaryTerm('Bushido 1')).toBe('bushido');
    expect(normalizeGlossaryTerm('Soulshift 3')).toBe('soulshift');
    expect(normalizeGlossaryTerm('Vanishing 3')).toBe('vanishing');
  });

  it('a printed cost, of any shape, still reaches the row', () => {
    // The fold above is only useful if it lands on a row. This is the same
    // class, asserted at the seam the UI actually calls.
    for (const printed of [
      'Cycling {1}{U}',
      'Flashback {3}{U}{U}',
      'Equip {3}',
      'Ward {2}',
      'Kicker {2}{R}',
      'Vanishing 3',
      'Bushido 1',
    ]) {
      expect(glossaryEntry(printed), printed).toBeDefined();
    }
  });

  it('cuts reminder text and the ability-word dash', () => {
    expect(normalizeGlossaryTerm('Changeling (This card is every creature type.)')).toBe(
      'changeling',
    );
    expect(normalizeGlossaryTerm('Landfall — Whenever a land enters')).toBe('landfall');
  });

  it('collapses to empty for input with no letters, which resolves to nothing', () => {
    expect(normalizeGlossaryTerm('   ')).toBe('');
    expect(glossaryEntry('   ')).toBeUndefined();
    expect(glossaryEntry('')).toBeUndefined();
  });
});

/**
 * Words that must resolve to NOTHING, tabulated by WHY — and the why is
 * load-bearing, not decoration.
 *
 *  - `'typo'` — a spelling one letter from a real row, or a bare fragment. It
 *    proves the lookup does not fuzzy-match, and it is safe forever, because no
 *    card prints it.
 *  - `'unprinted'` — a REAL Magic keyword with no row. This kind is only honest
 *    while the pool does not print the word. The day it does, the coverage guard
 *    above demands a row and this one demands there be none, and the two
 *    contradict.
 *
 * ⚠️ That contradiction is not hypothetical: `'storm'` sat in this list as an
 * unmodelled keyword until the pool refresh brought in 15 cards printing Storm.
 * Only the coverage guard failed; this one stayed green while asserting the
 * opposite thing. So every `'unprinted'` row is now ALSO asserted to be absent
 * from the pool — the collision fails here, by name, the first time a refresh
 * creates it, instead of being settled by whichever test someone edited first.
 */
const MUST_NOT_RESOLVE = [
  { term: 'vigilant', kind: 'typo' },
  { term: 'flyin', kind: 'typo' },
  { term: 'firs strike', kind: 'typo' },
  { term: 'deathtouched', kind: 'typo' },
  { term: 'walk', kind: 'typo' },
  { term: 'cycl', kind: 'typo' },
  { term: 'annihilator', kind: 'unprinted' },
  { term: 'banding', kind: 'unprinted' },
  { term: 'dredge', kind: 'unprinted' },
] as const;

describe('the table is CLOSED — a near miss returns nothing, never a plausible lie', () => {
  it.each(MUST_NOT_RESOLVE)('$term ($kind) resolves to nothing', ({ term }) => {
    expect(glossaryEntry(term), `${term} must not resolve to a near match`).toBeUndefined();
  });

  it('every "unprinted" entry really is absent from the pool', () => {
    // The cross-guard. A term listed here as unprinted that the pool now prints
    // is a direct contradiction of `resolves every keyword the pool prints`, and
    // it must fail HERE — where the reason is written down — rather than leaving
    // someone to discover the conflict by writing a row and watching this file
    // go red for no stated reason.
    const printed = new Set(POOL_KEYWORDS.map((term) => term.toLowerCase()));
    const nowPrinted = MUST_NOT_RESOLVE.filter(
      (row) => row.kind === 'unprinted' && printed.has(row.term.toLowerCase()),
    ).map((row) => row.term);
    expect(
      nowPrinted,
      'the pool now prints this keyword — it needs a glossary row, and this entry must go',
    ).toEqual([]);
  });

  it('"protection" is the exception that proves the design: a declared alias, not a fuzzy match', () => {
    expect(glossaryEntry('protection')?.term).toBe('Protection from');
  });
});

describe('the affix table is definitional, not fuzzy', () => {
  it('resolves every landwalk and typecycling variant the pool prints', () => {
    for (const walk of [
      'Swampwalk',
      'Islandwalk',
      'Forestwalk',
      'Mountainwalk',
      'Plainswalk',
      'Legendary landwalk',
      'Nonbasic landwalk',
    ]) {
      expect(glossaryEntry(walk)?.term, walk).toBe('Landwalk');
    }
    for (const cycle of ['Plainscycling', 'Forestcycling', 'Islandcycling', 'Swampcycling']) {
      expect(glossaryEntry(cycle)?.term, cycle).toBe('Typecycling');
    }
  });

  it('an exact row always wins over an affix rule', () => {
    // "Cycling" ends in the `cycling` suffix. It must reach the cycling row, not
    // the typecycling one, or a player hovering the commonest keyword in the
    // pool gets the wrong rule.
    expect(glossaryEntry('Cycling')?.term).toBe('Cycling');
    expect(glossaryEntry('Landwalk')?.term).toBe('Landwalk');
  });

  it('a bare affix with nothing in front of it does not resolve', () => {
    expect(glossaryEntry('walk')).toBeUndefined();
    expect(glossaryEntry('protectionfrom')?.term).toBe('Protection from'); // the prefix row's own key
  });

  it('a card TYPE never resolves to a keyword row', () => {
    // The reason the table has no "enchant" PREFIX rule: "enchantment" starts
    // with it and is a card type, not an ability. A prefix rule there would
    // answer a question nobody asked, wrongly, on every Aura in the pool.
    for (const type of [
      'enchantment',
      'creature',
      'artifact',
      'instant',
      'sorcery',
      'land',
      'planeswalker',
    ]) {
      expect(glossaryEntry(type), type).toBeUndefined();
    }
  });

  it('every affix rule points at a row that exists and states why it is definitional', () => {
    for (const rule of GLOSSARY_AFFIX_RULES) {
      expect(KEYWORD_GLOSSARY[rule.entry], rule.affix).toBeDefined();
      expect(rule.why.length, rule.affix).toBeGreaterThan(40);
      expect(normalizeGlossaryTerm(rule.affix), 'affixes are stored normalised').toBe(rule.affix);
    }
  });
});

describe('every row is well-formed', () => {
  const kinds = new Set<string>(GLOSSARY_TERM_KINDS);

  it('has a term, a tabulated kind, and a real explanation', () => {
    for (const [key, entry] of Object.entries(KEYWORD_GLOSSARY)) {
      expect(entry.term.length, key).toBeGreaterThan(0);
      expect(kinds.has(entry.kind), `${key} has untabulated kind ${entry.kind}`).toBe(true);
      // Long enough to be an explanation rather than a restatement of the word.
      expect(entry.text.length, `${key} explanation is too short to explain anything`).toBeGreaterThan(40);
    }
  });

  it('is reachable by its own key and by its printed term', () => {
    for (const key of Object.keys(KEYWORD_GLOSSARY) as GlossaryKey[]) {
      expect(glossaryEntry(key), key).toBe(KEYWORD_GLOSSARY[key]);
      expect(glossaryEntry(KEYWORD_GLOSSARY[key].term), key).toBe(KEYWORD_GLOSSARY[key]);
    }
  });

  it('is frozen, so a consumer cannot mutate the shared table', () => {
    expect(Object.isFrozen(KEYWORD_GLOSSARY)).toBe(true);
    expect(Object.isFrozen(KEYWORD_FLAG_GLOSSARY)).toBe(true);
    expect(Object.isFrozen(GLOSSARY_AFFIX_RULES)).toBe(true);
    expect(Object.isFrozen(POOL_TERMS_WITHOUT_GLOSSARY)).toBe(true);
  });

  it('spells the hard cases right, because these are the ones a player checks', () => {
    // Spot-checks on rows where a wrong explanation would actively mislead.
    expect(glossaryForFlag('indestructible').text).toMatch(/toughness reduced to 0/u);
    expect(glossaryForFlag('myriad').text).toMatch(/two-player/u);
    expect(glossaryForFlag('shroud').text).toMatch(/including you/u);
    expect(glossaryForFlag('wither').text).toMatch(/Damage to players is completely normal/u);
    expect(glossaryEntry('Vigilance')?.text).toMatch(/does not tap it/u);
  });
});

/**
 * THE CITATIONS THEMSELVES (§3.143 wave 2, GAP-15 / GAP-16).
 *
 * This directory exists to make a missing rule VISIBLE. A rule that is present
 * but points at the WRONG section is the same failure wearing a better hat:
 * `rules-manifest.ts`'s own header records that a 2026-08-07 verification pass
 * corrected 24 such citations, "a rules index that cites the wrong rule is worse
 * than no index: it is confidently wrong". Nothing has checked since, and two
 * more had crept back in by §3.143:
 *
 *  - `KEYWORD_RULES` gave CR 702.18 to BOTH `shroud` and `landwalk`. Shroud is
 *    right; landwalk is 702.14 (the CR 702 evergreen block is alphabetical, and
 *    the neighbours this table already has agree: indestructible 702.12,
 *    lifelink 702.15, protection 702.16, reach 702.17).
 *  - `internal/stats.ts` cited "CR 613.3 layer 7a", one of the exact citations
 *    that 2026-08-07 pass corrected — the layer-7 sublayers are 613.4.
 *
 * Both are the same SHAPE of defect: a number typed from memory that no test
 * could see. So this file guards the shape rather than the two instances.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { KEYWORD_RULES } from './rules-manifest.js';

/* -------------------------------------------------------------------------- */
/* GAP-H — a CR citation anywhere in the packages agrees with the manifest      */
/* -------------------------------------------------------------------------- */

/**
 * The words a CR 702 citation can NAME, each mapped to the `KEYWORD_RULES` entry
 * that is the authority on its section number.
 *
 * ## Why this table exists rather than a second list of numbers
 * The GAP-15 guard above only ever read `KEYWORD_RULES`. That is exactly why a
 * wrong number could live in EIGHT other places at once: nine files said landwalk
 * was CR 702.18b, the manifest said 702.14, and nothing compared the two. So this
 * table carries no rule numbers of its own — it maps a WORD to a manifest key, and
 * the number always comes from the manifest. A row added here cannot introduce a
 * disagreement; it can only subject one more word to the one that already exists.
 *
 * CLOSED: a citation naming a word that is not a row is simply not checked, which
 * is an honest refusal (the walker says how many it checked, so the population can
 * never silently fall to zero). Deliberately omitted are words too common in
 * ordinary prose to be a reliable signal of what a nearby number cites.
 */
const CITED_ABILITY_WORDS: Readonly<Record<string, keyof typeof KEYWORD_RULES>> = {
  // The landwalk family: every printed walk cites the ONE landwalk section.
  landwalk: 'landwalk',
  islandwalk: 'landwalk',
  forestwalk: 'landwalk',
  swampwalk: 'landwalk',
  mountainwalk: 'landwalk',
  plainswalk: 'landwalk',
  shroud: 'shroud',
  hexproof: 'hexproof',
  infect: 'infect',
  wither: 'wither',
  toxic: 'toxic',
  shadow: 'shadow',
  flanking: 'flanking',
  'split second': 'splitSecond',
  myriad: 'myriad',
  menace: 'menace',
  horsemanship: 'horsemanship',
  vigilance: 'vigilance',
  deathtouch: 'deathtouch',
  lifelink: 'lifelink',
  indestructible: 'indestructible',
};


/**
 * CR 702 abilities this repo CITES but carries no `KeywordFlags` bit for, so the
 * manifest cannot be their authority. Each number is VERIFIED against the
 * Comprehensive Rules at the date given, never typed from memory — that is the
 * habit this whole file exists to enforce.
 */
const EXTRA_702_SECTIONS: Readonly<Record<string, string>> = {
  // §3.143 GAP-I. The conformance index gave 702.90a to exalted and 702.90b/c
  // to infect, and one CR 702 subsection cannot define two keyword abilities.
  // Verified 2026-09-11 against the Comprehensive Rules: exalted is 702.83
  // ("Whenever a creature you control attacks alone, that creature gets +1/+1
  // until end of turn"), and 702.90 really does belong to infect — so it was
  // the exalted claim that was wrong.
  exalted: '702.83',
};

/**
 * Ability words that make a line AMBIGUOUS without being judged themselves.
 *
 * The distinction earns its keep twice over, and both cases are real lines in
 * this repo:
 *
 *  - `"trample + infect (CR 702.19b)"` — 702.19 is TRAMPLE's own number, so
 *    judging it as an infect citation is a false alarm. Knowing the word
 *    `trample` is enough to make the line ambiguous and skip it.
 *  - `"cast it … and it gains haste (CR 702.62a)"` — haste is a RIDER on
 *    suspend's text, not the subject of the citation. Words that commonly ride
 *    on another ability's rules text belong here and NOT in the judged table.
 *
 * Seeded from the manifest's own keys (so a keyword added to `KeywordFlags`
 * widens the ambiguity check for free) plus the CR 702 abilities this repo's
 * prose names but models as data rather than as a keyword flag.
 */
const AMBIGUATING_WORDS: readonly string[] = [
  // `firstStrike` → `first strike`: the manifest's key spelling, as prose.
  ...Object.keys(KEYWORD_RULES).map((key) => key.replace(/([a-z])([A-Z])/gu, '$1 $2').toLowerCase()),
  ...Object.keys(CITED_ABILITY_WORDS),
  ...Object.keys(EXTRA_702_SECTIONS),
  'protection',
  'bushido',
  'rampage',
  'banding',
  'intimidate',
  'fear',
  'provoke',
  'flashback',
  'suspend',
  'madness',
  'cascade',
  'warp',
  'echo',
  'annihilator',
  'undying',
  'persist',
  'evolve',
  'bestow',
  'scavenge',
  'overload',
  'unleash',
  'cipher',
  'extort',
  'fuse',
  'mobilize',
  'proliferate',
];

/** word → the CR 702 section it must cite. One answer, two sources, no overlap. */
function citedSectionOf(word: string): string | undefined {
  const keyword = CITED_ABILITY_WORDS[word];
  return keyword === undefined ? EXTRA_702_SECTIONS[word] : KEYWORD_RULES[keyword];
}

/* -------------------------------------------------------------------------- */
/* GAP-15 — one CR 702 section, one keyword ability                            */
/* -------------------------------------------------------------------------- */

/**
 * The CR 702 prefix. Only rule numbers inside it are subject to the uniqueness
 * rule below, and the reason is a rules fact rather than a convenience: CR 702
 * gives every KEYWORD ABILITY its own numbered subsection, so two keywords
 * sharing one 702 number is necessarily an error.
 *
 * Everything else in `KEYWORD_RULES` points OUT of 702 on purpose — the block
 * and attack restrictions/requirements (`unblockable`, `cantBlock`,
 * `minBlockers`, `mustBeBlocked`, …) are not keyword abilities at all, they are
 * clauses checked where blockers and attackers are declared, and the table says
 * so in its own comments. Several of them legitimately index to ONE rule
 * (509.1b), which is the whole distinction, so they are exempt by construction
 * rather than by an allowlist that would have to be maintained.
 */
const KEYWORD_ABILITY_SECTION = '702.';

describe('GAP-15 — no two keyword ABILITIES claim the same CR 702 subsection', () => {
  it('the guard has 702 entries to check (never vacuously green)', () => {
    const inSection = Object.values(KEYWORD_RULES).filter((rule) =>
      rule.startsWith(KEYWORD_ABILITY_SECTION),
    );
    expect(inSection.length).toBeGreaterThan(20);
  });

  it('every CR 702 rule number is claimed by exactly one keyword', () => {
    const byRule = new Map<string, string[]>();
    for (const [keyword, rule] of Object.entries(KEYWORD_RULES)) {
      if (!rule.startsWith(KEYWORD_ABILITY_SECTION)) continue;
      const claimants = byRule.get(rule);
      if (claimants === undefined) byRule.set(rule, [keyword]);
      else claimants.push(keyword);
    }
    const collisions = [...byRule.entries()]
      .filter(([, claimants]) => claimants.length > 1)
      .map(([rule, claimants]) => `CR ${rule} ← ${claimants.join(' + ')}`);
    // A collision means at least one of the named keywords indexes into another
    // keyword's rules text. Look the number up in the CR; do not pick a free one.
    expect(collisions).toEqual([]);
  });

  it('landwalk is 702.14 and shroud is 702.18 — the pair that collided', () => {
    // Pinned by name as well as by the general rule above, because this is the
    // instance the general rule was written for and a future "tidy-up" that
    // swapped them back would otherwise still satisfy uniqueness.
    expect(KEYWORD_RULES.landwalk).toBe('702.14');
    expect(KEYWORD_RULES.shroud).toBe('702.18');
  });
});

/** Every `.ts` source file under `packages/<pkg>/src`, as [label, text]. */
function packageSources(): readonly (readonly [string, string])[] {
  const packages = fileURLToPath(new URL('../../../', import.meta.url)); // …/packages/
  const out: [string, string][] = [];
  const walk = (dir: string, prefix: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      // `dist` holds BUILD OUTPUT of these same files, so walking it would
      // double-report every offender and make a stale build look like a defect.
      if (entry.name === 'dist' || entry.name === 'node_modules') continue;
      const child = `${dir}${entry.name}`;
      if (entry.isDirectory()) walk(`${child}/`, `${prefix}${entry.name}/`);
      // CRLF trap (CLAUDE.md): normalise before any matching.
      else if (entry.name.endsWith('.ts')) {
        out.push([`${prefix}${entry.name}`, readFileSync(child, 'utf8').replace(/\r\n/gu, '\n')]);
      }
    }
  };
  for (const pkg of readdirSync(packages, { withFileTypes: true })) {
    if (!pkg.isDirectory()) continue;
    const src = `${packages}${pkg.name}/src/`;
    try {
      walk(src, `${pkg.name}/src/`);
    } catch {
      // A package with no `src` (data-only) is not an error, just nothing to walk.
    }
  }
  return out;
}

/** Any `NNN.NN` rule number on a line, sub-letter stripped: `702.14b` → `702.14`. */
const RULE_NUMBER = /\b(\d{3}\.\d+)[a-z]?\b/gu;

/** Memoized whole-word matcher for one ability word. */
const WORD_PATTERNS = new Map<string, RegExp>();
function wordPattern(word: string): RegExp {
  let pattern = WORD_PATTERNS.get(word);
  if (pattern === undefined) {
    pattern = new RegExp(`\\b${word}\\b`, 'u');
    WORD_PATTERNS.set(word, pattern);
  }
  return pattern;
}

/** One citation the walker judged: where it is, what it names, what it cites. */
interface JudgedCitation {
  readonly where: string;
  readonly word: string;
  readonly cited: string;
  readonly expected: string;
}

/**
 * Every line that cites a CR 702 section AND names exactly one ability word from
 * the table, paired with the number the manifest says that word has.
 *
 * EXACTLY ONE word, because a line naming two ("landwalk, unlike shroud") is
 * ambiguous about which one a nearby number belongs to — and a guard that guesses
 * is the failure this file was written about. Such a line is skipped, and the
 * count below is what stops the skipping from quietly swallowing the population.
 */
function judgeCitations(): readonly JudgedCitation[] {
  const words = [...new Set([...Object.keys(CITED_ABILITY_WORDS), ...AMBIGUATING_WORDS])];
  const out: JudgedCitation[] = [];
  for (const [path, text] of packageSources()) {
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] as string;
      const lower = line.toLowerCase();
      // WORD BOUNDARIES, not `includes`: `flash` is a substring of `flashback`
      // (CR 702.34) and `ward` of `toward`, and a substring match reported both
      // as wrong citations on its first run.
      const named = words.filter((word) => wordPattern(word).test(lower));
      if (named.length !== 1) continue;
      const word = named[0] as string;
      const expected = citedSectionOf(word);
      if (expected === undefined) continue; // ambiguating-only: it says nothing
      // EXACTLY ONE CR 702 number too, for the same reason as exactly one word.
      // A line that LISTS several (the neighbour argument that settled landwalk:
      // indestructible 702.12, lifelink 702.15, protection 702.16, reach 702.17)
      // or that names one in order to REJECT it (toxic is 702.164, NOT 702.181,
      // which is Mobilize) says nothing about which number belongs to the word,
      // and a guard that guesses is the defect this whole file is about.
      const cited = [...line.matchAll(RULE_NUMBER)]
        .map((match) => match[1] as string)
        .filter((rule) => rule.startsWith('702.'));
      if (cited.length !== 1) continue;
      out.push({ where: `${path}:${i + 1}`, word, cited: cited[0] as string, expected });
    }
  }
  return out;
}

describe('GAP-H — no CR citation in any package contradicts the manifest', () => {
  const judged = judgeCitations();

  it('the walker finds citations to judge (never vacuously green)', () => {
    // Measured 2026-09-11: 100 judged citations across 452 package sources. The
    // floors are well under that so ordinary comment edits cannot fail them, but
    // a walker that stopped reading the packages, or a word table that stopped
    // matching anything, drops to zero and is caught — which is how a sweep dies
    // quietly. Nine files cited landwalk wrongly before this guard existed.
    expect(packageSources().length).toBeGreaterThan(200);
    expect(judged.length).toBeGreaterThan(40);
  });

  it('every judged citation matches the section the manifest gives that ability', () => {
    const wrong = judged
      .filter((entry) => entry.cited !== entry.expected)
      .map((entry) => `${entry.where}: "${entry.word}" cited CR ${entry.cited}, manifest says ${entry.expected}`);
    // Look the number up in the CR and fix whichever of the two is wrong — never
    // move the manifest to match a citation, which is how a wrong number spreads.
    expect(wrong).toEqual([]);
  });

  it('the two authorities never claim the same word', () => {
    // The extra table exists only for CR 702 abilities the engine carries no
    // keyword bit for. An overlap would be two answers to one question.
    const overlap = Object.keys(EXTRA_702_SECTIONS).filter(
      (word) => CITED_ABILITY_WORDS[word] !== undefined,
    );
    expect(overlap).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/* GAP-16 — the layer-7 sublayers are 613.4, and stay that way                 */
/* -------------------------------------------------------------------------- */

/** Every `.ts` file under `packages/core/src`, as [repo-relative path, text]. */
function coreSources(): readonly (readonly [string, string])[] {
  const root = fileURLToPath(new URL('../', import.meta.url)); // …/packages/core/src/
  const out: [string, string][] = [];
  const walk = (dir: string, prefix: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const child = `${dir}${entry.name}`;
      if (entry.isDirectory()) {
        walk(`${child}/`, `${prefix}${entry.name}/`);
      } else if (entry.name.endsWith('.ts')) {
        // CRLF trap (CLAUDE.md): committed files are CRLF on a Windows
        // checkout, LF in git. Normalise before any matching.
        out.push([`${prefix}${entry.name}`, readFileSync(child, 'utf8').replace(/\r\n/gu, '\n')]);
      }
    }
  };
  walk(root, '');
  return out;
}

/**
 * `613.3` in core source, but not `613.30`-and-up. Written as a negative
 * lookahead rather than `\b` because `\b` matches before a period and would
 * flag "613.34" in prose that does not exist yet but could.
 */
const WRONG_LAYER_CITATION = /613\.3(?![0-9])/u;

/**
 * The files allowed to contain `613.3` today, each with the reason. CLOSED: a
 * file not on this list fails, which is the point — the ban is what stops a new
 * one appearing while the debt rows are paid off by the lanes that own them.
 */
const ALLOWED_613_3: Readonly<Record<string, string>> = {
  'conformance/rules-citations.test.ts':
    'DELIBERATE. This guard names the banned number in order to ban it — and the fact that it ' +
    'flagged ITSELF on its first run is the cheapest possible proof that the walker really reads ' +
    'core source rather than passing on an empty list.',
  'conformance/rules-manifest.ts':
    'DELIBERATE. Its header quotes the 2026-08-07 correction verbatim — "the layer-7 sublayers ' +
    'being 613.4 rather than 613.3". Removing the wrong number would remove the record of it.',
  'provenance.ts':
    'DELIBERATE. Its ⚠️ states the rule for every later reader: "they are 613.4, not 613.3".',
};

describe('GAP-16 — layer 7a is cited as CR 613.4, the number the 2026-08-07 pass settled', () => {
  const offenders = coreSources()
    .filter(([, text]) => WRONG_LAYER_CITATION.test(text))
    .map(([path]) => path);

  it('the walker actually reads core (never vacuously green)', () => {
    expect(coreSources().length).toBeGreaterThan(100);
  });

  it('no file outside the closed allowlist cites 613.3', () => {
    const unexpected = offenders.filter((path) => ALLOWED_613_3[path] === undefined);
    // A new name here means a citation typed from memory. The layer-7 sublayers
    // are CR 613.4 (613.4a is the characteristic-defining one); see
    // `rules-manifest.ts`'s header for why this repo does not guess rule numbers.
    expect(unexpected).toEqual([]);
  });

  it('internal/stats.ts — the file this guard was written for — is clean', () => {
    expect(offenders).not.toContain('internal/stats.ts');
  });
});

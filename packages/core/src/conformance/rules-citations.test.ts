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
  'card.ts':
    'DEBT (§3.143 wave 2). `characteristicPT` still says "applied in CR 613.3\'s layer 7a". ' +
    'Owned by another lane this wave and reported as a one-line change, not patched across a ' +
    'lane boundary. Delete this row when it lands.',
  'derived.ts':
    'DEBT (§3.143 wave 2). The module header says "CR 613.3 layer 7a". Same one-line change.',
  'derived-state.test.ts':
    'DEBT (§3.143 wave 2). Its title line says "(CR 613.3 layer 7a)". Same one-line change.',
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

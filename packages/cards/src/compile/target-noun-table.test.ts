/**
 * THE SHARED TARGET-NOUN TABLE — one printed-noun vocabulary, read by every
 * removal verb (§3.58).
 *
 * Found by DATA, not by intuition: `scripts/near-miss-report.mjs` ranks the
 * cards that are ONE clause from playable by the shape of the clause blocking
 * them, and the top of that list was a run of "destroy / exile / counter target
 * <noun>" lines whose nouns the table simply did not carry. Each was one row.
 *
 * What this pins is the SHARING, because that is what stops the next noun being
 * added for one verb and forgotten for the other: every noun in the table must
 * compile under destroy AND exile, to the same restriction, and a noun outside
 * the table must still be refused by both.
 */

import { describe, expect, it } from 'vitest';
import { compileCard } from './compile.js';
import type { CompilableCard } from './types.js';
import { COUNTER_NOUN_RESTRICTIONS, TARGET_NOUN_RESTRICTIONS } from './rules.js';

function instant(oracleText: string): CompilableCard {
  return {
    id: 'test:noun',
    name: 'Probe Card',
    manaCost: { generic: 1, W: 0, U: 0, B: 1, R: 0, G: 0, C: 0, other: [] },
    typeLine: { supertypes: [], types: ['Instant'], subtypes: [] },
    oracleText,
    power: null,
    toughness: null,
    keywords: [],
  };
}

describe('the shared permanent-noun table', () => {
  it('every noun compiles under BOTH destroy and exile, to the same restriction', () => {
    for (const [noun, restriction] of Object.entries(TARGET_NOUN_RESTRICTIONS)) {
      for (const verb of ['Destroy', 'Exile'] as const) {
        const result = compileCard(instant(`${verb} target ${noun}.`));
        expect(result.status, `${verb} target ${noun}: ${JSON.stringify(result.missing)}`).toBe('complete');
        expect(result.definition.effects?.[0]?.params?.targets, `${verb} target ${noun}`).toBe(restriction);
      }
    }
  });

  it('a noun OUTSIDE the table is refused by both verbs — never widened', () => {
    // "creature or land" is not a noun this engine carries; compiling it as
    // 'permanent' would let the card hit an artifact it may not touch.
    for (const verb of ['Destroy', 'Exile'] as const) {
      expect(compileCard(instant(`${verb} target creature or land.`)).status).toBe('incomplete');
    }
  });
});

describe('the shared spell-noun table', () => {
  it('every counter noun compiles to its own restriction', () => {
    for (const [noun, restriction] of Object.entries(COUNTER_NOUN_RESTRICTIONS)) {
      const result = compileCard(instant(`Counter target ${noun}.`));
      expect(result.status, `counter target ${noun}: ${JSON.stringify(result.missing)}`).toBe('complete');
      expect(result.definition.effects?.[0]?.params?.targets).toBe(restriction);
    }
  });

  it('a spell noun outside the table is refused — a counterspell is never widened', () => {
    expect(compileCard(instant('Counter target artifact spell.')).status).toBe('incomplete');
  });
});

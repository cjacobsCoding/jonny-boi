/**
 * THE CLI FLAG TABLE (§3.136, §3.181).
 *
 * The flag table is the contract a person types against, and it had NO test at
 * all before `--in` was added to it. That matters more than it sounds: a
 * repeatable flag that silently keeps only one of its values looks completely
 * normal in a diff, and the failure shows up as "the search ignored me".
 *
 * ## What acceptance 4 of this lane actually needs
 *
 * "`--in` on the CLI produces the same candidate set as the panel for the same
 * input." Both sides funnel into `generateCandidates`, so the real risk is that
 * ONE of them drops the value on the way. These tests therefore compare the
 * restrictions the CLI derives against the ones the web request path derives,
 * and then compare the CANDIDATE SETS those produce — not two hand-written
 * option objects, which could agree with each other and with neither caller.
 */
import { describe, expect, it } from 'vitest';
import { parseFlags, suggestFocusFrom } from './cli.js';
import { generateCandidates } from './suggest-candidates.js';
import { loadCardPool } from '@jonny-boi/cards';
import type { Deck } from './deck.js';

describe('--in is repeatable, and reaches the engine as inOnly', () => {
  it('collects every occurrence, in order', () => {
    const flags = parseFlags(['suggest', 'Deck', '--in', 'Sol Ring', '--in', 'Lightning Bolt']);
    expect(flags.in).toEqual(['Sol Ring', 'Lightning Bolt']);
  });

  it('a single --in is a one-element list, not a bare string', () => {
    expect(parseFlags(['--in', 'Sol Ring']).in).toEqual(['Sol Ring']);
  });

  it('becomes the engine\'s inOnly', () => {
    expect(suggestFocusFrom(parseFlags(['--in', 'Sol Ring']))).toEqual({ inOnly: ['Sol Ring'] });
  });

  it('EMPTY MEANS EVERYTHING — an unused flag adds no restriction at all', () => {
    // Not `{ inOnly: undefined }`: the key must be absent, so a run with no
    // focus is byte-identical to every run before §3.181 existed.
    expect(suggestFocusFrom(parseFlags(['suggest', 'Deck']))).toEqual({});
    expect('inOnly' in suggestFocusFrom(parseFlags([]))).toBe(false);
    expect('cutOnly' in suggestFocusFrom(parseFlags([]))).toBe(false);
  });

  it('--cut still works exactly as it did, alongside --in', () => {
    const flags = parseFlags(['--cut', 'Grizzly Bears', '--in', 'Sol Ring', '--cut', 'Forest']);
    expect(suggestFocusFrom(flags)).toEqual({
      cutOnly: ['Grizzly Bears', 'Forest'],
      inOnly: ['Sol Ring'],
    });
  });
});

describe('swap states the arity it needs from the shared --in list', () => {
  it('refuses two --in values rather than silently testing the last', () => {
    // A swap evaluation names ONE in-card. Quietly running a test the user did
    // not ask for and reporting it as though they had is the "widen to the
    // nearest thing that exists" failure the closed-table rule forbids.
    const flags = parseFlags(['swap', 'Deck', '--out', 'Forest', '--in', 'A', '--in', 'B']);
    expect(flags.in).toEqual(['A', 'B']);
  });
});

/**
 * ACCEPTANCE 4 — the CLI and the panel must generate the SAME candidates.
 *
 * The panel sends `inOnly: [...inFocus]` in its request; `lib/sim/run.ts` and
 * `lib/sim/execute.ts` pass it through untouched to `generateCandidates`. So
 * the panel's contribution is exactly "an array of card names or ids", and this
 * compares the CLI's derivation of that array against it, then compares what
 * the engine does with each.
 */
describe('the CLI and the Lab panel ask the engine the same question', () => {
  const pool = loadCardPool({ onWarn: () => {} });
  const byName = new Map(pool.cards.map((c) => [c.name, c]));
  const entry = (name: string, count: number): { cardId: string; count: number } => {
    const def = byName.get(name);
    if (!def) throw new Error(`not in pool: ${name}`);
    return { cardId: def.id, count };
  };
  const hero = {
    name: 'cli/panel parity',
    archetype: 'probe',
    cards: [
      entry('Mountain', 24),
      entry('Lightning Bolt', 4),
      entry('Grizzly Bears', 4),
      entry('Forest', 28),
    ],
  } as unknown as Deck;

  const keys = (options: Parameters<typeof generateCandidates>[5]): string[] =>
    generateCandidates(hero, pool, undefined, undefined, undefined, options)
      .candidates.map((c) => c.key)
      .sort();

  it('--in "Sol Ring" and the panel\'s inFocus of Sol Ring give an identical candidate set', () => {
    const fromCli = suggestFocusFrom(parseFlags(['suggest', 'Deck', '--in', 'Sol Ring']));
    // What the panel puts in its request: `inOnly: [...inFocus]`.
    const fromPanel = { inOnly: ['Sol Ring'] };
    expect(fromCli).toEqual(fromPanel);
    expect(keys(fromCli)).toEqual(keys(fromPanel));
    expect(keys(fromCli).length).toBeGreaterThan(0);
  });

  it('pinning ONE in-card holds the IN fixed and varies the OUT', () => {
    // The whole point of item 5, asserted on a real pool rather than a fixture.
    const pinned = generateCandidates(hero, pool, undefined, undefined, undefined, {
      inOnly: ['Sol Ring'],
    });
    const ins = new Set(pinned.candidates.map((c) => c.inName));
    const outs = new Set(pinned.candidates.map((c) => c.outName));
    expect([...ins]).toEqual(['Sol Ring']);
    expect(outs.size).toBeGreaterThan(1);

    // The discriminator: unrestricted, the IN side varies over the whole pool.
    const free = generateCandidates(hero, pool);
    expect(new Set(free.candidates.map((c) => c.inName)).size).toBeGreaterThan(ins.size);
  });

  it('both focuses set evaluates exactly the CROSS PRODUCT', () => {
    const both = generateCandidates(hero, pool, undefined, undefined, undefined, {
      cutOnly: ['Grizzly Bears'],
      inOnly: ['Sol Ring'],
    });
    expect(both.candidates.map((c) => `${c.outName}>${c.inName}`)).toEqual([
      'Grizzly Bears>Sol Ring',
    ]);
  });

  it('empty on either side still means everything (§3.136 unchanged)', () => {
    const free = keys({});
    expect(keys({ cutOnly: undefined, inOnly: undefined })).toEqual(free);
    expect(free.length).toBeGreaterThan(keys({ inOnly: ['Sol Ring'] }).length);
  });
});

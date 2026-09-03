/**
 * §3.123 — **ONE ANSWER TO "IS THE SORCERY-SPEED WINDOW OPEN?"** (rule 12).
 *
 * "Any time you could cast a sorcery" (CR 307.1) is asked by sorceries, Equip,
 * transmute, plot, foretell, suspend, graveyard abilities and every alternative
 * cast — in three layers: the engine OFFERS only what it is open for, the engine
 * ACCEPTS only what it is open for, and the pilot PLANS only what it is open
 * for. Before this section that was sixteen hand-written copies of the same
 * conjunction: seven in `engine.ts`, eight in `heuristic.ts`, one in `mcts.ts` —
 * and several of the pilot's had inlined the two step names instead of reading
 * `MAIN_STEPS`, so the table and its readers were already two sources.
 *
 * Sixteen copies did not disagree with each other. What happened is worse and is
 * the failure mode rule 12 names: a seventeenth consumer did not ask AT ALL. The
 * pilot's cycling policy (`bestCycle`) had never needed the question, because
 * cycling prints no timing restriction — and then transmute arrived wearing
 * cycling's shape with `timing: 'sorcery'`, and a policy whose only live case is
 * the END STEP started proposing an ability that is legal only in a main phase.
 * A missing question looks exactly like a question that returned `true`.
 *
 * So this sweep does the thing a single reader cannot do by itself: it makes the
 * SECOND copy impossible to add quietly. Re-deriving the window in `core` or
 * `ai` fails here, which is a prompt to call `sorcerySpeedWindowFor` — and a
 * caller of a named function is a caller you can find.
 */

import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sorcerySpeedWindowFor, type GameState } from '@jonny-boi/core';

const SRC = dirname(fileURLToPath(import.meta.url));

/** The packages whose source may not re-derive the window, and where they live. */
const SWEPT: readonly { readonly label: string; readonly dir: string }[] = [
  { label: 'core', dir: join(SRC, '..', '..', 'core', 'src') },
  { label: 'ai', dir: join(SRC, '..', '..', 'ai', 'src') },
];

/**
 * `state.ts` DEFINES the window, so it is the one file allowed to spell it.
 * Test files are swept too: a test that hand-rolls the predicate is asserting
 * against its own copy rather than against the engine's.
 */
const DEFINITION_FILE = 'state.ts';

/**
 * The conjunction, whitespace-collapsed so a copy split over three lines is
 * caught as readily as a one-liner: "…activePlayer && … stack.length === 0".
 * Bounded so it cannot leap across an unrelated statement.
 */
const RE_DERIVED = /activePlayer\s*&&[^;{}]{0,200}?stack\.length === 0/;

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) out.push(...sourceFiles(join(dir, entry.name)));
    else if (entry.name.endsWith('.ts')) out.push(join(dir, entry.name));
  }
  return out;
}

describe('the sorcery-speed window has exactly one reader', () => {
  it('nothing in core or ai re-derives it', () => {
    const offences: string[] = [];
    for (const { label, dir } of SWEPT) {
      for (const file of sourceFiles(dir)) {
        if (file.endsWith(DEFINITION_FILE)) continue;
        const collapsed = readFileSync(file, 'utf8').replace(/\s+/g, ' ');
        if (RE_DERIVED.test(collapsed)) offences.push(`${label}: ${file.slice(dir.length + 1)}`);
      }
    }
    expect(
      offences,
      `these re-derive the sorcery-speed window instead of calling sorcerySpeedWindowFor():\n  ${offences.join('\n  ')}`,
    ).toEqual([]);
  });

  it('and that reader says what CR 307.1 says', () => {
    const at = (activePlayer: 'A' | 'B', step: string, stack: number) =>
      ({ activePlayer, step, stack: Array.from({ length: stack }, () => 0) }) as unknown as GameState;
    expect(sorcerySpeedWindowFor(at('A', 'precombatMain', 0), 'A')).toBe(true);
    expect(sorcerySpeedWindowFor(at('A', 'postcombatMain', 0), 'A')).toBe(true);
    // Not your turn, not a main phase, or something is on the stack.
    expect(sorcerySpeedWindowFor(at('B', 'precombatMain', 0), 'A')).toBe(false);
    expect(sorcerySpeedWindowFor(at('A', 'end', 0), 'A')).toBe(false);
    expect(sorcerySpeedWindowFor(at('A', 'upkeep', 0), 'A')).toBe(false);
    expect(sorcerySpeedWindowFor(at('A', 'precombatMain', 1), 'A')).toBe(false);
  });
});

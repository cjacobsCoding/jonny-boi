/**
 * STOPPING WHEN THE LEADER IS SETTLED MUST NOT CHANGE THE RECOMMENDATION (§3.98).
 *
 * §3.96 measured that `suggest`'s finalists are decided against the BASE long
 * before the final wave, and refused to stop on it: the command outputs an ORDER,
 * and the last wave is what separates the leaders from each other. §3.97 made the
 * leader-vs-runner-up comparison free. This rule stops the ladder when THAT is
 * decided — and the entire justification is that the recommendation is unchanged,
 * so that is what these tests check, across several decks and seeds rather than
 * the one run it was developed on.
 */

import { describe, expect, it } from 'vitest';
import { loadCardPool, buildRegistry } from '@jonny-boi/cards';
import { createDefaultAiRegistry, HEURISTIC_PILOT_ID } from '@jonny-boi/ai';
import type { Pilot } from '@jonny-boi/ai';
import { loadDeck } from './deck.js';
import type { MatchupPilots } from './matchup.js';
import { SAMPLE_DECKS } from '../data/decks/index.js';
import { DEFAULT_ADAPTIVE_CONFIG, DEFAULT_SUGGEST_CONFIG } from './suggest-config.js';
import { suggestSwaps, type SuggestOptions } from './suggest.js';

const pool = loadCardPool({ onWarn: () => {} });
const registry = buildRegistry();
const ai = createDefaultAiRegistry();
const pilots = (): MatchupPilots => ({
  pilotA: ai.getPilot(HEURISTIC_PILOT_ID) as Pilot,
  pilotB: ai.getPilot(HEURISTIC_PILOT_ID) as Pilot,
});

function optionsFor(hero: (typeof SAMPLE_DECKS)[number], seed: number, stop: boolean): SuggestOptions {
  return {
    gauntletDecks: SAMPLE_DECKS.filter((d) => d.name !== hero.name)
      .slice(0, 2)
      .map((d) => loadDeck(d, pool)),
    pilots: pilots(),
    pool,
    registry,
    baseSeed: seed,
    gamesPerCandidate: 8,
    suggestConfig: { ...DEFAULT_SUGGEST_CONFIG, maxCandidates: 6 },
    adaptiveConfig: { ...DEFAULT_ADAPTIVE_CONFIG, stopWhenLeaderSettled: stop },
  };
}

/** The line a user actually acts on. */
const topPick = (report: ReturnType<typeof suggestSwaps>) =>
  report.suggestions[0] ? `${report.suggestions[0].outName} -> ${report.suggestions[0].inName}` : '(none)';

describe('the leader-settled rule keeps the recommendation', () => {
  const cases = [
    { hero: SAMPLE_DECKS[0]!, seed: 4242 },
    { hero: SAMPLE_DECKS[0]!, seed: 90210 },
    { hero: SAMPLE_DECKS[1]!, seed: 4242 },
    { hero: SAMPLE_DECKS[3]!, seed: 555001 },
  ];

  for (const { hero, seed } of cases) {
    it(`recommends the same swap for ${hero.name} at seed ${seed}`, () => {
      const stopped = suggestSwaps(hero, optionsFor(hero, seed, true));
      const full = suggestSwaps(hero, optionsFor(hero, seed, false));
      // ⚠️ THE WHOLE JUSTIFICATION. Stopping early is only defensible if the
      // candidate a user is told to play is the same one.
      expect(topPick(stopped)).toBe(topPick(full));
    });
  }

  it('never plays MORE games than running the full ladder', () => {
    const hero = SAMPLE_DECKS[0]!;
    const stopped = suggestSwaps(hero, optionsFor(hero, 4242, true));
    const full = suggestSwaps(hero, optionsFor(hero, 4242, false));
    expect(stopped.notes.totalGamesRun).toBeLessThanOrEqual(full.notes.totalGamesRun);
  });

  it('still reports every candidate it evaluated, with its own game count', () => {
    // Stopping the ladder must not lose candidates from the report — they are
    // simply reported at the depth they reached.
    const hero = SAMPLE_DECKS[0]!;
    const stopped = suggestSwaps(hero, optionsFor(hero, 4242, true));
    expect(stopped.suggestions.length).toBeGreaterThan(0);
    for (const s of stopped.suggestions) {
      expect(s.gamesPlayed).toBeGreaterThan(0);
      expect(s.gamesPlayed).toBe(s.evaluation.nGames);
    }
    expect(stopped.notes.candidatesGenerated).toBe(stopped.candidatesEvaluated + stopped.skipped.length);
  });
});

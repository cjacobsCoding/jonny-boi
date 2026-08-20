/**
 * WHAT THE CR 704.3 PRIORITY-BOUNDARY CHECK COSTS.
 *
 * `onPassPriority` runs `checkStateBasedActions` behind `stateBasedActionsPossible`,
 * which puts a call on the single hottest loop the sim has — a 280-game gauntlet
 * passes priority 125,753 times. Rule 7 says that has to be paid for with a
 * measurement, and ⚠️ **the wall clock on this box cannot make one**: a dozen
 * agents share it and the identical build has read 39–128 games/sec within an
 * hour. A cross-build gauntlet comparison here read anywhere from 1.02× to 1.41×
 * for a change that allocates nothing — which is noise wearing a result's clothes.
 *
 * So this measures the gate directly, on a settled board, with the loop long
 * enough that the OS clock granularity (~15 ms) is noise rather than signal, and
 * reduced by the MINIMUM over rounds — the round least disturbed by whatever else
 * the box was doing.
 *
 * Run:
 *   npx tsx packages/core/bench/sba-gate-cost.ts
 *
 * Reference reading (2026-08, this box): ~30 ns per permanent, so ~240 ns for the
 * eight-permanent board a mid-game gauntlet position holds. At 125,753 boundary
 * passes that is about 30 ms across 280 games — against a gauntlet that costs
 * roughly 1.9 s of CPU, i.e. under 2%, and the gate lets only 0.1% of those passes
 * through to the full check. The paired self-play measurement in
 * `selfplay-lock.test.ts`'s note is the other half of the evidence: identical
 * event counts, and identical scavenge counts (587/584 vs 588/583, inside the
 * ±2 floor `scavenge-probe.ts` documents), so it allocates nothing at all.
 */

import { stateBasedActionsPossible } from '../src/internal/sba.js';
import { createGame } from '../src/engine.js';
import { creatureDef, deckOf, landDef } from '../src/test-fixtures.js';
import type { CardInstance, GameState } from '../src/state.js';
import { NO_COUNTERS } from '../src/state.js';

const LAND = landDef('Mountain', 'R');
const BEAR = creatureDef('Bear', 2, 2);

/** How many calls one timed round makes. Large enough to swamp clock granularity. */
const ITERATIONS = 2_000_000;
/** Rounds per board size; the fastest is the one the box interfered with least. */
const ROUNDS = 5;
/** Board sizes worth knowing: an early board, a mid-game one, a wide one. */
const SIZES = [4, 8, 16] as const;

/** A SETTLED board of `permanents` — the case the gate exists to answer `false` for. */
function settledBoard(permanents: number): GameState {
  const { state } = createGame({ seed: 1, decks: { A: deckOf(LAND, 40), B: deckOf(LAND, 40) } });
  for (let i = 0; i < permanents; i++) {
    const inst: CardInstance = {
      instanceId: state.nextInstanceId++,
      def: i % 3 === 0 ? BEAR : LAND,
      controller: i % 2 === 0 ? 'A' : 'B',
      owner: i % 2 === 0 ? 'A' : 'B',
      zone: 'battlefield',
      tapped: false,
      summoningSick: false,
      damageMarked: 0,
      markedByDeathtouch: false,
      attachedTo: null,
      counters: NO_COUNTERS,
    };
    state.battlefield.push(inst);
  }
  return state;
}

for (const size of SIZES) {
  const state = settledBoard(size);
  // A board the gate says `true` about would be measuring the wrong thing, and
  // silently: it would time the early return instead of the whole walk.
  if (stateBasedActionsPossible(state)) throw new Error(`the ${size}-permanent board is not settled`);
  for (let i = 0; i < ITERATIONS / 10; i++) stateBasedActionsPossible(state);

  let best = Number.POSITIVE_INFINITY;
  for (let round = 0; round < ROUNDS; round++) {
    const before = process.cpuUsage();
    let passed = 0;
    for (let i = 0; i < ITERATIONS; i++) if (stateBasedActionsPossible(state)) passed += 1;
    const used = process.cpuUsage(before);
    if (passed !== 0) throw new Error('the gate answered true on a settled board');
    best = Math.min(best, used.user + used.system);
  }
  console.log(
    `${String(size).padStart(2)} permanents: ${((best / ITERATIONS) * 1000).toFixed(1)} ns/call ` +
      `(min of ${ROUNDS} rounds x ${ITERATIONS.toLocaleString()} calls)`,
  );
}

/**
 * The ALLOCATION probe `engine-alloc-bench.ts` documents: play a fixed number of
 * seeded self-play games and let V8's scavenge count stand in for bytes
 * allocated.
 *
 * Wall clock on a shared box is worthless for this comparison (the alloc bench's
 * own header says repeated runs of the SAME build swing by more than 2x, and
 * this machine currently has several agents on it). Garbage is what a hot-path
 * change actually adds, and with the nursery pinned to 1 MB at BOTH bounds the
 * scavenge count is reproducible to within a couple of counts and completely
 * immune to what else the box is doing.
 *
 * Run:
 *   node --min-semi-space-size=1 --max-semi-space-size=1 --trace-gc \
 *        --import tsx packages/core/bench/scavenge-probe.ts | grep -c Scavenge
 *
 * The games are the same seeded self-play games the alloc bench replays, so a
 * difference in the count is a difference in allocation on the engine's hot
 * path — not a difference in what was played (that would show up as a different
 * action count, which this prints).
 */

import { playSelfPlayGame, selfPlayDecks } from '../src/test-fixtures.js';

/** Games per probe run. Enough to make the count large relative to startup. */
const GAMES = 40;

let actions = 0;
for (let seed = 0; seed < GAMES; seed++) {
  const result = playSelfPlayGame(selfPlayDecks(), seed);
  actions += result.actions;
}
console.log(`games ${GAMES}  actions ${actions}`);

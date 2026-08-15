/**
 * Print the behaviour-lock table that `src/selfplay-lock.test.ts` asserts against.
 *
 * The test pins the engine's exact output for a set of seeded self-play games, so
 * an optimization that changes ANY of it fails loudly. Regenerating the table is
 * therefore a deliberate act: only run this when a rules change is INTENDED, and
 * say so in the commit — a diff here is a diff in how the game plays.
 *
 * Run: npx tsx packages/core/bench/selfplay-digests.ts
 */

import {
  playSelfPlayGame,
  selfPlayDecks,
  selfPlayLockLine,
  SELF_PLAY_LOCK_SEEDS,
} from '../src/test-fixtures.js';

const decks = selfPlayDecks();
for (const seed of SELF_PLAY_LOCK_SEEDS) {
  console.log(`  '${selfPlayLockLine(playSelfPlayGame(decks, seed))}',`);
}

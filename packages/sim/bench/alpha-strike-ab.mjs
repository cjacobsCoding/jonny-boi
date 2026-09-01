/**
 * IS THE ALPHA STRIKE ACTUALLY STRONGER? — the head-to-head that decides it.
 *
 * ⚠️ THIS IS THE ONLY EXACT METHOD, and the reason the feature is behind a flag
 * at all. Two BUILDS of one pilot cannot be compared across branches: both hold
 * the same id, so only one can be loaded at a time, and running the same-id
 * control on two branches proves nothing (it is 50% on both by construction).
 * `runPilotAb` takes pilot OBJECTS, so both behaviours can sit in one process
 * and play the same seeded games against each other.
 *
 * The pairing is what makes it a verdict rather than a vibe: every unordered
 * pair of the sample decks is played in BOTH orientations on matched seeds, so
 * deck strength, seat and who is on the play all cancel exactly, and McNemar's
 * test is applied to the slots where the two arms actually disagreed.
 *
 * Usage: node packages/sim/bench/alpha-strike-ab.mjs [--games N] [--seed S]
 */
import { createHeuristicPilot } from '@jonny-boi/ai';
import { buildRegistry, loadCardPool } from '@jonny-boi/cards';
import { SAMPLE_DECKS } from '../dist/data/decks/index.js';
import { loadDeck } from '../dist/src/deck.js';
import { runPilotAb } from '../dist/src/pilot-ab.js';

function arg(name, fallback) {
  const at = process.argv.indexOf(`--${name}`);
  return at >= 0 ? Number(process.argv[at + 1]) : fallback;
}

const gamesPerOrientation = arg('games', 40);
const baseSeed = arg('seed', 4242);

const pool = loadCardPool({ onWarn: () => {} });
const registry = buildRegistry();
const decks = SAMPLE_DECKS.map((deck) => loadDeck(deck, pool));

const result = runPilotAb({
  decks,
  pilots: {
    // A: the behaviour under test. B: the pilot exactly as it was before it.
    pilotA: createHeuristicPilot(undefined, { alphaStrike: true }),
    pilotB: createHeuristicPilot(undefined, { alphaStrike: false }),
  },
  registry,
  gamesPerOrientation,
  baseSeed,
});

console.log(
  `alpha strike ON vs OFF — ${decks.length} decks, ${gamesPerOrientation} games/pair/orientation, ` +
    `${result.totalGames} games`,
);
// The VERDICT and the paired slot counts are the answer. The raw win totals are
// not: they include every game the two arms played identically, which is most of
// them, and a share near 50% there means "the case is rare", not "no effect".
console.log(
  `  slots: ahead A ${result.slots.aheadA} · ahead B ${result.slots.aheadB} · level ${result.slots.level}`,
);
console.log(`  McNemar p: ${result.pValue.toExponential(2)}`);
console.log(`  VERDICT: ${result.verdict}`);

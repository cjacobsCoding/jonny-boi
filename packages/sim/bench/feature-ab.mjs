/**
 * IS THIS FEATURE ACTUALLY STRONGER? — the two-seed head-to-head that decides it.
 *
 * ⚠️ THIS IS THE ONLY EXACT METHOD, and the reason a behaviour is put behind a flag
 * at all. Two BUILDS of one pilot cannot be compared across branches: both hold the
 * same id, so only one can be loaded at a time, and running the same-id control on
 * two branches proves nothing (it is 50% on both by construction). `runPilotAb`
 * takes pilot OBJECTS, so both behaviours sit in one process and play the same
 * seeded games against each other.
 *
 * The pairing is what makes it a verdict rather than a vibe: every unordered pair
 * of the sample decks is played in BOTH orientations on matched seeds, so deck
 * strength, seat and who is on the play all cancel exactly, and McNemar's test is
 * applied to the slots where the two arms actually disagreed.
 *
 * ⚠️ AND IT RUNS TWICE, on independent seeds — see `ab-protocol.mjs`. A single-seed
 * A/B at p < 0.05 reports a fluke as a finding, and this repo nearly shipped one.
 * A change is CONFIRMED only when both seed sets agree.
 *
 * Usage: node packages/sim/bench/feature-ab.mjs [--feature name] [--games N] [--seed S]
 */
import { createHeuristicPilot } from '@jonny-boi/ai';
import { buildRegistry, loadCardPool } from '@jonny-boi/cards';
import { SAMPLE_DECKS } from '../dist/data/decks/index.js';
import { loadDeck } from '../dist/src/deck.js';
import { runPilotAb } from '../dist/src/pilot-ab.js';
import { confirmedAb, report } from './ab-protocol.mjs';

function arg(name, fallback) {
  const at = process.argv.indexOf(`--${name}`);
  return at >= 0 ? Number(process.argv[at + 1]) : fallback;
}

const gamesPerOrientation = arg('games', 40);
const at = process.argv.indexOf('--feature');
const FEATURE = at >= 0 ? process.argv[at + 1] : 'alphaStrike';
const seed = arg('seed', 4242);
const confirmSeed = arg('confirm-seed', 90210);

const pool = loadCardPool({ onWarn: () => {} });
const registry = buildRegistry();
const decks = SAMPLE_DECKS.map((deck) => loadDeck(deck, pool));

const outcome = confirmedAb(
  (baseSeed) =>
    runPilotAb({
      decks,
      pilots: {
        // A: the behaviour under test. B: the pilot exactly as it was before it.
        pilotA: createHeuristicPilot(undefined, { [FEATURE]: true }),
        pilotB: createHeuristicPilot(undefined, { [FEATURE]: false }),
      },
      registry,
      gamesPerOrientation,
      baseSeed,
    }),
  { seed, confirmSeed },
);

// The VERDICT and the paired slot counts are the answer. The raw win totals are
// not: they include every game the two arms played identically, which is most of
// them, and a share near 50% there means "the case is rare", not "no effect".
report(
  `${FEATURE} ON vs OFF — ${decks.length} decks, ${gamesPerOrientation} games/pair/orientation, ` +
    `${outcome.primary.totalGames} games per run`,
  outcome,
  { seed, confirmSeed },
);

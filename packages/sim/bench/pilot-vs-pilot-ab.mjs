/**
 * TWO REGISTERED PILOTS, HEAD TO HEAD, ON THE FOUR-SEED BATTERY (§3.108).
 *
 * `feature-ab.mjs`, `weight-ab.mjs` and `forecast-ab.mjs` each compare a pilot
 * with a variant of ITSELF. This compares two different pilots by id — the
 * question "is `lookahead` still ahead of `heuristic` now that §3.83's set-level
 * attack ships?" had no tool, and its last answer (42 slots to 10, §3.74) predates
 * that change. Same protocol as its siblings: every unordered deck pair in both
 * orientations on matched seeds, and the held-out seeds decide.
 *
 * Usage: node packages/sim/bench/pilot-vs-pilot-ab.mjs --a lookahead --b heuristic [--games N] [--seed S]
 */
import { createDefaultAiRegistry } from '@jonny-boi/ai';
import { buildRegistry, loadCardPool } from '@jonny-boi/cards';
import { SAMPLE_DECKS } from '../dist/data/decks/index.js';
import { loadDeck } from '../dist/src/deck.js';
import { runPilotAb } from '../dist/src/pilot-ab.js';
import { confirmedAb, report, DEV_SEEDS, HELD_OUT_SEEDS } from './ab-protocol.mjs';

function arg(name, fallback) {
  const at = process.argv.indexOf(`--${name}`);
  return at >= 0 ? process.argv[at + 1] : fallback;
}

const A_ID = arg('a', 'lookahead');
const B_ID = arg('b', 'heuristic');
const gamesPerOrientation = Number(arg('games', 40));
const seedShift = Number(arg('seed', 0));

const ai = createDefaultAiRegistry();
for (const id of [A_ID, B_ID]) {
  if (!ai.getPilot(id)) {
    console.error(`unknown pilot "${id}". Known: ${ai.pilotIds().join(', ')}`);
    process.exit(2);
  }
}
if (A_ID === B_ID) {
  console.error('the two ids are the same — that A/B compares a pilot with itself.');
  process.exit(2);
}

const pool = loadCardPool({ onWarn: () => {} });
const registry = buildRegistry();
const decks = SAMPLE_DECKS.map((deck) => loadDeck(deck, pool));

const outcome = confirmedAb(
  (baseSeed) =>
    runPilotAb({
      decks,
      // Fresh instances per run: a pilot is stateless by contract, and this
      // keeps that contract from being the thing under test.
      pilots: { pilotA: ai.getPilot(A_ID), pilotB: ai.getPilot(B_ID) },
      registry,
      gamesPerOrientation,
      baseSeed,
    }),
  seedShift === 0 ? {} : { seeds: DEV_SEEDS.map((x) => x + seedShift), heldOut: HELD_OUT_SEEDS.map((x) => x + seedShift) },
);

report(
  `${A_ID} (A) vs ${B_ID} (B) — ${decks.length} decks, ${gamesPerOrientation} games/pair/orientation, ` +
    `${outcome.dev[0].result.totalGames} games per run`,
  outcome,
);

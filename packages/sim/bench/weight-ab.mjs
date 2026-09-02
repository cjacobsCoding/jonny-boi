/**
 * IS THIS WEIGHT BETTER? — the two-seed head-to-head that decides it.
 *
 * The sibling of `feature-ab.mjs`, for the tuning knobs rather than the behaviour
 * switches, and it runs the same TWO-SEED protocol: see `ab-protocol.mjs` for the
 * measurement that made two seeds mandatory (this very weight measured "stronger"
 * at p = 2.03e-3 on one seed and dead level on another).
 *
 * Two BUILDS of one pilot cannot be compared across branches — both hold the same
 * id, so only one loads at a time, and a same-id control is 50% on both by
 * construction. `runPilotAb` takes pilot OBJECTS, so two weight sets sit in one
 * process and play the same seeded games. Every unordered pair of the sample decks
 * is played in BOTH orientations on matched seeds, so deck strength, seat and who
 * is on the play cancel exactly, and McNemar's test is applied to the slots where
 * the two arms actually disagreed.
 *
 * ⚠️ READ THE LEVEL COUNT FIRST. A weight that changes nothing produces all-level
 * slots — that is "the case never arose", not "no effect". And the raw win totals
 * are the wrong number for the same reason: they include every game the arms played
 * identically, which is usually most of them.
 *
 * Usage:
 *   node packages/sim/bench/weight-ab.mjs --weight attackValueThreshold --value 3
 *   node packages/sim/bench/weight-ab.mjs --weight faceDamageValue --value 0.5 --games 160
 */
import { createHeuristicPilot, DEFAULT_HEURISTIC_WEIGHTS } from '@jonny-boi/ai';
import { buildRegistry, loadCardPool } from '@jonny-boi/cards';
import { SAMPLE_DECKS } from '../dist/data/decks/index.js';
import { loadDeck } from '../dist/src/deck.js';
import { runPilotAb } from '../dist/src/pilot-ab.js';
import { confirmedAb, report, DEV_SEEDS, HELD_OUT_SEEDS } from './ab-protocol.mjs';

function arg(name, fallback) {
  const at = process.argv.indexOf(`--${name}`);
  return at >= 0 ? process.argv[at + 1] : fallback;
}

const WEIGHT = arg('weight', undefined);
const VALUE = Number(arg('value', NaN));
const gamesPerOrientation = Number(arg('games', 40));
// `--seed S` shifts the WHOLE battery, so an entirely fresh set of four is one
// flag away — which is what you want after tuning against the defaults.
const seedShift = Number(arg('seed', 0));

if (!WEIGHT || Number.isNaN(VALUE)) {
  console.error('usage: node packages/sim/bench/weight-ab.mjs --weight <name> --value <number> [--games N] [--seed S] [--confirm-seed S2]');
  process.exit(2);
}
if (!(WEIGHT in DEFAULT_HEURISTIC_WEIGHTS)) {
  console.error(`unknown weight "${WEIGHT}". Known weights:\n  ${Object.keys(DEFAULT_HEURISTIC_WEIGHTS).join('\n  ')}`);
  process.exit(2);
}
const wasValue = DEFAULT_HEURISTIC_WEIGHTS[WEIGHT];
if (wasValue === VALUE) {
  console.error(`${WEIGHT} is already ${VALUE} — that A/B compares a pilot with itself.`);
  process.exit(2);
}

const pool = loadCardPool({ onWarn: () => {} });
const registry = buildRegistry();
const decks = SAMPLE_DECKS.map((deck) => loadDeck(deck, pool));

const outcome = confirmedAb(
  (baseSeed) =>
    runPilotAb({
      decks,
      pilots: {
        // A: the proposed value. B: the pilot exactly as it ships today.
        pilotA: createHeuristicPilot({ ...DEFAULT_HEURISTIC_WEIGHTS, [WEIGHT]: VALUE }),
        pilotB: createHeuristicPilot(DEFAULT_HEURISTIC_WEIGHTS),
      },
      registry,
      gamesPerOrientation,
      baseSeed,
    }),
  seedShift === 0 ? {} : { seeds: DEV_SEEDS.map((x) => x + seedShift), heldOut: HELD_OUT_SEEDS.map((x) => x + seedShift) },
);

report(`${WEIGHT}: ${VALUE} vs ${wasValue} (shipped) — ${decks.length} decks, ` +
    `${gamesPerOrientation} games/pair/orientation, ${outcome.dev[0].result.totalGames} games per run`,
  outcome,
);

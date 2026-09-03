/**
 * IS THIS FORECAST WEIGHT BETTER? — the A/B for the pilot we actually ship.
 *
 * ⚠️ WHY THIS EXISTS SEPARATELY FROM `weight-ab.mjs`. `DEFAULT_PILOT_ID` is
 * `lookahead`, NOT `heuristic`. Lookahead delegates every decision to the
 * heuristic EXCEPT the attack step, which it decides with `combat-forecast.ts`
 * and its own `ForecastWeights`. So a `weight-ab` run tunes a pilot nobody gets
 * by default, and a heuristic-vs-lookahead comparison can only ever disagree
 * about attacks — the two share every other decision by construction, which
 * makes "100% of the gap is in declareAttackers" a tautology rather than a
 * finding. Measuring the SHIPPED pilot needs this file.
 *
 * Same method as its siblings: `runPilotAb` takes pilot OBJECTS, so two weight
 * sets play the same seeded games; every unordered deck pair is played in both
 * orientations on matched seeds; and the verdict comes from the four-seed
 * held-out battery in `ab-protocol.mjs`, not from one run.
 *
 * Usage:
 *   node packages/sim/bench/forecast-ab.mjs --weight crackBackPerPoint --value 0.25
 *   node packages/sim/bench/forecast-ab.mjs --weight racePerTurn --value 2 --games 60
 *   node packages/sim/bench/forecast-ab.mjs --feature gangBlock
 *
 * `--feature <name>` flips a `HeuristicFeatures` flag ON the shipped pilot (§3.108):
 * the heuristic's blocking, spell and land rules all reach lookahead through its
 * delegation, so a feature that changes one of them must be judged HERE as well as
 * by `feature-ab.mjs`, which only ever measures the heuristic pilot.
 */
import { createLookaheadPilot, DEFAULT_FORECAST_WEIGHTS, DEFAULT_HEURISTIC_WEIGHTS } from '@jonny-boi/ai';
import { buildRegistry, loadCardPool } from '@jonny-boi/cards';
import { SAMPLE_DECKS } from '../dist/data/decks/index.js';
import { loadDeck } from '../dist/src/deck.js';
import { runPilotAb } from '../dist/src/pilot-ab.js';
import { confirmedAb, report, DEV_SEEDS, HELD_OUT_SEEDS } from './ab-protocol.mjs';

function arg(name, fallback) {
  const at = process.argv.indexOf(`--${name}`);
  return at >= 0 ? process.argv[at + 1] : fallback;
}

// `--weight` names a FORECAST weight (the attack step lookahead owns); `--heuristic`
// names a HeuristicWeights field, which lookahead delegates — blocking, land
// sequencing and spell choice all live there and all reach the shipped pilot.
const WEIGHT = arg('weight', undefined);
const HEURISTIC_WEIGHT = arg('heuristic', undefined);
const FEATURE = arg('feature', undefined);
const VALUE = Number(arg('value', NaN));
const gamesPerOrientation = Number(arg('games', 40));
const seedShift = Number(arg('seed', 0));

if (HEURISTIC_WEIGHT && !(HEURISTIC_WEIGHT in DEFAULT_HEURISTIC_WEIGHTS)) {
  console.error(`unknown heuristic weight "${HEURISTIC_WEIGHT}"`);
  process.exit(2);
}
if (!WEIGHT && !HEURISTIC_WEIGHT && !FEATURE) {
  console.error(
    'usage: node packages/sim/bench/forecast-ab.mjs (--weight <name> | --heuristic <name>) --value <number> | --feature <name>  [--games N] [--seed S]',
  );
  process.exit(2);
}
if (WEIGHT && !(WEIGHT in DEFAULT_FORECAST_WEIGHTS)) {
  console.error(`unknown forecast weight "${WEIGHT}". Known:\n  ${Object.keys(DEFAULT_FORECAST_WEIGHTS).join('\n  ')}`);
  process.exit(2);
}
const NAME = WEIGHT ?? HEURISTIC_WEIGHT ?? FEATURE;
const wasValue = WEIGHT
  ? DEFAULT_FORECAST_WEIGHTS[WEIGHT]
  : HEURISTIC_WEIGHT
    ? DEFAULT_HEURISTIC_WEIGHTS[HEURISTIC_WEIGHT]
    : false;
if (!FEATURE && wasValue === VALUE) {
  console.error(`${NAME} is already ${VALUE} — that A/B compares a pilot with itself.`);
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
        pilotA: createLookaheadPilot(
          HEURISTIC_WEIGHT ? { ...DEFAULT_HEURISTIC_WEIGHTS, [HEURISTIC_WEIGHT]: VALUE } : DEFAULT_HEURISTIC_WEIGHTS,
          WEIGHT ? { ...DEFAULT_FORECAST_WEIGHTS, [WEIGHT]: VALUE } : DEFAULT_FORECAST_WEIGHTS,
          FEATURE ? { [FEATURE]: true } : {},
        ),
        pilotB: createLookaheadPilot(
          DEFAULT_HEURISTIC_WEIGHTS,
          DEFAULT_FORECAST_WEIGHTS,
          FEATURE ? { [FEATURE]: false } : {},
        ),
      },
      registry,
      gamesPerOrientation,
      baseSeed,
    }),
  seedShift === 0
    ? {}
    : { seeds: DEV_SEEDS.map((x) => x + seedShift), heldOut: HELD_OUT_SEEDS.map((x) => x + seedShift) },
);

report(
  (FEATURE
    ? `lookahead ${FEATURE} ON vs OFF`
    : `lookahead ${NAME}: ${VALUE} vs ${wasValue} (shipped)`) +
    ` — ${decks.length} decks, ${gamesPerOrientation} games/pair/orientation, ${outcome.dev[0].result.totalGames} games per run`,
  outcome,
);

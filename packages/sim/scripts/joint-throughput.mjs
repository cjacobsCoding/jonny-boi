/**
 * THROUGHPUT OF A JOINT PHASE AGAINST THE MANABASE SWEEP IT REUSES (§3.177).
 *
 * The joint search adds no code to the engine's hot path: it is a planner, a
 * reducer and a report. What it DOES do is play the same watched paired arms
 * §3.175 plays, so the honest question is whether a joint phase costs more per
 * GAME than a manabase sweep of the same shape on the same deck, seed and
 * pilot. This script measures both and prints games/sec for each.
 *
 *   node packages/sim/scripts/joint-throughput.mjs [games] [repeats]
 *
 * Committed rather than run once by hand, because a number nobody can reproduce
 * is not a measurement (CLAUDE.md rule 11).
 */
import { buildRegistry, loadCardPool } from '@jonny-boi/cards';
import { createDefaultAiRegistry, HEURISTIC_PILOT_ID } from '@jonny-boi/ai';
import {
  SAMPLE_DECKS,
  finishJointPhase,
  loadDeck,
  planJointPhase,
  prepareSuggestionRun,
  runJointPhase,
  runManabaseSweep,
} from '@jonny-boi/sim';

const GAMES = Number.parseInt(process.argv[2] ?? '8', 10);
const REPEATS = Number.parseInt(process.argv[3] ?? '3', 10);
const SEED = 0xc0ffee;

const pool = loadCardPool({ onWarn: () => {} });
const registry = buildRegistry();
const pilot = createDefaultAiRegistry().getPilot(HEURISTIC_PILOT_ID);
if (!pilot) throw new Error(`no pilot ${HEURISTIC_PILOT_ID}`);
const pilots = { pilotA: pilot, pilotB: pilot };

const hero = SAMPLE_DECKS.find((d) => d.name === 'Selesnya Blink');
const opponent = SAMPLE_DECKS.find((d) => d.name === 'Mono-Red Aggro');
if (!hero || !opponent) throw new Error('the gauntlet decks this script measures are not in SAMPLE_DECKS');
const gauntletDecks = [loadDeck(opponent, pool)];

/** Games/sec of one run, with the games it actually played. */
function timed(label, run) {
  const started = process.hrtime.bigint();
  const games = run();
  const seconds = Number(process.hrtime.bigint() - started) / 1e9;
  return { label, games, seconds, perSecond: games / seconds };
}

const rows = [];
for (let i = 0; i < REPEATS; i++) {
  rows.push(
    timed('manabase sweep (§3.175)', () => {
      const report = runManabaseSweep(hero, {
        gauntletDecks,
        pilots,
        pool,
        registry,
        baseSeed: SEED,
        gamesPerVariant: GAMES,
        sweep: { sweeps: { count: true, mix: true, type: false }, countRadius: 1, mixRadius: 1 },
        maxVariants: 6,
      });
      return report.notes.totalGamesRun;
    }),
  );
  // LIKE FOR LIKE: the joint phase under §3.175's own partner rule enumerates the
  // SAME family the sweep does (count + mix, radius 1), so this row and the one
  // above play the same decks on the same seeds. The difference between them is
  // the joint search's OVERHEAD. A difference against the measured-partner row
  // below is the different DECKS that rule builds, not the code.
  rows.push(
    timed('joint phase, §3.175 partner rule (same family)', () => {
      const report = runJointPhase(hero, {
        pool,
        phase: 'manabase',
        round: 0,
        gauntletDecks,
        pilots,
        registry,
        baseSeed: SEED,
        gamesPerMove: GAMES,
        partnerRule: 'cheapest-nonland',
        countRadius: 1,
        mixRadius: 1,
        maxMoves: 6,
      });
      return report.gamesPlayed;
    }),
  );
  rows.push(
    timed('joint phase, measured partners (§3.177)', () => {
      const report = runJointPhase(hero, {
        pool,
        phase: 'manabase',
        round: 0,
        gauntletDecks,
        pilots,
        registry,
        baseSeed: SEED,
        gamesPerMove: GAMES,
        countRadius: 1,
        mixRadius: 1,
        partnersPerCountStep: 2,
        maxMoves: 6,
      });
      return report.gamesPlayed;
    }),
  );
}

/** The MEDIAN of the repeats, per label — one slow run is the machine, not the code. */
function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

const labels = [...new Set(rows.map((r) => r.label))];
const summary = labels.map((label) => {
  const mine = rows.filter((r) => r.label === label);
  return {
    label,
    games: mine.map((r) => r.games).join('/'),
    perSecond: median(mine.map((r) => r.perSecond)),
  };
});

for (const row of rows) {
  console.log(`  ${row.label}: ${row.games} games in ${row.seconds.toFixed(2)}s = ${row.perSecond.toFixed(1)} games/s`);
}
console.log('');
for (const row of summary) {
  console.log(`MEDIAN ${row.label}: ${row.perSecond.toFixed(1)} games/s (games ${row.games})`);
}
const [sweep, same, measured] = summary;
console.log('');
if (sweep && same) {
  console.log(
    `OVERHEAD (same family, identical decks): ${(same.perSecond / sweep.perSecond).toFixed(3)}× the manabase sweep`,
  );
}
if (sweep && measured) {
  console.log(
    `DECK EFFECT (measured partners build DIFFERENT decks): ${(measured.perSecond / sweep.perSecond).toFixed(3)}× — ` +
      'a games/sec difference here is the games those decks play, not the search.',
  );
}

/*
 * The pure work the joint search ADDS over a manabase plan: enumerating a
 * PARTNERED family. Timed on its own, because it is the only code in this lane
 * that is not already on the §3.175 per-game path — and a plan runs once per
 * phase against thousands of games, so this is the honest denominator.
 */
const PLANS = 20;
function timePlan(label, run) {
  const started = process.hrtime.bigint();
  for (let i = 0; i < PLANS; i++) run();
  const ms = Number(process.hrtime.bigint() - started) / 1e6 / PLANS;
  console.log(`PLAN ${label}: ${ms.toFixed(2)} ms/plan`);
}
timePlan('joint manabase phase (measured partners)', () =>
  planJointPhase(hero, { pool, phase: 'manabase', round: 0, opponentCount: 1, baseSeed: SEED, gamesPerMove: GAMES }),
);
timePlan('joint spell phase', () =>
  planJointPhase(hero, { pool, phase: 'spells', round: 0, opponentCount: 1, baseSeed: SEED, gamesPerMove: GAMES }),
);
// The bar a joint plan has to clear: a SUGGEST plan enumerates the same
// candidate space over the same pool. The spell phase IS one of these with both
// sides filtered to nonlands, so it should cost about the same — and if it ever
// costs much more, this row is where that shows.
timePlan('suggest plan (the same generator, for scale)', () =>
  prepareSuggestionRun(hero, { pool, opponentCount: 1, baseSeed: SEED, gamesPerCandidate: GAMES }),
);
// Imported so the script fails loudly if the finisher ever leaves the surface.
void finishJointPhase;

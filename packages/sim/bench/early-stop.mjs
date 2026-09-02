/**
 * HOW MANY GAMES DID THE VERDICT ACTUALLY NEED?
 *
 * Every speed axis measured so far is about making the work cheaper: per-action
 * cost (§3.78), action count (§3.79), decision cost (§3.81). This asks the other
 * question — how much of the work was needed AT ALL.
 *
 * A paired A/B plays a fixed number of games and then tests the 2x2 table. But the
 * table is built up slot by slot, and for a swap that is clearly good or clearly
 * neutral the answer is often settled long before the last game. This replays a
 * real paired run in slot order and finds the earliest point at which the verdict
 * was already the final one AND already significant — the game count a sequential
 * stopping rule could have used.
 *
 * ⚠️ WHAT THIS DOES NOT CLAIM. Stopping early is only sound if the rule is fixed
 * in advance; peeking at every slot and stopping at the first p < 0.05 inflates
 * the false-positive rate badly. The number below is therefore an UPPER BOUND on
 * the saving — the best a properly-calibrated sequential test could hope for, not
 * what one would deliver. It exists to answer "is there anything here?" before
 * anyone builds one.
 *
 * Usage: node packages/sim/bench/early-stop.mjs [--games N] [--swaps K]
 */
import { buildRegistry, loadCardPool } from '@jonny-boi/cards';
import { createDefaultAiRegistry, HEURISTIC_PILOT_ID } from '@jonny-boi/ai';
import { SAMPLE_DECKS } from '../dist/data/decks/index.js';
import { loadDeck } from '../dist/src/deck.js';
import { createPairedArmRunner } from '../dist/src/paired-arms.js';
import { mcNemarTest } from '../dist/src/stats.js';

const arg = (name, fallback) => {
  const at = process.argv.indexOf(`--${name}`);
  return at >= 0 ? Number(process.argv[at + 1]) : fallback;
};
const GAMES = arg('games', 60);
const SWAPS = arg('swaps', 6);
const ALPHA = 0.05;

const pool = loadCardPool({ onWarn: () => {} });
const registry = buildRegistry();
const ai = createDefaultAiRegistry();
const pilots = { pilotA: ai.getPilot(HEURISTIC_PILOT_ID), pilotB: ai.getPilot(HEURISTIC_PILOT_ID) };

const base = SAMPLE_DECKS[0];
const gauntlet = SAMPLE_DECKS.filter((d) => d.name !== base.name).map((d) => loadDeck(d, pool));

// A handful of real swaps: replace one card of the base deck with another card
// already in the pool's sample decks, so every arm is legal without a search.
const baseNames = [...new Set(base.cards.map((c) => c.cardId))];
const otherNames = [
  ...new Set(SAMPLE_DECKS.filter((d) => d.name !== base.name).flatMap((d) => d.cards.map((c) => c.cardId))),
].filter((n) => !baseNames.includes(n));

const runner = createPairedArmRunner(base, {
  gauntletDecks: gauntlet,
  pilots,
  pool,
  registry,
  seed: 20260901,
});

const capacity = runner.slotCapacity(GAMES);
let examined = 0;
let totalSlots = 0;
let neededSlots = 0;
const rows = [];

for (let i = 0; i < SWAPS && i < otherNames.length; i++) {
  const outName = baseNames[i % baseNames.length];
  const inName = otherNames[i];
  let handle;
  try {
    handle = runner.openArm({ out: outName, in: inName }, outName, inName);
  } catch {
    continue; // illegal swap (copy limits, colours) — not what this measures
  }

  // Walk the arm one slot at a time so the table is available at every prefix.
  const table = { bothWon: 0, baseOnly: 0, variantOnly: 0, neither: 0 };
  let firstSettled = -1;
  for (let slot = 1; slot <= capacity; slot++) {
    const arm = runner.advance(handle, slot);
    table.bothWon = arm.paired.bothWon;
    table.baseOnly = arm.paired.baseOnly;
    table.variantOnly = arm.paired.variantOnly;
    table.neither = arm.paired.neither;
    const p = mcNemarTest(table).pValue;
    if (p < ALPHA && firstSettled < 0) firstSettled = slot;
    if (p >= ALPHA) firstSettled = -1; // it must STAY settled to count
  }
  const finalP = mcNemarTest(table).pValue;
  const settledAt = finalP < ALPHA ? firstSettled : capacity; // never-significant arms need every game
  examined++;
  totalSlots += capacity;
  neededSlots += settledAt < 0 ? capacity : settledAt;
  rows.push(
    `  ${outName} -> ${inName}: final p ${finalP.toExponential(2)}, ` +
      `settled at ${settledAt < 0 ? 'never' : settledAt}/${capacity} slots`,
  );
}

console.log(`${examined} swaps x ${capacity} paired slots (${GAMES} games/matchup, ${gauntlet.length} opponents)\n`);
for (const row of rows) console.log(row);
console.log(
  `\nslots played: ${totalSlots}; slots a perfectly-calibrated sequential test would need: ${neededSlots}` +
    ` (${((neededSlots / totalSlots) * 100).toFixed(0)}%)`,
);
console.log(
  `UPPER BOUND on the speed-up from early stopping: ${(totalSlots / Math.max(1, neededSlots)).toFixed(2)}x`,
);
console.log('\n⚠️ An upper bound only: stopping at the first p < alpha inflates false positives badly.');
console.log('   A real sequential test spends games to control that, and delivers less than this.');

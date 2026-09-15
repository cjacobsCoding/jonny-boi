/**
 * MEASURE THE STORAGE BUDGET — what a real game actually costs on disk.
 *
 * `lib/persistence/budget.ts` divides one origin-wide localStorage budget among
 * the features that share it. The shares in that table have to come from DATA,
 * not from intuition: the number they replaced — 4,000,000 characters for the
 * game library alone, against an origin that is 2,500,000 characters on the most
 * conservative real browsers — is what let the library starve the saved decks
 * and lose two imported decks.
 *
 * So this script plays real games with the real engine and the real pilots,
 * encodes each one exactly the way `lib/play/persist.ts` does, and prints the
 * sizes the table is set from. Committed rather than run once, so the next
 * person to move a share re-measures instead of guessing (CLAUDE.md rule 11).
 *
 *   node apps/web/scripts/measure-storage-budget.mjs [games]
 */
import { SAMPLE_DECKS, loadDeck, runMatch } from '@jonny-boi/sim';
import { loadCardPool, buildRegistry } from '@jonny-boi/cards';
import { getPilot, SELECTABLE_PILOT_IDS } from '@jonny-boi/ai';

const GAMES = Number(process.argv[2] ?? 12);
const PILOT_ID = SELECTABLE_PILOT_IDS[0];

/** The exact record shape `persist.ts` stores — nothing added, nothing dropped. */
function recordFor(deckA, deckB, actions, seed) {
  return {
    version: 1,
    savedAt: Date.now(),
    setup: {
      names: { A: 'You', B: 'Opponent' },
      deckA,
      deckB,
      startingPlayer: 'A',
      seed,
      ai: { seat: 'B', pilotId: PILOT_ID },
    },
    mulligans: [],
    actions,
    ui: { revealed: 'A', scrollY: 0, turn: 1 },
  };
}

const pool = loadCardPool({ onWarn: () => {} });
const registry = buildRegistry();
const pilot = getPilot(PILOT_ID);

const sizes = [];
let totalActions = 0;

for (let i = 0; i < GAMES; i += 1) {
  const deckA = SAMPLE_DECKS[i % SAMPLE_DECKS.length];
  const deckB = SAMPLE_DECKS[(i + 1) % SAMPLE_DECKS.length];
  const loadedA = loadDeck(deckA, pool);
  const loadedB = loadDeck(deckB, pool);
  if (loadedA instanceof Error || loadedB instanceof Error) {
    console.error('deck load failed:', loadedA, loadedB);
    process.exit(1);
  }
  const seed = 1000 + i;
  const result = runMatch(
    { deckA: loadedA, deckB: loadedB, pilotA: pilot, pilotB: pilot, registry },
    seed,
    { recordTrace: true },
  );
  const actions = (result.decisions ?? []).map((d) => d.action);
  totalActions += actions.length;
  sizes.push({
    actions: actions.length,
    turns: result.turns,
    chars: JSON.stringify(recordFor(deckA, deckB, actions, seed)).length,
  });
}

if (sizes.length === 0) {
  console.error('no games measured');
  process.exit(1);
}

const chars = sizes.map((s) => s.chars).sort((a, b) => a - b);
const sum = chars.reduce((a, b) => a + b, 0);
const mean = Math.round(sum / chars.length);
const at = (q) => chars[Math.min(chars.length - 1, Math.floor(q * chars.length))];
const n = (v) => v.toLocaleString('en-US');

console.log(`games measured    ${sizes.length}  (pilot ${PILOT_ID})`);
console.log(
  `actions per game  min ${Math.min(...sizes.map((s) => s.actions))}  ` +
    `max ${Math.max(...sizes.map((s) => s.actions))}  ` +
    `mean ${Math.round(totalActions / sizes.length)}`,
);
console.log('');
console.log('ONE persisted game record, in characters:');
console.log(`  min      ${n(chars[0])}`);
console.log(`  median   ${n(at(0.5))}`);
console.log(`  p90      ${n(at(0.9))}`);
console.log(`  max      ${n(chars[chars.length - 1])}`);
console.log(`  mean     ${n(mean)}`);
console.log('');
console.log('What that implies for the budget table:');
console.log(`  play-in-progress must hold ONE record  ->  >= ${n(chars[chars.length - 1])} (max seen)`);
for (const games of [10, 20, 50]) {
  console.log(`  a ${String(games).padStart(2)}-game library at the mean       ->  ${n(mean * games)}`);
}
console.log('');
console.log('NOTE: these are AI-vs-AI games on the sample decks. A human game is');
console.log('longer per turn in decisions but the same shape; treat the max as the');
console.log('floor for play-in-progress, not as the ceiling.');

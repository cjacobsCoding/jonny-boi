/**
 * WHERE DOES THE HEURISTIC DISAGREE WITH SEARCH?
 *
 * `lookahead` plays real engine rollouts, and head-to-head it beats the
 * heuristic — but only on 42 matched slots to 10, with 88% level. So the two
 * agree almost everywhere, and the interesting question is not "who wins" but
 * WHERE THEY DIFFER: those windows are the entire remaining strength gap, and
 * they are a shortlist of things worth teaching the cheap pilot.
 *
 * The game is driven by ONE pilot (so the position stays on-policy and both are
 * judging the same reachable states); the other is asked at each window and its
 * answer recorded, never played.
 *
 * Usage: node packages/sim/bench/oracle-diff.mjs [--games N]
 */
import { createDefaultAiRegistry, HEURISTIC_PILOT_ID, LOOKAHEAD_PILOT_ID } from '@jonny-boi/ai';
import { buildRegistry, loadCardPool } from '@jonny-boi/cards';
import { applyAction, createGame, createRng, DEFAULT_RULES, generateLegalActions } from '@jonny-boi/core';
import { SAMPLE_DECKS } from '../dist/data/decks/index.js';
import { loadDeck } from '../dist/src/deck.js';

const at = process.argv.indexOf('--games');
const GAMES = at >= 0 ? Number(process.argv[at + 1]) : 6;

const pool = loadCardPool({ onWarn: () => {} });
const registry = buildRegistry();
const ai = createDefaultAiRegistry();
const cheap = ai.getPilot(HEURISTIC_PILOT_ID);
const oracle = ai.getPilot(LOOKAHEAD_PILOT_ID);
const deckOf = (n) => loadDeck(SAMPLE_DECKS.find((d) => d.name === n), pool);

/** A comparable fingerprint: the kind, plus what it aimed at. */
const shape = (a) => {
  if (!a) return 'none';
  if (a.kind === 'declareAttackers') return `declareAttackers[${a.attackers.length}]`;
  if (a.kind === 'declareBlockers') return `declareBlockers[${a.blocks.length}]`;
  if (a.kind === 'castSpell' || a.kind === 'playLand' || a.kind === 'activateAbility') {
    return `${a.kind}`;
  }
  return a.kind;
};

let windows = 0;
let disagreements = 0;
const byPair = new Map();

for (const [nameA, nameB] of [
  ['Mono-Red Aggro', 'UW Control'],
  ['Mono-Green Ramp', 'Golgari Midrange'],
]) {
  const A = deckOf(nameA);
  const B = deckOf(nameB);
  for (let g = 0; g < GAMES; g++) {
    const { state } = createGame({
      seed: 77 + g,
      startingPlayer: g % 2 === 0 ? 'A' : 'B',
      registry,
      decks: { A: { cards: A.library }, B: { cards: B.library } },
    });
    let s = state;
    const rngs = { A: createRng(11 + g), B: createRng(9011 + g) };
    for (let i = 0; i < 3000 && !s.gameOver; i++) {
      const legal = generateLegalActions(s, DEFAULT_RULES);
      if (legal.length === 0) break;
      const ctx = {
        view: s, legalActions: legal, rng: rngs[s.priorityPlayer], registry,
        rulesConfig: DEFAULT_RULES, observer: undefined,
      };
      const mine = cheap.chooseAction(ctx);
      // Only ask the expensive pilot where there is a real choice to make.
      if (legal.length > 1) {
        windows += 1;
        const theirs = oracle.chooseAction(ctx);
        const a = shape(mine);
        const b = shape(theirs);
        if (a !== b) {
          disagreements += 1;
          const key = `${s.step}: heuristic=${a} vs lookahead=${b}`;
          byPair.set(key, (byPair.get(key) ?? 0) + 1);
        }
      }
      s = applyAction(s, mine, DEFAULT_RULES, registry).state;
    }
  }
}
console.log(`windows with a real choice : ${windows}`);
console.log(`disagreements              : ${disagreements} (${((disagreements / Math.max(1, windows)) * 100).toFixed(1)}%)`);
console.log('top disagreement shapes:');
for (const [key, n] of [...byPair].sort((x, y) => y[1] - x[1]).slice(0, 14)) {
  console.log(`  ${String(n).padStart(4)}  ${key}`);
}

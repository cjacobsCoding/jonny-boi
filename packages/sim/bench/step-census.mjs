/**
 * STEP CENSUS — what fraction of a game's actions are pure step advancement?
 *
 * The profile (§3.78) says no single function is worth attacking. That leaves
 * the other axis: not "make each action cheaper" but "perform fewer actions".
 * This counts, over real games, how many applied actions are a pass in a window
 * where NOTHING could have happened — an empty stack, no pending choice, and a
 * menu offering nothing but the pass itself — broken down by step, so the answer
 * says WHERE the dead windows are and not merely how many.
 */
import { createDefaultAiRegistry, HEURISTIC_PILOT_ID } from '@jonny-boi/ai';
import { buildRegistry, loadCardPool } from '@jonny-boi/cards';
import { applyAction, createGame, createRng, DEFAULT_RULES, generateLegalActions } from '@jonny-boi/core';
import { SAMPLE_DECKS } from '../dist/data/decks/index.js';
import { loadDeck } from '../dist/src/deck.js';

const pool = loadCardPool({ onWarn: () => {} });
const registry = buildRegistry();
const pilot = createDefaultAiRegistry().getPilot(HEURISTIC_PILOT_ID);
const deckOf = (n) => loadDeck(SAMPLE_DECKS.find((d) => d.name === n), pool);
const A = deckOf('Mono-Red Aggro');
const B = deckOf('UW Control');

const GAMES = Number(process.argv.includes('--games') ? process.argv[process.argv.indexOf('--games') + 1] : 200);

let actions = 0;
let deadPasses = 0;
let realPlays = 0;
let livePasses = 0;
const deadByStep = new Map();
const allByStep = new Map();
const bump = (m, k) => m.set(k, (m.get(k) ?? 0) + 1);

for (let g = 0; g < GAMES; g++) {
  const { state } = createGame({
    seed: 7 + g,
    startingPlayer: g % 2 === 0 ? 'A' : 'B',
    decks: { A: { cards: A.library }, B: { cards: B.library } },
    registry,
  });
  let s = state;
  const rngs = { A: createRng(1 + g), B: createRng(9001 + g) };
  for (let i = 0; i < 4000 && !s.gameOver; i++) {
    const legal = generateLegalActions(s, DEFAULT_RULES);
    if (legal.length === 0) break;
    const action = pilot.chooseAction({
      view: s,
      legalActions: legal,
      rng: rngs[s.priorityPlayer],
      registry,
      rulesConfig: DEFAULT_RULES,
      observer: undefined,
    });
    actions++;
    bump(allByStep, s.step);
    // A DEAD window: the only thing on offer was the pass, nothing was waiting on
    // the stack, and no choice was parked. Nothing a pilot could have done here.
    const onlyPass = legal.length === 1 && legal[0].kind === 'passPriority';
    if (onlyPass && s.stack.length === 0 && !s.pendingChoice) {
      deadPasses++;
      bump(deadByStep, s.step);
    } else if (action.kind === 'passPriority') {
      livePasses++;
    } else {
      realPlays++;
    }
    s = applyAction(s, action, DEFAULT_RULES, registry).state;
  }
}


// The two dimensions this census separates, because they are different problems:
//
//  DEAD passes are a SPEED question. Nothing was on offer but the pass, so the
//    pilot had no decision to make and the round-trip bought nothing. The gate
//    (`willPassPriority`) already skips menu-building for most of them — the ones
//    left are the steps it refuses to judge cheaply, and they are the only dead
//    windows still paying full price.
//  LIVE passes are a STRENGTH question. The pilot COULD have acted and chose not
//    to. Every misplay of omission this engine can make lives in that band, and
//    it is far larger than the band where the pilot actually does something.
//
// Reporting them together, and never as one "passes" number, is the point: a
// change that moves one has no claim on the other.

const pct = (n) => `${((n / actions) * 100).toFixed(1)}%`;
console.log(`${GAMES} games, ${actions} actions (${(actions / GAMES).toFixed(0)} per game)\n`);
console.log(`  dead passes (nothing was possible):   ${deadPasses}  ${pct(deadPasses)}`);
console.log(`  live passes (could have acted, chose not to): ${livePasses}  ${pct(livePasses)}`);
console.log(`  real plays:                           ${realPlays}  ${pct(realPlays)}\n`);
console.log('dead passes by step (dead / all in that step):');
for (const [step, all] of [...allByStep.entries()].sort((a, b) => b[1] - a[1])) {
  const dead = deadByStep.get(step) ?? 0;
  console.log(
    `  ${step.padEnd(20)} ${String(dead).padStart(7)} / ${String(all).padStart(7)}  ${((dead / all) * 100).toFixed(0)}%`,
  );
}
console.log(
  `\nCeiling: removing every dead pass would cut ${pct(deadPasses)} of applied actions.`,
);

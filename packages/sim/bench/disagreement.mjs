/**
 * WHERE DO THE PILOTS DISAGREE? — the map of what is left to win.
 *
 * The heuristic and `lookahead` (which does real engine rollouts) agree on 99% of
 * decisions, and lookahead wins the head-to-head. Both facts are already measured.
 * Neither says WHICH decisions the 1% are — and every gain available from better
 * play is concentrated in exactly those, so that is the map worth having before
 * anyone writes another heuristic rule.
 *
 * Method: record every (state, legalActions) from real games driven by the
 * heuristic, then ask BOTH pilots about each one and classify the disagreements by
 * action kind and by step. Recording under one pilot and asking both is deliberate:
 * it holds the state distribution fixed, so the comparison is "given the same
 * board, what would each do?" rather than two pilots drifting into different games.
 *
 * ⚠️ A DISAGREEMENT IS NOT A MISPLAY. Lookahead is stronger overall but not
 * optimal, and many disagreements are between two fine lines. This ranks where to
 * LOOK; only an A/B on matched slots can say whether a change is an improvement.
 *
 * Usage: node packages/sim/bench/disagreement.mjs [--games N] [--pilot id]
 */
import { createDefaultAiRegistry, HEURISTIC_PILOT_ID } from '@jonny-boi/ai';
import { buildRegistry, loadCardPool } from '@jonny-boi/cards';
import { applyAction, createGame, createRng, DEFAULT_RULES, generateLegalActions } from '@jonny-boi/core';
import { SAMPLE_DECKS } from '../dist/data/decks/index.js';
import { loadDeck } from '../dist/src/deck.js';

const arg = (name, fallback) => {
  const at = process.argv.indexOf(`--${name}`);
  return at >= 0 ? process.argv[at + 1] : fallback;
};
const GAMES = Number(arg('games', 40));
const RIVAL_ID = arg('pilot', 'lookahead');

const pool = loadCardPool({ onWarn: () => {} });
const registry = buildRegistry();
const ai = createDefaultAiRegistry();
const base = ai.getPilot(HEURISTIC_PILOT_ID);
const rival = ai.getPilot(RIVAL_ID);
if (!rival) {
  console.error(`unknown pilot "${RIVAL_ID}". Known: ${ai.list?.().map((p) => p.id).join(', ') ?? '(registry has no list())'}`);
  process.exit(2);
}
const deckOf = (n) => loadDeck(SAMPLE_DECKS.find((d) => d.name === n), pool);

const MATCHUPS = [
  ['Mono-Red Aggro', 'UW Control'],
  ['Mono-Green Ramp', 'Golgari Midrange'],
  ['Orzhov Lifegain', 'Izzet Prowess'],
];

/** A comparable fingerprint of an action — kind plus whatever identifies its object. */
function signature(action) {
  if (!action) return 'none';
  const parts = [action.kind];
  if (action.instanceId !== undefined) parts.push(`#${action.instanceId}`);
  if (action.abilityIndex !== undefined) parts.push(`a${action.abilityIndex}`);
  if (Array.isArray(action.attackers)) parts.push(`atk[${[...action.attackers].sort().join(',')}]`);
  if (action.blocks) parts.push(`blk${JSON.stringify(action.blocks)}`);
  if (action.targets) parts.push(`tgt${JSON.stringify(action.targets)}`);
  return parts.join(' ');
}

let decisions = 0;
let disagreements = 0;
const byKind = new Map();
const byStep = new Map();
const swaps = new Map(); // "heuristic-kind -> rival-kind"
const bump = (m, k) => m.set(k, (m.get(k) ?? 0) + 1);

for (const [aName, bName] of MATCHUPS) {
  const A = deckOf(aName);
  const B = deckOf(bName);
  for (let g = 0; g < GAMES; g++) {
    const { state } = createGame({
      seed: 211 + g,
      startingPlayer: g % 2 === 0 ? 'A' : 'B',
      decks: { A: { cards: A.library }, B: { cards: B.library } },
      registry,
    });
    let s = state;
    const rngs = { A: createRng(17 + g), B: createRng(6101 + g) };
    for (let i = 0; i < 4000 && !s.gameOver; i++) {
      const legalActions = generateLegalActions(s, DEFAULT_RULES);
      if (legalActions.length === 0) break;
      // Only windows with a REAL choice can be disagreed about.
      if (legalActions.length > 1) {
        const ctx = {
          view: s,
          legalActions,
          rng: createRng(4242), // identical rng for both, so a tie-break is not a "disagreement"
          registry,
          rulesConfig: DEFAULT_RULES,
          observer: undefined,
        };
        const mine = base.chooseAction(ctx);
        const theirs = rival.chooseAction({ ...ctx, rng: createRng(4242) });
        decisions++;
        if (signature(mine) !== signature(theirs)) {
          disagreements++;
          bump(byKind, `${mine.kind} -> ${theirs.kind}`);
          bump(byStep, s.step);
          bump(swaps, mine.kind === theirs.kind ? `same kind, different choice: ${mine.kind}` : 'different kind');
        }
      }
      const action = base.chooseAction({
        view: s,
        legalActions,
        rng: rngs[s.priorityPlayer],
        registry,
        rulesConfig: DEFAULT_RULES,
        observer: undefined,
      });
      s = applyAction(s, action, DEFAULT_RULES, registry).state;
    }
  }
}

const pct = (n) => `${((n / decisions) * 100).toFixed(2)}%`;
console.log(`heuristic vs ${RIVAL_ID} — ${GAMES * MATCHUPS.length} games`);
console.log(`decisions with a real choice : ${decisions}`);
console.log(`disagreements                : ${disagreements} (${pct(disagreements)})\n`);

const top = (m, label, limit) => {
  console.log(label);
  const rows = [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit);
  for (const [k, n] of rows) {
    console.log(`  ${String(n).padStart(6)}  ${((n / Math.max(1, disagreements)) * 100).toFixed(1).padStart(5)}%  ${k}`);
  }
  console.log('');
};
top(byKind, 'by transition (what the heuristic did -> what the rival did):', 12);
top(byStep, 'by step:', 12);
top(swaps, 'shape:', 4);
console.log('⚠️ A disagreement is not a misplay. This ranks where to LOOK; only an A/B on');
console.log('   matched slots can say whether a change is an improvement.');

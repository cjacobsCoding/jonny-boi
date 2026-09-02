/**
 * THE SAFETY HARNESS FOR ANY COMBAT FAST-PASS PRE-CHECK — and the record of one
 * that was tried, measured, and NOT shipped.
 *
 * `heuristicWillPass` (§3.62) refuses to judge `declareAttackers`/`declareBlockers`
 * cheaply and returns `false` for both, so every combat window builds a full menu.
 * The census (§3.79) found 4,414 of those per 109k actions offering nothing but a
 * pass. The obvious fix — "no untapped creature, so nothing to declare" — was
 * written, and this harness was written to prove it safe. It was not:
 *
 *   declareAttackers   handed over  10860, of which UNSAFE      0
 *   declareBlockers    handed over  10226, of which UNSAFE   3179   <-- WRONG
 *
 * ⚠️ THE TRAP: "declare NO blockers" is ITSELF a declaration the engine offers, so
 * a defending seat with nothing untapped is still being asked something. No creature
 * count can rule that window out. Narrowing the rule to the attacking seat only made
 * it safe (17,907 windows handed over, 0 unsafe) and left outcomes byte-identical —
 * but the wall clock did not move: 196 games/sec against a 197-204 spread on
 * IDENTICAL code. Under 1% of actions were affected, which is below this machine's
 * noise floor, so a fifteen-line special case in a correctness-critical function
 * bought nothing measurable and was reverted.
 *
 * The harness stays because the TRAP is permanent. Anyone attempting this again
 * should edit `combatDecisionIsReal` below to match their rule and run this first:
 * a timing run cannot see the failure mode, because skipping a live window makes
 * the pilot silently weaker rather than wrong.
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

const isCreatureDef = (def) => (def.types ?? []).some((t) => String(t).toLowerCase() === 'creature');
const controlsUntapped = (view, seat) =>
  view.battlefield.some((p) => p.controller === seat && !p.tapped && isCreatureDef(p.def));

/** The exact condition the new gate code uses to decline to judge a window. */
function combatDecisionIsReal(view) {
  const me = view.priorityPlayer;
  if (view.step === 'declareAttackers') {
    return me === view.activePlayer && view.combat?.attackersDeclared === false && controlsUntapped(view, me);
  }
  if (view.step === 'declareBlockers') {
    return me !== view.activePlayer && view.combat?.blockersDeclared === false;
  }
  return null; // not a combat-declaration window
}

let combatWindows = 0;
let nowJudged = 0; // windows the old gate refused outright, the new one may pass
let unsafe = 0; // ⚠️ judged "nothing to do" while a real option was on offer
const unsafeByStep = new Map();
const judgedByStep = new Map();

for (let g = 0; g < 300; g++) {
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
    const real = combatDecisionIsReal(s);
    if (real !== null) {
      combatWindows++;
      if (!real) {
        nowJudged++;
        judgedByStep.set(s.step, (judgedByStep.get(s.step) ?? 0) + 1);
        // The safety property: if the pre-check says "no declaration to make",
        // the menu must not contain a declaration either.
        const hasDeclaration = legal.some(
          (a) => a.kind === 'declareAttackers' || a.kind === 'declareBlockers',
        );
        if (hasDeclaration) {
          unsafe++;
          unsafeByStep.set(s.step, (unsafeByStep.get(s.step) ?? 0) + 1);
        }
      }
    }
    const action = pilot.chooseAction({
      view: s,
      legalActions: legal,
      rng: rngs[s.priorityPlayer],
      registry,
      rulesConfig: DEFAULT_RULES,
      observer: undefined,
    });
    s = applyAction(s, action, DEFAULT_RULES, registry).state;
  }
}

console.log(`combat-declaration windows seen: ${combatWindows}`);
console.log(
  `the old gate refused to judge ALL of them; the new pre-check hands ${nowJudged} ` +
    `(${((nowJudged / combatWindows) * 100).toFixed(1)}%) to the normal reasoning`,
);
console.log(
  unsafe === 0
    ? '\nSAFE: in every one of those windows the menu contained no declaration to make.'
    : `\n⚠️ UNSAFE: ${unsafe} windows had a declaration on offer.`,
);
for (const [step, n] of judgedByStep) {
  console.log(`  ${step.padEnd(18)} handed over ${String(n).padStart(6)}, of which UNSAFE ${String(unsafeByStep.get(step) ?? 0).padStart(6)}`);
}

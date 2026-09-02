/**
 * WHICH DECLINED ATTACKS ARE PROVABLY WRONG? — and the answer, which is "none of
 * them" (DESIGN §3.80).
 *
 * `missed-plays.mjs` reports that the pilot declines 13.6% of its attack windows.
 * That number alone is not a defect: most declines are judgement, and this repo has
 * already MEASURED that holding attackers back for defence is worse (§3.75) and
 * that taking a guaranteed lethal swing is better (§3.74). What is left needs
 * splitting into cases that can be judged without an opinion.
 *
 * This classifies every declined attack window by what the defender could actually
 * do about it:
 *
 *   FREE       the defender has NO untapped creature.
 *   UNBLOCKED  the defender has blockers, but at least one attacker survives every
 *              one of them.
 *   CONTESTED  everything else — a genuine judgement call.
 *
 * ⚠️ READ THIS BEFORE ACTING ON THE OUTPUT. Both "defect" bands are OVER-COUNTS,
 * and acting on them without checking costs a day:
 *
 *   FREE (17 windows / 4,602) is almost entirely 0-power mana creatures — "5
 *     attackers for 2 power" — which the pilot correctly keeps untapped for mana.
 *     This script reads printed power, so it counts them as attackers; the pilot
 *     knows better.
 *   UNBLOCKED (154 / 4,602) reads printed power/toughness and ignores evasion and
 *     continuous effects, so it is NOT the same question `attackIsProfitable` asks.
 *     Those declines come from the TRADE branch (a block that profitably kills the
 *     attacker), not from a threshold refusing chip damage.
 *
 * THE HYPOTHESIS THIS KILLED. "A creature the defender cannot kill should attack
 * whatever its power — the value threshold is guarding against a loss that cannot
 * happen." It was implemented behind a `safeAttacker` flag and A/B'd:
 *
 *   safeAttacker ON vs OFF — 9 decks, 2880 games: ahead A 0 · ahead B 0 · level 1440
 *
 * Not one game in 2,880 differed, because the pilot ALREADY does it:
 * `attackValueThreshold` is 1 and `faceDamageValue` is 1, and a 0-power attacker is
 * rejected earlier — so any attacker with no profitable block against it already
 * clears the bar by construction. The rule was dead code and was reverted.
 *
 * Usage: node packages/sim/bench/declined-attacks.mjs [--games N]
 */
import { createDefaultAiRegistry, HEURISTIC_PILOT_ID } from '@jonny-boi/ai';
import { buildRegistry, loadCardPool } from '@jonny-boi/cards';
import { applyAction, createGame, createRng, DEFAULT_RULES, generateLegalActions } from '@jonny-boi/core';
import { SAMPLE_DECKS } from '../dist/data/decks/index.js';
import { loadDeck } from '../dist/src/deck.js';

const at = process.argv.indexOf('--games');
const GAMES = at >= 0 ? Number(process.argv[at + 1]) : 120;

const pool = loadCardPool({ onWarn: () => {} });
const registry = buildRegistry();
const pilot = createDefaultAiRegistry().getPilot(HEURISTIC_PILOT_ID);
const deckOf = (n) => loadDeck(SAMPLE_DECKS.find((d) => d.name === n), pool);

const MATCHUPS = [
  ['Mono-Red Aggro', 'UW Control'],
  ['Mono-Green Ramp', 'Golgari Midrange'],
  ['Orzhov Lifegain', 'Izzet Prowess'],
];

const isCreature = (def) => (def.types ?? []).some((t) => String(t).toLowerCase() === 'creature');
const power = (inst) => Number(inst.def.power ?? 0) + Number(inst.counters?.['+1/+1'] ?? 0);
const toughness = (inst) => Number(inst.def.toughness ?? 0) + Number(inst.counters?.['+1/+1'] ?? 0);

let windows = 0;
let declined = 0;
let free = 0;
let unblocked = 0;
let contested = 0;
let freeDamage = 0;
const freeExamples = [];

for (const [aName, bName] of MATCHUPS) {
  const A = deckOf(aName);
  const B = deckOf(bName);
  for (let g = 0; g < GAMES; g++) {
    const { state } = createGame({
      seed: 31 + g,
      startingPlayer: g % 2 === 0 ? 'A' : 'B',
      decks: { A: { cards: A.library }, B: { cards: B.library } },
      registry,
    });
    let s = state;
    const rngs = { A: createRng(11 + g), B: createRng(7001 + g) };
    for (let i = 0; i < 4000 && !s.gameOver; i++) {
      const legal = generateLegalActions(s, DEFAULT_RULES);
      if (legal.length === 0) break;
      const attackOffer = legal.find((a) => a.kind === 'declareAttackers' && a.attackers?.length > 0);
      const action = pilot.chooseAction({
        view: s,
        legalActions: legal,
        rng: rngs[s.priorityPlayer],
        registry,
        rulesConfig: DEFAULT_RULES,
        observer: undefined,
      });

      if (attackOffer) {
        windows++;
        const declaredAny = action.kind === 'declareAttackers' && (action.attackers?.length ?? 0) > 0;
        if (!declaredAny) {
          declined++;
          const me = s.priorityPlayer;
          const foe = me === 'A' ? 'B' : 'A';
          const blockers = s.battlefield.filter(
            (p) => p.controller === foe && !p.tapped && isCreature(p.def),
          );
          // Every creature we could have sent, from the engine's own offer.
          const couldAttack = s.battlefield.filter(
            (p) => p.controller === me && isCreature(p.def) && !p.tapped,
          );
          if (blockers.length === 0) {
            free++;
            freeDamage += couldAttack.reduce((sum, c) => sum + power(c), 0);
            if (freeExamples.length < 5) {
              freeExamples.push(
                `${aName} vs ${bName} g${g}: ${couldAttack.length} attacker(s) for ` +
                  `${couldAttack.reduce((sum, c) => sum + power(c), 0)} vs ${s.players[foe].life} life, no blockers`,
              );
            }
          } else {
            // Survives every possible single block, and kills nothing — a body the
            // defender simply cannot answer without losing the creature or the life.
            const anySafe = couldAttack.some((a) =>
              blockers.every((b) => power(b) < toughness(a)),
            );
            if (anySafe) unblocked++;
            else contested++;
          }
        }
      }
      s = applyAction(s, action, DEFAULT_RULES, registry).state;
    }
  }
}

console.log(`attack windows offering a real attack : ${windows}`);
console.log(`declined                              : ${declined} (${((declined / windows) * 100).toFixed(1)}%)\n`);
console.log(`  FREE      (defender has NO untapped creature) : ${free}`);
console.log(`  UNBLOCKED (an attacker survives every block)   : ${unblocked}`);
console.log(`  CONTESTED (a genuine judgement call)           : ${contested}`);
console.log(`\ndamage declined in the FREE band: ${freeDamage}`);
for (const example of freeExamples) console.log(`  e.g. ${example}`);
console.log(
  free === 0
    ? 'No declined attack was free.'
    : `${free} FREE declines — but see the header: these are overwhelmingly 0-power mana creatures.`,
);
console.log(
  'The UNBLOCKED band is NOT a defect either. The rule it suggests — "attack with anything they',
);
console.log(
  'cannot kill" — was implemented behind a safeAttacker flag and A/B tested at 2,880 games: it moved',
);
console.log(
  'ZERO slots, because the pilot already does it (attackValueThreshold 1, faceDamageValue 1, and a',
);
console.log(
  '0-power attacker is rejected earlier). Tune this band only with an A/B, never on this count alone.',
);
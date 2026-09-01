/**
 * WHERE DOES THE PILOT LEAVE VALUE ON THE TABLE?
 *
 * A strength diagnostic, not a benchmark. It plays real games and, at the moment
 * each turn ends, asks the ENGINE what the seat could still legally have done —
 * so "a missed play" means the menu really offered it and the pilot really did
 * not take it, never a guess about what a better pilot might have wanted.
 *
 * Usage: node packages/sim/bench/missed-plays.mjs [--games N]
 */
import { createDefaultAiRegistry, HEURISTIC_PILOT_ID } from '@jonny-boi/ai';
import { buildRegistry, loadCardPool } from '@jonny-boi/cards';
import { applyAction, createGame, createRng, DEFAULT_RULES, generateLegalActions } from '@jonny-boi/core';
import { SAMPLE_DECKS } from '../dist/data/decks/index.js';
import { loadDeck } from '../dist/src/deck.js';

const at = process.argv.indexOf('--games');
const GAMES = at >= 0 ? Number(process.argv[at + 1]) : 40;

const pool = loadCardPool({ onWarn: () => {} });
const registry = buildRegistry();
const pilot = createDefaultAiRegistry().getPilot(HEURISTIC_PILOT_ID);
const deckOf = (n) => loadDeck(SAMPLE_DECKS.find((d) => d.name === n), pool);

const MATCHUPS = [
  ['Mono-Red Aggro', 'UW Control'],
  ['Mono-Green Ramp', 'Golgari Midrange'],
  ['Orzhov Lifegain', 'Izzet Prowess'],
];

let turns = 0;
let turnsWithUnusedLandDrop = 0;
let turnsWithCastableLeft = 0;
let castableLeftTotal = 0;
let attacksDeclined = 0;
let attackWindows = 0;

for (const [nameA, nameB] of MATCHUPS) {
  const A = deckOf(nameA);
  const B = deckOf(nameB);
  for (let g = 0; g < GAMES; g++) {
    const { state } = createGame({
      seed: 900 + g,
      startingPlayer: g % 2 === 0 ? 'A' : 'B',
      registry,
      decks: { A: { cards: A.library }, B: { cards: B.library } },
    });
    let s = state;
    const rngs = { A: createRng(1 + g), B: createRng(7001 + g) };
    let lastTurn = s.turnNumber;
    let lastStep = s.step;
    for (let i = 0; i < 4000 && !s.gameOver; i++) {
      const legal = generateLegalActions(s, DEFAULT_RULES);
      if (legal.length === 0) break;
      const me = s.priorityPlayer;

      // The END of the active seat's second main: the last moment it could have
      // spent the turn's mana. Anything still on offer here was declined.
      const endingTurn = s.step === 'end' && s.activePlayer === me && s.turnNumber !== lastTurn;
      if (endingTurn) {
        turns += 1;
        lastTurn = s.turnNumber;
        if (s.players[me].landsPlayedThisTurn < 1 &&
            s.players[me].hand.some((c) => (c.def.types ?? []).includes('land'))) {
          turnsWithUnusedLandDrop += 1;
        }
      }
      if (s.step === 'declareAttackers' && s.activePlayer === me && s.step !== lastStep) {
        attackWindows += 1;
        const canAttack = legal.some((a) => a.kind === 'declareAttackers' && a.attackers.length > 0);
        if (canAttack) {
          const chose = pilot.chooseAction({
            view: s, legalActions: legal, rng: rngs[me], registry, rulesConfig: DEFAULT_RULES,
            observer: undefined,
          });
          if (chose.kind !== 'declareAttackers' || chose.attackers.length === 0) attacksDeclined += 1;
        }
      }
      lastStep = s.step;

      const chosen = pilot.chooseAction({
        view: s, legalActions: legal, rng: rngs[me], registry, rulesConfig: DEFAULT_RULES,
        observer: undefined,
      });
      // A pass in the seat's OWN main phase while a cast is on offer is the
      // clearest "declined a play" signal the menu can give.
      if (
        chosen.kind === 'passPriority' &&
        me === s.activePlayer &&
        (s.step === 'precombatMain' || s.step === 'postcombatMain') &&
        s.stack.length === 0
      ) {
        const casts = legal.filter((a) => a.kind === 'castSpell').length;
        if (casts > 0) {
          turnsWithCastableLeft += 1;
          castableLeftTotal += casts;
        }
      }
      s = applyAction(s, chosen, DEFAULT_RULES, registry).state;
    }
  }
}
const pc = (n, d) => `${((n / Math.max(1, d)) * 100).toFixed(1)}%`;
console.log(`turns observed            : ${turns}`);
console.log(`  land drop left unused   : ${turnsWithUnusedLandDrop} (${pc(turnsWithUnusedLandDrop, turns)})`);
console.log(`main-phase passes with a castable spell on offer:`);
console.log(`  windows                 : ${turnsWithCastableLeft} (${castableLeftTotal} cast options declined)`);
console.log(`attack windows            : ${attackWindows}`);
console.log(`  declined to attack      : ${attacksDeclined} (${pc(attacksDeclined, attackWindows)})`);

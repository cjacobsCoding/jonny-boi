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

let windows = 0, passOnly = 0, chosePass = 0, totalOffers = 0, kinds = new Map();
for (let g = 0; g < 60; g++) {
  const { state } = createGame({
    seed: 7 + g,
    startingPlayer: g % 2 === 0 ? 'A' : 'B',
    decks: { A: { cards: A.library }, B: { cards: B.library } },
    registry,
  });
  let s = state;
  const rngs = { A: createRng(1 + g), B: createRng(9001 + g) };
  for (let i = 0; i < 3000 && !s.gameOver; i++) {
    const legal = generateLegalActions(s, DEFAULT_RULES);
    if (legal.length === 0) break;
    windows += 1;
    totalOffers += legal.length;
    if (legal.length === 1) passOnly += 1;
    for (const a of legal) kinds.set(a.kind, (kinds.get(a.kind) ?? 0) + 1);
    const chosen = pilot.chooseAction({
      view: s, legalActions: legal, rng: rngs[s.priorityPlayer], registry, rulesConfig: DEFAULT_RULES,
      observer: undefined,
    });
    if (chosen.kind === 'passPriority') chosePass += 1;
    s = applyAction(s, chosen, DEFAULT_RULES, registry).state;
  }
}
const pct = (n) => `${((n / windows) * 100).toFixed(1)}%`;
console.log(`windows ${windows} over 60 games (${(windows / 60).toFixed(0)}/game)`);
console.log(`  only-pass offered : ${passOnly} (${pct(passOnly)})`);
console.log(`  pilot chose pass  : ${chosePass} (${pct(chosePass)})`);
console.log(`  mean offers/window: ${(totalOffers / windows).toFixed(1)}`);
console.log('  offers by kind    :', [...kinds].sort((a,b)=>b[1]-a[1]).map(([k,v])=>`${k}=${v}`).join(' '));

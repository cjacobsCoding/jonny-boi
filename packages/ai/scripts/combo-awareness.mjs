/**
 * DOES THE PILOT SEE A COMBO? — a measurement, not an opinion.
 *
 * Caleb asked two specific questions about his decks:
 *
 *   1. Archangel of Thune + Spike Feeder. Remove a +1/+1 counter from the Feeder
 *      for free, gain 2 life, the Angel triggers and puts a counter on every
 *      creature you control — including the Feeder. Net: the counter comes back,
 *      so it repeats forever. Infinite life and an arbitrarily large board.
 *      (Heliod, Sun-Crowned does the same job and is also in that deck.)
 *
 *   2. Curse of Exhaustion on the opponent + Possibility Storm. The Curse caps
 *      them at one spell per turn; the Storm exiles the spell they cast and
 *      offers a replacement cast — which would be their SECOND spell that turn
 *      and is therefore prohibited. So every spell they cast is exiled and
 *      replaced by nothing. They cannot resolve a spell from hand at all.
 *
 * Both are things a human pilot would organise their whole game around. This
 * script asks the REAL heuristic pilot, on a rigged board, what it actually
 * does — and prints the answer whether or not it is flattering.
 *
 * Run it:  npx vite-node packages/ai/scripts/combo-awareness.mjs
 */
import {
  applyAction,
  createGame,
  createRng,
  generateLegalActions,
  DEFAULT_RULES,
  PLUS_ONE_COUNTER,
} from '@jonny-boi/core';
import { buildRegistry, loadCardPool } from '@jonny-boi/cards';
import { createHeuristicPilot } from '../src/index.ts';

const pool = loadCardPool({ onWarn: () => {} });
const registry = buildRegistry();
const byName = new Map(pool.cards.map((c) => [c.name, c]));

/** Refuse to measure a card the pool does not carry — a silent miss reads as "the AI ignored it". */
function def(name) {
  const d = byName.get(name);
  if (!d) throw new Error(`"${name}" is not in the shipped pool — nothing can be concluded about it`);
  return d;
}

function table({ mine = [], theirs = [], myHand = [], seed = 11 } = {}) {
  const filler = def('Plains');
  const created = createGame({
    seed,
    startingPlayer: 'A',
    registry,
    config: DEFAULT_RULES,
    decks: {
      A: { cards: Array.from({ length: 40 }, () => filler) },
      B: { cards: Array.from({ length: 40 }, () => filler) },
    },
  });
  const state = created.state;
  const put = (name, controller, zone) => {
    const inst = {
      instanceId: state.nextInstanceId++,
      def: def(name),
      controller,
      owner: controller,
      zone,
      tapped: false,
      summoningSick: false,
      damageMarked: 0,
      markedByDeathtouch: false,
      counters: {},
    };
    if (zone === 'battlefield') state.battlefield.push(inst);
    else state.players[controller][zone].push(inst);
    return inst;
  };
  for (const n of mine) {
    const inst = put(n, 'A', 'battlefield');
    // ⚠️ A hand-placed permanent never ran its ENTERS-WITH replacement, so
    // Spike Feeder would sit at zero counters and its "remove a +1/+1 counter"
    // ability would be correctly illegal — which reads exactly like "the engine
    // does not implement the card". Give it the counters its printed text says
    // it arrives with, so what is measured is the PILOT and not my rig.
    if (n === 'Spike Feeder') inst.counters = { [PLUS_ONE_COUNTER]: 2 };
  }
  for (const n of theirs) put(n, 'B', 'battlefield');
  for (const n of myHand) put(n, 'A', 'hand');
  // Plenty of untapped lands, so nothing is refused for mana.
  for (let i = 0; i < 8; i++) put('Plains', 'A', 'battlefield');
  while (state.step !== 'precombatMain') {
    const r = applyAction(state, { kind: 'passPriority', player: state.priorityPlayer }, DEFAULT_RULES, registry);
    Object.assign(state, r.state);
  }
  return state;
}

function describe(a) {
  const bits = [a.kind];
  if (a.instanceId !== undefined) bits.push(`#${a.instanceId}`);
  if (a.abilityIndex !== undefined) bits.push(`ability${a.abilityIndex}`);
  return bits.join(' ');
}

/** Ask the pilot for N consecutive decisions and report what it reached for. */
function drive(state, label, { turns = 12 } = {}) {
  const pilot = createHeuristicPilot();
  const rng = createRng(7);
  const picks = [];
  let s = state;
  for (let i = 0; i < turns; i++) {
    const legal = generateLegalActions(s, DEFAULT_RULES);
    if (legal.length === 0) break;
    const chosen = pilot.chooseAction({ view: s, legalActions: legal, rng, registry });
    if (!chosen) break;
    picks.push(describe(chosen));
    const result = applyAction(s, chosen, DEFAULT_RULES, registry);
    const rejected = result.events.find((e) => e.type === 'actionRejected');
    if (rejected) { picks.push(`REJECTED: ${rejected.reason}`); break; }
    s = result.state;
    if (s.gameOver) { picks.push('game over'); break; }
  }
  const tally = new Map();
  for (const p of picks) tally.set(p, (tally.get(p) ?? 0) + 1);
  console.log(`\n--- ${label} ---`);
  console.log(`life A=${s.players.A.life} B=${s.players.B.life}`);
  console.log('what the pilot chose, most often first:');
  for (const [what, n] of [...tally].sort((a, b) => b[1] - a[1]).slice(0, 8)) {
    console.log(`  ${n}x  ${what}`);
  }
  return s;
}

// --- 1. Archangel of Thune + Spike Feeder ------------------------------------
{
  const s = table({ mine: ['Archangel of Thune', 'Spike Feeder'] });
  const feeder = s.battlefield.find((c) => c.def.name === 'Spike Feeder');
  console.log('\n=== COMBO 1: Archangel of Thune + Spike Feeder ===');
  console.log(`Spike Feeder counters on entry: ${JSON.stringify(feeder?.counters ?? {})}`);
  const legal = generateLegalActions(s, DEFAULT_RULES);
  const feederActions = legal.filter((a) => a.instanceId === feeder?.instanceId);
  console.log(`legal actions on the Feeder: ${feederActions.length ? feederActions.map(describe).join(', ') : 'NONE — the loop is not even offered'}`);
  const after = drive(s, 'heuristic pilot, 12 decisions');
  console.log(`life gained by A: ${after.players.A.life - 20}`);
}

// --- 2. Curse of Exhaustion + Possibility Storm ------------------------------
{
  console.log('\n=== COMBO 2: Curse of Exhaustion (on them) + Possibility Storm ===');
  const absent = ['Possibility Storm', 'Curse of Exhaustion'].filter((n) => !byName.has(n));
  if (absent.length > 0) {
    console.log(`NOT MEASURABLE — the pool does not carry: ${absent.join(', ')}.`);
    console.log('The compiler has to learn these cards before any question about the');
    console.log('AI valuing them can be asked. That is the honest answer, not a zero:');
    console.log('"the AI ignores the lock" and "the cards do not exist yet" look the');
    console.log('same from the outside and want completely different fixes.');
    process.exit(0);
  }
  const s = table({ mine: ['Possibility Storm'], myHand: ['Curse of Exhaustion'] });
  const legal = generateLegalActions(s, DEFAULT_RULES);
  const curse = legal.filter((a) => a.kind === 'castSpell');
  console.log(`castable from hand: ${curse.length ? curse.map(describe).join(', ') : 'NONE'}`);
  drive(s, 'heuristic pilot, 12 decisions');
}

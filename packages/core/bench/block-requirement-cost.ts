/**
 * Is the CR 509.1c/d requirement solver INERT on an ordinary board?
 *
 * Paired and interleaved on purpose: wall clock on this box is worthless (the
 * same build has read 39-87 games/sec within an hour), so the two arms are run
 * alternately in one process and compared by `process.cpuUsage`, which is not
 * affected by what else is scheduled.
 *
 * Arm A: `illegalBlockDeclaration` over a board with NO block requirement — the
 *        board every game in the gauntlet actually has.
 * Arm B: the same call on a board where one attacker carries "must be blocked",
 *        so the solver really runs.
 */
import { createGame } from '../src/engine.js';
import { deckOf, landDef } from '../src/test-fixtures.js';
import { illegalBlockDeclaration } from '../src/internal/combat.js';
import { indexContinuous } from '../src/internal/continuous.js';
import type { CardDefinition } from '../src/card.js';
import type { CardInstance, GameState, PlayerId } from '../src/state.js';

const ITERATIONS = 2_000_000;
const ATTACKERS = 4;
const BLOCKERS = 5;

function creature(id: string, keywords?: CardDefinition['keywords']): CardDefinition {
  return { id, name: id, types: ['creature'], power: 2, toughness: 2, ...(keywords ? { keywords } : {}) };
}

function place(state: GameState, def: CardDefinition, controller: PlayerId): CardInstance {
  const inst: CardInstance = {
    instanceId: state.nextInstanceId++, def, controller, owner: controller,
    zone: 'battlefield', tapped: false, summoningSick: false,
    damageMarked: 0, markedByDeathtouch: false, counters: {},
  };
  state.battlefield.push(inst);
  return inst;
}

function board(withRequirement: boolean) {
  const { state } = createGame({
    seed: 4, decks: { A: deckOf(landDef('M', 'R'), 30), B: deckOf(landDef('M', 'R'), 30) },
  });
  state.battlefield = [];
  state.continuous = [];
  const attackers: CardInstance[] = [];
  for (let i = 0; i < ATTACKERS; i++) {
    attackers.push(place(state, creature(`A${i}`, withRequirement && i === 0 ? { mustBeBlocked: true } : undefined), 'A'));
  }
  const defenders: CardInstance[] = [];
  for (let i = 0; i < BLOCKERS; i++) defenders.push(place(state, creature(`D${i}`), 'B'));
  const blocks = [{ blocker: defenders[0]!.instanceId, attacker: attackers[0]!.instanceId }];
  return { index: indexContinuous(state), attackers, defenders, blocks };
}

function run(withRequirement: boolean): number {
  const { index, attackers, defenders, blocks } = board(withRequirement);
  const before = process.cpuUsage();
  let sink = 0;
  for (let i = 0; i < ITERATIONS; i++) {
    if (illegalBlockDeclaration(attackers, blocks, index, defenders) !== undefined) sink++;
  }
  const after = process.cpuUsage(before);
  if (sink < 0) console.log('unreachable');
  return (after.user + after.system) / 1000;
}

// Interleaved, alternating, best-of — the pairing the box demands.
const inert: number[] = [];
const active: number[] = [];
for (let round = 0; round < 5; round++) {
  inert.push(run(false));
  active.push(run(true));
}
const best = (xs: number[]): number => Math.min(...xs);
console.log(`iterations ${ITERATIONS} x ${ATTACKERS} attackers / ${BLOCKERS} blockers`);
console.log(`no requirement on the board : ${best(inert).toFixed(1)} ms cpu  (all: ${inert.map((n) => n.toFixed(0)).join('/')})`);
console.log(`one "must be blocked"       : ${best(active).toFixed(1)} ms cpu  (all: ${active.map((n) => n.toFixed(0)).join('/')})`);
console.log(`ratio (active / inert)      : ${(best(active) / best(inert)).toFixed(2)}x`);

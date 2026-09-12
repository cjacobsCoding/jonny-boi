/**
 * What does the SETTLED-STATS deferral cost the continuous layer?
 *
 * §3.146 gave `indexContinuous` and `aggregateFor` a second pass for statics
 * that read a value the layer system produces (Tetsuko's effective-P/T selector,
 * Champion of Lambholt's source-power bound). Both functions run several times
 * per action — combat, SBAs, legality, serialization — so the question that
 * matters is not what the feature costs when it fires, it is what the ORDINARY
 * board pays for the branch that decides it does not.
 *
 * Paired and interleaved in ONE process, compared by `process.cpuUsage`: wall
 * clock on this box is worthless (the same build has read 39-108 games/sec
 * within an hour), so the arms alternate and are taken best-of.
 *
 * Arm A — an ORDINARY anthem board, no settled-stats static anywhere. This is
 *         the board every game in the gauntlet actually has, and it is the arm
 *         to compare against `origin/main`: the branch cost is whatever this
 *         moved.
 * Arm B — the CONTROL: an ordinary keyword-granting static, code `origin/main`
 *         has too and prices the same. Without it arm C is unreadable, because
 *         a keyword grant allocates a flags object per affected permanent where
 *         an anthem only adds two numbers — most of the gap between A and C is
 *         the price of granting a keyword at all, not of the settled pass.
 * Arm C — the same board with a Champion-shaped static, so the deferral, the
 *         settled pass and the source-power read all really run. ⚠️ Running arm
 *         C on `origin/main` measures NOTHING: the field does not exist there,
 *         `staticIsInert` judges the ability inert, and the static is skipped.
 *         A against A and B against B are the only cross-checkout comparisons.
 *
 * Run: `npx tsx packages/core/bench/settled-static-cost.ts`
 */
import { createGame } from '../src/engine.js';
import { deckOf, landDef } from '../src/test-fixtures.js';
import { aggregateFor, indexContinuous } from '../src/internal/continuous.js';
import type { CardDefinition } from '../src/card.js';
import type { StaticAbility } from '../src/statics.js';
import type { CardInstance, GameState, PlayerId } from '../src/state.js';

const ITERATIONS = 300_000;
/** A realistic mid-game board: creatures on both sides plus an anthem. */
const CREATURES_PER_SIDE = 5;

function creature(id: string, statics?: readonly StaticAbility[]): CardDefinition {
  return { id, name: id, types: ['creature'], power: 2, toughness: 2, ...(statics ? { statics } : {}) };
}

/** The plain anthem every board in this bench carries. */
const ANTHEM: CardDefinition = {
  id: 'anthem',
  name: 'Anthem',
  types: ['enchantment'],
  statics: [{ affects: { anyOfTypes: ['creature'], controller: 'you' }, power: 1, toughness: 1 }],
};

/**
 * The Champion's static, written through a cast so this file also transpiles
 * against a checkout whose types predate the field — the `origin/main` arm-A
 * baseline is taken by running this very file there.
 */
const CHAMPION_STATIC = {
  affects: { anyOfTypes: ['creature'], controller: 'you' },
  blockBoundFromSourcePower: 'minBlockerPower',
} as unknown as StaticAbility;

/**
 * THE CONTROL ARM, and it is what makes the Champion number readable: an
 * ORDINARY keyword-granting static, which `origin/main` supports and prices
 * identically. A keyword grant allocates a flags object per affected permanent
 * where an anthem only adds two numbers, so most of the gap between the anthem
 * board and the Champion board is the cost of GRANTING A KEYWORD AT ALL, not
 * the cost of the settled pass.
 */
const KEYWORD_STATIC: StaticAbility = {
  affects: { anyOfTypes: ['creature'], controller: 'you' },
  keywords: { blockRestriction: { minBlockerPower: 2 } },
};

function place(state: GameState, def: CardDefinition, controller: PlayerId): CardInstance {
  const inst: CardInstance = {
    instanceId: state.nextInstanceId++,
    def,
    controller,
    owner: controller,
    zone: 'battlefield',
    tapped: false,
    summoningSick: false,
    damageMarked: 0,
    markedByDeathtouch: false,
    counters: {},
  };
  state.battlefield.push(inst);
  return inst;
}

type Arm = 'ordinary' | 'keywordGrant' | 'champion';

function staticsForArm(arm: Arm): readonly StaticAbility[] | undefined {
  if (arm === 'champion') return [CHAMPION_STATIC];
  if (arm === 'keywordGrant') return [KEYWORD_STATIC];
  return undefined;
}

function board(arm: Arm): { state: GameState; probe: CardInstance } {
  const { state } = createGame({
    seed: 3143,
    decks: { A: deckOf(landDef('M', 'G'), 30), B: deckOf(landDef('M', 'G'), 30) },
  });
  state.battlefield = [];
  state.continuous = [];
  place(state, ANTHEM, 'A');
  let probe: CardInstance | undefined;
  for (let i = 0; i < CREATURES_PER_SIDE; i++) {
    const mine = place(state, creature(`A${i}`, i === 0 ? staticsForArm(arm) : undefined), 'A');
    probe ??= mine;
    place(state, creature(`B${i}`), 'B');
  }
  return { state, probe: probe as CardInstance };
}

function run(arm: Arm): { index: number; single: number } {
  const { state, probe } = board(arm);
  let sink = 0;

  let before = process.cpuUsage();
  for (let i = 0; i < ITERATIONS; i++) sink += indexContinuous(state).size;
  let after = process.cpuUsage(before);
  const index = (after.user + after.system) / 1000;

  before = process.cpuUsage();
  for (let i = 0; i < ITERATIONS; i++) sink += aggregateFor(state, probe.instanceId).power;
  after = process.cpuUsage(before);
  const single = (after.user + after.system) / 1000;

  if (sink < 0) console.log('unreachable');
  return { index, single };
}

const ordinary: Array<{ index: number; single: number }> = [];
const granting: Array<{ index: number; single: number }> = [];
const settled: Array<{ index: number; single: number }> = [];
for (let round = 0; round < 5; round++) {
  ordinary.push(run('ordinary'));
  granting.push(run('keywordGrant'));
  settled.push(run('champion'));
}
const best = (xs: Array<{ index: number; single: number }>, key: 'index' | 'single'): number =>
  Math.min(...xs.map((x) => x[key]));
const ns = (ms: number): string => `${((ms * 1e6) / ITERATIONS).toFixed(0)} ns/call`;

console.log(`${ITERATIONS} iterations, ${CREATURES_PER_SIDE * 2} creatures + 1 anthem`);
for (const [label, arm] of [
  ['ordinary anthem board  ', ordinary],
  ['+ a keyword-granting   ', granting],
  ['+ a Champion (settled) ', settled],
] as const) {
  console.log(`indexContinuous ${label}: ${best(arm, 'index').toFixed(0)} ms  ${ns(best(arm, 'index'))}`);
}
for (const [label, arm] of [
  ['ordinary anthem board  ', ordinary],
  ['+ a keyword-granting   ', granting],
  ['+ a Champion (settled) ', settled],
] as const) {
  console.log(`aggregateFor    ${label}: ${best(arm, 'single').toFixed(0)} ms  ${ns(best(arm, 'single'))}`);
}

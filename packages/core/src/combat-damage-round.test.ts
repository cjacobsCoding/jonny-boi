/**
 * THE COMBAT-DAMAGE ROUND MARKER (CR 510.4) — §3.143 / UX-15, GAP-12.
 *
 * A combat containing a first-striker runs TWO damage steps with state-based
 * actions between them. Until this marker existed the log said nothing about
 * which step a hit belonged to, so the play surface had to GUESS the boundary
 * from the shape of the events — and one documented shape (a first-strike round
 * that kills nothing and repeats no source/recipient pair) was invisible, which
 * is exactly the "one blur" the overhaul forbids.
 *
 * The class this pins is not "first strike works" (`combat.test.ts` has that).
 * It is: **every combat damage event says which round it belonged to, and every
 * non-combat one says nothing** — because a marker that is sometimes absent when
 * it should be present is worse than none, and a marker invented for a burn
 * spell is a lie about a step that never ran.
 */
import { describe, expect, it } from 'vitest';
import {
  applyAction,
  createGame,
  DEFAULT_RULES,
  type CardDefinition,
  type GameAction,
  type GameEvent,
  type GameState,
  type InstanceId,
  type PlayerId,
} from './index.js';
import { createEffectRegistry } from './effects.js';
import { creatureDef, deckOf, landDef } from './test-fixtures.js';
import { applyDamageResult } from './internal/damage-result.js';
import { indexContinuous } from './internal/continuous.js';

const ISLAND = landDef('Island', 'U');

/** One damage event, reduced to the three facts these tests are about. */
interface DamageRow {
  readonly target: InstanceId | PlayerId;
  readonly combat: boolean;
  readonly round: 'firstStrike' | 'normal' | undefined;
}

function damageRows(events: readonly GameEvent[]): DamageRow[] {
  return events
    .filter((e): e is Extract<GameEvent, { type: 'damageDealt' }> => e.type === 'damageDealt')
    .map((e) => ({ target: e.target, combat: e.combat, round: e.round }));
}

/** Run one action, collecting its events; a rejection is a test bug, not a result. */
function act(state: GameState, action: GameAction, log: GameEvent[]): GameState {
  const r = applyAction(state, action, DEFAULT_RULES, createEffectRegistry());
  const rejected = r.events.find((e) => e.type === 'actionRejected');
  if (rejected) throw new Error(`unexpected rejection: ${(rejected as { reason: string }).reason}`);
  log.push(...r.events);
  return r.state;
}

function advanceToStep(state: GameState, target: string, log: GameEvent[], max = 300): GameState {
  let s = state;
  let guard = 0;
  while (s.step !== target && !s.gameOver && guard++ < max) {
    s = act(s, { kind: 'passPriority', player: s.priorityPlayer }, log);
  }
  return s;
}

/** Put creatures on the battlefield for both seats and stop in declareAttackers. */
function combatSetup(
  attackers: readonly CardDefinition[],
  blockers: readonly CardDefinition[],
  log: GameEvent[],
): { state: GameState; attackerIds: InstanceId[]; blockerIds: InstanceId[] } {
  const { state } = createGame({
    seed: 1,
    decks: { A: deckOf(ISLAND, 40), B: deckOf(ISLAND, 40) },
    config: DEFAULT_RULES,
  });
  let nextId = state.nextInstanceId;
  const place = (def: CardDefinition, controller: PlayerId): InstanceId => {
    const id = nextId++;
    state.battlefield.push({
      instanceId: id,
      def,
      controller,
      owner: controller,
      zone: 'battlefield',
      tapped: false,
      summoningSick: false,
      damageMarked: 0,
      markedByDeathtouch: false,
      counters: {},
    });
    return id;
  };
  const attackerIds = attackers.map((d) => place(d, 'A'));
  const blockerIds = blockers.map((d) => place(d, 'B'));
  state.nextInstanceId = nextId;
  return { state: advanceToStep(state, 'declareAttackers', log), attackerIds, blockerIds };
}

/** Declare the given attack and blocks, then run through the damage steps. */
function runCombat(
  state: GameState,
  attackerIds: readonly InstanceId[],
  blocks: ReadonlyArray<{ blocker: InstanceId; attacker: InstanceId }>,
  log: GameEvent[],
): GameState {
  let s = act(state, { kind: 'declareAttackers', player: 'A', attackers: [...attackerIds] }, log);
  s = advanceToStep(s, 'declareBlockers', log);
  s = act(s, { kind: 'declareBlockers', player: 'B', blocks: [...blocks] }, log);
  return advanceToStep(s, 'postcombatMain', log);
}

describe('damageDealt.round — which combat-damage step dealt this (CR 510.4)', () => {
  it('THE GAP: two unblocked attackers, one with first strike, are TWO marked rounds', () => {
    // The exact shape that was invisible before the marker: nothing dies, no
    // source/recipient pair repeats, both hits land on the same seat. The old
    // fold saw one round; the log now says two.
    const log: GameEvent[] = [];
    const firstStriker = creatureDef('FS', 2, 2, { keywords: { firstStrike: true } });
    const vanilla = creatureDef('V', 3, 3);
    const { state, attackerIds } = combatSetup([firstStriker, vanilla], [], log);
    runCombat(state, attackerIds, [], log);

    expect(damageRows(log)).toEqual([
      { target: 'B', combat: true, round: 'firstStrike' },
      { target: 'B', combat: true, round: 'normal' },
    ]);
  });

  it('a combat with no first-striker is one round, and it is marked `normal`', () => {
    // The marker is not "first strike happened" — it names the STEP, and the
    // ordinary combat runs the normal step. A fold that only ever saw a marker
    // when first strike was present could not tell "unmarked" from "legacy log".
    const log: GameEvent[] = [];
    const { state, attackerIds } = combatSetup([creatureDef('A1', 3, 3)], [], log);
    runCombat(state, attackerIds, [], log);
    expect(damageRows(log)).toEqual([{ target: 'B', combat: true, round: 'normal' }]);
  });

  it('a DOUBLE STRIKER deals in both steps, and each hit names its own step', () => {
    const log: GameEvent[] = [];
    const ds = creatureDef('DS', 2, 2, { keywords: { doubleStrike: true } });
    const { state, attackerIds } = combatSetup([ds], [], log);
    runCombat(state, attackerIds, [], log);
    expect(damageRows(log).map((r) => r.round)).toEqual(['firstStrike', 'normal']);
  });

  it('every hit in ONE step shares one marker — a trample split is not two rounds', () => {
    const log: GameEvent[] = [];
    const trampler = creatureDef('TR', 5, 5, { keywords: { trample: true } });
    const chump = creatureDef('Chump', 1, 1);
    const { state, attackerIds, blockerIds } = combatSetup([trampler], [chump], log);
    runCombat(state, attackerIds, [{ blocker: blockerIds[0] as InstanceId, attacker: attackerIds[0] as InstanceId }], log);
    const rows = damageRows(log);
    // The chump's 1 lethal, the 4 that tramples through, and the chump's own
    // 1 back at the trampler — all in the normal step.
    expect(rows.length).toBeGreaterThanOrEqual(2);
    expect(new Set(rows.map((r) => r.round))).toEqual(new Set(['normal']));
  });

  it('the INVARIANT: combat damage is marked, and only combat damage is', () => {
    // The class-level claim, asserted over a whole combat rather than over one
    // hand-picked event: `combat` and `round !== undefined` are the same fact.
    const log: GameEvent[] = [];
    const fs = creatureDef('FS', 2, 2, { keywords: { firstStrike: true, lifelink: true } });
    const blocker = creatureDef('B1', 2, 3);
    const { state, attackerIds, blockerIds } = combatSetup([fs], [blocker], log);
    runCombat(state, attackerIds, [{ blocker: blockerIds[0] as InstanceId, attacker: attackerIds[0] as InstanceId }], log);
    const rows = damageRows(log);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(row.combat).toBe(row.round !== undefined);
  });

  it('NON-combat damage carries no round — there was no step for it to belong to', () => {
    // A burn spell / a fight goes through the same result funnel with
    // `combat: false`, and must reach the log unmarked: the marker is stamped by
    // the combat-damage step alone, so any future damage site gets the honest
    // `undefined` rather than an inherited "normal".
    const log: GameEvent[] = [];
    const { state, attackerIds } = combatSetup([creatureDef('Src', 1, 1)], [], log);
    const source = state.battlefield.find((c) => c.instanceId === attackerIds[0]);
    expect(source).toBeDefined();
    const events: GameEvent[] = [];
    applyDamageResult(state, source!, 'B', 3, false, indexContinuous(state), (e) => events.push(e));
    expect(damageRows(events)).toEqual([{ target: 'B', combat: false, round: undefined }]);
  });
});

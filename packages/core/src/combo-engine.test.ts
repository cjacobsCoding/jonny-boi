/**
 * INFINITE COMBOS, END TO END (DESIGN §3.177 stage 1; CR 732.4).
 *
 * A player steps through a real loop twice through `applyAction`; the engine
 * opens a combo window naming the loop and its net change; `repeatCombo` runs
 * it N more times through the ordinary action funnel; `dismissCombo` closes
 * it, remembers the cycle for the turn, and forgets it next turn. The no-op
 * untap ↔ untap loop opens nothing, ever. Detection is OFF for every
 * configuration that does not name a seat, and a loop owned by an unlisted
 * seat (the pilot's) is never offered.
 *
 * The loops are hand-built: definitions with stub primitives, no compiler.
 */
import { describe, expect, it } from 'vitest';
import type { GameAction } from './actions.js';
import type { CardDefinition } from './card.js';
import type { RulesConfig } from './config.js';
import { DEFAULT_RULES } from './config.js';
import type { EffectRegistry } from './effects.js';
import { createEffectRegistry } from './effects.js';
import { applyAction, createGame, generateLegalActions } from './engine.js';
import type { GameEvent } from './events.js';
import type { CardInstance, GameState, InstanceId, PlayerId } from './state.js';
import { deckOf, landDef } from './test-fixtures.js';
import { COMBO_REPEAT_CAP, findComboLoop } from './combo.js';

// --- the pieces --------------------------------------------------------------------

/** "{T}: You gain 1 life." */
const LIFE_TAPPER: CardDefinition = {
  id: 'life-tapper',
  name: 'Life Tapper',
  types: ['artifact'],
  activated: [{ cost: { tap: true }, effects: [{ primitive: 'gainOneLife' }], label: '{T}: You gain 1 life.' }],
};

/** "{T}: Untap target permanent and untap ~." — the piece that makes a two-card loop real. */
const SELF_UNTAPPER: CardDefinition = {
  id: 'self-untapper',
  name: 'Self Untapper',
  types: ['artifact'],
  activated: [
    {
      cost: { tap: true },
      effects: [{ primitive: 'untapTargetAndSelf', params: { targets: 'permanent' } }],
      label: '{T}: Untap target permanent and untap this.',
    },
  ],
};

/** "{T}: Untap target permanent." — two of these untapping each other is the no-op. */
function plainUntapper(id: string): CardDefinition {
  return {
    id,
    name: id,
    types: ['artifact'],
    activated: [
      {
        cost: { tap: true },
        effects: [{ primitive: 'untapTarget', params: { targets: 'permanent' } }],
        label: '{T}: Untap target permanent.',
      },
    ],
  };
}

/** "{T}: Target opponent loses 5 life." — a loop that ends the game mid-repeat. */
const DRAINER: CardDefinition = {
  id: 'drainer',
  name: 'Drainer',
  types: ['artifact'],
  activated: [{ cost: { tap: true }, effects: [{ primitive: 'drainFive' }], label: '{T}: Your opponent loses 5 life.' }],
};

/** "Whenever you gain life, untap target permanent." — the loop that asks a question each cycle. */
const LIFE_UNTAP_TRIGGER: CardDefinition = {
  id: 'life-untap-trigger',
  name: 'Lifelink Reliquary',
  types: ['artifact'],
  triggers: [
    {
      condition: { on: 'gainLife', who: 'you' },
      effects: [{ primitive: 'untapTarget', params: { targets: 'permanent' } }],
      targets: 'permanent',
      label: 'Whenever you gain life, untap target permanent.',
    },
  ],
};

const DRAIN_AMOUNT = 5;

function registry(): EffectRegistry {
  const reg = createEffectRegistry();
  reg.register('gainOneLife', (ctx) => {
    const player = ctx.state.players[ctx.controller];
    player.life += 1;
    ctx.emit({ type: 'lifeChanged', player: ctx.controller, delta: 1, to: player.life });
    ctx.emit({ type: 'gainLife', player: ctx.controller, amount: 1 });
  });
  const untap = (state: GameState, id: InstanceId, emit: (e: GameEvent) => void): void => {
    const target = state.battlefield.find((c) => c.instanceId === id);
    if (!target || !target.tapped) return;
    target.tapped = false;
    emit({ type: 'untapped', instanceId: id, player: target.controller });
  };
  reg.register('untapTarget', (ctx) => {
    const target = ctx.targets[0];
    if (typeof target === 'number') untap(ctx.state, target, ctx.emit);
  });
  reg.register('untapTargetAndSelf', (ctx) => {
    const target = ctx.targets[0];
    if (typeof target === 'number') untap(ctx.state, target, ctx.emit);
    untap(ctx.state, ctx.source.instanceId, ctx.emit);
  });
  reg.register('drainFive', (ctx) => {
    const victim: PlayerId = ctx.controller === 'A' ? 'B' : 'A';
    const player = ctx.state.players[victim];
    player.life -= DRAIN_AMOUNT;
    ctx.emit({ type: 'lifeChanged', player: victim, delta: -DRAIN_AMOUNT, to: player.life });
  });
  return reg;
}

// --- the harness ---------------------------------------------------------------------

/** The Play session's rules: seat A is the human; no cleanup discard to park a question in. */
const HUMAN_A: RulesConfig = { ...DEFAULT_RULES, comboDetectionSeats: ['A'], maximumHandSize: Number.MAX_SAFE_INTEGER };

interface Table {
  state: GameState;
  readonly registry: EffectRegistry;
  readonly config: RulesConfig;
  /** Every event every action produced, in order. */
  readonly events: GameEvent[];
  readonly ids: Record<string, InstanceId>;
}

/** A game in A's first main phase with `defs` on A's battlefield, untapped (or as `tapped` says). */
function tableWith(defs: readonly CardDefinition[], config: RulesConfig = HUMAN_A, tapped: readonly string[] = []): Table {
  const reg = registry();
  const plains = landDef('Plains', 'W');
  const created = createGame({
    seed: 7,
    startingPlayer: 'A',
    registry: reg,
    config,
    decks: { A: deckOf(plains, 40), B: deckOf(plains, 40) },
  });
  const state = created.state;
  const ids: Record<string, InstanceId> = {};
  for (const def of defs) {
    const inst: CardInstance = {
      instanceId: state.nextInstanceId++,
      def,
      controller: 'A',
      owner: 'A',
      zone: 'battlefield',
      tapped: tapped.includes(def.id),
      summoningSick: false,
      damageMarked: 0,
      markedByDeathtouch: false,
      counters: {},
    };
    state.battlefield.push(inst);
    ids[def.id] = inst.instanceId;
  }
  const table: Table = { state, registry: reg, config, events: [...created.events], ids };
  // Upkeep → draw → main: pass both seats through the two empty windows.
  while (table.state.step !== 'precombatMain') apply(table, { kind: 'passPriority', player: table.state.priorityPlayer });
  return table;
}

/** Apply one action, keep the state, and return its events; throws on a rejection so a test cannot pass by accident. */
function apply(table: Table, action: GameAction): readonly GameEvent[] {
  const result = applyAction(table.state, action, table.config, table.registry);
  const rejected = result.events.find((e) => e.type === 'actionRejected');
  if (rejected && rejected.type === 'actionRejected') throw new Error(`${action.kind} rejected: ${rejected.reason}`);
  table.state = result.state;
  table.events.push(...result.events);
  return result.events;
}

/** Apply and EXPECT a rejection; returns its reason. */
function refused(table: Table, action: GameAction): string {
  const result = applyAction(table.state, action, table.config, table.registry);
  const rejected = result.events.find((e) => e.type === 'actionRejected');
  if (!rejected || rejected.type !== 'actionRejected') throw new Error(`${action.kind} was NOT rejected`);
  return rejected.reason;
}

const activate = (instanceId: InstanceId, targets?: readonly InstanceId[]): GameAction => ({
  kind: 'activateAbility',
  player: 'A',
  instanceId,
  abilityIndex: 0,
  ...(targets ? { targets } : {}),
});
const passA: GameAction = { kind: 'passPriority', player: 'A' };
const passB: GameAction = { kind: 'passPriority', player: 'B' };

/** ONE cycle of the life loop by hand: activate the tapper, resolve it, untap it, resolve that. Six applied actions. */
function lifeCycle(table: Table): void {
  apply(table, activate(table.ids['life-tapper']!));
  apply(table, passA);
  apply(table, passB);
  apply(table, activate(table.ids['self-untapper']!, [table.ids['life-tapper']!]));
  apply(table, passA);
  apply(table, passB);
}

const LIFE_CYCLE_ACTIONS = 6;

const tapped = (table: Table, id: string): boolean =>
  table.state.battlefield.find((c) => c.instanceId === table.ids[id])!.tapped;

// --- the tests ----------------------------------------------------------------------

describe('a hand-built life loop, stepped through twice', () => {
  it('opens the window after the second cycle, naming the loop and +1 life per cycle', () => {
    const table = tableWith([LIFE_TAPPER, SELF_UNTAPPER]);
    const lifeBefore = table.state.players.A.life;
    lifeCycle(table);
    expect(table.state.comboWindow ?? null, 'one cycle is not a loop').toBeNull();
    expect(table.state.players.A.life).toBe(lifeBefore + 1);
    lifeCycle(table);
    const window = table.state.comboWindow;
    expect(window, 'the window opens after the second cycle').toBeTruthy();
    if (!window) return;
    expect(window.owner).toBe('A');
    expect(window.loop.player).toBe('A');
    expect(window.loop.cycle).toHaveLength(LIFE_CYCLE_ACTIONS);
    expect(window.loop.cycle.map((a) => a.kind)).toEqual([
      'activateAbility',
      'passPriority',
      'passPriority',
      'activateAbility',
      'passPriority',
      'passPriority',
    ]);
    expect(window.loop.deltas.map((d) => d.label)).toEqual(['+1 life']);
    expect(table.state.players.A.life).toBe(lifeBefore + 2);
    // The floor is the owner's, and the moment before is remembered.
    expect(table.state.priorityPlayer).toBe('A');
    expect(window.resume).toEqual({ priorityPlayer: 'A', consecutivePasses: 0 });
    const opened = table.events.filter((e) => e.type === 'comboWindowOpened');
    expect(opened).toEqual([{ type: 'comboWindowOpened', player: 'A', cycleLength: LIFE_CYCLE_ACTIONS, summary: '+1 life per cycle' }]);
  });

  it('while open, the owner has exactly two legal actions and nobody may act around it', () => {
    const table = tableWith([LIFE_TAPPER, SELF_UNTAPPER]);
    lifeCycle(table);
    lifeCycle(table);
    expect(generateLegalActions(table.state, table.config)).toEqual([
      { kind: 'dismissCombo', player: 'A' },
      { kind: 'repeatCombo', player: 'A', times: expect.any(Number) },
    ]);
    expect(refused(table, activate(table.ids['life-tapper']!))).toBe('a combo window is awaiting its owner');
    expect(refused(table, passA)).toBe('a combo window is awaiting its owner');
    expect(refused(table, { kind: 'repeatCombo', player: 'B', times: 3 })).toBe('a combo window is awaiting its owner');
    expect(refused(table, { kind: 'dismissCombo', player: 'B' })).toBe('a combo window is awaiting its owner');
  });

  it('repeatCombo 50 leaves life 50 higher, every piece untapped, the stack empty and the window closed', () => {
    const table = tableWith([LIFE_TAPPER, SELF_UNTAPPER]);
    lifeCycle(table);
    lifeCycle(table);
    const before = table.state.players.A.life;
    const eventsBefore = table.events.length;
    const started = performance.now();
    const events = apply(table, { kind: 'repeatCombo', player: 'A', times: 50 });
    const elapsedMs = performance.now() - started;
    expect(table.state.players.A.life).toBe(before + 50);
    expect(table.state.comboWindow).toBeNull();
    expect(table.state.stack).toHaveLength(0);
    expect(tapped(table, 'life-tapper')).toBe(false);
    expect(tapped(table, 'self-untapper')).toBe(false);
    expect(table.state.priorityPlayer).toBe('A');
    expect(table.state.gameOver).toBe(false);
    const summary = events.filter((e) => e.type === 'comboRepeated');
    expect(summary).toEqual([{ type: 'comboRepeated', player: 'A', requested: 50, completed: 50 }]);
    // Every iteration's own events are in the batch, before the summary: 50 real life gains.
    expect(events.filter((e) => e.type === 'gainLife')).toHaveLength(50);
    expect(events[events.length - 1]!.type).toBe('comboRepeated');
    // The loop just run is not found again at once — the memory restarted.
    expect(table.state.comboHistory).toHaveLength(1);
    expect(table.state.comboHistory![0]!.action).toBeNull();
    // Reported, not asserted: the event burst and the time a 50× repeat took on this box.
    console.log(`repeatCombo 50: ${table.events.length - eventsBefore} events, ${elapsedMs.toFixed(1)} ms`);
  });

  it('the cap is honoured and the count must be a whole number the window can take', () => {
    const table = tableWith([LIFE_TAPPER, SELF_UNTAPPER]);
    lifeCycle(table);
    lifeCycle(table);
    const bound = `the loop can be repeated between 1 and ${COMBO_REPEAT_CAP} times`;
    expect(refused(table, { kind: 'repeatCombo', player: 'A', times: 0 })).toBe(bound);
    expect(refused(table, { kind: 'repeatCombo', player: 'A', times: COMBO_REPEAT_CAP + 1 })).toBe(bound);
    expect(refused(table, { kind: 'repeatCombo', player: 'A', times: 2.5 })).toBe(bound);
    // A refusal leaves the window standing.
    expect(table.state.comboWindow).toBeTruthy();
    const before = table.state.players.A.life;
    apply(table, { kind: 'repeatCombo', player: 'A', times: COMBO_REPEAT_CAP });
    expect(table.state.players.A.life).toBe(before + COMBO_REPEAT_CAP);
  });

  it('after a repeat the loop is offered again only once it has been demonstrated twice more', () => {
    const table = tableWith([LIFE_TAPPER, SELF_UNTAPPER]);
    lifeCycle(table);
    lifeCycle(table);
    apply(table, { kind: 'repeatCombo', player: 'A', times: 3 });
    lifeCycle(table);
    expect(table.state.comboWindow).toBeNull();
    lifeCycle(table);
    expect(table.state.comboWindow).toBeTruthy();
  });

  it('without a window, both answers are refused', () => {
    const table = tableWith([LIFE_TAPPER, SELF_UNTAPPER]);
    expect(refused(table, { kind: 'repeatCombo', player: 'A', times: 3 })).toBe('no combo window is open');
    expect(refused(table, { kind: 'dismissCombo', player: 'A' })).toBe('no combo window is open');
  });
});

describe('dismissCombo', () => {
  it('closes the window, restores the floor, and does not re-offer the cycle this turn — but does next turn', () => {
    const table = tableWith([LIFE_TAPPER, SELF_UNTAPPER]);
    lifeCycle(table);
    lifeCycle(table);
    expect(table.state.comboWindow).toBeTruthy();
    const key = table.state.comboWindow!.loop.key;
    const events = apply(table, { kind: 'dismissCombo', player: 'A' });
    expect(events).toEqual([{ type: 'comboDismissed', player: 'A' }]);
    expect(table.state.comboWindow).toBeNull();
    expect(table.state.comboDismissed).toEqual([key]);
    expect(table.state.priorityPlayer).toBe('A');
    // A third cycle by hand: no window at ANY of its six boundaries — the
    // rotations of a dismissed loop are the same loop.
    const life = table.state.players.A.life;
    apply(table, activate(table.ids['life-tapper']!));
    expect(table.state.comboWindow).toBeNull();
    apply(table, passA);
    expect(table.state.comboWindow).toBeNull();
    apply(table, passB);
    expect(table.state.comboWindow).toBeNull();
    apply(table, activate(table.ids['self-untapper']!, [table.ids['life-tapper']!]));
    expect(table.state.comboWindow).toBeNull();
    apply(table, passA);
    expect(table.state.comboWindow).toBeNull();
    apply(table, passB);
    expect(table.state.comboWindow).toBeNull();
    expect(table.state.players.A.life).toBe(life + 1);

    // Into A's NEXT turn: the dismissal is forgotten with the turn.
    const turn = table.state.turnNumber;
    while (!(table.state.turnNumber === turn + 2 && table.state.step === 'precombatMain')) {
      apply(table, { kind: 'passPriority', player: table.state.priorityPlayer });
    }
    expect(table.state.comboDismissed).toEqual([]);
    expect(table.state.comboWindow).toBeNull();
    lifeCycle(table);
    lifeCycle(table);
    expect(table.state.comboWindow, 'offered afresh next turn').toBeTruthy();
  });
});

describe('what is NOT a combo', () => {
  it('two untappers untapping each other open no window after any number of cycles', () => {
    const table = tableWith([plainUntapper('untap-x'), plainUntapper('untap-y')], HUMAN_A, ['untap-y']);
    const x = table.ids['untap-x']!;
    const y = table.ids['untap-y']!;
    for (let cycle = 0; cycle < 4; cycle++) {
      apply(table, activate(x, [y]));
      apply(table, passA);
      apply(table, passB);
      apply(table, activate(y, [x]));
      apply(table, passA);
      apply(table, passB);
      expect(table.state.comboWindow ?? null).toBeNull();
    }
    expect(tapped(table, 'untap-x')).toBe(false);
    expect(tapped(table, 'untap-y')).toBe(true);
    expect(findComboLoop(table.state.comboHistory!, table.state)).toEqual({ found: false, reason: 'noNetChange' });
    expect(table.events.some((e) => e.type === 'comboWindowOpened')).toBe(false);
  });

  it('a loop owned by a seat the rules do not name — the pilot — is never offered', () => {
    const table = tableWith([LIFE_TAPPER, SELF_UNTAPPER], { ...HUMAN_A, comboDetectionSeats: ['B'] });
    lifeCycle(table);
    lifeCycle(table);
    lifeCycle(table);
    expect(table.state.comboWindow ?? null).toBeNull();
    // …and the detector itself would have found it: the seat list is the only reason it was not offered.
    expect(findComboLoop(table.state.comboHistory!, table.state).found).toBe(true);
  });

  it('with the default rules nothing is recorded at all — the sim pays nothing', () => {
    const table = tableWith([LIFE_TAPPER, SELF_UNTAPPER], { ...DEFAULT_RULES, maximumHandSize: Number.MAX_SAFE_INTEGER });
    lifeCycle(table);
    lifeCycle(table);
    expect(table.state.comboHistory).toBeUndefined();
    expect(table.state.comboWindow).toBeUndefined();
    expect(table.state.comboDismissed).toBeUndefined();
    expect('comboHistory' in table.state).toBe(false);
  });
});

describe('a repeat that ends the game stops there and says so', () => {
  it('the drain loop kills the opponent in the second iteration of fifty', () => {
    const table = tableWith([DRAINER, SELF_UNTAPPER]);
    const cycle = (): void => {
      apply(table, activate(table.ids['drainer']!));
      apply(table, passA);
      apply(table, passB);
      apply(table, activate(table.ids['self-untapper']!, [table.ids['drainer']!]));
      apply(table, passA);
      apply(table, passB);
    };
    cycle();
    cycle();
    expect(table.state.players.B.life).toBe(20 - 2 * DRAIN_AMOUNT);
    const window = table.state.comboWindow;
    expect(window?.loop.deltas.map((d) => d.label)).toEqual([`−${DRAIN_AMOUNT} life`]);
    const events = apply(table, { kind: 'repeatCombo', player: 'A', times: 50 });
    expect(table.state.gameOver).toBe(true);
    expect(table.state.winner).toBe('A');
    const summary = events.find((e) => e.type === 'comboRepeated');
    // B hits 0 as the drain RESOLVES, halfway through the second iteration —
    // one whole cycle completed, the second cut short by the end of the game.
    expect(summary).toEqual({
      type: 'comboRepeated',
      player: 'A',
      requested: 50,
      completed: 1,
      stoppedBecause: 'the game ended',
    });
    expect(table.state.comboWindow).toBeNull();
  });
});

describe('a loop that asks a question every cycle (a triggered untap with a target)', () => {
  /** One cycle: tap for life; the trigger asks where to aim; aim it at the tapper; resolve. */
  function triggerCycle(table: Table): void {
    apply(table, activate(table.ids['life-tapper']!));
    apply(table, passA);
    apply(table, passB); // the life gain resolves, the trigger goes on the stack and asks
    const choice = table.state.pendingChoice;
    expect(choice?.kind).toBe('selectTargets');
    apply(table, {
      kind: 'answerChoice',
      player: 'A',
      choiceId: choice!.id,
      answer: { kind: 'selectTargets', targets: [table.ids['life-tapper']!] },
    });
    apply(table, passA);
    apply(table, passB); // the untap resolves
  }

  it('is found, and the replay re-aims each iteration\'s answer at the question actually open', () => {
    const table = tableWith([LIFE_TAPPER, LIFE_UNTAP_TRIGGER]);
    triggerCycle(table);
    triggerCycle(table);
    const window = table.state.comboWindow;
    expect(window, 'the loop with a mid-cycle question is found').toBeTruthy();
    if (!window) return;
    expect(window.loop.cycle.map((a) => a.kind)).toContain('answerChoice');
    expect(window.loop.deltas.map((d) => d.label)).toEqual(['+1 life']);
    const before = table.state.players.A.life;
    const events = apply(table, { kind: 'repeatCombo', player: 'A', times: 10 });
    expect(table.state.players.A.life).toBe(before + 10);
    expect(table.state.pendingChoice ?? null).toBeNull();
    expect(table.state.stack).toHaveLength(0);
    expect(tapped(table, 'life-tapper')).toBe(false);
    expect(events.find((e) => e.type === 'comboRepeated')).toEqual({
      type: 'comboRepeated',
      player: 'A',
      requested: 10,
      completed: 10,
    });
  });
});

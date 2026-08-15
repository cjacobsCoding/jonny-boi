/**
 * Regression tests for bugs found in an adversarial pass over the rules engine.
 *
 * Each test here corresponds to a specific defect that FAILED before its fix. They
 * are deliberately hostile — malformed declarations, permanents leaving and coming
 * back, mana kept across a step boundary — because this engine both decides
 * statistically-significant A/B verdicts and runs real human games: a quiet rules
 * error biases every simulation and corrupts live play.
 */

import { describe, expect, it } from 'vitest';
import {
  aggregateFor,
  applyAction,
  createGame,
  createRng,
  DEFAULT_RULES,
  effectivePower,
  generateLegalActions,
  type CardDefinition,
  type GameAction,
  type GameEvent,
  type GameState,
  type InstanceId,
  type PlayerId,
} from './index.js';
import { createEffectRegistry, type EffectRegistry } from './effects.js';
import { creatureDef, deckOf, landDef, spellDef } from './test-fixtures.js';

const ISLAND = landDef('Island', 'U');
const FOREST = landDef('Forest', 'G');
const LIFE = DEFAULT_RULES.startingLife;

// --- harness -------------------------------------------------------------------

function rejectionOf(events: readonly GameEvent[]): string | undefined {
  const rejected = events.find((e) => e.type === 'actionRejected');
  return rejected ? (rejected as Extract<GameEvent, { type: 'actionRejected' }>).reason : undefined;
}

/** Apply an action that is expected to be legal; throws if the engine rejects it. */
function act(state: GameState, action: GameAction, registry = createEffectRegistry()): GameState {
  const r = applyAction(state, action, DEFAULT_RULES, registry);
  const reason = rejectionOf(r.events);
  if (reason) throw new Error(`unexpected rejection: ${reason}`);
  return r.state;
}

function pass(state: GameState, registry?: EffectRegistry): GameState {
  return act(state, { kind: 'passPriority', player: state.priorityPlayer }, registry);
}

function advanceToStep(state: GameState, target: GameState['step'], registry?: EffectRegistry): GameState {
  let s = state;
  for (let guard = 0; s.step !== target && !s.gameOver && guard < 300; guard++) s = pass(s, registry);
  return s;
}

function newGame(seed = 11): GameState {
  return createGame({ seed, decks: { A: deckOf(ISLAND, 40), B: deckOf(ISLAND, 40) } }).state;
}

/** Put a permanent straight onto the battlefield (test positions, not a real play). */
function place(state: GameState, def: CardDefinition, controller: PlayerId): InstanceId {
  const id = state.nextInstanceId++;
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
}

/** Put a card straight into a hand. */
function give(state: GameState, player: PlayerId, def: CardDefinition): InstanceId {
  const id = state.nextInstanceId++;
  state.players[player].hand.push({
    instanceId: id,
    def,
    controller: player,
    owner: player,
    zone: 'hand',
    tapped: false,
    summoningSick: true,
    damageMarked: 0,
    markedByDeathtouch: false,
    counters: {},
  });
  return id;
}

// --- combat declaration robustness ---------------------------------------------

describe('regression: malformed combat declarations are rejected, never silently reinterpreted', () => {
  it('rejects an attacker declared twice instead of letting it deal damage twice', () => {
    // `combat.attackers` is a flat list the damage step walks, so a repeated id used
    // to make one creature hit once per occurrence — a 3/3 dealt 6.
    const state = newGame();
    const attacker = place(state, creatureDef('Bear', 3, 3), 'A');
    const atDeclare = advanceToStep(state, 'declareAttackers');

    const r = applyAction(atDeclare, { kind: 'declareAttackers', player: 'A', attackers: [attacker, attacker] });

    expect(rejectionOf(r.events)).toMatch(/more than once/);
    expect(r.state.combat?.attackersDeclared).toBe(false);
    // And the honest single declaration still hits for exactly its power.
    const resolved = advanceToStep(
      act(atDeclare, { kind: 'declareAttackers', player: 'A', attackers: [attacker] }),
      'postcombatMain',
    );
    expect(resolved.players.B.life).toBe(LIFE - 3);
  });

  it('rejects one blocker assigned to two attackers instead of dropping a block', () => {
    // `combat.blocks` is a blocker→attacker map: a repeated blocker used to keep only
    // its LAST assignment, quietly turning "I block both" into an unblocked attacker.
    const state = newGame();
    const a1 = place(state, creatureDef('A1', 3, 3), 'A');
    const a2 = place(state, creatureDef('A2', 3, 3), 'A');
    const blocker = place(state, creatureDef('Wall', 1, 5), 'B');
    let s = advanceToStep(state, 'declareAttackers');
    s = act(s, { kind: 'declareAttackers', player: 'A', attackers: [a1, a2] });
    s = advanceToStep(s, 'declareBlockers');

    const r = applyAction(s, {
      kind: 'declareBlockers',
      player: 'B',
      blocks: [
        { blocker, attacker: a1 },
        { blocker, attacker: a2 },
      ],
    });

    expect(rejectionOf(r.events)).toMatch(/more than once/);
    expect(r.state.combat?.blockersDeclared).toBe(false);
    expect(r.state.combat?.blocks).toEqual({});
  });

  it('rejects a repeated identical block entry', () => {
    const state = newGame();
    const attacker = place(state, creatureDef('A1', 3, 3), 'A');
    const blocker = place(state, creatureDef('B1', 1, 5), 'B');
    let s = advanceToStep(state, 'declareAttackers');
    s = act(s, { kind: 'declareAttackers', player: 'A', attackers: [attacker] });
    s = advanceToStep(s, 'declareBlockers');

    const r = applyAction(s, {
      kind: 'declareBlockers',
      player: 'B',
      blocks: [
        { blocker, attacker },
        { blocker, attacker },
      ],
    });

    expect(rejectionOf(r.events)).toBeDefined();
  });
});

// --- battlefield entry is fully reported ---------------------------------------

describe('regression: a permanent arriving tapped says so in the event log', () => {
  const tappedCreature: CardDefinition = {
    id: 'sleeper',
    name: 'Sleeper',
    types: ['creature'],
    power: 1,
    toughness: 1,
    cost: { generic: 1 },
    entersTapped: true,
  };

  it('emits `tapped` when an entersTapped permanent resolves off the stack', () => {
    // A replay/inspector folds the event log and starts every entering permanent
    // untapped, so arriving tapped has to be emitted, not only stored in state.
    const state = newGame();
    const land = place(state, FOREST, 'A');
    let s = advanceToStep(state, 'precombatMain');
    const spell = give(s, 'A', tappedCreature);
    s = act(s, { kind: 'tapForMana', player: 'A', instanceId: land });
    s = act(s, { kind: 'castSpell', player: 'A', instanceId: spell });
    s = pass(s);

    const r = applyAction(s, { kind: 'passPriority', player: s.priorityPlayer });

    expect(r.state.battlefield.find((c) => c.instanceId === spell)?.tapped).toBe(true);
    expect(r.events.some((e) => e.type === 'tapped' && e.instanceId === spell)).toBe(true);
  });

  it('emits `tapped` when a token is created tapped', () => {
    const tokenDef: CardDefinition = {
      id: 'tapped-token',
      name: 'Tapped Token',
      types: ['creature'],
      power: 1,
      toughness: 1,
      entersTapped: true,
    };
    const registry = createEffectRegistry();
    registry.register('makeTappedToken', (ctx) => {
      ctx.createToken(tokenDef);
    });
    const state = newGame();
    const land = place(state, FOREST, 'A');
    let s = advanceToStep(state, 'precombatMain', registry);
    const maker = give(s, 'A', spellDef('Maker', 'sorcery', [{ primitive: 'makeTappedToken' }], { generic: 1 }));
    s = act(s, { kind: 'tapForMana', player: 'A', instanceId: land }, registry);
    s = act(s, { kind: 'castSpell', player: 'A', instanceId: maker }, registry);
    s = pass(s, registry);

    const r = applyAction(s, { kind: 'passPriority', player: s.priorityPlayer }, DEFAULT_RULES, registry);

    const token = r.state.battlefield.find((c) => c.def.id === tokenDef.id);
    expect(token?.tapped).toBe(true);
    expect(r.events.some((e) => e.type === 'tapped' && e.instanceId === token?.instanceId)).toBe(true);
  });
});

// --- continuous effects belong to a permanent's current stay on the battlefield -

describe('regression: an until-EOT buff does not follow a permanent out of play and back', () => {
  it('a bounced and re-cast creature comes back at its printed size', () => {
    // Orphaned continuous effects used to be dropped only in the cleanup step, so a
    // permanent that left and returned in the same turn kept its old pump: a re-cast
    // 2/2 read as a 5/5 in combat, SBAs and serialization alike.
    const registry = createEffectRegistry();
    registry.register('bounceTarget', (ctx) => {
      const targetId = ctx.targets[0];
      const target = ctx.state.battlefield.find((c) => c.instanceId === targetId);
      if (!target) return;
      ctx.state.battlefield = ctx.state.battlefield.filter((c) => c.instanceId !== target.instanceId);
      target.zone = 'hand';
      target.tapped = false;
      target.damageMarked = 0;
      ctx.state.players[target.owner].hand.push(target);
      ctx.emit({ type: 'zoneChange', instanceId: target.instanceId, from: 'battlefield', to: 'hand' });
    });

    const bear = creatureDef('Bear', 2, 2, { cost: { generic: 1 } });
    const state = newGame();
    const land1 = place(state, landDef('Forest1', 'G'), 'A');
    const land2 = place(state, landDef('Forest2', 'G'), 'A');
    const creature = place(state, bear, 'A');
    state.continuous.push({
      id: state.nextInstanceId++,
      targetInstanceId: creature,
      sourceInstanceId: creature,
      duration: 'endOfTurn',
      power: 3,
      toughness: 3,
    });

    let s = advanceToStep(state, 'precombatMain', registry);
    const bounce = give(s, 'A', spellDef('Unsummon', 'instant', [{ primitive: 'bounceTarget' }], { generic: 1 }));
    s = act(s, { kind: 'tapForMana', player: 'A', instanceId: land1 }, registry);
    s = act(s, { kind: 'tapForMana', player: 'A', instanceId: land2 }, registry);
    s = act(s, { kind: 'castSpell', player: 'A', instanceId: bounce, targets: [creature] }, registry);
    s = pass(s, registry);
    s = pass(s, registry);

    expect(s.players.A.hand.some((c) => c.instanceId === creature)).toBe(true);
    expect(s.continuous).toHaveLength(0);

    // Re-cast it: it must be a plain 2/2 again, not a 5/5.
    s = act(s, { kind: 'castSpell', player: 'A', instanceId: creature }, registry);
    s = pass(s, registry);
    s = pass(s, registry);

    const back = s.battlefield.find((c) => c.instanceId === creature);
    expect(back).toBeDefined();
    expect(effectivePower(back!, aggregateFor(s, creature))).toBe(2);
  });

  it('a creature that dies takes its continuous effects with it', () => {
    const state = newGame();
    const doomed = place(state, creatureDef('Doomed', 1, 1), 'A');
    state.continuous.push({
      id: state.nextInstanceId++,
      targetInstanceId: doomed,
      sourceInstanceId: doomed,
      duration: 'permanent',
      power: 5,
    });
    state.battlefield.find((c) => c.instanceId === doomed)!.damageMarked = 5;

    const s = advanceToStep(state, 'precombatMain');

    expect(s.battlefield.some((c) => c.instanceId === doomed)).toBe(false);
    expect(s.continuous).toHaveLength(0);
  });
});

// --- broad guards ---------------------------------------------------------------

describe('regression: hostile input degrades cleanly', () => {
  const malformed: readonly GameAction[] = [
    { kind: 'playLand', player: 'B', instanceId: 999 },
    { kind: 'playLand', player: 'A', instanceId: -1 },
    { kind: 'tapForMana', player: 'A', instanceId: 999 },
    { kind: 'tapForMana', player: 'A', instanceId: 1, mode: -1 },
    { kind: 'tapForMana', player: 'A', instanceId: 1, mode: 99 },
    { kind: 'castSpell', player: 'A', instanceId: 999 },
    { kind: 'castSpell', player: 'B', instanceId: 1 },
    { kind: 'declareAttackers', player: 'A', attackers: [999] },
    { kind: 'declareAttackers', player: 'B', attackers: [] },
    { kind: 'declareBlockers', player: 'A', blocks: [] },
    { kind: 'declareBlockers', player: 'B', blocks: [{ blocker: 999, attacker: 998 }] },
    { kind: 'passPriority', player: 'B' },
  ];

  it('never throws and never half-applies', () => {
    const state = newGame();
    place(state, FOREST, 'A');
    const s = advanceToStep(state, 'precombatMain');
    const before = JSON.stringify(snapshot(s));

    for (const action of malformed) {
      const r = applyAction(s, action);
      expect(rejectionOf(r.events)).toBeDefined();
      expect(JSON.stringify(snapshot(r.state))).toBe(before);
    }
    expect(JSON.stringify(snapshot(s))).toBe(before);
  });
});

describe('regression: random legal play stays sound', () => {
  it('every generated action is accepted, leaves the input untouched, and games end', () => {
    // A blunt instrument that has repeatedly been the thing that catches a rules
    // bug: play whole games choosing uniformly among generated legal actions and
    // assert the engine's own contract on every ply.
    const registry = createEffectRegistry();
    registry.register('noop', () => {});
    const bear = creatureDef('Bear', 2, 2, { cost: { generic: 1 } });
    const flier = creatureDef('Flier', 2, 1, { cost: { generic: 2 }, keywords: { flying: true } });
    const trick = spellDef('Trick', 'instant', [{ primitive: 'noop' }], { generic: 1 });

    for (let seed = 1; seed <= 8; seed++) {
      const rng = createRng(seed * 977);
      const buildDeck = (creature: CardDefinition): { cards: CardDefinition[] } => ({
        cards: Array.from({ length: 40 }, (_, i) => (i % 3 === 0 ? creature : i % 3 === 1 ? ISLAND : trick)),
      });
      let s = createGame({ seed, decks: { A: buildDeck(bear), B: buildDeck(flier) }, registry }).state;

      for (let ply = 0; !s.gameOver && ply < 4000; ply++) {
        const legal = generateLegalActions(s);
        expect(legal.length).toBeGreaterThan(0);
        const chosen = legal[rng.nextInt(legal.length)]!;
        const before = JSON.stringify(snapshot(s));

        const r = applyAction(s, chosen, DEFAULT_RULES, registry);

        expect(rejectionOf(r.events)).toBeUndefined();
        expect(JSON.stringify(snapshot(s))).toBe(before); // purity: input untouched
        for (const pid of ['A', 'B'] as PlayerId[]) {
          expect(Object.values(r.state.players[pid].manaPool).every((v) => v >= 0)).toBe(true);
        }
        const ids = r.state.battlefield.map((c) => c.instanceId);
        expect(new Set(ids).size).toBe(ids.length);
        s = r.state;
      }
      expect(s.gameOver).toBe(true);
    }
  }, 60000);
});

/** A structural snapshot used to prove `applyAction` never touches its input. */
function snapshot(s: GameState): unknown {
  return {
    turn: s.turnNumber,
    step: s.step,
    active: s.activePlayer,
    priority: s.priorityPlayer,
    passes: s.consecutivePasses,
    gameOver: s.gameOver,
    winner: s.winner,
    nextInstanceId: s.nextInstanceId,
    rngState: s.rngState,
    players: (['A', 'B'] as PlayerId[]).map((pid) => ({
      life: s.players[pid].life,
      pool: s.players[pid].manaPool,
      hand: s.players[pid].hand.map((c) => c.instanceId),
      library: s.players[pid].library.map((c) => c.instanceId),
      graveyard: s.players[pid].graveyard.map((c) => c.instanceId),
      landsPlayed: s.players[pid].landsPlayedThisTurn,
      hasLost: s.players[pid].hasLost,
    })),
    battlefield: s.battlefield.map((c) => [
      c.instanceId,
      c.tapped,
      c.damageMarked,
      c.summoningSick,
      c.markedByDeathtouch,
      c.counters,
    ]),
    stack: s.stack.map((o) => [o.kind, o.instanceId]),
    combat: s.combat,
    continuous: s.continuous,
  };
}

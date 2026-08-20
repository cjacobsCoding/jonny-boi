/**
 * Triggered-ability system tests (DESIGN §3.9). Inline card-definition fixtures
 * declare `triggers` as data; small registered primitives carry out the effects.
 * Covers: ETB triggers (draw / deal damage), an attack trigger, a cast trigger that
 * makes a token, a death/leaves trigger, deterministic APNAP ordering of multiple
 * simultaneous triggers, and seed-determinism of trigger outcomes.
 */

import { describe, expect, it } from 'vitest';
import {
  applyAction,
  createGame,
  DEFAULT_RULES,
  type CardDefinition,
  type EffectContext,
  defaultAnswerFor,
  type GameAction,
  type GameState,
  type PlayerId,
} from './index.js';
import { createEffectRegistry, type EffectRegistry } from './effects.js';
import { creatureDef, deckOf, giveHand, landDef } from './test-fixtures.js';

const ISLAND = landDef('Island', 'U');

/** A registry wired with the small primitives these tests reference. */
function testRegistry(): EffectRegistry {
  const reg = createEffectRegistry();
  // Draw N cards for the source's controller (default 1).
  reg.register('draw', (ctx: EffectContext) => {
    const n = (ctx.params.count as number | undefined) ?? 1;
    const p = ctx.state.players[ctx.controller];
    for (let i = 0; i < n; i++) {
      const top = p.library.shift();
      if (!top) break;
      top.zone = 'hand';
      p.hand.push(top);
      ctx.emit({ type: 'drawCard', player: ctx.controller, instanceId: top.instanceId });
    }
  });
  // Deal N damage to the opponent of the controller.
  reg.register('pingOpponent', (ctx: EffectContext) => {
    const n = (ctx.params.amount as number | undefined) ?? 1;
    const opp: PlayerId = ctx.controller === 'A' ? 'B' : 'A';
    const player = ctx.state.players[opp];
    player.life -= n;
    ctx.emit({ type: 'damageDealt', source: ctx.source.instanceId, target: opp, amount: n, combat: false });
    ctx.emit({ type: 'lifeChanged', player: opp, delta: -n, to: player.life });
  });
  // Create a vanilla token under the controller from params {power,toughness,name}.
  reg.register('makeToken', (ctx: EffectContext) => {
    const power = (ctx.params.power as number | undefined) ?? 1;
    const toughness = (ctx.params.toughness as number | undefined) ?? 1;
    const name = (ctx.params.name as string | undefined) ?? 'Token';
    const def: CardDefinition = { id: `token-${name}`, name, types: ['creature'], power, toughness };
    ctx.createToken(def);
  });
  // Append a tag to a shared log array passed via params (for ordering assertions).
  reg.register('log', (ctx: EffectContext) => {
    const sink = ctx.params.sink as string[] | undefined;
    const tag = ctx.params.tag as string | undefined;
    if (sink && tag) sink.push(tag);
  });
  return reg;
}

/** Apply an action, asserting no rejection. */
function act(state: GameState, action: GameAction, reg: EffectRegistry): GameState {
  const r = applyAction(state, action, DEFAULT_RULES, reg);
  const rejected = r.events.find((e) => e.type === 'actionRejected');
  if (rejected) throw new Error(`unexpected rejection: ${(rejected as { reason: string }).reason}`);
  return r.state;
}

/**
 * Pass priority — or, when a turn-based action has parked a question (the cleanup
 * step's discard down to maximum hand size, CR 514.1), ANSWER it. A seat with a
 * question outstanding may do nothing else, so a helper that only ever passes
 * would wedge the moment any rule stops to ask something.
 */
function pass(state: GameState, reg: EffectRegistry): GameState {
  const question = state.pendingChoice;
  if (question) {
    return act(state, {
      kind: 'answerChoice',
      player: question.chooser,
      choiceId: question.id,
      answer: defaultAnswerFor(question),
    }, reg);
  }
  return act(state, { kind: 'passPriority', player: state.priorityPlayer }, reg);
}

/** Pass priority repeatedly until the given step (resolving any stack on the way). */
function advanceToStep(state: GameState, target: string, reg: EffectRegistry, max = 400): GameState {
  let s = state;
  let g = 0;
  while (s.step !== target && !s.gameOver && g++ < max) s = pass(s, reg);
  return s;
}

function advanceUntilActive(state: GameState, player: PlayerId, reg: EffectRegistry, max = 800): GameState {
  let s = state;
  let g = 0;
  while (s.activePlayer !== player && !s.gameOver && g++ < max) s = pass(s, reg);
  return s;
}

/** Both players pass until the stack is empty (resolving everything on it). */
function resolveStack(state: GameState, reg: EffectRegistry, max = 50): GameState {
  let s = state;
  let g = 0;
  while (s.stack.length > 0 && !s.gameOver && g++ < max) s = pass(s, reg);
  return s;
}

function lib(): ReturnType<typeof deckOf> {
  return deckOf(ISLAND, 40);
}

describe('ETB triggers', () => {
  it('an ETB "draw a card" trigger goes on the stack and resolves', () => {
    const reg = testRegistry();
    const Seer: CardDefinition = {
      ...creatureDef('Seer', 1, 1, { cost: { generic: 0 } }),
      triggers: [{ condition: { on: 'etb' }, effects: [{ primitive: 'draw' }], label: 'ETB: draw a card' }],
    };
    const g = createGame({ seed: 1, decks: { A: lib(), B: lib() }, registry: reg });
    let s = advanceToStep(g.state, 'precombatMain', reg);
    const [seer] = giveHand(s, 'A', [Seer]);
    const handBefore = s.players.A.hand.length;

    s = act(s, { kind: 'castSpell', player: 'A', instanceId: seer!.instanceId }, reg);
    // Resolve the creature: it enters → ETB trigger queues → goes on stack.
    s = pass(s, reg); // A
    s = pass(s, reg); // B → creature resolves, ETB trigger put on stack
    expect(s.stack.length).toBe(1);
    expect(s.stack[0]!.kind).toBe('trigger');
    // Resolve the trigger.
    s = resolveStack(s, reg);
    expect(s.stack.length).toBe(0);
    // Hand: -1 (cast the Seer) then +1 (drew from the trigger) = net same as before cast.
    expect(s.players.A.hand.length).toBe(handBefore - 1 + 1);
    expect(s.battlefield.some((c) => c.instanceId === seer!.instanceId)).toBe(true);
  });

  it('emits triggerPutOnStack and triggeredAbilityResolved events', () => {
    const reg = testRegistry();
    const Bolt: CardDefinition = {
      ...creatureDef('Imp', 1, 1, { cost: { generic: 0 } }),
      triggers: [{ condition: { on: 'etb' }, effects: [{ primitive: 'pingOpponent', params: { amount: 1 } }], label: 'ETB: ping' }],
    };
    const g = createGame({ seed: 2, decks: { A: lib(), B: lib() }, registry: reg });
    let s = advanceToStep(g.state, 'precombatMain', reg);
    const [imp] = giveHand(s, 'A', [Bolt]);
    const allEvents: string[] = [];
    const sink = (st: GameState, a: GameAction) => {
      const r = applyAction(st, a, DEFAULT_RULES, reg);
      r.events.forEach((e) => allEvents.push(e.type));
      return r.state;
    };
    s = sink(s, { kind: 'castSpell', player: 'A', instanceId: imp!.instanceId });
    s = sink(s, { kind: 'passPriority', player: s.priorityPlayer });
    s = sink(s, { kind: 'passPriority', player: s.priorityPlayer }); // resolves Imp + queues trigger
    expect(allEvents).toContain('triggerPutOnStack');
    s = sink(s, { kind: 'passPriority', player: s.priorityPlayer });
    s = sink(s, { kind: 'passPriority', player: s.priorityPlayer }); // resolves trigger
    expect(allEvents).toContain('triggeredAbilityResolved');
    expect(s.players.B.life).toBe(DEFAULT_RULES.startingLife - 1);
  });
});

describe('attack triggers', () => {
  it('a "whenever this attacks, ping opponent" trigger fires on declare-attackers', () => {
    const reg = testRegistry();
    const Raider: CardDefinition = {
      ...creatureDef('Raider', 2, 2),
      triggers: [
        { condition: { on: 'attacks' }, effects: [{ primitive: 'pingOpponent', params: { amount: 2 } }], label: 'attacks: ping 2' },
      ],
    };
    // Place the Raider on A's battlefield directly (not summoning-sick).
    const g = createGame({ seed: 3, decks: { A: lib(), B: lib() }, registry: reg });
    const state = g.state;
    const id = state.nextInstanceId++;
    state.battlefield.push({
      instanceId: id,
      def: Raider,
      controller: 'A',
      owner: 'A',
      zone: 'battlefield',
      tapped: false,
      summoningSick: false,
      damageMarked: 0,
      markedByDeathtouch: false,
      counters: {},
    });
    let s = advanceToStep(state, 'declareAttackers', reg);
    s = act(s, { kind: 'declareAttackers', player: 'A', attackers: [id] }, reg);
    // The attack trigger is on the stack.
    expect(s.stack.some((o) => o.kind === 'trigger')).toBe(true);
    s = resolveStack(s, reg);
    // 2 from the trigger (combat damage hasn't happened yet at declare step).
    expect(s.players.B.life).toBe(DEFAULT_RULES.startingLife - 2);
  });
});

describe('cast triggers', () => {
  it('"whenever you cast an instant/sorcery, make a 1/1" creates a token', () => {
    const reg = testRegistry();
    const Pyro: CardDefinition = {
      ...creatureDef('Pyro', 2, 2),
      triggers: [
        {
          condition: { on: 'castSpell', who: 'you', spellType: 'instant' },
          effects: [{ primitive: 'makeToken', params: { power: 1, toughness: 1, name: 'Elemental' } }],
          label: 'cast instant: make 1/1',
        },
      ],
    };
    const Zap: CardDefinition = {
      id: 'Zap',
      name: 'Zap',
      types: ['instant'],
      timing: 'instant',
      cost: { generic: 0 },
      effects: [{ primitive: 'pingOpponent', params: { amount: 1 } }],
    };
    const g = createGame({ seed: 4, decks: { A: lib(), B: lib() }, registry: reg });
    const state = g.state;
    const pyroId = state.nextInstanceId++;
    state.battlefield.push({
      instanceId: pyroId,
      def: Pyro,
      controller: 'A',
      owner: 'A',
      zone: 'battlefield',
      tapped: false,
      summoningSick: false,
      damageMarked: 0,
      markedByDeathtouch: false,
      counters: {},
    });
    let s = advanceToStep(state, 'precombatMain', reg);
    const [zap] = giveHand(s, 'A', [Zap]);
    const bfBefore = s.battlefield.length;
    s = act(s, { kind: 'castSpell', player: 'A', instanceId: zap!.instanceId }, reg);
    // The cast trigger is already on the stack, above the spell.
    expect(s.stack.filter((o) => o.kind === 'trigger').length).toBe(1);
    s = resolveStack(s, reg);
    // A token was created and the Zap resolved.
    const tokens = s.battlefield.filter((c) => c.def.name === 'Elemental');
    expect(tokens.length).toBe(1);
    expect(s.battlefield.length).toBe(bfBefore + 1); // +token (Zap went to graveyard)
    expect(s.players.B.life).toBe(DEFAULT_RULES.startingLife - 1);
  });

  it('a cast trigger filtered by spellType does NOT fire on the wrong type', () => {
    const reg = testRegistry();
    const Pyro: CardDefinition = {
      ...creatureDef('Pyro', 2, 2),
      triggers: [
        {
          condition: { on: 'castSpell', who: 'you', spellType: 'instant' },
          effects: [{ primitive: 'makeToken' }],
          label: 'cast instant: token',
        },
      ],
    };
    const Sorc: CardDefinition = {
      id: 'Sorc',
      name: 'Sorc',
      types: ['sorcery'],
      timing: 'sorcery',
      cost: { generic: 0 },
      effects: [{ primitive: 'pingOpponent' }],
    };
    const g = createGame({ seed: 5, decks: { A: lib(), B: lib() }, registry: reg });
    const state = g.state;
    const pyroId = state.nextInstanceId++;
    state.battlefield.push({
      instanceId: pyroId, def: Pyro, controller: 'A', owner: 'A', zone: 'battlefield',
      tapped: false, summoningSick: false, damageMarked: 0, markedByDeathtouch: false, counters: {},
    });
    let s = advanceToStep(state, 'precombatMain', reg);
    const [sorc] = giveHand(s, 'A', [Sorc]);
    s = act(s, { kind: 'castSpell', player: 'A', instanceId: sorc!.instanceId }, reg);
    // Sorcery is not an instant → no trigger queued.
    expect(s.stack.filter((o) => o.kind === 'trigger').length).toBe(0);
  });
});

describe('death / leaves triggers', () => {
  it('a "when this dies, draw a card" trigger fires when the creature dies in combat', () => {
    const reg = testRegistry();
    const Martyr: CardDefinition = {
      ...creatureDef('Martyr', 1, 1),
      triggers: [{ condition: { on: 'dies' }, effects: [{ primitive: 'draw' }], label: 'dies: draw' }],
    };
    const Killer = creatureDef('Killer', 2, 2);
    const g = createGame({ seed: 6, decks: { A: lib(), B: lib() }, registry: reg });
    const state = g.state;
    const martyrId = state.nextInstanceId++;
    state.battlefield.push({
      instanceId: martyrId, def: Martyr, controller: 'A', owner: 'A', zone: 'battlefield',
      tapped: false, summoningSick: false, damageMarked: 0, markedByDeathtouch: false, counters: {},
    });
    const killerId = state.nextInstanceId++;
    state.battlefield.push({
      instanceId: killerId, def: Killer, controller: 'B', owner: 'B', zone: 'battlefield',
      tapped: false, summoningSick: false, damageMarked: 0, markedByDeathtouch: false, counters: {},
    });
    // A attacks with Martyr; B blocks with Killer → Martyr dies → dies trigger fires.
    let s = advanceToStep(state, 'declareAttackers', reg);
    const handBefore = s.players.A.hand.length;
    s = act(s, { kind: 'declareAttackers', player: 'A', attackers: [martyrId] }, reg);
    s = advanceToStep(s, 'declareBlockers', reg);
    s = act(s, { kind: 'declareBlockers', player: 'B', blocks: [{ blocker: killerId, attacker: martyrId }] }, reg);
    // Advance through combat damage; Martyr dies, dies-trigger goes on the stack.
    s = advanceToStep(s, 'postcombatMain', reg);
    expect(s.battlefield.some((c) => c.instanceId === martyrId)).toBe(false);
    // The draw from the dies trigger happened.
    expect(s.players.A.hand.length).toBe(handBefore + 1);
  });
});

describe('multiple simultaneous triggers — APNAP ordering', () => {
  it('orders the active player\'s triggers to resolve after the non-active player\'s', () => {
    const reg = testRegistry();
    const order: string[] = [];
    // Two creatures, one each side, both with an upkeep trigger that logs. At the
    // active player A's upkeep, both fire (A's via who:'any'/'you', B's via 'any').
    const mkUpkeepLogger = (id: string, tag: string): CardDefinition => ({
      ...creatureDef(id, 1, 1),
      triggers: [
        { condition: { on: 'upkeep', who: 'any' }, effects: [{ primitive: 'log', params: { sink: order, tag } }], label: `${tag} upkeep` },
      ],
    });
    const g = createGame({ seed: 7, decks: { A: lib(), B: lib() }, registry: reg });
    const state = g.state;
    const aId = state.nextInstanceId++;
    state.battlefield.push({
      instanceId: aId, def: mkUpkeepLogger('AOwn', 'A-trigger'), controller: 'A', owner: 'A', zone: 'battlefield',
      tapped: false, summoningSick: false, damageMarked: 0, markedByDeathtouch: false, counters: {},
    });
    const bId = state.nextInstanceId++;
    state.battlefield.push({
      instanceId: bId, def: mkUpkeepLogger('BOwn', 'B-trigger'), controller: 'B', owner: 'B', zone: 'battlefield',
      tapped: false, summoningSick: false, damageMarked: 0, markedByDeathtouch: false, counters: {},
    });
    // Advance into B's turn so we pass through a fresh upkeep with both creatures present.
    let s = advanceUntilActive(state, 'B', reg);
    // s is now somewhere in B's turn (upkeep already opened). Advance to A's next upkeep.
    s = advanceUntilActive(s, 'A', reg);
    s = advanceToStep(s, 'upkeep', reg);
    // Both upkeep triggers are already on the stack (flushed when A's upkeep
    // opened) but have NOT resolved yet. Clear the log to isolate this batch, then
    // resolve the stack and capture only A's-upkeep resolution order.
    order.length = 0;
    resolveStack(s, reg);
    // APNAP at A's upkeep: A is active → A's trigger pushed first → resolves last.
    // So the non-active player's (B's) trigger resolves first.
    expect(order).toEqual(['B-trigger', 'A-trigger']);
  });
});

describe('determinism', () => {
  it('same seed → identical trigger outcomes (life + battlefield)', () => {
    const run = (seed: number): GameState => {
      const reg = testRegistry();
      const Imp: CardDefinition = {
        ...creatureDef('Imp', 1, 1, { cost: { generic: 0 } }),
        triggers: [{ condition: { on: 'etb' }, effects: [{ primitive: 'pingOpponent', params: { amount: 3 } }], label: 'etb ping' }],
      };
      const g = createGame({ seed, decks: { A: lib(), B: lib() }, registry: reg });
      let s = advanceToStep(g.state, 'precombatMain', reg);
      const [imp] = giveHand(s, 'A', [Imp]);
      s = act(s, { kind: 'castSpell', player: 'A', instanceId: imp!.instanceId }, reg);
      s = resolveStack(s, reg);
      return s;
    };
    const a = run(123);
    const b = run(123);
    expect(a.players.B.life).toBe(b.players.B.life);
    expect(a.players.B.life).toBe(DEFAULT_RULES.startingLife - 3);
    expect(a.battlefield.map((c) => c.def.name)).toEqual(b.battlefield.map((c) => c.def.name));
  });
});

describe('robustness', () => {
  it('a trigger with an unknown primitive resolves as a no-op (effectUnsupported) without crashing', () => {
    const reg = testRegistry();
    const Weird: CardDefinition = {
      ...creatureDef('Weird', 1, 1, { cost: { generic: 0 } }),
      triggers: [{ condition: { on: 'etb' }, effects: [{ primitive: 'no-such-thing' }], label: 'etb broken' }],
    };
    const g = createGame({ seed: 8, decks: { A: lib(), B: lib() }, registry: reg });
    let s = advanceToStep(g.state, 'precombatMain', reg);
    const [weird] = giveHand(s, 'A', [Weird]);
    let unsupported = false;
    const sink = (st: GameState, a: GameAction): GameState => {
      const r = applyAction(st, a, DEFAULT_RULES, reg);
      if (r.events.some((e) => e.type === 'effectUnsupported')) unsupported = true;
      return r.state;
    };
    s = sink(s, { kind: 'castSpell', player: 'A', instanceId: weird!.instanceId });
    let g2 = 0;
    while (s.stack.length > 0 && g2++ < 20) s = sink(s, { kind: 'passPriority', player: s.priorityPlayer });
    expect(unsupported).toBe(true);
    expect(s.gameOver).toBe(false);
  });
});

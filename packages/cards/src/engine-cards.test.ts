/**
 * Engine-v2 integration tests for the un-stubbed pool cards (DESIGN §3.2 revisit on
 * §3.9 machinery). Each test drives a REAL engine turn via `createGame` + this
 * package's registry, so it exercises the triggered-ability system and the
 * continuous-effects ("until end of turn") layer end-to-end — not just the
 * primitives in isolation.
 *
 * Asserted here:
 *   - Giant Growth buffs effective P/T THIS turn and is GONE after the cleanup step.
 *   - Young Pyromancer: casting an instant makes a 1/1 red Elemental token.
 *   - Monastery Swiftspear: prowess gives +1/+1 this turn, gone next turn.
 *   - Kitchen Finks: persist returns it with a -1/-1 counter, then dies for good.
 *   - A smoke run: the supported cards resolve with no `effectUnsupported` events.
 *
 * Everything is seeded + deterministic.
 */

import { describe, expect, it } from 'vitest';
import type {
  CardDefinition,
  CardInstance,
  GameAction,
  GameState,
  InstanceId,
  PlayerId,
} from '@jonny-boi/core';
import {
  applyAction,
  createGame,
  defaultAnswerFor,
  DEFAULT_RULES,
  effectivePower,
  effectiveToughness,
  indexContinuous,
  NO_MOD,
} from '@jonny-boi/core';
import { buildRegistry } from './pool.js';
import { CARD_POOL } from '../data/pool.js';

function getByName(name: string): CardDefinition {
  const c = CARD_POOL.find((x) => x.name === name);
  if (!c) throw new Error(`pool missing ${name}`);
  return c;
}

const FOREST = getByName('Forest');
const MOUNTAIN = getByName('Mountain');

function deck(def: CardDefinition, n = 40): { cards: CardDefinition[] } {
  return { cards: Array.from({ length: n }, () => def) };
}

function act(state: GameState, action: GameAction, reg: ReturnType<typeof buildRegistry>): GameState {
  const r = applyAction(state, action, DEFAULT_RULES, reg);
  const rejected = r.events.find((e) => e.type === 'actionRejected');
  if (rejected) throw new Error(`unexpected rejection: ${(rejected as { reason: string }).reason}`);
  return r.state;
}

function pass(state: GameState, reg: ReturnType<typeof buildRegistry>): GameState {
  return act(state, { kind: 'passPriority', player: state.priorityPlayer }, reg);
}

function advanceToStep(state: GameState, step: string, reg: ReturnType<typeof buildRegistry>, max = 400): GameState {
  let s = state;
  let g = 0;
  while (s.step !== step && !s.gameOver && g++ < max) s = pass(s, reg);
  return s;
}

function advanceUntilActive(state: GameState, player: PlayerId, reg: ReturnType<typeof buildRegistry>, max = 800): GameState {
  let s = state;
  let g = 0;
  while (s.activePlayer !== player && !s.gameOver && g++ < max) s = pass(s, reg);
  return s;
}

function resolveStack(state: GameState, reg: ReturnType<typeof buildRegistry>, max = 50): GameState {
  let s = state;
  let g = 0;
  while (s.stack.length > 0 && !s.gameOver && g++ < max) s = pass(s, reg);
  return s;
}

function floodMana(state: GameState): void {
  state.players[state.activePlayer].manaPool = { W: 9, U: 9, B: 9, R: 9, G: 9, C: 9 };
}

/** Place a non-summoning-sick creature on the battlefield; return its id. */
function place(state: GameState, def: CardDefinition, controller: PlayerId): InstanceId {
  const id = state.nextInstanceId++;
  state.battlefield.push({
    instanceId: id, def, controller, owner: controller, zone: 'battlefield',
    tapped: false, summoningSick: false, damageMarked: 0, markedByDeathtouch: false, counters: {},
  });
  return id;
}

/** Push a fresh hand instance, returning its id. */
function giveHand(state: GameState, player: PlayerId, def: CardDefinition): InstanceId {
  const inst: CardInstance = {
    instanceId: state.nextInstanceId++, def, controller: player, owner: player, zone: 'hand',
    tapped: false, summoningSick: false, damageMarked: 0, markedByDeathtouch: false, counters: {},
  };
  state.players[player].hand.push(inst);
  return inst.instanceId;
}

/** Effective P/T reading the continuous layer for a battlefield instance. */
function pt(state: GameState, id: InstanceId): { power: number; toughness: number } {
  const inst = state.battlefield.find((c) => c.instanceId === id)!;
  const mod = indexContinuous(state).get(id) ?? NO_MOD;
  return { power: effectivePower(inst, mod), toughness: effectiveToughness(inst, mod) };
}

// --- Giant Growth: pump applies, then wears off at cleanup ----------------------

describe('Giant Growth — until-EOT pump applies this turn and expires at cleanup', () => {
  it('raises effective P/T this turn and is back to base next turn', () => {
    const reg = buildRegistry();
    const { state } = createGame({ seed: 7, decks: { A: deck(FOREST), B: deck(FOREST) }, registry: reg });
    let s = state;
    const bear: CardDefinition = { id: 'bear', name: 'Bear', types: ['creature'], power: 2, toughness: 2, cost: { generic: 2 } };
    const bearId = place(s, bear, 'A');
    s = advanceToStep(s, 'precombatMain', reg);
    floodMana(s);
    expect(pt(s, bearId)).toEqual({ power: 2, toughness: 2 });

    const ggId = giveHand(s, 'A', getByName('Giant Growth'));
    s = act(s, { kind: 'castSpell', player: 'A', instanceId: ggId, targets: [bearId] }, reg);
    s = resolveStack(s, reg);
    // Pumped this turn.
    expect(pt(s, bearId)).toEqual({ power: 5, toughness: 5 });
    expect(s.continuous.length).toBe(1);

    // Advance into the opponent's turn — the cleanup step expired the buff.
    s = advanceUntilActive(s, 'B', reg);
    expect(s.continuous.length).toBe(0);
    expect(pt(s, bearId)).toEqual({ power: 2, toughness: 2 });
  });
});

// --- Young Pyromancer: cast an instant → a 1/1 token ----------------------------

describe('Young Pyromancer — casting an instant makes a 1/1 red Elemental token', () => {
  it('a token appears under the caster when an instant is cast', () => {
    const reg = buildRegistry();
    const { state } = createGame({ seed: 8, decks: { A: deck(MOUNTAIN), B: deck(MOUNTAIN) }, registry: reg });
    let s = state;
    place(s, getByName('Young Pyromancer'), 'A');
    s = advanceToStep(s, 'precombatMain', reg);
    floodMana(s);
    const tokensBefore = s.battlefield.filter((c) => c.def.name === 'Elemental').length;

    const boltId = giveHand(s, 'A', getByName('Lightning Bolt'));
    s = act(s, { kind: 'castSpell', player: 'A', instanceId: boltId, targets: ['B'] }, reg);
    s = resolveStack(s, reg);

    const tokens = s.battlefield.filter((c) => c.def.name === 'Elemental');
    expect(tokens.length).toBe(tokensBefore + 1);
    expect(tokens[0]!.controller).toBe('A');
    expect(tokens[0]!.def.power).toBe(1);
    expect(tokens[0]!.def.toughness).toBe(1);
  });
});

// --- Monastery Swiftspear: prowess +1/+1 this turn, gone next turn --------------

describe('Monastery Swiftspear — prowess buffs this turn and wears off next turn', () => {
  it('casting an instant gives +1/+1 that turn; it is gone the following turn', () => {
    const reg = buildRegistry();
    const { state } = createGame({ seed: 9, decks: { A: deck(MOUNTAIN), B: deck(MOUNTAIN) }, registry: reg });
    let s = state;
    const swiftId = place(s, getByName('Monastery Swiftspear'), 'A'); // base 1/2
    s = advanceToStep(s, 'precombatMain', reg);
    floodMana(s);
    expect(pt(s, swiftId)).toEqual({ power: 1, toughness: 2 });

    const boltId = giveHand(s, 'A', getByName('Lightning Bolt'));
    s = act(s, { kind: 'castSpell', player: 'A', instanceId: boltId, targets: ['B'] }, reg);
    s = resolveStack(s, reg);
    // Prowess fired: +1/+1 this turn.
    expect(pt(s, swiftId)).toEqual({ power: 2, toughness: 3 });

    // Next turn the buff is gone.
    s = advanceUntilActive(s, 'B', reg);
    expect(pt(s, swiftId)).toEqual({ power: 1, toughness: 2 });
  });
});

// --- Kitchen Finks: persist returns with -1/-1, then dies for good --------------

describe('Kitchen Finks — persist returns with a -1/-1 counter, then dies for good', () => {
  it('returns as a 2/1 on first death and stays dead on the second', () => {
    const reg = buildRegistry();
    const { state } = createGame({ seed: 10, decks: { A: deck(FOREST), B: deck(FOREST) }, registry: reg });
    let s = state;
    const finksId = place(s, getByName('Kitchen Finks'), 'A'); // base 3/2
    s = advanceToStep(s, 'precombatMain', reg);
    floodMana(s);
    const lifeBefore = s.players.A.life;

    // Kill it with a Lightning Bolt (3 to a 3/2 is lethal).
    const bolt1 = giveHand(s, 'A', getByName('Lightning Bolt'));
    s = act(s, { kind: 'castSpell', player: 'A', instanceId: bolt1, targets: [finksId] }, reg);
    s = resolveStack(s, reg);

    // Persist: it is back on the battlefield as a 2/1 (3/2 with a -1/-1 counter),
    // and the ETB lifegain re-fired (gain 2 again).
    const returned = s.battlefield.find((c) => c.def.name === 'Kitchen Finks');
    expect(returned).toBeDefined();
    // A REAL -1/-1 counter (CR 702.79a). It used to be written as a negative
    // '+1/+1' tally, which nets the same power and toughness but is invisible to
    // 'does it have a -1/-1 counter on it?' — persist's own printed condition —
    // and to the CR 704.5q annihilation.
    expect(returned!.counters['-1/-1']).toBe(1);
    expect(returned!.counters['+1/+1'] ?? 0).toBe(0);
    expect(effectivePower(returned!)).toBe(2);
    expect(effectiveToughness(returned!)).toBe(1);
    expect(s.players.A.life).toBe(lifeBefore + 2); // ETB lifegain fired on the return

    // Kill it again — this time it does NOT come back (persist trigger was stripped).
    const bolt2 = giveHand(s, 'A', getByName('Lightning Bolt'));
    floodMana(s);
    s = act(s, { kind: 'castSpell', player: 'A', instanceId: bolt2, targets: [returned!.instanceId] }, reg);
    s = resolveStack(s, reg);
    expect(s.battlefield.some((c) => c.def.name === 'Kitchen Finks')).toBe(false);
    expect(s.players.A.graveyard.some((c) => c.def.name === 'Kitchen Finks')).toBe(true);
  });
});

// --- smoke: supported cards resolve with no effectUnsupported -------------------

describe('pool smoke run — supported cards resolve with no effectUnsupported events', () => {
  it('casting representative supported spells/creatures never emits effectUnsupported', () => {
    const reg = buildRegistry();
    const { state } = createGame({ seed: 11, decks: { A: deck(FOREST), B: deck(FOREST) }, registry: reg });
    let s = state;
    s = advanceToStep(s, 'precombatMain', reg);
    floodMana(s);

    const supported = [
      'Lightning Bolt', 'Giant Growth', 'Doom Blade', 'Brainstorm', 'Ponder', 'Dark Ritual',
      'Kitchen Finks', 'Eternal Witness', 'Young Pyromancer', 'Monastery Swiftspear',
    ];
    const allEvents: string[] = [];
    // A sink that applies an action while accumulating every event it produces.
    const sink = (st: GameState, a: GameAction): GameState => {
      const r = applyAction(st, a, DEFAULT_RULES, reg);
      r.events.forEach((e) => allEvents.push(e.type));
      return r.state;
    };
    // Resolve everything, ANSWERING any question a card parks — several of these
    // cards ask one now (Brainstorm's put-back, Ponder's reorder), and while a
    // choice is parked passing is rejected, so a loop that only passed would
    // quietly stop casting anything after the first one.
    const resolveSink = (st: GameState, max = 50): GameState => {
      let cur = st;
      let g = 0;
      while ((cur.stack.length > 0 || cur.pendingChoice) && !cur.gameOver && g++ < max) {
        const choice = cur.pendingChoice;
        cur = choice
          ? sink(cur, {
              kind: 'answerChoice',
              player: choice.chooser,
              choiceId: choice.id,
              answer: defaultAnswerFor(choice),
            })
          : sink(cur, { kind: 'passPriority', player: cur.priorityPlayer });
      }
      return cur;
    };

    // Provide a creature target for Giant Growth / Doom Blade.
    const dummyId = place(s, { id: 'd', name: 'Dummy', types: ['creature'], power: 1, toughness: 4 }, 'A');

    for (const name of supported) {
      const def = getByName(name);
      const id = giveHand(s, 'A', def);
      floodMana(s);
      const needsTarget = def.effects?.some((e) => e.primitive === 'pumpUntilEndOfTurn' || e.primitive === 'destroyTarget');
      const targets = needsTarget ? [dummyId] : [];
      s = sink(s, { kind: 'castSpell', player: 'A', instanceId: id, targets });
      s = resolveSink(s);
    }
    expect(allEvents).not.toContain('effectUnsupported');
    expect(allEvents).toContain('effectApplied');
  });
});

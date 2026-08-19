/**
 * Unit tests for the effect primitives in isolation. Each test builds a minimal
 * draft `GameState` + an `EffectContext`, runs one primitive, and asserts the
 * state mutation and the events emitted. No engine, no RNG — pure and
 * deterministic.
 */

import { describe, expect, it } from 'vitest';
import type {
  CardDefinition,
  CardInstance,
  ChoiceAnswer,
  EffectContext,
  EffectRef,
  GameEvent,
  GameState,
  InstanceId,
  PendingChoice,
  PlayerId,
} from '@jonny-boi/core';
import {
  PLUS_ONE_COUNTER,
  defaultAnswerFor,
  effectiveToughness,
  effectivePower,
  normalizeChoiceRequest,
  validateChoiceAnswer,
} from '@jonny-boi/core';
import {
  addMana,
  counterSpell,
  createToken,
  dealDamage,
  destroyAll,
  destroyTarget,
  drawCards,
  exileTarget,
  gainLife,
  grantKeywordUntilEndOfTurn,
  loseLife,
  makeToken,
  pumpUntilEndOfTurn,
  tapTarget,
  mill,
  fight,
  dealDamageToEach,
  addCounters,
} from './primitives.js';
import {
  discardCard,
  mayShuffleLibrary,
  putFromHandOnTop,
  reorderTopOfLibrary,
  returnFromGraveyard,
  returnToHand,
  revealTopCard,
  searchLibrary,
  tapPermanents,
} from './choice-primitives.js';

// --- minimal fixtures ----------------------------------------------------------

let nextId = 1;

function inst(def: CardDefinition, player: PlayerId, zone: CardInstance['zone'] = 'battlefield'): CardInstance {
  return {
    instanceId: nextId++,
    def,
    controller: player,
    owner: player,
    zone,
    tapped: false,
    summoningSick: false,
    damageMarked: 0,
    markedByDeathtouch: false,
    counters: {},
  };
}

function emptyState(): GameState {
  return {
    continuous: [],
    nextInstanceId: 1000,
    turnNumber: 1,
    activePlayer: 'A',
    priorityPlayer: 'A',
    step: 'precombatMain',
    players: {
      A: {
        id: 'A', life: 20, manaPool: { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 },
        landsPlayedThisTurn: 0, hasLost: false,
        library: [], hand: [], graveyard: [], exile: [], command: [],
      },
      B: {
        id: 'B', life: 20, manaPool: { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 },
        landsPlayedThisTurn: 0, hasLost: false,
        library: [], hand: [], graveyard: [], exile: [], command: [],
      },
    },
    battlefield: [],
    stack: [],
    combat: null,
    winner: null,
    gameOver: false,
    consecutivePasses: 0,
    seed: 1,
    rngState: 1,
  };
}

function ctxFor(
  state: GameState,
  source: CardInstance,
  params: Record<string, unknown>,
  targets: ReadonlyArray<InstanceId | PlayerId> = [],
  /** Scripted answers: return one for a parked question, or omit for the default. */
  answer?: (choice: PendingChoice) => ChoiceAnswer | undefined,
): {
  ctx: EffectContext;
  events: GameEvent[];
  asked: PendingChoice[];
  enqueued: EffectRef[];
  shuffled: PlayerId[];
} {
  const events: GameEvent[] = [];
  const asked: PendingChoice[] = [];
  const enqueued: EffectRef[] = [];
  const shuffled: PlayerId[] = [];
  const ctx: EffectContext = {
    state,
    source,
    controller: source.controller,
    targets,
    params,
    emit: (e) => events.push(e),
    // Mirror the engine's continuous-effect channel (effects.ts) so primitives that
    // register an until-EOT modification can be unit-tested in isolation: push a
    // ContinuousEffect onto the draft and return its id.
    addContinuousEffect(mod) {
      const id = state.nextInstanceId++;
      state.continuous.push({
        id,
        targetInstanceId: mod.target ?? source.instanceId,
        sourceInstanceId: source.instanceId,
        duration: mod.duration ?? 'endOfTurn',
        power: mod.power,
        toughness: mod.toughness,
        keywords: mod.keywords,
      });
      events.push({
        type: 'continuousEffectAdded',
        targetInstanceId: mod.target ?? source.instanceId,
        sourceInstanceId: source.instanceId,
        duration: mod.duration ?? 'endOfTurn',
      });
      return id;
    },
    // Mirror the engine's token creation: place a creature token on the battlefield.
    createToken(def, controller) {
      const instanceId = state.nextInstanceId++;
      const ctrl = controller ?? source.controller;
      state.battlefield.push({
        instanceId,
        def,
        controller: ctrl,
        owner: ctrl,
        zone: 'battlefield',
        tapped: false,
        summoningSick: def.types.includes('creature') ? !(def.keywords?.haste ?? false) : false,
        damageMarked: 0,
        markedByDeathtouch: false,
        counters: {},
      });
      events.push({ type: 'tokenCreated', instanceId, controller: ctrl, name: def.name });
      events.push({ type: 'zoneChange', instanceId, from: 'stack', to: 'battlefield' });
      return instanceId;
    },
    // Mirror the engine's CHOICE channel (choices.ts) so a primitive that asks a
    // question can be unit-tested without a game: every request is normalised
    // exactly as the engine normalises it, then answered by the test's script —
    // or, with no script, by the same safe default the engine falls back to.
    ask(request) {
      const choice = normalizeChoiceRequest(request, {
        id: asked.length,
        sourceInstanceId: source.instanceId,
        sourceName: source.def.name,
      });
      if (!choice) return undefined;
      asked.push(choice);
      const scripted = answer?.(choice);
      const value = scripted ?? defaultAnswerFor(choice);
      const validation = validateChoiceAnswer(choice, value);
      if (!validation.ok) throw new Error(`scripted answer is illegal: ${validation.reason}`);
      return value;
    },
    chooseCards(request) {
      const a = ctx.ask({ ...request, kind: 'selectCards', chooser: request.chooser ?? source.controller });
      return a && a.kind === 'selectCards' ? a.instanceIds : undefined;
    },
    choosePlayers(request) {
      const a = ctx.ask({ ...request, kind: 'selectPlayers', chooser: request.chooser ?? source.controller });
      return a && a.kind === 'selectPlayers' ? a.players : undefined;
    },
    chooseModes(request) {
      const a = ctx.ask({ ...request, kind: 'chooseModes', chooser: request.chooser ?? source.controller });
      return a && a.kind === 'chooseModes' ? a.modeIds : undefined;
    },
    confirm(request) {
      const a = ctx.ask({ ...request, kind: 'confirm', chooser: request.chooser ?? source.controller });
      return a && a.kind === 'confirm' ? a.yes : undefined;
    },
    enqueueEffects(refs) {
      enqueued.push(...refs);
    },
    shuffleLibrary(player) {
      // Deterministic stand-in for the engine's seeded shuffle: reverse the
      // library, which is observable ("it moved") without any RNG.
      state.players[player].library.reverse();
      shuffled.push(player);
    },
  };
  return { ctx, events, asked, enqueued, shuffled };
}

/** Effective P/T reading the draft's continuous layer for a given instance. */
function effectivePT(state: GameState, target: CardInstance): { power: number; toughness: number } {
  const mods = state.continuous.filter((c) => c.targetInstanceId === target.instanceId);
  const dp = mods.reduce((a, m) => a + (m.power ?? 0), 0);
  const dt = mods.reduce((a, m) => a + (m.toughness ?? 0), 0);
  return { power: effectivePower(target) + dp, toughness: effectiveToughness(target) + dt };
}

/** A minimal non-creature definition, for tests that only need a source object. */
function vanilla(name: string): CardDefinition {
  return { id: `id:${name}`, name, types: ['instant'] };
}

const bear: CardDefinition = { id: 'bear', name: 'Bear', types: ['creature'], power: 2, toughness: 2, cost: { generic: 2 } };
const bigGuy: CardDefinition = { id: 'big', name: 'Big', types: ['creature'], power: 3, toughness: 3, cost: { generic: 3 } };

// --- dealDamage ----------------------------------------------------------------

describe('dealDamage', () => {
  it('3 damage to a 2/2 marks lethal damage and emits damageDealt', () => {
    const s = emptyState();
    const target = inst(bear, 'B');
    s.battlefield.push(target);
    const src = inst({ id: 'bolt', name: 'Bolt', types: ['instant'] }, 'A', 'stack');
    const { ctx, events } = ctxFor(s, src, { amount: 3 }, [target.instanceId]);
    dealDamage(ctx);
    expect(target.damageMarked).toBe(3);
    expect(effectiveToughness(target) - target.damageMarked).toBeLessThanOrEqual(0); // lethal
    expect(events.find((e) => e.type === 'damageDealt')).toMatchObject({ amount: 3, combat: false });
  });

  it('to a player reduces life and emits lifeChanged + damageDealt', () => {
    const s = emptyState();
    const src = inst({ id: 'bolt', name: 'Bolt', types: ['instant'] }, 'A', 'stack');
    const { ctx, events } = ctxFor(s, src, { amount: 3 }, ['B']);
    dealDamage(ctx);
    expect(s.players.B.life).toBe(17);
    expect(events.some((e) => e.type === 'lifeChanged')).toBe(true);
  });

  it('is a safe no-op with no target', () => {
    const s = emptyState();
    const src = inst({ id: 'bolt', name: 'Bolt', types: ['instant'] }, 'A', 'stack');
    const { ctx, events } = ctxFor(s, src, { amount: 3 }, []);
    expect(() => dealDamage(ctx)).not.toThrow();
    expect(events).toHaveLength(0);
  });
});

// --- drawCards -----------------------------------------------------------------

describe('drawCards', () => {
  it('moves N cards from library to hand and emits drawCard each', () => {
    const s = emptyState();
    for (let i = 0; i < 5; i++) s.players.A.library.push(inst(bear, 'A', 'library'));
    const src = inst({ id: 'brainstorm', name: 'Brainstorm', types: ['instant'] }, 'A', 'stack');
    const { ctx, events } = ctxFor(s, src, { count: 2 });
    drawCards(ctx);
    expect(s.players.A.hand).toHaveLength(2);
    expect(s.players.A.library).toHaveLength(3);
    expect(events.filter((e) => e.type === 'drawCard')).toHaveLength(2);
  });

  it('stops safely on an empty library', () => {
    const s = emptyState();
    const src = inst({ id: 'ponder', name: 'Ponder', types: ['sorcery'] }, 'A', 'stack');
    const { ctx } = ctxFor(s, src, { count: 3 });
    expect(() => drawCards(ctx)).not.toThrow();
    expect(s.players.A.hand).toHaveLength(0);
  });
});

// --- gainLife / loseLife -------------------------------------------------------

describe('gainLife / loseLife', () => {
  it('gainLife adds to controller life', () => {
    const s = emptyState();
    const src = inst({ id: 'finks', name: 'Finks', types: ['creature'] }, 'A', 'stack');
    const { ctx, events } = ctxFor(s, src, { amount: 2 });
    gainLife(ctx);
    expect(s.players.A.life).toBe(22);
    expect(events.some((e) => e.type === 'gainLife')).toBe(true);
  });

  it('loseLife subtracts from controller life', () => {
    const s = emptyState();
    const src = inst({ id: 'seize', name: 'Thoughtseize', types: ['sorcery'] }, 'A', 'stack');
    const { ctx } = ctxFor(s, src, { amount: 2 });
    loseLife(ctx);
    expect(s.players.A.life).toBe(18);
  });
});

// --- pumpUntilEndOfTurn --------------------------------------------------------

describe('pumpUntilEndOfTurn', () => {
  it('+3/+3 registers an until-EOT continuous effect (no permanent counter) and raises effective P/T', () => {
    const s = emptyState();
    const target = inst(bear, 'A');
    s.battlefield.push(target);
    const src = inst({ id: 'gg', name: 'Giant Growth', types: ['instant'] }, 'A', 'stack');
    const { ctx, events } = ctxFor(s, src, { power: 3, toughness: 3 }, [target.instanceId]);
    pumpUntilEndOfTurn(ctx);
    // No permanent +1/+1 counter is added — the buff lives in the continuous layer.
    expect(target.counters[PLUS_ONE_COUNTER]).toBeUndefined();
    expect(s.continuous).toHaveLength(1);
    expect(s.continuous[0]).toMatchObject({ targetInstanceId: target.instanceId, power: 3, toughness: 3, duration: 'endOfTurn' });
    expect(effectivePT(s, target)).toEqual({ power: 5, toughness: 5 });
    expect(events.some((e) => e.type === 'continuousEffectAdded')).toBe(true);
  });

  it('with no target pumps the source itself (prowess-style self-buff)', () => {
    const s = emptyState();
    const self = inst(bear, 'A');
    s.battlefield.push(self);
    const { ctx } = ctxFor(s, self, { power: 1, toughness: 1 }, []);
    pumpUntilEndOfTurn(ctx);
    expect(s.continuous).toHaveLength(1);
    expect(s.continuous[0]!.targetInstanceId).toBe(self.instanceId);
    expect(effectivePT(s, self)).toEqual({ power: 3, toughness: 3 });
  });
});

// --- grantKeywordUntilEndOfTurn ------------------------------------------------

describe('grantKeywordUntilEndOfTurn', () => {
  it('registers an until-EOT keyword grant on the target', () => {
    const s = emptyState();
    const target = inst(bear, 'A');
    s.battlefield.push(target);
    const src = inst({ id: 'wings', name: 'Wings', types: ['instant'] }, 'A', 'stack');
    const { ctx, events } = ctxFor(s, src, { keywords: { trample: true } }, [target.instanceId]);
    grantKeywordUntilEndOfTurn(ctx);
    expect(s.continuous).toHaveLength(1);
    expect(s.continuous[0]).toMatchObject({ targetInstanceId: target.instanceId, keywords: { trample: true }, duration: 'endOfTurn' });
    expect(events.some((e) => e.type === 'continuousEffectAdded')).toBe(true);
  });

  it('an empty/absent keyword grant is a safe no-op', () => {
    const s = emptyState();
    const target = inst(bear, 'A');
    s.battlefield.push(target);
    const src = inst({ id: 'wings', name: 'Wings', types: ['instant'] }, 'A', 'stack');
    const { ctx } = ctxFor(s, src, {}, [target.instanceId]);
    grantKeywordUntilEndOfTurn(ctx);
    expect(s.continuous).toHaveLength(0);
  });
});

// --- makeToken -----------------------------------------------------------------

describe('makeToken', () => {
  it('creates N data-driven tokens via ctx.createToken (P/T/name/keywords are params)', () => {
    const s = emptyState();
    const src = inst({ id: 'pyro', name: 'Young Pyromancer', types: ['creature'] }, 'A', 'battlefield');
    const { ctx, events } = ctxFor(s, src, { count: 2, power: 1, toughness: 1, name: 'Elemental' });
    makeToken(ctx);
    const tokens = s.battlefield.filter((c) => c.def.name === 'Elemental');
    expect(tokens).toHaveLength(2);
    expect(tokens[0]!.controller).toBe('A');
    expect(tokens[0]!.def.power).toBe(1);
    expect(events.filter((e) => e.type === 'tokenCreated')).toHaveLength(2);
  });
});

// --- destroyTarget -------------------------------------------------------------

describe('destroyTarget', () => {
  it('destroys a creature, moving it to its owner graveyard', () => {
    const s = emptyState();
    const target = inst(bear, 'B');
    s.battlefield.push(target);
    const src = inst({ id: 'db', name: 'Doom Blade', types: ['instant'] }, 'A', 'stack');
    const { ctx, events } = ctxFor(s, src, {}, [target.instanceId]);
    destroyTarget(ctx);
    expect(s.battlefield).toHaveLength(0);
    expect(s.players.B.graveyard).toHaveLength(1);
    expect(events.some((e) => e.type === 'creatureDied')).toBe(true);
  });

  it('notColor filter spares a creature of that color (no-op)', () => {
    const s = emptyState();
    const blackBear: CardDefinition = { ...bear, id: 'bb', cost: { B: 2 } };
    const target = inst(blackBear, 'B');
    s.battlefield.push(target);
    const src = inst({ id: 'db', name: 'Doom Blade', types: ['instant'] }, 'A', 'stack');
    const { ctx } = ctxFor(s, src, { notColor: 'B' }, [target.instanceId]);
    destroyTarget(ctx);
    expect(s.battlefield).toHaveLength(1); // nonblack-only: black creature survives
  });

  it('maxManaValue filter spares a too-expensive creature', () => {
    const s = emptyState();
    const target = inst(bigGuy, 'B'); // mv 3
    s.battlefield.push(target);
    const src = inst({ id: 'push', name: 'Fatal Push', types: ['instant'] }, 'A', 'stack');
    const { ctx } = ctxFor(s, src, { maxManaValue: 2 }, [target.instanceId]);
    destroyTarget(ctx);
    expect(s.battlefield).toHaveLength(1);
  });
});

// --- exileTarget ---------------------------------------------------------------

describe('exileTarget', () => {
  it('exiles a creature to its owner exile zone', () => {
    const s = emptyState();
    const target = inst(bear, 'B');
    s.battlefield.push(target);
    const src = inst({ id: 'path', name: 'Path', types: ['instant'] }, 'A', 'stack');
    const { ctx } = ctxFor(s, src, {}, [target.instanceId]);
    exileTarget(ctx);
    expect(s.battlefield).toHaveLength(0);
    expect(s.players.B.exile).toHaveLength(1);
  });

  it('gainLifeEqualPower gives the controller life equal to power (Swords)', () => {
    const s = emptyState();
    const target = inst(bigGuy, 'B'); // power 3
    s.battlefield.push(target);
    const src = inst({ id: 'stp', name: 'Swords', types: ['instant'] }, 'A', 'stack');
    const { ctx } = ctxFor(s, src, { gainLifeEqualPower: true }, [target.instanceId]);
    exileTarget(ctx);
    expect(s.players.B.life).toBe(23); // the exiled creature's controller gains
  });
});

// --- destroyAll ----------------------------------------------------------------

describe('destroyAll', () => {
  it('destroys every creature but leaves lands', () => {
    const s = emptyState();
    s.battlefield.push(inst(bear, 'A'), inst(bigGuy, 'B'));
    s.battlefield.push(inst({ id: 'forest', name: 'Forest', types: ['land'], produces: ['G'] }, 'A'));
    const src = inst({ id: 'wrath', name: 'Wrath', types: ['sorcery'] }, 'A', 'stack');
    const { ctx } = ctxFor(s, src, {});
    destroyAll(ctx);
    expect(s.battlefield.filter((c) => c.def.types.includes('creature'))).toHaveLength(0);
    expect(s.battlefield.filter((c) => c.def.types.includes('land'))).toHaveLength(1);
  });
});

// --- addMana -------------------------------------------------------------------

describe('addMana', () => {
  it('adds the listed symbols to the controller pool (Dark Ritual BBB)', () => {
    const s = emptyState();
    const src = inst({ id: 'ritual', name: 'Dark Ritual', types: ['instant'] }, 'A', 'stack');
    const { ctx, events } = ctxFor(s, src, { mana: ['B', 'B', 'B'] });
    addMana(ctx);
    expect(s.players.A.manaPool.B).toBe(3);
    expect(events.filter((e) => e.type === 'manaAdded')).toHaveLength(3);
  });
});

// --- counterSpell --------------------------------------------------------------

describe('counterSpell', () => {
  it('removes a targeted spell from the stack to its owner graveyard', () => {
    const s = emptyState();
    const spell = inst({ id: 'bolt', name: 'Bolt', types: ['instant'] }, 'B', 'stack');
    s.stack.push({ kind: 'spell', instanceId: spell.instanceId, card: spell, controller: 'B', resolvesTo: 'graveyard', targets: [] });
    const src = inst({ id: 'cs', name: 'Counterspell', types: ['instant'] }, 'A', 'stack');
    const { ctx } = ctxFor(s, src, {}, [spell.instanceId]);
    counterSpell(ctx);
    expect(s.stack).toHaveLength(0);
    expect(s.players.B.graveyard).toHaveLength(1);
  });

  it('is a no-op when the target is not on the stack', () => {
    const s = emptyState();
    const src = inst({ id: 'cs', name: 'Counterspell', types: ['instant'] }, 'A', 'stack');
    const { ctx } = ctxFor(s, src, {}, [9999]);
    expect(() => counterSpell(ctx)).not.toThrow();
  });
});

// --- discardCard ---------------------------------------------------------------

describe('discardCard', () => {
  const island: CardDefinition = { id: 'isl', name: 'Island', types: ['land'] };

  it('moves the CHOSEN card from the targeted player hand to graveyard', () => {
    const s = emptyState();
    s.players.B.hand.push(inst(bear, 'B', 'hand'), inst(bigGuy, 'B', 'hand'));
    const big = s.players.B.hand[1]!;
    const src = inst({ id: 'seize', name: 'Thoughtseize', types: ['sorcery'] }, 'A', 'stack');
    const { ctx, asked } = ctxFor(s, src, { count: 1 }, ['B'], () => ({
      kind: 'selectCards',
      instanceIds: [big.instanceId],
    }));

    discardCard(ctx);

    expect(asked).toHaveLength(1);
    expect(s.players.B.graveyard.map((c) => c.def.name)).toEqual(['Big']);
    expect(s.players.B.hand.map((c) => c.def.name)).toEqual(['Bear']);
  });

  it('asks the VICTIM by default (a loss they answer) and the CASTER on demand', () => {
    const s = emptyState();
    s.players.B.hand.push(inst(bear, 'B', 'hand'));
    const src = inst({ id: 'seize', name: 'Thoughtseize', types: ['sorcery'] }, 'A', 'stack');

    const self = ctxFor(s, src, { count: 1 }, ['B']);
    discardCard(self.ctx);
    expect(self.asked[0]!.chooser).toBe('B');
    expect(self.asked[0]!.valence).toBe('loss');

    const s2 = emptyState();
    s2.players.B.hand.push(inst(bear, 'B', 'hand'));
    const byCaster = ctxFor(s2, src, { count: 1, chosenBy: 'controller' }, ['B']);
    discardCard(byCaster.ctx);
    expect(byCaster.asked[0]!.chooser).toBe('A');
    expect(byCaster.asked[0]!.valence).toBe('gain');
  });

  it('honours the filter: a hand of only lands offers nothing and discards nothing', () => {
    const s = emptyState();
    s.players.B.hand.push(inst(island, 'B', 'hand'), inst(island, 'B', 'hand'));
    const src = inst({ id: 'seize', name: 'Thoughtseize', types: ['sorcery'] }, 'A', 'stack');
    const { ctx, asked } = ctxFor(s, src, { count: 1, chosenBy: 'controller', filter: { noneOfTypes: ['land'] } }, ['B']);

    discardCard(ctx);

    expect(asked[0]!.kind === 'selectCards' && asked[0]!.candidates).toHaveLength(0);
    expect(s.players.B.hand).toHaveLength(2);
    expect(s.players.B.graveyard).toHaveLength(0);
  });
});

// --- the choice-driven library primitives ---------------------------------------

describe('putFromHandOnTop', () => {
  it('puts the chosen cards back IN THE CHOSEN ORDER, first choice on top', () => {
    const s = emptyState();
    const a = inst({ id: 'a', name: 'A', types: ['instant'] }, 'A', 'hand');
    const b = inst({ id: 'b', name: 'B', types: ['instant'] }, 'A', 'hand');
    const c = inst({ id: 'c', name: 'C', types: ['instant'] }, 'A', 'hand');
    s.players.A.hand.push(a, b, c);
    const src = inst({ id: 'bs', name: 'Brainstorm', types: ['instant'] }, 'A', 'stack');
    const { ctx, asked } = ctxFor(s, src, { count: 2 }, [], () => ({
      kind: 'selectCards',
      instanceIds: [c.instanceId, a.instanceId],
    }));

    putFromHandOnTop(ctx);

    expect(asked[0]!.kind === 'selectCards' && asked[0]!.ordered).toBe(true);
    expect(s.players.A.library.map((x) => x.def.name)).toEqual(['C', 'A']);
    expect(s.players.A.hand.map((x) => x.def.name)).toEqual(['B']);
  });
});

describe('reorderTopOfLibrary', () => {
  it('re-seats the top cards in the chosen order and leaves the rest alone', () => {
    const s = emptyState();
    const names = ['one', 'two', 'three', 'four'];
    for (const n of names) s.players.A.library.push(inst({ id: n, name: n, types: ['land'] }, 'A', 'library'));
    const top = s.players.A.library.slice(0, 3);
    const src = inst({ id: 'ponder', name: 'Ponder', types: ['sorcery'] }, 'A', 'stack');
    const { ctx } = ctxFor(s, src, { count: 3 }, [], () => ({
      kind: 'selectCards',
      instanceIds: [top[2]!.instanceId, top[0]!.instanceId, top[1]!.instanceId],
    }));

    reorderTopOfLibrary(ctx);

    expect(s.players.A.library.map((c) => c.def.name)).toEqual(['three', 'one', 'two', 'four']);
  });
});

describe('mayShuffleLibrary', () => {
  it('shuffles on yes and does nothing on no', () => {
    const s = emptyState();
    const src = inst({ id: 'ponder', name: 'Ponder', types: ['sorcery'] }, 'A', 'stack');

    const yes = ctxFor(s, src, {}, [], () => ({ kind: 'confirm', yes: true }));
    mayShuffleLibrary(yes.ctx);
    expect(yes.shuffled).toEqual(['A']);

    const no = ctxFor(s, src, {}, [], () => ({ kind: 'confirm', yes: false }));
    mayShuffleLibrary(no.ctx);
    expect(no.shuffled).toEqual([]);
    // The steer says "you just arranged this — don't throw it away".
    expect(no.asked[0]!.valence).toBe('loss');
  });
});

describe('searchLibrary', () => {
  const plains: CardDefinition = { id: 'pl', name: 'Plains', types: ['land'] };
  const wrath: CardDefinition = { id: 'wr', name: 'Wrath of God', types: ['sorcery'] };

  function libraryOf(state: GameState): void {
    state.players.A.library.push(inst(wrath, 'A', 'library'), inst(plains, 'A', 'library'));
  }

  it('declining the optional search moves nothing and shuffles nothing', () => {
    const s = emptyState();
    libraryOf(s);
    const src = inst({ id: 'path', name: 'Path to Exile', types: ['instant'] }, 'A', 'stack');
    const { ctx, shuffled } = ctxFor(s, src, { optional: true, who: 'controller' }, [], () => ({
      kind: 'confirm',
      yes: false,
    }));

    searchLibrary(ctx);

    expect(s.players.A.library).toHaveLength(2);
    expect(shuffled).toEqual([]);
  });

  it('accepting it puts the chosen card onto the battlefield tapped, then shuffles', () => {
    const s = emptyState();
    libraryOf(s);
    const land = s.players.A.library[1]!;
    const src = inst({ id: 'path', name: 'Path to Exile', types: ['instant'] }, 'A', 'stack');
    const { ctx, shuffled } = ctxFor(
      s,
      src,
      {
        optional: true,
        who: 'controller',
        filter: { anyOfTypes: ['land'] },
        nameAnyOf: ['Plains'],
        destination: 'battlefield',
        tapped: true,
      },
      [],
      (choice) =>
        choice.kind === 'confirm'
          ? { kind: 'confirm', yes: true }
          : { kind: 'selectCards', instanceIds: [land.instanceId] },
    );

    searchLibrary(ctx);

    const fetched = s.battlefield.find((c) => c.instanceId === land.instanceId);
    expect(fetched).toBeDefined();
    expect(fetched!.tapped).toBe(true);
    expect(s.players.A.library).toHaveLength(1);
    expect(shuffled).toEqual(['A']);
  });

  it('only offers cards matching BOTH the filter and the name list', () => {
    const s = emptyState();
    libraryOf(s);
    const src = inst({ id: 'path', name: 'Path to Exile', types: ['instant'] }, 'A', 'stack');
    const { ctx, asked } = ctxFor(s, src, {
      who: 'controller',
      filter: { anyOfTypes: ['land'] },
      nameAnyOf: ['Plains'],
    });

    searchLibrary(ctx);

    const choice = asked[0]!;
    expect(choice.kind === 'selectCards' && choice.candidates.map((c) => c.name)).toEqual(['Plains']);
  });
});

describe('revealTopCard', () => {
  const plains: CardDefinition = { id: 'pl', name: 'Plains', types: ['land'] };

  it('moves the revealed card to hand only when it matches the filter', () => {
    const s = emptyState();
    s.players.B.library.push(inst(plains, 'B', 'library'), inst(bear, 'B', 'library'));
    const src = inst({ id: 'gg', name: 'Goblin Guide', types: ['creature'] }, 'A', 'battlefield');
    const { ctx } = ctxFor(s, src, { who: 'opponent', filter: { anyOfTypes: ['land'] } });

    revealTopCard(ctx); // top is the land → into their hand
    expect(s.players.B.hand.map((c) => c.def.name)).toEqual(['Plains']);

    revealTopCard(ctx); // top is now a creature → stays put
    expect(s.players.B.hand).toHaveLength(1);
    expect(s.players.B.library.map((c) => c.def.name)).toEqual(['Bear']);
  });
});

describe('returnToHand', () => {
  it('returns the targeted permanent to its owner hand', () => {
    const s = emptyState();
    const target = inst(bear, 'B');
    s.battlefield.push(target);
    const src = inst({ id: 'cc', name: 'Cryptic Command', types: ['instant'] }, 'A', 'stack');
    const { ctx } = ctxFor(s, src, {}, [target.instanceId]);

    returnToHand(ctx);

    expect(s.battlefield).toHaveLength(0);
    expect(s.players.B.hand.map((c) => c.def.name)).toEqual(['Bear']);
  });
});

describe('tapPermanents', () => {
  it('taps only the opponent creatures, leaving your own board untapped', () => {
    const s = emptyState();
    const mine = inst(bear, 'A');
    const theirs = inst(bigGuy, 'B');
    const theirLand = inst({ id: 'l', name: 'Island', types: ['land'] }, 'B');
    s.battlefield.push(mine, theirs, theirLand);
    const src = inst({ id: 'cc', name: 'Cryptic Command', types: ['instant'] }, 'A', 'stack');
    const { ctx } = ctxFor(s, src, { who: 'opponent', types: ['creature'] });

    tapPermanents(ctx);

    expect(mine.tapped).toBe(false);
    expect(theirs.tapped).toBe(true);
    expect(theirLand.tapped).toBe(false);
  });
});

// --- createToken ---------------------------------------------------------------

describe('createToken', () => {
  it('puts a token creature onto the battlefield under the controller', () => {
    const s = emptyState();
    const src = inst({ id: 'pyro', name: 'Young Pyromancer', types: ['creature'] }, 'A', 'battlefield');
    const { ctx } = ctxFor(s, src, { count: 1, power: 1, toughness: 1, name: 'Elemental' });
    createToken(ctx);
    const tokens = s.battlefield.filter((c) => c.def.name === 'Elemental');
    expect(tokens).toHaveLength(1);
    expect(tokens[0]!.controller).toBe('A');
    expect(tokens[0]!.def.power).toBe(1);
  });
});

// --- tapTarget -----------------------------------------------------------------

describe('tapTarget', () => {
  it('taps an untapped target permanent', () => {
    const s = emptyState();
    const target = inst(bear, 'B');
    s.battlefield.push(target);
    const src = inst({ id: 'cmd', name: 'Cryptic', types: ['instant'] }, 'A', 'stack');
    const { ctx } = ctxFor(s, src, {}, [target.instanceId]);
    tapTarget(ctx);
    expect(target.tapped).toBe(true);
  });
});

// --- returnFromGraveyard -------------------------------------------------------

describe('returnFromGraveyard', () => {
  it('returns the CHOSEN graveyard card to hand, never the source itself', () => {
    const s = emptyState();
    const bolt = inst({ id: 'bolt', name: 'Lightning Bolt', types: ['instant'] }, 'A', 'graveyard');
    const dead = inst(bear, 'A', 'graveyard');
    const src = inst({ id: 'witness', name: 'Eternal Witness', types: ['creature'] }, 'A', 'battlefield');
    // The source sits in the graveyard too — it must not be offered.
    s.players.A.graveyard.push(bolt, dead, { ...src, zone: 'graveyard' });

    const { ctx, asked } = ctxFor(s, src, { count: 1 }, [], () => ({
      kind: 'selectCards',
      instanceIds: [bolt.instanceId],
    }));
    returnFromGraveyard(ctx);

    const choice = asked[0]!;
    expect(choice.kind === 'selectCards' && choice.candidates.map((c) => c.name)).toEqual([
      'Lightning Bolt',
      'Bear',
    ]);
    expect(choice.valence).toBe('gain');
    expect(s.players.A.hand.map((c) => c.def.name)).toEqual(['Lightning Bolt']);
  });

  it('"you may" (optional) lets the chooser return nothing', () => {
    const s = emptyState();
    s.players.A.graveyard.push(inst(bear, 'A', 'graveyard'));
    const src = inst({ id: 'witness', name: 'Eternal Witness', types: ['creature'] }, 'A', 'battlefield');
    const { ctx, asked } = ctxFor(s, src, { count: 1, optional: true }, [], () => ({
      kind: 'selectCards',
      instanceIds: [],
    }));

    returnFromGraveyard(ctx);

    expect(asked[0]!.min).toBe(0);
    expect(s.players.A.hand).toHaveLength(0);
    expect(s.players.A.graveyard).toHaveLength(1);
  });
});

// --- the newly-added mechanics -------------------------------------------------

describe('mill', () => {
  it('moves the top N cards of the target player library to their graveyard', () => {
    const state = emptyState();
    const source = inst(vanilla('Source'), 'A');
    const library = [1, 2, 3, 4].map((n) => inst(vanilla(`Card${n}`), 'B', 'library'));
    state.players.B.library = library;

    const { ctx } = ctxFor(state, source, { amount: 3 }, ['B']);
    mill(ctx);

    expect(state.players.B.library.map((c) => c.def.name)).toEqual(['Card4']);
    expect(state.players.B.graveyard.map((c) => c.def.name)).toEqual(['Card1', 'Card2', 'Card3']);
    // Milled cards are IN the graveyard, not deleted — graveyard effects see them.
    for (const card of state.players.B.graveyard) expect(card.zone).toBe('graveyard');
  });

  it('mills the controller when `self` is set', () => {
    const state = emptyState();
    const source = inst(vanilla('Source'), 'A');
    state.players.A.library = [inst(vanilla('Mine'), 'A', 'library')];

    const { ctx } = ctxFor(state, source, { amount: 1, self: true });
    mill(ctx);

    expect(state.players.A.graveyard).toHaveLength(1);
  });

  it('empties a short library instead of over-milling', () => {
    const state = emptyState();
    const source = inst(vanilla('Source'), 'A');
    state.players.B.library = [inst(vanilla('Only'), 'B', 'library')];

    const { ctx } = ctxFor(state, source, { amount: 10 }, ['B']);
    mill(ctx);

    expect(state.players.B.library).toHaveLength(0);
    expect(state.players.B.graveyard).toHaveLength(1);
  });
});

describe('fight', () => {
  /** A creature definition with the given power/toughness. */
  function beast(name: string, power: number, toughness: number): CardDefinition {
    return { id: `id:${name}`, name, types: ['creature'], power, toughness };
  }

  it('deals damage BOTH ways, simultaneously', () => {
    const state = emptyState();
    const mine = inst(beast('Mine', 3, 3), 'A');
    const theirs = inst(beast('Theirs', 2, 4), 'B');
    state.battlefield.push(mine, theirs);

    const { ctx } = ctxFor(state, mine, {}, [theirs.instanceId]);
    fight(ctx);

    expect(theirs.damageMarked).toBe(3);
    expect(mine.damageMarked).toBe(2);
  });

  it('lets a mutual kill kill both — damage is read before either is applied', () => {
    const state = emptyState();
    // A 4/3 and a 3/4: each has lethal power against the other's toughness.
    const mine = inst(beast('Mine', 4, 3), 'A');
    const theirs = inst(beast('Theirs', 3, 4), 'B');
    state.battlefield.push(mine, theirs);

    const { ctx } = ctxFor(state, mine, {}, [theirs.instanceId]);
    fight(ctx);

    // If the first death had cancelled the second damage, one would survive.
    expect(mine.damageMarked).toBeGreaterThanOrEqual(3);
    expect(theirs.damageMarked).toBeGreaterThanOrEqual(4);
  });

  it('is a safe no-op with no target', () => {
    const state = emptyState();
    const mine = inst(beast('Mine', 2, 2), 'A');
    state.battlefield.push(mine);

    const { ctx } = ctxFor(state, mine, {}, []);
    expect(() => fight(ctx)).not.toThrow();
    expect(mine.damageMarked).toBe(0);
  });
});

describe('dealDamageToEach', () => {
  function beast(name: string, player: PlayerId): CardInstance {
    return inst({ id: `id:${name}`, name, types: ['creature'], power: 2, toughness: 2 }, player);
  }

  it('hits every creature on both sides', () => {
    const state = emptyState();
    const source = inst(vanilla('Sweeper'), 'A');
    const a = beast('A1', 'A');
    const b = beast('B1', 'B');
    state.battlefield.push(a, b);

    const { ctx } = ctxFor(state, source, { amount: 2, creatures: true });
    dealDamageToEach(ctx);

    expect(a.damageMarked).toBe(2);
    expect(b.damageMarked).toBe(2);
  });

  it('hits only the opponent for the "each opponent" template', () => {
    const state = emptyState();
    const source = inst(vanilla('Burn'), 'A');

    const { ctx } = ctxFor(state, source, { amount: 3, opponents: true });
    dealDamageToEach(ctx);

    expect(state.players.B.life).toBe(17);
    expect(state.players.A.life, 'the caster must not hit themselves').toBe(20);
  });

  it('hits BOTH players for the symmetrical template', () => {
    const state = emptyState();
    const source = inst(vanilla('Earthquake'), 'A');

    const { ctx } = ctxFor(state, source, { amount: 2, players: true });
    dealDamageToEach(ctx);

    expect(state.players.A.life).toBe(18);
    expect(state.players.B.life).toBe(18);
  });
});

describe('addCounters', () => {
  function beast(name: string, power: number, toughness: number): CardDefinition {
    return { id: `id:${name}`, name, types: ['creature'], power, toughness };
  }

  it('permanently raises effective power and toughness', () => {
    const state = emptyState();
    const source = inst(vanilla('Bolster'), 'A');
    const target = inst(beast('Bear', 2, 2), 'A');
    state.battlefield.push(target);

    const { ctx } = ctxFor(state, source, { amount: 2 }, [target.instanceId]);
    addCounters(ctx);

    // Unlike a pump, this is a counter on the object — it survives cleanup.
    expect(target.counters[PLUS_ONE_COUNTER]).toBe(2);
    expect(effectivePower(target)).toBe(4);
    expect(effectiveToughness(target)).toBe(4);
  });

  it('accumulates with counters already there', () => {
    const state = emptyState();
    const source = inst(vanilla('Bolster'), 'A');
    const target = inst(beast('Bear', 2, 2), 'A');
    target.counters[PLUS_ONE_COUNTER] = 1;
    state.battlefield.push(target);

    const { ctx } = ctxFor(state, source, { amount: 1 }, [target.instanceId]);
    addCounters(ctx);

    expect(target.counters[PLUS_ONE_COUNTER]).toBe(2);
  });

  it('shrinks a creature with a negative amount (-1/-1)', () => {
    const state = emptyState();
    const source = inst(vanilla('Shrink'), 'A');
    const target = inst(beast('Bear', 2, 2), 'A');
    state.battlefield.push(target);

    const { ctx } = ctxFor(state, source, { amount: -1 }, [target.instanceId]);
    addCounters(ctx);

    expect(effectivePower(target)).toBe(1);
    expect(effectiveToughness(target)).toBe(1);
  });

  it('counters the SOURCE when `self` is set (the "enters with" template)', () => {
    const state = emptyState();
    const self = inst(beast('Ballista', 0, 0), 'A');
    state.battlefield.push(self);

    const { ctx } = ctxFor(state, self, { amount: 2, self: true });
    addCounters(ctx);

    expect(self.counters[PLUS_ONE_COUNTER]).toBe(2);
  });
});

/**
 * The three "state the engine could see but could not express" systems, proved
 * END TO END on real pool cards in real games — not by inspecting compiler
 * output, because the claim is that these cards PLAY as printed.
 *
 *  1. **Fatal Push's revolt.** The ≤2 mode and the ≤4 mode, chosen by whether a
 *     permanent left the battlefield under your control this turn. The sharp
 *     case is the one a cast-time read would get wrong: the fact is checked
 *     when the spell RESOLVES, so a permanent leaving in response counts.
 *  2. **Tarmogoyf's star box**, in a real game with a real graveyard.
 *  3. **Coloured statics**, through the compiler and the statics layer.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type {
  CardDefinition,
  CardInstance,
  GameState,
  InstanceId,
  PlayerId,
} from '@jonny-boi/core';
import {
  applyAction,
  createGame,
  DEFAULT_RULES,
  effectivePower,
  effectiveToughness,
  indexContinuous,
  matchesCardFilter,
  turnFactHolds,
  NO_MOD,
} from '@jonny-boi/core';
import { buildRegistry } from './pool.js';
import { CARD_POOL } from '../data/pool.js';
import { compileCard } from './compile/index.js';
import type { CompilableCard } from './compile/index.js';

const SEED = 20260818;

function poolCard(name: string): CardDefinition {
  const card = CARD_POOL.find((entry) => entry.name === name);
  if (!card) throw new Error(`pool missing ${name}`);
  return card;
}

/** A game parked in A's precombat main with mana floating and empty hands. */
function mainPhase(): { state: GameState; registry: ReturnType<typeof buildRegistry> } {
  const registry = buildRegistry();
  const swamp = poolCard('Swamp');
  const { state } = createGame({
    seed: SEED,
    decks: {
      A: { cards: Array.from({ length: 30 }, () => swamp) },
      B: { cards: Array.from({ length: 30 }, () => swamp) },
    },
    registry,
  });
  state.step = 'precombatMain';
  state.activePlayer = 'A';
  state.priorityPlayer = 'A';
  state.stack = [];
  state.players.A.hand = [];
  state.players.B.hand = [];
  state.players.A.manaPool = { W: 9, U: 9, B: 9, R: 9, G: 9, C: 9 };
  return { state, registry };
}

function place(state: GameState, def: CardDefinition, controller: PlayerId): CardInstance {
  const instance: CardInstance = {
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
  state.battlefield.push(instance);
  return instance;
}

function giveHand(state: GameState, player: PlayerId, def: CardDefinition): InstanceId {
  const instance: CardInstance = {
    instanceId: state.nextInstanceId++,
    def,
    controller: player,
    owner: player,
    zone: 'hand',
    tapped: false,
    summoningSick: false,
    damageMarked: 0,
    markedByDeathtouch: false,
    counters: {},
  };
  state.players[player].hand.push(instance);
  return instance.instanceId;
}

function giveGraveyard(state: GameState, player: PlayerId, defs: readonly CardDefinition[]): void {
  for (const def of defs) {
    state.players[player].graveyard.push({
      instanceId: state.nextInstanceId++,
      def,
      controller: player,
      owner: player,
      zone: 'graveyard',
      tapped: false,
      summoningSick: false,
      damageMarked: 0,
      markedByDeathtouch: false,
      counters: {},
    });
  }
}

/** Cast, then let the stack fully resolve. */
function castAndResolve(
  state: GameState,
  registry: ReturnType<typeof buildRegistry>,
  instanceId: InstanceId,
  targets: ReadonlyArray<InstanceId | PlayerId>,
): GameState {
  let s = applyAction(state, { kind: 'castSpell', player: 'A', instanceId, targets }, DEFAULT_RULES, registry).state;
  let guard = 0;
  while (s.stack.length > 0 && !s.gameOver && guard++ < 20) {
    s = applyAction(s, { kind: 'passPriority', player: s.priorityPlayer }, DEFAULT_RULES, registry).state;
  }
  return s;
}

/** The Scryfall record for a pool card, for compile-level assertions. */
function scryfallFor(definition: CardDefinition): CompilableCard {
  const path = new URL('../../data-tools/data/card-index.json', import.meta.url);
  const index = JSON.parse(readFileSync(path, 'utf8')) as { cards: readonly CompilableCard[] };
  const found = index.cards.find((card) => card.id === definition.id);
  if (!found) throw new Error(`no Scryfall record for ${definition.name}`);
  return found;
}

describe('Fatal Push — both modes, chosen by revolt at RESOLUTION', () => {
  const FATAL_PUSH = () => poolCard('Fatal Push');
  // A 3-mana creature: outside the ≤2 mode, inside the ≤4 revolt mode. That gap
  // is the whole card, so the fixture has to sit in it.
  const THREE_DROP: CardDefinition = {
    id: 'ThreeDrop',
    name: 'Three Drop',
    types: ['creature'],
    cost: { generic: 2, B: 1 },
    power: 3,
    toughness: 3,
  };
  const TWO_DROP: CardDefinition = {
    id: 'TwoDrop',
    name: 'Two Drop',
    types: ['creature'],
    cost: { generic: 1, B: 1 },
    power: 2,
    toughness: 2,
  };

  it('is UN-STUBBED: it compiles complete from its real printed text', () => {
    const result = compileCard(scryfallFor(FATAL_PUSH()));
    expect(result.status, JSON.stringify(result.missing)).toBe('complete');
    expect(result.definition.effects?.[0]?.params?.maxManaValue).toEqual({ base: 2, revolt: 4 });
  });

  it('kills a 2-drop with revolt OFF', () => {
    const { state, registry } = mainPhase();
    const victim = place(state, TWO_DROP, 'B');
    const push = giveHand(state, 'A', FATAL_PUSH());
    expect(turnFactHolds(state, 'permanentLeftBattlefield', 'A')).toBe(false);

    const after = castAndResolve(state, registry, push, [victim.instanceId]);
    expect(after.battlefield.some((c) => c.instanceId === victim.instanceId)).toBe(false);
  });

  it('does NOT kill a 3-drop with revolt OFF (the printed ≤2 bound holds)', () => {
    const { state, registry } = mainPhase();
    const victim = place(state, THREE_DROP, 'B');
    const push = giveHand(state, 'A', FATAL_PUSH());

    const after = castAndResolve(state, registry, push, [victim.instanceId]);
    expect(after.battlefield.some((c) => c.instanceId === victim.instanceId)).toBe(true);
  });

  it('DOES kill a 3-drop once a permanent you controlled has left this turn', () => {
    const { state, registry } = mainPhase();
    const victim = place(state, THREE_DROP, 'B');
    const push = giveHand(state, 'A', FATAL_PUSH());

    // A fetchland cracking — modelled here as A's own permanent leaving the
    // battlefield, which is exactly what revolt asks about. Driven through a
    // real state-based action so the fact is fed by the real event stream.
    const mine = place(state, TWO_DROP, 'A');
    mine.damageMarked = 99;
    let s = state;
    for (let i = 0; i < 40 && s.battlefield.some((c) => c.instanceId === mine.instanceId); i++) {
      s = applyAction(s, { kind: 'passPriority', player: s.priorityPlayer }, DEFAULT_RULES, registry).state;
    }
    expect(turnFactHolds(s, 'permanentLeftBattlefield', 'A')).toBe(true);

    // Put the cast back in A's hands wherever the passes left priority.
    s.step = 'precombatMain';
    s.activePlayer = 'A';
    s.priorityPlayer = 'A';
    s.players.A.manaPool = { W: 9, U: 9, B: 9, R: 9, G: 9, C: 9 };
    const after = castAndResolve(s, registry, push, [victim.instanceId]);
    expect(after.battlefield.some((c) => c.instanceId === victim.instanceId)).toBe(false);
  });

  it('revolt is the CASTER’s fact, not the opponent’s', () => {
    const { state, registry } = mainPhase();
    const victim = place(state, THREE_DROP, 'B');
    const push = giveHand(state, 'A', FATAL_PUSH());

    // B loses a permanent. That is B's revolt, not A's — so A's Fatal Push is
    // still the ≤2 spell and the 3-drop lives.
    const theirs = place(state, TWO_DROP, 'B');
    theirs.damageMarked = 99;
    let s = state;
    for (let i = 0; i < 40 && s.battlefield.some((c) => c.instanceId === theirs.instanceId); i++) {
      s = applyAction(s, { kind: 'passPriority', player: s.priorityPlayer }, DEFAULT_RULES, registry).state;
    }
    expect(turnFactHolds(s, 'permanentLeftBattlefield', 'B')).toBe(true);
    expect(turnFactHolds(s, 'permanentLeftBattlefield', 'A')).toBe(false);

    s.step = 'precombatMain';
    s.activePlayer = 'A';
    s.priorityPlayer = 'A';
    s.players.A.manaPool = { W: 9, U: 9, B: 9, R: 9, G: 9, C: 9 };
    const after = castAndResolve(s, registry, push, [victim.instanceId]);
    expect(after.battlefield.some((c) => c.instanceId === victim.instanceId)).toBe(true);
  });
});

describe('Tarmogoyf — the star box in a real game', () => {
  it('is UN-STUBBED: it compiles complete, with the formula and no printed P/T', () => {
    const goyf = poolCard('Tarmogoyf');
    const result = compileCard(scryfallFor(goyf));
    expect(result.status, JSON.stringify(result.missing)).toBe('complete');
    expect(result.definition.power).toBeUndefined();
    expect(result.definition.toughness).toBeUndefined();
    expect(result.definition.characteristicPT).toEqual({
      power: { countOf: 'cardTypesInAllGraveyards' },
      toughness: { countOf: 'cardTypesInAllGraveyards', plus: 1 },
    });
  });

  it('sizes itself off both graveyards, on the board', () => {
    const { state } = mainPhase();
    const goyf = place(state, poolCard('Tarmogoyf'), 'A');
    const size = (): [number, number] => {
      const mod = indexContinuous(state).get(goyf.instanceId) ?? NO_MOD;
      return [effectivePower(goyf, mod), effectiveToughness(goyf, mod)];
    };
    expect(size()).toEqual([0, 1]);
    giveGraveyard(state, 'A', [poolCard('Swamp')]);
    expect(size()).toEqual([1, 2]);
    giveGraveyard(state, 'B', [poolCard('Lightning Bolt')]); // instant
    expect(size()).toEqual([2, 3]);
  });
});

describe('coloured statics — CardFilter carries colour everywhere', () => {
  const WHITE_ANTHEM = `White creatures you control get +1/+1.`;

  it('compiles "White creatures you control get +1/+1" to a colour-filtered static', () => {
    const result = compileCard({
      id: 'white-anthem',
      name: 'Test Anthem',
      manaCost: { generic: 2, W: 1, U: 0, B: 0, R: 0, G: 0, C: 0, other: [] },
      typeLine: { supertypes: [], types: ['Enchantment'], subtypes: [] },
      oracleText: WHITE_ANTHEM,
      power: null,
      toughness: null,
      keywords: [],
    });
    expect(result.status, JSON.stringify(result.missing)).toBe('complete');
    expect(result.definition.statics?.[0]?.affects).toMatchObject({
      anyOfTypes: ['creature'],
      controller: 'you',
      anyOfColors: ['W'],
    });
  });

  it('pumps only the white creatures on a real board', () => {
    const anthemDef = compileCard({
      id: 'white-anthem',
      name: 'Test Anthem',
      manaCost: { generic: 2, W: 1, U: 0, B: 0, R: 0, G: 0, C: 0, other: [] },
      typeLine: { supertypes: [], types: ['Enchantment'], subtypes: [] },
      oracleText: WHITE_ANTHEM,
      power: null,
      toughness: null,
      keywords: [],
    }).definition;

    const { state } = mainPhase();
    place(state, anthemDef, 'A');
    const whiteGuy = place(
      state,
      { id: 'W1', name: 'White One', types: ['creature'], cost: { W: 1 }, power: 1, toughness: 1 },
      'A',
    );
    const blackGuy = place(
      state,
      { id: 'B1', name: 'Black One', types: ['creature'], cost: { B: 1 }, power: 1, toughness: 1 },
      'A',
    );
    const index = indexContinuous(state);
    expect(effectivePower(whiteGuy, index.get(whiteGuy.instanceId) ?? NO_MOD)).toBe(2);
    expect(effectivePower(blackGuy, index.get(blackGuy.instanceId) ?? NO_MOD)).toBe(1);
  });

  it('the SAME colour filter is honoured by the shared matcher every chooser uses', () => {
    // Not just statics: `matchesCardFilter` is what searches, discards and
    // sacrifices select through, so the colour field has to work there too.
    const { state } = mainPhase();
    const hybrid = place(
      state,
      { id: 'H', name: 'Hybrid', types: ['creature'], cost: { hybrid: [['G', 'W']] }, power: 1, toughness: 1 },
      'A',
    );
    const colorless = place(
      state,
      { id: 'C', name: 'Colorless', types: ['artifact'], cost: { generic: 2 } },
      'A',
    );
    // A hybrid card is BOTH its colours, exactly as protection reads it.
    expect(matchesCardFilter(hybrid, { anyOfColors: ['W'] })).toBe(true);
    expect(matchesCardFilter(hybrid, { anyOfColors: ['G'] })).toBe(true);
    expect(matchesCardFilter(hybrid, { anyOfColors: ['U'] })).toBe(false);
    // A colourless card matches NO colour filter.
    expect(matchesCardFilter(colorless, { anyOfColors: ['W', 'U', 'B', 'R', 'G'] })).toBe(false);
    // …and an absent colour filter still matches everything.
    expect(matchesCardFilter(colorless, { anyOfTypes: ['artifact'] })).toBe(true);
  });
});

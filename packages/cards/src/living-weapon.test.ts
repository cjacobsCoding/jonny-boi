/**
 * LIVING WEAPON (CR 702.92a) — "When this Equipment enters, create a 0/0 black
 * Phyrexian Germ creature token, then attach this to it."
 *
 * The keyword is worth its own suite because the interesting part is not that it
 * compiles, it is that the two halves happen in the printed ORDER and produce a
 * board that survives the state-based actions. A 0/0 Germ is lethal to itself, so
 * an implementation that created the token and failed to attach — or attached
 * before the token existed — would put a creature into play and kill it
 * immediately, while `status === 'complete'` stayed green. Every assertion below
 * is about the resulting BOARD for that reason.
 *
 * Real printed cards, from the corpus: Flayer Husk (+1/+1), Batterbone
 * (+1/+1, vigilance and lifelink) and Sickleslicer (+2/+2).
 */

import { describe, expect, it } from 'vitest';
import type { CardDefinition, CardInstance, GameState } from '@jonny-boi/core';
import {
  aggregateFor,
  applyAction,
  colorsOfDefinition,
  createGame,
  DEFAULT_RULES,
  effectiveKeywords,
  effectivePower,
  effectiveToughness,
  generateLegalActions,
  hasSubtype,
} from '@jonny-boi/core';
import { buildRegistry } from './pool.js';
import { compileCard } from './compile/compile.js';
import type { CompilableCard } from './compile/types.js';

const NO_MANA = { generic: 0, W: 0, U: 0, B: 0, R: 0, G: 0, C: 0, other: [] as readonly string[] };

function scryfall(parts: {
  name: string;
  cost?: Partial<typeof NO_MANA>;
  oracleText: string;
  keywords?: readonly string[];
}): CompilableCard {
  return {
    id: `lw:${parts.name}`,
    name: parts.name,
    manaCost: { ...NO_MANA, ...parts.cost },
    typeLine: { supertypes: [], types: ['Artifact'], subtypes: ['Equipment'] },
    oracleText: parts.oracleText,
    power: null,
    toughness: null,
    keywords: parts.keywords ?? [],
  };
}

/** Compile insisting the card is fully playable, naming the gap when it is not. */
function playable(card: CompilableCard): CardDefinition {
  const result = compileCard(card);
  expect(result.status, `${card.name}: ${JSON.stringify(result.missing)}`).toBe('complete');
  return result.definition;
}

const FLAYER_HUSK = playable(
  scryfall({
    name: 'Flayer Husk',
    cost: { generic: 1 },
    keywords: ['Living weapon', 'Equip'],
    oracleText: 'Living weapon\nEquipped creature gets +1/+1.\nEquip {2}',
  }),
);

const BATTERBONE = playable(
  scryfall({
    name: 'Batterbone',
    cost: { generic: 2 },
    keywords: ['Living weapon', 'Equip'],
    oracleText:
      'Living weapon\nEquipped creature gets +1/+1 and has vigilance and lifelink.\nEquip {5}',
  }),
);

const SICKLESLICER = playable(
  scryfall({
    name: 'Sickleslicer',
    cost: { generic: 3 },
    keywords: ['Living weapon', 'Equip'],
    oracleText: 'Living weapon\nEquipped creature gets +2/+2.\nEquip {4}',
  }),
);

const SWAMP: CardDefinition = { id: 'lw:Swamp', name: 'Swamp', types: ['land'], produces: ['B'] };

function deckOf(def: CardDefinition): { cards: readonly CardDefinition[] } {
  const cards: CardDefinition[] = [];
  for (let i = 0; i < 6; i++) cards.push(def);
  while (cards.length < 40) cards.push(SWAMP);
  return { cards };
}

/**
 * Put the Equipment onto the battlefield the way the engine does — cast it and
 * let the ETB trigger resolve — and hand back the settled board.
 *
 * Deliberately NOT a hand-built battlefield: the whole claim is about what the
 * trigger does on entry, and a test that placed the token itself would assert
 * nothing.
 */
function playEquipment(def: CardDefinition): GameState {
  const registry = buildRegistry();
  const { state } = createGame({
    seed: 909,
    decks: { A: deckOf(def), B: deckOf(SWAMP) },
    registry,
  });
  state.step = 'precombatMain';
  state.activePlayer = 'A';
  state.priorityPlayer = 'A';
  state.stack = [];
  // Enough mana for any of the three, and the card in hand.
  state.players.A.hand = [
    {
      instanceId: state.nextInstanceId++,
      def,
      controller: 'A',
      owner: 'A',
      zone: 'hand',
      tapped: false,
      summoningSick: false,
      damageMarked: 0,
      markedByDeathtouch: false,
      counters: {},
    },
  ];
  state.players.A.manaPool = { generic: 0, W: 0, U: 0, B: 6, R: 0, G: 0, C: 0 } as GameState['players']['A']['manaPool'];

  const card = state.players.A.hand[0] as CardInstance;
  let current = state;
  const cast = generateLegalActions(current).find(
    (a) => a.kind === 'castSpell' && a.instanceId === card.instanceId,
  );
  expect(cast, `no cast offered for ${def.name}`).toBeDefined();
  current = applyAction(current, cast!, DEFAULT_RULES, registry).state;
  // The stack resolves when both players pass priority — there is no "resolve"
  // action, so passing is how the spell and then its ETB trigger get to happen.
  for (let i = 0; i < 40 && current.stack.length > 0; i++) {
    current = applyAction(
      current,
      { kind: 'passPriority', player: current.priorityPlayer },
      DEFAULT_RULES,
      registry,
    ).state;
  }
  expect(current.stack, 'the stack never emptied').toHaveLength(0);
  return current;
}

/** The Germ this Equipment made, if any. */
function germOf(state: GameState): CardInstance | undefined {
  return state.battlefield.find((p) => p.def.name === 'Phyrexian Germ');
}

describe('living weapon brings its own creature', () => {
  it('Flayer Husk enters with a 0/0 black Phyrexian Germ and attaches itself to it', () => {
    const state = playEquipment(FLAYER_HUSK);

    const germ = germOf(state);
    expect(germ, 'no Germ token was created').toBeDefined();
    // CR 111.3: a token's name IS its subtype line, so it reads right in a log
    // and is selected by a "sacrifice a Germ" cost.
    expect(germ!.def.name).toBe('Phyrexian Germ');
    expect(hasSubtype(germ!.def, 'Germ')).toBe(true);
    expect(hasSubtype(germ!.def, 'Phyrexian')).toBe(true);
    expect(germ!.def.types).toContain('creature');
    expect(germ!.def.isToken).toBe(true);
    // BLACK, stated on the token rather than derived: a token has no mana cost,
    // so a missing colour list would read colourless and the Germ would stop
    // being a legal target for everything that cares about black.
    expect(colorsOfDefinition(germ!.def)).toEqual(['B']);
    // Printed 0/0 — the buff is the Equipment's, not the token's.
    expect(germ!.def.power).toBe(0);
    expect(germ!.def.toughness).toBe(0);

    // THE HALF THAT MATTERS: the Equipment is attached to the Germ it made.
    const husk = state.battlefield.find((p) => p.def.name === 'Flayer Husk');
    expect(husk, 'the Equipment is not on the battlefield').toBeDefined();
    expect(husk!.attachedTo).toBe(germ!.instanceId);
  });

  it('the Germ SURVIVES, because the Equipment it carries is what makes it non-zero', () => {
    // The point of the whole keyword, and the assertion an "it compiles" test
    // would miss: a 0/0 creature dies to CR 704.5f the moment state-based
    // actions run, so the board is only correct if the attach happened first.
    const state = playEquipment(FLAYER_HUSK);
    const germ = germOf(state);
    expect(germ, 'the Germ died — the attach did not take effect').toBeDefined();

    const mod = aggregateFor(state, germ!.instanceId);
    expect(effectivePower(germ!, mod)).toBe(1);
    expect(effectiveToughness(germ!, mod)).toBe(1);
    expect(state.players.A.graveyard.some((c) => c.def.name === 'Phyrexian Germ')).toBe(false);
  });

  it('the Germ gets whatever the Equipment grants — Batterbone hands it vigilance and lifelink', () => {
    const state = playEquipment(BATTERBONE);
    const germ = germOf(state);
    expect(germ).toBeDefined();

    const mod = aggregateFor(state, germ!.instanceId);
    expect(effectivePower(germ!, mod)).toBe(1);
    expect(effectiveToughness(germ!, mod)).toBe(1);
    // The keyword half of the same modification, on a creature whose printed
    // definition has no keywords at all.
    const keywords = effectiveKeywords(germ!, mod);
    expect(keywords.vigilance ?? false).toBe(true);
    expect(keywords.lifelink ?? false).toBe(true);
  });

  it('a bigger Equipment makes a bigger Germ — Sickleslicer is +2/+2', () => {
    const state = playEquipment(SICKLESLICER);
    const germ = germOf(state);
    expect(germ).toBeDefined();
    const mod = aggregateFor(state, germ!.instanceId);
    expect(effectivePower(germ!, mod)).toBe(2);
    expect(effectiveToughness(germ!, mod)).toBe(2);
  });

  it('exactly ONE Germ per Equipment — the trigger is not a loop', () => {
    const state = playEquipment(FLAYER_HUSK);
    expect(state.battlefield.filter((p) => p.def.name === 'Phyrexian Germ')).toHaveLength(1);
  });
});

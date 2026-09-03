/**
 * SOULSHIFT N (CR 702.46a) — "When this creature dies, you may return target
 * Spirit card with mana value N or less from your graveyard to your hand."
 *
 * The risk in this keyword is not whether it compiles, it is whether the FILTER
 * means what the card says. A soulshift that forgot its mana-value cap would
 * return any Spirit ever printed, and a soulshift that forgot the Spirit clause
 * would be a universal regrowth on a 5-mana body — both play strictly stronger
 * than printed, which biases an A/B verdict exactly as badly as playing weaker.
 * So the compiled filter is asserted field by field, and then the rule is driven
 * through a real death to see which cards the engine actually offers.
 *
 * Real printed cards: Hundred-Talon Kami (Soulshift 4), Nightsoil Kami (5),
 * Thousand-legged Kami (7).
 */

import { describe, expect, it } from 'vitest';
import {
  applyAction,
  createGame,
  DEFAULT_RULES,
  generateLegalActions,
  type CardDefinition,
  type CardInstance,
  type GameState,
} from '@jonny-boi/core';
import { compileCard } from './compile/compile.js';
import type { CompilableCard } from './compile/types.js';
import { buildRegistry } from './pool.js';

const NO_MANA = { generic: 0, W: 0, U: 0, B: 0, R: 0, G: 0, C: 0, other: [] as readonly string[] };

function kami(parts: {
  name: string;
  cost: Partial<typeof NO_MANA>;
  soulshift: number;
  power: number;
  toughness: number;
  extraLine?: string;
}): CompilableCard {
  const lines = [
    ...(parts.extraLine ? [parts.extraLine] : []),
    `Soulshift ${parts.soulshift} (When this creature dies, you may return target Spirit card with mana value ${parts.soulshift} or less from your graveyard to your hand.)`,
  ];
  return {
    id: `ss:${parts.name}`,
    name: parts.name,
    manaCost: { ...NO_MANA, ...parts.cost },
    typeLine: { supertypes: [], types: ['Creature'], subtypes: ['Spirit'] },
    oracleText: lines.join('\n'),
    power: parts.power,
    toughness: parts.toughness,
    keywords: ['Soulshift'],
  };
}

function compiled(card: CompilableCard): CardDefinition {
  const result = compileCard(card);
  expect(result.status, `${card.name}: ${JSON.stringify(result.missing)}`).toBe('complete');
  return result.definition;
}

const HUNDRED_TALON = compiled(
  kami({
    name: 'Hundred-Talon Kami',
    cost: { generic: 4, W: 1 },
    soulshift: 4,
    power: 2,
    toughness: 3,
    extraLine: 'Flying',
  }),
);

const THOUSAND_LEGGED = compiled(
  kami({ name: 'Thousand-legged Kami', cost: { generic: 6, G: 2 }, soulshift: 7, power: 6, toughness: 6 }),
);

/** A Spirit card of a given mana value, for the graveyard. */
function spirit(name: string, manaValue: number): CardDefinition {
  return {
    id: `ss:${name}`,
    name,
    types: ['creature'],
    subtypes: ['Spirit'],
    power: 1,
    toughness: 1,
    cost: { generic: manaValue },
  };
}

/** A NON-Spirit of a given mana value — the control the Spirit clause must exclude. */
function goblin(name: string, manaValue: number): CardDefinition {
  return {
    id: `ss:${name}`,
    name,
    types: ['creature'],
    subtypes: ['Goblin'],
    power: 1,
    toughness: 1,
    cost: { generic: manaValue },
  };
}

const PLAINS: CardDefinition = { id: 'ss:Plains', name: 'Plains', types: ['land'], produces: ['W'] };

function instanceOf(state: GameState, def: CardDefinition, zone: CardInstance['zone']): CardInstance {
  return {
    instanceId: state.nextInstanceId++,
    def,
    controller: 'A',
    owner: 'A',
    zone,
    tapped: false,
    summoningSick: false,
    damageMarked: 0,
    markedByDeathtouch: false,
    counters: {},
  };
}

/**
 * Put the Kami on the battlefield with `graveyard` already in the graveyard,
 * then KILL it with lethal damage and let state-based actions run.
 *
 * Killing it for real (rather than calling the trigger by hand) is the point:
 * the claim is about what the engine offers when the creature dies.
 */
function killAndSettle(
  kamiDef: CardDefinition,
  graveyard: readonly CardDefinition[],
): { state: GameState } {
  const registry = buildRegistry();
  const deck = { cards: Array.from({ length: 30 }, () => PLAINS) };
  const { state } = createGame({ seed: 4242, decks: { A: deck, B: deck }, registry });
  state.step = 'precombatMain';
  state.activePlayer = 'A';
  state.priorityPlayer = 'A';
  state.stack = [];
  state.players.A.hand = [];
  state.players.B.hand = [];
  state.players.A.graveyard = graveyard.map((def) => instanceOf(state, def, 'graveyard'));

  const body = instanceOf(state, kamiDef, 'battlefield');
  state.battlefield.push(body);
  // Lethal damage marked, so the state-based action at the next priority
  // boundary puts it into the graveyard and its dies trigger goes on the stack.
  body.damageMarked = (kamiDef.toughness ?? 1) + 1;

  let current: GameState = state;
  for (let i = 0; i < 30; i++) {
    if (current.pendingChoice) break;
    const pass = generateLegalActions(current).find((a) => a.kind === 'passPriority');
    if (!pass) break;
    current = applyAction(current, pass, DEFAULT_RULES, registry).state;
  }
  return { state: current };
}

describe('soulshift compiles to the printed filter, field by field', () => {
  it('Hundred-Talon Kami — a dies trigger returning a Spirit of mana value 4 or less', () => {
    const triggers = HUNDRED_TALON.triggers ?? [];
    const soulshift = triggers.find((t) => t.label?.startsWith('Soulshift'));
    expect(soulshift, `triggers: ${JSON.stringify(triggers)}`).toBeDefined();
    expect(soulshift!.label).toBe('Soulshift 4');
    expect(soulshift!.condition).toEqual({ on: 'dies' });
    expect(soulshift!.effects).toEqual([
      {
        primitive: 'returnFromGraveyard',
        params: {
          count: 1,
          // The printed "you MAY": forced, a lone Spirit would be dragged back
          // even when its controller wants it left for a later Soulshift.
          optional: true,
          filter: { anyOfSubtypes: ['Spirit'], maxManaValue: 4 },
        },
      },
    ]);
    // The rest of the card still compiled — soulshift is not the whole text.
    expect(HUNDRED_TALON.keywords?.flying).toBe(true);
  });

  it('the cap is the printed number, not a constant — Thousand-legged Kami is 7', () => {
    const soulshift = (THOUSAND_LEGGED.triggers ?? []).find((t) => t.label?.startsWith('Soulshift'));
    expect(soulshift!.label).toBe('Soulshift 7');
    const params = soulshift!.effects[0]!.params as { filter: { maxManaValue: number } };
    expect(params.filter.maxManaValue).toBe(7);
  });
});

describe('soulshift offers exactly the cards the printed line allows', () => {
  it('a Spirit within the cap is offered; one above it, and a non-Spirit, are not', () => {
    const { state } = killAndSettle(HUNDRED_TALON, [
      spirit('Cheap Spirit', 2),
      spirit('Exact Spirit', 4),
      spirit('Expensive Spirit', 6),
      goblin('Cheap Goblin', 1),
    ]);

    const choice = state.pendingChoice;
    // Truthy, not toBeDefined: the engine parks `null` when nothing is asked,
    // and `null` IS defined — so toBeDefined would pass on the broken case.
    expect(choice, 'the dies trigger asked nothing — soulshift did not fire').toBeTruthy();
    expect(choice!.kind).toBe('selectCards');
    const offered =
      choice!.kind === 'selectCards' ? choice!.candidates.map((c) => c.name).sort() : [];
    // 4 or less, and a Spirit. Both halves of the filter, in one assertion.
    expect(offered).toEqual(['Cheap Spirit', 'Exact Spirit']);
  });

  it('it is OPTIONAL — the choice accepts returning nothing', () => {
    const { state } = killAndSettle(HUNDRED_TALON, [spirit('Cheap Spirit', 2)]);
    const choice = state.pendingChoice;
    expect(choice).toBeTruthy();
    expect(choice!.kind === 'selectCards' && choice!.min).toBe(0);
  });

  it('a graveyard with no legal Spirit asks nothing at all', () => {
    // The honest empty case: no question, no crash, and the Kami is still dead.
    const { state } = killAndSettle(HUNDRED_TALON, [spirit('Expensive Spirit', 6), goblin('Goblin', 1)]);
    expect(state.pendingChoice ?? undefined).toBeUndefined();
    expect(state.players.A.graveyard.some((c) => c.def.name === 'Hundred-Talon Kami')).toBe(true);
  });
});

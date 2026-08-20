/**
 * DOES THE PILOT ACTUALLY PLAY THEM? — the end-to-end test for attachments.
 *
 * A mechanic nothing can play is indistinguishable from a mechanic that does not
 * work, and this repo has shipped that bug before: a pilot reading a primitive by
 * the wrong id silently degraded every removal spell to an untargeted no-op, and
 * the suite stayed green because it only asserted that games FINISH. So this suite
 * asserts BEHAVIOUR — the aura got cast on a sensible creature, the equip got
 * activated, and the board really changed — by playing real games with the real
 * heuristic pilot, the real compiled definitions, and the real effect registry.
 *
 * It lives in `cards` (rather than `ai`) because it is the only place that can hold
 * all three: `ai` deliberately does not depend on `cards`, so an assertion that the
 * pilot and the primitives agree has to be made from this side of the seam.
 */

import { describe, expect, it } from 'vitest';
import type { CardDefinition, GameAction, GameEvent, GameState } from '@jonny-boi/core';
import {
  applyAction,
  createGame,
  createRng,
  DEFAULT_RULES,
  effectivePower,
  generateLegalActions,
  indexContinuous,
  NO_MOD,
} from '@jonny-boi/core';
import { createHeuristicPilot } from '@jonny-boi/ai';
import { buildRegistry } from './pool.js';
import { compileCard } from './compile/compile.js';
import type { CompilableCard } from './compile/types.js';

const NO_MANA = { generic: 0, W: 0, U: 0, B: 0, R: 0, G: 0, C: 0, other: [] as readonly string[] };

function scryfall(parts: {
  name: string;
  cost?: Partial<typeof NO_MANA>;
  types: readonly string[];
  subtypes?: readonly string[];
  oracleText: string;
  keywords?: readonly string[];
  power?: number | null;
  toughness?: number | null;
}): CompilableCard {
  return {
    id: `play:${parts.name}`,
    name: parts.name,
    manaCost: { ...NO_MANA, ...parts.cost },
    typeLine: { supertypes: [], types: parts.types, subtypes: parts.subtypes ?? [] },
    oracleText: parts.oracleText,
    power: parts.power ?? null,
    toughness: parts.toughness ?? null,
    keywords: parts.keywords ?? [],
  };
}

/** Compile a card the way the deck importer does, insisting it be playable. */
function playable(card: CompilableCard): CardDefinition {
  const result = compileCard(card);
  expect(result.status, `${card.name}: ${JSON.stringify(result.missing)}`).toBe('complete');
  return result.definition;
}

const BONESPLITTER = playable(
  scryfall({
    name: 'Bonesplitter',
    cost: { generic: 1 },
    types: ['Artifact'],
    subtypes: ['Equipment'],
    keywords: ['Equip'],
    oracleText: 'Equipped creature gets +2/+0.\nEquip {1}',
  }),
);

const UNHOLY_STRENGTH = playable(
  scryfall({
    name: 'Unholy Strength',
    cost: { B: 1 },
    types: ['Enchantment'],
    subtypes: ['Aura'],
    keywords: ['Enchant'],
    oracleText: 'Enchant creature\nEnchanted creature gets +2/+1.',
  }),
);

const DEAD_WEIGHT = playable(
  scryfall({
    name: 'Dead Weight',
    cost: { B: 1 },
    types: ['Enchantment'],
    subtypes: ['Aura'],
    keywords: ['Enchant'],
    oracleText: 'Enchant creature\nEnchanted creature gets -2/-2.',
  }),
);

const SWAMP: CardDefinition = { id: 'play:Swamp', name: 'Swamp', types: ['land'], produces: ['B'] };
const GRIZZLY: CardDefinition = {
  id: 'play:Grizzly Bears',
  name: 'Grizzly Bears',
  types: ['creature'],
  power: 2,
  toughness: 2,
  cost: { generic: 1, B: 1 },
};

/**
 * A 40-card deck holding `copies` of each key card, padded with Swamps.
 *
 * Real playsets rather than singletons on purpose: the deck is shuffled, so a
 * one-of would routinely sit at the bottom of the library and the test would be
 * asserting the shuffle rather than the pilot.
 */
function deckWith(key: readonly CardDefinition[], copies = 8): { cards: readonly CardDefinition[] } {
  const cards: CardDefinition[] = [];
  for (let i = 0; i < copies; i++) cards.push(...key);
  while (cards.length < 40) cards.push(SWAMP);
  return { cards };
}

interface PlayedGame {
  readonly state: GameState;
  readonly events: readonly GameEvent[];
  readonly actions: readonly GameAction[];
}

/**
 * Play a real game with the heuristic pilot on BOTH seats and record everything.
 *
 * Deliberately the whole loop rather than a single `chooseAction` probe: the
 * failure this is guarding against (a cast that resolves into nothing) only shows
 * up once the engine has actually resolved the pilot's choice.
 */
function playGame(
  decks: { A: { cards: readonly CardDefinition[] }; B: { cards: readonly CardDefinition[] } },
  seed: number,
  maxActions = 600,
): PlayedGame {
  const registry = buildRegistry();
  const pilot = createHeuristicPilot();
  const rng = createRng(seed);
  const created = createGame({ seed, decks, registry });
  let state = created.state;
  const events: GameEvent[] = [...created.events];
  const actions: GameAction[] = [];

  for (let i = 0; i < maxActions && !state.gameOver; i++) {
    const legal = generateLegalActions(state, DEFAULT_RULES);
    if (legal.length === 0) break;
    const chosen = pilot.chooseAction({ view: state, legalActions: legal, rng, registry });
    const result = applyAction(state, chosen, DEFAULT_RULES, registry);
    // A rejected action would spin forever; take the guaranteed-legal move instead.
    state = result.state;
    events.push(...result.events);
    actions.push(chosen);
  }
  return { state, events, actions };
}

describe('the heuristic pilot really plays Auras', () => {
  it('casts an Aura on one of ITS OWN creatures, and the creature gets bigger', () => {
    const game = playGame(
      {
        A: deckWith([GRIZZLY, UNHOLY_STRENGTH]),
        B: deckWith([]),
      },
      20260815,
    );

    const attached = game.events.filter((e) => e.type === 'permanentAttached');
    expect(attached.length, 'the pilot never attached anything').toBeGreaterThan(0);

    // The Aura must be on a creature its OWN controller controls — the pilot
    // buffing the opponent's board would be worse than not casting it at all.
    const auras = game.state.battlefield.filter((c) => c.def.name === 'Unholy Strength' && c.attachedTo !== null);
    expect(auras.length).toBeGreaterThan(0);
    for (const aura of auras) {
      const host = game.state.battlefield.find((c) => c.instanceId === aura.attachedTo);
      expect(host, 'the Aura is attached to something not on the battlefield').toBeDefined();
      expect(host!.controller).toBe(aura.controller);
      // And the buff is REAL, not just a recorded relationship.
      const mod = indexContinuous(game.state).get(host!.instanceId) ?? NO_MOD;
      expect(effectivePower(host!, mod)).toBeGreaterThanOrEqual((host!.def.power ?? 0) + 2);
    }
  });

  it('aims a NEGATIVE Aura at the opponent, killing the creature', () => {
    // Dead Weight is removal wearing an Aura's clothes. A pilot that read it as a
    // buff would shrink its own board; one that could not read it at all would
    // never cast it. Both failures are silent, so this asserts the kill.
    const game = playGame(
      {
        A: deckWith([DEAD_WEIGHT]),
        B: deckWith([GRIZZLY]),
      },
      777,
      400,
    );

    const attached = game.events.filter((e) => e.type === 'permanentAttached');
    expect(attached.length, 'Dead Weight was never cast').toBeGreaterThan(0);
    // A 2/2 with -2/-2 is a 0/0: it dies to a state-based action, and the Aura
    // follows it to the graveyard.
    expect(game.events.some((e) => e.type === 'creatureDied' && e.name === 'Grizzly Bears')).toBe(true);
    expect(game.events.some((e) => e.type === 'attachmentPutIntoGraveyard')).toBe(true);
  });
});

describe('the heuristic pilot really equips', () => {
  it('activates Equip and the equipment ends up attached to its creature', () => {
    const game = playGame(
      {
        A: deckWith([GRIZZLY, BONESPLITTER]),
        B: deckWith([]),
      },
      4242,
    );

    expect(
      game.actions.some((a) => a.kind === 'activateAbility'),
      'the pilot never activated an ability at all',
    ).toBe(true);
    const attached = game.events.filter((e) => e.type === 'permanentAttached');
    expect(attached.length, 'Bonesplitter was never equipped').toBeGreaterThan(0);

    const equipment = game.state.battlefield.find((c) => c.def.name === 'Bonesplitter');
    expect(equipment).toBeDefined();
    expect(equipment!.attachedTo).not.toBeNull();
    const host = game.state.battlefield.find((c) => c.instanceId === equipment!.attachedTo);
    expect(host!.controller).toBe(equipment!.controller);
    // The deck plays several Bonesplitters and the pilot may stack more than one
    // on its best body — a real line, and not what this test is about. Count
    // what is on THIS host instead of assuming exactly one.
    const onThisHost = game.state.battlefield.filter(
      (c) => c.def.name === 'Bonesplitter' && c.attachedTo === host!.instanceId,
    ).length;
    expect(onThisHost).toBeGreaterThan(0);
    const mod = indexContinuous(game.state).get(host!.instanceId) ?? NO_MOD;
    expect(effectivePower(host!, mod)).toBe((host!.def.power ?? 0) + 2 * onThisHost);
  });

  it('does NOT re-equip the creature it is already on (the mana-burning loop)', () => {
    // The classic equipment bug: re-equipping the same creature is legal and
    // completely pointless, so a pilot that does not check spends every turn's
    // mana on it. Counted rather than reasoned about: with one creature on the
    // board there is exactly one useful equip, ever.
    const game = playGame(
      {
        A: deckWith([GRIZZLY, BONESPLITTER], 1),
        B: deckWith([]),
      },
      31337,
    );
    const equips = game.events.filter((e) => e.type === 'permanentAttached');
    const hosts = new Set(equips.map((e) => (e.type === 'permanentAttached' ? e.hostInstanceId : 0)));
    // One attach per distinct host: never twice onto the same creature.
    expect(equips.length).toBe(hosts.size);
  });
});

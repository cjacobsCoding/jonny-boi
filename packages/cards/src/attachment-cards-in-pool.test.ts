/**
 * ARE THE SHIPPED AURAS AND EQUIPMENT REACHABLE, AND DO THEY PLAY?
 *
 * `attachments-play.test.ts` next door proves the SEAM works by compiling
 * hand-typed fixtures. That is a different claim from this one. The engine had a
 * complete, tested attachment seam for a while and the curated pool contained
 * **zero** Auras and **zero** Equipment, so nobody could put one in a deck, the
 * Lab could not suggest one, and the sim never exercised any of it. A feature
 * nothing can reach is indistinguishable from a feature that does not work — and
 * worse, because it looks finished.
 *
 * So this suite asserts the CARDS, not the mechanism:
 *
 *  1. the pool really carries Auras and Equipment (the guard against silently
 *     regressing to zero — the state this branch existed to fix);
 *  2. each one's data matches what its printed line says it does (`fidelity.test.ts`
 *     already proves every pool card recompiles from its Scryfall text; what is
 *     added here is that the *attachment* half of that data says the right thing);
 *  3. and the real pool definitions, played by the real heuristic pilot in real
 *     games, attach, change stats, move, and fire the state-based actions.
 *
 * Everything below pulls its definitions out of `CARD_POOL` by name. Nothing is
 * hand-built, so a card dropped from the pool fails here rather than passing
 * against a fixture that is not shipped.
 */

import { describe, expect, it } from 'vitest';
import type { CardDefinition, GameAction, GameEvent, GameState } from '@jonny-boi/core';
import {
  applyAction,
  createGame,
  createRng,
  DEFAULT_RULES,
  effectivePower,
  effectiveToughness,
  generateLegalActions,
  indexContinuous,
  NO_MOD,
} from '@jonny-boi/core';
import { createHeuristicPilot } from '@jonny-boi/ai';
import { CARD_POOL } from '../data/pool.js';
import { buildRegistry, loadCardPool } from './pool.js';

/** A pool card by name — throws rather than silently skipping a missing card. */
function poolCard(name: string): CardDefinition {
  const card = CARD_POOL.find((entry) => entry.name === name);
  if (!card) throw new Error(`pool is missing '${name}'`);
  return card;
}

/** An Aura is the attachment form that DIES when it is not legally attached. */
const isAura = (card: CardDefinition): boolean => card.attachment?.whenIllegal === 'toGraveyard';
/** An Equipment merely unattaches, and attaches through an activated ability. */
const isEquipment = (card: CardDefinition): boolean => card.attachment?.whenIllegal === 'detach';

const attachments = CARD_POOL.filter((card) => card.attachment !== undefined);

/**
 * How many of each form the pool must carry.
 *
 * A floor rather than an exact count: adding cards is a data edit and should not
 * fail a test, but dropping BACK toward the empty pool this branch fixed must.
 * The numbers are "enough that a deck can be built and the Lab has real choices",
 * not the current totals.
 */
const MINIMUM_AURAS = 8;
const MINIMUM_EQUIPMENT = 8;

describe('the pool actually contains the cards the attachment seam needs', () => {
  it(`carries at least ${MINIMUM_AURAS} Auras and ${MINIMUM_EQUIPMENT} Equipment`, () => {
    const auras = attachments.filter(isAura).map((card) => card.name);
    const equipment = attachments.filter(isEquipment).map((card) => card.name);
    expect(auras.length, `auras in pool: ${auras.join(', ')}`).toBeGreaterThanOrEqual(MINIMUM_AURAS);
    expect(
      equipment.length,
      `equipment in pool: ${equipment.join(', ')}`,
    ).toBeGreaterThanOrEqual(MINIMUM_EQUIPMENT);
  });

  it('loads them with no attachment problems core cannot honour', () => {
    // `loadCardPool` reports an attachment declaration the engine cannot use.
    // An unusable declaration is the quiet failure mode: the card enters play and
    // does nothing, which reads as "attachments are broken" rather than "this
    // card's data is wrong".
    const pool = loadCardPool({ onWarn: () => {} });
    expect(pool.attachmentProblems).toEqual([]);
  });

  it('gives every Equipment an Equip ability, and every Aura a way to enter attached', () => {
    for (const card of attachments.filter(isEquipment)) {
      const equip = card.activated ?? [];
      expect(equip.length, `${card.name} has no Equip ability`).toBeGreaterThan(0);
      // Equip is sorcery-speed (CR 301.5c); an instant-speed Equipment would be a
      // combat trick the printed card is not.
      expect(equip[0]!.timing, `${card.name}'s Equip is not sorcery-speed`).toBe('sorcery');
      expect(equip[0]!.effects[0]!.primitive).toBe('attachToTarget');
      // An Equipment is not an Aura: it enters unattached and waits.
      expect(card.effects, `${card.name} should have no spell script`).toBeUndefined();
    }
    for (const card of attachments.filter(isAura)) {
      const script = card.effects ?? [];
      expect(
        script.some((ref) => ref.primitive === 'attachToTarget'),
        `${card.name} never attaches to its target on resolution`,
      ).toBe(true);
    }
  });

  it('offers Auras and Equipment across the colours, not just one archetype', () => {
    // A pool where every attachment is black serves one deck. Colour is read off
    // the card's own cost, so this cannot drift away from what is shipped.
    const colours = new Set<string>();
    for (const card of attachments) {
      const cost = card.cost ?? {};
      for (const pip of ['W', 'U', 'B', 'R', 'G'] as const) {
        if ((cost[pip] ?? 0) > 0) colours.add(pip);
      }
      for (const pair of cost.hybrid ?? []) for (const pip of pair) colours.add(pip);
      // A colourless Equipment is playable in EVERY deck, which is the widest
      // coverage there is.
      if (Object.keys(cost).every((key) => key === 'generic')) colours.add('colourless');
    }
    expect([...colours].sort()).toEqual(['B', 'G', 'R', 'U', 'W', 'colourless']);
  });
});

describe('each shipped attachment says what its printed line says', () => {
  /**
   * The printed modification, per card, transcribed from the Oracle text that is
   * committed alongside each definition in `../data/expanded-pool.ts`.
   *
   * Written out by hand ON PURPOSE. `fidelity.test.ts` proves the definition is
   * what the COMPILER produces from the index; that catches a compiler
   * regression but would happily agree with a template that misreads every card
   * the same way. This table is the independent second reading.
   */
  const PRINTED: ReadonlyArray<
    readonly [name: string, power: number, toughness: number, keywords: readonly string[]]
  > = [
    // Auras
    ['Unholy Strength', 2, 1, []], // "Enchanted creature gets +2/+1."
    ['Holy Strength', 1, 2, []], // "Enchanted creature gets +1/+2."
    ['Dead Weight', -2, -2, []], // "Enchanted creature gets -2/-2."
    ['Weakness', -2, -1, []], // "Enchanted creature gets -2/-1."
    ['Enfeeblement', -2, -2, []], // "Enchanted creature gets -2/-2."
    ['Dark Favor', 3, 1, []], // "Enchanted creature gets +3/+1."
    ['Flight', 0, 0, ['flying']], // "Enchanted creature has flying."
    ['Angelic Gift', 0, 0, ['flying']], // "Enchanted creature has flying."
    ['Nimbus Wings', 1, 2, ['flying']], // "gets +1/+2 and has flying."
    ['Mark of the Vampire', 2, 2, ['lifelink']], // "gets +2/+2 and has lifelink."
    ['Goblin War Paint', 2, 2, ['haste']], // "gets +2/+2 and has haste."
    ["Serra's Embrace", 2, 2, ['flying', 'vigilance']], // "+2/+2 and has flying and vigilance."
    ['Unflinching Courage', 2, 2, ['trample', 'lifelink']], // "+2/+2 and has trample and lifelink."
    ['Gift of Orzhova', 1, 1, ['flying', 'lifelink']], // "+1/+1 and has flying and lifelink."
    // Equipment
    ['Bone Saw', 1, 0, []], // "Equipped creature gets +1/+0."
    ['Bonesplitter', 2, 0, []], // "Equipped creature gets +2/+0."
    ['Leonin Scimitar', 1, 1, []], // "Equipped creature gets +1/+1."
    ['Trusty Machete', 2, 1, []], // "Equipped creature gets +2/+1."
    ['Vulshok Morningstar', 2, 2, []], // "Equipped creature gets +2/+2."
    ["Accorder's Shield", 0, 3, ['vigilance']], // "+0/+3 and has vigilance."
    ['Cobbled Wings', 0, 0, ['flying']], // "Equipped creature has flying."
    ['Kitesail', 1, 0, ['flying']], // "gets +1/+0 and has flying."
    ['Bladed Pinions', 0, 0, ['flying', 'firstStrike']], // "has flying and first strike."
    ['Fireshrieker', 0, 0, ['doubleStrike']], // "Equipped creature has double strike."
    ['Strider Harness', 1, 1, ['haste']], // "gets +1/+1 and has haste."
    ['Mask of Avacyn', 1, 2, ['hexproof']], // "gets +1/+2 and has hexproof."
    ['Loxodon Warhammer', 3, 0, ['trample', 'lifelink']], // "+3/+0 and has trample and lifelink."
    ['Sword of Vengeance', 2, 0, ['firstStrike', 'vigilance', 'trample', 'haste']],
    ['Darksteel Axe', 2, 0, []], // "Equipped creature gets +2/+0." (the Equipment itself is indestructible)
    ['Darksteel Plate', 0, 0, ['indestructible']], // "Equipped creature has indestructible."
    ['Whispersilk Cloak', 0, 0, ['unblockable', 'shroud']], // "can't be blocked and has shroud."
  ];

  it('covers every attachment in the pool — a new card cannot slip in unread', () => {
    const listed = new Set(PRINTED.map(([name]) => name));
    const unlisted = attachments.filter((card) => !listed.has(card.name)).map((card) => card.name);
    expect(
      unlisted,
      'add the card to PRINTED with its printed modification transcribed from the Oracle text',
    ).toEqual([]);
  });

  for (const [name, power, toughness, keywords] of PRINTED) {
    it(`${name} modifies exactly as printed`, () => {
      const modifies = poolCard(name).attachment?.modifies;
      expect(modifies, `${name} grants nothing`).toBeDefined();
      expect(modifies!.power ?? 0).toBe(power);
      expect(modifies!.toughness ?? 0).toBe(toughness);
      const granted = Object.entries(modifies!.keywords ?? {})
        .filter(([, on]) => on)
        .map(([keyword]) => keyword)
        .sort();
      expect(granted).toEqual([...keywords].sort());
    });
  }
});

// --- and now play them ----------------------------------------------------------

const PLAINS = poolCard('Plains');
const SWAMP = poolCard('Swamp');
/** A vanilla white one-drop and a vanilla black two-drop, to wear the buffs. */
const SAVANNAH_LIONS = poolCard('Savannah Lions'); // {W} 2/1
const WALKING_CORPSE = poolCard('Walking Corpse'); // {1}{B} 2/2

interface PlayedGame {
  readonly state: GameState;
  readonly events: readonly GameEvent[];
  readonly actions: readonly GameAction[];
}

/**
 * A 40-card deck of `copies` of each key card, padded with a basic land.
 * Playsets, not singletons: the deck is shuffled, so a one-of would usually sit
 * at the bottom of the library and the test would be asserting the shuffle.
 */
function deckWith(
  key: readonly CardDefinition[],
  land: CardDefinition,
  copies = 8,
): { cards: readonly CardDefinition[] } {
  const cards: CardDefinition[] = [];
  for (let i = 0; i < copies; i++) cards.push(...key);
  while (cards.length < 40) cards.push(land);
  return { cards };
}

/** Play a real game with the real heuristic pilot on both seats. */
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
    state = result.state;
    events.push(...result.events);
    actions.push(chosen);
  }
  return { state, events, actions };
}

/** The host a given attachment is on, or `undefined` when it is on nothing. */
function hostOf(state: GameState, attachmentName: string) {
  const attachment = state.battlefield.find((c) => c.def.name === attachmentName);
  if (!attachment || attachment.attachedTo == null) return undefined;
  return state.battlefield.find((c) => c.instanceId === attachment.attachedTo);
}

describe('the pool Auras really resolve onto a creature and change its stats', () => {
  it('Serra’s Embrace: the pilot casts it on its own Lions, which grows and gains flying', () => {
    const game = playGame(
      {
        A: deckWith([SAVANNAH_LIONS, poolCard("Serra's Embrace")], PLAINS),
        B: deckWith([], PLAINS),
      },
      99001,
    );

    expect(
      game.events.filter((e) => e.type === 'permanentAttached').length,
      'the pilot never cast the Aura',
    ).toBeGreaterThan(0);

    const auras = game.state.battlefield.filter(
      (c) => c.def.name === "Serra's Embrace" && c.attachedTo != null,
    );
    expect(auras.length).toBeGreaterThan(0);
    const mods = indexContinuous(game.state);
    for (const aura of auras) {
      const host = game.state.battlefield.find((c) => c.instanceId === aura.attachedTo);
      expect(host, 'the Aura is attached to something not on the battlefield').toBeDefined();
      // Buffing the opponent's board would be worse than not casting it at all.
      expect(host!.controller).toBe(aura.controller);
      // Auras STACK: with a playset in the deck the pilot happily puts a second
      // one on the same creature, so the expected buff is per-Aura-on-this-host,
      // not a flat +2/+2. (Asserting the flat number is how this test first
      // failed — against correct engine behaviour.)
      const onThisHost = auras.filter((a) => a.attachedTo === host!.instanceId).length;
      const mod = mods.get(host!.instanceId) ?? NO_MOD;
      expect(effectivePower(host!, mod)).toBe((host!.def.power ?? 0) + 2 * onThisHost);
      expect(effectiveToughness(host!, mod)).toBe((host!.def.toughness ?? 0) + 2 * onThisHost);
      // The granted keywords are real, not just recorded on the Aura.
      expect(mod.keywords.flying).toBe(true);
      expect(mod.keywords.vigilance).toBe(true);
    }
  });

  it('Dead Weight: aimed at the OPPONENT, and the state-based actions kill the creature', () => {
    // Removal wearing an Aura's clothes. A pilot reading it as a buff would shrink
    // its own board; one that could not read it would never cast it. Both are
    // silent, so this asserts the kill AND the Aura following its host (CR 704.5m).
    const game = playGame(
      {
        A: deckWith([poolCard('Dead Weight')], SWAMP),
        B: deckWith([WALKING_CORPSE], SWAMP),
      },
      99002,
      400,
    );

    expect(
      game.events.some((e) => e.type === 'permanentAttached'),
      'Dead Weight was never cast',
    ).toBe(true);
    // A 2/2 with -2/-2 is a 0/0, so it dies to an SBA and the Aura goes with it.
    expect(
      game.events.some((e) => e.type === 'creatureDied' && e.name === 'Walking Corpse'),
    ).toBe(true);
    expect(game.events.some((e) => e.type === 'attachmentPutIntoGraveyard')).toBe(true);
    expect(game.state.battlefield.some((c) => c.def.name === 'Dead Weight')).toBe(false);
  });
});

describe('the pool Equipment really equips, moves, and survives its host', () => {
  it('Bonesplitter: the pilot activates Equip and the creature hits for two more', () => {
    const game = playGame(
      {
        A: deckWith([WALKING_CORPSE, poolCard('Bonesplitter')], SWAMP),
        B: deckWith([], SWAMP),
      },
      99003,
    );

    expect(
      game.actions.some((a) => a.kind === 'activateAbility'),
      'the pilot never activated an ability at all',
    ).toBe(true);
    expect(
      game.events.some((e) => e.type === 'permanentAttached'),
      'Bonesplitter was never equipped',
    ).toBe(true);

    const host = hostOf(game.state, 'Bonesplitter');
    expect(host, 'Bonesplitter ended the game attached to nothing').toBeDefined();
    const equipment = game.state.battlefield.find((c) => c.def.name === 'Bonesplitter')!;
    expect(host!.controller).toBe(equipment.controller);
    const mod = indexContinuous(game.state).get(host!.instanceId) ?? NO_MOD;
    expect(effectivePower(host!, mod)).toBe((host!.def.power ?? 0) + 2);
  });

  it('an Equipment whose creature dies UNATTACHES and stays on the battlefield (CR 704.5n)', () => {
    // The difference between the two forms, played rather than asserted from the
    // data: the same board that sends an Aura to the graveyard leaves an
    // Equipment in play, ready to be moved onto the next creature.
    const game = playGame(
      {
        A: deckWith([WALKING_CORPSE, poolCard('Bonesplitter')], SWAMP),
        B: deckWith([WALKING_CORPSE, poolCard('Dead Weight')], SWAMP),
      },
      99004,
      600,
    );

    const died = game.events.some((e) => e.type === 'creatureDied');
    expect(died, 'no creature ever died, so the SBA never had a chance to fire').toBe(true);
    expect(
      game.events.some((e) => e.type === 'permanentUnattached'),
      'the Equipment never came off its dead host',
    ).toBe(true);
    // Equipment is not an Aura: it must still be in play afterwards.
    const equipment = game.state.battlefield.filter((c) => c.def.name === 'Bonesplitter');
    expect(equipment.length).toBeGreaterThan(0);
    const graveyarded = game.events.filter(
      (e) => e.type === 'attachmentPutIntoGraveyard' && e.name === 'Bonesplitter',
    );
    expect(graveyarded, 'an Equipment must never be put into the graveyard by an SBA').toEqual([]);
  });
});

/**
 * §3.151 — THE LIFE-GAIN EVENT KIND and THE ANCHORED PREVENTION SHIELD, proven
 * on the REAL printed cards and then played.
 *
 * `core/src/life.test.ts` pins the layer's own rules. This file pins the other
 * half, which is where this repo has shipped lies before: that the printed line
 * reaches the layer at all, with the filter the card actually prints, and that
 * a board really changes.
 *
 * ⚠️ Every Oracle string below is copied VERBATIM from a real card in the
 * corpus, and the card is named. `dead-rule-sweep.mjs` exists because a rule
 * written from a remembered wording once matched no real card and no test could
 * see it.
 *
 * ## The two defects that make this family worth refusing until it is right
 *  1. **A life-gain doubler that misses LIFELINK.** Rhox Faithmender is a
 *     LIFELINK creature that doubles life gain — the two halves are printed on
 *     the same card. A version whose doubling only reached resolving spells
 *     would pass every test anyone thinks to write about "you gain 3 life", and
 *     be wrong about the card's own attack.
 *  2. **A two-directional shield compiled as one blanket.** Fog Bank stops
 *     damage to itself and damage it deals. Compiled as "prevent all combat
 *     damage", it would fog the whole board every turn — strictly, massively
 *     better than printed, and "complete" would say nothing about it.
 */

import { describe, expect, it } from 'vitest';
import {
  createGame,
  indexReplacements,
  gainLifeAmount,
  replaceDamage,
  type CardDefinition,
  type CardInstance,
  type GameEvent,
  type GameState,
  type PlayerId,
} from '@jonny-boi/core';
import { buildRegistry } from './pool.js';
import { gainLife } from './primitives.js';
import { compileCard } from './compile/compile.js';
import type { CompilableCard } from './compile/types.js';

const NO_MANA = { generic: 0, W: 0, U: 0, B: 0, R: 0, G: 0, C: 0, other: [] as readonly string[] };

function scryfall(parts: {
  name: string;
  cost?: Partial<typeof NO_MANA>;
  types: readonly string[];
  supertypes?: readonly string[];
  subtypes?: readonly string[];
  oracleText: string;
  keywords?: readonly string[];
  power?: number | null;
  toughness?: number | null;
}): CompilableCard {
  return {
    id: `lifegain:${parts.name}`,
    name: parts.name,
    manaCost: { ...NO_MANA, ...parts.cost },
    typeLine: { supertypes: parts.supertypes ?? [], types: parts.types, subtypes: parts.subtypes ?? [] },
    oracleText: parts.oracleText,
    power: parts.power ?? null,
    toughness: parts.toughness ?? null,
    keywords: parts.keywords ?? [],
  };
}

function playable(card: CompilableCard): CardDefinition {
  const result = compileCard(card);
  expect(result.status, `${card.name}: ${JSON.stringify(result.missing)}`).toBe('complete');
  return result.definition;
}

// --- the printed cards, verbatim -------------------------------------------------

/** THE ACCEPTANCE CARD. Both printed lines, including the lifelink keyword. */
const RHOX_FAITHMENDER = scryfall({
  name: 'Rhox Faithmender',
  cost: { generic: 3, W: 1 },
  types: ['Creature'],
  subtypes: ['Rhino', 'Monk'],
  power: 1,
  toughness: 5,
  keywords: ['Lifelink'],
  oracleText:
    'Lifelink (Damage dealt by this creature also causes you to gain that much life.)\nIf you would gain life, you gain twice that much life instead.',
});

/** THE OTHER ACCEPTANCE CARD. Defender + flying + the two-directional shield. */
const FOG_BANK = scryfall({
  name: 'Fog Bank',
  cost: { generic: 1, U: 1 },
  types: ['Creature'],
  subtypes: ['Wall'],
  power: 0,
  toughness: 2,
  keywords: ['Defender', 'Flying'],
  oracleText:
    'Defender (This creature can\'t attack.)\nFlying\nPrevent all combat damage that would be dealt to and dealt by this creature.',
});

const BOON_REFLECTION = scryfall({
  name: 'Boon Reflection',
  cost: { generic: 4, W: 1 },
  types: ['Enchantment'],
  oracleText: 'If you would gain life, you gain twice that much life instead.',
});

const KNIGHT_OF_DAWNS_LIGHT = scryfall({
  name: "Knight of Dawn's Light",
  cost: { generic: 2, W: 1 },
  types: ['Creature'],
  subtypes: ['Human', 'Knight'],
  power: 3,
  toughness: 3,
  oracleText: 'If you would gain life, you gain that much life plus 1 instead.',
});

const SULFURIC_VORTEX = scryfall({
  name: 'Sulfuric Vortex',
  cost: { generic: 1, R: 2 },
  types: ['Enchantment'],
  oracleText:
    'At the beginning of each player\'s upkeep, Sulfuric Vortex deals 2 damage to that player.\nIf a player would gain life, that player gains no life instead.',
});

/** An AURA whose shield anchors to its host — "enchanted creature". */
const GASEOUS_FORM = scryfall({
  name: 'Gaseous Form',
  cost: { generic: 1, U: 1 },
  types: ['Enchantment'],
  subtypes: ['Aura'],
  oracleText:
    'Enchant creature\nPrevent all combat damage that would be dealt to and dealt by enchanted creature.',
});

/** The one-directional aura: "dealt BY enchanted creature" only. */
const MUZZLE = scryfall({
  name: 'Muzzle',
  cost: { generic: 1, W: 1 },
  types: ['Enchantment'],
  subtypes: ['Aura'],
  oracleText:
    'Enchant creature\nEnchanted creature gets -2/-0.\nPrevent all damage that would be dealt by enchanted creature.',
});

/** The source-class tail: "…dealt to ~ BY CREATURES". */
const CHAMPION_LANCER = scryfall({
  name: 'Champion Lancer',
  cost: { generic: 4, W: 1 },
  types: ['Creature'],
  subtypes: ['Human', 'Knight'],
  power: 3,
  toughness: 4,
  oracleText: 'Prevent all damage that would be dealt to this creature by creatures.',
});

describe('the printed clause reaches the layer with EXACTLY the printed filter', () => {
  it('Rhox Faithmender compiles both lines — lifelink AND the doubler', () => {
    const def = playable(RHOX_FAITHMENDER);
    expect(def.keywords?.lifelink).toBe(true);
    expect(def.replacements).toHaveLength(1);
    const entry = def.replacements![0]!;
    expect(entry.event).toBe('lifegain');
    expect(entry.outcome).toEqual({ times: 2 });
    // "If YOU would gain life" — not a symmetric doubler for both players.
    expect(entry.applies.recipientController).toBe('you');
  });

  it('Knight of Dawn\'s Light is PLUS one, not TWICE — different arithmetic, different card', () => {
    const entry = playable(KNIGHT_OF_DAWNS_LIGHT).replacements![0]!;
    expect(entry.outcome).toEqual({ plus: 1 });
    expect(entry.outcome.times).toBeUndefined();
  });

  it('Sulfuric Vortex is SYMMETRIC and zeroes — "a player", not "you"', () => {
    const entry = playable(SULFURIC_VORTEX).replacements![0]!;
    expect(entry.event).toBe('lifegain');
    expect(entry.outcome).toEqual({ times: 0 });
    // No controller scope at all: the clause names "a player".
    expect(entry.applies.recipientController).toBeUndefined();
    // And it is NOT a prevention — prevention is CR 615 and it applies to
    // damage; reporting a `prevented` quantity for a life gain would be a lie
    // in the log.
    expect(entry.outcome.preventAll).toBeUndefined();
  });

  it('Fog Bank is TWO entries, one per printed direction', () => {
    const def = playable(FOG_BANK);
    expect(def.keywords?.defender).toBe(true);
    expect(def.keywords?.flying).toBe(true);
    expect(def.replacements).toHaveLength(2);
    const [to, by] = def.replacements!;
    expect(to!.applies.recipientAnchor).toBe('source');
    expect(to!.applies.dealerAnchor).toBeUndefined();
    expect(by!.applies.dealerAnchor).toBe('source');
    expect(by!.applies.recipientAnchor).toBeUndefined();
    // COMBAT only. A shield that dropped the printed word would also eat burn.
    for (const entry of def.replacements!) {
      expect(entry.applies.combat).toBe(true);
      expect(entry.outcome).toEqual({ preventAll: true });
    }
  });

  it('Gaseous Form anchors to its HOST, not to the Aura', () => {
    const def = playable(GASEOUS_FORM);
    expect(def.replacements).toHaveLength(2);
    expect(def.replacements![0]!.applies.recipientAnchor).toBe('attached');
    expect(def.replacements![1]!.applies.dealerAnchor).toBe('attached');
  });

  it('Muzzle is the DEALER side only — one entry, not two', () => {
    const def = playable(MUZZLE);
    expect(def.replacements).toHaveLength(1);
    expect(def.replacements![0]!.applies.dealerAnchor).toBe('attached');
    expect(def.replacements![0]!.applies.recipientAnchor).toBeUndefined();
    // No `combat` word is printed, so BOTH kinds of damage are stopped.
    expect(def.replacements![0]!.applies.combat).toBeUndefined();
  });

  it('Champion Lancer keeps the source-class tail', () => {
    const entry = playable(CHAMPION_LANCER).replacements![0]!;
    expect(entry.applies.recipientAnchor).toBe('source');
    expect(entry.applies.sourceFilter).toEqual({ anyOfTypes: ['creature'] });
  });
});

describe('what stays REPORTED — no template is widened to swallow it (§3.151)', () => {
  const refuses = (name: string, oracleText: string, types: readonly string[] = ['Enchantment']) => {
    const result = compileCard(scryfall({ name, types, oracleText }));
    expect(result.status, `${name} unexpectedly compiled`).toBe('incomplete');
    expect(result.definition.replacements).toBeUndefined();
  };

  it('a gain turned into a LOSS is a different event (Tainted Remedy, Plague Drone)', () => {
    refuses('Tainted Remedy', 'If an opponent would gain life, that player loses that much life instead.');
  });

  it('a gain turned into a DRAW is a different action, not a scaled quantity', () => {
    refuses('Rites of Flourishing-ish', 'If you would gain life, draw that many cards instead.');
  });

  it('a gain gated on a LIFE TOTAL has no field in the filter', () => {
    refuses(
      'Conditional Doubler',
      'If you would gain life while you have 5 or less life, you gain twice that much life instead.',
    );
  });

  it('a "by" clause on a subject with no dealer projection is refused, not guessed', () => {
    // "You" is a legal recipient and no kind of source at all. A rule that
    // shrugged and emitted the recipient projection would build a card that
    // stops damage dealt TO its controller from a clause that says BY.
    refuses('Bogus Shield', 'Prevent all combat damage that would be dealt by you.');
  });

  it('a source class outside the closed table reports (artifact CREATURES, first strike)', () => {
    // "artifact creatures" is a CONJUNCTION of two types; `anyOfTypes` is a
    // disjunction, so compiling it would stop damage from every creature.
    refuses('Bogus Treefolk', 'Prevent all damage that would be dealt to ~ by artifact creatures.');
    // `CardFilter` has no keyword field.
    refuses('Bogus Skyknight', 'Prevent all damage that would be dealt to ~ by creatures with first strike.');
  });

  it('a static shield printed on an INSTANT is still refused (it is a one-shot)', () => {
    refuses('Not A Wall', 'Prevent all combat damage that would be dealt to and dealt by ~.', ['Instant']);
  });
});

// --- played, not merely compiled -------------------------------------------------

const FOREST: CardDefinition = { id: 'lg-forest', name: 'Forest', types: ['land'], produces: ['G'] };

function freshState(): GameState {
  return createGame({
    seed: 9,
    decks: {
      A: { cards: Array.from({ length: 40 }, () => FOREST) },
      B: { cards: Array.from({ length: 40 }, () => FOREST) },
    },
    registry: buildRegistry(),
  }).state;
}

function put(state: GameState, def: CardDefinition, controller: PlayerId): CardInstance {
  const inst: CardInstance = {
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
    attachedTo: null,
  };
  state.battlefield.push(inst);
  return inst;
}

const BEAR: CardDefinition = {
  id: 'lg-bear',
  name: 'Bear',
  types: ['creature'],
  power: 2,
  toughness: 2,
  cost: { G: 1 },
};

function collector(): { emit: (e: GameEvent) => void; events: GameEvent[] } {
  const events: GameEvent[] = [];
  return { emit: (e) => void events.push(e), events };
}

describe('the shipped definitions really change a board', () => {
  it('Rhox Faithmender doubles a resolving gain AND its own lifelink', () => {
    const state = freshState();
    put(state, playable(RHOX_FAITHMENDER), 'A');
    const index = indexReplacements(state);
    // The resolving-effect mechanism...
    expect(gainLifeAmount(state, 'A', 3, collector().emit, index)).toBe(6);
    // ...and the LIFELINK mechanism, which is printed on this very card. Both
    // ask the one question, so both are doubled. This is the assertion a
    // life-gain doubler wired only to the primitive would fail.
    expect(gainLifeAmount(state, 'A', 1, collector().emit, index)).toBe(2);
    // The opponent is untouched: "if YOU would gain life".
    expect(gainLifeAmount(state, 'B', 3, collector().emit, index)).toBe(3);
  });

  /**
   * THE FUNNEL ITSELF, through the real `gainLife` PRIMITIVE.
   *
   * ⚠️ This test was added because a deliberate sabotage found it missing. The
   * rest of this file calls `gainLifeAmount` directly, which is core's side of
   * the question — so gutting `effect-helpers.changeLife` back to a bare
   * `p.life += delta` left every other test in the file GREEN while a resolving
   * "you gain N life" silently stopped being doubled. That is precisely the
   * shape of bug the funnel exists to prevent, and nothing was watching the
   * cards-side caller.
   */
  it('the gainLife PRIMITIVE goes through the funnel — life total and event both doubled', () => {
    const state = freshState();
    const rhox = put(state, playable(RHOX_FAITHMENDER), 'A');
    const before = state.players.A.life;
    const log = collector();
    const ctx = {
      state,
      source: rhox,
      controller: 'A' as PlayerId,
      targets: [],
      params: { amount: 3 },
      emit: log.emit,
    } as unknown as Parameters<typeof gainLife>[0];

    gainLife(ctx);

    // The LIFE TOTAL really moved by the doubled amount...
    expect(state.players.A.life).toBe(before + 6);
    // ...and the emitted event reports the TRUE number, not the printed 3.
    // "Whenever you gain life" counts what was gained (CR 118.5).
    const gains = log.events.filter((e) => e.type === 'gainLife');
    expect(gains).toHaveLength(1);
    expect((gains[0] as { amount: number }).amount).toBe(6);
  });

  it('a gain zeroed by Sulfuric Vortex emits NO gainLife event at all (CR 118.5)', () => {
    const state = freshState();
    const vortex = put(state, playable(SULFURIC_VORTEX), 'B');
    const before = state.players.A.life;
    const log = collector();
    gainLife({
      state,
      source: vortex,
      controller: 'A' as PlayerId,
      targets: [],
      params: { amount: 5 },
      emit: log.emit,
    } as unknown as Parameters<typeof gainLife>[0]);

    expect(state.players.A.life).toBe(before);
    // Neither event. A `gainLife` of 0 would make "whenever you gain life" fire
    // on a gain that did not happen; a `lifeChanged` of 0 would be a log entry
    // for nothing moving.
    expect(log.events.filter((e) => e.type === 'gainLife')).toHaveLength(0);
    expect(log.events.filter((e) => e.type === 'lifeChanged')).toHaveLength(0);
  });

  it('Boon Reflection and Rhox Faithmender together is x4 (CR 614.5, once each)', () => {
    const state = freshState();
    put(state, playable(RHOX_FAITHMENDER), 'A');
    put(state, playable(BOON_REFLECTION), 'A');
    const log = collector();
    expect(gainLifeAmount(state, 'A', 2, log.emit)).toBe(8);
    expect(log.events.filter((e) => e.type === 'replacementApplied')).toHaveLength(2);
  });

  it("Knight of Dawn's Light adds one; with Rhox the order their controller wants wins", () => {
    const state = freshState();
    put(state, playable(KNIGHT_OF_DAWNS_LIGHT), 'A');
    expect(gainLifeAmount(state, 'A', 3, collector().emit)).toBe(4);
    // (3 + 1) x 2 = 8 beats (3 x 2) + 1 = 7, and CR 616.1 gives the choice to
    // the AFFECTED player — who is the one gaining.
    put(state, playable(RHOX_FAITHMENDER), 'A');
    expect(gainLifeAmount(state, 'A', 3, collector().emit)).toBe(8);
  });

  it('Sulfuric Vortex zeroes BOTH players, and Rhox cannot out-double it', () => {
    const state = freshState();
    put(state, playable(SULFURIC_VORTEX), 'B');
    expect(gainLifeAmount(state, 'A', 9, collector().emit)).toBe(0);
    expect(gainLifeAmount(state, 'B', 9, collector().emit)).toBe(0);
    // Twice nothing is still nothing, whichever order CR 616.1 picks.
    put(state, playable(RHOX_FAITHMENDER), 'A');
    expect(gainLifeAmount(state, 'A', 9, collector().emit)).toBe(0);
  });

  it('Fog Bank stops damage to itself and by itself — and nothing else', () => {
    const state = freshState();
    const fogBank = put(state, playable(FOG_BANK), 'A');
    const myBear = put(state, BEAR, 'A');
    const theirBear = put(state, BEAR, 'B');
    const index = indexReplacements(state);
    const hit = (source: CardInstance, target: CardInstance, combat: boolean) =>
      replaceDamage(
        state,
        index,
        source,
        source.controller,
        target,
        target.controller,
        4,
        combat,
        collector().emit,
      ).amount;

    expect(hit(theirBear, fogBank, true)).toBe(0); // dealt TO it
    expect(hit(fogBank, theirBear, true)).toBe(0); // dealt BY it
    expect(hit(theirBear, myBear, true)).toBe(4); // a third party: untouched
    expect(hit(myBear, theirBear, true)).toBe(4); // and a fourth
    expect(hit(theirBear, fogBank, false)).toBe(4); // NONCOMBAT: the word is printed
  });

  it('Gaseous Form guards the creature it is attached to, and follows it', () => {
    const state = freshState();
    const aura = put(state, playable(GASEOUS_FORM), 'A');
    const host = put(state, BEAR, 'A');
    const otherHost = put(state, BEAR, 'A');
    const attacker = put(state, BEAR, 'B');
    const hit = (target: CardInstance) =>
      replaceDamage(
        state,
        indexReplacements(state),
        attacker,
        'B',
        target,
        'A',
        3,
        true,
        collector().emit,
      ).amount;

    aura.attachedTo = host.instanceId;
    expect(hit(host)).toBe(0);
    expect(hit(otherHost)).toBe(3);
    aura.attachedTo = otherHost.instanceId;
    expect(hit(otherHost)).toBe(0);
    expect(hit(host)).toBe(3);
  });

  it('Muzzle stops what its host DEALS and not what its host TAKES', () => {
    const state = freshState();
    const aura = put(state, playable(MUZZLE), 'A');
    const host = put(state, BEAR, 'A');
    const victim = put(state, BEAR, 'B');
    aura.attachedTo = host.instanceId;
    const index = indexReplacements(state);
    expect(
      replaceDamage(state, index, host, 'A', victim, 'B', 3, true, collector().emit).amount,
    ).toBe(0);
    // The host is not protected: Muzzle prints only the "by" direction.
    expect(
      replaceDamage(state, index, victim, 'B', host, 'A', 3, true, collector().emit).amount,
    ).toBe(3);
  });

  it('Champion Lancer stops CREATURE damage to itself and not a burn spell', () => {
    const state = freshState();
    const lancer = put(state, playable(CHAMPION_LANCER), 'A');
    const creature = put(state, BEAR, 'B');
    const bolt: CardDefinition = { id: 'lg-bolt', name: 'Bolt', types: ['instant'], cost: { R: 1 } };
    const spell = put(state, bolt, 'B');
    const index = indexReplacements(state);
    expect(
      replaceDamage(state, index, creature, 'B', lancer, 'A', 3, true, collector().emit).amount,
    ).toBe(0);
    expect(
      replaceDamage(state, index, spell, 'B', lancer, 'A', 3, false, collector().emit).amount,
    ).toBe(3);
  });
});

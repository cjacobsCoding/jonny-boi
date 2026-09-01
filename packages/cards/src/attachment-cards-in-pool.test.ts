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
import CARD_INDEX from '../../data-tools/data/card-index.json' with { type: 'json' };

/** The printed Oracle text for a pool card, from the committed Scryfall index. */
const ORACLE_BY_NAME = new Map(
  (CARD_INDEX as { cards: { name: string; oracleText?: string }[] }).cards.map((card) => [
    card.name,
    card.oracleText,
  ]),
);
const oracleTextOf = (name: string): string | undefined => ORACLE_BY_NAME.get(name);
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
      // ⚠️ FOUND BY WHAT IT DOES, NOT BY WHERE IT SITS. This used to read
      // `activated[0]`, which holds only while Equip is the card's ONLY
      // activated ability. Lead Pipe prints "{2}, Sacrifice this Equipment:
      // Draw a card." above its "Equip {2}", so index 0 is the sacrifice — and
      // the test failed on a card that was entirely correct.
      const equip = (card.activated ?? []).filter((ability) =>
        ability.effects.some((effect) => effect.primitive === 'attachToTarget'),
      );
      expect(equip.length, `${card.name} has no Equip ability`).toBeGreaterThan(0);
      // Equip is sorcery-speed (CR 301.5c); an instant-speed Equipment would be a
      // combat trick the printed card is not. EVERY equip ability is checked,
      // not just one, so a second attach ability cannot slip in at instant speed.
      for (const ability of equip) {
        expect(ability.timing, `${card.name}'s Equip is not sorcery-speed`).toBe('sorcery');
      }
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
    // An aura on the FRONT face of a modal DFC — the land back face changes
    // nothing about what the aura does once it is on a creature.
    ['Glasswing Grace', 2, 2, ['flying', 'lifelink']], // "+2/+2 and has flying and lifelink."
    ['Aqueous Form', 0, 0, ['unblockable']], // "Enchanted creature can't be blocked."
    ['Elephant Guide', 3, 3, []], // "Enchanted creature gets +3/+3."
    ['Spirit Mantle', 1, 1, ['protectionFrom:creatures']], // "+1/+1 and protection from creatures."
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
    // Equipment that grants only keywords — no P/T line at all, which is the
    // shape a "+0/+0 means it grants nothing" reading would silently blank.
    ['Basilisk Collar', 0, 0, ['deathtouch', 'lifelink']], // "has deathtouch and lifelink."
    ['Lightning Greaves', 0, 0, ['haste', 'shroud']], // "has haste and shroud."
    ['Swiftfoot Boots', 0, 0, ['hexproof', 'haste']], // "has hexproof and haste."
    // Equipment whose real text is a TRIGGER — the modification is only half the
    // card, and transcribing it here is what proves the other half did not eat it.
    ['Argentum Armor', 6, 6, []], // "Equipped creature gets +6/+6." (+ an attack trigger)
    ['Skullclamp', 1, -1, []], // "Equipped creature gets +1/-1." (+ a dies trigger)
    ['Sword of the Animist', 1, 1, []], // "Equipped creature gets +1/+1." (+ an attack trigger)
    ['Sword of Fire and Ice', 2, 2, ['protectionFrom:red', 'protectionFrom:blue']],
  ];

  /**
   * A SECOND, INDEPENDENT READING of the printed P/T line — a different regex,
   * written from the card face rather than from the rule table, so it can
   * disagree with the compiler instead of echoing it.
   *
   * ⚠️ WHY THIS EXISTS AT ALL. The hand table above IS the better guard: a human
   * read the card and typed what it says. It was also the only guard, and at 30
   * attachments that was fine. The pool now ships **5,066 cards** (§3.71) and
   * over 200 attachments, and "transcribe every one by hand" is not a thing that
   * scales to the whole printed card pool — it would have become a permanently
   * red test, which is a guard nobody trusts and therefore no guard at all.
   *
   * So the claim is now tiered, and neither tier is weaker than what it replaced:
   * the named cards keep their human transcription, and EVERY other attachment
   * must agree with a reading derived independently from its Oracle text.
   *
   * ⚠️ THE NOUN IS FOLLOWED IMMEDIATELY BY "gets", with nothing allowed between.
   * A looser version accepted anything up to the next "gets" and duly flagged
   * Dragon Mantle, Midnight Covenant and Talons of Falkenrath — whose printed
   * `+1/+0` sits inside a GRANTED ability ("Enchanted creature has '{R}: This
   * creature gets +1/+0 until end of turn.'"), not in a static modification. All
   * three were compiled correctly; the second reader was the one misreading.
   */
  const PRINTED_MODIFICATION =
    /(?:^|\n)(?:Equipped|Enchanted) (?:creature|artifact|permanent|land|player) gets ([+-]\d+)\/([+-]\d+)/;

  it('covers every attachment in the pool — a new card cannot slip in unread', () => {
    // Coverage means SOME independent second reading exists — a modification
    // row in PRINTED, a trigger-only row in PURE_TRIGGER (§3.56), or the
    // machine re-reading below.
    const listed = new Set([...PRINTED.map(([name]) => name), ...PURE_TRIGGER.map(([name]) => name)]);
    const disagreed: string[] = [];
    for (const card of attachments) {
      if (listed.has(card.name)) continue;
      const text = oracleTextOf(card.name);
      // A card whose text this suite cannot see is NOT quietly passed: an
      // attachment with no readable printed line is exactly the "looks
      // implemented, isn't" case, so it is reported by name.
      if (text === undefined) {
        disagreed.push(`${card.name}: no Oracle text to read`);
        continue;
      }
      const match = PRINTED_MODIFICATION.exec(text);
      const expectedPower = match ? Number(match[1]) + 0 : 0;
      const expectedToughness = match ? Number(match[2]) + 0 : 0;
      const modifies = card.attachment?.modifies;
      const actualPower = modifies?.power ?? 0;
      const actualToughness = modifies?.toughness ?? 0;
      if (actualPower !== expectedPower || actualToughness !== expectedToughness) {
        disagreed.push(
          `${card.name}: printed ${expectedPower}/${expectedToughness}, compiled ${actualPower}/${actualToughness}`,
        );
      }
    }
    expect(
      disagreed,
      'each attachment must match a reading taken independently from its Oracle text; ' +
        'add the card to PRINTED (modification) or PURE_TRIGGER (trigger-only) if the printed line needs a human',
    ).toEqual([]);
  });

  for (const [name, power, toughness, keywords] of PRINTED) {
    it(`${name} modifies exactly as printed`, () => {
      const modifies = poolCard(name).attachment?.modifies;
      expect(modifies, `${name} grants nothing`).toBeDefined();
      expect(modifies!.power ?? 0).toBe(power);
      expect(modifies!.toughness ?? 0).toBe(toughness);
      // A LIST-valued keyword (`protectionFrom: ['red', 'blue']`) is expanded
      // one entry per value, so the table transcribes WHICH protection the card
      // prints. Reading it as a bare `protectionFrom` would pass a Sword of Fire
      // and Ice that granted protection from white.
      const granted = Object.entries(modifies!.keywords ?? {})
        .filter(([, on]) => (Array.isArray(on) ? on.length > 0 : on))
        .flatMap(([keyword, on]) =>
          Array.isArray(on) ? on.map((value) => `${keyword}:${String(value)}`) : [keyword],
        )
        .sort();
      expect(granted).toEqual([...keywords].sort());
    });
  }
});

  /**
   * Attachments whose ENTIRE printed text is a trigger — no stat line, no
   * keyword grant. The first of these (Helm of the Host, §3.55) failed the
   * PRINTED loop precisely because that loop demands a modification, which for
   * every earlier card was the right demand. This list is the same independent
   * second reading for the trigger shape: the card must declare NO
   * modification (a phantom +0/+0 here would hide a compiler regression) and
   * must carry the printed trigger, transcribed.
   */
  const PURE_TRIGGER: ReadonlyArray<readonly [name: string, triggerContains: string]> = [
    // "At the beginning of combat on your turn, create a token that's a copy of
    // equipped creature, except the token isn't legendary and it gains haste."
    ['Helm of the Host', 'copy of equipped creature'],
  ];

  for (const [name, triggerContains] of PURE_TRIGGER) {
    it(`${name} is trigger-only, exactly as printed`, () => {
      const card = poolCard(name);
      expect(card.attachment, `${name} must still BE an attachment`).toBeDefined();
      expect(card.attachment!.modifies, `${name} prints no modification — a phantom one is a compiler bug`).toBeUndefined();
      const labels = (card.triggers ?? []).map((t) => (t.label ?? '').toLowerCase());
      expect(
        labels.some((l) => l.includes(triggerContains.toLowerCase())),
        `${name} must carry its printed trigger`,
      ).toBe(true);
    });
  }

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
    // A deck plays FOUR Bonesplitters, and stacking two on one creature is a
    // real (and correct) line — so the assertion counts what is actually on this
    // host rather than assuming one, exactly as the Aura test above does.
    const onThisHost = game.state.battlefield.filter(
      (c) => c.def.name === 'Bonesplitter' && c.attachedTo === host!.instanceId,
    ).length;
    expect(onThisHost).toBeGreaterThan(0);
    const mod = indexContinuous(game.state).get(host!.instanceId) ?? NO_MOD;
    expect(effectivePower(host!, mod)).toBe((host!.def.power ?? 0) + 2 * onThisHost);
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

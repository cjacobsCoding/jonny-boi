/**
 * THE SPELL-COUNT FAMILY (DESIGN §3.113) — storm, cascade, ripple, learn,
 * investigate N times, the loot template, the mill shapes, doubling power,
 * the reveal-the-top draw, and the keyword-sweep rows (Heal, a mode's surveil,
 * a granted scry) — proven the way this compiler's contract demands: a REAL
 * printed card compiles `'complete'` with its data pinned, AND the compiled
 * definition plays correctly in a real `createGame` + `applyAction` game with
 * the questions actually answered.
 *
 * The board assertions are the ones the brief names: Grapeshot after two
 * spells deals 3; Bloodbraid Elf cascades into a cheaper nonland card and
 * casts it free; Surging Flame ripples into its twin.
 */

import { describe, expect, it } from 'vitest';
import type { CardDefinition, CardInstance, ChoiceAnswer, GameAction, GameState, PlayerId } from '@jonny-boi/core';
import { aggregateFor, applyAction, createGame, DEFAULT_RULES, dumpState, effectivePower } from '@jonny-boi/core';
import { compileCard } from './compile/compile.js';
import type { CompilableCard } from './compile/types.js';
import { buildRegistry } from './pool.js';
import { CORE_PRIMITIVE_IDS } from './primitives.js';

type Registry = ReturnType<typeof buildRegistry>;

// --- the printed cards, exactly as Scryfall prints them --------------------------

type Cost = CompilableCard['manaCost'];
const cost = (parts: Partial<Cost>): Cost => ({ generic: 0, W: 0, U: 0, B: 0, R: 0, G: 0, C: 0, other: [], ...parts });
const INSTANT: CompilableCard['typeLine'] = { supertypes: [], types: ['Instant'], subtypes: [] };
const SORCERY: CompilableCard['typeLine'] = { supertypes: [], types: ['Sorcery'], subtypes: [] };
const creature = (subtypes: string[]): CompilableCard['typeLine'] => ({ supertypes: [], types: ['Creature'], subtypes });

function printed(
  name: string,
  oracleText: string,
  typeLine: CompilableCard['typeLine'],
  manaCost: Cost | null,
  extra: Partial<CompilableCard> = {},
): CompilableCard {
  return { id: `id:${name}`, name, manaCost, typeLine, power: null, toughness: null, keywords: [], oracleText, ...extra } as CompilableCard;
}

const STORM_REMINDER = ' (When you cast this spell, copy it for each spell cast before it this turn. You may choose new targets for the copies.)';
const CASCADE_REMINDER =
  ' (When you cast this spell, exile cards from the top of your library until you exile a nonland card that costs less. You may cast it without paying its mana cost. Put the exiled cards on the bottom in a random order.)';
const LEARN_REMINDER = ' (You may reveal a Lesson card you own from outside the game and put it into your hand, or discard a card to draw a card.)';

const GRAPESHOT = printed('Grapeshot', `Grapeshot deals 1 damage to any target.\nStorm${STORM_REMINDER}`, SORCERY, cost({ generic: 1, R: 1 }), { keywords: ['Storm'] });
const EMPTY_THE_WARRENS = printed('Empty the Warrens', `Create two 1/1 red Goblin creature tokens.\nStorm${STORM_REMINDER}`, SORCERY, cost({ generic: 3, R: 1 }), { keywords: ['Storm'] });
const STORMSCALE_SCION = printed(
  'Stormscale Scion',
  'Flying\nOther Dragons you control get +1/+1.\nStorm (When you cast this spell, copy it for each spell cast before it this turn. Copies become tokens.)',
  creature(['Dragon']),
  cost({ generic: 4, R: 2 }),
  { power: 4, toughness: 4, keywords: ['Flying', 'Storm'] },
);
const BLOODBRAID_ELF = printed(
  'Bloodbraid Elf',
  `Haste (This creature can attack and {T} as soon as it comes under your control.)\nCascade${CASCADE_REMINDER}`,
  creature(['Elf', 'Berserker']),
  cost({ generic: 2, R: 1, G: 1 }),
  { power: 3, toughness: 2, keywords: ['Haste', 'Cascade'] },
);
const MAELSTROM_WANDERER = printed(
  'Maelstrom Wanderer',
  `Creatures you control have haste.\nCascade, cascade${CASCADE_REMINDER.replace(')', ' Then do it again.)')}`,
  { supertypes: ['Legendary'], types: ['Creature'], subtypes: ['Elemental'] },
  cost({ generic: 5, G: 1, U: 1, R: 1 }),
  { power: 7, toughness: 5, keywords: ['Cascade'] },
);
const SURGING_FLAME = printed(
  'Surging Flame',
  'Ripple 4 (When you cast this spell, you may reveal the top four cards of your library. You may cast spells with the same name as this spell from among those cards without paying their mana costs. Put the rest on the bottom of your library.)\nSurging Flame deals 2 damage to any target.',
  INSTANT,
  cost({ generic: 1, R: 1 }),
  { keywords: ['Ripple'] },
);
const POP_QUIZ = printed('Pop Quiz', `Draw a card.\nLearn.${LEARN_REMINDER}`, INSTANT, cost({ generic: 2, U: 1 }), { keywords: ['Learn'] });
const CONFIRM_SUSPICIONS = printed(
  'Confirm Suspicions',
  'Counter target spell.\nInvestigate three times. (To investigate, create a Clue token. It\'s an artifact with "{2}, Sacrifice this token: Draw a card.")',
  INSTANT,
  cost({ generic: 3, U: 2 }),
  { keywords: ['Investigate'] },
);
const OWL_FAMILIAR = printed(
  'Owl Familiar',
  'Flying\nWhen this creature enters, draw a card, then discard a card.',
  creature(['Bird']),
  cost({ generic: 1, U: 1 }),
  { power: 1, toughness: 1, keywords: ['Flying'] },
);
const MERFOLK_LOOTER = printed('Merfolk Looter', '{T}: Draw a card, then discard a card.', creature(['Merfolk', 'Rogue']), cost({ generic: 1, U: 1 }), {
  power: 1,
  toughness: 1,
});
const SEED_OF_HOPE = printed(
  'Seed of Hope',
  'Mill two cards. You may put a permanent card from among the milled cards into your hand. You gain 2 life. (To mill two cards, put the top two cards of your library into your graveyard.)',
  INSTANT,
  cost({ G: 1 }),
  { keywords: ['Mill'] },
);
const MIDNIGHT_TILLING = printed(
  'Midnight Tilling',
  'Mill four cards, then you may return a permanent card from among them to your hand. (To mill four cards, put the top four cards of your library into your graveyard.)',
  INSTANT,
  cost({ generic: 1, G: 1 }),
  { keywords: ['Mill'] },
);
const CORPSE_CHURN = printed(
  'Corpse Churn',
  'Mill three cards, then you may return a creature card from your graveyard to your hand. (To mill three cards, put the top three cards of your library into your graveyard.)',
  INSTANT,
  cost({ generic: 1, B: 1 }),
  { keywords: ['Mill'] },
);
const SUDDEN_RECLAMATION = printed('Sudden Reclamation', 'Mill four cards, then return a creature card and a land card from your graveyard to your hand.', INSTANT, cost({ generic: 3, G: 1 }), {
  keywords: ['Mill'],
});
const UNLEASH_FURY = printed('Unleash Fury', 'Double the power of target creature until end of turn.', INSTANT, cost({ generic: 1, R: 1 }), { keywords: ['Double'] });
const DOUBLE_TROUBLE = printed('Double Trouble', 'Double the power of each creature you control until end of turn.', INSTANT, cost({ generic: 4, R: 1 }), { keywords: ['Double'] });
const ABSORBING_MAN = printed(
  'Absorbing Man and Titania',
  'Double all damage that creature sources you control would deal.',
  { supertypes: ['Legendary'], types: ['Creature'], subtypes: ['Human', 'Villain'] },
  cost({ generic: 3, R: 1, G: 1 }),
  { power: 4, toughness: 5, keywords: ['Double'] },
);
const TRACK_DOWN = printed(
  'Track Down',
  "Scry 3, then reveal the top card of your library. If it's a creature or land card, draw a card. (To scry 3, look at the top three cards of your library, then put any number of them on the bottom and the rest on top in any order.)",
  SORCERY,
  cost({ generic: 1, G: 1 }),
  { keywords: ['Scry'] },
);
const ELVEN_FARSIGHT = printed('Elven Farsight', 'Scry 3, then you may reveal the top card of your library. If a creature card is revealed this way, draw a card.', SORCERY, cost({ G: 1 }), {
  keywords: ['Scry'],
});
const SPELLGYRE = printed(
  'Spellgyre',
  'Choose one —\n• Counter target spell.\n• Surveil 2, then draw two cards. (To surveil 2, look at the top two cards of your library, then put any number of them into your graveyard and the rest on top of your library in any order.)',
  INSTANT,
  cost({ generic: 2, U: 2 }),
  { keywords: ['Surveil', 'Modal'] },
);
const ORACLES_INSIGHT = printed(
  "Oracle's Insight",
  'Enchant creature\nEnchanted creature has "{T}: Scry 1, then draw a card." (To scry 1, look at the top card of your library, then you may put that card on the bottom.)',
  { supertypes: [], types: ['Enchantment'], subtypes: ['Aura'] },
  cost({ generic: 3, U: 1 }),
  { keywords: ['Enchant', 'Scry'] },
);
const DRUDGE_SKELETONS = printed(
  'Drudge Skeletons',
  '{B}: Regenerate this creature. (The next time this creature would be destroyed this turn, instead tap it, remove it from combat, and heal all damage on it.)',
  creature(['Skeleton']),
  cost({ generic: 1, B: 1 }),
  { power: 1, toughness: 1, keywords: ['Heal', 'Regenerate'] },
);
// --- outside the closed tables: reported, never approximated -------------------
const CACHE_GRAB = printed(
  'Cache Grab',
  'Mill four cards. You may put a permanent card from among the cards milled this way into your hand. If you control a Squirrel or returned a Squirrel card to your hand this way, create a Food token.',
  INSTANT,
  cost({ generic: 1, G: 1 }),
  { keywords: ['Mill', 'Food'] },
);
const ROOTS_OF_WISDOM = printed('Roots of Wisdom', "Mill three cards, then return a land card or Elf card from your graveyard to your hand. If you can't, draw a card.", SORCERY, cost({ generic: 1, G: 1 }), {
  keywords: ['Mill'],
});
const BEACON_OF_IMMORTALITY = printed('Beacon of Immortality', "Double target player's life total. Shuffle Beacon of Immortality into its owner's library.", INSTANT, cost({ generic: 5, W: 1 }), {
  keywords: ['Double'],
});
const COLLECTIVE_INFERNO = printed(
  'Collective Inferno',
  'Convoke\nAs this enchantment enters, choose a creature type.\nDouble all damage that sources you control of the chosen type would deal.',
  { supertypes: [], types: ['Enchantment'], subtypes: [] },
  cost({ generic: 3, R: 2 }),
  { keywords: ['Convoke', 'Double'] },
);
const SECRETS_OF_THE_KEY = printed('Secrets of the Key', 'Investigate. If this spell was cast from a graveyard, investigate twice instead.\nFlashback {3}{U}', INSTANT, cost({ U: 1 }), {
  keywords: ['Investigate', 'Flashback'],
});

function complete(card: CompilableCard): CardDefinition {
  const result = compileCard(card);
  expect(result.status, `${card.name}: ${JSON.stringify(result.missing)}`).toBe('complete');
  return result.definition;
}

describe('the printed lines compile to the family’s data, and every body is a registered primitive', () => {
  it('registers the eight primitives the rules emit', () => {
    for (const id of ['stormCopies', 'cascade', 'ripple', 'learn', 'millThenReturn', 'returnMilledCard', 'doublePower', 'revealTopDrawIf']) {
      expect(CORE_PRIMITIVE_IDS, id).toContain(id);
    }
  });

  it('Storm (Grapeshot, Empty the Warrens, Stormscale Scion) — one cast trigger tagged storm, whose body is stormCopies', () => {
    expect(complete(GRAPESHOT).castTriggers).toEqual([{ keyword: 'storm', label: 'Storm', effects: [{ primitive: 'stormCopies' }] }]);
    expect(complete(EMPTY_THE_WARRENS).castTriggers?.length).toBe(1);
    expect(complete(STORMSCALE_SCION).castTriggers?.[0]?.keyword).toBe('storm');
  });

  it('Cascade (Bloodbraid Elf) and "Cascade, cascade" (Maelstrom Wanderer) — one trigger per printed instance', () => {
    expect(complete(BLOODBRAID_ELF).castTriggers).toEqual([{ keyword: 'cascade', label: 'Cascade', effects: [{ primitive: 'cascade' }] }]);
    expect(complete(MAELSTROM_WANDERER).castTriggers?.map((t) => t.keyword)).toEqual(['cascade', 'cascade']);
  });

  it('Ripple 4 (Surging Flame) — the count is the payload', () => {
    expect(complete(SURGING_FLAME).castTriggers).toEqual([
      { keyword: 'ripple', label: 'Ripple 4', effects: [{ primitive: 'ripple', params: { count: 4 } }] },
    ]);
  });

  it('Learn (Pop Quiz), Investigate three times (Confirm Suspicions), and the loot template (Owl Familiar, Merfolk Looter)', () => {
    expect(complete(POP_QUIZ).effects).toEqual([{ primitive: 'drawCards', params: { count: 1 } }, { primitive: 'learn' }]);
    expect(complete(CONFIRM_SUSPICIONS).effects?.[1]).toEqual({ primitive: 'createPredefinedToken', params: { token: 'clue', count: 3 } });
    const loot = [
      { primitive: 'drawCards', params: { count: 1 } },
      { primitive: 'discardCard', params: { who: 'controller' } },
    ];
    expect(complete(OWL_FAMILIAR).triggers?.[0]?.effects).toEqual(loot);
    expect(complete(MERFOLK_LOOTER).activated?.[0]?.effects).toEqual(loot);
  });

  it('the mill shapes — "from among the milled cards" (Seed of Hope, Midnight Tilling) and "from your graveyard" (Corpse Churn, Sudden Reclamation)', () => {
    const seed = compileCard(SEED_OF_HOPE);
    expect(seed.matchedRules).toContain('mill-then-put-from-among');
    expect(seed.definition.effects).toEqual([
      { primitive: 'millThenReturn', params: { amount: 2, filter: { noneOfTypes: ['instant', 'sorcery'] }, optional: true } },
      { primitive: 'gainLife', params: { amount: 2 } },
    ]);
    expect(complete(MIDNIGHT_TILLING).effects?.[0]).toMatchObject({ primitive: 'millThenReturn', params: { amount: 4, optional: true } });
    expect(complete(CORPSE_CHURN).effects).toEqual([
      { primitive: 'mill', params: { amount: 3, self: true } },
      { primitive: 'returnFromGraveyard', params: { count: 1, filter: { anyOfTypes: ['creature'] }, optional: true } },
    ]);
    expect(complete(SUDDEN_RECLAMATION).effects).toEqual([
      { primitive: 'mill', params: { amount: 4, self: true } },
      { primitive: 'returnFromGraveyard', params: { count: 1, filter: { anyOfTypes: ['creature'] } } },
      { primitive: 'returnFromGraveyard', params: { count: 1, filter: { anyOfTypes: ['land'] } } },
    ]);
  });

  it('Double (Unleash Fury, Double Trouble) and "Double all damage that creature sources you control would deal" (Absorbing Man and Titania)', () => {
    expect(complete(UNLEASH_FURY).effects).toEqual([{ primitive: 'doublePower', params: { targets: 'creature' } }]);
    expect(complete(DOUBLE_TROUBLE).effects).toEqual([{ primitive: 'doublePower', params: { each: 'yours' } }]);
    expect(complete(ABSORBING_MAN).replacements).toEqual([
      { event: 'damage', applies: { sourceController: 'you', sourceFilter: { anyOfTypes: ['creature'] } }, outcome: { times: 2 } },
    ]);
  });

  it('the reveal-the-top draw (Track Down, Elven Farsight) rides scry-then-effect', () => {
    expect(complete(TRACK_DOWN).effects).toEqual([
      { primitive: 'scry', params: { count: 3 } },
      { primitive: 'revealTopDrawIf', params: { filter: { anyOfTypes: ['creature', 'land'] } } },
    ]);
    expect(complete(ELVEN_FARSIGHT).effects?.[1]).toEqual({
      primitive: 'revealTopDrawIf',
      params: { filter: { anyOfTypes: ['creature'] }, optional: true },
    });
  });

  it('the keyword sweep: a Heal tag is regenerate’s reminder text; a mode’s surveil and a granted scry are evidence', () => {
    expect(complete(DRUDGE_SKELETONS).activated?.length).toBe(1);
    expect(complete(SPELLGYRE).modal?.modes.length).toBe(2);
    expect(complete(ORACLES_INSIGHT).attachment?.modifies?.activated?.[0]?.effects).toEqual([
      { primitive: 'scry' },
      { primitive: 'drawCards', params: { count: 1 } },
    ]);
  });

  it('REPORTS, never approximates, the forms outside the closed tables', () => {
    for (const [card, clause] of [
      [CACHE_GRAB, /squirrel/i],
      [ROOTS_OF_WISDOM, /land card or elf card/i],
      [BEACON_OF_IMMORTALITY, /life total/i],
      [COLLECTIVE_INFERNO, /chosen type/i],
      [SECRETS_OF_THE_KEY, /cast from a graveyard/i],
    ] as const) {
      const result = compileCard(card);
      expect(result.status, card.name).toBe('incomplete');
      expect(result.missing.some((gap) => clause.test(gap.text)), `${card.name}: ${JSON.stringify(result.missing)}`).toBe(true);
    }
  });
});

// --- played through the real engine -------------------------------------------------

const SEED = 113;
const DECK_SIZE = 40;
let syntheticId = 91_000;

function land(id: string, color: 'W' | 'U' | 'B' | 'R' | 'G'): CardDefinition {
  return { id, name: id, types: ['land'], produces: [color] };
}
const FOREST = land('Forest', 'G');
const BEAR: CardDefinition = { id: 'bear', name: 'Bear', types: ['creature'], power: 2, toughness: 2, cost: { generic: 2 } };
const BIG: CardDefinition = { id: 'big', name: 'Big', types: ['creature'], power: 5, toughness: 5, cost: { generic: 5 } };
/** A blank one-mana sorcery — a spell cast "before it this turn". */
const BLANK: CardDefinition = { id: 'blank', name: 'Blank', types: ['sorcery'], timing: 'sorcery', cost: { generic: 1 }, effects: [] };

function instance(def: CardDefinition, player: PlayerId, zone: CardInstance['zone']): CardInstance {
  return { instanceId: syntheticId++, def, controller: player, owner: player, zone, tapped: false, summoningSick: false, damageMarked: 0, markedByDeathtouch: false, counters: {} };
}

function act(state: GameState, action: GameAction, reg: Registry): GameState {
  const result = applyAction(state, action, DEFAULT_RULES, reg);
  const rejected = result.events.find((e) => e.type === 'actionRejected');
  if (rejected) throw new Error(`unexpected rejection: ${(rejected as { reason: string }).reason}\n${dumpState(state)}`);
  return result.state;
}

function pass(state: GameState, reg: Registry): GameState {
  return act(state, { kind: 'passPriority', player: state.priorityPlayer }, reg);
}

function until(state: GameState, reg: Registry, done: (s: GameState) => boolean): GameState {
  let s = state;
  for (let guard = 0; guard < 800; guard++) {
    if (done(s)) return s;
    if (s.gameOver) throw new Error('game ended first');
    if (s.pendingChoice) throw new Error(`a question parked the game first:\n${dumpState(s)}`);
    s = pass(s, reg);
  }
  throw new Error(`never reached the condition (turn ${s.turnNumber} ${s.step})`);
}

function gameAtMain(reg: Registry): GameState {
  const { state: created } = createGame({
    seed: SEED,
    startingPlayer: 'A',
    registry: reg,
    decks: { A: { cards: Array.from({ length: DECK_SIZE }, () => FOREST) }, B: { cards: Array.from({ length: DECK_SIZE }, () => FOREST) } },
  });
  const state = until(created, reg, (s) => s.step === 'precombatMain');
  state.players.A.hand = [];
  state.players.B.hand = [];
  return state;
}

function fund(state: GameState, player: PlayerId, pool: Partial<Record<'W' | 'U' | 'B' | 'R' | 'G' | 'C', number>>): void {
  state.players[player].manaPool = { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0, ...pool };
}

function inHand(state: GameState, def: CardDefinition): CardInstance {
  const card = instance(def, 'A', 'hand');
  state.players.A.hand.push(card);
  return card;
}

/** Put `defs` on top of A's library, `defs[0]` topmost. */
function onTop(state: GameState, defs: readonly CardDefinition[]): CardInstance[] {
  const cards = defs.map((def) => instance(def, 'A', 'library'));
  state.players.A.library.unshift(...cards);
  return cards;
}

function cast(state: GameState, reg: Registry, card: CardInstance, targets?: (number | PlayerId)[], fromZone?: 'exile'): GameState {
  return act(state, { kind: 'castSpell', player: 'A', instanceId: card.instanceId, ...(targets ? { targets } : {}), ...(fromZone ? { fromZone } : {}) }, reg);
}

/**
 * Pass until the stack is empty, answering every question with `answerer`,
 * and STOPPING at an open cast window (the test decides what to do with it).
 */
function settle(state: GameState, reg: Registry, answerer: (s: GameState) => ChoiceAnswer): GameState {
  let s = state;
  for (let guard = 0; guard < 200; guard++) {
    if (s.pendingChoice) {
      const choice = s.pendingChoice;
      s = act(s, { kind: 'answerChoice', player: choice.chooser, choiceId: choice.id, answer: answerer(s) }, reg);
      continue;
    }
    if (s.madnessWindow) return s;
    if (s.stack.length === 0) return s;
    s = pass(s, reg);
  }
  throw new Error(`the stack never emptied:\n${dumpState(s)}`);
}

const yes: ChoiceAnswer = { kind: 'confirm', yes: true };
const toB: ChoiceAnswer = { kind: 'selectTargets', targets: ['B'] };
function pickFirst(s: GameState): ChoiceAnswer {
  const choice = s.pendingChoice!;
  if (choice.kind === 'selectCards') return { kind: 'selectCards', instanceIds: choice.candidates.slice(0, Math.max(1, choice.min)).map((c) => c.instanceId) };
  if (choice.kind === 'selectTargets') return toB;
  return yes;
}

describe('STORM, played (CR 702.40a)', () => {
  it('Grapeshot after two spells deals 3: two copies, each re-aimed, plus the original', () => {
    const reg = buildRegistry();
    let s = gameAtMain(reg);
    fund(s, 'A', { R: 9, C: 9 });
    s = cast(s, reg, inHand(s, BLANK));
    s = settle(s, reg, pickFirst);
    s = cast(s, reg, inHand(s, BLANK));
    s = settle(s, reg, pickFirst);
    const grapeshot = inHand(s, complete(GRAPESHOT));
    s = cast(s, reg, grapeshot, ['B']);
    expect(s.stack.length).toBe(2); // the spell and its storm trigger
    const asked: string[] = [];
    s = settle(s, reg, (x) => {
      asked.push(x.pendingChoice!.kind);
      return toB;
    });
    // Two copies, one "choose new targets" question each (CR 707.10).
    expect(asked).toEqual(['selectTargets', 'selectTargets']);
    expect(s.players.B.life).toBe(20 - 3);
    expect(s.stack).toEqual([]);
    // The copies ceased to exist: only the real card reached the graveyard.
    expect(s.players.A.graveyard.filter((c) => c.def.name === 'Grapeshot').length).toBe(1);
  });

  it('a storm spell cast first this turn makes no copies', () => {
    const reg = buildRegistry();
    let s = gameAtMain(reg);
    fund(s, 'A', { R: 9, C: 9 });
    s = cast(s, reg, inHand(s, complete(GRAPESHOT)), ['B']);
    s = settle(s, reg, pickFirst);
    expect(s.players.B.life).toBe(19);
  });
});

describe('CASCADE, played (CR 702.85a)', () => {
  it('Bloodbraid Elf exiles past a land and a costlier card to a cheaper creature, casts it for nothing, and bottoms the rest', () => {
    const reg = buildRegistry();
    let s = gameAtMain(reg);
    fund(s, 'A', { R: 9, G: 9, C: 9 });
    const [forest, big, bear] = onTop(s, [FOREST, BIG, BEAR]);
    const librarySize = s.players.A.library.length;
    const elf = inHand(s, complete(BLOODBRAID_ELF));
    s = cast(s, reg, elf);
    s = settle(s, reg, pickFirst);
    expect(s.madnessWindow?.kind).toBe('cascade');
    expect(s.madnessWindow?.instanceId).toBe(bear!.instanceId);
    expect(s.players.A.exile.map((c) => c.def.name)).toEqual(['Forest', 'Big', 'Bear']);
    // Without paying its mana cost: the pool is empty and the cast is legal.
    fund(s, 'A', {});
    s = cast(s, reg, bear!, undefined, 'exile');
    expect(s.madnessWindow).toBeNull();
    expect(s.players.A.exile).toEqual([]);
    expect(s.players.A.library.length).toBe(librarySize - 1);
    expect(new Set(s.players.A.library.slice(-2).map((c) => c.instanceId))).toEqual(new Set([forest!.instanceId, big!.instanceId]));
    s = settle(s, reg, pickFirst);
    expect(s.battlefield.map((c) => c.def.name)).toEqual(['Bear', 'Bloodbraid Elf']);
    expect(s.battlefield.find((c) => c.def.name === 'Bloodbraid Elf')?.summoningSick).toBe(false); // haste, its own line
  });
});

describe('RIPPLE, played (CR 702.60a)', () => {
  it('Surging Flame reveals four, casts its twin for nothing at a new target, and bottoms the rest in order', () => {
    const reg = buildRegistry();
    let s = gameAtMain(reg);
    fund(s, 'A', { R: 9, C: 9 });
    const def = complete(SURGING_FLAME);
    const [twin] = onTop(s, [def, FOREST, FOREST, FOREST]);
    const librarySize = s.players.A.library.length;
    s = cast(s, reg, inHand(s, def), ['B']);
    // The trigger asks "reveal?", then the window opens on the twin.
    s = settle(s, reg, () => yes);
    expect(s.madnessWindow?.kind).toBe('ripple');
    expect(s.madnessWindow?.instanceId).toBe(twin!.instanceId);
    fund(s, 'A', {});
    s = cast(s, reg, twin!, ['B'], 'exile');
    expect(s.madnessWindow).toBeNull();
    // The three Forests went to the bottom, revealed order kept.
    expect(s.players.A.library.length).toBe(librarySize - 1);
    expect(s.players.A.library.slice(-3).every((c) => c.def.name === 'Forest')).toBe(true);
    // The twin's own ripple resolves (reveals four Forests, finds no twin), then both spells.
    s = settle(s, reg, () => yes);
    expect(s.madnessWindow ?? null).toBeNull();
    expect(s.players.B.life).toBe(20 - 4);
    expect(s.players.A.exile).toEqual([]);
  });
});

describe('LEARN and the loot template, played (CR 701.48a)', () => {
  it('Pop Quiz draws, then learn discards a card to draw a card — and skips the draw with nothing to discard', () => {
    const reg = buildRegistry();
    let s = gameAtMain(reg);
    fund(s, 'A', { U: 9, C: 9 });
    const blank = inHand(s, BLANK);
    s = cast(s, reg, inHand(s, complete(POP_QUIZ)));
    const asked: string[] = [];
    s = settle(s, reg, (x) => {
      asked.push(x.pendingChoice!.kind);
      if (x.pendingChoice!.kind === 'selectCards') return { kind: 'selectCards', instanceIds: [blank.instanceId] };
      return yes;
    });
    expect(asked).toEqual(['confirm', 'selectCards']);
    expect(s.players.A.hand.length).toBe(2); // Blank + drawn, then Blank out and another in
    expect(s.players.A.graveyard.map((c) => c.def.name).sort()).toEqual(['Blank', 'Pop Quiz']);

    // An empty hand: the draw resolves, learn has nothing to discard, no question.
    let e = gameAtMain(reg);
    fund(e, 'A', { U: 9, C: 9 });
    e = cast(e, reg, inHand(e, complete(POP_QUIZ)));
    // "Draw a card" gives the hand a card, so learn DOES have something to discard;
    // remove it first to pin the empty-hand branch honestly.
    e = pass(e, reg);
    e = pass(e, reg);
    expect(e.pendingChoice?.kind).toBe('confirm');
    e = act(e, { kind: 'answerChoice', player: 'A', choiceId: e.pendingChoice!.id, answer: { kind: 'confirm', yes: false } }, reg);
    expect(e.pendingChoice ?? null).toBeNull();
    expect(e.players.A.hand.length).toBe(1);
  });

  it('Owl Familiar enters, draws, then its controller discards', () => {
    const reg = buildRegistry();
    let s = gameAtMain(reg);
    fund(s, 'A', { U: 9, C: 9 });
    s = cast(s, reg, inHand(s, complete(OWL_FAMILIAR)));
    s = settle(s, reg, pickFirst);
    expect(s.battlefield.map((c) => c.def.name)).toEqual(['Owl Familiar']);
    expect(s.players.A.hand.length).toBe(0);
    expect(s.players.A.graveyard.length).toBe(1);
  });
});

describe('the mill shapes, played (CR 701.17a)', () => {
  // ⚠️ The graveyard assertion here is the guard for a CLASS of bug, not a
  // detail: a primitive that mutates and THEN asks re-runs its mutation when the
  // question parks, and the first version of `millThenReturn` milled twice — two
  // extra Forests. The ask now lives in an enqueued second ref, and this counts.
  it('Seed of Hope mills two — exactly once, across the parked question — offers only the milled permanents, and gains 2', () => {
    const reg = buildRegistry();
    let s = gameAtMain(reg);
    fund(s, 'A', { G: 9 });
    const [forest, bear] = onTop(s, [FOREST, BEAR]);
    s = cast(s, reg, inHand(s, complete(SEED_OF_HOPE)));
    s = settle(s, reg, (x) => {
      const choice = x.pendingChoice!;
      expect(choice.kind).toBe('selectCards');
      if (choice.kind !== 'selectCards') return yes;
      expect(choice.candidates.map((c) => c.instanceId).sort()).toEqual([forest!.instanceId, bear!.instanceId].sort());
      expect(choice.min).toBe(0);
      return { kind: 'selectCards', instanceIds: [bear!.instanceId] };
    });
    expect(s.players.A.hand.map((c) => c.def.name)).toEqual(['Bear']);
    expect(s.players.A.graveyard.map((c) => c.def.name)).toEqual(['Forest', 'Seed of Hope']);
    expect(s.players.A.life).toBe(22);
  });

  it('Corpse Churn mills three, then returns a creature card from the graveyard', () => {
    const reg = buildRegistry();
    let s = gameAtMain(reg);
    fund(s, 'A', { B: 9 });
    const [bear] = onTop(s, [BEAR, FOREST, FOREST]);
    s = cast(s, reg, inHand(s, complete(CORPSE_CHURN)));
    s = settle(s, reg, () => ({ kind: 'selectCards', instanceIds: [bear!.instanceId] }));
    expect(s.players.A.hand.map((c) => c.def.name)).toEqual(['Bear']);
    expect(s.players.A.graveyard.filter((c) => c.def.name === 'Forest').length).toBe(2);
  });
});

describe('DOUBLE, played (CR 701.10b)', () => {
  it('Unleash Fury doubles the target’s power; Double Trouble doubles each of yours', () => {
    const reg = buildRegistry();
    let s = gameAtMain(reg);
    fund(s, 'A', { R: 9, C: 9 });
    const mine = instance(BEAR, 'A', 'battlefield');
    const other = instance(BEAR, 'A', 'battlefield');
    const theirs = instance(BEAR, 'B', 'battlefield');
    s.battlefield.push(mine, other, theirs);
    const powerOf = (state: GameState, id: number) => {
      const card = state.battlefield.find((c) => c.instanceId === id)!;
      return effectivePower(card, aggregateFor(state, id));
    };
    s = cast(s, reg, inHand(s, complete(UNLEASH_FURY)), [mine.instanceId]);
    s = settle(s, reg, pickFirst);
    expect(powerOf(s, mine.instanceId)).toBe(4);
    expect(powerOf(s, other.instanceId)).toBe(2);
    s = cast(s, reg, inHand(s, complete(DOUBLE_TROUBLE)));
    s = settle(s, reg, pickFirst);
    expect(powerOf(s, mine.instanceId)).toBe(8); // its real power as the spell resolves
    expect(powerOf(s, other.instanceId)).toBe(4);
    expect(powerOf(s, theirs.instanceId)).toBe(2);
  });
});

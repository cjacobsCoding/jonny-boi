/**
 * THE GRAVEYARD-CASTING FAMILY (DESIGN §3.111) — unearth, scavenge, embalm,
 * eternalize, encore, retrace, jump-start, escape, flashback's non-mana costs,
 * and the graveyard-return templates (Rancor, "when ~ dies, return it to its
 * owner's hand", "{2}{B}: Return ~ from your graveyard to your hand"), each
 * proven twice: the REAL printed card compiles (ground truth from the full
 * corpus, names pinned), and the compiled card does the printed thing to a
 * game played through the real engine.
 *
 * Every assertion is about the RULE's effect on the board — an unearthed
 * Dregscape Zombie is in exile after the end step, a scavenged Deadbridge
 * Goliath's five counters sit on the target, a retraced Flame Jab is back in
 * the graveyard — because a card that compiles and then does nothing is the
 * failure this whole package exists to refuse.
 */

import { describe, expect, it } from 'vitest';
import type { CardDefinition, CardInstance, GameAction, GameState, PlayerId } from '@jonny-boi/core';
import { applyAction, createGame, DEFAULT_RULES, delayedRemovalTargets, dumpState, generateLegalActions } from '@jonny-boi/core';
import { compileCard } from './compile/compile.js';
import type { CompilableCard } from './compile/types.js';
import { buildRegistry } from './pool.js';
import { CORE_PRIMITIVE_IDS } from './primitives.js';

type Registry = ReturnType<typeof buildRegistry>;

// --- the printed cards, exactly as Scryfall prints them --------------------------

type Cost = CompilableCard['manaCost'];
const cost = (parts: Partial<Cost>): Cost => ({ generic: 0, W: 0, U: 0, B: 0, R: 0, G: 0, C: 0, other: [], ...parts });

function printed(
  name: string,
  oracleText: string,
  typeLine: CompilableCard['typeLine'],
  manaCost: Cost | null,
  extra: Partial<CompilableCard> = {},
): CompilableCard {
  return {
    id: `id:${name}`,
    name,
    manaCost,
    typeLine,
    power: null,
    toughness: null,
    keywords: [],
    oracleText,
    ...extra,
  } as CompilableCard;
}

const creature = (subtypes: string[]): CompilableCard['typeLine'] => ({ supertypes: [], types: ['Creature'], subtypes });
const spell = (type: 'Instant' | 'Sorcery'): CompilableCard['typeLine'] => ({ supertypes: [], types: [type], subtypes: [] });

const DREGSCAPE_ZOMBIE = printed(
  'Dregscape Zombie',
  'Unearth {B} ({B}: Return this card from your graveyard to the battlefield. It gains haste. Exile it at the beginning of the next end step or if it would leave the battlefield. Unearth only as a sorcery.)',
  creature(['Zombie']),
  cost({ generic: 1, B: 1 }),
  { power: 2, toughness: 1, keywords: ['Unearth'] },
);
const DEADBRIDGE_GOLIATH = printed(
  'Deadbridge Goliath',
  "Scavenge {4}{G}{G} ({4}{G}{G}, Exile this card from your graveyard: Put a number of +1/+1 counters equal to this card's power on target creature. Scavenge only as a sorcery.)",
  creature(['Insect']),
  cost({ generic: 2, G: 2 }),
  { power: 5, toughness: 5, keywords: ['Scavenge'] },
);
const SACRED_CAT = printed(
  'Sacred Cat',
  "Lifelink\nEmbalm {W} ({W}, Exile this card from your graveyard: Create a token that's a copy of it, except it's a white Zombie Cat with no mana cost. Embalm only as a sorcery.)",
  creature(['Cat']),
  cost({ W: 1 }),
  { power: 1, toughness: 1, keywords: ['Lifelink', 'Embalm'] },
);
const PROVEN_COMBATANT = printed(
  'Proven Combatant',
  "Eternalize {4}{U}{U} ({4}{U}{U}, Exile this card from your graveyard: Create a token that's a copy of it, except it's a 4/4 black Zombie Human Warrior with no mana cost. Eternalize only as a sorcery.)",
  creature(['Human', 'Warrior']),
  cost({ U: 1 }),
  { power: 1, toughness: 1, keywords: ['Eternalize'] },
);
const EXQUISITE_HUNTMASTER = printed(
  'Exquisite Huntmaster',
  'When this creature dies, create a 1/1 green Elf Warrior creature token.\nEncore {4}{B} ({4}{B}, Exile this card from your graveyard: For each opponent, create a token copy that attacks that opponent this turn if able. They gain haste. Sacrifice them at the beginning of the next end step. Activate only as a sorcery.)',
  creature(['Elf', 'Warrior']),
  cost({ generic: 3, B: 1 }),
  { power: 4, toughness: 2, keywords: ['Encore'] },
);
const SANITARIUM_SKELETON = printed(
  'Sanitarium Skeleton',
  '{2}{B}: Return this card from your graveyard to your hand.',
  creature(['Skeleton']),
  cost({ B: 1 }),
  { power: 1, toughness: 2 },
);
const FLAME_JAB = printed(
  'Flame Jab',
  'Flame Jab deals 1 damage to any target.\nRetrace (You may cast this card from your graveyard by discarding a land card in addition to paying its other costs.)',
  spell('Sorcery'),
  cost({ R: 1 }),
  { keywords: ['Retrace'] },
);
const DIRECT_CURRENT = printed(
  'Direct Current',
  'Direct Current deals 2 damage to any target.\nJump-start (You may cast this card from your graveyard by discarding a card in addition to paying its other costs. Then exile this card.)',
  spell('Sorcery'),
  cost({ generic: 1, R: 2 }),
  { keywords: ['Jump', 'Jump-start'] },
);
const GLIMPSE_OF_FREEDOM = printed(
  'Glimpse of Freedom',
  'Draw a card.\nEscape—{2}{U}, Exile five other cards from your graveyard. (You may cast this card from your graveyard for its escape cost.)',
  spell('Instant'),
  cost({ generic: 1, U: 1 }),
  { keywords: ['Escape'] },
);
const DREAD_RETURN = printed(
  'Dread Return',
  'Return target creature card from your graveyard to the battlefield.\nFlashback—Sacrifice three creatures. (You may cast this card from your graveyard for its flashback cost. Then exile it.)',
  spell('Sorcery'),
  cost({ generic: 2, B: 2 }),
  { keywords: ['Flashback'] },
);
const BATTLE_SCREECH = printed(
  'Battle Screech',
  'Create two 1/1 white Bird creature tokens with flying.\nFlashback—Tap three untapped white creatures you control. (You may cast this card from your graveyard for its flashback cost. Then exile it.)',
  spell('Sorcery'),
  cost({ generic: 2, W: 2 }),
  { keywords: ['Flashback'] },
);
const LAVA_DART = printed(
  'Lava Dart',
  'Lava Dart deals 1 damage to any target.\nFlashback—Sacrifice a Mountain. (You may cast this card from your graveyard for its flashback cost. Then exile it.)',
  spell('Instant'),
  cost({ R: 1 }),
  { keywords: ['Flashback'] },
);
const RANCOR = printed(
  'Rancor',
  "Enchant creature\nEnchanted creature gets +2/+0 and has trample.\nWhen this Aura is put into a graveyard from the battlefield, return it to its owner's hand.",
  { supertypes: [], types: ['Enchantment'], subtypes: ['Aura'] },
  cost({ G: 1 }),
  { keywords: ['Enchant'] },
);
const MORTUS_STRIDER = printed(
  'Mortus Strider',
  "When this creature dies, return it to its owner's hand.",
  creature(['Skeleton', 'Wizard']),
  cost({ generic: 1, U: 1, B: 1 }),
  { power: 1, toughness: 1 },
);
// --- the honest refusals -----------------------------------------------------------
const SINUOUS_STRIKER = printed(
  'Sinuous Striker',
  "{U}: This creature gets +1/-1 until end of turn.\nEternalize—{3}{U}{U}, Discard a card. ({3}{U}{U}, Discard a card, Exile this card from your graveyard: Create a token that's a copy of it, except it's a 4/4 black Zombie Snake Warrior with no mana cost. Eternalize only as a sorcery.)",
  creature(['Snake', 'Warrior']),
  cost({ generic: 2, U: 1 }),
  { power: 2, toughness: 2, keywords: ['Eternalize'] },
);
const CONFLAGRATE = printed(
  'Conflagrate',
  'Conflagrate deals X damage divided as you choose among any number of targets.\nFlashback—{R}{R}, Discard X cards. (You may cast this card from your graveyard for its flashback cost. Then exile it.)',
  spell('Sorcery'),
  cost({ R: 1, other: ['X', 'X'] }),
  { keywords: ['Flashback'] },
);
const SALVATION_COLOSSUS_LINE = printed(
  'Salvation Colossus',
  'Unearth—Pay eight {E}. (Pay eight energy counters: Return this card from your graveyard to the battlefield. It gains haste. Exile it at the beginning of the next end step or if it would leave the battlefield. Unearth only as a sorcery.)',
  { supertypes: [], types: ['Artifact', 'Creature'], subtypes: ['Construct'] },
  cost({ generic: 6, W: 2 }),
  { power: 8, toughness: 8, keywords: ['Unearth'] },
);
const LAZOTEP_ARCHWAY = printed(
  'Lazotep Archway',
  "Lazotep Archway enters the battlefield tapped.\n{T}: Add {W} or {B}.\nEternalize {3}{W}{B} ({3}{W}{B}, Exile this card from your graveyard: Create a token that's a copy of it, except it's a 4/4 black Zombie creature and loses all other card types. Eternalize only as a sorcery.)",
  { supertypes: [], types: ['Land'], subtypes: [] },
  { ...cost({}), absent: true },
  { keywords: ['Eternalize'] },
);

function complete(card: CompilableCard): CardDefinition {
  const result = compileCard(card);
  expect(result.status, `${card.name}: ${JSON.stringify(result.missing)}`).toBe('complete');
  return result.definition;
}

// --- the compiler half ------------------------------------------------------------

describe('the printed lines compile to the family’s shapes, and every body is a registered primitive', () => {
  it('registers the four primitives the rules emit', () => {
    for (const id of ['unearthReturn', 'scavengeCounters', 'graveyardTokenCopy', 'returnSourceFromGraveyard']) {
      expect(CORE_PRIMITIVE_IDS, id).toContain(id);
    }
  });

  it('Unearth {B} (Dregscape Zombie) and Scavenge {4}{G}{G} (Deadbridge Goliath) — graveyard abilities, scavenge with exile as its cost', () => {
    expect(complete(DREGSCAPE_ZOMBIE).graveyardAbilities).toEqual([
      { kind: 'unearth', cost: { mana: { B: 1 } }, effects: [{ primitive: 'unearthReturn' }], timing: 'sorcery', label: 'Unearth {B}' },
    ]);
    expect(complete(DEADBRIDGE_GOLIATH).graveyardAbilities).toEqual([
      {
        kind: 'scavenge',
        cost: { mana: { generic: 4, G: 2 } },
        exileSelf: true,
        effects: [{ primitive: 'scavengeCounters', params: { targets: 'creature' } }],
        timing: 'sorcery',
        label: 'Scavenge {4}{G}{G}',
      },
    ]);
  });

  it('Embalm {W} (Sacred Cat), Eternalize {4}{U}{U} (Proven Combatant), Encore {4}{B} (Exquisite Huntmaster) — the token copies and their printed "except" tails', () => {
    expect(complete(SACRED_CAT).graveyardAbilities?.[0]).toMatchObject({
      kind: 'embalm',
      exileSelf: true,
      effects: [{ primitive: 'graveyardTokenCopy', params: { except: { colors: ['W'], addSubtypes: ['zombie'], noManaCost: true } } }],
    });
    expect(complete(PROVEN_COMBATANT).graveyardAbilities?.[0]).toMatchObject({
      kind: 'eternalize',
      effects: [{ primitive: 'graveyardTokenCopy', params: { except: { colors: ['B'], addSubtypes: ['zombie'], noManaCost: true, power: 4, toughness: 4 } } }],
    });
    expect(complete(EXQUISITE_HUNTMASTER).graveyardAbilities?.[0]).toMatchObject({
      kind: 'encore',
      effects: [{ primitive: 'graveyardTokenCopy', params: { perOpponent: true, grantKeywords: { haste: true, mustAttack: true }, delayedRemoval: 'sacrifice' } }],
    });
    expect(complete(SANITARIUM_SKELETON).graveyardAbilities?.[0]).toMatchObject({
      kind: 'returnToHand',
      cost: { mana: { generic: 2, B: 1 } },
      effects: [{ primitive: 'returnSourceFromGraveyard', params: { to: 'hand' } }],
    });
  });

  it('Retrace (Flame Jab), Jump-start (Direct Current — with Scryfall’s phantom "Jump" tag) and Escape—{2}{U}, Exile five (Glimpse of Freedom) — the graveyard casts', () => {
    expect(complete(FLAME_JAB).graveyardCasts).toEqual([
      { kind: 'retrace', additional: { kind: 'discard', filter: { anyOfTypes: ['land'] }, label: 'Discard a land card' } },
    ]);
    expect(complete(DIRECT_CURRENT).graveyardCasts).toEqual([{ kind: 'jumpStart', additional: { kind: 'discard', label: 'Discard a card' } }]);
    expect(complete(GLIMPSE_OF_FREEDOM).graveyardCasts).toEqual([
      { kind: 'escape', cost: { generic: 2, U: 1 }, additional: { kind: 'exileFromGraveyard', count: 5, label: 'Exile 5 other cards from your graveyard' } },
    ]);
  });

  it('Flashback—Sacrifice three creatures (Dread Return) / —Tap three untapped white creatures (Battle Screech) / —Sacrifice a Mountain (Lava Dart) — an empty mana half and the rider', () => {
    const dread = complete(DREAD_RETURN);
    expect(dread.flashback).toEqual({});
    expect(dread.flashbackAdditionalCost).toEqual({ kind: 'sacrifice', count: 3, filter: { anyOfTypes: ['creature'] }, label: 'Sacrifice three creatures' });
    expect(complete(BATTLE_SCREECH).flashbackAdditionalCost).toEqual({
      kind: 'tap',
      count: 3,
      filter: { anyOfTypes: ['creature'], anyOfColors: ['W'] },
      label: 'Tap three untapped white creatures you control',
    });
    expect(complete(LAVA_DART).flashbackAdditionalCost).toMatchObject({ kind: 'sacrifice', count: 1, filter: { anyOfSubtypes: ['Mountain'] } });
  });

  it('Rancor’s "put into a graveyard from the battlefield" and Mortus Strider’s "dies" — the same self-return body on two events', () => {
    expect(complete(RANCOR).triggers?.[0]).toMatchObject({
      condition: { on: 'putIntoGraveyardFromBattlefield' },
      effects: [{ primitive: 'returnSourceFromGraveyard', params: { to: 'hand' } }],
    });
    expect(complete(MORTUS_STRIDER).triggers?.[0]).toMatchObject({
      condition: { on: 'dies' },
      effects: [{ primitive: 'returnSourceFromGraveyard', params: { to: 'hand' } }],
    });
  });

  it('REPORTS, never approximates, the forms outside the closed tables', () => {
    for (const [card, clause] of [
      [SINUOUS_STRIKER, /eternalize—\{3\}\{u\}\{u\}, discard a card/i],
      [CONFLAGRATE, /flashback—\{r\}\{r\}, discard x cards/i],
      [SALVATION_COLOSSUS_LINE, /unearth—pay eight/i],
      [LAZOTEP_ARCHWAY, /eternalize \{3\}\{w\}\{b\}/i],
    ] as const) {
      const result = compileCard(card);
      expect(result.status, card.name).toBe('incomplete');
      expect(result.missing.some((gap) => clause.test(gap.text)), `${card.name}: ${JSON.stringify(result.missing)}`).toBe(true);
      expect(result.definition.graveyardAbilities ?? []).toHaveLength(0);
    }
  });
});

// --- the engine half --------------------------------------------------------------

const SEED = 71;
const DECK_SIZE = 40;
let syntheticId = 90_000;

function land(id: string, color: 'W' | 'U' | 'B' | 'R' | 'G'): CardDefinition {
  return { id, name: id, types: ['land'], produces: [color] };
}
const SWAMP = land('Swamp', 'B');
const MOUNTAIN: CardDefinition = { ...land('Mountain', 'R'), subtypes: ['mountain'] };
const BEAR: CardDefinition = { id: 'bear', name: 'Bear', types: ['creature'], power: 2, toughness: 2, cost: { generic: 1, G: 1 } };
const WHITE_KNIGHT: CardDefinition = { id: 'white-knight', name: 'White Knight', types: ['creature'], power: 2, toughness: 2, cost: { W: 2 } };

function instance(def: CardDefinition, player: PlayerId, zone: CardInstance['zone']): CardInstance {
  return {
    instanceId: syntheticId++,
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

function act(state: GameState, action: GameAction, reg: Registry): GameState {
  const result = applyAction(state, action, DEFAULT_RULES, reg);
  const rejected = result.events.find((e) => e.type === 'actionRejected');
  if (rejected) throw new Error(`unexpected rejection: ${(rejected as { reason: string }).reason}\n${dumpState(state)}`);
  return result.state;
}

function pass(state: GameState, reg: Registry): GameState {
  return act(state, { kind: 'passPriority', player: state.priorityPlayer }, reg);
}

/** Pass until `done` holds; a parked question or a finished game fails loudly. */
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

/** A's main phase on turn 1, empty hands. */
function gameAtMain(reg: Registry): GameState {
  const { state: created } = createGame({
    seed: SEED,
    startingPlayer: 'A',
    registry: reg,
    decks: {
      A: { cards: Array.from({ length: DECK_SIZE }, () => SWAMP) },
      B: { cards: Array.from({ length: DECK_SIZE }, () => SWAMP) },
    },
  });
  const state = until(created, reg, (s) => s.step === 'precombatMain');
  state.players.A.hand = [];
  state.players.B.hand = [];
  return state;
}

function fund(state: GameState, player: PlayerId, pool: Partial<Record<'W' | 'U' | 'B' | 'R' | 'G' | 'C', number>>): void {
  state.players[player].manaPool = { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0, ...pool };
}

function inGraveyard(state: GameState, def: CardDefinition, player: PlayerId = 'A'): CardInstance {
  const card = instance(def, player, 'graveyard');
  state.players[player].graveyard.push(card);
  return card;
}
function onBattlefield(state: GameState, def: CardDefinition, player: PlayerId = 'A'): CardInstance {
  const card = instance(def, player, 'battlefield');
  state.battlefield.push(card);
  return card;
}
function inHand(state: GameState, def: CardDefinition, player: PlayerId = 'A'): CardInstance {
  const card = instance(def, player, 'hand');
  state.players[player].hand.push(card);
  return card;
}

const graveyardActivations = (state: GameState) =>
  generateLegalActions(state).filter((a): a is Extract<GameAction, { kind: 'activateGraveyardAbility' }> => a.kind === 'activateGraveyardAbility');
const graveyardCasts = (state: GameState) =>
  generateLegalActions(state).filter((a): a is Extract<GameAction, { kind: 'castSpell' }> => a.kind === 'castSpell' && a.fromZone === 'graveyard');
const where = (state: GameState, id: number): string => {
  if (state.battlefield.some((c) => c.instanceId === id)) return 'battlefield';
  for (const player of ['A', 'B'] as const) {
    for (const zone of ['graveyard', 'exile', 'hand', 'library'] as const) {
      if (state.players[player][zone].some((c) => c.instanceId === id)) return `${player}:${zone}`;
    }
  }
  if (state.stack.some((o) => o.kind === 'spell' && o.instanceId === id)) return 'stack';
  return 'nowhere';
};
/** Activate the one offered graveyard ability (optionally the one aimed at `target`) and let it resolve. */
function activateAndResolve(state: GameState, reg: Registry, target?: number): GameState {
  const offered = graveyardActivations(state).filter((a) => target === undefined || a.targets?.[0] === target);
  expect(offered, `expected exactly one graveyard activation\n${dumpState(state)}`).toHaveLength(1);
  let s = act(state, offered[0] as GameAction, reg);
  s = pass(s, reg);
  s = pass(s, reg);
  return s;
}

describe('UNEARTH, played (CR 702.84a, 702.84c)', () => {
  it('Dregscape Zombie returns from the graveyard with haste for {B}, and is exiled at the beginning of the next end step', () => {
    const reg = buildRegistry();
    let state = gameAtMain(reg);
    const zombie = inGraveyard(state, complete(DREGSCAPE_ZOMBIE));
    expect(graveyardActivations(state)).toHaveLength(0);
    fund(state, 'A', { B: 1 });
    state = activateAndResolve(state, reg);
    const body = state.battlefield.find((c) => c.instanceId === zombie.instanceId);
    expect(body).toBeDefined();
    expect(body?.summoningSick).toBe(false);
    expect(body?.exileIfLeaves).toBe(true);
    // The pilot can see the doom: the delayed ability declares its removal.
    expect(delayedRemovalTargets(state).has(zombie.instanceId)).toBe(true);
    state = until(state, reg, (s) => s.step === 'end');
    state = until(state, reg, (s) => where(s, zombie.instanceId) !== 'battlefield');
    expect(where(state, zombie.instanceId)).toBe('A:exile');
  });

  it('an unearthed Dregscape Zombie that dies is exiled instead of going to the graveyard, so it cannot be unearthed again', () => {
    const reg = buildRegistry();
    let state = gameAtMain(reg);
    const zombie = inGraveyard(state, complete(DREGSCAPE_ZOMBIE));
    fund(state, 'A', { B: 1 });
    state = activateAndResolve(state, reg);
    const body = state.battlefield.find((c) => c.instanceId === zombie.instanceId) as CardInstance;
    body.damageMarked = 1;
    state = pass(state, reg);
    expect(where(state, zombie.instanceId)).toBe('A:exile');
  });
});

describe('SCAVENGE, EMBALM, ETERNALIZE and ENCORE, played (CR 702.96a, 702.128a, 702.129a, 702.141a)', () => {
  it('Deadbridge Goliath is exiled as the cost, and its five +1/+1 counters land on the targeted creature', () => {
    const reg = buildRegistry();
    let state = gameAtMain(reg);
    const bear = onBattlefield(state, BEAR);
    const goliath = inGraveyard(state, complete(DEADBRIDGE_GOLIATH));
    fund(state, 'A', { G: 2, C: 4 });
    const offered = graveyardActivations(state);
    expect(offered.map((a) => a.targets)).toEqual([[bear.instanceId]]);
    state = act(state, offered[0] as GameAction, reg);
    expect(where(state, goliath.instanceId)).toBe('A:exile');
    state = pass(pass(state, reg), reg);
    expect(state.battlefield.find((c) => c.instanceId === bear.instanceId)?.counters['+1/+1']).toBe(5);
  });

  it('Sacred Cat’s embalm makes a WHITE Zombie Cat token with no mana cost that still has lifelink; Proven Combatant’s eternalize makes a 4/4 BLACK one', () => {
    const reg = buildRegistry();
    let state = gameAtMain(reg);
    const cat = inGraveyard(state, complete(SACRED_CAT));
    fund(state, 'A', { W: 1 });
    state = activateAndResolve(state, reg);
    expect(where(state, cat.instanceId)).toBe('A:exile');
    const token = state.battlefield.find((c) => c.def.name === 'Sacred Cat') as CardInstance;
    expect(token.def.isToken).toBe(true);
    expect(token.def.colors).toEqual(['W']);
    expect(token.def.subtypes).toEqual(expect.arrayContaining(['cat', 'zombie']));
    expect(token.def.cost).toBeUndefined();
    expect(token.def.noManaCost).toBe(true);
    expect(token.def.keywords?.lifelink).toBe(true);
    expect([token.def.power, token.def.toughness]).toEqual([1, 1]);

    inGraveyard(state, complete(PROVEN_COMBATANT));
    fund(state, 'A', { U: 2, C: 4 });
    state = activateAndResolve(state, reg);
    const eternal = state.battlefield.find((c) => c.def.name === 'Proven Combatant') as CardInstance;
    expect(eternal.def.isToken).toBe(true);
    expect(eternal.def.colors).toEqual(['B']);
    expect([eternal.def.power, eternal.def.toughness]).toEqual([4, 4]);
    expect(eternal.def.subtypes).toEqual(expect.arrayContaining(['human', 'warrior', 'zombie']));
  });

  it('Exquisite Huntmaster’s encore makes ONE token copy (one opponent), doomed at the next end step — and the copy’s own dies trigger fires when it goes', () => {
    const reg = buildRegistry();
    let state = gameAtMain(reg);
    const huntmaster = inGraveyard(state, complete(EXQUISITE_HUNTMASTER));
    fund(state, 'A', { B: 1, C: 4 });
    state = activateAndResolve(state, reg);
    expect(where(state, huntmaster.instanceId)).toBe('A:exile');
    const tokens = state.battlefield.filter((c) => c.def.name === 'Exquisite Huntmaster');
    expect(tokens).toHaveLength(1);
    const token = tokens[0] as CardInstance;
    expect(token.def.isToken).toBe(true);
    expect(delayedRemovalTargets(state).has(token.instanceId)).toBe(true);
    state = until(state, reg, (s) => s.step === 'end');
    state = until(state, reg, (s) => !s.battlefield.some((c) => c.instanceId === token.instanceId));
    // Sacrificed, and the copy carried the printed dies-trigger with it.
    state = until(state, reg, (s) => s.stack.length === 0);
    expect(state.battlefield.some((c) => c.def.name === 'Elf Warrior')).toBe(true);
  });

  it('Sanitarium Skeleton returns itself to hand for {2}{B} at instant speed', () => {
    const reg = buildRegistry();
    let state = gameAtMain(reg);
    const skeleton = inGraveyard(state, complete(SANITARIUM_SKELETON));
    state = until(state, reg, (s) => s.activePlayer === 'B' && s.priorityPlayer === 'A');
    fund(state, 'A', { B: 1, C: 2 });
    state = activateAndResolve(state, reg);
    expect(where(state, skeleton.instanceId)).toBe('A:hand');
  });
});

describe('RETRACE, JUMP-START and ESCAPE, played (CR 702.81a, 702.133a, 702.138a)', () => {
  it('Flame Jab is retraced for {R} plus a land from hand, hits for 1, and is back in the graveyard for the next land', () => {
    const reg = buildRegistry();
    let state = gameAtMain(reg);
    const jab = inGraveyard(state, complete(FLAME_JAB));
    fund(state, 'A', { R: 1 });
    expect(graveyardCasts(state)).toHaveLength(0);
    const swamp = inHand(state, SWAMP);
    // "Any target" is the unrestricted default: the offer carries no target and
    // the caster names one, exactly as a hand cast of the same spell does.
    const offered = graveyardCasts(state);
    expect(offered).toEqual([{ kind: 'castSpell', player: 'A', instanceId: jab.instanceId, fromZone: 'graveyard', graveyardCast: 'retrace' }]);
    state = act(state, { ...(offered[0] as GameAction), targets: ['B'] } as GameAction, reg);
    expect(where(state, swamp.instanceId)).toBe('A:graveyard');
    state = pass(pass(state, reg), reg);
    expect(state.players.B.life).toBe(19);
    expect(where(state, jab.instanceId)).toBe('A:graveyard');
  });

  it('Direct Current is jump-started for {1}{R}{R} plus a discard, hits for 2, and is exiled', () => {
    const reg = buildRegistry();
    let state = gameAtMain(reg);
    const current = inGraveyard(state, complete(DIRECT_CURRENT));
    const bearInHand = inHand(state, BEAR);
    fund(state, 'A', { R: 2, C: 1 });
    const offered = graveyardCasts(state);
    expect(offered).toMatchObject([{ graveyardCast: 'jumpStart' }]);
    state = act(state, { ...(offered[0] as GameAction), targets: ['B'] } as GameAction, reg);
    expect(where(state, bearInHand.instanceId)).toBe('A:graveyard');
    state = pass(pass(state, reg), reg);
    expect(state.players.B.life).toBe(18);
    expect(where(state, current.instanceId)).toBe('A:exile');
  });

  it('Glimpse of Freedom escapes for {2}{U} plus five other exiled graveyard cards, draws, and is NOT exiled', () => {
    const reg = buildRegistry();
    let state = gameAtMain(reg);
    const glimpse = inGraveyard(state, complete(GLIMPSE_OF_FREEDOM));
    const fuel = Array.from({ length: 5 }, () => inGraveyard(state, SWAMP));
    fund(state, 'A', { U: 1, C: 2 });
    const handBefore = state.players.A.hand.length;
    const escape = graveyardCasts(state);
    expect(escape).toHaveLength(1);
    expect(escape[0]).toMatchObject({ graveyardCast: 'escape' });
    state = act(state, escape[0] as GameAction, reg);
    for (const card of fuel) expect(where(state, card.instanceId)).toBe('A:exile');
    state = pass(pass(state, reg), reg);
    expect(state.players.A.hand.length).toBe(handBefore + 1);
    expect(where(state, glimpse.instanceId)).toBe('A:graveyard');
  });
});

describe('FLASHBACK with a non-mana cost, played (CR 702.34a)', () => {
  it('Dread Return is flashed back by sacrificing three creatures and no mana, reanimates its target, and is exiled', () => {
    const reg = buildRegistry();
    let state = gameAtMain(reg);
    const dread = inGraveyard(state, complete(DREAD_RETURN));
    const dead = inGraveyard(state, BEAR);
    const bears = [onBattlefield(state, BEAR), onBattlefield(state, BEAR)];
    expect(graveyardCasts(state)).toHaveLength(0);
    bears.push(onBattlefield(state, BEAR));
    const offered = graveyardCasts(state);
    expect(offered).toHaveLength(1);
    expect(offered[0]?.targets).toEqual([dead.instanceId]);
    state = act(state, offered[0] as GameAction, reg);
    for (const bear of bears) expect(where(state, bear.instanceId)).toBe('A:graveyard');
    state = pass(pass(state, reg), reg);
    expect(where(state, dead.instanceId)).toBe('battlefield');
    expect(where(state, dread.instanceId)).toBe('A:exile');
  });

  it('Battle Screech is flashed back by tapping three untapped WHITE creatures, and makes its Birds', () => {
    const reg = buildRegistry();
    let state = gameAtMain(reg);
    const screech = inGraveyard(state, complete(BATTLE_SCREECH));
    onBattlefield(state, BEAR);
    onBattlefield(state, BEAR);
    onBattlefield(state, BEAR);
    // Three creatures, none white: not offered.
    expect(graveyardCasts(state)).toHaveLength(0);
    const knights = [onBattlefield(state, WHITE_KNIGHT), onBattlefield(state, WHITE_KNIGHT), onBattlefield(state, WHITE_KNIGHT)];
    state = act(state, graveyardCasts(state)[0] as GameAction, reg);
    for (const knight of knights) expect(state.battlefield.find((c) => c.instanceId === knight.instanceId)?.tapped).toBe(true);
    state = pass(pass(state, reg), reg);
    expect(state.battlefield.filter((c) => c.def.name === 'Bird')).toHaveLength(2);
    expect(where(state, screech.instanceId)).toBe('A:exile');
  });

  it('Lava Dart is flashed back by sacrificing a Mountain — a Swamp does not qualify', () => {
    const reg = buildRegistry();
    let state = gameAtMain(reg);
    const dart = inGraveyard(state, complete(LAVA_DART));
    onBattlefield(state, SWAMP);
    expect(graveyardCasts(state)).toHaveLength(0);
    const mountain = onBattlefield(state, MOUNTAIN);
    const offered = graveyardCasts(state);
    expect(offered).toHaveLength(1);
    state = act(state, { ...(offered[0] as GameAction), targets: ['B'] } as GameAction, reg);
    expect(where(state, mountain.instanceId)).toBe('A:graveyard');
    state = pass(pass(state, reg), reg);
    expect(state.players.B.life).toBe(19);
    expect(where(state, dart.instanceId)).toBe('A:exile');
  });
});

describe('the graveyard-return templates, played', () => {
  it('Rancor comes back to hand when its host dies and it is put into the graveyard from the battlefield', () => {
    const reg = buildRegistry();
    let state = gameAtMain(reg);
    const bear = onBattlefield(state, BEAR);
    const rancor = inHand(state, complete(RANCOR));
    fund(state, 'A', { G: 1 });
    state = act(state, { kind: 'castSpell', player: 'A', instanceId: rancor.instanceId, targets: [bear.instanceId] }, reg);
    state = pass(pass(state, reg), reg);
    expect(where(state, rancor.instanceId)).toBe('battlefield');
    const host = state.battlefield.find((c) => c.instanceId === bear.instanceId) as CardInstance;
    host.damageMarked = 2;
    state = pass(state, reg);
    state = until(state, reg, (s) => s.stack.length === 0 && where(s, rancor.instanceId) !== 'A:graveyard');
    expect(where(state, rancor.instanceId)).toBe('A:hand');
  });

  it('Mortus Strider returns to its owner’s hand when it dies', () => {
    const reg = buildRegistry();
    let state = gameAtMain(reg);
    const strider = onBattlefield(state, complete(MORTUS_STRIDER));
    strider.damageMarked = 1;
    state = pass(state, reg);
    state = until(state, reg, (s) => s.stack.length === 0 && where(s, strider.instanceId) !== 'A:graveyard');
    expect(where(state, strider.instanceId)).toBe('A:hand');
  });
});

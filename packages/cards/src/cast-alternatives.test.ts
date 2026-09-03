/**
 * THE CAST-ALTERNATIVE FAMILY (DESIGN §3.112) at the cards level: the compiler's
 * rules for evoke, dash, blitz, surge, prototype, warp, foretell, plot, entwine,
 * channel, bloodrush and transmute, their refusals (the compiler never
 * approximates), and every keyword played END TO END through the real engine
 * with this package's primitives on the REAL PRINTED CARDS — Mulldrifter
 * evoked draws two and dies, Kolaghan Skirmisher dashed comes home at end of
 * turn, Knight Luminary warped is castable again from exile next turn.
 */

import { describe, expect, it } from 'vitest';
import type { CardDefinition, CardInstance, ChoiceAnswer, GameAction, GameState, PlayerId } from '@jonny-boi/core';
import { applyAction, castPermissionFor, createGame, DEFAULT_RULES, dumpState, effectivePower, generateLegalActions } from '@jonny-boi/core';
import { compileCard } from './compile/compile.js';
import type { CompilableCard } from './compile/types.js';
import { buildRegistry } from './pool.js';
import { CORE_PRIMITIVE_IDS } from './primitives.js';

type Registry = ReturnType<typeof buildRegistry>;

// --- the printed cards, exactly as Scryfall prints them --------------------------

type Cost = CompilableCard['manaCost'];
const cost = (parts: Partial<Cost>): Cost => ({ generic: 0, W: 0, U: 0, B: 0, R: 0, G: 0, C: 0, other: [], ...parts });
const creature = (subtypes: string[], extra: string[] = []): CompilableCard['typeLine'] => ({
  supertypes: [],
  types: [...extra, 'Creature'],
  subtypes,
});
const spell = (type: 'Instant' | 'Sorcery', subtypes: string[] = []): CompilableCard['typeLine'] => ({
  supertypes: [],
  types: [type],
  subtypes,
});

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
    manaCost: manaCost ?? { ...cost({}), absent: true },
    typeLine,
    power: null,
    toughness: null,
    keywords: [],
    oracleText,
    ...extra,
  };
}

const MULLDRIFTER = printed(
  'Mulldrifter',
  "Flying\nWhen this creature enters, draw two cards.\nEvoke {2}{U} (You may cast this spell for its evoke cost. If you do, it's sacrificed when it enters.)",
  creature(['Elemental']),
  cost({ generic: 4, U: 1 }),
  { power: 2, toughness: 2, keywords: ['Flying', 'Evoke'] },
);

const KOLAGHAN_SKIRMISHER = printed(
  'Kolaghan Skirmisher',
  "Dash {2}{B} (You may cast this spell for its dash cost. If you do, it gains haste, and it's returned from the battlefield to its owner's hand at the beginning of the next end step.)",
  creature(['Human', 'Warrior']),
  cost({ generic: 1, B: 1 }),
  { power: 2, toughness: 2, keywords: ['Dash'] },
);

const RIVETEERS_DECOY = printed(
  'Riveteers Decoy',
  'This creature must be blocked if able.\nBlitz {3}{G} (If you cast this spell for its blitz cost, it gains haste and "When this creature dies, draw a card." Sacrifice it at the beginning of the next end step.)',
  creature(['Human', 'Warrior']),
  cost({ generic: 1, G: 1 }),
  { power: 3, toughness: 1, keywords: ['Blitz'] },
);

const BOULDER_SALVO = printed(
  'Boulder Salvo',
  'Surge {1}{R} (You may cast this spell for its surge cost if you or a teammate has cast another spell this turn.)\nBoulder Salvo deals 4 damage to target creature.',
  spell('Sorcery'),
  cost({ generic: 4, R: 1 }),
  { keywords: ['Surge'] },
);

const GORING_WARPLOW = printed(
  'Goring Warplow',
  'Prototype {1}{B} — 1/1 (You may cast this spell with different mana cost, color, and size. It keeps its abilities and types.)\nDeathtouch',
  creature(['Construct'], ['Artifact']),
  cost({ generic: 6 }),
  { power: 5, toughness: 4, keywords: ['Prototype', 'Deathtouch'] },
);

const KNIGHT_LUMINARY = printed(
  'Knight Luminary',
  'When this creature enters, create a 1/1 white Human Soldier creature token.\nWarp {1}{W} (You may cast this card from your hand for its warp cost. Exile this creature at the beginning of the next end step, then you may cast it from exile on a later turn.)',
  creature(['Human', 'Knight']),
  cost({ generic: 3, W: 1 }),
  { power: 3, toughness: 2, keywords: ['Warp'] },
);

const KAYAS_ONSLAUGHT = printed(
  "Kaya's Onslaught",
  'Target creature gets +1/+1 and gains double strike until end of turn.\nForetell {W} (During your turn, you may pay {2} and exile this card from your hand face down. Cast it on a later turn for its foretell cost.)',
  spell('Instant'),
  cost({ generic: 2, W: 1 }),
  { keywords: ['Foretell'] },
);

const BEASTBOND_OUTCASTER = printed(
  'Beastbond Outcaster',
  'When this creature enters, if you control a creature with power 4 or greater, draw a card.\nPlot {1}{G} (You may pay {1}{G} and exile this card from your hand. Cast it as a sorcery on a later turn without paying its mana cost. Plot only as a sorcery.)',
  creature(['Human', 'Druid']),
  cost({ generic: 2, G: 1 }),
  { power: 3, toughness: 3, keywords: ['Plot'] },
);

const ONE_DOZEN_EYES = printed(
  'One Dozen Eyes',
  'Choose one —\n• Create a 5/5 green Beast creature token.\n• Create five 1/1 green Insect creature tokens.\nEntwine {G}{G}{G} (Choose both if you pay the entwine cost.)',
  spell('Sorcery'),
  cost({ generic: 5, G: 1 }),
  { keywords: ['Entwine', 'Modal'] },
);

const GHOST_LIT_RAIDER = printed(
  'Ghost-Lit Raider',
  '{2}{R}, {T}: This creature deals 2 damage to target creature.\nChannel — {3}{R}, Discard this card: It deals 4 damage to target creature.',
  creature(['Spirit']),
  cost({ generic: 2, R: 1 }),
  { power: 2, toughness: 1, keywords: ['Channel'] },
);

const RUBBLEBELT_MAAKA = printed(
  'Rubblebelt Maaka',
  'Bloodrush — {R}, Discard this card: Target attacking creature gets +3/+3 until end of turn.',
  creature(['Cat']),
  cost({ generic: 3, R: 1 }),
  { power: 3, toughness: 3, keywords: ['Bloodrush'] },
);

const DIZZY_SPELL = printed(
  'Dizzy Spell',
  'Target creature gets -3/-0 until end of turn.\nTransmute {1}{U}{U} ({1}{U}{U}, Discard this card: Search your library for a card with the same mana value as this card, reveal it, put it into your hand, then shuffle. Transmute only as a sorcery.)',
  spell('Instant'),
  cost({ U: 1 }),
  { keywords: ['Transmute'] },
);

const GRIZZLY_BEARS = printed('Grizzly Bears', '', creature(['Bear']), cost({ generic: 1, G: 1 }), { power: 2, toughness: 2 });

// The honest refusals — a cost outside the closed mana table.
const GRIEF = printed(
  'Grief',
  'Menace\nWhen this creature enters, target opponent reveals their hand. You choose a nonland card from it. That player discards that card.\nEvoke—Exile a black card from your hand.',
  creature(['Elemental', 'Incarnation']),
  cost({ generic: 2, B: 2 }),
  { power: 3, toughness: 2, keywords: ['Menace', 'Evoke'] },
);
const TIMELINE_CULLER = printed(
  'Timeline Culler',
  'Haste\nYou may cast this card from your graveyard using its warp ability.\nWarp—{B}, Pay 2 life. (You may cast this card from your hand or graveyard for its warp cost. If you do, exile this creature at the beginning of the next end step, then you may cast it from exile on a later turn.)',
  creature(['Drix', 'Warlock']),
  cost({ B: 2 }),
  { power: 3, toughness: 2, keywords: ['Haste', 'Warp'] },
);
const BETRAYAL_OF_FLESH = printed(
  'Betrayal of Flesh',
  'Choose one —\n• Destroy target creature.\n• Return target creature card from your graveyard to the battlefield.\nEntwine—Sacrifice three lands. (Choose both if you pay the entwine cost.)',
  spell('Instant'),
  cost({ generic: 5, B: 1 }),
  { keywords: ['Entwine', 'Modal'] },
);

function complete(card: CompilableCard): CardDefinition {
  const result = compileCard(card);
  expect(result.status, `${card.name}: ${JSON.stringify(result.missing)}`).toBe('complete');
  return result.definition;
}

// --- the compiler half ------------------------------------------------------------

describe('the printed lines compile, and every rider body is a registered primitive', () => {
  it('registers the family’s primitives', () => {
    for (const id of ['sacrificeSelfIfCastWith', 'returnSelfToHand', 'warpExile']) {
      expect(CORE_PRIMITIVE_IDS, id).toContain(id);
    }
  });

  it('Mulldrifter: an evoke cost with an ETB sacrifice rider that names the stamp', () => {
    const def = complete(MULLDRIFTER);
    expect(def.alternativeCosts?.evoke?.cost).toEqual({ generic: 2, U: 1 });
    expect(def.alternativeCosts?.evoke?.riders?.[0]).toMatchObject({
      condition: { on: 'etb' },
      effects: [{ primitive: 'sacrificeSelfIfCastWith', params: { castWith: 'evoke' } }],
      removesFromBattlefield: true,
    });
    // The keyword sweep must not report "Evoke" a second time.
    expect(compileCard(MULLDRIFTER).missing).toEqual([]);
  });

  it('dash, blitz, surge, warp and prototype each compile to their kind', () => {
    expect(complete(KOLAGHAN_SKIRMISHER).alternativeCosts?.dash?.riders?.[0]?.effects).toEqual([{ primitive: 'returnSelfToHand' }]);
    const blitz = complete(RIVETEERS_DECOY).alternativeCosts?.blitz;
    expect(blitz?.cost).toEqual({ generic: 3, G: 1 });
    expect(blitz?.riders?.map((r) => r.condition.on)).toEqual(['endStep', 'dies']);
    expect(complete(BOULDER_SALVO).alternativeCosts?.surge?.cost).toEqual({ generic: 1, R: 1 });
    expect(complete(KNIGHT_LUMINARY).alternativeCosts?.warp?.riders?.[0]?.effects).toEqual([{ primitive: 'warpExile' }]);
    expect(complete(GORING_WARPLOW).alternativeCosts?.prototype).toEqual({ cost: { generic: 1, B: 1 }, face: { power: 1, toughness: 1 } });
  });

  it('foretell, plot and entwine compile to their cost fields', () => {
    expect(complete(KAYAS_ONSLAUGHT).foretell).toEqual({ W: 1 });
    expect(complete(BEASTBOND_OUTCASTER).plot).toEqual({ generic: 1, G: 1 });
    const eyes = complete(ONE_DOZEN_EYES);
    expect(eyes.entwine).toEqual({ G: 3 });
    expect(eyes.modal?.modes).toHaveLength(2);
  });

  it('channel, bloodrush and transmute compile beside cycling, tagged with their kind', () => {
    const raider = complete(GHOST_LIT_RAIDER);
    expect(raider.activated).toHaveLength(1);
    expect(raider.cycling?.[0]).toMatchObject({ cost: { generic: 3, R: 1 }, kind: 'channel' });
    const maaka = complete(RUBBLEBELT_MAAKA);
    expect(maaka.cycling?.[0]).toMatchObject({ cost: { R: 1 }, kind: 'bloodrush' });
    const dizzy = complete(DIZZY_SPELL);
    expect(dizzy.cycling?.[0]).toMatchObject({
      cost: { generic: 1, U: 2 },
      kind: 'transmute',
      timing: 'sorcery',
      effects: [{ primitive: 'searchLibrary', params: { who: 'controller', count: 1, destination: 'hand', filter: { minManaValue: 1, maxManaValue: 1 } } }],
    });
  });

  it('REFUSES the cost forms outside the closed table, and says which line', () => {
    for (const [card, word] of [
      [GRIEF, 'Evoke'],
      [TIMELINE_CULLER, 'Warp'],
      [BETRAYAL_OF_FLESH, 'Entwine'],
    ] as const) {
      const result = compileCard(card);
      expect(result.status, card.name).toBe('incomplete');
      expect(result.missing.some((m) => m.text.includes(word)), `${card.name} reports its ${word} line`).toBe(true);
      expect(result.definition.alternativeCosts, card.name).toBeUndefined();
      expect(result.definition.entwine, card.name).toBeUndefined();
    }
  });
});

// --- the engine half: every keyword, end to end, on the real card ------------------

const SEED = 0x3112;
const DECK_SIZE = 40;
let syntheticId = 91_000;

function land(id: string, color: 'W' | 'U' | 'B' | 'R' | 'G'): CardDefinition {
  return { id, name: id, types: ['land'], produces: [color] };
}
const FOREST = land('Forest', 'G');

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

function rejection(state: GameState, action: GameAction, reg: Registry): string | undefined {
  const rejected = applyAction(state, action, DEFAULT_RULES, reg).events.find((e) => e.type === 'actionRejected');
  return rejected ? (rejected as { reason: string }).reason : undefined;
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
    decks: {
      A: { cards: Array.from({ length: DECK_SIZE }, () => FOREST) },
      B: { cards: Array.from({ length: DECK_SIZE }, () => FOREST) },
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

function inHand(state: GameState, player: PlayerId, def: CardDefinition): CardInstance {
  const card = instance(def, player, 'hand');
  state.players[player].hand.push(card);
  return card;
}

function onField(state: GameState, player: PlayerId, def: CardDefinition): CardInstance {
  const card = instance(def, player, 'battlefield');
  state.battlefield.push(card);
  return card;
}

function answer(state: GameState, reg: Registry, value: ChoiceAnswer): GameState {
  const choice = state.pendingChoice;
  if (!choice) throw new Error(`no choice pending:\n${dumpState(state)}`);
  return act(state, { kind: 'answerChoice', player: choice.chooser, choiceId: choice.id, answer: value }, reg);
}

const settled = (s: GameState) => s.stack.length === 0 && !s.pendingChoice;
const has = (zone: readonly CardInstance[], id: number) => zone.some((c) => c.instanceId === id);

describe('evoke (CR 702.74a) — Mulldrifter', () => {
  it('evoked for {2}{U}: draws two cards and is sacrificed as it enters', () => {
    const reg = buildRegistry();
    const state = gameAtMain(reg);
    const drifter = inHand(state, 'A', complete(MULLDRIFTER));
    fund(state, 'A', { U: 1, C: 2 });
    const before = state.players.A.hand.length;
    let s = act(state, { kind: 'castSpell', player: 'A', instanceId: drifter.instanceId, alternative: 'evoke' }, reg);
    s = until(s, reg, settled);
    expect(s.players.A.hand.length).toBe(before - 1 + 2);
    expect(has(s.players.A.graveyard, drifter.instanceId)).toBe(true);
    expect(has(s.battlefield, drifter.instanceId)).toBe(false);
  });
});

describe('dash (CR 702.109a) — Kolaghan Skirmisher', () => {
  it('dashed for {2}{B}: attacks the turn it enters, then comes home at the end step', () => {
    const reg = buildRegistry();
    const state = gameAtMain(reg);
    const skirmisher = inHand(state, 'A', complete(KOLAGHAN_SKIRMISHER));
    fund(state, 'A', { B: 1, C: 2 });
    let s = act(state, { kind: 'castSpell', player: 'A', instanceId: skirmisher.instanceId, alternative: 'dash' }, reg);
    s = until(s, reg, (x) => has(x.battlefield, skirmisher.instanceId));
    expect(s.battlefield.find((c) => c.instanceId === skirmisher.instanceId)?.summoningSick).toBe(false);
    s = until(s, reg, (x) => x.step === 'declareAttackers' && x.priorityPlayer === 'A');
    s = act(s, { kind: 'declareAttackers', player: 'A', attackers: [skirmisher.instanceId] }, reg);
    s = until(s, reg, (x) => x.step === 'end' && settled(x));
    expect(s.players.B.life).toBe(18);
    expect(has(s.players.A.hand, skirmisher.instanceId)).toBe(true);
  });
});

describe('blitz (CR 702.152a) — Riveteers Decoy', () => {
  it('blitzed for {3}{G}: sacrificed at the end step, and its death draws a card', () => {
    const reg = buildRegistry();
    const state = gameAtMain(reg);
    const decoy = inHand(state, 'A', complete(RIVETEERS_DECOY));
    fund(state, 'A', { G: 1, C: 3 });
    let s = act(state, { kind: 'castSpell', player: 'A', instanceId: decoy.instanceId, alternative: 'blitz' }, reg);
    s = until(s, reg, (x) => has(x.battlefield, decoy.instanceId));
    expect(s.battlefield.find((c) => c.instanceId === decoy.instanceId)?.summoningSick).toBe(false);
    const handBefore = s.players.A.hand.length;
    s = until(s, reg, (x) => x.step === 'end' && settled(x));
    expect(has(s.players.A.graveyard, decoy.instanceId)).toBe(true);
    expect(s.players.A.hand.length).toBe(handBefore + 1);
  });
});

describe('surge (CR 702.117a) — Boulder Salvo', () => {
  it('for {1}{R} after another spell this turn, deals 4 to the target creature', () => {
    const reg = buildRegistry();
    const state = gameAtMain(reg);
    const salvo = inHand(state, 'A', complete(BOULDER_SALVO));
    const bears = inHand(state, 'A', complete(GRIZZLY_BEARS));
    const victim = onField(state, 'B', complete(GRIZZLY_BEARS));
    fund(state, 'A', { R: 1, G: 1, C: 2 });
    expect(rejection(state, { kind: 'castSpell', player: 'A', instanceId: salvo.instanceId, targets: [victim.instanceId], alternative: 'surge' }, reg)).toContain('another spell');
    let s = act(state, { kind: 'castSpell', player: 'A', instanceId: bears.instanceId }, reg);
    s = until(s, reg, settled);
    s = act(s, { kind: 'castSpell', player: 'A', instanceId: salvo.instanceId, targets: [victim.instanceId], alternative: 'surge' }, reg);
    s = until(s, reg, settled);
    expect(has(s.players.B.graveyard, victim.instanceId)).toBe(true);
    expect(s.players.A.manaPool.C).toBe(0);
  });
});

describe('prototype (CR 702.160a) — Goring Warplow', () => {
  it('prototyped for {1}{B}: a black 1/1 deathtouch artifact creature', () => {
    const reg = buildRegistry();
    const state = gameAtMain(reg);
    const warplow = inHand(state, 'A', complete(GORING_WARPLOW));
    fund(state, 'A', { B: 1, C: 1 });
    let s = act(state, { kind: 'castSpell', player: 'A', instanceId: warplow.instanceId, alternative: 'prototype' }, reg);
    s = until(s, reg, (x) => has(x.battlefield, warplow.instanceId));
    const perm = s.battlefield.find((c) => c.instanceId === warplow.instanceId)!;
    expect(effectivePower(perm)).toBe(1);
    expect(perm.def.keywords?.deathtouch).toBe(true);
    expect(perm.def.types).toContain('artifact');
  });
});

describe('warp (CR 702.185a) — Knight Luminary', () => {
  it('warped for {1}{W}: makes its token, is exiled at the end step, and is castable from exile next turn for {3}{W}', () => {
    const reg = buildRegistry();
    const state = gameAtMain(reg);
    const knight = inHand(state, 'A', complete(KNIGHT_LUMINARY));
    fund(state, 'A', { W: 1, C: 1 });
    let s = act(state, { kind: 'castSpell', player: 'A', instanceId: knight.instanceId, alternative: 'warp' }, reg);
    s = until(s, reg, settled);
    expect(s.battlefield.filter((c) => c.controller === 'A' && c.def.isToken === true)).toHaveLength(1);
    s = until(s, reg, (x) => x.step === 'end' && settled(x));
    const exiled = s.players.A.exile.find((c) => c.instanceId === knight.instanceId)!;
    expect(exiled).toBeDefined();
    expect(exiled.faceDown).toBeUndefined();
    // "After the current turn has ended" — not tonight.
    expect(castPermissionFor(s, exiled)).toBeUndefined();
    s = until(s, reg, (x) => x.turnNumber === 3 && x.step === 'precombatMain' && x.priorityPlayer === 'A');
    expect(castPermissionFor(s, exiled)).toMatchObject({ face: 'front', free: false });
    fund(s, 'A', { W: 1, C: 3 });
    const offer = generateLegalActions(s).find((a) => a.kind === 'castSpell' && a.instanceId === knight.instanceId);
    expect(offer).toMatchObject({ fromZone: 'exile' });
    s = act(s, offer as GameAction, reg);
    s = until(s, reg, settled);
    expect(has(s.battlefield, knight.instanceId)).toBe(true);
    expect(s.battlefield.filter((c) => c.controller === 'A' && c.def.isToken === true)).toHaveLength(2);
    expect(s.players.A.manaPool.C).toBe(0);
  });
});

describe("foretell (CR 702.143a) — Kaya's Onslaught", () => {
  it('foretold for {2} on your turn, cast from exile next turn for {W}', () => {
    const reg = buildRegistry();
    const state = gameAtMain(reg);
    const onslaught = inHand(state, 'A', complete(KAYAS_ONSLAUGHT));
    const bears = onField(state, 'A', complete(GRIZZLY_BEARS));
    fund(state, 'A', { C: 2 });
    let s = act(state, { kind: 'foretellCard', player: 'A', instanceId: onslaught.instanceId }, reg);
    expect(s.players.A.exile.find((c) => c.instanceId === onslaught.instanceId)?.faceDown).toBe(true);
    s = until(s, reg, (x) => x.turnNumber === 2 && x.priorityPlayer === 'A' && x.step === 'precombatMain');
    fund(s, 'A', { W: 1 });
    s = act(s, { kind: 'castSpell', player: 'A', instanceId: onslaught.instanceId, fromZone: 'exile', targets: [bears.instanceId] }, reg);
    s = until(s, reg, settled);
    expect(effectivePower(s.battlefield.find((c) => c.instanceId === bears.instanceId)!)).toBe(3);
    expect(has(s.players.A.graveyard, onslaught.instanceId)).toBe(true);
  });
});

describe('plot (CR 702.170a) — Beastbond Outcaster', () => {
  it('plotted for {1}{G}, cast free as a sorcery on a later turn', () => {
    const reg = buildRegistry();
    const state = gameAtMain(reg);
    const outcaster = inHand(state, 'A', complete(BEASTBOND_OUTCASTER));
    fund(state, 'A', { G: 1, C: 1 });
    let s = act(state, { kind: 'plotCard', player: 'A', instanceId: outcaster.instanceId }, reg);
    s = until(s, reg, (x) => x.turnNumber === 3 && x.step === 'precombatMain' && x.priorityPlayer === 'A');
    fund(s, 'A', {});
    s = act(s, { kind: 'castSpell', player: 'A', instanceId: outcaster.instanceId, fromZone: 'exile' }, reg);
    s = until(s, reg, settled);
    expect(has(s.battlefield, outcaster.instanceId)).toBe(true);
  });
});

describe('entwine (CR 702.42a) — One Dozen Eyes', () => {
  it('paying {G}{G}{G} makes both the 5/5 and the five 1/1s', () => {
    const reg = buildRegistry();
    const state = gameAtMain(reg);
    const eyes = inHand(state, 'A', complete(ONE_DOZEN_EYES));
    fund(state, 'A', { G: 4, C: 5 });
    let s = act(state, { kind: 'castSpell', player: 'A', instanceId: eyes.instanceId }, reg);
    expect(s.pendingChoice?.kind).toBe('payMana');
    s = answer(s, reg, { kind: 'payMana', pay: true });
    s = until(s, reg, settled);
    const tokens = s.battlefield.filter((c) => c.controller === 'A' && c.def.isToken === true);
    expect(tokens).toHaveLength(6);
    expect(tokens.filter((t) => t.def.power === 5)).toHaveLength(1);
  });
});

describe('channel — Ghost-Lit Raider', () => {
  it('"{3}{R}, Discard this card: It deals 4 damage to target creature" from hand, at instant speed', () => {
    const reg = buildRegistry();
    const state = gameAtMain(reg);
    const raider = inHand(state, 'A', complete(GHOST_LIT_RAIDER));
    const victim = onField(state, 'B', complete(GRIZZLY_BEARS));
    fund(state, 'A', { R: 1, C: 3 });
    const offer = generateLegalActions(state).find((a) => a.kind === 'cycleCard');
    expect(offer).toMatchObject({ instanceId: raider.instanceId, targets: [victim.instanceId] });
    let s = act(state, offer as GameAction, reg);
    s = until(s, reg, settled);
    expect(has(s.players.B.graveyard, victim.instanceId)).toBe(true);
    expect(has(s.players.A.graveyard, raider.instanceId)).toBe(true);
  });
});

describe('bloodrush — Rubblebelt Maaka', () => {
  it('"{R}, Discard this card: Target attacking creature gets +3/+3" pumps an attacker and nothing else', () => {
    const reg = buildRegistry();
    const state = gameAtMain(reg);
    const maaka = inHand(state, 'A', complete(RUBBLEBELT_MAAKA));
    const bears = onField(state, 'A', complete(GRIZZLY_BEARS));
    fund(state, 'A', { R: 1 });
    // Not before an attack: no attacking creature exists.
    expect(generateLegalActions(state).some((a) => a.kind === 'cycleCard')).toBe(false);
    let s = until(state, reg, (x) => x.step === 'declareAttackers' && x.priorityPlayer === 'A');
    s = act(s, { kind: 'declareAttackers', player: 'A', attackers: [bears.instanceId] }, reg);
    fund(s, 'A', { R: 1 });
    const offer = generateLegalActions(s).find((a) => a.kind === 'cycleCard');
    expect(offer).toMatchObject({ instanceId: maaka.instanceId, targets: [bears.instanceId] });
    s = act(s, offer as GameAction, reg);
    s = until(s, reg, (x) => x.step === 'combatDamage' || x.players.B.life < 20);
    expect(s.players.B.life).toBe(15);
  });
});

describe('transmute (CR 702.53a) — Dizzy Spell', () => {
  it('"{1}{U}{U}, Discard this card: search for a card with mana value 1", as a sorcery', () => {
    const reg = buildRegistry();
    const state = gameAtMain(reg);
    const dizzy = complete(DIZZY_SPELL);
    const inHandCopy = inHand(state, 'A', dizzy);
    const inLibrary = instance(dizzy, 'A', 'library');
    state.players.A.library.unshift(inLibrary);
    fund(state, 'A', { U: 2, C: 1 });
    let s = act(state, { kind: 'cycleCard', player: 'A', instanceId: inHandCopy.instanceId, abilityIndex: 0 }, reg);
    s = until(s, reg, settled);
    expect(has(s.players.A.hand, inLibrary.instanceId)).toBe(true);
    expect(has(s.players.A.graveyard, inHandCopy.instanceId)).toBe(true);
    // Sorcery timing: refused outside a main phase.
    const later = gameAtMain(reg);
    const second = inHand(later, 'A', dizzy);
    const combat = until(later, reg, (x) => x.step === 'beginCombat' && x.priorityPlayer === 'A');
    fund(combat, 'A', { U: 2, C: 1 });
    expect(rejection(combat, { kind: 'cycleCard', player: 'A', instanceId: second.instanceId, abilityIndex: 0 }, reg)).toContain('sorcery');
  });
});

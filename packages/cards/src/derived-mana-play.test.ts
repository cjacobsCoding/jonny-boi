/**
 * THE DERIVED-AMOUNT MANA FAMILY, COMPILED FROM PRINT AND PLAYED — DESIGN §3.164.
 *
 * "And Selvala, Explorer Returned" — and Axebane Guardian, the one card that
 * kept *Tamiyo + Jace Surge* from being playable. Each is compiled here from
 * its Oracle text (the engine half is pinned in `core/mana-amount.test.ts`) and
 * the compiled ability is tapped on a real board, so what is pinned is the
 * mana in the pool, not the shape of the data.
 */
import { describe, expect, it } from 'vitest';
import type { CardDefinition, GameAction, GameState, InstanceId, PlayerId } from '@jonny-boi/core';
import { applyAction, createGame, DEFAULT_RULES } from '@jonny-boi/core';
import { compileCard } from './compile/index.js';
import type { CompilableCard } from './compile/index.js';
import { buildRegistry } from './pool.js';
import { CARD_POOL } from '../data/pool.js';

type Registry = ReturnType<typeof buildRegistry>;

function fromPool(name: string): CardDefinition {
  const found = CARD_POOL.find((entry) => entry.name === name);
  if (!found) throw new Error(`pool missing ${name}`);
  return found;
}

const NO_MANA = { generic: 0, W: 0, U: 0, B: 0, R: 0, G: 0, C: 0, other: [] } as const;

function compiled(card: {
  readonly name: string;
  readonly oracleText: string;
  readonly manaCost?: CompilableCard['manaCost'];
  readonly typeLine: CompilableCard['typeLine'];
  readonly power?: number | null;
  readonly toughness?: number | null;
  readonly keywords?: readonly string[];
}): CardDefinition {
  const result = compileCard({
    id: `test:${card.name}`,
    manaCost: NO_MANA,
    keywords: [],
    power: null,
    toughness: null,
    ...card,
  } as CompilableCard);
  expect(result.status, `${card.name}: ${JSON.stringify(result.missing)}`).toBe('complete');
  return result.definition;
}

const AXEBANE = compiled({
  name: 'Axebane Guardian',
  manaCost: { ...NO_MANA, generic: 2, G: 1 },
  typeLine: { supertypes: [], types: ['Creature'], subtypes: ['Human', 'Druid'] },
  power: 0,
  toughness: 3,
  keywords: ['Defender'],
  oracleText: 'Defender\n{T}: Add X mana in any combination of colors, where X is the number of creatures you control with defender.',
});

const CRADLE = compiled({
  name: "Gaea's Cradle",
  typeLine: { supertypes: ['Legendary'], types: ['Land'], subtypes: [] },
  oracleText: '{T}: Add {G} for each creature you control.',
});

const ACOLYTE = compiled({
  name: "Karametra's Acolyte",
  manaCost: { ...NO_MANA, generic: 3, G: 1 },
  typeLine: { supertypes: [], types: ['Creature'], subtypes: ['Human', 'Druid'] },
  power: 1,
  toughness: 4,
  oracleText: '{T}: Add an amount of {G} equal to your devotion to green.',
});

const ARCHDRUID = compiled({
  name: 'Elvish Archdruid',
  manaCost: { ...NO_MANA, generic: 1, G: 2 },
  typeLine: { supertypes: [], types: ['Creature'], subtypes: ['Elf', 'Druid'] },
  power: 2,
  toughness: 2,
  oracleText: 'Other Elf creatures you control get +1/+1.\n{T}: Add {G} for each Elf you control.',
});

const SELVALA = compiled({
  name: 'Selvala, Explorer Returned',
  manaCost: { ...NO_MANA, generic: 1, G: 1, W: 1 },
  typeLine: { supertypes: ['Legendary'], types: ['Creature'], subtypes: ['Elf', 'Scout'] },
  power: 2,
  toughness: 4,
  oracleText:
    'Parley — {T}: Each player reveals the top card of their library. For each nonland card revealed this way, add {G} and you gain 1 life. Then each player draws a card. (Activate only as an instant.)',
});

function atMain(reg: Registry): GameState {
  const forest = fromPool('Forest');
  const { state } = createGame({
    seed: 31164,
    decks: { A: { cards: Array.from({ length: 60 }, () => forest) }, B: { cards: Array.from({ length: 60 }, () => forest) } },
    registry: reg,
  });
  let s = state;
  for (let guard = 0; guard < 300 && (s.step !== 'precombatMain' || s.priorityPlayer !== 'A'); guard++) {
    s = applyAction(s, { kind: 'passPriority', player: s.priorityPlayer }, DEFAULT_RULES, reg).state;
  }
  s.players.A.manaPool = { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 };
  return s;
}

function put(state: GameState, def: CardDefinition, controller: PlayerId): InstanceId {
  const id = state.nextInstanceId++;
  (state.battlefield as unknown[]).push({
    instanceId: id,
    def,
    controller,
    owner: controller,
    zone: 'battlefield',
    tapped: false,
    summoningSick: false,
    damageMarked: 0,
    markedByDeathtouch: false,
    attachedTo: null,
    counters: {},
  });
  return id;
}

function tap(state: GameState, reg: Registry, id: InstanceId, extra: Record<string, unknown> = {}) {
  const r = applyAction(state, { kind: 'tapForMana', player: 'A', instanceId: id, ...extra } as GameAction, DEFAULT_RULES, reg);
  const rejected = r.events.find((e) => e.type === 'actionRejected') as { reason?: string } | undefined;
  if (rejected) throw new Error(`unexpected rejection: ${rejected.reason}`);
  return r.state;
}

describe('the derived-amount mana family, from print', () => {
  it("Gaea's Cradle taps for one green per creature you control", () => {
    const reg = buildRegistry();
    const s = atMain(reg);
    const cradle = put(s, CRADLE, 'A');
    put(s, fromPool('Grizzly Bears'), 'A');
    put(s, fromPool('Grizzly Bears'), 'A');
    put(s, fromPool('Grizzly Bears'), 'B');
    expect(tap(s, reg, cradle).players.A.manaPool.G).toBe(2);
  });

  it('Axebane Guardian taps for the defender count in one colour, or split across colours', () => {
    const reg = buildRegistry();
    const s = atMain(reg);
    const axe = put(s, AXEBANE, 'A');
    put(s, AXEBANE, 'A'); // two defenders
    expect(tap(s, reg, axe, { mode: 4 }).players.A.manaPool.G, '{G} is mode four of five').toBe(2);
    expect(tap(s, reg, axe, { split: { U: 1, G: 1 } }).players.A.manaPool).toMatchObject({ U: 1, G: 1 });
  });

  it("Karametra's Acolyte adds green equal to your devotion to green", () => {
    const reg = buildRegistry();
    const s = atMain(reg);
    const acolyte = put(s, ACOLYTE, 'A'); // {3}{G} — one pip
    put(s, ARCHDRUID, 'A'); // {1}{G}{G} — two more
    expect(tap(s, reg, acolyte).players.A.manaPool.G).toBe(3);
  });

  it('Elvish Archdruid counts Elves you control — the singular "for each" of a filtered count', () => {
    const reg = buildRegistry();
    const s = atMain(reg);
    const druid = put(s, ARCHDRUID, 'A'); // an Elf itself
    put(s, SELVALA, 'A'); // an Elf Scout
    put(s, fromPool('Grizzly Bears'), 'A'); // not an Elf
    expect(tap(s, reg, druid).players.A.manaPool.G).toBe(2);
  });

  it("Selvala's parley reveals, adds a green per nonland card, gains the life, and both players draw", () => {
    const reg = buildRegistry();
    const s = atMain(reg);
    const selvala = put(s, SELVALA, 'A');
    // Both libraries are all Forest; put a nonland card on top of A's.
    const bearsId = s.nextInstanceId++;
    s.players.A.library.unshift({
      instanceId: bearsId,
      def: fromPool('Grizzly Bears'),
      controller: 'A',
      owner: 'A',
      zone: 'library',
      tapped: false,
      summoningSick: false,
      damageMarked: 0,
      markedByDeathtouch: false,
      counters: {},
    } as never);
    const life = s.players.A.life;
    const handA = s.players.A.hand.length;
    const handB = s.players.B.hand.length;
    const after = tap(s, reg, selvala);
    expect(after.players.A.manaPool.G, 'A revealed the Bears, B a Forest').toBe(1);
    expect(after.players.A.life).toBe(life + 1);
    expect(after.players.A.hand.length).toBe(handA + 1);
    expect(after.players.B.hand.length).toBe(handB + 1);
    expect(after.players.A.hand.some((c) => c.instanceId === bearsId), 'the revealed card is the card drawn').toBe(true);
  });
});

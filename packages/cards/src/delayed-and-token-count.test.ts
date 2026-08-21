/**
 * TWO "AN EFFECT CREATES SOMETHING LATER" SYSTEMS, PLAYED — with cards COMPILED
 * FROM THEIR PRINTED ORACLE TEXT, not hand-authored definitions.
 *
 *  1. **A delayed triggered ability** (CR 603.7) — Kiki-Jiki's "Sacrifice it at
 *     the beginning of the next end step". The compiler half is pinned in
 *     `compile/copy-effects.test.ts`; this is the proof that the clause plays.
 *  2. **A token-count replacement** (CR 614) — Doubling Season's other half.
 *
 * ⚠️ EVERY CARD HERE IS RUN THROUGH `compileCard` on its real printed text.
 * A test that hand-built the definition it wanted would pass while the compiler
 * emitted something else entirely, which is exactly the shape of green test this
 * repo keeps having to unwind.
 *
 * ⚠️ AND THE ASSERTIONS ARE ABOUT THE BOARD AT A LATER MOMENT, not about an
 * event having been logged. "A delayed ability was created" is cheap; "the token
 * is gone at the end of the turn, and the game still holds exactly the cards it
 * held before" is the claim worth making.
 */

import { describe, expect, it } from 'vitest';
import type {
  CardDefinition,
  CardInstance,
  GameAction,
  GameEvent,
  GameState,
  InstanceId,
  PlayerId,
} from '@jonny-boi/core';
import { applyAction, createGame, DEFAULT_RULES, defaultAnswerFor } from '@jonny-boi/core';
import { buildRegistry } from './pool.js';
import { CARD_POOL } from '../data/pool.js';
import { compileCard } from './compile/index.js';

type Registry = ReturnType<typeof buildRegistry>;

const SEEDS = { kiki: 4401, survives: 4402, doubling: 4403, tapped: 4404, orderIndependent: 4405 } as const;

/** Every event this test has seen — the two delayed events are its only record. */
let seen: GameEvent[] = [];

function poolCard(name: string): CardDefinition {
  const card = CARD_POOL.find((entry) => entry.name === name);
  if (!card) throw new Error(`pool missing ${name}`);
  return card;
}

const MOUNTAIN = poolCard('Mountain');

const NO_MANA = { generic: 0, W: 0, U: 0, B: 0, R: 0, G: 0, C: 0, other: [] as readonly string[] };

/**
 * Compile a card from its PRINTED oracle text and insist it came out complete.
 *
 * The insistence is the point: if the compiler ever stops reading one of these
 * clauses, this file fails LOUDLY at the definition rather than quietly playing
 * a card that is missing its drawback.
 */
function printed(card: {
  name: string;
  cost?: Partial<typeof NO_MANA>;
  supertypes?: readonly string[];
  types: readonly string[];
  subtypes?: readonly string[];
  oracleText: string;
  keywords?: readonly string[];
  power?: number | null;
  toughness?: number | null;
}): CardDefinition {
  const result = compileCard({
    id: `delayed:${card.name}`,
    name: card.name,
    manaCost: { ...NO_MANA, ...card.cost },
    typeLine: {
      supertypes: card.supertypes ?? [],
      types: card.types,
      subtypes: card.subtypes ?? [],
    },
    oracleText: card.oracleText,
    power: card.power ?? null,
    toughness: card.toughness ?? null,
    keywords: card.keywords ?? [],
  });
  if (result.status !== 'complete') {
    throw new Error(`${card.name} did not compile: ${result.missing.map((m) => m.text).join(' | ')}`);
  }
  return result.definition;
}

const KIKI_JIKI = printed({
  name: 'Kiki-Jiki, Mirror Breaker',
  cost: { generic: 2, R: 3 },
  supertypes: ['Legendary'],
  types: ['Creature'],
  subtypes: ['Goblin', 'Shaman'],
  keywords: ['Haste'],
  power: 2,
  toughness: 2,
  oracleText:
    "Haste\n{T}: Create a token that's a copy of target nonlegendary creature you control, except it has haste. Sacrifice it at the beginning of the next end step.",
});

const DOUBLING_SEASON = printed({
  name: 'Doubling Season',
  cost: { generic: 4, G: 1 },
  types: ['Enchantment'],
  oracleText:
    'If an effect would create one or more tokens under your control, it creates twice that many of those tokens instead.\nIf an effect would put one or more counters on a permanent you control, it puts twice that many of those counters on that permanent instead.',
});

const PARALLEL_LIVES = printed({
  name: 'Parallel Lives',
  cost: { generic: 3, G: 1 },
  types: ['Enchantment'],
  oracleText:
    'If an effect would create one or more tokens under your control, it creates twice that many of those tokens instead.',
});

/** A plain body for Kiki-Jiki to copy. Nonlegendary, so it is a legal target. */
const BEAR: CardDefinition = {
  id: 'test-bear',
  name: 'Grizzly Bears',
  types: ['creature'],
  power: 2,
  toughness: 2,
};

function act(state: GameState, action: GameAction, reg: Registry): GameState {
  const result = applyAction(state, action, DEFAULT_RULES, reg);
  seen.push(...result.events);
  const rejected = result.events.find((e) => e.type === 'actionRejected');
  if (rejected) throw new Error(`unexpected rejection: ${(rejected as { reason: string }).reason}`);
  return result.state;
}

function pass(state: GameState, reg: Registry): GameState {
  const question = state.pendingChoice;
  if (question) {
    return act(
      state,
      { kind: 'answerChoice', player: question.chooser, choiceId: question.id, answer: defaultAnswerFor(question) },
      reg,
    );
  }
  return act(state, { kind: 'passPriority', player: state.priorityPlayer }, reg);
}

function advanceToStep(state: GameState, step: GameState['step'], reg: Registry, max = 400): GameState {
  let s = state;
  let guard = 0;
  while (s.step !== step && !s.gameOver && guard++ < max) s = pass(s, reg);
  return s;
}

/** Pass until the stack is empty, answering every question with its default. */
function settle(state: GameState, reg: Registry): GameState {
  let s = state;
  let guard = 0;
  while ((s.stack.length > 0 || s.pendingChoice != null) && !s.gameOver && guard++ < 60) s = pass(s, reg);
  return s;
}

function place(state: GameState, def: CardDefinition, controller: PlayerId): InstanceId {
  const id = state.nextInstanceId++;
  const permanent: CardInstance = {
    instanceId: id,
    def,
    controller,
    owner: controller,
    zone: 'battlefield',
    tapped: false,
    summoningSick: false,
    damageMarked: 0,
    markedByDeathtouch: false,
    counters: {},
  };
  state.battlefield.push(permanent);
  return id;
}

function openGame(seed: number): { s: GameState; reg: Registry } {
  seen = [];
  const reg = buildRegistry();
  const s = createGame({
    seed,
    decks: {
      A: { cards: Array.from({ length: 60 }, () => MOUNTAIN) },
      B: { cards: Array.from({ length: 60 }, () => MOUNTAIN) },
    },
    registry: reg,
  }).state;
  return { s, reg };
}

/** Every object on the battlefield with this name. */
function boardCount(state: GameState, name: string): number {
  return state.battlefield.filter((c) => c.def.name === name).length;
}

describe('Kiki-Jiki, compiled from its printed text and played', () => {
  it('copies a nonlegendary creature, and the token IS SACRIFICED at the end step', () => {
    const { s: fresh, reg } = openGame(SEEDS.kiki);
    let s = fresh;
    const kiki = place(s, KIKI_JIKI, 'A');
    const bear = place(s, BEAR, 'A');
    s = advanceToStep(s, 'precombatMain', reg);

    s = act(s, { kind: 'activateAbility', player: 'A', instanceId: kiki, abilityIndex: 0, targets: [bear] }, reg);
    s = settle(s, reg);

    // The copy is there, it is a Grizzly Bears, and it has haste from the tail.
    expect(boardCount(s, 'Grizzly Bears')).toBe(2);
    const token = s.battlefield.find((c) => c.def.name === 'Grizzly Bears' && c.def.isToken === true);
    expect(token).toBeDefined();
    expect(token?.summoningSick).toBe(false);
    // And the drawback exists, on no object at all.
    expect(s.delayedTriggers).toHaveLength(1);

    s = advanceToStep(s, 'end', reg);
    s = settle(s, reg);
    s = pass(s, reg);
    s = settle(s, reg);

    // The token is gone; the original Bear is not.
    expect(boardCount(s, 'Grizzly Bears')).toBe(1);
    expect(s.battlefield.some((c) => c.instanceId === bear)).toBe(true);
    // CR 704.5d — a sacrificed TOKEN ceases to exist rather than filling a
    // graveyard, so the card census is unchanged.
    expect(s.players.A.graveyard.some((c) => c.def.name === 'Grizzly Bears')).toBe(false);
    expect(seen.some((e) => e.type === 'delayedTriggerFired')).toBe(true);
  });

  it("cannot target a LEGENDARY creature — including itself", () => {
    const { s: fresh, reg } = openGame(SEEDS.kiki + 1);
    let s = fresh;
    const kiki = place(s, KIKI_JIKI, 'A');
    s = advanceToStep(s, 'precombatMain', reg);
    // With no nonlegendary creature on the board, the ability has no legal
    // target — and Kiki-Jiki, being legendary, is not one either. Dropping the
    // printed word would make this an infinite combo with every legend in Magic.
    const result = applyAction(
      s,
      { kind: 'activateAbility', player: 'A', instanceId: kiki, abilityIndex: 0, targets: [kiki] },
      DEFAULT_RULES,
      reg,
    );
    expect(result.events.some((e) => e.type === 'actionRejected')).toBe(true);
    expect(result.state.battlefield).toHaveLength(1);
  });

  it('SACRIFICES THE TOKEN EVEN WHEN KIKI-JIKI HAS BEEN DESTROYED — the headline property', () => {
    const { s: fresh, reg } = openGame(SEEDS.survives);
    let s = fresh;
    const kiki = place(s, KIKI_JIKI, 'A');
    const bear = place(s, BEAR, 'A');
    s = advanceToStep(s, 'precombatMain', reg);
    s = act(s, { kind: 'activateAbility', player: 'A', instanceId: kiki, abilityIndex: 0, targets: [bear] }, reg);
    s = settle(s, reg);
    expect(boardCount(s, 'Grizzly Bears')).toBe(2);

    // Kiki-Jiki eats a removal spell. Every trigger this engine had before
    // CR 603.7 was collected FROM the battlefield, so a design that hung the
    // delayed ability off the permanent loses it exactly here — and the copy
    // becomes a permanent hasty body with no drawback.
    const at = s.battlefield.findIndex((c) => c.instanceId === kiki);
    s.battlefield.splice(at, 1);

    s = advanceToStep(s, 'end', reg);
    s = settle(s, reg);
    s = pass(s, reg);
    s = settle(s, reg);
    expect(boardCount(s, 'Grizzly Bears')).toBe(1);
  });
});

describe("Doubling Season's OTHER half — a token-count replacement", () => {
  it('doubles a token copy, once, as ONE event', () => {
    const { s: fresh, reg } = openGame(SEEDS.doubling);
    let s = fresh;
    const kiki = place(s, KIKI_JIKI, 'A');
    const bear = place(s, BEAR, 'A');
    place(s, DOUBLING_SEASON, 'A');
    s = advanceToStep(s, 'precombatMain', reg);
    s = act(s, { kind: 'activateAbility', player: 'A', instanceId: kiki, abilityIndex: 0, targets: [bear] }, reg);
    s = settle(s, reg);

    // One printed token became two. The original Bear makes three on the board.
    expect(boardCount(s, 'Grizzly Bears')).toBe(3);
    // ONE application, logged once — the count is replaced as a single CR 614
    // event, not once per token. A loop of single creations would log two.
    const applied = seen.filter((e) => e.type === 'replacementApplied' && e.event === 'tokens');
    expect(applied).toHaveLength(1);
    expect(applied[0]).toMatchObject({ from: 1, to: 2 });
    // And BOTH tokens are sacrificed by the one delayed ability the printed
    // sentence creates — "sacrifice IT" names everything the effect made.
    expect(s.delayedTriggers).toHaveLength(1);
    s = advanceToStep(s, 'end', reg);
    s = settle(s, reg);
    s = pass(s, reg);
    s = settle(s, reg);
    expect(boardCount(s, 'Grizzly Bears')).toBe(1);
  });

  it('two doublers give ×4, and each applies AT MOST ONCE (CR 614.5)', () => {
    const { s: fresh, reg } = openGame(SEEDS.orderIndependent);
    let s = fresh;
    const kiki = place(s, KIKI_JIKI, 'A');
    const bear = place(s, BEAR, 'A');
    place(s, DOUBLING_SEASON, 'A');
    place(s, PARALLEL_LIVES, 'A');
    s = advanceToStep(s, 'precombatMain', reg);
    s = act(s, { kind: 'activateAbility', player: 'A', instanceId: kiki, abilityIndex: 0, targets: [bear] }, reg);
    s = settle(s, reg);

    // 1 → 2 → 4. Termination is structural: each doubler matches its own output
    // and is never offered again, so the loop is bounded by the candidate list.
    expect(boardCount(s, 'Grizzly Bears')).toBe(5);
    const applied = seen.filter((e) => e.type === 'replacementApplied' && e.event === 'tokens');
    expect(applied).toHaveLength(2);
  });

  it("does NOT double an opponent's tokens — 'under your control' is read", () => {
    const { s: fresh, reg } = openGame(SEEDS.doubling + 1);
    let s = fresh;
    place(s, DOUBLING_SEASON, 'A');
    const kiki = place(s, KIKI_JIKI, 'B');
    const bear = place(s, BEAR, 'B');
    s = advanceToStep(s, 'precombatMain', reg);
    // Hand priority to B in its own main phase so it may activate.
    s = pass(s, reg);
    s = act(s, { kind: 'activateAbility', player: 'B', instanceId: kiki, abilityIndex: 0, targets: [bear] }, reg);
    s = settle(s, reg);
    expect(boardCount(s, 'Grizzly Bears')).toBe(2);
    expect(seen.filter((e) => e.type === 'replacementApplied' && e.event === 'tokens')).toHaveLength(0);
  });
});

describe('a token that arrives TAPPED', () => {
  it('enters tapped when the printed instruction says so, and untapped when it does not', () => {
    const tappedMaker = printed({
      name: 'Tapped Maker',
      cost: { generic: 2 },
      types: ['Sorcery'],
      oracleText: 'Create two tapped 1/1 white Soldier creature tokens.',
    });
    const plainMaker = printed({
      name: 'Plain Maker',
      cost: { generic: 2 },
      types: ['Sorcery'],
      oracleText: 'Create two 1/1 white Soldier creature tokens.',
    });
    const { s: fresh, reg } = openGame(SEEDS.tapped);
    let s = fresh;
    s = advanceToStep(s, 'precombatMain', reg);

    for (const [def, expectTapped] of [
      [tappedMaker, true],
      [plainMaker, false],
    ] as const) {
      const before = s.battlefield.length;
      const inst: CardInstance = {
        instanceId: s.nextInstanceId++,
        def,
        controller: 'A',
        owner: 'A',
        zone: 'hand',
        tapped: false,
        summoningSick: false,
        damageMarked: 0,
        markedByDeathtouch: false,
        counters: {},
      };
      s.players.A.hand.push(inst);
      s.players.A.manaPool = { W: 9, U: 9, B: 9, R: 9, G: 9, C: 9 };
      s = act(s, { kind: 'castSpell', player: 'A', instanceId: inst.instanceId }, reg);
      s = settle(s, reg);
      const made = s.battlefield.slice(before);
      expect(made).toHaveLength(2);
      for (const token of made) expect(token.tapped).toBe(expectTapped);
    }
  });
});

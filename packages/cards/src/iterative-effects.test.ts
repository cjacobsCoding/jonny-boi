/**
 * THE ITERATIVE-EFFECTS FAMILY (§3.156) — `repeat this process`, proven the way
 * this compiler's contract demands: the REAL printed card compiles `'complete'`
 * with its data pinned, AND the compiled definition is PLAYED through a real
 * `createGame` + `applyAction` game with every question actually answered.
 *
 * Playing it is not optional here. A card that compiles and then hangs is worse
 * than a card that reports, and "hangs" is the specific failure an unbounded
 * iteration produces: no question, no action, no turn — so nothing the sim or
 * the soak watches would ever have seen it. Every play row below therefore ends
 * by asserting what actually reached the battlefield or the graveyard, and the
 * two budget rows assert what the engine SAID when it gave up.
 *
 * ⚠️ THE ASSERTIONS RUN IN BOTH DIRECTIONS (§1a). A `repeat this process` that
 * iterates once too often plays STRONGER than printed and one that stops early
 * plays WEAKER, and both corrupt an A/B verdict identically. So each play row
 * pins an exact board rather than a floor, and the declined / non-permanent /
 * empty-library exits are pinned as separately as the yes path.
 */

import { describe, expect, it } from 'vitest';
import type {
  CardDefinition,
  CardInstance,
  ChoiceAnswer,
  EffectPrimitive,
  GameAction,
  GameEvent,
  GameState,
  PlayerId,
} from '@jonny-boi/core';
import {
  applyAction,
  createGame,
  DEFAULT_RULES,
  dumpState,
  MAX_CHOICES_PER_EFFECT_REF,
  MAX_EFFECT_STEPS_PER_RESOLUTION,
} from '@jonny-boi/core';
import { compileCard } from './compile/compile.js';
import { SHARED_MILL_PARAM_VALUES } from './compile/rules.js';
import type { CompilableCard } from './compile/types.js';
import { SHARED_MILL_PREDICATE_KEYS } from './iterative-primitives.js';
import { buildRegistry } from './pool.js';
import { CORE_PRIMITIVE_IDS } from './primitives.js';

type Registry = ReturnType<typeof buildRegistry>;
type Cost = CompilableCard['manaCost'];

const cost = (parts: Partial<Cost>): Cost => ({ generic: 0, W: 0, U: 0, B: 0, R: 0, G: 0, C: 0, other: [], ...parts });
const SORCERY: CompilableCard['typeLine'] = { supertypes: [], types: ['Sorcery'], subtypes: [] };
const ARTIFACT: CompilableCard['typeLine'] = { supertypes: [], types: ['Artifact'], subtypes: [] };

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

// --- the printed cards, exactly as Scryfall prints them --------------------------

const PRIMAL_SURGE = printed(
  'Primal Surge',
  "Exile the top card of your library. If it's a permanent card, you may put it onto the battlefield. If you do, repeat this process.",
  SORCERY,
  cost({ generic: 7, G: 3 }),
);
const GRINDSTONE = printed(
  'Grindstone',
  '{3}, {T}: Target player mills two cards. If two cards that share a color were milled this way, repeat this process.',
  ARTIFACT,
  cost({ generic: 1 }),
  { keywords: ['Mill'] },
);
/** The same template printed with the OTHER characteristic the closed table holds. */
const GRINDSTONE_BY_TYPE = printed(
  'Grindstone (card type)',
  '{3}, {T}: Target player mills two cards. If two cards that share a card type were milled this way, repeat this process.',
  ARTIFACT,
  cost({ generic: 1 }),
  { keywords: ['Mill'] },
);

function complete(card: CompilableCard): CardDefinition {
  const result = compileCard(card);
  expect(result.status, `${card.name}: ${JSON.stringify(result.missing)}`).toBe('complete');
  return result.definition;
}

// ---------------------------------------------------------------------------
// COMPILE
// ---------------------------------------------------------------------------

describe('the printed lines compile to the family’s data', () => {
  it('registers the three primitives the rules emit', () => {
    // ⚠️ The denominator first (§8a item 8): a "for each id, assert" sweep over
    // an empty registry passes vacuously, and that shape is everywhere here.
    expect(CORE_PRIMITIVE_IDS.length).toBeGreaterThan(50);
    for (const id of ['exileTopMayPlay', 'mayPlayExiledCard', 'millSharedColorRepeat']) {
      expect(CORE_PRIMITIVE_IDS, id).toContain(id);
    }
  });

  it('Primal Surge — one ref carrying the permanent-card filter and the printed repeat', () => {
    const result = compileCard(PRIMAL_SURGE);
    expect(result.status, JSON.stringify(result.missing)).toBe('complete');
    expect(result.matchedRules).toContain('exile-top-may-play-repeat');
    expect(result.definition.effects).toEqual([
      {
        primitive: 'exileTopMayPlay',
        params: {
          filter: { anyOfTypes: ['land', 'creature', 'artifact', 'enchantment', 'planeswalker', 'battle'] },
          repeat: true,
        },
      },
    ]);
  });

  it('Grindstone — the activated ability, with the shared characteristic as a param', () => {
    const result = compileCard(GRINDSTONE);
    expect(result.status, JSON.stringify(result.missing)).toBe('complete');
    expect(result.matchedRules).toContain('target-player-mills-share-repeat');
    expect(result.definition.activated?.[0]?.effects).toEqual([
      { primitive: 'millSharedColorRepeat', params: { amount: 2, share: 'color', targets: 'player' } },
    ]);
    expect(complete(GRINDSTONE_BY_TYPE).activated?.[0]?.effects?.[0]).toMatchObject({
      params: { share: 'type' },
    });
  });

  it('the compiler and the primitive agree about the closed `share` vocabulary', () => {
    // §8a item 5: two tables spelling one vocabulary is how eight cards vanish
    // without a conflict. The compiler may only author a value the primitive can
    // honour — the reverse is fine (a predicate no card prints yet).
    expect(SHARED_MILL_PARAM_VALUES.length).toBeGreaterThan(0);
    for (const value of SHARED_MILL_PARAM_VALUES) {
      expect(SHARED_MILL_PREDICATE_KEYS, `the compiler authors share='${value}'`).toContain(value);
    }
  });

  it('REPORTS, never approximates, the iteration wordings outside the closed rules', () => {
    // Each of these is a REAL printed corpus line (`scripts/repeat-blame.mjs`).
    // They must keep reporting: widening a template to swallow a clause it
    // cannot do is the one thing the pool rule forbids.
    const outside: ReadonlyArray<readonly [CompilableCard, RegExp]> = [
      [
        printed(
          'Tainted Pact',
          'Exile the top card of your library. You may put that card into your hand unless it has the same name as another card exiled this way. Repeat this process until you put a card into your hand or you exile two cards with the same name, whichever comes first.',
          { supertypes: [], types: ['Instant'], subtypes: [] },
          cost({ generic: 1, B: 1 }),
        ),
        /repeat this process until/i,
      ],
      [
        printed(
          'Ad Nauseam',
          'Reveal the top card of your library and put that card into your hand. You lose life equal to its mana value. You may repeat this process any number of times.',
          { supertypes: [], types: ['Instant'], subtypes: [] },
          cost({ generic: 3, B: 2 }),
        ),
        /any number of times/i,
      ],
      [
        printed(
          'Remorseless Punishment',
          'Target opponent loses 5 life unless that player discards two cards or sacrifices a creature or planeswalker of their choice. Repeat this process once.',
          SORCERY,
          cost({ generic: 4, B: 1 }),
        ),
        /repeat this process once/i,
      ],
      [
        // The share vocabulary is CLOSED: "the same name" has no predicate, so
        // the whole line reports rather than falling through to `color`.
        printed(
          'Grindstone (by name)',
          '{3}, {T}: Target player mills two cards. If two cards that share a name were milled this way, repeat this process.',
          ARTIFACT,
          cost({ generic: 1 }),
          { keywords: ['Mill'] },
        ),
        /share a name/i,
      ],
    ];
    for (const [card, clause] of outside) {
      const result = compileCard(card);
      expect(result.status, card.name).toBe('incomplete');
      expect(
        result.missing.some((gap) => clause.test(gap.text)),
        `${card.name}: ${JSON.stringify(result.missing)}`,
      ).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// PLAYED THROUGH THE REAL ENGINE
// ---------------------------------------------------------------------------

const SEED = 4013;
const DECK_SIZE = 40;
let syntheticId = 74_000;

function land(id: string, color: 'W' | 'U' | 'B' | 'R' | 'G'): CardDefinition {
  return { id, name: id, types: ['land'], produces: [color] };
}
const FOREST = land('Forest', 'G');
const BEAR: CardDefinition = {
  id: 'bear',
  name: 'Bear',
  types: ['creature'],
  power: 2,
  toughness: 2,
  cost: { generic: 2 },
};
const RELIC: CardDefinition = { id: 'relic', name: 'Relic', types: ['artifact'], cost: { generic: 2 } };
/** A NONPERMANENT — the printed stopping condition of Primal Surge. */
const BOLT: CardDefinition = {
  id: 'bolt',
  name: 'Bolt',
  types: ['instant'],
  timing: 'instant',
  cost: { R: 1 },
  effects: [],
};
/** Two cards that share GREEN, and one that shares nothing with either. */
const GREEN_BEAR: CardDefinition = { ...BEAR, id: 'green-bear', name: 'Green Bear', cost: { G: 2 } };
const RED_BEAR: CardDefinition = { ...BEAR, id: 'red-bear', name: 'Red Bear', cost: { R: 2 } };

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

function act(state: GameState, action: GameAction, reg: Registry): { state: GameState; events: readonly GameEvent[] } {
  const result = applyAction(state, action, DEFAULT_RULES, reg);
  const rejected = result.events.find((e) => e.type === 'actionRejected');
  if (rejected) throw new Error(`unexpected rejection: ${(rejected as { reason: string }).reason}\n${dumpState(state)}`);
  return { state: result.state, events: result.events };
}

function until(state: GameState, reg: Registry, done: (s: GameState) => boolean): GameState {
  let s = state;
  for (let guard = 0; guard < 800; guard++) {
    if (done(s)) return s;
    if (s.gameOver) throw new Error('game ended first');
    if (s.pendingChoice) throw new Error(`a question parked the game first:\n${dumpState(s)}`);
    s = act(s, { kind: 'passPriority', player: s.priorityPlayer }, reg).state;
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

function inHand(state: GameState, def: CardDefinition): CardInstance {
  const card = instance(def, 'A', 'hand');
  state.players.A.hand.push(card);
  return card;
}

/** Replace a player's whole library with `defs`, `defs[0]` topmost. */
function setLibrary(state: GameState, player: PlayerId, defs: readonly CardDefinition[]): CardInstance[] {
  const cards = defs.map((def) => instance(def, player, 'library'));
  state.players[player].library = cards;
  return cards;
}

/**
 * Pass until the stack is empty, answering every question with `answerer`, and
 * collecting every event so a row can assert on what the engine SAID.
 *
 * The guard is deliberately generous and deliberately THROWS: the failure this
 * whole file exists for is a resolution that never finishes, and a harness that
 * quietly returned a half-resolved state would report it as a board assertion
 * failing somewhere else.
 */
function settle(
  state: GameState,
  reg: Registry,
  answerer: (s: GameState) => ChoiceAnswer,
): { state: GameState; events: GameEvent[]; asked: number } {
  let s = state;
  const events: GameEvent[] = [];
  let asked = 0;
  for (let guard = 0; guard < 4000; guard++) {
    if (s.pendingChoice) {
      const choice = s.pendingChoice;
      asked += 1;
      const stepped = act(s, { kind: 'answerChoice', player: choice.chooser, choiceId: choice.id, answer: answerer(s) }, reg);
      s = stepped.state;
      events.push(...stepped.events);
      continue;
    }
    if (s.stack.length === 0) return { state: s, events, asked };
    const stepped = act(s, { kind: 'passPriority', player: s.priorityPlayer }, reg);
    s = stepped.state;
    events.push(...stepped.events);
  }
  throw new Error(`the stack never emptied:\n${dumpState(s)}`);
}

const yes: ChoiceAnswer = { kind: 'confirm', yes: true };
const no: ChoiceAnswer = { kind: 'confirm', yes: false };

function cast(state: GameState, reg: Registry, card: CardInstance, targets?: (number | PlayerId)[]): GameState {
  return act(
    state,
    { kind: 'castSpell', player: 'A', instanceId: card.instanceId, ...(targets ? { targets } : {}) },
    reg,
  ).state;
}

const names = (cards: readonly CardInstance[]): string[] => cards.map((c) => c.def.name);
const abandoned = (events: readonly GameEvent[]): string[] =>
  events.filter((e) => e.type === 'choiceAbandoned').map((e) => (e as { reason: string }).reason);

describe('PRIMAL SURGE, played', () => {
  it('walks permanents onto the battlefield and STOPS at the first nonpermanent, which stays exiled', () => {
    const reg = buildRegistry();
    let s = gameAtMain(reg);
    fund(s, 'A', { G: 9, C: 9 });
    // Bear, Relic, Forest are permanents; Bolt is not; the Bear after it must
    // never be reached — that is the "stronger than printed" direction.
    setLibrary(s, 'A', [BEAR, RELIC, FOREST, BOLT, BEAR, BEAR]);
    s = cast(s, reg, inHand(s, complete(PRIMAL_SURGE)));
    const played = settle(s, reg, () => yes);
    s = played.state;

    expect(names(s.battlefield.filter((c) => c.controller === 'A'))).toEqual(['Bear', 'Relic', 'Forest']);
    // Both exiled cards are printed consequences: the three permanents passed
    // THROUGH exile, and the Bolt stopped the loop while staying there.
    expect(names(s.players.A.exile)).toEqual(['Bolt']);
    expect(names(s.players.A.library)).toEqual(['Bear', 'Bear']);
    // One question per permanent — never one for the Bolt, which was not offered.
    expect(played.asked).toBe(3);
    expect(abandoned(played.events)).toEqual([]);
    expect(names(s.players.A.graveyard)).toContain('Primal Surge');
  });

  it('DECLINING ends the iteration — the printed "if you do" is false', () => {
    const reg = buildRegistry();
    let s = gameAtMain(reg);
    fund(s, 'A', { G: 9, C: 9 });
    setLibrary(s, 'A', [BEAR, RELIC, FOREST]);
    s = cast(s, reg, inHand(s, complete(PRIMAL_SURGE)));
    let answers = 0;
    const played = settle(s, reg, () => (++answers === 1 ? yes : no));
    s = played.state;

    expect(names(s.battlefield.filter((c) => c.controller === 'A'))).toEqual(['Bear']);
    // The declined card was already exiled by the printed first sentence, and
    // stays there: declining does not put it back.
    expect(names(s.players.A.exile)).toEqual(['Relic']);
    expect(names(s.players.A.library)).toEqual(['Forest']);
    expect(played.asked).toBe(2);
  });

  it('an EMPTY library resolves to nothing at all, and asks nothing', () => {
    const reg = buildRegistry();
    let s = gameAtMain(reg);
    fund(s, 'A', { G: 9, C: 9 });
    setLibrary(s, 'A', []);
    const before = s.battlefield.length;
    s = cast(s, reg, inHand(s, complete(PRIMAL_SURGE)));
    const played = settle(s, reg, () => yes);
    s = played.state;

    expect(s.battlefield.length).toBe(before);
    expect(s.players.A.exile).toEqual([]);
    expect(played.asked).toBe(0);
    expect(abandoned(played.events)).toEqual([]);
    expect(names(s.players.A.graveyard)).toContain('Primal Surge');
  });

  it('a PERMANENT-HEAVY deck empties its library onto the battlefield without the engine giving up', () => {
    // ⚠️ THE ROW THE OLD FRAME-WIDE CEILING WOULD HAVE FAILED. Caleb's "Tamiyo +
    // Jace Surge" deck is what Primal Surge is built for, and it is almost all
    // permanents — so the real card asks fifty-odd questions in ONE resolution.
    // While the 32-question ceiling counted across the whole FRAME, the rest of
    // the resolution was abandoned and the remaining `confirm`s degraded to NO:
    // a card playing WEAKER than printed with every test still green. The
    // ceiling is now per EFFECT REF, which is the pathology it was written for,
    // and this card's fifty-odd questions come from fifty-odd different refs.
    const reg = buildRegistry();
    let s = gameAtMain(reg);
    fund(s, 'A', { G: 9, C: 9 });
    const deck = Array.from({ length: 56 }, (_, i) => (i % 2 === 0 ? FOREST : BEAR));
    setLibrary(s, 'A', deck);
    s = cast(s, reg, inHand(s, complete(PRIMAL_SURGE)));
    const played = settle(s, reg, () => yes);
    s = played.state;

    expect(s.players.A.library).toEqual([]);
    expect(s.battlefield.filter((c) => c.controller === 'A').length).toBe(deck.length);
    expect(played.asked).toBe(deck.length);
    expect(
      abandoned(played.events),
      'the engine gave up on a legal resolution — the ceiling is too low',
    ).toEqual([]);
    // ⚠️ AND WHICH CEILING IS DOING THE WORK, stated as numbers rather than as
    // "it worked" — a row that passes because the deck happens to be small is
    // not the check it claims to be, and this card's whole design rests on the
    // two ceilings counting DIFFERENT things:
    //
    //   - the per-REF ask ceiling is SMALLER than the number of questions this
    //     resolution asked, and that is correct. Each question comes from its
    //     own enqueued ref, so none of them is the loop that ceiling guards.
    //     Asserted as a `<` so a future change that makes it frame-wide again
    //     fails HERE, where the reason is written down.
    //   - the per-RESOLUTION step ceiling is what genuinely bounds the frame,
    //     and it must exceed two refs per iteration.
    expect(played.asked).toBeGreaterThan(MAX_CHOICES_PER_EFFECT_REF);
    expect(MAX_EFFECT_STEPS_PER_RESOLUTION).toBeGreaterThan(deck.length * 2);
  });
});

describe('GRINDSTONE, played — the iteration that asks NOTHING', () => {
  /** Grindstone on the battlefield, untapped and not summoning-sick, with mana up. */
  function grindstoneAtMain(reg: Registry, victimLibrary: readonly CardDefinition[]): {
    state: GameState;
    stone: CardInstance;
  } {
    const s = gameAtMain(reg);
    fund(s, 'A', { C: 9, G: 9 });
    const stone = instance(complete(GRINDSTONE), 'A', 'battlefield');
    stone.summoningSick = false;
    s.battlefield.push(stone);
    setLibrary(s, 'B', victimLibrary);
    return { state: s, stone };
  }

  it('mono-coloured library: it repeats until the library cannot pay two more cards', () => {
    const reg = buildRegistry();
    const { state, stone } = grindstoneAtMain(reg, Array.from({ length: 10 }, () => GREEN_BEAR));
    let s = act(
      state,
      { kind: 'activateAbility', player: 'A', instanceId: stone.instanceId, abilityIndex: 0, targets: ['B'] },
      reg,
    ).state;
    const played = settle(s, reg, () => yes);
    s = played.state;

    expect(s.players.B.library).toEqual([]);
    expect(s.players.B.graveyard.length).toBe(10);
    // Nothing was ASKED: this is the shape that had no bound before §3.156.
    expect(played.asked).toBe(0);
    expect(abandoned(played.events)).toEqual([]);
  });

  it('an ODD library stops when it cannot mill the printed two', () => {
    const reg = buildRegistry();
    const { state, stone } = grindstoneAtMain(reg, Array.from({ length: 5 }, () => GREEN_BEAR));
    let s = act(
      state,
      { kind: 'activateAbility', player: 'A', instanceId: stone.instanceId, abilityIndex: 0, targets: ['B'] },
      reg,
    ).state;
    s = settle(s, reg, () => yes).state;
    // 2 + 2 + the last one: "as many as possible" mills the odd card and the
    // condition, which names TWO cards, is false.
    expect(s.players.B.library).toEqual([]);
    expect(s.players.B.graveyard.length).toBe(5);
  });

  it('two cards that share NO colour mill exactly the printed two and stop', () => {
    const reg = buildRegistry();
    const { state, stone } = grindstoneAtMain(reg, [GREEN_BEAR, RED_BEAR, GREEN_BEAR, GREEN_BEAR]);
    let s = act(
      state,
      { kind: 'activateAbility', player: 'A', instanceId: stone.instanceId, abilityIndex: 0, targets: ['B'] },
      reg,
    ).state;
    s = settle(s, reg, () => yes).state;
    expect(s.players.B.graveyard.length).toBe(2);
    expect(names(s.players.B.library)).toEqual(['Green Bear', 'Green Bear']);
  });

  it('COLOURLESS cards share no colour with each other — an artifact library stops at two', () => {
    // The direction that would play STRONGER than printed: treating "no colour"
    // as a shared characteristic would grind an artifact deck to nothing.
    const reg = buildRegistry();
    const { state, stone } = grindstoneAtMain(reg, Array.from({ length: 6 }, () => RELIC));
    let s = act(
      state,
      { kind: 'activateAbility', player: 'A', instanceId: stone.instanceId, abilityIndex: 0, targets: ['B'] },
      reg,
    ).state;
    s = settle(s, reg, () => yes).state;
    expect(s.players.B.graveyard.length).toBe(2);
    expect(s.players.B.library.length).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// THE BOUND — proven by an iteration that genuinely never stops
// ---------------------------------------------------------------------------

describe('a body that iterates without consuming anything is ABANDONED, and says so', () => {
  it('trips MAX_EFFECT_STEPS_PER_RESOLUTION, emits the reason, and lets the game carry on', () => {
    // ⚠️ THE AUTHORING MISTAKE THIS BOUND EXISTS FOR, written as a fixture rather
    // than hoped for. Everything in §3.156 terminates because its body consumes
    // a finite zone; this one consumes nothing, which is exactly what a future
    // iterative card gets wrong. Before the bound it hung the process — no
    // question, no action, no turn, and nothing the soak watches.
    const reg = buildRegistry();
    const runaway: EffectPrimitive = (ctx) => {
      ctx.enqueueEffects([{ primitive: 'neverStops', params: {} }]);
    };
    reg.register('neverStops', runaway);
    const LOOP: CardDefinition = {
      id: 'loop',
      name: 'Loop',
      types: ['sorcery'],
      timing: 'sorcery',
      cost: { generic: 1 },
      effects: [{ primitive: 'neverStops', params: {} }],
    };
    let s = gameAtMain(reg);
    fund(s, 'A', { C: 9, G: 9 });
    s = cast(s, reg, inHand(s, LOOP));
    const played = settle(s, reg, () => yes);
    s = played.state;

    const reasons = abandoned(played.events);
    expect(reasons.length, 'the runaway was not reported at all').toBe(1);
    expect(reasons[0]).toContain(String(MAX_EFFECT_STEPS_PER_RESOLUTION));
    expect(reasons[0]).toContain('effect steps');
    // ABANDONED, not hung and not crashed: the spell finished resolving and the
    // game is playable afterwards.
    expect(names(s.players.A.graveyard)).toContain('Loop');
    expect(s.stack).toEqual([]);
    expect(s.gameOver).toBe(false);
  });
});

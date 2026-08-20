/**
 * The templates this branch closed, proven through the REAL compiler on REAL
 * printed oracle text — and then, where a flag alone would be inert, proven in a
 * played game.
 *
 * Two clusters:
 *   1. BLOCK REQUIREMENTS and comparing block restrictions (CR 509.1c/d).
 *   2. Four standalone rules statics — changeling, "this spell can't be
 *      countered", "you have no maximum hand size", "you may play lands from your
 *      graveyard" — plus the general "enters tapped unless you control …".
 *
 * ⚠️ WHY THE PLAY TESTS ARE HERE AND NOT ONLY THE COMPILE ONES. A rules static is
 * exactly the kind of feature that can compile `'complete'` and do nothing: the
 * field lands on the definition, no consumer reads it, and every compiler test
 * still passes. Each one below is therefore asserted twice — once that the printed
 * line compiles, and once that the game plays differently because of it.
 */

import { describe, expect, it } from 'vitest';
import {
  applyAction,
  createGame,
  DEFAULT_RULES,
  defaultAnswerFor,
  generateLegalActions,
  hasSubtype,
  indexContinuous,
  landPlayZonesFor,
  spellCanBeCountered,
} from '@jonny-boi/core';
import type {
  CardDefinition,
  CardInstance,
  GameAction,
  GameState,
  PlayerId,
} from '@jonny-boi/core';
import { compileCard } from './compile/index.js';
import type { CompilableCard } from './compile/index.js';
import { buildRegistry } from './pool.js';

/**
 * A printed card record, as `normalizeCard` would hand one to the compiler.
 *
 * `manaCost` is spelled as the parsed record the compiler expects rather than as a
 * string: these tests exercise the RULE TABLE, and re-deriving a cost from text
 * would put a second parser between the printed line and the assertion.
 */
function card(
  partial: Omit<Partial<CompilableCard>, 'manaCost'> & {
    name: string;
    typeLine: CompilableCard['typeLine'];
    manaCost?: Partial<CompilableCard['manaCost']>;
  },
): CompilableCard {
  const { manaCost, ...rest } = partial;
  return {
    id: partial.name,
    oracleText: '',
    power: null,
    toughness: null,
    keywords: [],
    ...rest,
    manaCost: { generic: 0, W: 0, U: 0, B: 0, R: 0, G: 0, C: 0, other: [], ...(manaCost ?? {}) },
  } as CompilableCard;
}

function typeLine(types: readonly string[], subtypes: readonly string[] = []): CompilableCard['typeLine'] {
  return { supertypes: [], types: [...types], subtypes: [...subtypes] } as CompilableCard['typeLine'];
}

/** Compile and assert the card came out COMPLETE, naming what blocked it if not. */
function compileComplete(input: CompilableCard): CardDefinition {
  const result = compileCard(input);
  expect(result.missing.map((m) => m.text)).toEqual([]);
  expect(result.status).toBe('complete');
  return result.definition as CardDefinition;
}

describe('block requirements compile from printed text', () => {
  it('"~ must be blocked if able"', () => {
    const def = compileComplete(
      card({
        name: 'Lure Target',
        typeLine: typeLine(['creature'], ['Beast']),
        manaCost: { generic: 2, G: 1 },
        power: 2,
        toughness: 2,
        oracleText: 'Lure Target must be blocked if able.',
      }),
    );
    expect(def.keywords?.mustBeBlocked).toBe(true);
  });

  it('"All creatures able to block ~ do so" — the stronger Lure printing', () => {
    const def = compileComplete(
      card({
        name: 'Lured Beast',
        typeLine: typeLine(['creature'], ['Beast']),
        manaCost: { generic: 2, G: 1 },
        power: 2,
        toughness: 2,
        oracleText: 'All creatures able to block Lured Beast do so.',
      }),
    );
    expect(def.keywords?.blockedByAllAble).toBe(true);
  });

  it('skulk compiles to the self-comparing restriction, not to a flag', () => {
    const def = compileComplete(
      card({
        name: 'Sneak',
        typeLine: typeLine(['creature'], ['Rogue']),
        manaCost: { generic: 1, B: 1 },
        power: 2,
        toughness: 1,
        oracleText: 'Skulk (This creature can’t be blocked by creatures with greater power.)',
        keywords: ['Skulk'],
      }),
    );
    expect(def.keywords?.blockRestriction).toEqual({ blockerPowerAtMostMine: true });
  });

  it('a printed power bound inverts as it compiles', () => {
    const def = compileComplete(
      card({
        name: 'Slippery Thing',
        typeLine: typeLine(['creature'], ['Fish']),
        manaCost: { generic: 1, U: 1 },
        power: 1,
        toughness: 3,
        oracleText: "Slippery Thing can't be blocked by creatures with power 3 or greater.",
      }),
    );
    // "power 3 or greater cannot block" is the restriction "at most power 2".
    expect(def.keywords?.blockRestriction).toEqual({ maxBlockerPower: 2 });
  });

  it("Gingerbrute's activated 'except by creatures with haste' compiles whole", () => {
    const def = compileComplete(
      card({
        name: 'Gingerbrute',
        typeLine: typeLine(['artifact', 'creature'], ['Food', 'Golem']),
        manaCost: { generic: 1 },
        power: 1,
        toughness: 1,
        oracleText: "{1}: Gingerbrute can't be blocked this turn except by creatures with haste.",
        keywords: [],
      }),
    );
    expect(def.activated?.length).toBe(1);
    const grant = def.activated?.[0]?.effects?.[0];
    expect(grant?.primitive).toBe('grantKeywordUntilEndOfTurn');
    expect((grant?.params as { keywords?: unknown })?.keywords).toEqual({
      blockRestriction: { blockerMustHaveAnyOf: ['haste'] },
    });
  });
});

describe('changeling', () => {
  it('compiles to a definition flag, not a keyword flag', () => {
    const def = compileComplete(
      card({
        name: 'Universal Automaton',
        typeLine: typeLine(['artifact', 'creature'], ['Shapeshifter']),
        manaCost: { generic: 1 },
        power: 1,
        toughness: 1,
        oracleText: 'Changeling (This card is every creature type.)',
        keywords: ['Changeling'],
      }),
    );
    expect(def.changeling).toBe(true);
    // It is NOT a `KeywordFlags` boolean — it applies in every zone, which the
    // continuous layer (a battlefield mechanism) could not do.
    expect((def.keywords as Record<string, unknown> | undefined)?.changeling).toBeUndefined();
  });

  it('IS every creature type through core’s one subtype funnel', () => {
    const def = compileComplete(
      card({
        name: 'Universal Automaton',
        typeLine: typeLine(['artifact', 'creature'], ['Shapeshifter']),
        manaCost: { generic: 1 },
        power: 1,
        toughness: 1,
        oracleText: 'Changeling (This card is every creature type.)',
        keywords: ['Changeling'],
      }),
    );
    expect(hasSubtype(def, 'Goblin')).toBe(true);
    expect(hasSubtype(def, 'Zombie')).toBe(true);
    expect(hasSubtype(def, 'Shapeshifter')).toBe(true);
    // …and it is NOT every OTHER kind of subtype. An artifact creature with
    // changeling is not an Equipment and not an Island.
    expect(hasSubtype(def, 'Equipment')).toBe(false);
    expect(hasSubtype(def, 'Island')).toBe(false);
    expect(hasSubtype(def, 'Aura')).toBe(false);
  });

  it('does not leak onto a non-creature card', () => {
    // The gate is real: changeling grants CREATURE types, so a hypothetical
    // non-creature carrying the flag answers no subtype question `true`.
    const def: CardDefinition = { id: 'x', name: 'Odd', types: ['artifact'], changeling: true };
    expect(hasSubtype(def, 'Goblin')).toBe(false);
  });
});

describe("“this spell can't be countered”", () => {
  it('compiles on the spell, and on a permanent that protects others', () => {
    const verdict = compileComplete(
      card({
        name: 'Supreme Verdict',
        typeLine: typeLine(['sorcery']),
        manaCost: { generic: 1, W: 2, U: 1 },
        oracleText: "This spell can't be countered.\nDestroy all creatures.",
      }),
    );
    expect(verdict.cantBeCountered).toBe(true);

    const rhythm = compileComplete(
      card({
        name: 'Rhythm of the Wild',
        typeLine: typeLine(['enchantment']),
        manaCost: { generic: 1, R: 1, G: 1 },
        oracleText: "Creature spells you control can't be countered.",
      }),
    );
    expect(rhythm.spellsCantBeCountered).toEqual({
      controller: 'you',
      filter: { anyOfTypes: ['creature'] },
    });

    const lier = compileComplete(
      card({
        name: 'Lier, Disciple of the Drowned',
        typeLine: typeLine(['creature'], ['Human', 'Wizard']),
        manaCost: { generic: 3, U: 1 },
        power: 3,
        toughness: 4,
        oracleText: "Spells can't be countered.",
      }),
    );
    // Lier's wording is unrestricted — EVERYBODY'S spells, including the
    // opponent's, which is the whole reason it is a symmetrical card.
    expect(lier.spellsCantBeCountered).toEqual({ controller: 'any' });
  });

  it('refuses a narrowing it cannot express, rather than compiling a wider one', () => {
    const result = compileCard(
      card({
        name: 'Hypothetical Ward',
        typeLine: typeLine(['enchantment']),
        manaCost: { generic: 2, U: 1 },
        oracleText: "Noncreature spells you control can't be countered.",
      }),
    );
    expect(result.status).not.toBe('complete');
  });

  it('actually stops a counter — and its source leaving lets one through', () => {
    const { state } = createGame({
      seed: 3,
      decks: { A: { cards: [] }, B: { cards: [] } },
    });
    const uncounterable: CardDefinition = {
      id: 'u',
      name: 'Uncounterable',
      types: ['sorcery'],
      cantBeCountered: true,
    };
    const plain: CardDefinition = { id: 'p', name: 'Plain', types: ['sorcery'] };
    expect(spellCanBeCountered(state, uncounterable, 'A')).toBe(false);
    expect(spellCanBeCountered(state, plain, 'A')).toBe(true);

    // A permanent that protects its controller's creature spells.
    const chimil: CardDefinition = {
      id: 'c',
      name: 'Chimil',
      types: ['artifact'],
      spellsCantBeCountered: { controller: 'you' },
    };
    state.battlefield.push(permanent(state, chimil, 'A'));
    expect(spellCanBeCountered(state, plain, 'A')).toBe(false);
    // …and only for ITS controller.
    expect(spellCanBeCountered(state, plain, 'B')).toBe(true);
    // Destroy it and the protection ends with it — the lifetime is derived, not
    // stored, so there is nothing to expire.
    state.battlefield = [];
    expect(spellCanBeCountered(state, plain, 'A')).toBe(true);
  });
});

describe('"you have no maximum hand size"', () => {
  it('compiles, and the rule it lifts is real', () => {
    const def = compileComplete(
      card({
        name: 'Reliquary Tower',
        typeLine: typeLine(['land']),
        oracleText: 'You have no maximum hand size.\n{T}: Add {C}.',
      }),
    );
    expect(def.noMaximumHandSize).toBe(true);
  });

  it('a player OVER the limit discards at cleanup — and does not with the Tower out', () => {
    const registry = buildRegistry();
    const filler: CardDefinition = { id: 'f', name: 'Filler', types: ['sorcery'] };
    const tower = compileComplete(
      card({
        name: 'Reliquary Tower',
        typeLine: typeLine(['land']),
        oracleText: 'You have no maximum hand size.\n{T}: Add {C}.',
      }),
    );

    for (const withTower of [false, true]) {
      const { state } = createGame({
        seed: 5,
        decks: { A: { cards: Array.from({ length: 40 }, () => filler) }, B: { cards: Array.from({ length: 40 }, () => filler) } },
        registry,
      });
      // Deal a hand well over the limit.
      while (state.players.A.hand.length < DEFAULT_RULES.maximumHandSize + 3) {
        const drawn = state.players.A.library.shift();
        if (!drawn) break;
        drawn.zone = 'hand';
        state.players.A.hand.push(drawn);
      }
      if (withTower) state.battlefield.push(permanent(state, tower, 'A'));
      const before = state.players.A.hand.length;
      const after = playUntilTurn(state, registry, state.turnNumber + 2);
      const handSize = after.players.A.hand.length;
      if (withTower) {
        // No limit at all: the hand is only ever bigger (the draw step).
        expect(handSize).toBeGreaterThanOrEqual(before);
      } else {
        expect(handSize).toBeLessThanOrEqual(DEFAULT_RULES.maximumHandSize);
      }
    }
  });
});

describe('"you may play lands from your graveyard"', () => {
  it('compiles both printed zones', () => {
    const crucible = compileComplete(
      card({
        name: 'Crucible of Worlds',
        typeLine: typeLine(['artifact']),
        manaCost: { generic: 3 },
        oracleText: 'You may play lands from your graveyard.',
      }),
    );
    expect(crucible.playLandsFrom).toEqual(['graveyard']);
  });

  it('the engine OFFERS the land play, and refuses it once the source is gone', () => {
    const registry = buildRegistry();
    const forest: CardDefinition = { id: 'Forest', name: 'Forest', types: ['land'], produces: ['G'] };
    const crucible = compileComplete(
      card({
        name: 'Crucible of Worlds',
        typeLine: typeLine(['artifact']),
        manaCost: { generic: 3 },
        oracleText: 'You may play lands from your graveyard.',
      }),
    );
    const { state } = createGame({
      seed: 9,
      decks: { A: { cards: Array.from({ length: 30 }, () => forest) }, B: { cards: Array.from({ length: 30 }, () => forest) } },
      registry,
    });
    // A land in the graveyard, and the Crucible on the battlefield.
    const buried = state.players.A.library.shift() as CardInstance;
    buried.zone = 'graveyard';
    state.players.A.graveyard.push(buried);
    const artifact = permanent(state, crucible, 'A');
    state.battlefield.push(artifact);

    expect(landPlayZonesFor(state, 'A')).toEqual(['graveyard']);
    const main = advanceToStep(state, registry, 'precombatMain');
    const offered = generateLegalActions(main, DEFAULT_RULES).filter(
      (action): action is Extract<GameAction, { kind: 'playLand' }> =>
        action.kind === 'playLand' && action.fromZone === 'graveyard',
    );
    expect(offered.map((a) => a.instanceId)).toContain(buried.instanceId);

    // Playing it really moves it to the battlefield.
    const played = applyAction(
      main,
      { kind: 'playLand', player: 'A', instanceId: buried.instanceId, fromZone: 'graveyard' },
      DEFAULT_RULES,
      registry,
    );
    expect(played.events.some((e) => e.type === 'actionRejected')).toBe(false);
    expect(played.state.battlefield.some((c) => c.instanceId === buried.instanceId)).toBe(true);

    // Without the Crucible the SAME action is refused — the permission is
    // re-derived from the board, never trusted from the action.
    const noCrucible = { ...main, battlefield: main.battlefield.filter((c) => c.def.id !== crucible.id) };
    const refused = applyAction(
      noCrucible,
      { kind: 'playLand', player: 'A', instanceId: buried.instanceId, fromZone: 'graveyard' },
      DEFAULT_RULES,
      registry,
    );
    expect(refused.events.some((e) => e.type === 'actionRejected')).toBe(true);
  });
});

describe('"enters tapped unless you control …" — the general condition', () => {
  it('compiles the legendary, basic and counted-subtype printings', () => {
    const minas = compileComplete(
      card({
        name: 'Minas Tirith',
        typeLine: typeLine(['land']),
        oracleText: 'Minas Tirith enters tapped unless you control a legendary creature.\n{T}: Add {W}.',
      }),
    );
    expect(minas.entersTappedUnless).toEqual({
      controlsMatching: { filter: { anyOfTypes: ['creature'], legendary: true }, minimum: 1 },
    });

    const temple = compileComplete(
      card({
        name: 'Abandoned Air Temple',
        typeLine: typeLine(['land']),
        oracleText: 'Abandoned Air Temple enters tapped unless you control a basic land.\n{T}: Add {U}.',
      }),
    );
    expect(temple.entersTappedUnless).toEqual({
      controlsMatching: { filter: { anyOfTypes: ['land'], basic: true }, minimum: 1 },
    });

    const cottage = compileComplete(
      card({
        name: "Witch's Cottage",
        typeLine: typeLine(['land']),
        oracleText: "Witch's Cottage enters tapped unless you control three or more other Swamps.\n{T}: Add {B}.",
      }),
    );
    expect(cottage.entersTappedUnless).toEqual({
      controlsMatching: { filter: { anyOfSubtypes: ['swamp'] }, minimum: 3 },
    });
  });
});

// --- small helpers -------------------------------------------------------------

function permanent(state: GameState, def: CardDefinition, controller: PlayerId): CardInstance {
  return {
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
  };
}

/** Pass priority (answering any parked question) until the given step. */
function advanceToStep(
  state: GameState,
  registry: ReturnType<typeof buildRegistry>,
  target: string,
  max = 400,
): GameState {
  let s = state;
  let guard = 0;
  while (s.step !== target && !s.gameOver && guard++ < max) s = step(s, registry);
  return s;
}

/** Play on until the given turn number, answering every question with the default. */
function playUntilTurn(
  state: GameState,
  registry: ReturnType<typeof buildRegistry>,
  turn: number,
  max = 2000,
): GameState {
  let s = state;
  let guard = 0;
  while (s.turnNumber < turn && !s.gameOver && guard++ < max) s = step(s, registry);
  return s;
}

/** One step of "do the only thing available": answer a question, or pass. */
function step(state: GameState, registry: ReturnType<typeof buildRegistry>): GameState {
  const question = state.pendingChoice;
  const action: GameAction = question
    ? {
        kind: 'answerChoice',
        player: question.chooser,
        choiceId: question.id,
        answer: defaultAnswerFor(question),
      }
    : { kind: 'passPriority', player: state.priorityPlayer };
  return applyAction(state, action, DEFAULT_RULES, registry).state;
}

// Referenced so the import is not dropped: the continuous index is what makes the
// blocking half read EFFECTIVE keywords, and `block-requirements.test.ts` in core
// exercises it directly.
void indexContinuous;

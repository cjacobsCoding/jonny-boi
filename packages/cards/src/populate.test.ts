/**
 * POPULATE (CR 701.32) — the copy-selector family's keyword action, compiled and
 * PLAYED.
 *
 * Populate is the residue the {X}/derived-value lane pinned on the owner's own
 * Trostani, Selesnya's Voice (DESIGN §3.149): *"`createTokenCopy` takes `self`,
 * `equipped` or a TARGET. Populate is a resolution-time CHOICE among your own
 * creature tokens — the copy-selector family, not this one."* This file is that
 * selector, and the reason it is a play test and not only a compile test is the
 * §3.148 lesson: Journey to Nowhere shipped as a one-way exile that every
 * compile-level check in the repo called `'complete'`.
 *
 * ## The three claims a compile-level assertion cannot make
 *
 * 1. **The candidate set is the printed one.** Populate says "a **creature**
 *    **token** **you control**" — three words, three ways to be wrong. A
 *    selector that dropped any one of them would copy an opponent's token, a
 *    nontoken creature, or a Treasure, and would look identical in a definition
 *    dump. So the menu itself is asserted, by name, against a board built to
 *    have one legal answer and three illegal ones.
 * 2. **It is a CHOICE, not a target.** Nothing is aimed as the ability goes on
 *    the stack, and a token with hexproof is a legal populate. The discriminator
 *    is that the ability is castable/activatable with no `targets` at all.
 * 3. **The chosen object may be gone by the time the answer arrives.**
 *    `chooseCards` parks; the board is live across that window. A populate whose
 *    token died must create nothing and must not throw — the outcome that can
 *    never play better than the printed card.
 *
 * ## And two the compiler alone must make
 *
 * The closed tails, and what happens to a printed sentence OUTSIDE them: a
 * populate tail nobody has read must REPORT, never quietly make an ordinary
 * untapped token with no drawback attached.
 */

import { describe, expect, it } from 'vitest';
import {
  applyAction,
  createGame,
  DEFAULT_RULES,
  type CardDefinition,
  type GameAction,
  type GameState,
  type InstanceId,
} from '@jonny-boi/core';
import { compileCard, type CompilableCard } from './compile/index.js';
import { buildRegistry } from './pool.js';

// ===========================================================================
// 1. THE COMPILER HALF — the printed cards, verbatim
// ===========================================================================

const NO_COST = { generic: 0, W: 0, U: 0, B: 0, R: 0, G: 0, C: 0, other: [] } as const;

function record(over: Partial<CompilableCard> & Pick<CompilableCard, 'name' | 'oracleText'>): CompilableCard {
  return {
    id: `test-${over.name.toLowerCase().replace(/\W+/g, '-')}`,
    manaCost: NO_COST,
    typeLine: { supertypes: [], types: ['Sorcery'], subtypes: [] },
    power: null,
    toughness: null,
    // Scryfall tags every one of these cards with the keyword, and the keyword
    // sweep is a separate gate from the rule table — a rule that compiles while
    // the sweep still reports leaves the card incomplete, which is exactly how
    // this looked before `PRIMITIVE_BACKED_KEYWORDS` learned the row.
    keywords: ['Populate'],
    ...over,
  } as CompilableCard;
}

const blockers = (card: CompilableCard): readonly string[] =>
  (compileCard(card).missing ?? []).map((entry) => entry.text);

describe('the printed populate cards compile', () => {
  it("⚠️ TROSTANI, SELESNYA'S VOICE — the acceptance card, its whole printed text", () => {
    const result = compileCard(
      record({
        name: "Trostani, Selesnya's Voice",
        manaCost: { generic: 1, W: 2, U: 0, B: 0, R: 0, G: 1, C: 0, other: [] },
        typeLine: { supertypes: ['Legendary'], types: ['Creature'], subtypes: ['Dryad'] },
        power: 2,
        toughness: 5,
        oracleText:
          "Whenever another creature you control enters, you gain life equal to that creature's toughness.\n" +
          "{1}{G}{W}, {T}: Populate. (Create a token that's a copy of a creature token you control.)",
      }),
    );
    expect(result.missing, JSON.stringify(result.missing)).toEqual([]);
    expect(result.status).toBe('complete');
    // The populate is the ACTIVATED ability's body, and it aims at nothing —
    // claim 2 above, asserted where it is first observable.
    const ability = result.definition.activated?.[0];
    expect(ability?.effects[0]?.primitive).toBe('createTokenCopy');
    expect(ability?.effects[0]?.params?.chooseCreatureTokenYouControl).toBe(true);
    expect(ability?.effects[0]?.params?.targets).toBeUndefined();
  });

  it('the bare keyword compiles wherever it is printed — spell, activated body, trigger body', () => {
    // One rule, three printed homes, because the effect rule table is shared by
    // every clause compiler. Wake the Reflections, Vitu-Ghazi Guildmage and
    // Growing Ranks, each its real printed line.
    expect(blockers(record({ name: 'Wake the Reflections', oracleText: 'Populate.' }))).toEqual([]);
    expect(
      blockers(
        record({
          name: 'Vitu-Ghazi Guildmage',
          typeLine: { supertypes: [], types: ['Creature'], subtypes: ['Dryad', 'Shaman'] },
          power: 2,
          toughness: 2,
          oracleText: '{4}{G}{W}: Create a 3/3 green Centaur creature token.\n{2}{G}{W}: Populate.',
        }),
      ),
    ).toEqual([]);
    expect(
      blockers(
        record({
          name: 'Growing Ranks',
          typeLine: { supertypes: [], types: ['Enchantment'], subtypes: [] },
          oracleText: 'At the beginning of your upkeep, populate.',
        }),
      ),
    ).toEqual([]);
  });

  it('GHIRED, CONCLAVE EXILE — the entry words printed as a trailing SENTENCE', () => {
    const result = compileCard(
      record({
        name: 'Ghired, Conclave Exile',
        typeLine: { supertypes: ['Legendary'], types: ['Creature'], subtypes: ['Human', 'Shaman'] },
        power: 4,
        toughness: 4,
        oracleText:
          'When Ghired enters, create a 4/4 green Rhino creature token with trample.\n' +
          'Whenever Ghired attacks, populate. The token enters tapped and attacking.',
      }),
    );
    expect(result.missing, JSON.stringify(result.missing)).toEqual([]);
    const populate = result.definition.triggers?.find((t) =>
      t.effects.some((e) => e.params?.chooseCreatureTokenYouControl === true),
    );
    expect(populate?.effects[0]?.params).toMatchObject({ tapped: true, attacking: true });
  });

  it('DETERMINED ITERATION — the haste grant and the delayed sacrifice, both carried', () => {
    const result = compileCard(
      record({
        name: 'Determined Iteration',
        typeLine: { supertypes: [], types: ['Enchantment'], subtypes: [] },
        oracleText:
          'At the beginning of combat on your turn, populate. The token created this way gains haste. ' +
          'Sacrifice it at the beginning of the next end step.',
      }),
    );
    expect(result.missing, JSON.stringify(result.missing)).toEqual([]);
    const ref = result.definition.triggers?.[0]?.effects[0];
    expect(ref?.params).toMatchObject({
      chooseCreatureTokenYouControl: true,
      grantKeywords: { haste: true },
      delayedRemoval: 'sacrifice',
    });
    // ⚠️ The grant is a LAYER-6 grant, never folded into the copy — a second
    // copy of this token must not inherit the haste (CR 707.2). The
    // discriminator is that it rides `grantKeywords`, not `except`.
    expect(ref?.params?.except).toBeUndefined();
  });
});

describe('a populate the tables have NOT read still reports', () => {
  /**
   * The over-match guard. Every case here is a printed sentence whose meaning
   * the compiler does not carry, and the failure mode being pinned is the one
   * this repo's contract exists to prevent: compiling the word "populate" and
   * SILENTLY DROPPING the rest, which would ship a card strictly better than
   * printed — a hasty token with no sacrifice, an untapped token that should
   * have entered attacking.
   */
  it('"Populate X times." (Full Flowering) — a repeat COUNT nothing reads', () => {
    expect(blockers(record({ name: 'Full Flowering', oracleText: 'Populate X times.' }))).toEqual(['Populate X times.']);
  });

  it('a tail outside the closed ENTRY-WORD set is refused, not turned into a plain token', () => {
    const text = 'Populate. The token enters with a +1/+1 counter on it.';
    expect(blockers(record({ name: 'Probe Counters', oracleText: text }))).toEqual([text]);
  });

  it('a tail granting a keyword the flag table has no row for is refused', () => {
    const text = 'Populate. It gains flurgling.';
    expect(blockers(record({ name: 'Probe Flurgling', oracleText: text }))).toEqual([text]);
  });

  it('a trailing sentence that is not a tail at all is refused', () => {
    const text = 'Populate. You draw a card for each token you control.';
    expect(blockers(record({ name: 'Probe Draw', oracleText: text }))).toEqual([text]);
  });
});

describe('", then" is an ordered conjunction, and it is still a GUARDED split', () => {
  it("COURSERS' ACCORD — create, THEN populate, in that order", () => {
    const result = compileCard(
      record({
        name: "Coursers' Accord",
        oracleText: 'Create a 3/3 green Centaur creature token, then populate.',
      }),
    );
    expect(result.missing, JSON.stringify(result.missing)).toEqual([]);
    // ORDER IS THE MEANING: populating before the Centaur exists copies a
    // different board. A set-equality assertion would pass on either order.
    const primitives = result.definition.effects?.map((ref) => ref.primitive);
    expect(primitives).toEqual(['makeToken', 'createTokenCopy']);
  });

  it('⚠️ a BACK-REFERENCE across ", then" is still refused — the split is not a free pass', () => {
    // The right half names an object no rule can resolve on its own, so the cut
    // is abandoned and the card reports. This is the discriminator for the
    // separator being safe: remove the both-halves-compile guard and this card
    // would compile with the second sentence pointing at nothing.
    const text = "Exile target creature, then its controller draws a card.";
    expect(blockers(record({ name: 'Probe Backref', oracleText: text, keywords: [] }))).toEqual([text]);
  });

  it('" and " still wins when a sentence carries both joiners — nothing compiles differently', () => {
    const result = compileCard(
      record({ name: 'Probe Both', oracleText: 'Draw a card and create a Treasure token, then populate.' }),
    );
    expect(result.missing, JSON.stringify(result.missing)).toEqual([]);
    const primitives = result.definition.effects?.map((ref) => ref.primitive) ?? [];
    expect(primitives[primitives.length - 1]).toBe('createTokenCopy');
    expect(primitives).toHaveLength(3);
  });
});

// ===========================================================================
// 2. THE ENGINE HALF — populate, played
// ===========================================================================

const REGISTRY = buildRegistry();

const FOREST: CardDefinition = {
  id: 'test-forest',
  name: 'Forest',
  types: ['land'],
  subtypes: ['forest'],
  manaAbility: { produces: { G: 1 } },
};

/**
 * Wake the Reflections as the compiler emits it, with only its COST zeroed.
 *
 * The compiled `effects` are the thing under test and are untouched; paying
 * {1}{G} is not, and a test that spent four actions tapping lands would be
 * testing the mana system. Same shortcut `block-selectors.test.ts` takes with
 * Giant Growth, and for the same reason.
 */
const WAKE_THE_REFLECTIONS: CardDefinition = {
  ...compileCard(record({ name: 'Wake the Reflections', oracleText: 'Populate.' })).definition,
  cost: { generic: 0 },
};

function tokenDef(name: string, power = 1, toughness = 1): CardDefinition {
  return {
    id: `test-token-${name.toLowerCase().replace(/\W+/g, '-')}`,
    name,
    types: ['creature'],
    subtypes: ['soldier'],
    power,
    toughness,
    isToken: true,
  };
}

function nontokenCreature(name: string): CardDefinition {
  return { id: `test-${name.toLowerCase()}`, name, types: ['creature'], cost: { generic: 2 }, power: 3, toughness: 3 };
}

/** A Treasure-shaped TOKEN that is not a creature — the "creature" word's discriminator. */
const TREASURE_TOKEN: CardDefinition = {
  id: 'test-token-treasure',
  name: 'Treasure',
  types: ['artifact'],
  subtypes: ['treasure'],
  isToken: true,
};

function act(state: GameState, action: GameAction): GameState {
  const result = applyAction(state, action, DEFAULT_RULES, REGISTRY);
  const rejected = result.events.find((e) => e.type === 'actionRejected');
  if (rejected) throw new Error(`unexpected rejection: ${(rejected as { reason: string }).reason}`);
  return result.state;
}

function place(state: GameState, def: CardDefinition, controller: 'A' | 'B'): InstanceId {
  const id = state.nextInstanceId++;
  state.battlefield.push({
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
  });
  return id;
}

/** A seeded game at A's first main phase, both hands empty. */
function atMain(): GameState {
  const { state } = createGame({
    seed: 0x707_32,
    startingPlayer: 'A',
    registry: REGISTRY,
    decks: {
      A: { cards: Array.from({ length: 30 }, () => FOREST) },
      B: { cards: Array.from({ length: 30 }, () => FOREST) },
    },
  });
  state.players.A.hand = [];
  state.players.B.hand = [];
  let s = state;
  let guard = 0;
  while (s.step !== 'precombatMain' && !s.gameOver && guard++ < 80) {
    s = act(s, { kind: 'passPriority', player: s.priorityPlayer });
  }
  return s;
}

/** Cast the populate spell from A's hand; stop as soon as anything is asked. */
function castPopulate(state: GameState): GameState {
  const instanceId = state.nextInstanceId++;
  state.players.A.hand.push({
    instanceId,
    def: WAKE_THE_REFLECTIONS,
    controller: 'A',
    owner: 'A',
    zone: 'hand',
    tapped: false,
    summoningSick: false,
    damageMarked: 0,
    markedByDeathtouch: false,
    counters: {},
  });
  // NO `targets` — claim 2. The engine accepting this action is the assertion:
  // an ability compiled through the target path would be rejected here.
  let s = act(state, { kind: 'castSpell', player: 'A', instanceId });
  let guard = 0;
  while (s.stack.length > 0 && s.pendingChoice == null && !s.gameOver && guard++ < 40) {
    s = act(s, { kind: 'passPriority', player: s.priorityPlayer });
  }
  return s;
}

function settle(state: GameState): GameState {
  let s = state;
  let guard = 0;
  while (s.stack.length > 0 && s.pendingChoice == null && !s.gameOver && guard++ < 40) {
    s = act(s, { kind: 'passPriority', player: s.priorityPlayer });
  }
  return s;
}

const controlled = (state: GameState, player: 'A' | 'B'): readonly string[] =>
  state.battlefield.filter((c) => c.controller === player).map((c) => c.def.name);

describe('populate, played through the real engine', () => {
  /**
   * ⚠️ EVERY TEST BELOW PUTS **TWO** CREATURE TOKENS ON THE BOARD, and that is
   * load-bearing rather than incidental. Core settles a `min === max ===
   * candidates.length` question without asking (`choices.ts` — one legal answer
   * is not a decision), so a single-candidate populate resolves with
   * `pendingChoice` never set. A test written on one token would assert nothing
   * about the menu, and would keep passing if the candidate filter broke open.
   */
  it('⚠️ THE MENU IS THE PRINTED WORDS — two legal answers among three decoys', () => {
    const state = atMain();
    const saproling = place(state, tokenDef('Saproling'), 'A');
    const elf = place(state, tokenDef('Elf Warrior'), 'A');
    place(state, nontokenCreature('Grizzly Bears'), 'A'); // a creature, not a TOKEN
    place(state, TREASURE_TOKEN, 'A'); // a token, not a CREATURE
    place(state, tokenDef('Goblin'), 'B'); // a creature token, not YOURS
    const asked = castPopulate(state);
    const choice = asked.pendingChoice;
    expect(choice?.kind).toBe('selectCards');
    // Named, not counted: a candidate list of the right LENGTH built from the
    // wrong permanents would pass a length assertion.
    expect(
      [...(choice as { candidates: readonly { instanceId: InstanceId }[] }).candidates.map((c) => c.instanceId)].sort(),
    ).toEqual([saproling, elf].sort());
    // Not optional once a candidate exists — the printed word is "choose".
    expect((choice as { min: number; max: number }).min).toBe(1);
    expect((choice as { min: number; max: number }).max).toBe(1);
  });

  it('the answer is HONOURED — the copy is of the token that was chosen, not the other', () => {
    const state = atMain();
    place(state, tokenDef('Saproling'), 'A');
    const elf = place(state, tokenDef('Elf Warrior'), 'A');
    const asked = castPopulate(state);
    const choice = asked.pendingChoice;
    expect(choice).not.toBeNull();
    const answered = act(asked, {
      kind: 'answerChoice',
      player: choice!.chooser,
      choiceId: choice!.id,
      answer: { kind: 'selectCards', instanceIds: [elf] },
    });
    const done = settle(answered);
    // TWO Elf Warriors, still ONE Saproling. A primitive that copied the first
    // candidate instead of the chosen one would pass a "there are three
    // creatures now" assertion and fail this one.
    expect(controlled(done, 'A').filter((n) => n === 'Elf Warrior')).toHaveLength(2);
    expect(controlled(done, 'A').filter((n) => n === 'Saproling')).toHaveLength(1);
    // CR 111.1: a copy of a token is itself a token, so it ceases to exist when
    // it leaves. A copy that answered `isToken: false` would be a real card the
    // graveyard keeps.
    for (const permanent of done.battlefield.filter((c) => c.def.name === 'Elf Warrior')) {
      expect(permanent.def.isToken).toBe(true);
      expect(permanent.controller).toBe('A');
    }
  });

  it('⚠️ THE CHOSEN TOKEN DIED WHILE THE QUESTION WAS PARKED — no copy, no throw', () => {
    // The hazard the brief names, and the reason `populateSourceFor` re-reads the
    // battlefield after the answer instead of trusting the id. Delete that
    // re-read and this test mints a copy of an object the rules say is gone.
    const state = atMain();
    place(state, tokenDef('Saproling'), 'A');
    const elf = place(state, tokenDef('Elf Warrior'), 'A');
    const asked = castPopulate(state);
    const choice = asked.pendingChoice;
    expect(choice).not.toBeNull();
    // The board is live across the parked window: the chosen token leaves.
    asked.battlefield = asked.battlefield.filter((c) => c.instanceId !== elf);
    const answered = act(asked, {
      kind: 'answerChoice',
      player: choice!.chooser,
      choiceId: choice!.id,
      answer: { kind: 'selectCards', instanceIds: [elf] },
    });
    const done = settle(answered);
    expect(done.gameOver).toBeFalsy();
    expect(controlled(done, 'A').filter((n) => n === 'Elf Warrior')).toHaveLength(0);
    // And it did NOT fall back to the survivor: a populate whose choice is gone
    // creates nothing, rather than quietly copying whatever is left.
    expect(controlled(done, 'A').filter((n) => n === 'Saproling')).toHaveLength(1);
  });

  it('no creature tokens at all ⇒ a legal no-op that asks NOTHING (CR 701.32b)', () => {
    // Populate with nothing to copy is not a failed cast and not a stuck
    // question — the spell resolves and does nothing. A `min: 1` question with
    // an empty candidate list would hand a pilot a menu it cannot answer.
    const state = atMain();
    place(state, nontokenCreature('Grizzly Bears'), 'A');
    const after = castPopulate(state);
    expect(after.pendingChoice).toBeNull();
    const done = settle(after);
    expect(done.stack).toHaveLength(0);
    expect(controlled(done, 'A')).toEqual(['Grizzly Bears']);
  });
});

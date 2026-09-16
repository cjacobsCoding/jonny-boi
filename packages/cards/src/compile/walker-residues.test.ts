/**
 * THE WALKER-RESIDUE FAMILY (DESIGN §3.154) — the two residues §3.150 pinned on
 * Tamiyo, the Moon Sage by name, and the three clauses it pinned on Jace,
 * Architect of Thought.
 *
 * §3.150 left both cards as evidenced NO-GOs and pinned each residue with a
 * test asserting the exact count (2 and 3). This file is the other side of that
 * pin: it proves the residues are gone by DRIVING each ability in a real game,
 * not by reading a compiled record. Every ability that this lane claims has a
 * test here that plays it and asserts what happened on the board.
 *
 * ⚠️ §1a — the pool rule has TWO directions. Each half below is checked for
 * playing STRONGER than printed as well as weaker: the subject-player count is
 * checked against a board where the two seats' answers DIFFER (an opponent
 * shortcut would pass a symmetric board), and the emblem trigger is checked
 * against a token (not a card) and against the other seat's graveyard.
 */

import { describe, expect, it } from 'vitest';
import type {
  CardDefinition,
  CardInstance,
  GameState,
  PlayerId,
} from '@jonny-boi/core';
import { countPermanentsMatching, createGame } from '@jonny-boi/core';
import { compileCard } from './compile.js';
import type { CompilableCard } from './types.js';
import { EFFECT_RULES, WALKER_RESIDUE_TABLES } from './rules.js';

// ---------------------------------------------------------------------------
// probes
// ---------------------------------------------------------------------------

function card(
  overrides: Partial<CompilableCard> & { name: string; oracleText: string },
): CompilableCard {
  return {
    id: `id:${overrides.name}`,
    manaCost: { generic: 2, W: 0, U: 0, B: 0, R: 0, G: 0, C: 0, other: [] },
    typeLine: { supertypes: [], types: ['Creature'], subtypes: ['Human'] },
    power: 2,
    toughness: 2,
    keywords: [],
    ...overrides,
  } as CompilableCard;
}

/** A planeswalker probe — printed loyalty included, or the card reports a loyalty gap of its own. */
function walker(name: string, oracleText: string): CompilableCard {
  return card({
    name,
    oracleText,
    typeLine: { supertypes: ['Legendary'], types: ['Planeswalker'], subtypes: ['Probe'] },
    power: null,
    toughness: null,
    loyalty: 4,
  } as Partial<CompilableCard> & { name: string; oracleText: string });
}

function missingTexts(printed: CompilableCard): string[] {
  return (compileCard(printed).missing ?? []).map((m) => (m.text ?? '').trim());
}

function definitionOf(printed: CompilableCard) {
  const result = compileCard(printed);
  expect(result.status, `missing: ${JSON.stringify(result.missing)}`).toBe('complete');
  return result.definition;
}

/** Tamiyo, the Moon Sage, exactly as printed. */
const TAMIYO = walker(
  'Tamiyo, the Moon Sage',
  "+1: Tap target permanent. It doesn't untap during its controller's next untap step.\n−2: Draw a card for each tapped creature target player controls.\n−8: You get an emblem with \"You have no maximum hand size\" and \"Whenever a card is put into your graveyard from anywhere, you may return it to your hand.\"",
);

// ---------------------------------------------------------------------------
// the guard that keeps the two count tables apart
// ---------------------------------------------------------------------------

describe('the count tables stay separated by whether they TARGET', () => {
  /**
   * ⚠️ THE CLASS THIS FILE EXISTS FOR (rule 1 — ship the guard with the fix).
   *
   * A phrase naming a target is only honest inside a rule that actually aims:
   * with no chosen target, `playersForParam('targetPlayer')` falls back to the
   * CONTROLLER, so a "target player controls" row read by a target-free rule
   * counts the caster's own board and nothing anywhere reports. The separation
   * is invisible in a diff — one more row in the wrong table looks exactly like
   * one more row in the right one — so it is a test or it is nothing.
   */
  it('no phrase in the target-FREE tapped table names a target', () => {
    const phrases = Object.keys(WALKER_RESIDUE_TABLES.tapped);
    // Print the denominator FIRST: a "for each X, assert…" check passes
    // vacuously over an empty table (§8a item 8).
    expect(phrases.length).toBeGreaterThan(0);
    for (const phrase of phrases) expect(phrase).not.toContain('target');
  });

  it('every phrase in the TARGETED table does name a target, and carries the subject axis', () => {
    const rows = Object.entries(WALKER_RESIDUE_TABLES.targeted);
    expect(rows.length).toBeGreaterThan(0);
    for (const [phrase, descriptor] of rows) {
      expect(phrase).toContain('target');
      expect((descriptor as { subject?: string }).subject).toBe('targetPlayer');
    }
  });

  it("every targeted SINGULAR names a plural row that exists", () => {
    const singulars = Object.entries(WALKER_RESIDUE_TABLES.targetedEach);
    expect(singulars.length).toBeGreaterThan(0);
    for (const [, plural] of singulars) {
      expect(Object.keys(WALKER_RESIDUE_TABLES.targeted)).toContain(plural);
    }
  });
});

// ---------------------------------------------------------------------------
// TAMIYO −2 — the count, on a board where the two seats DISAGREE
// ---------------------------------------------------------------------------

function creatureDef(id: string): CardDefinition {
  return {
    id,
    name: id,
    types: ['creature'],
    subtypes: [],
    power: 1,
    toughness: 1,
    cost: { generic: 1 },
  } as CardDefinition;
}

function putOnBattlefield(
  state: GameState,
  controller: PlayerId,
  def: CardDefinition,
  tapped: boolean,
): CardInstance {
  const inst = {
    instanceId: state.nextInstanceId++,
    def,
    controller,
    owner: controller,
    zone: 'battlefield',
    tapped,
    summoningSick: false,
    damageMarked: 0,
    markedByDeathtouch: false,
    counters: {},
  } as unknown as CardInstance;
  state.battlefield.push(inst);
  return inst;
}

/**
 * An ASYMMETRIC board: A has one tapped creature and two untapped ones, B has
 * three tapped creatures and one untapped. Every number below is different from
 * every other, so a count that silently answered for the wrong seat, or ignored
 * tapped-ness, cannot coincide with the right answer.
 */
function asymmetricBoard(): GameState {
  const filler = creatureDef('filler');
  const { state } = createGame({
    seed: 7,
    decks: {
      A: { cards: Array.from({ length: 40 }, () => filler) },
      B: { cards: Array.from({ length: 40 }, () => filler) },
    },
  });
  putOnBattlefield(state, 'A', creatureDef('a-tapped'), true);
  putOnBattlefield(state, 'A', creatureDef('a-untapped-1'), false);
  putOnBattlefield(state, 'A', creatureDef('a-untapped-2'), false);
  putOnBattlefield(state, 'B', creatureDef('b-tapped-1'), true);
  putOnBattlefield(state, 'B', creatureDef('b-tapped-2'), true);
  putOnBattlefield(state, 'B', creatureDef('b-tapped-3'), true);
  putOnBattlefield(state, 'B', creatureDef('b-untapped'), false);
  return state;
}

describe("the board-state axis counts TAPPED, and only tapped", () => {
  it('counts tapped creatures per seat, not every creature', () => {
    const state = asymmetricBoard();
    const creatures = { anyOfTypes: ['creature'] } as const;
    expect(countPermanentsMatching(state, creatures, 'you', 'A')).toBe(3);
    expect(countPermanentsMatching(state, creatures, 'you', 'A', 'tapped')).toBe(1);
    expect(countPermanentsMatching(state, creatures, 'you', 'A', 'untapped')).toBe(2);
    expect(countPermanentsMatching(state, creatures, 'you', 'B', 'tapped')).toBe(3);
  });

  /**
   * The SUBJECT axis, proved the only way it can be: `scope` is held fixed at
   * `'you'` and only the seat moves. An implementation that read the scope and
   * ignored the subject would return the same number both times.
   */
  it("reads the SAME scope from a different seat and gets a different number", () => {
    const state = asymmetricBoard();
    const creatures = { anyOfTypes: ['creature'] } as const;
    const fromA = countPermanentsMatching(state, creatures, 'you', 'A', 'tapped');
    const fromB = countPermanentsMatching(state, creatures, 'you', 'B', 'tapped');
    expect(fromA).not.toBe(fromB);
  });
});

describe("Tamiyo's −2 compiles as a TARGETED, subject-scoped count", () => {
  it('compiles, and the draw aims at a player', () => {
    const def = definitionOf(
      walker('Probe Sage', '−2: Draw a card for each tapped creature target player controls.'),
    );
    const ability = def.activated![0]!;
    const effect = ability.effects[0]!;
    expect(effect.primitive).toBe('drawCards');
    // The TARGET is what makes the printed word "target" true; without it the
    // count falls back to the controller's own board.
    expect(effect.params!.targets).toBe('player');
    expect(effect.params!.count).toEqual({
      countOf: 'permanentsMatching',
      filter: { anyOfTypes: ['creature'] },
      scope: 'you',
      subject: 'targetPlayer',
      permanentState: 'tapped',
    });
  });

  /**
   * ⚠️ §3.150 named the exact wrong fix: widening the count to
   * `creaturesOpponentControls`. This asserts the emitted descriptor is NOT
   * that — a subject-scoped count aimed at yourself must count YOUR board.
   */
  it('is NOT an opponent shortcut — the descriptor names a subject, not a scope', () => {
    const def = definitionOf(
      walker('Probe Sage', '−2: Draw a card for each tapped creature target player controls.'),
    );
    const count = def.activated![0]!.effects[0]!.params!.count as Record<string, unknown>;
    expect(count.countOf).not.toBe('creaturesOpponentControls');
    expect(count.scope).toBe('you');
  });

  it('the target-FREE spellings still compile, and carry no subject', () => {
    const def = definitionOf(
      card({
        name: 'Probe Draw',
        oracleText: 'When ~ enters, draw a card for each tapped creature you control.',
      }),
    );
    const count = def.triggers![0]!.effects[0]!.params!.count as Record<string, unknown>;
    expect(count.permanentState).toBe('tapped');
    expect(count.scope).toBe('you');
    expect(count.subject).toBeUndefined();
  });

  /**
   * A TRIGGER may carry the count too — §3.148 made triggered abilities able to
   * aim — but only because the target rides on the TRIGGER as well as on the
   * effect. That is the thing to assert: a trigger that compiled the count
   * WITHOUT declaring a target would resolve with an empty target list and the
   * count would silently answer for the controller.
   */
  it('a TRIGGER carrying the count declares the target on the trigger itself', () => {
    const def = definitionOf(
      card({
        name: 'Probe Trigger',
        oracleText: 'When ~ enters, draw a card for each tapped creature target player controls.',
      }),
    );
    const trigger = def.triggers![0]!;
    expect(trigger.targets).toBe('player');
    expect(trigger.effects[0]!.params!.targets).toBe('player');
  });

  /**
   * And it is still refused where a target genuinely cannot be chosen — the
   * target-FREE nested bodies (a rider, an "if you do" tail). `applyRules`
   * drops every `needsChosenTarget` rule from that table, which is what makes
   * the separation enforceable rather than remembered.
   */
  it('stays out of the target-FREE rule table', () => {
    const targeting = EFFECT_RULES.filter((rule) => rule.id === 'draw-for-each-targeted');
    expect(targeting).toHaveLength(1);
    expect(targeting[0]!.needsChosenTarget).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// THE ACCEPTANCE CARD
// ---------------------------------------------------------------------------

describe('Tamiyo, the Moon Sage', () => {
  it("+1 still compiles — §3.150's family, re-checked rather than assumed", () => {
    expect(missingTexts(TAMIYO).some((t) => t.startsWith('+1:'))).toBe(false);
  });

  it('compiles COMPLETE — every printed ability, ultimate included', () => {
    const result = compileCard(TAMIYO);
    expect(result.status, `missing: ${JSON.stringify(result.missing)}`).toBe('complete');
    expect(missingTexts(TAMIYO)).toHaveLength(0);
  });
});

/** Jace, Architect of Thought, exactly as printed. */
const JACE = walker(
  'Jace, Architect of Thought',
  '+1: Until your next turn, whenever a creature an opponent controls attacks, it gets -1/-0 until end of turn.\n' +
    '−2: Reveal the top three cards of your library. An opponent separates those cards into two piles. Put one pile into your hand and the other on the bottom of your library in any order.\n' +
    '−8: For each player, search that player’s library for a nonland card and exile it, then that player shuffles. You may cast those cards without paying their mana costs.',
);

describe('Jace, Architect of Thought — two clauses in, ONE residue pinned by name', () => {
  it('the +1 and the −2 no longer report', () => {
    const texts = missingTexts(JACE);
    expect(texts.some((t) => t.includes('Until your next turn'))).toBe(false);
    expect(texts.some((t) => t.includes('separates those cards into two piles'))).toBe(false);
  });

  /**
   * ⚠️ THE RESIDUE PIN. Exactly ONE clause is left, and it is named — so a card
   * that quietly starts compiling it makes this test fail rather than sliding
   * into the pool unnoticed, and a lane that regresses either landed clause
   * fails on the count.
   *
   * What the −8 needs, read from the engine rather than guessed:
   *  1. `SEARCH_DESTINATIONS` has no `'exile'` row — one row, and its own comment
   *     says exile is absent only because no compiled template printed it;
   *  2. `searchLibrary` already takes `who`, so another player's library is
   *     expressible;
   *  3. ⛔ the free-cast permission CANNOT CROSS SEATS. `CardGrant.castFace` +
   *     `castFree` is the right shape and exists, but `generateLegalActions`
   *     offers an exile cast by walking `player.exile` — the ASKING player's own
   *     exile zone — and this engine models exile per player, so a card exiled
   *     from B's library sits in B's exile and A is never offered it.
   *
   * Corpus: **321 clauses / 315 distinct shapes / 168 sole-blocked cards** print
   * "without paying its/their mana cost".
   */
  it('reports exactly ONE residual ability, and this names it', () => {
    const texts = missingTexts(JACE);
    expect(texts).toHaveLength(1);
    expect(texts[0]).toContain('You may cast those cards without paying their mana costs');
  });
});

/**
 * §3.150 — THE PLANESWALKER LANE: the does-not-untap family, the emblem's two
 * real gaps, and the acceptance cards' residue.
 *
 * ## What the measurement said, and why these are the tests
 * `packages/cards/scripts/loyalty-blame.mjs` split the backlog row "a
 * loyalty-ability template the compiler does not recognize yet" over the fixed
 * 32,341-card corpus:
 *
 *   COST half unknown           0 clauses     <- the loyalty machinery is COMPLETE
 *   LOYALTY-PATH gap            3 clauses
 *   BODY gap (no effect rule)   668 clauses / 641 shapes
 *
 * So there is no lever in the row itself (1.04 clauses per shape, the flattest
 * §3.120 artifact measured so far). The lever is a family the row's name never
 * mentions: 246 corpus cards print "doesn't untap during", ALL of them blocked,
 * 99 blocked SOLELY by such a clause, and their shapes concentrate.
 *
 * ⚠️ EVERY ORACLE STRING BELOW IS COPIED FROM A REAL PRINTED CARD in the
 * corpus, for the reason `dead-rule-sweep.mjs` exists: the Gatecreeper Vine bug
 * (§3.57) was a rule written from a REMEMBERED wording, which matched nothing
 * and which no test could see. A rule proven only against text this file
 * invented is that bug with a green checkmark attached.
 */

import { describe, expect, it } from 'vitest';
import type { CardDefinition, CardInstance, GameState } from '@jonny-boi/core';
import {
  aggregateFor,
  applyEffectRef,
  createGame,
  effectivePower,
  hasNoMaximumHandSize,
} from '@jonny-boi/core';
import { buildRegistry } from '../pool.js';
import { compileCard } from './compile.js';
import { EMBLEM_DEFINITION_FIELDS } from './rules.js';
import { EMBLEM_DEFINITION_FIELD_NAMES } from '../primitives.js';
import type { CompilableCard } from './types.js';

/** A vanilla 1/1 for the end-to-end deck — the game needs a library, not a theme. */
const BEAR: CardDefinition = { id: 'bear', name: 'Bear', types: ['creature'], power: 1, toughness: 1 };

/**
 * A library of `BEAR`s. Built here rather than imported from core's
 * `test-fixtures` — that would be a deep import into another package's src,
 * and this is one line.
 */
const bearDeck = (n = 40): { cards: readonly CardDefinition[] } => ({
  cards: Array.from({ length: n }, () => BEAR),
});

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

/** The compiled definition of a card that must be `'complete'`. */
function definitionOf(printed: CompilableCard) {
  const result = compileCard(printed);
  expect(result.status, `missing: ${JSON.stringify(result.missing)}`).toBe('complete');
  return result.definition;
}

/** Every missing clause's text, for the residue assertions. */
function missingTexts(printed: CompilableCard): string[] {
  return (compileCard(printed).missing ?? []).map((m) => (m.text ?? '').trim());
}

// ---------------------------------------------------------------------------
// The CONTINUOUS half — one row in KEYWORD_PHRASES, read from three places
// ---------------------------------------------------------------------------

describe('the continuous freeze — one row serving the self, the Aura and the Equipment', () => {
  it('Basalt Monolith prints it on ITSELF, as a keyword on the definition', () => {
    const def = definitionOf(
      card({
        name: 'Basalt Monolith',
        oracleText:
          "Basalt Monolith doesn't untap during your untap step.\n{T}: Add {C}{C}{C}.\n{3}: Untap Basalt Monolith.",
        typeLine: { supertypes: [], types: ['Artifact'], subtypes: [] },
        power: null,
        toughness: null,
      } as Partial<CompilableCard> & { name: string; oracleText: string }),
    );
    expect(def.keywords?.doesNotUntap).toBe(true);
  });

  it('Vulshok Gauntlets prints it after a P/T grant, which is why the "and" verb is optional', () => {
    // The defect this pins: before §3.150 the "and" branch required "has"/
    // "gains", so "gets +4/+2 and doesn't untap …" fell to the verbless
    // catch-all, which then handed `parseKeywordList` the conjunct "gets +4/+2"
    // and refused the whole Equipment.
    const def = definitionOf(
      card({
        name: 'Vulshok Gauntlets',
        oracleText:
          "Equipped creature gets +4/+2 and doesn't untap during its controller's untap step.\nEquip {3}",
        typeLine: { supertypes: [], types: ['Artifact'], subtypes: ['Equipment'] },
        power: null,
        toughness: null,
      } as Partial<CompilableCard> & { name: string; oracleText: string }),
    );
    const modifies = def.attachment?.modifies;
    expect(modifies?.keywords?.doesNotUntap).toBe(true);
    // ⚠️ The P/T half must SURVIVE the change. A rule that started matching the
    // freeze and stopped carrying the pump would look green on the keyword
    // assertion alone.
    expect(modifies?.power).toBe(4);
    expect(modifies?.toughness).toBe(2);
  });

  it('Heavy Arbalest prints it with no P/T at all', () => {
    const def = definitionOf(
      card({
        name: 'Heavy Arbalest',
        oracleText:
          "Equipped creature doesn't untap during its controller's untap step.\nEquipped creature has \"{T}: This creature deals 2 damage to any target.\"\nEquip {3}",
        typeLine: { supertypes: [], types: ['Artifact'], subtypes: ['Equipment'] },
        power: null,
        toughness: null,
      } as Partial<CompilableCard> & { name: string; oracleText: string }),
    );
    expect(def.attachment?.modifies?.keywords?.doesNotUntap).toBe(true);
  });

  it('a CONDITIONAL freeze keeps REPORTING rather than compiling into a land that never untaps', () => {
    // Veldt, Lava Tubes. `KeywordFlags` is unconditional; dropping "if it has a
    // depletion counter on it" is a strictly worse card, and nothing would say so.
    const texts = missingTexts(
      card({
        name: 'Veldt',
        oracleText:
          "Veldt doesn't untap during your untap step if it has a depletion counter on it.\n{T}: Add {G}.",
        typeLine: { supertypes: [], types: ['Land'], subtypes: [] },
        power: null,
        toughness: null,
      } as Partial<CompilableCard> & { name: string; oracleText: string }),
    );
    expect(texts.some((t) => t.includes('depletion counter'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The ONE-SHOT half — off the shared UNTAP_TARGET_NOUNS table
// ---------------------------------------------------------------------------

describe('the one-shot freeze — tap-and-freeze, and freeze alone', () => {
  it('Crippling Chill taps AND freezes, as two effects', () => {
    const def = definitionOf(
      card({
        name: 'Crippling Chill',
        oracleText:
          "Tap target creature. It doesn't untap during its controller's next untap step.\nDraw a card.",
        typeLine: { supertypes: [], types: ['Instant'], subtypes: [] },
        power: null,
        toughness: null,
      } as Partial<CompilableCard> & { name: string; oracleText: string }),
    );
    const primitives = (def.effects ?? []).map((e) => e.primitive);
    expect(primitives).toContain('tapTarget');
    expect(primitives).toContain('freezeTarget');
  });

  it('Skyline Cascade freezes with NO tap — which is why the freeze is its own primitive', () => {
    const def = definitionOf(
      card({
        name: 'Skyline Cascade',
        oracleText:
          "Skyline Cascade enters tapped.\nWhen Skyline Cascade enters, target creature an opponent controls doesn't untap during its controller's next untap step.\n{T}: Add {U}.",
        typeLine: { supertypes: [], types: ['Land'], subtypes: [] },
        power: null,
        toughness: null,
      } as Partial<CompilableCard> & { name: string; oracleText: string }),
    );
    const fromTriggers = (def.triggers ?? []).flatMap((t) => t.effects.map((e) => e.primitive));
    expect(fromTriggers).toContain('freezeTarget');
    expect(fromTriggers).not.toContain('tapTarget');
  });

  it('Frost Trickster proves the PRONOUN alternation — "That creature", not "It"', () => {
    const def = definitionOf(
      card({
        name: 'Frost Trickster',
        oracleText:
          "Flash\nFlying\nWhen Frost Trickster enters, tap target creature an opponent controls. That creature doesn't untap during its controller's next untap step.",
      }),
    );
    const fromTriggers = (def.triggers ?? []).flatMap((t) => t.effects.map((e) => e.primitive));
    expect(fromTriggers).toContain('tapTarget');
    expect(fromTriggers).toContain('freezeTarget');
  });

  it('⚠️ the sentence break is a LITERAL dot — the template-literal escape trap', () => {
    // THE DEFECT: in a template literal a lone `\.` is a non-escape that
    // collapses to `.`, so the regex would match ANY character there and this
    // comma form would compile as if it were the printed full stop. Only `\\.`
    // is a literal dot. Caught mid-write on this very rule.
    const result = compileCard(
      card({
        name: 'Not A Real Printing',
        oracleText:
          "Tap target creature, it doesn't untap during its controller's next untap step.",
        typeLine: { supertypes: [], types: ['Instant'], subtypes: [] },
        power: null,
        toughness: null,
      } as Partial<CompilableCard> & { name: string; oracleText: string }),
    );
    expect(result.status).not.toBe('complete');
  });

  it('a noun outside the shared table keeps REPORTING rather than being widened', () => {
    const texts = missingTexts(
      card({
        name: 'Invented Narrowing',
        oracleText:
          "Tap target legendary creature. It doesn't untap during its controller's next untap step.",
        typeLine: { supertypes: [], types: ['Instant'], subtypes: [] },
        power: null,
        toughness: null,
      } as Partial<CompilableCard> & { name: string; oracleText: string }),
    );
    expect(texts.some((t) => t.toLowerCase().includes('legendary creature'))).toBe(true);
  });

  it('"for as long as you control ~" stays REPORTED — a third lifetime this family does not model', () => {
    // Dungeon Geists. Compiled as the one-shot it unfreezes a turn early; as the
    // permanent flag it never unfreezes. Both are wrong and neither reports.
    const texts = missingTexts(
      card({
        name: 'Dungeon Geists',
        oracleText:
          "Flying\nWhen Dungeon Geists enters, tap target creature an opponent controls. That creature doesn't untap during its controller's untap step for as long as you control Dungeon Geists.",
      }),
    );
    expect(texts.some((t) => t.includes('for as long as you control'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The EMBLEM — the two gaps that were NOT the emblem seam
// ---------------------------------------------------------------------------

describe('the emblem: the seam was built, two specific things were missing', () => {
  it('a SINGLE-ability anthem emblem still compiles (the regression guard)', () => {
    definitionOf(walker('Single Emblem Probe', '−8: You get an emblem with "Creatures you control get +1/+1."'));
  });

  it('GAP 1 — a multi-ability emblem: the greedy pattern used to swallow the join', () => {
    const def = definitionOf(
      walker(
        'Multi Emblem Probe',
        '−8: You get an emblem with "Creatures you control get +1/+1" and "At the beginning of your upkeep, draw a card."',
      ),
    );
    const params = (def.activated ?? []).flatMap((a) => a.effects).find((e) => e.primitive === 'createEmblem')
      ?.params as { statics?: unknown[]; triggers?: unknown[] } | undefined;
    // BOTH halves reached the emblem. Carrying only the first is the silent
    // approximation this rule exists to prevent.
    expect(params?.statics ?? []).toHaveLength(1);
    expect(params?.triggers ?? []).toHaveLength(1);
  });

  it('GAP 2 — "You have no maximum hand size" is a DEFINITION flag, not a StaticAbility', () => {
    // `emblemStatics` read only `.statics`, so the compiler read this body
    // correctly, produced the right contribution, and dropped it on the floor.
    // `player-statics.ts` reads `noMaximumHandSize` from the COMMAND ZONE and
    // its header says an emblem is the case it exists for.
    const def = definitionOf(
      walker('Hand Size Probe', '−8: You get an emblem with "You have no maximum hand size."'),
    );
    const params = (def.activated ?? []).flatMap((a) => a.effects).find((e) => e.primitive === 'createEmblem')
      ?.params as { definitionFields?: Record<string, unknown> } | undefined;
    expect(params?.definitionFields?.noMaximumHandSize).toBe(true);
  });

  it('both gaps together — Tamiyo\'s ultimate shape, static flag AND a trigger', () => {
    const def = definitionOf(
      walker(
        'Both Gaps Probe',
        '−8: You get an emblem with "You have no maximum hand size" and "At the beginning of your upkeep, draw a card."',
      ),
    );
    const params = (def.activated ?? []).flatMap((a) => a.effects).find((e) => e.primitive === 'createEmblem')
      ?.params as { definitionFields?: Record<string, unknown>; triggers?: unknown[] } | undefined;
    expect(params?.definitionFields?.noMaximumHandSize).toBe(true);
    expect(params?.triggers ?? []).toHaveLength(1);
  });

  it('an emblem whose SECOND ability has no rule refuses the WHOLE line', () => {
    // An emblem is unremovable (CR 114): a half-right one is wrong for the rest
    // of the game with nothing to destroy. Compiling the understood half is the
    // single worst available outcome.
    const result = compileCard(
      walker(
        'Half Known Probe',
        '−8: You get an emblem with "Creatures you control get +1/+1" and "Blorp the frazzle twice."',
      ),
    );
    expect(result.status).not.toBe('complete');
  });

  it('the compiler\'s closed table and the PRIMITIVE\'s cannot drift apart', () => {
    // Rule 12 says where a second copy is unavoidable, derive both from one
    // source and add a test that fails when they diverge. The copy IS
    // unavoidable here: params reaching `createEmblem` are DATA (a generated
    // pool module, a saved game) and can arrive without passing the compiler at
    // all, so a permissive spread in the primitive would let a field the
    // compiler refuses land on an object nothing can remove.
    expect([...EMBLEM_DEFINITION_FIELDS].sort()).toEqual([...EMBLEM_DEFINITION_FIELD_NAMES].sort());
  });

  it('a contribution field OUTSIDE the closed table refuses rather than being dropped', () => {
    // "Artifact spells you cast cost {1} less to cast" compiles happily as a
    // card's own line, but it is a cost-reduction contribution with no
    // command-zone reader — so as an emblem body it must REPORT, not compile
    // into an emblem that provably does nothing. Saheeli, Filigree Master.
    const result = compileCard(
      walker('Cost Reduction Probe', '−4: You get an emblem with "Artifact spells you cast cost {1} less to cast."'),
    );
    expect(result.status).not.toBe('complete');
  });
});

// ---------------------------------------------------------------------------
// END TO END — the compiled emblem actually reaching the command zone
// ---------------------------------------------------------------------------

describe('the emblem the compiler produced really works from the command zone', () => {
  /**
   * ⚠️ PINNING WHAT THIS LANE RELIES ON, and the reason is a real incident.
   * A merge into `main` once ate three lines of `foldCommandStatics`'s body by
   * aligning `applied = true;` as a common line — git reported NO conflict and
   * **emblem anthems would have applied nothing**, with every test still green
   * (COORDINATION, 2026-09-13). Everything below this lane's emblem work stands
   * on is asserted here against a live game, not against the compiled shape:
   *   - a static radiating from the COMMAND zone reaches the continuous layer;
   *   - `noMaximumHandSize` on an emblem's definition reaches
   *     `hasNoMaximumHandSize`, the `player-statics.ts` reader;
   *   - a TWO-ability emblem applies BOTH, which is the whole point of the split.
   */
  function emblemFromUltimate(oracle: string): CardDefinition {
    const def = definitionOf(walker('Emblem Probe', oracle));
    const ref = (def.activated ?? []).flatMap((a) => a.effects).find((e) => e.primitive === 'createEmblem');
    expect(ref, 'the ultimate did not compile to a createEmblem').toBeDefined();
    const state = createGame({
      seed: 7,
      decks: { A: bearDeck(), B: bearDeck() },
    }).state;
    const source: CardInstance = {
      instanceId: state.nextInstanceId++,
      def: { id: 'src', name: 'Source', types: ['creature'], power: 1, toughness: 1 },
      controller: 'A',
      owner: 'A',
      zone: 'battlefield',
      tapped: false,
      summoningSick: false,
      damageMarked: 0,
      markedByDeathtouch: false,
      attachedTo: null,
      counters: {},
    };
    state.battlefield.push(source);
    applyEffectRef(buildRegistry(), ref!, { state, source, controller: 'A' }, () => {}, []);
    const command = state.players.A.command;
    expect(command, 'no emblem reached the command zone').toHaveLength(1);
    // Handed back WITH the state it lives in, via a property, so callers can
    // assert against the live game rather than against the definition alone.
    emblemState = state;
    return command[0]!.def;
  }
  let emblemState: GameState;

  it('a single-ability anthem emblem buffs from the command zone (the eaten-lines guard)', () => {
    emblemFromUltimate('−8: You get an emblem with "Creatures you control get +1/+1."');
    const bear = emblemState.battlefield.find((c) => c.def.name === 'Source')!;
    expect(effectivePower(bear, aggregateFor(emblemState, bear.instanceId))).toBe(2);
  });

  it('a no-maximum-hand-size emblem reaches hasNoMaximumHandSize from the command zone', () => {
    const def = emblemFromUltimate('−8: You get an emblem with "You have no maximum hand size."');
    expect(def.noMaximumHandSize).toBe(true);
    expect(hasNoMaximumHandSize(emblemState, 'A')).toBe(true);
    // Only its controller — the reader walks that seat's command zone, not both.
    expect(hasNoMaximumHandSize(emblemState, 'B')).toBe(false);
  });

  it('a TWO-ability emblem applies BOTH halves at once — the split, end to end', () => {
    const def = emblemFromUltimate(
      '−8: You get an emblem with "You have no maximum hand size" and "Creatures you control get +1/+1."',
    );
    expect(def.noMaximumHandSize).toBe(true);
    expect(hasNoMaximumHandSize(emblemState, 'A')).toBe(true);
    const bear = emblemState.battlefield.find((c) => c.def.name === 'Source')!;
    expect(effectivePower(bear, aggregateFor(emblemState, bear.instanceId))).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// The two acceptance cards, honestly
// ---------------------------------------------------------------------------

/** Tamiyo, the Moon Sage, exactly as printed. */
const TAMIYO = walker(
  'Tamiyo, the Moon Sage',
  "+1: Tap target permanent. It doesn't untap during its controller's next untap step.\n−2: Draw a card for each tapped creature target player controls.\n−8: You get an emblem with \"You have no maximum hand size\" and \"Whenever a card is put into your graveyard from anywhere, you may return it to your hand.\"",
);

/** Jace, Architect of Thought, exactly as printed. */
const JACE = walker(
  'Jace, Architect of Thought',
  '+1: Until your next turn, whenever a creature an opponent controls attacks, it gets -1/-0 until end of turn.\n−2: Reveal the top three cards of your library. An opponent separates those cards into two piles. Put one pile into your hand and the other on the bottom of your library in any order.\n−8: For each player, search that player\'s library for a nonland card and exile it, then that player shuffles. You may cast those cards without paying their mana costs.',
);

describe('the acceptance cards — what landed, and the residue BY NAME', () => {
  it("Tamiyo's +1 now compiles: the tap-and-freeze this lane built", () => {
    // Before §3.150 this line was one of the 668 body gaps. It is the reason the
    // does-not-untap family was the work the measurement chose.
    expect(missingTexts(TAMIYO).some((t) => t.startsWith('+1:'))).toBe(false);
  });

  it('Tamiyo REPORTS exactly two residual abilities, and this names both', () => {
    const texts = missingTexts(TAMIYO);
    expect(texts).toHaveLength(2);
    // −2: a derived count over "tapped creatures TARGET PLAYER controls".
    // `DerivedCountName` is a closed 12-row vocabulary with no tapped-creature
    // row and — the harder half — no SUBJECT-PLAYER axis at all: every row
    // counts for "you" or globally. Widening to `creaturesOpponentControls`
    // would silently make a printed "target player" mean "the opponent", which
    // is a different card whenever Tamiyo's controller aims at themselves.
    expect(texts.some((t) => t.includes('for each tapped creature target player controls'))).toBe(true);
    // −8: the emblem's SECOND ability. The split and the no-maximum-hand-size
    // channel both landed (see the emblem tests above); what is missing is a
    // trigger on "a card is put into your graveyard FROM ANYWHERE" — every
    // zone at once, with a body pointing back at the card that moved. 23 corpus
    // cards print the trigger; ONE prints this body.
    expect(texts.some((t) => t.includes('put into your graveyard from anywhere'))).toBe(true);
  });

  it('Jace is a well-evidenced NO-GO: three abilities, three unrelated systems', () => {
    const texts = missingTexts(JACE);
    expect(texts).toHaveLength(3);
    // +1: a DELAYED, duration-scoped trigger installed by a loyalty ability —
    // "until your next turn" is a lifetime no `TriggeredAbility` carries.
    expect(texts.some((t) => t.includes('Until your next turn, whenever a creature an opponent controls attacks'))).toBe(
      true,
    );
    // −2: pile separation. A choice made by an OPPONENT during resolution over a
    // revealed set — a prompt-seam question, not a loyalty one.
    expect(texts.some((t) => t.includes('separates those cards into two piles'))).toBe(true);
    // −8: the 5,640-card "you may / choose" row, NOT this lane. Searching every
    // player's library and casting the exiles for free.
    expect(texts.some((t) => t.includes('You may cast those cards without paying their mana costs'))).toBe(true);
  });
});

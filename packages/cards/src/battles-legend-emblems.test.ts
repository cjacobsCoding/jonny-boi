/**
 * The compiler half of battles, the legend rule and emblems — and, just as
 * importantly, the REFUSALS that keep the completeness claim honest.
 *
 * The contract this file exists to hold (see `compile/types.ts`): the compiler
 * never approximates. So each system is proven in two directions:
 *
 *   1. what the engine genuinely plays compiles `'complete'`, with the compiled
 *      data pinned so params cannot silently drift; and
 *   2. what it does NOT play stays `'incomplete'`, naming the exact system —
 *      most importantly a real SIEGE, whose reward is casting its BACK FACE and
 *      which therefore reports the castable-second-face gap even though the
 *      battle OBJECT behind it is complete.
 *
 * That second point is the whole reason `TYPES_WITHOUT_SYSTEM` being empty is
 * not the same claim as "every battle card is playable", and this file is where
 * the difference is made non-negotiable.
 */

import { describe, expect, it } from 'vitest';
import { compileCard, SECOND_CASTABLE_FACE_GAP, TYPES_WITHOUT_SYSTEM } from './compile/index.js';
import type { CompilableCard } from './compile/index.js';
import { CORE_PRIMITIVE_IDS } from './primitives.js';

/** A card record with the boring fields filled in. */
function card(overrides: Partial<CompilableCard> & Pick<CompilableCard, 'id' | 'name'>): CompilableCard {
  return {
    manaCost: { generic: 2, W: 0, U: 0, B: 0, R: 0, G: 0, C: 0, other: [] },
    typeLine: { supertypes: [], types: ['Creature'], subtypes: [] },
    oracleText: '',
    power: null,
    toughness: null,
    keywords: [],
    ...overrides,
  };
}

/** The Siege reminder line every printed battle carries. */
const SIEGE_REMINDER =
  'As this Siege enters, choose an opponent to protect it. You and others can attack it.';

describe('battles', () => {
  it('the engine has a system for every printed card type it can meet', () => {
    // Empty, and that is the honest state: planeswalker left when loyalty
    // landed, battle left when battles did. A real Siege is still reported, but
    // for a DIFFERENT and more specific reason — see below.
    expect(Object.keys(TYPES_WITHOUT_SYSTEM)).toHaveLength(0);
  });

  it('a battle compiles to the battle type with its printed defense', () => {
    const result = compileCard(
      card({
        id: 'battle-plain',
        name: 'Plain Siege',
        typeLine: { supertypes: [], types: ['Battle'], subtypes: ['Siege'] },
        oracleText: SIEGE_REMINDER,
        defense: 4,
      }),
    );
    expect(result.status).toBe('complete');
    expect(result.definition.types).toEqual(['battle']);
    expect(result.definition.defense).toBe(4);
    expect(result.definition.subtypes).toEqual(['siege']);
  });

  it("a Siege's protector line is vacuous at two seats, not reported", () => {
    // "Choose an opponent to protect it" has exactly one legal answer with two
    // players, and the engine already gives that answer structurally
    // (`protectorOf`). Reporting it would block a card the engine plays exactly
    // right; compiling it into a real question would be theatre.
    const result = compileCard(
      card({
        id: 'battle-reminder',
        name: 'Reminder Siege',
        typeLine: { supertypes: [], types: ['Battle'], subtypes: ['Siege'] },
        oracleText: SIEGE_REMINDER,
        defense: 3,
      }),
    );
    expect(result.missing).toEqual([]);
  });

  it('a battle with NO printed defense is REFUSED, never given a guessed number', () => {
    // A battle entering at the wrong defense takes the wrong number of attacks
    // to defeat, which is a different card. Same contract as walker loyalty.
    const result = compileCard(
      card({
        id: 'battle-nodef',
        name: 'Unknown Siege',
        typeLine: { supertypes: [], types: ['Battle'], subtypes: ['Siege'] },
        oracleText: SIEGE_REMINDER,
        defense: null,
      }),
    );
    expect(result.status).toBe('incomplete');
    expect(result.missing.some((m) => m.text === 'defense')).toBe(true);
  });

  it('a Siege record with NO per-face data still reports — there is no reward to compile', () => {
    // The Siege's reward (exile it, then you may cast the back face free from
    // exile) SHIPPED — `compile/split-cards.test.ts` pins a real two-faced Siege
    // compiling complete, and `core/split-cards.test.ts` plays it. What is left
    // under this gap is the residual it now names: a record carrying only the
    // combined `A // B` name, with nothing to compile the reward half FROM. A
    // Siege built from that would silently pay no reward when its last counter
    // came off, so it reports instead.
    const result = compileCard(
      card({
        id: 'battle-real',
        name: 'Invasion of Gobakhan // Lightshield Array',
        manaCost: { generic: 1, W: 1, U: 0, B: 0, R: 0, G: 0, C: 0, other: [] },
        typeLine: { supertypes: [], types: ['Battle'], subtypes: ['Siege'] },
        oracleText: SIEGE_REMINDER,
        defense: 3,
      }),
    );
    expect(result.status).toBe('incomplete');
    expect(result.missing.some((m) => m.missingEngineSystem === SECOND_CASTABLE_FACE_GAP)).toBe(true);
  });
});

describe('the Legendary supertype', () => {
  it('a legendary card carries the flag the legend rule keys on', () => {
    const result = compileCard(
      card({
        id: 'legend-1',
        name: 'Legendary Bear',
        typeLine: { supertypes: ['Legendary'], types: ['Creature'], subtypes: ['Bear'] },
        oracleText: '',
        power: 2,
        toughness: 2,
      }),
    );
    expect(result.status).toBe('complete');
    expect(result.definition.legendary).toBe(true);
  });

  it('a NONlegendary card does not carry it', () => {
    const result = compileCard(
      card({ id: 'plain-1', name: 'Plain Bear', oracleText: '', power: 2, toughness: 2 }),
    );
    expect(result.status).toBe('complete');
    expect(result.definition.legendary).toBeUndefined();
  });

  it('other supertypes are ignored rather than reported', () => {
    // "Basic" and "Snow" have no engine meaning here — a basic land's mana comes
    // from its land TYPES — so ignoring them changes nothing a game can observe.
    // Reporting them would block every basic land in the pool.
    const result = compileCard(
      card({
        id: 'basic-forest',
        name: 'Forest',
        manaCost: { generic: 0, W: 0, U: 0, B: 0, R: 0, G: 0, C: 0, other: [] },
        typeLine: { supertypes: ['Basic'], types: ['Land'], subtypes: ['Forest'] },
        oracleText: '',
      }),
    );
    expect(result.status).toBe('complete');
    expect(result.definition.legendary).toBeUndefined();
  });
});

describe('emblems', () => {
  it('the createEmblem primitive is registered', () => {
    expect(CORE_PRIMITIVE_IDS).toContain('createEmblem');
  });

  it('an ultimate that makes a STATIC emblem compiles complete', () => {
    // The emblem's ability goes through the ORDINARY static rule table, so it
    // can only carry things the engine genuinely runs.
    const result = compileCard(
      card({
        id: 'walker-static-emblem',
        name: 'Emblem Walker',
        manaCost: { generic: 3, W: 1, U: 0, B: 0, R: 0, G: 0, C: 0, other: [] },
        typeLine: { supertypes: ['Legendary'], types: ['Planeswalker'], subtypes: ['Gideon'] },
        oracleText: '−6: You get an emblem with "Creatures you control get +1/+1."',
        loyalty: 4,
      }),
    );
    expect(result.status).toBe('complete');
    const ultimate = result.definition.activated?.[0];
    expect(ultimate?.cost.loyalty).toBe(-6);
    const ref = ultimate?.effects[0];
    expect(ref?.primitive).toBe('createEmblem');
    // The statics are real `StaticAbility` records the continuous layer reads —
    // pinned, so a params rename cannot silently produce an inert emblem.
    const statics = ref?.params?.statics as ReadonlyArray<Record<string, unknown>>;
    expect(statics).toHaveLength(1);
    expect(statics[0]!.power).toBe(1);
    expect(statics[0]!.toughness).toBe(1);
    expect(statics[0]!.affects).toMatchObject({ controller: 'you' });
  });

  it('straight quotes are accepted as well as typographic ones', () => {
    const result = compileCard(
      card({
        id: 'walker-straight-quotes',
        name: 'Quote Walker',
        manaCost: { generic: 3, W: 1, U: 0, B: 0, R: 0, G: 0, C: 0, other: [] },
        typeLine: { supertypes: ['Legendary'], types: ['Planeswalker'], subtypes: ['Gideon'] },
        oracleText: '−6: You get an emblem with “Creatures you control get +1/+1.”',
        loyalty: 4,
      }),
    );
    expect(result.status).toBe('complete');
    expect(result.definition.activated?.[0]?.effects[0]?.primitive).toBe('createEmblem');
  });

  it('an emblem whose ability has NO rule is REFUSED, not created inert', () => {
    // The compiler contract in one test: an emblem body the engine cannot run
    // leaves the line reported rather than producing a command-zone object that
    // provably does nothing. The reported system names the emblem TEMPLATE — the
    // system exists, this wording does not have a rule.
    const result = compileCard(
      card({
        id: 'walker-unknown-emblem',
        name: 'Strange Walker',
        manaCost: { generic: 3, W: 1, U: 0, B: 0, R: 0, G: 0, C: 0, other: [] },
        typeLine: { supertypes: ['Legendary'], types: ['Planeswalker'], subtypes: ['Gideon'] },
        oracleText:
          '−6: You get an emblem with "Whenever a Zombie you control causes a Sliver to phase out, scry 7."',
        loyalty: 4,
      }),
    );
    expect(result.status).toBe('incomplete');
    expect(result.missing.some((m) => /emblem template/.test(m.missingEngineSystem))).toBe(true);
  });

  it('the emblem hint no longer claims the SYSTEM is missing', () => {
    // A stale hint is how the next agent gets sent to rebuild something that
    // already exists — the exact failure CLAUDE.md calls a bug with a blast
    // radius. The wording must read as a template gap now.
    const result = compileCard(
      card({
        id: 'walker-unknown-emblem-2',
        name: 'Another Walker',
        manaCost: { generic: 3, W: 1, U: 0, B: 0, R: 0, G: 0, C: 0, other: [] },
        typeLine: { supertypes: ['Legendary'], types: ['Planeswalker'], subtypes: ['Gideon'] },
        oracleText: '−6: You get an emblem with "Nonsense that has no rule."',
        loyalty: 4,
      }),
    );
    const emblemGap = result.missing.find((m) => /emblem/.test(m.missingEngineSystem));
    expect(emblemGap).toBeDefined();
    expect(emblemGap!.missingEngineSystem).not.toMatch(/command-zone object that persists/);
    expect(emblemGap!.missingEngineSystem).toMatch(/template the compiler does not recognize yet/);
  });
});

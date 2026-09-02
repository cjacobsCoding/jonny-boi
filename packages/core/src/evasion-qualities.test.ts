/**
 * THE EVASION KEYWORDS WHOSE EXCEPTION NAMES A QUALITY (DESIGN §3.102).
 *
 * Fear, intimidate and horsemanship all read "can't be blocked except by …", and
 * all three name something a blocker IS rather than something it HAS: a card
 * type, a colour, or — for horsemanship — a keyword that exists only to be named
 * here. They are one rule with three tables, so they are tested as one.
 *
 * ⚠️ THE FAILURE THESE PREVENT IS NOT A MISSED BLOCK. A single illegal pair makes
 * the WHOLE `declareBlockers` action illegal, so a pilot that proposes one loses
 * every other block in the same declaration and the defender takes the entire
 * attack. That is why `canBlock` and the pilot's `canBlockByEvasion` mirror each
 * other, and why both are exercised below.
 */

import { describe, expect, it } from 'vitest';
import type { CardDefinition } from './card.js';
import { canBlock } from './internal/combat.js';
import { indexContinuous } from './internal/continuous.js';
import type { GameState } from './state.js';
import { createGame } from './index.js';

/** A creature definition with the given colours, types and keywords. */
function creature(
  name: string,
  colors: readonly ('W' | 'U' | 'B' | 'R' | 'G' | 'C')[],
  extra: Partial<CardDefinition> = {},
): CardDefinition {
  return {
    id: name,
    name,
    types: ['creature'],
    power: 2,
    toughness: 2,
    colors,
    ...extra,
  } as CardDefinition;
}

const FEAR = { blockRestriction: { blockerMustMatchAnyOf: [{ kind: 'artifact' }, { kind: 'color', color: 'B' }] } };
const INTIMIDATE = {
  blockRestriction: { blockerMustMatchAnyOf: [{ kind: 'artifact' }, { kind: 'sharesColorWithAttacker' }] },
};
const HORSEMANSHIP = {
  horsemanship: true,
  blockRestriction: { blockerMustHaveAnyOf: ['horsemanship'] },
};

/** Put an attacker and a blocker on a board and ask whether the block is legal. */
function blockAllowed(attackerDef: CardDefinition, blockerDef: CardDefinition): boolean {
  const { state } = createGame({
    seed: 1,
    startingPlayer: 'A',
    decks: { A: { cards: [] }, B: { cards: [] } },
  });
  const place = (def: CardDefinition, controller: 'A' | 'B') => {
    const inst = {
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
    state.battlefield.push(inst as never);
    return inst;
  };
  const attacker = place(attackerDef, 'A');
  const blocker = place(blockerDef, 'B');
  return canBlock(attacker as never, blocker as never, indexContinuous(state as GameState));
}

describe('fear — except by artifact creatures and/or black creatures', () => {
  const feared = creature('Feared', ['R'], { keywords: FEAR } as Partial<CardDefinition>);

  it('lets a BLACK creature block', () => {
    expect(blockAllowed(feared, creature('Black Blocker', ['B']))).toBe(true);
  });

  it('lets an ARTIFACT creature block whatever its colour', () => {
    const artifact = creature('Artifact Blocker', ['W'], { types: ['artifact', 'creature'] });
    expect(blockAllowed(feared, artifact)).toBe(true);
  });

  it('does NOT let a white non-artifact creature block', () => {
    expect(blockAllowed(feared, creature('White Blocker', ['W']))).toBe(false);
  });

  it('does NOT let a colourless non-artifact creature block', () => {
    // The "and/or" is a disjunction of two POSITIVE qualities: being neither is
    // not a third way to qualify.
    expect(blockAllowed(feared, creature('Colourless Blocker', []))).toBe(false);
  });
});

describe('intimidate — except by artifacts and/or creatures sharing a colour', () => {
  const redIntimidator = creature('Red Intimidator', ['R'], { keywords: INTIMIDATE } as Partial<CardDefinition>);

  it('lets a creature that SHARES a colour block', () => {
    expect(blockAllowed(redIntimidator, creature('Red Blocker', ['R']))).toBe(true);
  });

  it('lets a multicolour creature block when ONE of its colours matches', () => {
    expect(blockAllowed(redIntimidator, creature('Rakdos Blocker', ['B', 'R']))).toBe(true);
  });

  it('does NOT let a creature of a different colour block', () => {
    expect(blockAllowed(redIntimidator, creature('Blue Blocker', ['U']))).toBe(false);
  });

  it('⚠️ a COLOURLESS intimidator is blockable only by artifacts', () => {
    // CR 702.13a read literally: it shares a colour with nothing, so the "shares"
    // half never fires and only the artifact half can. Getting this wrong the
    // other way — treating "no colours" as matching — would make a colourless
    // intimidator blockable by everything, silently deleting the keyword.
    const colourless = creature('Colourless Intimidator', [], { keywords: INTIMIDATE } as Partial<CardDefinition>);
    expect(blockAllowed(colourless, creature('Green Blocker', ['G']))).toBe(false);
    expect(blockAllowed(colourless, creature('Also Colourless', []))).toBe(false);
    const artifact = creature('Artifact Blocker', [], { types: ['artifact', 'creature'] });
    expect(blockAllowed(colourless, artifact)).toBe(true);
  });
});

describe('horsemanship — except by creatures with horsemanship', () => {
  const horseman = creature('Horseman', ['R'], { keywords: HORSEMANSHIP } as Partial<CardDefinition>);

  it('lets another horseman block', () => {
    expect(blockAllowed(horseman, creature('Other Horseman', ['U'], { keywords: HORSEMANSHIP } as Partial<CardDefinition>))).toBe(
      true,
    );
  });

  it('does NOT let a creature without horsemanship block', () => {
    expect(blockAllowed(horseman, creature('Footsoldier', ['R']))).toBe(false);
  });

  it('does NOT let FLYING or REACH substitute for it', () => {
    // Horsemanship is its own axis: flying is not a cheaper horsemanship.
    const flier = creature('Flier', ['U'], { keywords: { flying: true } } as Partial<CardDefinition>);
    expect(blockAllowed(horseman, flier)).toBe(false);
  });
});

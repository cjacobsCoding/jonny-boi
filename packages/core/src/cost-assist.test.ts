/**
 * COST ASSISTANCE — Convoke (CR 702.51), Improvise (CR 702.126), Delve (CR 702.66).
 *
 * One shape wearing three names: a resource other than mana pays one mana each
 * toward a spell. The planner is shared, so these tests are as much about the
 * SHARING as about any one keyword — a bug fixed in one and not the others is
 * exactly what a single table exists to prevent.
 *
 * What a wrong implementation gets wrong, in the order it hurts:
 *   - it taps EVERYTHING it legally could, rather than the minimum. All three
 *     mechanics are optional, the resources are not free (a convoked creature
 *     cannot block, a delved card is gone), and a planner that maximises is
 *     obeying the rules while throwing the game.
 *   - it assigns a coloured creature to generic and then cannot pay the pip.
 *   - it lets an improvising artifact or a delved card pay a coloured pip, which
 *     neither may do — only convoke's creature pays "one mana of that
 *     creature's color".
 */

import { describe, expect, it } from 'vitest';
import { planCostAssist } from './cost-assist.js';
import type { CardDefinition, GameState, ManaCost, ManaPool } from './index.js';

const EMPTY_POOL: ManaPool = { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 };

function pool(over: Partial<ManaPool> = {}): ManaPool {
  return { ...EMPTY_POOL, ...over };
}

function permanent(id: string, types: readonly string[], colors: readonly string[] = [], tapped = false) {
  return {
    instanceId: id,
    def: { id: `def:${id}`, name: id, types, colors } as unknown as CardDefinition,
    controller: 'A',
    owner: 'A',
    zone: 'battlefield',
    tapped,
    damageMarked: 0,
    markedByDeathtouch: false,
    summoningSick: false,
    counters: {},
  };
}

/** A board and a graveyard, which is all `planCostAssist` reads. */
function board(battlefield: unknown[], graveyard: unknown[] = []): GameState {
  return {
    battlefield,
    players: { A: { graveyard }, B: { graveyard: [] } },
  } as unknown as GameState;
}

function spell(costAssist: 'convoke' | 'improvise' | 'delve'): CardDefinition {
  return { id: 'x', name: 'Spell', types: ['sorcery'], costAssist } as unknown as CardDefinition;
}

describe('cost assistance taps the minimum, not the maximum', () => {
  it('does not plan at all when the pool already pays', () => {
    const state = board([permanent('c1', ['creature'], ['G']), permanent('c2', ['creature'], ['G'])]);
    const plan = planCostAssist(state, 'A', spell('convoke'), { generic: 1 } as ManaCost, pool({ G: 1 }));
    expect(plan).toBeUndefined();
  });

  it('taps only as many creatures as the pool leaves unpaid', () => {
    const state = board([
      permanent('c1', ['creature'], ['G']),
      permanent('c2', ['creature'], ['G']),
      permanent('c3', ['creature'], ['G']),
    ]);
    // {3} with one mana floating needs exactly two more.
    const plan = planCostAssist(state, 'A', spell('convoke'), { generic: 3 } as ManaCost, pool({ G: 1 }));
    expect(plan?.consumed).toHaveLength(2);
    expect(plan?.remaining.generic).toBe(1);
  });

  it('spends a coloured creature on the PIP it can pay, not on generic', () => {
    // {1}{G} with an empty pool: the green creature must take the {G}, or the
    // colourless one gets it and the pip is unpayable.
    const state = board([permanent('rock', ['creature'], []), permanent('bear', ['creature'], ['G'])]);
    const plan = planCostAssist(
      state,
      'A',
      spell('convoke'),
      { generic: 1, G: 1 } as ManaCost,
      pool(),
    );
    expect(plan?.consumed).toEqual(['bear', 'rock']);
    expect(plan?.remaining).toEqual({});
  });

  it('refuses when no assignment covers the coloured pip', () => {
    const state = board([permanent('rock1', ['creature'], []), permanent('rock2', ['creature'], [])]);
    const plan = planCostAssist(state, 'A', spell('convoke'), { G: 1 } as ManaCost, pool());
    expect(plan).toBeUndefined();
  });

  it('ignores tapped creatures and creatures another player controls', () => {
    const tapped = permanent('tapped', ['creature'], ['G'], true);
    const theirs = { ...permanent('theirs', ['creature'], ['G']), controller: 'B', owner: 'B' };
    const state = board([tapped, theirs]);
    expect(planCostAssist(state, 'A', spell('convoke'), { generic: 1 } as ManaCost, pool())).toBeUndefined();
  });

  it('improvise taps ARTIFACTS and pays generic only', () => {
    const state = board([permanent('a1', ['artifact']), permanent('c1', ['creature'], ['G'])]);
    expect(
      planCostAssist(state, 'A', spell('improvise'), { generic: 1 } as ManaCost, pool())?.consumed,
    ).toEqual(['a1']);
    // The green creature is not an artifact, and no artifact is green, so a
    // coloured pip is beyond improvise entirely.
    expect(planCostAssist(state, 'A', spell('improvise'), { G: 1 } as ManaCost, pool())).toBeUndefined();
  });

  it('delve spends GRAVEYARD cards, and pays generic only', () => {
    const state = board([], [permanent('g1', ['creature'], ['U']), permanent('g2', ['land'])]);
    const plan = planCostAssist(state, 'A', spell('delve'), { generic: 2 } as ManaCost, pool());
    expect(plan?.consumed).toEqual(['g1', 'g2']);
    expect(planCostAssist(state, 'A', spell('delve'), { U: 1 } as ManaCost, pool())).toBeUndefined();
  });

  it('plans nothing for a spell that has no assist at all', () => {
    const state = board([permanent('c1', ['creature'], ['G'])]);
    const plain = { id: 'x', name: 'Spell', types: ['sorcery'] } as unknown as CardDefinition;
    expect(planCostAssist(state, 'A', plain, { generic: 1 } as ManaCost, pool())).toBeUndefined();
  });
});

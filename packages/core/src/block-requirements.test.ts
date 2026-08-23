/**
 * BLOCK REQUIREMENTS (CR 509.1c/d) — the other half of declare-blockers.
 *
 * What is being pinned, and why each case is here rather than being obvious:
 *   - "must be blocked if able" really FORCES a block. A requirement that only
 *     sometimes forces one is worse than none, because a deck built around a lure
 *     would simulate as if the card did nothing while reporting that it worked.
 *   - "if able" is real: an attacker nobody can legally block requires nothing,
 *     and a menacing lure facing a single creature likewise requires nothing —
 *     that creature is not ABLE to block it in any legal declaration.
 *   - "all creatures able to block ~ do so" is STRICTLY stronger, and blocking
 *     with only some of them is illegal even though it satisfies the weaker
 *     printing.
 *   - the maximisation is a real maximisation: with two lures and one creature,
 *     satisfying either is legal and satisfying neither is not.
 *   - a requirement never overrides a RESTRICTION (CR 509.1d maximises *without
 *     violating* one), so a lure with flying is still not blocked by a groundling.
 *   - the whole apparatus is INERT when nothing on the board requires anything.
 *
 * The comparing RESTRICTIONS live here too — "except by creatures with haste"
 * (Gingerbrute), a power bound, and skulk — because they are the other thing a
 * per-pair check could not previously express, and both halves have to agree.
 */

import { describe, expect, it } from 'vitest';
import { canBlock, illegalBlockDeclaration } from './internal/combat.js';
import { forcedBlockAssignment } from './internal/block-solver.js';
import { indexContinuous } from './internal/continuous.js';
import { createGame } from './engine.js';
import { deckOf, landDef } from './test-fixtures.js';
import type { CardDefinition } from './card.js';
import type { CardInstance, GameState, PlayerId } from './state.js';

function creature(
  id: string,
  keywords?: CardDefinition['keywords'],
  power = 2,
  toughness = 2,
): CardDefinition {
  return { id, name: id, types: ['creature'], power, toughness, ...(keywords ? { keywords } : {}) };
}

function board(): GameState {
  const { state } = createGame({
    seed: 7,
    decks: { A: deckOf(landDef('Mountain', 'R'), 30), B: deckOf(landDef('Mountain', 'R'), 30) },
  });
  state.battlefield = [];
  state.continuous = [];
  return state;
}

function place(state: GameState, def: CardDefinition, controller: PlayerId): CardInstance {
  const instance: CardInstance = {
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
  state.battlefield.push(instance);
  return instance;
}

/** Everything the defender could have blocked with (untapped creatures). */
function defendersOf(state: GameState, player: PlayerId): CardInstance[] {
  return state.battlefield.filter((c) => c.controller === player && !c.tapped);
}

describe('"~ must be blocked if able"', () => {
  it('rejects a declaration that leaves it unblocked when a creature could', () => {
    const state = board();
    const lure = place(state, creature('Lure Target', { mustBeBlocked: true }), 'A');
    place(state, creature('Bear'), 'B');
    const problem = illegalBlockDeclaration(
      [lure],
      [],
      indexContinuous(state),
      defendersOf(state, 'B'),
    );
    expect(problem).toBeDefined();
    expect(problem).toContain('blocking requirements');
  });

  it('accepts the declaration that blocks it', () => {
    const state = board();
    const lure = place(state, creature('Lure Target', { mustBeBlocked: true }), 'A');
    const bear = place(state, creature('Bear'), 'B');
    expect(
      illegalBlockDeclaration(
        [lure],
        [{ blocker: bear.instanceId, attacker: lure.instanceId }],
        indexContinuous(state),
        defendersOf(state, 'B'),
      ),
    ).toBeUndefined();
  });

  it('requires only ONE blocker, leaving the rest of the team free', () => {
    const state = board();
    const lure = place(state, creature('Lure Target', { mustBeBlocked: true }), 'A');
    const other = place(state, creature('Other'), 'A');
    const first = place(state, creature('First'), 'B');
    const second = place(state, creature('Second'), 'B');
    expect(
      illegalBlockDeclaration(
        [lure, other],
        [
          { blocker: first.instanceId, attacker: lure.instanceId },
          { blocker: second.instanceId, attacker: other.instanceId },
        ],
        indexContinuous(state),
        defendersOf(state, 'B'),
      ),
    ).toBeUndefined();
  });

  it('requires nothing when NOBODY is able to block it — "if able" is real', () => {
    const state = board();
    const flier = place(state, creature('Flying Lure', { mustBeBlocked: true, flying: true }), 'A');
    place(state, creature('Groundling'), 'B');
    expect(
      illegalBlockDeclaration([flier], [], indexContinuous(state), defendersOf(state, 'B')),
    ).toBeUndefined();
  });

  it('requires nothing when a RESTRICTION makes the block impossible (menacing lure, one creature)', () => {
    // The interaction the rule exists for: menace needs two blockers, the
    // defender has one, so that one creature is not ABLE to block it at all and
    // no requirement is generated. An implementation that checked the
    // requirement without the restriction would demand an illegal declaration
    // and wedge the combat.
    const state = board();
    const lure = place(state, creature('Menacing Lure', { mustBeBlocked: true, menace: true }), 'A');
    place(state, creature('Lone'), 'B');
    expect(
      illegalBlockDeclaration([lure], [], indexContinuous(state), defendersOf(state, 'B')),
    ).toBeUndefined();
  });

  it('DOES force both blockers onto a menacing lure when two exist', () => {
    const state = board();
    const lure = place(state, creature('Menacing Lure', { mustBeBlocked: true, menace: true }), 'A');
    const one = place(state, creature('One'), 'B');
    const two = place(state, creature('Two'), 'B');
    expect(
      illegalBlockDeclaration([lure], [], indexContinuous(state), defendersOf(state, 'B')),
    ).toBeDefined();
    expect(
      illegalBlockDeclaration(
        [lure],
        [
          { blocker: one.instanceId, attacker: lure.instanceId },
          { blocker: two.instanceId, attacker: lure.instanceId },
        ],
        indexContinuous(state),
        defendersOf(state, 'B'),
      ),
    ).toBeUndefined();
  });

  it('is satisfied by blocking EITHER of two lures when only one creature is free', () => {
    // The maximisation, at its smallest: two requirements, one creature. Max is
    // one, so blocking either lure is legal and blocking neither is not.
    const state = board();
    const first = place(state, creature('Lure A', { mustBeBlocked: true }), 'A');
    const second = place(state, creature('Lure B', { mustBeBlocked: true }), 'A');
    const lone = place(state, creature('Lone'), 'B');
    const index = indexContinuous(state);
    const defenders = defendersOf(state, 'B');
    expect(illegalBlockDeclaration([first, second], [], index, defenders)).toBeDefined();
    for (const target of [first, second]) {
      expect(
        illegalBlockDeclaration(
          [first, second],
          [{ blocker: lone.instanceId, attacker: target.instanceId }],
          index,
          defenders,
        ),
      ).toBeUndefined();
    }
  });

  it('demands BOTH be blocked when two creatures are free', () => {
    const state = board();
    const first = place(state, creature('Lure A', { mustBeBlocked: true }), 'A');
    const second = place(state, creature('Lure B', { mustBeBlocked: true }), 'A');
    const one = place(state, creature('One'), 'B');
    const two = place(state, creature('Two'), 'B');
    const index = indexContinuous(state);
    const defenders = defendersOf(state, 'B');
    expect(
      illegalBlockDeclaration(
        [first, second],
        [{ blocker: one.instanceId, attacker: first.instanceId }],
        index,
        defenders,
      ),
    ).toBeDefined();
    expect(
      illegalBlockDeclaration(
        [first, second],
        [
          { blocker: one.instanceId, attacker: first.instanceId },
          { blocker: two.instanceId, attacker: second.instanceId },
        ],
        index,
        defenders,
      ),
    ).toBeUndefined();
  });

  it('ignores a TAPPED creature — it was never able to block', () => {
    const state = board();
    const lure = place(state, creature('Lure Target', { mustBeBlocked: true }), 'A');
    const tapped = place(state, creature('Tapped'), 'B');
    tapped.tapped = true;
    expect(
      illegalBlockDeclaration([lure], [], indexContinuous(state), defendersOf(state, 'B')),
    ).toBeUndefined();
  });
});

describe('"all creatures able to block ~ do so" (the Lure requirement)', () => {
  it('is not satisfied by one blocker when two are able', () => {
    const state = board();
    const lure = place(state, creature('Lure', { blockedByAllAble: true }), 'A');
    const one = place(state, creature('One'), 'B');
    place(state, creature('Two'), 'B');
    expect(
      illegalBlockDeclaration(
        [lure],
        [{ blocker: one.instanceId, attacker: lure.instanceId }],
        indexContinuous(state),
        defendersOf(state, 'B'),
      ),
    ).toBeDefined();
  });

  it('is satisfied when EVERY able creature blocks it', () => {
    const state = board();
    const lure = place(state, creature('Lure', { blockedByAllAble: true }), 'A');
    const one = place(state, creature('One'), 'B');
    const two = place(state, creature('Two'), 'B');
    expect(
      illegalBlockDeclaration(
        [lure],
        [
          { blocker: one.instanceId, attacker: lure.instanceId },
          { blocker: two.instanceId, attacker: lure.instanceId },
        ],
        indexContinuous(state),
        defendersOf(state, 'B'),
      ),
    ).toBeUndefined();
  });

  it('exempts a creature a RESTRICTION disqualifies (a flier, when the lure has no flying)', () => {
    // Only ABLE creatures are required, so a creature that cannot legally block
    // is not one — and a rule that ignored the restriction would demand a block
    // the engine itself refuses.
    const state = board();
    const lure = place(state, creature('Lure', { blockedByAllAble: true }), 'A');
    const ground = place(state, creature('Ground'), 'B');
    const cantBlock = place(state, creature('Shackled', { cantBlock: true }), 'B');
    expect(
      illegalBlockDeclaration(
        [lure],
        [{ blocker: ground.instanceId, attacker: lure.instanceId }],
        indexContinuous(state),
        defendersOf(state, 'B'),
      ),
    ).toBeUndefined();
    expect(canBlock(lure, cantBlock, indexContinuous(state))).toBe(false);
  });
});

describe('the solver is inert when nothing requires anything', () => {
  it('answers with no requirement problem on an ordinary board', () => {
    const state = board();
    const plain = place(state, creature('Plain'), 'A');
    const bear = place(state, creature('Bear'), 'B');
    expect(
      illegalBlockDeclaration([plain], [], indexContinuous(state), defendersOf(state, 'B')),
    ).toBeUndefined();
    expect(
      forcedBlockAssignment([plain], [bear], indexContinuous(state)),
    ).toBeUndefined();
  });
});

describe('forcedBlockAssignment — the seam the AI blocks through', () => {
  it('names the creature a lure has spoken for', () => {
    const state = board();
    const lure = place(state, creature('Lure Target', { mustBeBlocked: true }), 'A');
    const bear = place(state, creature('Bear'), 'B');
    const forced = forcedBlockAssignment([lure], defendersOf(state, 'B'), indexContinuous(state));
    expect(forced).toEqual([{ blocker: bear.instanceId, attacker: lure.instanceId }]);
  });

  it('produces a declaration the engine accepts, for every board it answers', () => {
    // The contract that makes the seam worth having: whatever it returns must be
    // legal, or a pilot that trusts it proposes blocks the engine refuses.
    const state = board();
    const lure = place(state, creature('Lure', { blockedByAllAble: true }), 'A');
    const other = place(state, creature('Other', { mustBeBlocked: true }), 'A');
    place(state, creature('One'), 'B');
    place(state, creature('Two'), 'B');
    place(state, creature('Three'), 'B');
    const index = indexContinuous(state);
    const defenders = defendersOf(state, 'B');
    const forced = forcedBlockAssignment([lure, other], defenders, index);
    expect(forced).toBeDefined();
    expect(illegalBlockDeclaration([lure, other], forced ?? [], index, defenders)).toBeUndefined();
  });
});

describe('comparing block restrictions', () => {
  it('"except by creatures with haste" refuses a blocker without it (Gingerbrute)', () => {
    const state = board();
    const brute = place(
      state,
      creature('Gingerbrute', { blockRestriction: { blockerMustHaveAnyOf: ['haste'] } }),
      'A',
    );
    const slow = place(state, creature('Slow'), 'B');
    const hasty = place(state, creature('Hasty', { haste: true }), 'B');
    const index = indexContinuous(state);
    expect(canBlock(brute, slow, index)).toBe(false);
    expect(canBlock(brute, hasty, index)).toBe(true);
  });

  it('a power bound reads EFFECTIVE power, not the printed box', () => {
    const state = board();
    const evasive = place(
      state,
      creature('Evasive', { blockRestriction: { maxBlockerPower: 2 } }),
      'A',
    );
    const bear = place(state, creature('Bear', undefined, 2, 2), 'B');
    expect(canBlock(evasive, bear, indexContinuous(state))).toBe(true);
    // An anthem pushes the bear past the bound and it stops being a legal blocker.
    state.battlefield.push({
      instanceId: state.nextInstanceId++,
      def: {
        id: 'Anthem',
        name: 'Anthem',
        types: ['enchantment'],
        statics: [{ affects: { anyOfTypes: ['creature'], controller: 'you' }, power: 1, toughness: 1 }],
      },
      controller: 'B',
      owner: 'B',
      zone: 'battlefield',
      tapped: false,
      summoningSick: false,
      damageMarked: 0,
      markedByDeathtouch: false,
      counters: {},
    });
    expect(canBlock(evasive, bear, indexContinuous(state))).toBe(false);
  });

  it('skulk compares against the ATTACKER\'s own power', () => {
    const state = board();
    const skulker = place(
      state,
      creature('Skulker', { blockRestriction: { blockerPowerAtMostMine: true } }, 1, 1),
      'A',
    );
    const small = place(state, creature('Small', undefined, 1, 1), 'B');
    const big = place(state, creature('Big', undefined, 3, 3), 'B');
    const index = indexContinuous(state);
    expect(canBlock(skulker, small, index)).toBe(true);
    expect(canBlock(skulker, big, index)).toBe(false);
  });
});

/**
 * Blocking restrictions beyond the evasion keywords.
 *
 * Menace is the interesting one, and the reason it needed engine work rather
 * than a keyword flag: it is a constraint on the block DECLARATION, not on any
 * single attacker/blocker pair. Each blocker individually *can* block a
 * menacing creature — what the rule forbids is exactly one of them doing it. A
 * per-pair check cannot express that, so a naive implementation lets a single
 * blocker through and the keyword does nothing.
 *
 * That split is the whole design, and every restriction here is placed by it:
 *   - PER PAIR (`canBlock`): "can't be blocked", "~ can't block", flying/reach,
 *     protection. Each disqualifies one specific attacker/blocker pairing.
 *   - PER DECLARATION (`illegalBlockDeclaration`): menace and its general form
 *     "can't be blocked except by N or more creatures". Each blocker is
 *     individually fine; the assignment as a whole is not.
 *
 * Block REQUIREMENTS ("must be blocked if able") are deliberately absent — they
 * are the other half of CR 509.1c/d and need a solver, so cards printing one are
 * reported by the compiler instead.
 */

import { describe, expect, it } from 'vitest';
import { canBlock, illegalBlockDeclaration } from './internal/combat.js';
import { indexContinuous } from './internal/continuous.js';
import { applyAction, createGame, DEFAULT_RULES } from './engine.js';
import { createEffectRegistry } from './effects.js';
import { deckOf, landDef } from './test-fixtures.js';
import type { CardDefinition } from './card.js';
import type { GameAction } from './actions.js';
import type { CardInstance, GameState, PlayerId } from './state.js';

function creature(id: string, keywords?: CardDefinition['keywords']): CardDefinition {
  return { id, name: id, types: ['creature'], power: 2, toughness: 2, ...(keywords ? { keywords } : {}) };
}

function board(): GameState {
  const { state } = createGame({
    seed: 11,
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

describe("can't be blocked", () => {
  it('refuses every blocker', () => {
    const state = board();
    const attacker = place(state, creature('Slippery', { unblockable: true }), 'A');
    const blocker = place(state, creature('Wall'), 'B');
    expect(canBlock(attacker, blocker, indexContinuous(state))).toBe(false);
  });

  it('beats reach and flying, which it subsumes', () => {
    const state = board();
    const attacker = place(state, creature('Slippery', { unblockable: true }), 'A');
    const flyer = place(state, creature('Flyer', { flying: true, reach: true }), 'B');
    expect(canBlock(attacker, flyer, indexContinuous(state))).toBe(false);
  });
});

describe('menace', () => {
  it('rejects a declaration where exactly one creature blocks it', () => {
    const state = board();
    const attacker = place(state, creature('Menacer', { menace: true }), 'A');
    const blocker = place(state, creature('Lone'), 'B');

    const problem = illegalBlockDeclaration(
      [attacker],
      [{ blocker: blocker.instanceId, attacker: attacker.instanceId }],
      indexContinuous(state),
    );
    expect(problem).toBeDefined();
    expect(problem).toContain('menace');
  });

  it('allows two blockers', () => {
    const state = board();
    const attacker = place(state, creature('Menacer', { menace: true }), 'A');
    const one = place(state, creature('One'), 'B');
    const two = place(state, creature('Two'), 'B');

    expect(
      illegalBlockDeclaration(
        [attacker],
        [
          { blocker: one.instanceId, attacker: attacker.instanceId },
          { blocker: two.instanceId, attacker: attacker.instanceId },
        ],
        indexContinuous(state),
      ),
    ).toBeUndefined();
  });

  it('allows going UNBLOCKED — menace forbids one blocker, not zero', () => {
    const state = board();
    const attacker = place(state, creature('Menacer', { menace: true }), 'A');
    expect(illegalBlockDeclaration([attacker], [], indexContinuous(state))).toBeUndefined();
  });

  it('does not constrain a creature without it', () => {
    const state = board();
    const plain = place(state, creature('Plain'), 'A');
    const blocker = place(state, creature('Lone'), 'B');
    expect(
      illegalBlockDeclaration(
        [plain],
        [{ blocker: blocker.instanceId, attacker: plain.instanceId }],
        indexContinuous(state),
      ),
    ).toBeUndefined();
  });

  it('judges each attacker separately in a multi-attacker declaration', () => {
    const state = board();
    const menacer = place(state, creature('Menacer', { menace: true }), 'A');
    const plain = place(state, creature('Plain'), 'A');
    const one = place(state, creature('One'), 'B');
    const two = place(state, creature('Two'), 'B');

    // The plain attacker is legally blocked by one; the menacer by one is not.
    const problem = illegalBlockDeclaration(
      [menacer, plain],
      [
        { blocker: one.instanceId, attacker: plain.instanceId },
        { blocker: two.instanceId, attacker: menacer.instanceId },
      ],
      indexContinuous(state),
    );
    expect(problem).toBeDefined();
    expect(problem).toContain('Menacer');
  });
});

describe("~ can't block", () => {
  it('disqualifies the blocker whatever it would be blocking', () => {
    const state = board();
    const attacker = place(state, creature('Plain'), 'A');
    const recursive = place(state, creature('Gravecrawler', { cantBlock: true }), 'B');
    expect(canBlock(attacker, recursive, indexContinuous(state))).toBe(false);
  });

  it('is a restriction on the BLOCKER, so its own attacks are unaffected', () => {
    // The mirror check that keeps "can't block" from being read as "can't be
    // blocked": a creature that can't block is still perfectly blockable.
    const state = board();
    const recursive = place(state, creature('Gravecrawler', { cantBlock: true }), 'A');
    const wall = place(state, creature('Wall'), 'B');
    expect(canBlock(recursive, wall, indexContinuous(state))).toBe(true);
  });

  it('a granted "can\'t block" reaches a creature that printed none', () => {
    const state = board();
    const attacker = place(state, creature('Plain'), 'A');
    const blocker = place(state, creature('Ordinary'), 'B');
    state.continuous.push({
      id: state.nextInstanceId++,
      targetInstanceId: blocker.instanceId,
      sourceInstanceId: attacker.instanceId,
      keywords: { cantBlock: true },
      duration: 'endOfTurn',
    });
    expect(canBlock(attacker, blocker, indexContinuous(state))).toBe(false);
  });
});

describe("can't be blocked except by N or more creatures", () => {
  it('refuses a declaration one blocker short of the printed minimum', () => {
    const state = board();
    // Pathrazer of Ulamog: "can't be blocked except by three or more creatures".
    const attacker = place(state, creature('Pathrazer', { minBlockers: 3 }), 'A');
    const one = place(state, creature('One'), 'B');
    const two = place(state, creature('Two'), 'B');

    const problem = illegalBlockDeclaration(
      [attacker],
      [
        { blocker: one.instanceId, attacker: attacker.instanceId },
        { blocker: two.instanceId, attacker: attacker.instanceId },
      ],
      indexContinuous(state),
    );
    expect(problem).toBeDefined();
    expect(problem).toContain('3 or more');
  });

  it('accepts a declaration that meets it', () => {
    const state = board();
    const attacker = place(state, creature('Pathrazer', { minBlockers: 3 }), 'A');
    const blocks = [1, 2, 3].map((n) => ({
      blocker: place(state, creature(`B${n}`), 'B').instanceId,
      attacker: attacker.instanceId,
    }));
    expect(illegalBlockDeclaration([attacker], blocks, indexContinuous(state))).toBeUndefined();
  });

  it('accepts going unblocked, exactly as menace does', () => {
    const state = board();
    const attacker = place(state, creature('Pathrazer', { minBlockers: 3 }), 'A');
    expect(illegalBlockDeclaration([attacker], [], indexContinuous(state))).toBeUndefined();
  });

  it('takes the STRICTER of menace and a printed minimum, never the sum', () => {
    // A creature with menace AND "except by three or more" needs three, not five.
    const state = board();
    const attacker = place(state, creature('Both', { menace: true, minBlockers: 3 }), 'A');
    const blocks = [1, 2, 3].map((n) => ({
      blocker: place(state, creature(`B${n}`), 'B').instanceId,
      attacker: attacker.instanceId,
    }));
    expect(illegalBlockDeclaration([attacker], blocks, indexContinuous(state))).toBeUndefined();
    expect(
      illegalBlockDeclaration([attacker], blocks.slice(0, 2), indexContinuous(state)),
    ).toBeDefined();
  });
});

// --- end to end: the ENGINE refuses an illegal declaration -----------------------
//
// The unit tests above prove the rules; this proves they are actually WIRED. A
// restriction the engine never consults is a restriction that does not exist, and
// the failure is silent - every unit test still passes.

describe('the engine refuses an illegal block declaration', () => {
  const registry = createEffectRegistry();

  function pass(state: GameState): GameState {
    return applyAction(state, { kind: 'passPriority', player: state.priorityPlayer }, DEFAULT_RULES, registry).state;
  }

  function advanceToStep(state: GameState, target: string): GameState {
    let s = state;
    let guard = 0;
    while (s.step !== target && !s.gameOver && guard++ < 400) s = pass(s);
    return s;
  }

  function rejectionOf(state: GameState, action: GameAction): string | undefined {
    const rejected = applyAction(state, action, DEFAULT_RULES, registry).events.find(
      (e) => e.type === 'actionRejected',
    );
    return rejected ? (rejected as { reason: string }).reason : undefined;
  }

  /** A game in declare-blockers: A attacks with `attackerDef`, B holds `blockerCount` bears. */
  function combat(attackerDef: CardDefinition, blockerCount: number): {
    state: GameState;
    attacker: number;
    blockers: number[];
  } {
    const { state } = createGame({
      seed: 21,
      decks: { A: deckOf(landDef('Mountain', 'R'), 40), B: deckOf(landDef('Mountain', 'R'), 40) },
      registry,
    });
    const attacker = place(state, attackerDef, 'A');
    const blockers: number[] = [];
    for (let i = 0; i < blockerCount; i++) {
      blockers.push(place(state, creature(`Bear${i}`), 'B').instanceId);
    }
    let s = advanceToStep(state, 'declareAttackers');
    s = applyAction(s, { kind: 'declareAttackers', player: 'A', attackers: [attacker.instanceId] }, DEFAULT_RULES, registry).state;
    s = advanceToStep(s, 'declareBlockers');
    if (s.priorityPlayer !== 'B') s = pass(s);
    return { state: s, attacker: attacker.instanceId, blockers };
  }

  it('rejects one blocker on a menacing attacker, and accepts two', () => {
    const one = combat(creature('Menacer', { menace: true }), 2);
    expect(
      rejectionOf(one.state, {
        kind: 'declareBlockers',
        player: 'B',
        blocks: [{ blocker: one.blockers[0]!, attacker: one.attacker }],
      }),
    ).toMatch(/menace/i);

    const two = combat(creature('Menacer', { menace: true }), 2);
    expect(
      rejectionOf(two.state, {
        kind: 'declareBlockers',
        player: 'B',
        blocks: two.blockers.map((blocker) => ({ blocker, attacker: two.attacker })),
      }),
    ).toBeUndefined();
  });

  it('rejects a blocker that can\u2019t block, and accepts one that can', () => {
    const bad = combat(creature('Plain'), 0);
    const cantBlockId = place(bad.state, creature('Gravecrawler', { cantBlock: true }), 'B').instanceId;
    expect(
      rejectionOf(bad.state, {
        kind: 'declareBlockers',
        player: 'B',
        blocks: [{ blocker: cantBlockId, attacker: bad.attacker }],
      }),
    ).toBeDefined();

    const good = combat(creature('Plain'), 1);
    expect(
      rejectionOf(good.state, {
        kind: 'declareBlockers',
        player: 'B',
        blocks: [{ blocker: good.blockers[0]!, attacker: good.attacker }],
      }),
    ).toBeUndefined();
  });

  it('rejects two blockers on "except by three or more", and accepts three', () => {
    const few = combat(creature('Pathrazer', { minBlockers: 3 }), 3);
    expect(
      rejectionOf(few.state, {
        kind: 'declareBlockers',
        player: 'B',
        blocks: few.blockers.slice(0, 2).map((blocker) => ({ blocker, attacker: few.attacker })),
      }),
    ).toMatch(/3 or more/);

    const enough = combat(creature('Pathrazer', { minBlockers: 3 }), 3);
    expect(
      rejectionOf(enough.state, {
        kind: 'declareBlockers',
        player: 'B',
        blocks: enough.blockers.map((blocker) => ({ blocker, attacker: enough.attacker })),
      }),
    ).toBeUndefined();
  });
});

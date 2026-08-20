import { describe, expect, it } from 'vitest';
import {
  applyAction,
  createGame,
  generateLegalActions,
  indexContinuous,
  type CardInstance,
  type DeckList,
  type GameState,
  type InstanceId,
} from '@jonny-boi/core';
import { assessAttack, assessPosition, DEFAULT_TACTICAL_CONFIG, lethalAttackers } from './tactical.js';
import { creatureDef, landDef, putOnBattlefield } from './test-support.js';

const BEAR = creatureDef('bear', 2, 2);
const OGRE = creatureDef('ogre', 3, 3);
const GIANT = creatureDef('giant', 5, 5);
const WALL = creatureDef('wall', 0, 4);
const FLIER = creatureDef('flier', 4, 4, { keywords: { flying: true } });
const REACHER = creatureDef('reacher', 2, 3, { keywords: { reach: true } });
const TRAMPLER = creatureDef('trampler', 6, 6, { keywords: { trample: true } });
const DEATHTOUCH_TRAMPLER = creatureDef('deathtrample', 6, 6, {
  keywords: { trample: true, deathtouch: true },
});
const DEFENDER = creatureDef('defender', 4, 4, { keywords: { defender: true } });
const FIRST_STRIKE_KILLER = creatureDef('firststriker', 6, 1, { keywords: { firstStrike: true } });
const FIRST_STRIKE_WEAKLING = creatureDef('smallstriker', 1, 1, { keywords: { firstStrike: true } });
const FIRST_STRIKE_DEATHTOUCH = creatureDef('assassin', 1, 1, {
  keywords: { firstStrike: true, deathtouch: true },
});

function stubDeck(): DeckList {
  return { cards: Array.from({ length: 40 }, (_, i) => landDef(`L${i}`, 'R')) };
}

/**
 * The engine signals a refused action with an `actionRejected` EVENT, not a flag
 * on the result — a returned state that merely looks unchanged is not evidence
 * either way, so every legality assertion here reads the event.
 */
function wasRejected(result: { readonly events: readonly { readonly type: string }[] }): boolean {
  return result.events.some((e) => e.type === 'actionRejected');
}

function freshGame(): GameState {
  const { state } = createGame({ seed: 7, decks: { A: stubDeck(), B: stubDeck() } });
  state.players.A.hand = [];
  state.players.B.hand = [];
  return state;
}

describe('tactical solver — guaranteed damage', () => {
  it('a lone attacker facing no blockers is guaranteed to connect', () => {
    const state = freshGame();
    putOnBattlefield(state, 'A', [OGRE]);
    const a = assessAttack(state, 'A', 'now', indexContinuous(state));
    expect(a.maxDamage).toBe(3);
    expect(a.guaranteedDamage).toBe(3);
  });

  it('one blocker absorbs one non-trampling attacker, and only one', () => {
    const state = freshGame();
    putOnBattlefield(state, 'A', [OGRE, OGRE, OGRE]);
    putOnBattlefield(state, 'B', [WALL]);
    // 9 power, one blocker eats the biggest 3 → 6 guaranteed.
    expect(assessAttack(state, 'A', 'now', indexContinuous(state)).guaranteedDamage).toBe(6);
  });

  it('blockers cannot block twice — prevention is capped by the blocker count', () => {
    const state = freshGame();
    putOnBattlefield(state, 'A', [BEAR, BEAR, BEAR, BEAR]);
    putOnBattlefield(state, 'B', [WALL, WALL]);
    expect(assessAttack(state, 'A', 'now', indexContinuous(state)).guaranteedDamage).toBe(4);
  });

  it('a flier is only stopped by flying or reach', () => {
    const groundOnly = freshGame();
    putOnBattlefield(groundOnly, 'A', [FLIER]);
    putOnBattlefield(groundOnly, 'B', [OGRE, OGRE, OGRE]);
    expect(assessAttack(groundOnly, 'A', 'now', indexContinuous(groundOnly)).guaranteedDamage).toBe(4);

    const withReach = freshGame();
    putOnBattlefield(withReach, 'A', [FLIER]);
    putOnBattlefield(withReach, 'B', [REACHER]);
    expect(assessAttack(withReach, 'A', 'now', indexContinuous(withReach)).guaranteedDamage).toBe(0);
  });

  it('spends the scarce evasion-capable blockers on the fliers, not the ground crew', () => {
    // One reach blocker and two ground blockers against a flier and two ground
    // attackers: the greedy must not waste the reacher on a ground creature.
    const state = freshGame();
    putOnBattlefield(state, 'A', [FLIER, BEAR, BEAR]);
    putOnBattlefield(state, 'B', [REACHER, WALL, WALL]);
    expect(assessAttack(state, 'A', 'now', indexContinuous(state)).guaranteedDamage).toBe(0);
  });

  it('trample spills the excess past the blocker', () => {
    const state = freshGame();
    putOnBattlefield(state, 'A', [TRAMPLER]);
    putOnBattlefield(state, 'B', [WALL]);
    // 6 power, the 0/4 absorbs 4 → 2 tramples through.
    expect(assessAttack(state, 'A', 'now', indexContinuous(state)).guaranteedDamage).toBe(2);
  });

  it('a deathtouch trampler is absorbed one point per blocker (CR 702.2c)', () => {
    const state = freshGame();
    putOnBattlefield(state, 'A', [DEATHTOUCH_TRAMPLER]);
    putOnBattlefield(state, 'B', [GIANT]);
    // Deathtouch makes 1 damage lethal, so only 1 is "assigned" and 5 tramples.
    expect(assessAttack(state, 'A', 'now', indexContinuous(state)).guaranteedDamage).toBe(5);
  });

  it('a first-striking blocker that kills the trampler stops ALL of its damage', () => {
    // The one shape where "absorb its toughness, spill the rest" invents a lethal
    // that is not there: the trampler is dead before it assigns anything.
    const state = freshGame();
    putOnBattlefield(state, 'A', [TRAMPLER]);
    putOnBattlefield(state, 'B', [FIRST_STRIKE_KILLER]);
    expect(assessAttack(state, 'A', 'now', indexContinuous(state)).guaranteedDamage).toBe(0);
  });

  it('a first-striker that CANNOT kill the trampler does not stop it', () => {
    const state = freshGame();
    putOnBattlefield(state, 'A', [TRAMPLER]);
    putOnBattlefield(state, 'B', [FIRST_STRIKE_WEAKLING]);
    // 1/1 first striker: absorbs 1, five tramples through.
    expect(assessAttack(state, 'A', 'now', indexContinuous(state)).guaranteedDamage).toBe(5);
  });

  it('a first-striking DEATHTOUCH blocker stops a trampler at any size', () => {
    const state = freshGame();
    putOnBattlefield(state, 'A', [TRAMPLER]);
    putOnBattlefield(state, 'B', [FIRST_STRIKE_DEATHTOUCH]);
    expect(assessAttack(state, 'A', 'now', indexContinuous(state)).guaranteedDamage).toBe(0);
  });

  it('damage already marked on a blocker lowers what it can absorb from a trampler', () => {
    const state = freshGame();
    putOnBattlefield(state, 'A', [TRAMPLER]);
    const [wall] = putOnBattlefield(state, 'B', [WALL]);
    (wall as CardInstance).damageMarked = 3;
    expect(assessAttack(state, 'A', 'now', indexContinuous(state)).guaranteedDamage).toBe(5);
  });
});

describe('tactical solver — who may attack and who may block', () => {
  it('ignores tapped and summoning-sick creatures for an attack NOW', () => {
    const state = freshGame();
    const [tapped, sick] = putOnBattlefield(state, 'A', [OGRE, OGRE, OGRE]);
    (tapped as CardInstance).tapped = true;
    (sick as CardInstance).summoningSick = true;
    expect(assessAttack(state, 'A', 'now', indexContinuous(state)).attackerCount).toBe(1);
  });

  it('counts them for an attack NEXT turn — they untap and settle', () => {
    const state = freshGame();
    const [tapped, sick] = putOnBattlefield(state, 'A', [OGRE, OGRE, OGRE]);
    (tapped as CardInstance).tapped = true;
    (sick as CardInstance).summoningSick = true;
    expect(assessAttack(state, 'A', 'next', indexContinuous(state)).attackerCount).toBe(3);
  });

  it('a creature with defender never attacks', () => {
    const state = freshGame();
    putOnBattlefield(state, 'A', [DEFENDER]);
    expect(assessAttack(state, 'A', 'next', indexContinuous(state)).attackerCount).toBe(0);
  });

  it('a tapped creature cannot block, and a summoning-sick one can', () => {
    const tappedDefence = freshGame();
    putOnBattlefield(tappedDefence, 'A', [OGRE]);
    const [blocker] = putOnBattlefield(tappedDefence, 'B', [WALL]);
    (blocker as CardInstance).tapped = true;
    expect(assessAttack(tappedDefence, 'A', 'now', indexContinuous(tappedDefence)).guaranteedDamage).toBe(3);

    const sickDefence = freshGame();
    putOnBattlefield(sickDefence, 'A', [OGRE]);
    const [sick] = putOnBattlefield(sickDefence, 'B', [WALL]);
    (sick as CardInstance).summoningSick = true;
    expect(assessAttack(sickDefence, 'A', 'now', indexContinuous(sickDefence)).guaranteedDamage).toBe(0);
  });

  it('reads the DECLARED attackers once combat has begun, so the answer does not blink out', () => {
    // The defect this pins: attackers TAP when declared, so a solver that re-derives
    // "who can attack" from untapped creatures reports no attack at all one ply into
    // the combat it just recommended — and an evaluator built on that prices
    // attacking with a lethal board as LOSING the lethal bonus.
    const state = freshGame();
    const attackers = putOnBattlefield(state, 'A', [OGRE, OGRE]);
    state.players.B.life = 6;
    const before = assessAttack(state, 'A', 'now', indexContinuous(state));
    expect(before.lethal).toBe(true);

    for (const a of attackers) (a as CardInstance).tapped = true;
    state.activePlayer = 'A';
    state.step = 'declareBlockers';
    state.combat = {
      attackers: attackers.map((a) => a.instanceId),
      blocks: {},
      attackersDeclared: true,
      blockersDeclared: false,
    };
    const after = assessAttack(state, 'A', 'now', indexContinuous(state));
    expect(after.attackerCount).toBe(2);
    expect(after.lethal).toBe(true);
  });
});

describe('tactical solver — lethal', () => {
  it('fires only when the damage cannot be blocked out', () => {
    const state = freshGame();
    putOnBattlefield(state, 'A', [OGRE, OGRE, OGRE, OGRE]);
    putOnBattlefield(state, 'B', [WALL]);
    state.players.B.life = 9;
    expect(assessAttack(state, 'A', 'now', indexContinuous(state)).lethal).toBe(true);
    state.players.B.life = 10;
    expect(assessAttack(state, 'A', 'now', indexContinuous(state)).lethal).toBe(false);
  });

  it('does NOT fire on raw power that a full wall of blockers stops', () => {
    // The exact position the old `sum of untapped power >= their life` read got
    // wrong: 15 power against 6 life, and not one point can get through.
    const state = freshGame();
    putOnBattlefield(state, 'A', [GIANT, GIANT, GIANT]);
    putOnBattlefield(state, 'B', [WALL, WALL, WALL]);
    state.players.B.life = 6;
    expect(assessAttack(state, 'A', 'now', indexContinuous(state)).maxDamage).toBe(15);
    expect(assessAttack(state, 'A', 'now', indexContinuous(state)).lethal).toBe(false);
  });

  it('lethalAttackers returns a set the engine actually accepts', () => {
    const state = freshGame();
    putOnBattlefield(state, 'A', [OGRE, OGRE]);
    state.players.B.life = 6;
    state.step = 'declareAttackers';
    state.activePlayer = 'A';
    state.priorityPlayer = 'A';
    state.combat = { attackers: [], blocks: {}, attackersDeclared: false, blockersDeclared: false };

    const legal = generateLegalActions(state);
    const offered = legal.find((a) => a.kind === 'declareAttackers') as
      | Extract<(typeof legal)[number], { kind: 'declareAttackers' }>
      | undefined;
    expect(offered).toBeDefined();
    const attackers = lethalAttackers(
      state,
      'A',
      indexContinuous(state),
      DEFAULT_TACTICAL_CONFIG,
      offered!.attackers,
    );
    expect(attackers).toBeDefined();

    const result = applyAction(state, { kind: 'declareAttackers', player: 'A', attackers: [...attackers!] });
    expect(wasRejected(result)).toBe(false);
    expect(result.state.combat?.attackersDeclared).toBe(true);
  });

  it('restricting to the engine-offered list is what makes the answer playable', () => {
    // A creature the engine would not offer (here: already tapped) must not appear
    // in a declaration, and the guarantee must be computed over the OFFERED list —
    // intersecting afterwards could silently weaken it.
    const state = freshGame();
    const [tapped, ready] = putOnBattlefield(state, 'A', [OGRE, OGRE]);
    (tapped as CardInstance).tapped = true;
    state.players.B.life = 3;
    const restricted = lethalAttackers(state, 'A', indexContinuous(state), DEFAULT_TACTICAL_CONFIG, [
      (ready as CardInstance).instanceId,
    ]);
    expect(restricted).toEqual([(ready as CardInstance).instanceId]);
  });

  it('reads continuous effects when given the index — an anthem can create the kill', () => {
    const state = freshGame();
    const [bear] = putOnBattlefield(state, 'A', [BEAR]);
    state.players.B.life = 3;
    expect(assessAttack(state, 'A', 'now', indexContinuous(state)).lethal).toBe(false);
    (bear as CardInstance).counters = { '+1/+1': 1 };
    expect(assessAttack(state, 'A', 'now', indexContinuous(state)).lethal).toBe(true);
  });
});

describe('tactical solver — threat and clock', () => {
  it('sees the crack-back a player who taps out for an attack cannot block', () => {
    const state = freshGame();
    const mine = putOnBattlefield(state, 'A', [OGRE, OGRE, OGRE]);
    putOnBattlefield(state, 'B', [OGRE, OGRE, OGRE]);
    state.players.A.life = 5;

    const held = assessPosition(state, 'A', indexContinuous(state));
    expect(held.threat.lethal).toBe(false);

    for (const c of mine) (c as CardInstance).tapped = true;
    const tappedOut = assessPosition(state, 'A', indexContinuous(state));
    expect(tappedOut.threat.guaranteedDamage).toBe(9);
    expect(tappedOut.threat.lethal).toBe(true);
  });

  it('a board that cannot break through saturates at the clock cap rather than reporting infinity', () => {
    const state = freshGame();
    putOnBattlefield(state, 'A', [BEAR]);
    putOnBattlefield(state, 'B', [WALL]);
    const a = assessAttack(state, 'A', 'now', indexContinuous(state));
    expect(a.guaranteedDamage).toBe(0);
    expect(a.turnsToKill).toBe(DEFAULT_TACTICAL_CONFIG.maxClockTurns);
    expect(Number.isFinite(a.turnsToKill)).toBe(true);
  });

  it('the clock is turns of guaranteed damage, not turns of raw power', () => {
    const state = freshGame();
    putOnBattlefield(state, 'A', [OGRE, OGRE]);
    state.players.B.life = 12;
    expect(assessAttack(state, 'A', 'now', indexContinuous(state)).turnsToKill).toBe(2);
    putOnBattlefield(state, 'B', [WALL]);
    expect(assessAttack(state, 'A', 'now', indexContinuous(state)).turnsToKill).toBe(4);
  });
});

describe('tactical solver — the block-legality model matches the engine', () => {
  /**
   * The solver's whole cheapness rests on one claim: the only block the engine
   * rejects is a flier blocked by a creature with neither flying nor reach. If
   * that ever stops being true the greedy stops being optimal — so it is pinned
   * against the real engine here rather than against a comment.
   */
  function tryBlock(attackerDef: typeof FLIER, blockerDef: typeof OGRE): boolean {
    const state = freshGame();
    const [attacker] = putOnBattlefield(state, 'A', [attackerDef]);
    const [blocker] = putOnBattlefield(state, 'B', [blockerDef]);
    (attacker as CardInstance).tapped = true;
    state.step = 'declareBlockers';
    state.activePlayer = 'A';
    state.priorityPlayer = 'B';
    state.combat = {
      attackers: [(attacker as CardInstance).instanceId],
      blocks: {},
      attackersDeclared: true,
      blockersDeclared: false,
    };
    const result = applyAction(state, {
      kind: 'declareBlockers',
      player: 'B',
      blocks: [
        {
          blocker: (blocker as CardInstance).instanceId as InstanceId,
          attacker: (attacker as CardInstance).instanceId as InstanceId,
        },
      ],
    });
    return !wasRejected(result);
  }

  it('ground creatures block ground creatures', () => {
    expect(tryBlock(OGRE, BEAR)).toBe(true);
  });

  it('a ground creature cannot block a flier', () => {
    expect(tryBlock(FLIER, OGRE)).toBe(false);
  });

  it('flying and reach both block a flier', () => {
    expect(tryBlock(FLIER, FLIER)).toBe(true);
    expect(tryBlock(FLIER, REACHER)).toBe(true);
  });

  it('a flier may block a ground creature', () => {
    expect(tryBlock(OGRE, FLIER)).toBe(true);
  });
});

describe('tactical solver — hygiene', () => {
  it('does not leak scratch state between calls of different sizes', () => {
    // The reusable module-level buffers are the one way this file could produce a
    // wrong answer that no single-position test would catch.
    const big = freshGame();
    putOnBattlefield(big, 'A', [OGRE, OGRE, OGRE, OGRE, OGRE, OGRE]);
    putOnBattlefield(big, 'B', [WALL, WALL]);
    const bigFirst = assessAttack(big, 'A', 'now', indexContinuous(big)).guaranteedDamage;

    const small = freshGame();
    putOnBattlefield(small, 'A', [BEAR]);
    expect(assessAttack(small, 'A', 'now', indexContinuous(small)).guaranteedDamage).toBe(2);
    expect(assessAttack(big, 'A', 'now', indexContinuous(big)).guaranteedDamage).toBe(bigFirst);
  });

  it('an empty board is a well-formed, non-lethal assessment', () => {
    const state = freshGame();
    state.players.B.life = 0;
    const a = assessAttack(state, 'A', 'now', indexContinuous(state));
    expect(a.attackerCount).toBe(0);
    expect(a.lethal).toBe(false);
    expect(a.guaranteedDamage).toBe(0);
  });

  it('grows its buffers rather than truncating a wide board', () => {
    const state = freshGame();
    putOnBattlefield(state, 'A', Array.from({ length: 30 }, () => BEAR));
    expect(assessAttack(state, 'A', 'now', indexContinuous(state)).maxDamage).toBe(60);
  });
});

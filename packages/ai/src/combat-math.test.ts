/**
 * THE PILOT'S FIGHT MATHS — deathtouch, first strike, indestructible, marked
 * damage and trample (DESIGN §3.43).
 *
 * Every case here is a printed pool card, because the bug being pinned is
 * exactly "the pilot read the printed box and not the printed keyword": a
 * hand-built 1/2 with the deathtouch flag omitted would pass the old code too.
 */
import { describe, expect, it } from 'vitest';
import type { CardDefinition, CardInstance, GameState } from '@jonny-boi/core';
import { CARD_POOL } from '@jonny-boi/cards';
import { boardIndex } from './board-stats.js';
import { resolveFight } from './combat-math.js';

function pooled(name: string): CardDefinition {
  const c = CARD_POOL.find((e) => e.name === name);
  if (!c) throw new Error('pool missing ' + name);
  return c;
}

/** 1/2 reach DEATHTOUCH — the card that made this whole file necessary. */
const RECLUSE = pooled('Deadly Recluse');
/** 5/3 — the creature a Recluse eats and the old maths said it walked past. */
const THRAGTUSK = pooled('Thragtusk');
/** 2/2 FIRST STRIKE. */
const ATTENDED_KNIGHT = pooled('Attended Knight');
/** 7/7 TRAMPLE. */
const PELAKKA_WURM = pooled('Pelakka Wurm');
/** 0/4 defender — the body that soaks a trampler properly. */
const WALL = pooled('Wall of Omens');
/** 2/2 vanilla. */
const BEARS = pooled('Grizzly Bears');
/** 6/4 vanilla-sized ground beater. */
const CRAW_WURM = pooled('Craw Wurm');

interface Built {
  readonly state: GameState;
  readonly instances: readonly CardInstance[];
}

function board(defs: readonly CardDefinition[], damage: readonly number[] = []): Built {
  const seat = () => ({
    life: 20, hand: [], library: [], graveyard: [], exile: [], command: [],
    manaPool: { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 }, landsPlayedThisTurn: 0, hasLost: false,
  });
  const state = {
    battlefield: [] as CardInstance[], players: { A: seat(), B: seat() }, nextInstanceId: 1,
    stack: [], continuous: [], turnNumber: 1, step: 'declareBlockers',
    activePlayer: 'B', priorityPlayer: 'A', gameOver: false, combat: null, winner: null,
    consecutivePasses: 0, seed: 1, rngState: 1,
  } as unknown as GameState;
  const instances: CardInstance[] = [];
  defs.forEach((def, i) => {
    const inst = {
      instanceId: state.nextInstanceId++, def, controller: 'A', owner: 'A', zone: 'battlefield',
      tapped: false, summoningSick: false, damageMarked: damage[i] ?? 0,
      attachedTo: null, counters: {},
    } as unknown as CardInstance;
    state.battlefield.push(inst);
    instances.push(inst);
  });
  return { state, instances };
}

function fight(attacker: CardDefinition, blocker: CardDefinition, damage: readonly number[] = []) {
  const { state, instances } = board([attacker, blocker], damage);
  return resolveFight(instances[0] as CardInstance, instances[1] as CardInstance, boardIndex(state));
}

describe('resolveFight — the four things the printed boxes get wrong', () => {
  it('a DEATHTOUCH blocker kills an attacker far bigger than its power', () => {
    // 5/3 into 1/2 deathtouch. Printed-box maths: 1 >= 3 is false, "I survive".
    const outcome = fight(THRAGTUSK, RECLUSE);
    expect(outcome.attackerDies).toBe(true);
    expect(outcome.blockerDies).toBe(true);
  });

  it('a DEATHTOUCH attacker kills a blocker far bigger than its power', () => {
    const outcome = fight(RECLUSE, THRAGTUSK);
    expect(outcome.blockerDies).toBe(true);
    expect(outcome.attackerDies).toBe(true); // 5 power into a 1/2
  });

  it('deathtouch with ZERO power still kills nothing', () => {
    // The guard that stops "any damage is lethal" becoming "no damage is lethal".
    const zeroPower: CardDefinition = { ...RECLUSE, power: 0 };
    const outcome = fight(zeroPower, BEARS);
    expect(outcome.blockerDies).toBe(false);
  });

  it('FIRST STRIKE means the loser never strikes back', () => {
    // 2/2 first strike blocks a 2/2: the Knight kills it before it can answer.
    const outcome = fight(BEARS, ATTENDED_KNIGHT);
    expect(outcome.attackerDies).toBe(true);
    expect(outcome.blockerDies).toBe(false);
  });

  it('first strike does NOT save a creature it fails to kill', () => {
    // 2/2 first strike in front of a 6/4: two damage is not lethal, five is.
    const outcome = fight(CRAW_WURM, ATTENDED_KNIGHT);
    expect(outcome.blockerDies).toBe(true);
    expect(outcome.attackerDies).toBe(false);
  });

  it('first strike on BOTH sides is simultaneous again', () => {
    const outcome = fight(ATTENDED_KNIGHT, ATTENDED_KNIGHT);
    expect(outcome.attackerDies).toBe(true);
    expect(outcome.blockerDies).toBe(true);
  });

  it('INDESTRUCTIBLE survives lethal damage, deathtouch included', () => {
    const unkillable: CardDefinition = {
      ...BEARS,
      keywords: { ...(BEARS.keywords ?? {}), indestructible: true },
    };
    expect(fight(THRAGTUSK, unkillable).blockerDies).toBe(false);
    expect(fight(RECLUSE, unkillable).blockerDies).toBe(false);
  });

  it('MARKED DAMAGE lowers what it takes to finish a creature', () => {
    // A 0/4 wall with 3 damage on it dies to a 1-power poke it would shrug off.
    const [attacker, blocker] = [BEARS, WALL];
    const healthy = fight(attacker, blocker, [0, 0]);
    const wounded = fight(attacker, blocker, [0, 3]);
    expect(healthy.blockerDies).toBe(false);
    expect(wounded.blockerDies).toBe(true);
  });
});

describe('resolveFight — trample overflow decides WHICH body blocks', () => {
  it('a 7/7 trampler leaves three over an 0/4 wall and six over a 1/1', () => {
    const chump: CardDefinition = { ...BEARS, power: 1, toughness: 1 };
    expect(fight(PELAKKA_WURM, WALL).damageThrough).toBe(3);
    expect(fight(PELAKKA_WURM, chump).damageThrough).toBe(6);
  });

  it('an attacker WITHOUT trample leaks nothing whatever blocks it', () => {
    expect(fight(CRAW_WURM, WALL).damageThrough).toBe(0);
    expect(fight(CRAW_WURM, BEARS).damageThrough).toBe(0);
  });

  it('a DEATHTOUCH trampler only has to assign one, so nearly all of it spills', () => {
    const deathtouchWurm: CardDefinition = {
      ...PELAKKA_WURM,
      keywords: { ...(PELAKKA_WURM.keywords ?? {}), deathtouch: true },
    };
    expect(fight(deathtouchWurm, WALL).damageThrough).toBe(6);
  });

  it('marked damage on the blocker lets MORE trample through', () => {
    expect(fight(PELAKKA_WURM, WALL, [0, 2]).damageThrough).toBe(5);
  });
});

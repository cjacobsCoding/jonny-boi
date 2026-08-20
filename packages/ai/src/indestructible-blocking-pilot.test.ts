/**
 * The pilot vs indestructible creatures and blocking restrictions — the "the AI
 * must not be blind" half of both systems.
 *
 * An engine rule the pilot cannot see is worse than no rule: the sim plays
 * thousands of games through this pilot, so a pilot that keeps pointing Doom
 * Blade at Darksteel Citadel or keeps proposing single blocks on a menacing
 * attacker turns a correct engine into a wrong statistic.
 *
 * Two behaviours, one per system:
 *   1. removal that says DESTROY looks past an indestructible creature (and an
 *      EXILE effect deliberately does not);
 *   2. the pilot never proposes a block the declaration rules would refuse.
 */

import { describe, expect, it } from 'vitest';
import {
  applyAction,
  createGame,
  createRng,
  generateLegalActions,
  type CardDefinition,
  type DeckList,
  type GameAction,
  type GameState,
} from '@jonny-boi/core';
import { createHeuristicPilot } from './heuristic.js';
import { addPool, creatureDef, destroyDef, giveHand, landDef, putOnBattlefield } from './test-support.js';

function stubDeck(): DeckList {
  return { cards: Array.from({ length: 30 }, (_, i) => landDef(`L${i}`, 'R')) };
}

function freshGame(seed = 1): GameState {
  const { state } = createGame({ seed, decks: { A: stubDeck(), B: stubDeck() } });
  return state;
}

function intoMainPhase(state: GameState): void {
  state.step = 'precombatMain';
  state.activePlayer = 'A';
  state.priorityPlayer = 'A';
  state.stack = [];
  state.players.A.hand = [];
  state.players.B.hand = [];
  state.players.A.landsPlayedThisTurn = 0;
}

/** Declare-blockers with B defending against A's declared attackers. */
function intoDeclareBlockers(state: GameState, attackers: readonly number[]): void {
  state.step = 'declareBlockers';
  state.activePlayer = 'A';
  state.priorityPlayer = 'B';
  state.stack = [];
  state.combat = {
    attackers: [...attackers],
    blocks: {},
    attackersDeclared: true,
    blockersDeclared: false,
  };
}

/** An exile-based removal spell — the control for the destroy tests. */
function exileDef(id: string): CardDefinition {
  return {
    id,
    name: id,
    types: ['sorcery'],
    timing: 'sorcery',
    cost: { W: 1 },
    effects: [{ primitive: 'exileTarget', params: { targets: 'creature' } }],
  };
}

const pilot = createHeuristicPilot();

function choose(state: GameState): GameAction {
  return pilot.chooseAction({
    view: state,
    legalActions: generateLegalActions(state),
    rng: createRng(99),
  });
}

describe('the pilot does not "kill" an indestructible creature with a destroy effect', () => {
  it('aims removal at the reachable creature, not the bigger indestructible one', () => {
    const state = freshGame(3);
    intoMainPhase(state);
    const [steel, ordinary] = putOnBattlefield(state, 'B', [
      creatureDef('Steel Colossus', 8, 8, { keywords: { indestructible: true } }),
      creatureDef('Ordinary Bear', 2, 2),
    ]);
    giveHand(state, 'A', [destroyDef('Doom Blade')]);
    addPool(state, 'A', 'B', 1);
    addPool(state, 'A', 'R', 1);

    const action = choose(state);
    expect(action.kind).toBe('castSpell');
    if (action.kind === 'castSpell') {
      // The 8/8 is by far the biggest threat, and is exactly the wrong target.
      expect(action.targets).toEqual([ordinary!.instanceId]);
      expect(action.targets).not.toContain(steel!.instanceId);
    }
  });

  it('holds the destroy spell entirely when every enemy creature is indestructible', () => {
    const state = freshGame(4);
    intoMainPhase(state);
    putOnBattlefield(state, 'B', [
      creatureDef('Steel Colossus', 8, 8, { keywords: { indestructible: true } }),
    ]);
    giveHand(state, 'A', [destroyDef('Doom Blade')]);
    addPool(state, 'A', 'B', 1);
    addPool(state, 'A', 'R', 1);

    const action = choose(state);
    expect(action.kind).not.toBe('castSpell');
  });

  it('an EXILE effect still points at it — indestructible is not a general shield', () => {
    const state = freshGame(5);
    intoMainPhase(state);
    const [steel] = putOnBattlefield(state, 'B', [
      creatureDef('Steel Colossus', 8, 8, { keywords: { indestructible: true } }),
      creatureDef('Ordinary Bear', 2, 2),
    ]);
    giveHand(state, 'A', [exileDef('Swords')]);
    addPool(state, 'A', 'W', 1);

    const action = choose(state);
    expect(action.kind).toBe('castSpell');
    if (action.kind === 'castSpell') {
      expect(action.targets).toEqual([steel!.instanceId]);
    }
  });
});

describe('the pilot only proposes block declarations the engine accepts', () => {
  it('never assigns a lone blocker to a menacing attacker', () => {
    const state = freshGame(6);
    const [menacer] = putOnBattlefield(state, 'A', [
      creatureDef('Menacer', 4, 4, { keywords: { menace: true } }),
    ]);
    // One untapped blocker: blocking at all would be an illegal declaration.
    putOnBattlefield(state, 'B', [creatureDef('Lone Wall', 0, 6)]);
    intoDeclareBlockers(state, [menacer!.instanceId]);

    const action = choose(state);
    expect(action.kind).not.toBe('declareBlockers');
  });

  it('never assigns a lone blocker to "except by three or more creatures"', () => {
    const state = freshGame(7);
    const [pathrazer] = putOnBattlefield(state, 'A', [
      creatureDef('Pathrazer', 4, 4, { keywords: { minBlockers: 3 } }),
    ]);
    putOnBattlefield(state, 'B', [creatureDef('Wall A', 0, 6), creatureDef('Wall B', 0, 6)]);
    intoDeclareBlockers(state, [pathrazer!.instanceId]);

    const action = choose(state);
    expect(action.kind).not.toBe('declareBlockers');
  });

  it("never blocks with a creature that can't block", () => {
    const state = freshGame(8);
    const [attacker] = putOnBattlefield(state, 'A', [creatureDef('Ogre', 4, 4)]);
    putOnBattlefield(state, 'B', [
      creatureDef('Gravecrawler', 2, 6, { keywords: { cantBlock: true } }),
    ]);
    intoDeclareBlockers(state, [attacker!.instanceId]);

    const action = choose(state);
    expect(action.kind).not.toBe('declareBlockers');
  });

  it('still blocks normally when the declaration would be legal (the control)', () => {
    const state = freshGame(9);
    const [attacker] = putOnBattlefield(state, 'A', [creatureDef('Ogre', 4, 4)]);
    const [wall] = putOnBattlefield(state, 'B', [creatureDef('Ordinary Wall', 4, 6)]);
    intoDeclareBlockers(state, [attacker!.instanceId]);

    const action = choose(state);
    expect(action.kind).toBe('declareBlockers');
    if (action.kind === 'declareBlockers') {
      expect(action.blocks).toEqual([
        { blocker: wall!.instanceId, attacker: attacker!.instanceId },
      ]);
    }
  });

  /*
   * PROTECTION IS THE FOURTH BLOCKING RESTRICTION, and the pilot could not see it.
   *
   * Core's `canBlock` has always refused a blocker with a quality the attacker
   * has protection from (CR 702.16e). The pilot's mirror of that function checked
   * `cantBlock`, `unblockable` and flying — and stopped. So every white creature
   * it controlled went on proposing a block against a Black Knight, the engine
   * refused the WHOLE declaration (one illegal pair invalidates all of it), and
   * after `maxConsecutiveRejectedActions` the sim harness passed priority for
   * that seat: **the defender took the entire attack unblocked, every combat,
   * for the whole game.**
   *
   * Found by the full-pool soak (`@jonny-boi/sim`'s `soak.ts`) at seed
   * 1948110550 — "the engine rejected an offered action: Wall of Omens cannot
   * block Black Knight". Nothing in the isolated suites could see it: the
   * protection tests never asked a pilot to block, and the pilot tests never put
   * a protection creature on the other side.
   */
  const blackKnight = () =>
    creatureDef('Black Knight', 2, 2, { cost: { B: 2 }, keywords: { protectionFrom: ['white'] } });
  const whiteWall = () => creatureDef('Wall of Omens', 0, 4, { cost: { generic: 1, W: 1 } });

  it("never blocks an attacker with protection from the blocker's colour", () => {
    const state = freshGame(10);
    const [knight] = putOnBattlefield(state, 'A', [blackKnight()]);
    putOnBattlefield(state, 'B', [whiteWall()]);
    intoDeclareBlockers(state, [knight!.instanceId]);

    const action = choose(state);
    expect(action.kind, 'a white creature cannot block protection-from-white').not.toBe('declareBlockers');
  });

  it('THE ENGINE ACCEPTS whatever the pilot declares against a protected attacker', () => {
    // The end-to-end form, which is the claim that actually matters: a rejected
    // declaration is not a cosmetic mistake, it is the defender taking the hit.
    const state = freshGame(11);
    const [knight] = putOnBattlefield(state, 'A', [blackKnight()]);
    // A legal blocker as well, so "block nothing" is not the only safe answer and
    // the pilot has a real declaration to get right.
    // The Knight is the BIGGER attacker, so the pilot considers it first and the
    // white wall is the blocker it reaches for. Without the protection clause it
    // proposes exactly that, and the whole declaration is refused.
    const [goblin] = putOnBattlefield(state, 'A', [creatureDef('Goblin', 1, 1, { cost: { R: 1 } })]);
    // ONE untapped blocker, and it is white. The pilot must work out that its
    // only blocker cannot be pointed at the Knight — and must still make the
    // block it CAN make, rather than losing the whole declaration.
    const [white] = putOnBattlefield(state, 'B', [whiteWall()]);
    intoDeclareBlockers(state, [knight!.instanceId, goblin!.instanceId]);
    state.players.B.life = 3; // desperate: the pilot really wants to block

    const action = choose(state);
    const result = applyAction(state, action);
    const rejected = result.events.find((e) => e.type === 'actionRejected');
    expect(rejected, `the engine refused the pilot's own action: ${JSON.stringify(rejected)}`).toBeUndefined();
    expect(action.kind, 'gave up blocking entirely rather than blocking what it could').toBe('declareBlockers');
    if (action.kind === 'declareBlockers') {
      expect(action.blocks).toEqual([{ blocker: white!.instanceId, attacker: goblin!.instanceId }]);
    }
  });

  it('MENACE granted by a continuous effect counts, not just the printed box', () => {
    // The same class of mistake one clause over: `needsMultipleBlockers` read
    // `def.keywords` directly, so a granted menace was invisible to the pilot
    // while the rules path read the granted set.
    const state = freshGame(12);
    const [plain] = putOnBattlefield(state, 'A', [creatureDef('Plain Ogre', 4, 4)]);
    state.continuous.push({
      id: state.nextInstanceId++,
      targetInstanceId: plain!.instanceId,
      sourceInstanceId: plain!.instanceId,
      keywords: { menace: true },
      duration: 'endOfTurn',
    });
    putOnBattlefield(state, 'B', [creatureDef('Lone Wall', 0, 6)]);
    intoDeclareBlockers(state, [plain!.instanceId]);

    const action = choose(state);
    expect(action.kind, 'a lone blocker on a menacing attacker is an illegal declaration').not.toBe(
      'declareBlockers',
    );
  });
});

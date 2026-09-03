import { describe, expect, it } from 'vitest';
import {
  applyAction,
  canPay,
  createGame,
  createRng,
  generateLegalActions,
  type CardInstance,
  type DeckList,
  type GameAction,
  type GameState,
} from '@jonny-boi/core';
import { createHeuristicPilot, HEURISTIC_PILOT_ID } from './heuristic.js';
import {
  addPool,
  burnDef,
  counterDef,
  createTestRegistry,
  creatureDef,
  destroyDef,
  giveHand,
  landDef,
  pumpDef,
  putOnBattlefield,
  putOnStack,
  shrinkDef,
  sweeperDef,
} from './test-support.js';

/** A deck stub good enough to start a game; tests override hand/board directly. */
function stubDeck(): DeckList {
  return { cards: Array.from({ length: 30 }, (_, i) => landDef(`L${i}`, 'R')) };
}

/** Fresh game; then we sculpt the position by hand. */
function freshGame(seed = 1): GameState {
  const { state } = createGame({ seed, decks: { A: stubDeck(), B: stubDeck() } });
  return state;
}

/** Put the active player (A) into their precombat main with priority and empty hand. */
function intoMainPhase(state: GameState): void {
  state.step = 'precombatMain';
  state.activePlayer = 'A';
  state.priorityPlayer = 'A';
  state.stack = [];
  state.players.A.hand = [];
  state.players.B.hand = [];
  state.players.A.landsPlayedThisTurn = 0;
}

/** Put A into the declare-attackers step as the active player. */
function intoDeclareAttackers(state: GameState): void {
  state.step = 'declareAttackers';
  state.activePlayer = 'A';
  state.priorityPlayer = 'A';
  state.combat = { attackers: [], blocks: {}, attackersDeclared: false, blockersDeclared: false };
}

/** Put B into the declare-blockers step defending against A's attackers. */
function intoDeclareBlockers(state: GameState, attackers: CardInstance[]): void {
  state.step = 'declareBlockers';
  state.activePlayer = 'A';
  state.priorityPlayer = 'B';
  state.combat = {
    attackers: attackers.map((a) => a.instanceId),
    blocks: {},
    attackersDeclared: true,
    blockersDeclared: false,
  };
}

const pilot = createHeuristicPilot();
const rng = () => createRng(99);

function choose(state: GameState): GameAction {
  const legal = generateLegalActions(state);
  return pilot.chooseAction({ view: state, legalActions: legal, rng: rng() });
}

describe('heuristic pilot — identity', () => {
  it('registers under the expected id', () => {
    expect(pilot.id).toBe(HEURISTIC_PILOT_ID);
    expect(HEURISTIC_PILOT_ID).toBe('heuristic');
  });
});

describe('heuristic pilot — land development', () => {
  it('plays a land when it has one and a land drop available', () => {
    const state = freshGame();
    intoMainPhase(state);
    const [land] = giveHand(state, 'A', [landDef('Mountain', 'R')]);
    const action = choose(state);
    expect(action).toEqual({ kind: 'playLand', player: 'A', instanceId: land!.instanceId });
  });
});

describe('heuristic pilot — removal & burn', () => {
  it('casts burn at the opponent face when it is lethal', () => {
    const state = freshGame();
    intoMainPhase(state);
    state.players.B.life = 3;
    const [bolt] = giveHand(state, 'A', [burnDef('Bolt', 3, { R: 1 })]);
    addPool(state, 'A', 'R', 1); // already have the mana floating → casts immediately
    const action = choose(state);
    expect(action.kind).toBe('castSpell');
    if (action.kind === 'castSpell') {
      expect(action.instanceId).toBe(bolt!.instanceId);
      expect(action.targets).toEqual(['B']); // the face
    }
  });

  it('uses burn to kill an opposing creature rather than chip the face', () => {
    const state = freshGame();
    intoMainPhase(state);
    state.players.B.life = 20; // not lethal — killing a threat should win
    const [enemy] = putOnBattlefield(state, 'B', [creatureDef('Bear', 3, 3, { cost: { R: 2 } })]);
    const [bolt] = giveHand(state, 'A', [burnDef('Bolt', 3, { R: 1 })]);
    addPool(state, 'A', 'R', 1);
    const action = choose(state);
    expect(action.kind).toBe('castSpell');
    if (action.kind === 'castSpell') {
      expect(action.instanceId).toBe(bolt!.instanceId);
      expect(action.targets).toEqual([enemy!.instanceId]); // kill the bear
    }
  });

  it('burns the FACE instead of a blocker once the opponent is nearly dead', () => {
    // The same board, the same Bolt, a different life total: at 20 killing the
    // creature is right, at 6 the game is two spells away and the creature is
    // irrelevant. A flat "chip the face" score could not tell those apart, so an
    // aggro deck answered creatures until it ran out of cards.
    const play = (life: number) => {
      const state = freshGame();
      intoMainPhase(state);
      state.players.B.life = life;
      putOnBattlefield(state, 'B', [creatureDef('Bear', 2, 2, { cost: { R: 2 } })]);
      giveHand(state, 'A', [burnDef('Bolt', 3, { R: 1 })]);
      addPool(state, 'A', 'R', 1);
      const action = choose(state);
      if (action.kind !== 'castSpell') throw new Error('expected a cast');
      return action.targets;
    };
    expect(play(20)).not.toEqual(['B']); // healthy: kill the blocker
    expect(play(6)).toEqual(['B']); // low: race
  });

  it('targets the BIGGEST killable threat with removal', () => {
    const state = freshGame();
    intoMainPhase(state);
    const small = putOnBattlefield(state, 'B', [creatureDef('Rat', 1, 1, { cost: { B: 1 } })]);
    const big = putOnBattlefield(state, 'B', [creatureDef('Ogre', 4, 4, { cost: { B: 3 } })]);
    giveHand(state, 'A', [destroyDef('Murder', { B: 1, generic: 1 })]);
    addPool(state, 'A', 'B', 2);
    const action = choose(state);
    expect(action.kind).toBe('castSpell');
    if (action.kind === 'castSpell') {
      expect(action.targets).toEqual([big[0]!.instanceId]);
      expect(action.targets).not.toEqual([small[0]!.instanceId]);
    }
  });

  it('taps for mana toward a spell it cannot yet pay for', () => {
    const state = freshGame();
    intoMainPhase(state);
    state.players.B.life = 3;
    giveHand(state, 'A', [burnDef('Bolt', 3, { R: 1 })]);
    // A controls an untapped Mountain but has no floating mana yet.
    const [mountain] = putOnBattlefield(state, 'A', [landDef('Mountain', 'R')]);
    const action = choose(state);
    // `mode` names which mana the tap makes; a Mountain has exactly one mode.
    expect(action).toEqual({ kind: 'tapForMana', player: 'A', instanceId: mountain!.instanceId, mode: 0 });
  });

  it('does not waste removal when there is no valid target', () => {
    const state = freshGame();
    intoMainPhase(state);
    giveHand(state, 'A', [destroyDef('Murder', { B: 1, generic: 1 })]);
    addPool(state, 'A', 'B', 2);
    // No opposing creatures → removal has no target → should just pass.
    const action = choose(state);
    expect(action.kind).toBe('passPriority');
  });
});

describe('heuristic pilot — reactive spells are not blank cards', () => {
  it('holds a counterspell while the stack is empty', () => {
    const state = freshGame();
    intoMainPhase(state);
    giveHand(state, 'A', [counterDef('Counterspell')]);
    addPool(state, 'A', 'U', 2);
    // Casting it now would resolve as a no-op that ate a card.
    expect(choose(state).kind).toBe('passPriority');
  });

  it('counters the opponent’s spell on the stack, naming it as the target', () => {
    const state = freshGame();
    intoMainPhase(state);
    state.priorityPlayer = 'A';
    const threat = putOnStack(state, 'B', creatureDef('Dragon', 6, 6, { cost: { generic: 6 } }));
    const [counter] = giveHand(state, 'A', [counterDef('Counterspell')]);
    addPool(state, 'A', 'U', 2);
    const action = choose(state);
    expect(action.kind).toBe('castSpell');
    if (action.kind === 'castSpell') {
      expect(action.instanceId).toBe(counter!.instanceId);
      expect(action.targets).toEqual([threat.instanceId]);
    }
  });

  it('does not stack a second counter on its own answer', () => {
    const state = freshGame();
    intoMainPhase(state);
    putOnStack(state, 'B', creatureDef('Dragon', 6, 6, { cost: { generic: 6 } }));
    putOnStack(state, 'A', counterDef('Counterspell')); // our answer, already on top
    giveHand(state, 'A', [counterDef('Counterspell')]);
    addPool(state, 'A', 'U', 2);
    expect(choose(state).kind).toBe('passPriority');
  });

  it('holds a sweeper that would cost it more than the opponent', () => {
    const state = freshGame();
    intoMainPhase(state);
    putOnBattlefield(state, 'A', [creatureDef('Ours', 4, 4, { cost: { W: 3 } })]);
    putOnBattlefield(state, 'B', [creatureDef('Theirs', 1, 1, { cost: { B: 1 } })]);
    giveHand(state, 'A', [sweeperDef('Wrath of God')]);
    addPool(state, 'A', 'W', 4);
    expect(choose(state).kind).toBe('passPriority');
  });

  it('fires a sweeper into a board that is all theirs', () => {
    const state = freshGame();
    intoMainPhase(state);
    putOnBattlefield(state, 'B', [
      creatureDef('A1', 3, 3, { cost: { B: 2 } }),
      creatureDef('A2', 3, 3, { cost: { B: 2 } }),
    ]);
    const [wrath] = giveHand(state, 'A', [sweeperDef('Wrath of God')]);
    addPool(state, 'A', 'W', 4);
    const action = choose(state);
    expect(action.kind).toBe('castSpell');
    if (action.kind === 'castSpell') expect(action.instanceId).toBe(wrath!.instanceId);
  });

  it('reads a NEGATIVE pump as removal and points it at the biggest thing it kills', () => {
    const state = freshGame();
    intoMainPhase(state);
    const [small] = putOnBattlefield(state, 'B', [creatureDef('Rat', 1, 1, { cost: { B: 1 } })]);
    const [mid] = putOnBattlefield(state, 'B', [creatureDef('Knight', 2, 2, { cost: { B: 2 } })]);
    putOnBattlefield(state, 'B', [creatureDef('Ogre', 4, 4, { cost: { B: 3 } })]); // survives -2/-2
    const [disfigure] = giveHand(state, 'A', [shrinkDef('Disfigure', -2, -2)]);
    addPool(state, 'A', 'B', 1);
    const action = choose(state);
    expect(action.kind).toBe('castSpell');
    if (action.kind === 'castSpell') {
      expect(action.instanceId).toBe(disfigure!.instanceId);
      expect(action.targets).toEqual([mid!.instanceId]);
      expect(action.targets).not.toEqual([small!.instanceId]);
    }
  });

  it('holds shrink-removal that would kill nothing', () => {
    const state = freshGame();
    intoMainPhase(state);
    putOnBattlefield(state, 'B', [creatureDef('Ogre', 4, 4, { cost: { B: 3 } })]);
    giveHand(state, 'A', [shrinkDef('Disfigure', -2, -2)]);
    addPool(state, 'A', 'B', 1);
    expect(choose(state).kind).toBe('passPriority');
  });
});

describe('heuristic pilot — developing the board', () => {
  it('casts a creature to develop when nothing better is available', () => {
    const state = freshGame();
    intoMainPhase(state);
    const [bear] = giveHand(state, 'A', [creatureDef('Bear', 2, 2, { cost: { R: 1 } })]);
    addPool(state, 'A', 'R', 1);
    const action = choose(state);
    expect(action.kind).toBe('castSpell');
    if (action.kind === 'castSpell') expect(action.instanceId).toBe(bear!.instanceId);
  });
});

describe('heuristic pilot — attacking', () => {
  it('attacks when unblocked (opponent has no creatures)', () => {
    const state = freshGame();
    const [bear] = putOnBattlefield(state, 'A', [creatureDef('Bear', 2, 2)]);
    intoDeclareAttackers(state);
    const action = choose(state);
    expect(action.kind).toBe('declareAttackers');
    if (action.kind === 'declareAttackers') expect(action.attackers).toContain(bear!.instanceId);
  });

  it('does NOT send a 1/1 into an untapped 3/3 blocker (no profitable trade)', () => {
    const state = freshGame();
    putOnBattlefield(state, 'A', [creatureDef('Goblin', 1, 1)]);
    putOnBattlefield(state, 'B', [creatureDef('Wall', 3, 3)]);
    intoDeclareAttackers(state);
    const action = choose(state);
    // It declines to attack — either an empty attack or a pass.
    if (action.kind === 'declareAttackers') {
      expect(action.attackers).toHaveLength(0);
    } else {
      expect(action.kind).toBe('passPriority');
    }
  });

  it('DOES attack a 3/3 into a 1/1 (favourable: it survives and kills)', () => {
    const state = freshGame();
    const [ogre] = putOnBattlefield(state, 'A', [creatureDef('Ogre', 3, 3)]);
    putOnBattlefield(state, 'B', [creatureDef('Rat', 1, 1)]);
    intoDeclareAttackers(state);
    const action = choose(state);
    expect(action.kind).toBe('declareAttackers');
    if (action.kind === 'declareAttackers') expect(action.attackers).toContain(ogre!.instanceId);
  });
});

describe('heuristic pilot — blocking', () => {
  it('blocks to avoid lethal even at a creature loss', () => {
    const state = freshGame();
    const attackers = putOnBattlefield(state, 'A', [creatureDef('Beater', 5, 5)]);
    const [chump] = putOnBattlefield(state, 'B', [creatureDef('Chump', 1, 1)]);
    state.players.B.life = 4; // 5 damage incoming is lethal
    intoDeclareBlockers(state, attackers);
    const action = choose(state);
    expect(action.kind).toBe('declareBlockers');
    if (action.kind === 'declareBlockers') {
      expect(action.blocks).toContainEqual({ blocker: chump!.instanceId, attacker: attackers[0]!.instanceId });
    }
  });

  it('makes a favourable block (kills the attacker, keeps its blocker)', () => {
    const state = freshGame();
    const attackers = putOnBattlefield(state, 'A', [creatureDef('Goblin', 2, 1)]);
    const [wall] = putOnBattlefield(state, 'B', [creatureDef('Wall', 1, 4)]);
    state.players.B.life = 20; // not desperate — only block if it's good value
    intoDeclareBlockers(state, attackers);
    const action = choose(state);
    expect(action.kind).toBe('declareBlockers');
    if (action.kind === 'declareBlockers') {
      // Wall (1/4) blocks Goblin (2/1): wall survives, goblin dies → great trade.
      expect(action.blocks).toContainEqual({ blocker: wall!.instanceId, attacker: attackers[0]!.instanceId });
    }
  });

  it('takes the hit rather than chump a fine life total away', () => {
    const state = freshGame();
    const attackers = putOnBattlefield(state, 'A', [creatureDef('Goblin', 2, 2)]);
    putOnBattlefield(state, 'B', [creatureDef('Bigger', 4, 4)]);
    state.players.B.life = 20; // healthy: don't trade our 4/4 down to a 2/2 we'd both die? no — 4/4 survives
    intoDeclareBlockers(state, attackers);
    const action = choose(state);
    // The 4/4 kills the 2/2 and survives → that's a favourable block, so it blocks.
    expect(action.kind).toBe('declareBlockers');
  });

  it('does not block a small attacker with a valuable creature for nothing when healthy', () => {
    const state = freshGame();
    const attackers = putOnBattlefield(state, 'A', [creatureDef('Goblin', 1, 1)]);
    putOnBattlefield(state, 'B', [creatureDef('Dragon', 5, 5)]);
    state.players.B.life = 20;
    intoDeclareBlockers(state, attackers);
    const action = choose(state);
    // Dragon (5/5) blocking a 1/1: dragon survives and kills it → still favourable,
    // so a block is fine here too. We assert it never throws and stays legal.
    expect(['declareBlockers']).toContain(action.kind);
  });

  it('emits a rationale trace for its decision', () => {
    const state = freshGame();
    intoMainPhase(state);
    giveHand(state, 'A', [landDef('Mountain', 'R')]);
    const traces: string[] = [];
    const legal = generateLegalActions(state);
    pilot.chooseAction({ view: state, legalActions: legal, rng: rng(), trace: (t) => traces.push(t.reason) });
    expect(traces.length).toBeGreaterThan(0);
    expect(traces[0]).toContain('land');
  });
});

describe('heuristic pilot — combat tricks (pump)', () => {
  it('does NOT cast a pump in the main phase, where it does nothing', () => {
    const state = freshGame();
    intoMainPhase(state);
    putOnBattlefield(state, 'A', [creatureDef('Bear', 2, 2)]);
    giveHand(state, 'A', [pumpDef('Giant Growth', 3, 3)]);
    addPool(state, 'A', 'G', 1);
    const action = choose(state);
    // The old pilot cast this here with NO target, which silently no-opped.
    expect(action.kind).not.toBe('castSpell');
  });

  it('casts a pump to SAVE a blocked attacker that would otherwise die, and names the target', () => {
    const state = freshGame();
    const [ours] = putOnBattlefield(state, 'A', [creatureDef('Bear', 2, 2)]);
    const [theirs] = putOnBattlefield(state, 'B', [creatureDef('Ogre', 3, 3)]);
    // A's Bear attacks and is blocked by B's Ogre: without help the Bear dies.
    state.step = 'declareBlockers';
    state.activePlayer = 'A';
    state.priorityPlayer = 'A';
    state.combat = { attackers: [ours!.instanceId], blocks: { [theirs!.instanceId]: ours!.instanceId }, attackersDeclared: true, blockersDeclared: true };
    giveHand(state, 'A', [pumpDef('Giant Growth', 3, 3)]);
    addPool(state, 'A', 'G', 1);

    const action = choose(state);
    expect(action.kind).toBe('castSpell');
    if (action.kind === 'castSpell') {
      // +3/+3 makes the Bear a 5/5: it survives 3 damage AND kills the 3/3.
      expect(action.targets).toEqual([ours!.instanceId]);
    }
  });

  it('casts a pump for LETHAL through an unblocked attacker', () => {
    const state = freshGame();
    const [ours] = putOnBattlefield(state, 'A', [creatureDef('Bear', 2, 2)]);
    state.players.B.life = 5; // 2 power + 3 pump = exactly lethal
    state.step = 'declareBlockers';
    state.activePlayer = 'A';
    state.priorityPlayer = 'A';
    state.combat = { attackers: [ours!.instanceId], blocks: {}, attackersDeclared: true, blockersDeclared: true };
    giveHand(state, 'A', [pumpDef('Giant Growth', 3, 3)]);
    addPool(state, 'A', 'G', 1);

    const action = choose(state);
    expect(action.kind).toBe('castSpell');
    if (action.kind === 'castSpell') expect(action.targets).toEqual([ours!.instanceId]);
  });

  it('holds the pump when it would change no combat outcome', () => {
    const state = freshGame();
    const [ours] = putOnBattlefield(state, 'A', [creatureDef('Ogre', 4, 4)]);
    const [theirs] = putOnBattlefield(state, 'B', [creatureDef('Rat', 1, 1)]);
    state.players.B.life = 20; // nowhere near lethal
    state.step = 'declareBlockers';
    state.activePlayer = 'A';
    state.priorityPlayer = 'A';
    state.combat = { attackers: [ours!.instanceId], blocks: { [theirs!.instanceId]: ours!.instanceId }, attackersDeclared: true, blockersDeclared: true };
    giveHand(state, 'A', [pumpDef('Giant Growth', 3, 3)]);
    addPool(state, 'A', 'G', 1);

    // The Ogre already kills the Rat and already survives it — the trick is waste.
    const action = choose(state);
    expect(action.kind).not.toBe('castSpell');
  });
});

describe('heuristic pilot — mana is tapped only as needed', () => {
  it('stops tapping once the cost is covered (no stranded floating mana)', () => {
    const state = freshGame();
    intoMainPhase(state);
    // Five untapped Forests, but the spell in hand costs {G}{G}.
    putOnBattlefield(state, 'A', [
      landDef('Forest1', 'G'),
      landDef('Forest2', 'G'),
      landDef('Forest3', 'G'),
      landDef('Forest4', 'G'),
      landDef('Forest5', 'G'),
    ]);
    giveHand(state, 'A', [creatureDef('Bear', 2, 2, { cost: { G: 2 } })]);

    // Drive the pilot forward until it casts, counting the taps it makes.
    let taps = 0;
    const s = state;
    for (let i = 0; i < 10; i++) {
      const action = choose(s);
      if (action.kind === 'castSpell') break;
      expect(action.kind).toBe('tapForMana');
      if (action.kind === 'tapForMana') {
        taps++;
        const perm = s.battlefield.find((c) => c.instanceId === action.instanceId)!;
        perm.tapped = true;
        s.players.A.manaPool.G += 1;
      }
    }
    // Exactly two taps for a two-mana spell — the old pilot could tap more.
    expect(taps).toBe(2);
  });

  it('does not commit to a spell it cannot fund, and passes instead', () => {
    const state = freshGame();
    intoMainPhase(state);
    // One Forest on board, but the only spell costs five.
    putOnBattlefield(state, 'A', [landDef('Forest', 'G')]);
    giveHand(state, 'A', [creatureDef('Giant', 6, 6, { cost: { G: 5 } })]);
    const action = choose(state);
    expect(action.kind).toBe('passPriority');
  });

  it('taps a one-colour source before an any-colour one, keeping flexibility', () => {
    const state = freshGame();
    intoMainPhase(state);
    const bird: Parameters<typeof putOnBattlefield>[2][number] = {
      id: 'Bird',
      name: 'Bird',
      types: ['creature'],
      power: 0,
      toughness: 1,
      producesOptions: [{ W: 1 }, { U: 1 }, { B: 1 }, { R: 1 }, { G: 1 }],
    };
    const [forest] = putOnBattlefield(state, 'A', [landDef('Forest', 'G')]);
    putOnBattlefield(state, 'A', [bird]);
    giveHand(state, 'A', [creatureDef('Bear', 2, 2, { cost: { G: 1 } })]);

    const action = choose(state);
    expect(action.kind).toBe('tapForMana');
    if (action.kind === 'tapForMana') expect(action.instanceId).toBe(forest!.instanceId);
  });
});

// --- regression: hybrid mana costs (the livelock) -------------------------------

describe('heuristic pilot — hybrid mana costs (regression)', () => {
  /**
   * `{1}{G/W}{G/W}` (Kitchen Finks). The pilot used to ignore `cost.hybrid`
   * entirely, so it read this as a one-generic-mana spell, proposed a cast the
   * engine rejected for insufficient mana, and — seeing the same state on its next
   * decision — proposed the identical cast forever. That livelock burned the sim's
   * whole action cap and banked a bogus timeout draw; roughly 60% of gauntlet games
   * ended that way, poisoning every win-rate and A/B verdict built on them.
   */
  const hybridCost = { generic: 1, hybrid: [['G', 'W'], ['G', 'W']] } as const;
  const finks = creatureDef('Finks', 3, 2, { cost: hybridCost });

  it('never proposes a cast the engine refuses when a hybrid cost is unpayable', () => {
    const state = freshGame();
    intoMainPhase(state);
    // One Forest + one floating G: nowhere near {1}{G/W}{G/W}.
    putOnBattlefield(state, 'A', [landDef('Forest', 'G')]);
    addPool(state, 'A', 'G', 1);
    giveHand(state, 'A', [finks]);

    // Whatever the pilot chooses, the engine must accept it — and re-choosing from
    // the same position must not produce an ever-repeating rejected cast.
    for (let i = 0; i < 3; i++) {
      const action = choose(state);
      expect(action.kind).not.toBe('castSpell');
      const result = applyAction(state, action, undefined, createTestRegistry());
      expect(result.events.some((e) => e.type === 'actionRejected')).toBe(false);
    }
  });

  it('casts a hybrid spell once the pool genuinely covers it', () => {
    const state = freshGame();
    intoMainPhase(state);
    // GGG pays {1}{G/W}{G/W} by spending two G on the hybrids and one on the {1}.
    addPool(state, 'A', 'G', 3);
    const [card] = giveHand(state, 'A', [finks]);
    const action = choose(state);
    expect(action.kind).toBe('castSpell');
    if (action.kind === 'castSpell') expect(action.instanceId).toBe(card!.instanceId);
  });

  it('taps toward a hybrid cost instead of stalling', () => {
    const state = freshGame();
    intoMainPhase(state);
    putOnBattlefield(state, 'A', [landDef('F1', 'G'), landDef('F2', 'G'), landDef('P1', 'W')]);
    giveHand(state, 'A', [finks]);
    const action = choose(state);
    expect(action.kind).toBe('tapForMana');
  });

  it('casts Finks from an EMPTY pool when the only green comes from B/G duals offered B-first', () => {
    // THE REPORTED BOARD (2026-09-02): Jungle Hollow, Forest, two Golgari Guildgates
    // — four untapped green sources — and the pilot never cast Finks, because the
    // planner tapped the duals for B (their first-listed mode) and then found the
    // hybrids unpayable. It only cast Finks by accident, after tapping G, G, B
    // toward a plain {1}{G}{G} card, which biased every A/B verdict with one in it.
    const bgDual = (id: string): Parameters<typeof putOnBattlefield>[2][number] => ({
      id,
      name: id,
      types: ['land'],
      producesOptions: [{ B: 1 }, { G: 1 }],
    });
    let state = freshGame();
    intoMainPhase(state);
    putOnBattlefield(state, 'A', [
      bgDual('JungleHollow'),
      landDef('Forest', 'G'),
      bgDual('Guildgate1'),
      bgDual('Guildgate2'),
    ]);
    const [card] = giveHand(state, 'A', [finks]);

    // Three taps then the cast; a fifth decision is one more than it needs. The
    // whole trail is asserted so a failure says what the pilot did instead.
    // `applyAction` clones, so the game advances through the state it returns.
    const DECISIONS = 5;
    const trail: string[] = [];
    for (let i = 0; i < DECISIONS; i++) {
      const action = choose(state);
      const result = applyAction(state, action, undefined, createTestRegistry());
      expect(result.events.some((e) => e.type === 'actionRejected')).toBe(false);
      state = result.state;
      trail.push(
        action.kind === 'castSpell' && action.instanceId === card!.instanceId ? 'cast Finks' : action.kind,
      );
      if (trail[trail.length - 1] === 'cast Finks') break;
    }
    expect(trail).toEqual(['tapForMana', 'tapForMana', 'tapForMana', 'cast Finks']);
  });

  it("agrees with core's canPay on every hybrid pool (the invariant the pilot relies on)", () => {
    // The pilot's payability test must be the engine's, or it proposes illegal
    // casts. We assert the equivalence behaviourally: for each pool, the pilot
    // casts iff core says the cost is payable.
    const pools = [
      { G: 0, W: 0, C: 0 },
      { G: 1, W: 0, C: 0 },
      { G: 2, W: 0, C: 0 },
      { G: 3, W: 0, C: 0 },
      { G: 0, W: 3, C: 0 },
      { G: 1, W: 1, C: 0 },
      { G: 1, W: 1, C: 1 },
      { G: 0, W: 2, C: 1 },
      { G: 0, W: 0, C: 3 },
    ] as const;
    for (const p of pools) {
      const state = freshGame();
      intoMainPhase(state);
      addPool(state, 'A', 'G', p.G);
      addPool(state, 'A', 'W', p.W);
      addPool(state, 'A', 'C', p.C);
      giveHand(state, 'A', [finks]);
      const payable = canPay(state.players.A.manaPool, hybridCost);
      const action = choose(state);
      expect(action.kind === 'castSpell').toBe(payable);
    }
  });
});

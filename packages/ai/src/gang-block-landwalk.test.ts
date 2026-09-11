/**
 * The gang-block search must read the same board the engine reads.
 *
 * THE INCIDENT (the §3.108 pilot merged alongside the §3.107 combat family):
 * `addGangBlocks` called the pilot's `canBlockByEvasion` mirror without the
 * battlefield, and the mirror's DEFAULT of "no lands" said an islandwalker was
 * blockable while the engine — reading the live board with an Island on it —
 * refused the whole declaration. The full-pool soak caught it on the first
 * regenerated pool (Cryptic Annelid on Glissa's Courier, seed 2580271023). The
 * fix made the board a REQUIRED argument everywhere in the pilot; this test is
 * the literal case, so the class cannot come back through a new caller that
 * finds another way to omit it.
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
  type InstanceId,
} from '@jonny-boi/core';
import { indexContinuous } from '@jonny-boi/core';
import { createHeuristicPilot, legalizeBlocks } from './heuristic.js';
import { creatureDef, landDef, putOnBattlefield } from './test-support.js';

function stubDeck(): DeckList {
  return { cards: Array.from({ length: 30 }, (_, i) => landDef(`L${i}`, 'U')) };
}

function freshGame(seed: number): GameState {
  const { state } = createGame({ seed, decks: { A: stubDeck(), B: stubDeck() } });
  return state;
}

/** Declare-blockers with B defending against A's declared attackers. */
function intoDeclareBlockers(state: GameState, attackers: readonly InstanceId[]): void {
  state.step = 'declareBlockers';
  state.activePlayer = 'A';
  state.priorityPlayer = 'B';
  state.stack = [];
  state.players.A.hand = [];
  state.players.B.hand = [];
  state.combat = {
    attackers: [...attackers],
    blocks: {},
    attackersDeclared: true,
    blockersDeclared: false,
  };
}

/** A real Island: the subtype is what landwalk reads, not the name. */
const ISLAND: CardDefinition = {
  id: 'Island',
  name: 'Island',
  types: ['land'],
  subtypes: ['Island'],
  basic: true,
  produces: ['U'],
};

/** Glissa's Courier's shape — a 3/3 with islandwalk (CR 702.18b). */
const ISLANDWALKER = creatureDef('Islandwalker', 3, 3, {
  keywords: { landwalk: [{ kind: 'subtype', subtype: 'Island' }] },
});

// Gang blocks ON explicitly: the search under test is the one that omitted the board.
const pilot = createHeuristicPilot(undefined, { gangBlock: true });

function choose(state: GameState): GameAction {
  return pilot.chooseAction({ view: state, legalActions: generateLegalActions(state), rng: createRng(7) });
}

describe('the gang-block search reads the defender\'s lands for landwalk', () => {
  it('proposes no block on an islandwalker when the defender controls an Island', () => {
    const state = freshGame(2580271023);
    const [walker] = putOnBattlefield(state, 'A', [ISLANDWALKER]);
    // Two 2/2s that together kill a 3/3 — exactly the pair the gang search wants.
    putOnBattlefield(state, 'B', [creatureDef('Bear One', 2, 2), creatureDef('Bear Two', 2, 2), ISLAND]);
    intoDeclareBlockers(state, [walker!.instanceId]);

    const action = choose(state);
    // Whatever the pilot chooses, the engine must accept it — that is the soak's
    // invariant, and the one the incident broke.
    expect(rejectionOf(applyAction(state, action))).toBeUndefined();
    if (action.kind === 'declareBlockers') expect(action.blocks).toEqual([]);
  });

  it('CONTROL: without the Island the same pair gang-blocks the same attacker', () => {
    const state = freshGame(2580271023);
    const [walker] = putOnBattlefield(state, 'A', [ISLANDWALKER]);
    putOnBattlefield(state, 'B', [creatureDef('Bear One', 2, 2), creatureDef('Bear Two', 2, 2)]);
    intoDeclareBlockers(state, [walker!.instanceId]);

    const action = choose(state);
    expect(action.kind).toBe('declareBlockers');
    if (action.kind === 'declareBlockers') {
      // Two blockers on the one attacker: the gang path ran, so the first test
      // exercised the exact call that used to omit the board.
      expect(action.blocks.map((b) => b.attacker)).toEqual([walker!.instanceId, walker!.instanceId]);
      expect(rejectionOf(applyAction(state, action))).toBeUndefined();
    }
  });
});

describe('the gang-block search respects the SIZE of a block requirement', () => {
  it('proposes no block on an attacker needing three blockers, though it has three', () => {
    // THE INCIDENT (§3.121): the pilot's mirror answered "two or more?" as a
    // BOOLEAN, which made a menacing 2/2 and a Pathrazer-style "except by three
    // or more" the same case. The gang search then paired TWO blockers onto the
    // three-requirement attacker and the engine rejected the whole declaration,
    // costing every other block in it. The soak found it on the regenerated pool
    // (Rampaging Ceratops, seed 3379471118).
    const state = freshGame(3379471118);
    const [ceratops] = putOnBattlefield(state, 'A', [
      creatureDef('Rampaging Ceratops', 5, 5, { keywords: { minBlockers: 3 } }),
    ]);
    // Three untapped blockers: enough to satisfy the requirement in principle,
    // which is what makes a PAIR the tempting and illegal move.
    putOnBattlefield(state, 'B', [
      creatureDef('Bear One', 2, 2),
      creatureDef('Bear Two', 2, 2),
      creatureDef('Bear Three', 2, 2),
    ]);
    intoDeclareBlockers(state, [ceratops!.instanceId]);

    const action = choose(state);
    expect(rejectionOf(applyAction(state, action))).toBeUndefined();
    if (action.kind === 'declareBlockers') {
      // Never a partial gang. Either it satisfies the requirement or it blocks
      // nothing; this pilot's search only forms pairs, so it must block nothing.
      const onCeratops = action.blocks.filter((b) => b.attacker === ceratops!.instanceId);
      expect(onCeratops).toHaveLength(0);
    }
  });

  it('CONTROL: a MENACE attacker needing exactly two still gets its pair', () => {
    // The requirement the search can satisfy, so the fix must not have turned
    // gang blocking off wholesale.
    const state = freshGame(3379471118);
    const [menacer] = putOnBattlefield(state, 'A', [
      creatureDef('Menacing Bull', 3, 3, { keywords: { menace: true } }),
    ]);
    putOnBattlefield(state, 'B', [creatureDef('Bear One', 2, 2), creatureDef('Bear Two', 2, 2)]);
    intoDeclareBlockers(state, [menacer!.instanceId]);

    const action = choose(state);
    expect(action.kind).toBe('declareBlockers');
    if (action.kind === 'declareBlockers') {
      expect(action.blocks.map((b) => b.attacker)).toEqual([
        menacer!.instanceId,
        menacer!.instanceId,
      ]);
      expect(rejectionOf(applyAction(state, action))).toBeUndefined();
    }
  });
});


describe('the gang-block search respects the CAP on a block requirement', () => {
  it("proposes no PAIR on an attacker that can't be blocked by more than one creature", () => {
    /*
     * THE INCIDENT (DESIGN §3.142, soak seed 3455580742): the pilot's count
     * mirror read only the MINIMUM bound of CR 509.1b, so Bristling Boar's
     * "can't be blocked by more than one creature" looked like NO constraint at
     * all. The gang search paired Millennial Gargoyle and Screeching Sliver onto
     * it, the engine refused the whole declaration, and after three rejections
     * the harness passed priority and the defender took the attack unblocked.
     *
     * It is the SAME defect as the three-blocker case above, one bound over:
     * a mirror that answers a coarser question than the rule it mirrors. Both
     * bounds are now one core predicate (`blockerCountAllowed`).
     */
    const state = freshGame(3455580742);
    const [boar] = putOnBattlefield(state, 'A', [
      // Bristling Boar's rule on a 3/3 body: sized so the pair is a trade the
      // search genuinely WANTS (the CONTROL below proves it takes it), because a
      // test where it declines for value would pass whatever the rule said.
      creatureDef('Bristling Boar', 3, 3, { keywords: { maxBlockers: 1 } }),
    ]);
    // The pair the search wants: two 2/2s together kill it and neither does
    // alone, which is exactly the trade `addGangBlocks` exists to find.
    putOnBattlefield(state, 'B', [creatureDef('Bear One', 2, 2), creatureDef('Bear Two', 2, 2)]);
    intoDeclareBlockers(state, [boar!.instanceId]);

    const action = choose(state);
    expect(rejectionOf(applyAction(state, action))).toBeUndefined();
    if (action.kind === 'declareBlockers') {
      expect(action.blocks.filter((b) => b.attacker === boar!.instanceId).length).toBeLessThanOrEqual(1);
    }
  });

  it('CONTROL: the same pair gang-blocks the same body without the cap', () => {
    // Without `maxBlockers` the search must still form the pair, or the fix
    // turned gang blocking off rather than teaching it the rule.
    const state = freshGame(3455580742);
    const [boar] = putOnBattlefield(state, 'A', [creatureDef('Uncapped Boar', 3, 3)]);
    putOnBattlefield(state, 'B', [creatureDef('Bear One', 2, 2), creatureDef('Bear Two', 2, 2)]);
    intoDeclareBlockers(state, [boar!.instanceId]);

    const action = choose(state);
    expect(action.kind).toBe('declareBlockers');
    if (action.kind === 'declareBlockers') {
      expect(action.blocks.filter((b) => b.attacker === boar!.instanceId)).toHaveLength(2);
      expect(rejectionOf(applyAction(state, action))).toBeUndefined();
    }
  });
});

describe('the ask-core gate sheds the illegal pair, not the whole declaration', () => {
  /*
   * The price of getting a block rule wrong is what makes this gate worth its
   * cost: ONE illegal pair rejects the entire `declareBlockers`, so a pilot that
   * proposed one lost every other block in the same action. `legalizeBlocks`
   * hands the finished blocks to the engine's own judge and drops pairs until
   * they stand — so the next clause somebody forgets costs a block, not a combat.
   */
  it('drops both blockers from a capped attacker and keeps the legal block', () => {
    const state = freshGame(3455580742);
    const [boar, bear] = putOnBattlefield(state, 'A', [
      creatureDef('Bristling Boar', 4, 3, { keywords: { maxBlockers: 1 } }),
      creatureDef('Plain Attacker', 2, 2),
    ]);
    const defenders = putOnBattlefield(state, 'B', [
      creatureDef('Blocker One', 2, 2),
      creatureDef('Blocker Two', 2, 2),
      creatureDef('Blocker Three', 2, 2),
    ]);
    const blocks = [
      { blocker: defenders[2]!.instanceId, attacker: bear!.instanceId },
      { blocker: defenders[0]!.instanceId, attacker: boar!.instanceId },
      { blocker: defenders[1]!.instanceId, attacker: boar!.instanceId },
    ];
    legalizeBlocks([boar!, bear!], blocks, new Set(), indexContinuous(state), defenders, state.battlefield);
    // The capped attacker's whole group goes — leaving ONE of its two blockers
    // would be legal here, but a group is shed whole because for a menacing
    // attacker the leftover single blocker is illegal for a new reason.
    expect(blocks).toEqual([{ blocker: defenders[2]!.instanceId, attacker: bear!.instanceId }]);
  });

  it("never sheds a block core's own requirement solver demanded", () => {
    // A lure's block is REQUIRED (CR 509.1d): dropping it is the other way to
    // have a declaration refused, so the gate declares nothing instead.
    const state = freshGame(3455580742);
    const [lure] = putOnBattlefield(state, 'A', [
      creatureDef('Lure Target', 2, 2, { keywords: { blockedByAllAble: true } }),
    ]);
    const defenders = putOnBattlefield(state, 'B', [creatureDef('Blocker One', 2, 2)]);
    const blocks = [{ blocker: defenders[0]!.instanceId, attacker: lure!.instanceId }];
    const forced = new Set([lure!.instanceId]);
    legalizeBlocks([lure!], blocks, forced, indexContinuous(state), defenders, state.battlefield);
    expect(blocks).toEqual([{ blocker: defenders[0]!.instanceId, attacker: lure!.instanceId }]);
  });
});

/** The engine's refusal, if any: a rejected action leaves exactly one `actionRejected` event. */
function rejectionOf(result: ReturnType<typeof applyAction>): string | undefined {
  for (const event of result.events) {
    if (event.type === 'actionRejected') return event.reason;
  }
  return undefined;
}

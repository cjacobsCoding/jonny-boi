/**
 * INTERACTION MATRIX - library manipulation (scry / surveil) x the graveyard x
 * characteristic-defining P/T x shuffle effects x the empty-library edge, and
 * turn-scoped facts (revolt) x sacrifice costs x fetchlands x turn boundaries.
 *
 * Two families that look unrelated and are not:
 *
 *   - SURVEIL puts a card in a GRAVEYARD, and a graveyard is an input to
 *     Tarmogoyf's star box, to flashback and to revolt. So "library
 *     manipulation" is a board-changing effect, not a private one.
 *   - REVOLT is read at RESOLUTION, not at cast, which is the difference between
 *     Fatal Push as printed and a strictly worse card. A fetchland cracked in
 *     RESPONSE has to turn it on, and the turn boundary has to turn it off.
 *
 * Cards: Opt, Consider, Tarmogoyf, Fatal Push, Evolving Wilds - all shipped.
 */

import { describe, expect, it } from 'vitest';
import {
  effectivePower,
  effectiveToughness,
  indexContinuous,
  NO_MOD,
  TURN_FACTS,
  turnFactHolds,
  type CardDefinition,
  type GameState,
  type InstanceId,
} from '@jonny-boi/core';
import { buildRegistry } from '../pool.js';
import {
  act,
  boardAtMain,
  castCard,
  fund,
  isOnBattlefield,
  legal,
  onBattlefield,
  place,
  playLand,
  poolCard,
  putOnTop,
  resolvePermanent,
  settle,
  type Registry,
} from './harness.js';

const BEAR: CardDefinition = {
  id: 'matrix-lib-bear',
  name: 'Matrix Library Bear',
  types: ['creature'],
  cost: { generic: 2 },
  power: 2,
  toughness: 2,
};

/** A 4-mana-value creature - too big for Fatal Push without revolt. */
const OGRE: CardDefinition = {
  id: 'matrix-ogre',
  name: 'Matrix Ogre',
  types: ['creature'],
  cost: { generic: 3, R: 1 },
  power: 4,
  toughness: 4,
};

function statsOf(state: GameState, id: InstanceId): { power: number; toughness: number } {
  const inst = onBattlefield(state, id);
  const mod = indexContinuous(state).get(id) ?? NO_MOD;
  return { power: effectivePower(inst, mod), toughness: effectiveToughness(inst, mod) };
}

/** Answer a parked "which cards stay on top" question with the given ids. */
function keepOnTop(state: GameState, reg: Registry, instanceIds: readonly InstanceId[]): GameState {
  const choice = state.pendingChoice;
  if (!choice) throw new Error('no library question is parked');
  return act(
    state,
    {
      kind: 'answerChoice',
      player: choice.chooser,
      choiceId: choice.id,
      answer: { kind: 'selectCards', instanceIds: [...instanceIds] },
    },
    reg,
  );
}

describe('CELL: surveil x the graveyard x characteristic-defining P/T', () => {
  it('surveilling a card into the graveyard GROWS a Tarmogoyf, in the same resolution', () => {
    const reg = buildRegistry();
    let state = boardAtMain(reg);
    place(state, 'A', 'graveyard', poolCard('Lightning Bolt')); // instant
    const goyf = resolvePermanent(state, reg, poolCard('Tarmogoyf'), 'A');
    state = goyf.state;
    expect(statsOf(state, goyf.id)).toEqual({ power: 1, toughness: 2 });

    // A creature card on top of the library, ready to be binned.
    const top = putOnTop(state, 'A', BEAR);
    state = castCard(state, reg, poolCard('Consider'), 'A').state;
    expect(state.pendingChoice?.kind).toBe('selectCards');

    // Surveil's power over scry is exactly this: choosing NOTHING puts the
    // looked-at card in the GRAVEYARD rather than on the bottom.
    state = keepOnTop(state, reg, []);
    state = settle(state, reg);
    expect(state.players.A.graveyard.map((c) => c.instanceId)).toContain(top);

    // instant + creature (the binned bear) + instant... and Consider itself is
    // an instant already counted. Two card types => a 2/3.
    expect(statsOf(state, goyf.id)).toEqual({ power: 2, toughness: 3 });
  });

  it('scry can only reorder - it never adds a card type to a graveyard', () => {
    const reg = buildRegistry();
    let state = boardAtMain(reg);
    place(state, 'A', 'graveyard', poolCard('Lightning Bolt'));
    const goyf = resolvePermanent(state, reg, poolCard('Tarmogoyf'), 'A');
    state = goyf.state;
    const top = putOnTop(state, 'A', BEAR);

    state = castCard(state, reg, poolCard('Opt'), 'A').state;
    expect(state.pendingChoice?.kind).toBe('selectCards');
    // Declining to keep it puts it on the BOTTOM, not in the graveyard.
    state = keepOnTop(state, reg, []);
    state = settle(state, reg);

    expect(state.players.A.graveyard.map((c) => c.instanceId)).not.toContain(top);
    expect(state.players.A.library.map((c) => c.instanceId)).toContain(top);
    // Only the instant type is in a graveyard, so the Goyf did not move.
    expect(statsOf(state, goyf.id)).toEqual({ power: 1, toughness: 2 });
  });

  it('what scry KEEPS on top is what gets drawn', () => {
    const reg = buildRegistry();
    let state = boardAtMain(reg);
    const kept = putOnTop(state, 'A', poolCard('Lightning Bolt'));

    state = castCard(state, reg, poolCard('Opt'), 'A').state;
    state = keepOnTop(state, reg, [kept]);
    state = settle(state, reg);

    // Opt is scry-then-draw, so the card the look decided to keep is the one
    // that lands in hand - the whole point of the card.
    expect(state.players.A.hand.map((c) => c.instanceId)).toContain(kept);
  });
});

describe('CELL: library manipulation x the empty-library edge', () => {
  it('scrying an EMPTY library asks nothing and does not crash', () => {
    const reg = buildRegistry();
    let state = boardAtMain(reg);
    state.players.A.library = [];

    state = castCard(state, reg, poolCard('Opt'), 'A').state;
    // Nothing to look at, so no question is parked at all - the safe direction.
    expect(state.pendingChoice ?? null).toBeNull();
    state = settle(state, reg);
    expect(state.gameOver).toBe(false);
  });

  it('GAP: a SPELL-driven draw from an empty library does not lose the game (CR 704.5b)', () => {
    const reg = buildRegistry();
    let state = boardAtMain(reg);
    state.players.A.library = [];

    // The DRAW-STEP path is right: core's `drawCard` calls `loseGame` when the
    // library is empty, and the ordinary decking test covers it.
    // The SPELL path is not. `packages/cards/src/primitives.ts` `drawCards`
    // returns early on an empty library with the comment "emit nothing rather
    // than fabricate a loss event here" - so a player at zero cards may cast
    // Opt, Consider, Read the Bones and any other draw spell forever.
    //
    // CR 704.5b does not care WHICH draw it was: attempting to draw from an
    // empty library loses the game. This matters to the lab specifically - a
    // control deck that has decked itself keeps playing, which biases exactly
    // the long games a control matchup is decided in.
    //
    // Recorded as GAP `spell-draw-decking` in `interaction-matrix.test.ts`.
    state = castCard(state, reg, poolCard('Opt'), 'A').state;
    state = settle(state, reg);
    expect(state.players.A.hasLost).toBe(false);
    expect(state.gameOver).toBe(false);
    expect(state.players.A.library).toHaveLength(0);
  });
});

describe('CELL: scry x shuffle effects', () => {
  it('a fetchland’s shuffle happens AFTER the search, so an arranged top is gone', () => {
    const reg = buildRegistry();
    let state = boardAtMain(reg, { deck: poolCard('Island') });
    // Give A a real basic to find, so the search is not a no-op.
    place(state, 'A', 'library', poolCard('Plains'));
    const wilds = playLand(state, reg, poolCard('Evolving Wilds'), 'A');
    state = wilds.state;
    onBattlefield(state, wilds.id).summoningSick = false;

    const arranged = putOnTop(state, 'A', poolCard('Lightning Bolt'));
    expect(state.players.A.library[0]?.instanceId).toBe(arranged);

    fund(state, 'A');
    const crack = legal(state).find((a) => a.kind === 'activateAbility' && a.instanceId === wilds.id);
    expect(crack, 'the engine should offer cracking Evolving Wilds').toBeDefined();
    state = settle(act(state, crack!, reg), reg);
    state = answerAnySearch(state, reg);

    // The card is still SOMEWHERE in the library, but the shuffle means the
    // arrangement is gone - "scry then fetch" is a real anti-synergy, not a bug.
    const library = state.players.A.library.map((c) => c.instanceId);
    expect(library).toContain(arranged);
    expect(library.length).toBeGreaterThan(1);
  });
});

describe('CELL: turn facts (revolt) x sacrifice costs x fetchlands x turn boundaries', () => {
  it('cracking a fetchland turns revolt ON, and Fatal Push reads it AT RESOLUTION', () => {
    const reg = buildRegistry();
    let state = boardAtMain(reg);
    place(state, 'A', 'library', poolCard('Plains'));
    const ogre = resolvePermanent(state, reg, OGRE, 'B');
    state = ogre.state;

    // Without revolt the ≤2 mode cannot answer a mana value 4 creature...
    expect(turnFactHolds(state, 'permanentLeftBattlefield', 'A')).toBe(false);
    const wilds = playLand(state, reg, poolCard('Evolving Wilds'), 'A');
    state = wilds.state;
    onBattlefield(state, wilds.id).summoningSick = false;

    // Cast Fatal Push FIRST, then crack the land in response — this is the exact
    // ordering a cast-time read would get wrong.
    const push = place(state, 'A', 'hand', poolCard('Fatal Push'));
    fund(state, 'A');
    state.priorityPlayer = 'A';
    state = act(state, { kind: 'castSpell', player: 'A', instanceId: push, targets: [ogre.id] }, reg);

    const crack = legal(state).find((a) => a.kind === 'activateAbility' && a.instanceId === wilds.id);
    expect(crack, 'the fetchland should be crackable in response').toBeDefined();
    state = act(state, crack!, reg);
    state = answerAnySearch(state, reg);
    state = settle(state, reg);
    state = answerAnySearch(state, reg);
    state = settle(state, reg);

    // The land left the battlefield under A's control, so revolt is on and the
    // ≤4 mode applies: the mana-value-4 Ogre is destroyed.
    expect(turnFactHolds(state, 'permanentLeftBattlefield', 'A')).toBe(true);
    expect(isOnBattlefield(state, ogre.id)).toBe(false);
  });

  it('revolt is per PLAYER and is cleared as the next turn begins', () => {
    const reg = buildRegistry();
    let state = boardAtMain(reg);
    place(state, 'A', 'library', poolCard('Plains'));
    const wilds = playLand(state, reg, poolCard('Evolving Wilds'), 'A');
    state = wilds.state;
    onBattlefield(state, wilds.id).summoningSick = false;

    fund(state, 'A');
    const crack = legal(state).find((a) => a.kind === 'activateAbility' && a.instanceId === wilds.id);
    state = settle(act(state, crack!, reg), reg);
    state = answerAnySearch(state, reg);
    state = settle(state, reg);

    expect(turnFactHolds(state, 'permanentLeftBattlefield', 'A')).toBe(true);
    // It is A's permanent that left, so it is A's fact — B gained nothing.
    expect(turnFactHolds(state, 'permanentLeftBattlefield', 'B')).toBe(false);

    // Cleared as the NEXT turn begins (not at this turn's cleanup, so anything
    // resolving in the end step still reads "this turn" correctly).
    const turnWas = state.turnNumber;
    state = passUntilTurn(state, reg, turnWas + 1);
    for (const fact of TURN_FACTS) {
      expect(turnFactHolds(state, fact, 'A')).toBe(false);
      expect(turnFactHolds(state, fact, 'B')).toBe(false);
    }
  });
});

// --- shared drivers ---------------------------------------------------------------

/** Answer a parked library-search question by taking the first candidate. */
function answerAnySearch(state: GameState, reg: Registry): GameState {
  let next = state;
  for (let i = 0; i < 4 && next.pendingChoice?.kind === 'selectCards'; i++) {
    const choice = next.pendingChoice;
    const first = choice.candidates[0]?.instanceId;
    next = act(
      next,
      {
        kind: 'answerChoice',
        player: choice.chooser,
        choiceId: choice.id,
        answer: { kind: 'selectCards', instanceIds: first === undefined ? [] : [first] },
      },
      reg,
    );
  }
  return next;
}

/** How many priority passes a full turn of the machine can need. */
const TURN_PASS_LIMIT = 200;

function passUntilTurn(state: GameState, reg: Registry, turn: number): GameState {
  let next = state;
  for (let i = 0; i < TURN_PASS_LIMIT && next.turnNumber < turn; i++) {
    if (next.gameOver) throw new Error('the game ended before the turn arrived');
    if (next.pendingChoice) throw new Error('a choice parked while advancing the turn');
    next = act(next, { kind: 'passPriority', player: next.priorityPlayer }, reg);
  }
  if (next.turnNumber < turn) throw new Error(`never reached turn ${turn}`);
  return next;
}

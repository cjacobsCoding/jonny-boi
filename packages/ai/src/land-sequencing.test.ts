/**
 * LAND SEQUENCING — the defect this fixes, and the three ways it could come back.
 *
 * The headline case is the one `tactical-suite.test.ts` pinned as a live defect for
 * a whole branch: a Mountain in play, a Mountain, a Swamp and a `{1}{B}` removal
 * spell in hand, and every pilot played the Mountain. That assertion is flipped
 * where it lives; this file is the unit-level cover, and it grades the three
 * distinct claims the fix makes:
 *
 *   1. Play the land that casts the best spell you are HOLDING (now).
 *   2. Don't strand a colour your hand is asking for (later).
 *   3. Keep the untapped land drop when nothing else separates them (tempo).
 *
 * Plus the two properties that make it safe to ship into `DEFAULT_PILOT_ID`:
 * land-versus-SPELL ordering is untouched, and zeroing the three weights reproduces
 * the old pilot exactly — which is what lets the strength measurement run both arms
 * in one process.
 */

import { describe, expect, it } from 'vitest';
import {
  createGame,
  createRng,
  generateLegalActions,
  type CardDefinition,
  type DeckList,
  type GameAction,
  type GameState,
  type ManaCost,
} from '@jonny-boi/core';
import { createHeuristicPilot, policyCandidates } from './heuristic.js';
import { bestLandDrop, describeLandDrop, rankLandDrops, LAND_SEQUENCING_OFF_WEIGHTS } from './land-sequencing.js';
import { DEFAULT_HEURISTIC_WEIGHTS, type HeuristicWeights } from './weights.js';
import { creatureDef, destroyDef, giveHand, landDef, putOnBattlefield } from './test-support.js';

const MOUNTAIN = landDef('Mountain', 'R');
const SWAMP = landDef('Swamp', 'B');
const PLAINS = landDef('Plains', 'W');
/** Murder: `{1}{B}` hard removal — castable only once a black source is down. */
const MURDER = destroyDef('Murder', { generic: 1, B: 1 });
/** A big red body, so the "unlock" question has a red-side answer too. */
const OGRE = creatureDef('Ogre', 3, 3, { cost: { R: 1, generic: 1 } });
const ENEMY_GIANT = creatureDef('Giant', 4, 4, { cost: { generic: 4 } });

/** A land that arrives tapped, which is a data flag rather than a new card type. */
function tapLandDef(id: string, color: Parameters<typeof landDef>[1]): CardDefinition {
  return { ...landDef(id, color), entersTapped: true };
}

function stubDeck(): DeckList {
  return { cards: Array.from({ length: 30 }, (_, i) => landDef(`L${i}`, 'R')) };
}

/** A precombat main phase for A with priority, an empty stack and a sculpted hand. */
function position(options: {
  readonly board?: readonly CardDefinition[];
  readonly hand: readonly CardDefinition[];
  readonly enemyBoard?: readonly CardDefinition[];
  readonly seed?: number;
}): GameState {
  const { state } = createGame({ seed: options.seed ?? 7, decks: { A: stubDeck(), B: stubDeck() } });
  state.step = 'precombatMain';
  state.activePlayer = 'A';
  state.priorityPlayer = 'A';
  state.stack = [];
  state.players.A.hand = [];
  state.players.B.hand = [];
  state.players.A.landsPlayedThisTurn = 0;
  if (options.board) putOnBattlefield(state, 'A', options.board);
  if (options.enemyBoard) putOnBattlefield(state, 'B', options.enemyBoard);
  giveHand(state, 'A', options.hand);
  return state;
}

/** The name of the land a `playLand` action would put onto the battlefield. */
function landPlayed(state: GameState, action: GameAction | undefined): string | undefined {
  if (action === undefined || action.kind !== 'playLand') return undefined;
  return state.players.A.hand.find((c) => c.instanceId === action.instanceId)?.def.name;
}

/** What the shipped pilot actually does in this position, end to end. */
function pilotPlays(state: GameState, weights: HeuristicWeights = DEFAULT_HEURISTIC_WEIGHTS): string | undefined {
  const pilot = createHeuristicPilot(weights);
  const action = pilot.chooseAction({
    view: state,
    legalActions: generateLegalActions(state),
    rng: createRng(state.seed),
  });
  return landPlayed(state, action);
}

/** Weights with land sequencing switched off — the pre-fix pilot, exactly. */
const OFF: HeuristicWeights = { ...DEFAULT_HEURISTIC_WEIGHTS, ...LAND_SEQUENCING_OFF_WEIGHTS };

describe('land sequencing — play the land that casts the spell', () => {
  /**
   * THE PINNED DEFECT, at the level of the pilot rather than the puzzle harness.
   *
   * Both land drops are worth the same to anything that scores a card on its own
   * merits. Only the Swamp makes Murder castable this turn; the Mountain is the
   * same play one turn too late.
   */
  it('plays the Swamp when only the Swamp casts the removal spell in hand', () => {
    const state = position({
      board: [MOUNTAIN],
      hand: [MOUNTAIN, SWAMP, MURDER],
      enemyBoard: [ENEMY_GIANT],
    });
    expect(pilotPlays(state)).toBe('Swamp');
  });

  /**
   * The same position with the hand order reversed. The old pilot took the FIRST
   * offered land, so a test that only ever presented the right answer first would
   * pass against the bug — this is the half that could not.
   */
  it('plays the Swamp whichever order the two lands sit in hand', () => {
    const state = position({
      board: [MOUNTAIN],
      hand: [SWAMP, MOUNTAIN, MURDER],
      enemyBoard: [ENEMY_GIANT],
    });
    expect(pilotPlays(state)).toBe('Swamp');
  });

  /** The red answer to the same question: unlock the red card, not the black one. */
  it('plays the Mountain when the castable card is the red one', () => {
    const state = position({ board: [MOUNTAIN], hand: [MOUNTAIN, SWAMP, OGRE] });
    expect(pilotPlays(state)).toBe('Mountain');
  });

  /**
   * A land that unlocks nothing scores nothing for unlocking — the bonus is for
   * making a spell LIVE, not for being played alongside one that already was.
   */
  it('does not credit a land for a spell that was already castable', () => {
    // Two Mountains down and a one-mana red spell in hand: it is castable either
    // way, so neither land can claim it and the colour term decides nothing either.
    const state = position({ board: [MOUNTAIN, MOUNTAIN], hand: [MOUNTAIN, SWAMP, OGRE] });
    const options = rankLandDrops(state, generateLegalActions(state), DEFAULT_HEURISTIC_WEIGHTS);
    const mountain = options.find((o) => o.name === 'Mountain');
    const swamp = options.find((o) => o.name === 'Swamp');
    expect(mountain?.merit).toBe(swamp?.merit);
  });
});

describe('land sequencing — the colour and tapland terms', () => {
  /**
   * ⚠️ BOTH OF THESE ALMOST SHIPPED AT ZERO, and the reason they did not is a
   * measurement lesson worth keeping next to them (DESIGN §3.4e). On Boros vs Orzhov
   * the unlock term ALONE beat the three-term blend (52.6% of discordant games vs
   * 50.9%) — a clean-looking case for zeroing these two. On UW vs Golgari it
   * reversed exactly (blend 52.0%, unlock alone 50.9%). Pooled over 80,000 paired
   * games neither is separable from the other, so the default keeps all three and
   * the near-miss is recorded rather than the conclusion it suggested.
   */
  it('all three terms are on by default', () => {
    expect(DEFAULT_HEURISTIC_WEIGHTS.landUnlocksSpellWeight).toBeGreaterThan(0);
    expect(DEFAULT_HEURISTIC_WEIGHTS.landFixesNeededColorScore).toBeGreaterThan(0);
    expect(DEFAULT_HEURISTIC_WEIGHTS.landTaplandFreerollScore).toBeGreaterThan(0);
  });

  /**
   * The future-turn half. `{B}{B}` is not castable off one Swamp, so NOTHING is
   * unlocked this turn and the "what does it cast now" term is silent — but a hand
   * asking for black off a board that makes none still wants the Swamp, or the card
   * is dead for the rest of the game.
   */
  it('plays the land for a colour the hand needs and the board cannot make', () => {
    const doubleBlack: ManaCost = { B: 2 };
    const state = position({
      board: [MOUNTAIN],
      hand: [MOUNTAIN, SWAMP, destroyDef('Doom Blade', doubleBlack)],
      enemyBoard: [ENEMY_GIANT],
    });
    expect(pilotPlays(state)).toBe('Swamp');
  });

  /** A colour nothing in hand is asking for earns nothing — it is not "more colours is better". */
  it('does not chase a colour the hand has no use for', () => {
    const state = position({ board: [MOUNTAIN], hand: [MOUNTAIN, PLAINS, OGRE] });
    // Only the Mountain unlocks the Ogre; the Plains adds a colour nobody wants.
    expect(pilotPlays(state)).toBe('Mountain');
  });

  /**
   * THE TAPLAND RULE IS THE OPPOSITE OF THE OBVIOUS ONE. A tapland costs its
   * controller one mana on the turn it is played; holding it does not avoid that
   * cost, it moves it to a turn nobody gets to choose. So the right turn to play it
   * is one where the mana was never going to be spent — as here, where nothing in
   * hand is castable whichever land goes down.
   */
  it('plays the TAPPED land on a turn when no land drop unlocks anything', () => {
    const state = position({ board: [MOUNTAIN], hand: [MOUNTAIN, tapLandDef('Slow Mountain', 'R')] });
    expect(pilotPlays(state)).toBe('Slow Mountain');
  });

  /**
   * …and it stops the moment the mana matters. Same two lands, but now the untapped
   * one casts the Ogre this turn and the tapland cannot, so the freeroll is not free.
   */
  it('takes the untapped land the moment one of them casts something', () => {
    const state = position({ board: [MOUNTAIN], hand: [tapLandDef('Slow Mountain', 'R'), MOUNTAIN, OGRE] });
    expect(pilotPlays(state)).toBe('Mountain');
  });

  /**
   * The freeroll is a tie-break, not a reason: fixing a colour the hand needs is
   * worth more (`landFixesNeededColorScore` > `landTaplandFreerollScore`), so a
   * tapland that fixes black wins on the colour term rather than on the freeroll.
   */
  it('takes the tapped land when it is also the one that fixes a needed colour', () => {
    const state = position({
      board: [MOUNTAIN],
      hand: [MOUNTAIN, tapLandDef('Slow Swamp', 'B'), destroyDef('Doom Blade', { B: 2 })],
      enemyBoard: [ENEMY_GIANT],
    });
    expect(pilotPlays(state)).toBe('Slow Swamp');
  });

  /**
   * A tapped land cannot unlock anything THIS turn, so it never claims the unlock
   * bonus even when it produces exactly the colour the spell needs. The untapped
   * Swamp beside it does — same colour, same spell, and the only difference is
   * whether the mana is available on the turn it is needed.
   */
  it('never credits a tapped land with casting a spell this turn', () => {
    const state = position({
      board: [MOUNTAIN],
      hand: [tapLandDef('Slow Swamp', 'B'), SWAMP, MURDER],
      enemyBoard: [ENEMY_GIANT],
    });
    const options = rankLandDrops(state, generateLegalActions(state), {
      ...DEFAULT_HEURISTIC_WEIGHTS,
      // Isolate the unlock term: no colour credit, no tapland freeroll.
      landFixesNeededColorScore: 0,
      landTaplandFreerollScore: 0,
    });
    expect(options.find((o) => o.name === 'Slow Swamp')?.merit).toBe(0);
    expect(options.find((o) => o.name === 'Swamp')?.merit).toBeGreaterThan(0);
    expect(pilotPlays(state)).toBe('Swamp');
  });
});

describe('land sequencing — the shape that keeps the baselines honest', () => {
  /**
   * THE LOAD-BEARING INVARIANT. The recorded baselines all assume "a land drop is
   * worth `playLandScore`", and land-versus-spell ordering is what decides whether
   * a pilot develops or casts. So the BEST land keeps exactly that score and only
   * the worse ones are discounted — the fix reorders lands against each other and
   * moves nothing else.
   */
  it('scores the best land at exactly playLandScore and a worse one strictly below', () => {
    const state = position({
      board: [MOUNTAIN],
      hand: [MOUNTAIN, SWAMP, MURDER],
      enemyBoard: [ENEMY_GIANT],
    });
    const lands = policyCandidates(state, generateLegalActions(state), DEFAULT_HEURISTIC_WEIGHTS, true).filter(
      (c) => c.plies[0]?.kind === 'playLand',
    );
    expect(lands).toHaveLength(2);
    const swamp = lands.find((c) => c.label.includes('Swamp'));
    const mountain = lands.find((c) => c.label.includes('Mountain'));
    expect(swamp?.score).toBe(DEFAULT_HEURISTIC_WEIGHTS.playLandScore);
    expect(mountain?.score).toBeLessThan(DEFAULT_HEURISTIC_WEIGHTS.playLandScore);
  });

  /** Two copies of the same land are ONE decision — the search must not price them twice. */
  it('collapses duplicate lands into a single option', () => {
    const state = position({ hand: [MOUNTAIN, MOUNTAIN, MOUNTAIN] });
    expect(rankLandDrops(state, generateLegalActions(state), DEFAULT_HEURISTIC_WEIGHTS)).toHaveLength(1);
  });

  /**
   * The hot-path guard, stated as behaviour rather than as a comment: with a single
   * land drop on offer the answer is that action, and the scorer never runs (its
   * merit is the untouched zero it was seeded with).
   */
  it('answers a lone land drop without scoring anything', () => {
    const state = position({ board: [MOUNTAIN], hand: [SWAMP, MURDER], enemyBoard: [ENEMY_GIANT] });
    const options = rankLandDrops(state, generateLegalActions(state), DEFAULT_HEURISTIC_WEIGHTS);
    expect(options).toHaveLength(1);
    expect(options[0]?.merit).toBe(0);
    expect(landPlayed(state, bestLandDrop(state, generateLegalActions(state), DEFAULT_HEURISTIC_WEIGHTS))).toBe(
      'Swamp',
    );
  });

  it('offers nothing when no land can be played', () => {
    const state = position({ board: [MOUNTAIN], hand: [MURDER], enemyBoard: [ENEMY_GIANT] });
    const legal = generateLegalActions(state);
    expect(rankLandDrops(state, legal, DEFAULT_HEURISTIC_WEIGHTS)).toEqual([]);
    expect(bestLandDrop(state, legal, DEFAULT_HEURISTIC_WEIGHTS)).toBeUndefined();
  });
});

describe('land sequencing — switched off, it is the old pilot', () => {
  /**
   * `LAND_SEQUENCING_OFF_WEIGHTS` is not a debug toggle: it is the CONTROL ARM of
   * the strength measurement, and a control arm that is not really the old code
   * measures nothing. Zeroed weights make every land tie, and a tie resolves to the
   * first offered action — which on the pinned position is the wrong land, exactly
   * as the defect described.
   */
  it('reproduces the defect it was written to reproduce', () => {
    const state = position({
      board: [MOUNTAIN],
      hand: [MOUNTAIN, SWAMP, MURDER],
      enemyBoard: [ENEMY_GIANT],
    });
    expect(pilotPlays(state, OFF)).toBe('Mountain');
    expect(pilotPlays(state)).toBe('Swamp');
  });

  it('leaves every land candidate on exactly playLandScore, as the old policy did', () => {
    const state = position({
      board: [MOUNTAIN],
      hand: [MOUNTAIN, SWAMP, MURDER],
      enemyBoard: [ENEMY_GIANT],
    });
    const lands = policyCandidates(state, generateLegalActions(state), OFF, true).filter(
      (c) => c.plies[0]?.kind === 'playLand',
    );
    expect(lands.map((c) => c.score)).toEqual([OFF.playLandScore, OFF.playLandScore]);
  });
});

describe('land sequencing — you can watch it decide', () => {
  /**
   * DESIGN §1 rule 3: a system is not done until you can observe it at runtime. The
   * land drop already flowed through the pilot's `trace` seam, but the reason it
   * emitted was the constant "play a land" — which is exactly as informative as the
   * bug was. It now names the land it took and what it beat.
   */
  it('the decision trace names the land and what it beat', () => {
    const state = position({
      board: [MOUNTAIN],
      hand: [MOUNTAIN, SWAMP, MURDER],
      enemyBoard: [ENEMY_GIANT],
    });
    const traces: string[] = [];
    createHeuristicPilot().chooseAction({
      view: state,
      legalActions: generateLegalActions(state),
      rng: createRng(state.seed),
      trace: (t) => traces.push(t.reason),
    });
    expect(traces[0]).toContain('Swamp');
    expect(traces[0]).toContain('Mountain');
  });

  it('says so plainly when there was no choice to make', () => {
    const state = position({ board: [MOUNTAIN], hand: [SWAMP, MURDER], enemyBoard: [ENEMY_GIANT] });
    const legal = generateLegalActions(state);
    const chosen = bestLandDrop(state, legal, DEFAULT_HEURISTIC_WEIGHTS) as GameAction;
    expect(describeLandDrop(state, chosen, legal, DEFAULT_HEURISTIC_WEIGHTS)).toContain('the only land in hand');
  });
});

describe('land sequencing — determinism', () => {
  /**
   * Determinism is the product (DESIGN §1): the same position must produce the same
   * land every time, and the ranking must not depend on anything but the position.
   */
  it('is stable across repeated calls on the same position', () => {
    const state = position({
      board: [MOUNTAIN],
      hand: [MOUNTAIN, SWAMP, MURDER],
      enemyBoard: [ENEMY_GIANT],
    });
    const legal = generateLegalActions(state);
    const first = rankLandDrops(state, legal, DEFAULT_HEURISTIC_WEIGHTS).map((o) => `${o.name}:${o.merit}`);
    for (let i = 0; i < 3; i++) {
      expect(rankLandDrops(state, legal, DEFAULT_HEURISTIC_WEIGHTS).map((o) => `${o.name}:${o.merit}`)).toEqual(first);
    }
  });

  /** Ranking must not MUTATE the position it is asked about — it is a pure question. */
  it('does not touch the state it reads', () => {
    const state = position({
      board: [MOUNTAIN],
      hand: [MOUNTAIN, SWAMP, MURDER],
      enemyBoard: [ENEMY_GIANT],
    });
    const before = JSON.stringify(state);
    rankLandDrops(state, generateLegalActions(state), DEFAULT_HEURISTIC_WEIGHTS);
    expect(JSON.stringify(state)).toBe(before);
  });
});

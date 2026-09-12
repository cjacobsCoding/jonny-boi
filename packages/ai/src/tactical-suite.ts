/**
 * THE CURATED TACTICAL TEST SUITE (`docs/plans/superhuman-ai-program.md` §48, §51).
 *
 * > "Build curated tactical test suites (lethal, anti-lethal, combat, removal,
 * >  counterspell, sequencing, mana, sacrifice, stack, bluff, resource puzzles) so
 * >  aggregate win rate can't hide tactical regression."
 *
 * ## Why a win rate is not enough, stated concretely
 * A pilot's win rate over 120 games has a 95% interval roughly ±9 points wide.
 * A change that fixes one blunder class and breaks another can move it by nothing
 * at all, and the recorded history of this repo is full of exactly that shape:
 * tree reuse ran a search 2.4× deeper in information and produced **identical**
 * play; `evalWastedManaPenalty` fixed a measured symptom and cost 11.6 points.
 * These positions ask a specific question with a known right answer, so a pilot
 * that stops seeing lethal shows up as "lethal 4/4 → 2/4" rather than as noise.
 *
 * ## What counts as "the right answer"
 * Each puzzle carries an `accepts` predicate over the chosen action, not a single
 * blessed move. Several positions have more than one strong line, and a suite that
 * demanded one exact action would fail a pilot for playing a *different* good move
 * — which is a false alarm, and false alarms are how a suite gets ignored. The
 * predicate encodes the property that makes a line right ("this attack contains
 * the flier", "at least two attackers are blocked"), never the line itself.
 *
 * ## Deliberately not in the built package
 * Excluded from `tsconfig.json`, like `test-support.ts`: these are fixtures with a
 * grading function, and the consumer is `tactical-suite.test.ts`. Keeping them out
 * of `dist` means the suite can grow freely without growing the public API.
 */

import type { CardInstance, EffectRegistry, GameAction, GameState, InstanceId, PlayerId } from '@jonny-boi/core';
import { createGame, generateLegalActions, type DeckList } from '@jonny-boi/core';
import type { Pilot } from './pilot.js';
import { createRng } from '@jonny-boi/core';
import { creatureDef, destroyDef, giveHand, landDef, putOnBattlefield } from './test-support.js';

/** The families the brief names. One puzzle may only belong to one, on purpose. */
export type TacticalCategory =
  | 'lethal'
  | 'anti-lethal'
  | 'combat'
  | 'removal'
  | 'sequencing'
  | 'mana';

/** A position, the question it asks, and what counts as answering it. */
export interface TacticalPuzzle {
  readonly id: string;
  readonly category: TacticalCategory;
  /** What a strong player sees here, in one line. */
  readonly question: string;
  /** Why the accepted answers are the right ones — the reasoning, not the move. */
  readonly why: string;
  /** Build the position. Called fresh per pilot so no puzzle can leak into another. */
  readonly setUp: () => GameState;
  /** Does this action answer the question? */
  readonly accepts: (action: GameAction, state: GameState) => boolean;
}

/** One pilot's answer to one puzzle. */
export interface TacticalPuzzleResult {
  readonly puzzle: TacticalPuzzle;
  readonly solved: boolean;
  /** What the pilot actually played, for a failure message worth reading. */
  readonly played: string;
}

/** A pilot's score over the whole suite. */
export interface TacticalSuiteReport {
  readonly pilotId: string;
  readonly solved: number;
  readonly total: number;
  readonly results: readonly TacticalPuzzleResult[];
  /** Solved / total per category, so a regression names its own family. */
  readonly byCategory: ReadonlyMap<TacticalCategory, { solved: number; total: number }>;
}

// --- the puzzle vocabulary ------------------------------------------------------
//
// A fixed cast of printed-like cards rather than ad-hoc numbers, so a puzzle reads
// as a board a player could describe out loud and two puzzles that say "a 3/3"
// mean the same 3/3.

const MOUNTAIN = landDef('Mountain', 'R');
const SWAMP = landDef('Swamp', 'B');
const ISLAND = landDef('Island', 'U');
const BEAR = creatureDef('Grizzly Bears 2/2', 2, 2, { cost: { generic: 1, R: 1 } });
const OGRE = creatureDef('Hill Giant 3/3', 3, 3, { cost: { generic: 2, R: 1 } });
const KNIGHT = creatureDef('Knight 4/4', 4, 4, { cost: { generic: 3, R: 1 } });
const GIANT = creatureDef('Colossus 5/5', 5, 5, { cost: { generic: 4, R: 1 } });
const WALL = creatureDef('Wall 0/4', 0, 4, { cost: { generic: 1 } });
const BIG_WALL = creatureDef('Rampart 0/6', 0, 6, { cost: { generic: 2 } });
const ANGEL = creatureDef('Sky Knight 4/4 flying', 4, 4, {
  cost: { generic: 3, R: 1 },
  keywords: { flying: true },
});
const REACH_GIANT = creatureDef('Canopy Colossus 5/5 reach', 5, 5, {
  cost: { generic: 4, R: 1 },
  keywords: { reach: true },
});
const TRAMPLER = creatureDef('Trampler 6/6', 6, 6, {
  cost: { generic: 5, R: 1 },
  keywords: { trample: true },
});
const MURDER = destroyDef('Murder', { generic: 1, B: 1 });

/** A deck stub big enough to start a game; every puzzle sculpts the board by hand. */
function stubDeck(): DeckList {
  return { cards: Array.from({ length: 40 }, (_, i) => landDef(`Filler ${i}`, 'R')) };
}

/** A fresh, empty game with both hands cleared. */
function emptyGame(): GameState {
  const { state } = createGame({ seed: 20260815, decks: { A: stubDeck(), B: stubDeck() } });
  state.players.A.hand = [];
  state.players.B.hand = [];
  state.stack = [];
  return state;
}

/** Put `player` at their declare-attackers step with priority. */
function atDeclareAttackers(state: GameState, player: PlayerId): void {
  state.step = 'declareAttackers';
  state.activePlayer = player;
  state.priorityPlayer = player;
  state.combat = { attackers: [], blocks: {}, attackersDeclared: false, blockersDeclared: false };
}

/** Put `defender` at their declare-blockers step facing `attackers`. */
function atDeclareBlockers(
  state: GameState,
  attacker: PlayerId,
  defender: PlayerId,
  attackers: readonly CardInstance[],
): void {
  state.step = 'declareBlockers';
  state.activePlayer = attacker;
  state.priorityPlayer = defender;
  for (const a of attackers) a.tapped = true;
  state.combat = {
    attackers: attackers.map((a) => a.instanceId),
    blocks: {},
    attackersDeclared: true,
    blockersDeclared: false,
  };
}

/** Put `player` in their precombat main with priority and no land drop spent. */
function atPrecombatMain(state: GameState, player: PlayerId): void {
  state.step = 'precombatMain';
  state.activePlayer = player;
  state.priorityPlayer = player;
  state.combat = null;
  state.players[player].landsPlayedThisTurn = 0;
}

// --- predicates used by the puzzles ---------------------------------------------

function declaredAttackers(action: GameAction): readonly InstanceId[] | undefined {
  return action.kind === 'declareAttackers' ? action.attackers : undefined;
}

/** An action that leaves combat without attacking (pass, or an empty declaration). */
function isNoAttack(action: GameAction): boolean {
  if (action.kind === 'passPriority') return true;
  const attackers = declaredAttackers(action);
  return attackers !== undefined && attackers.length === 0;
}

function blockCount(action: GameAction): number {
  return action.kind === 'declareBlockers' ? action.blocks.length : 0;
}

// --- the puzzles -----------------------------------------------------------------

/**
 * The suite. Each entry is self-contained: nothing is shared between puzzles
 * except the card vocabulary, so one failing puzzle cannot cascade.
 */
export const TACTICAL_PUZZLES: readonly TacticalPuzzle[] = Object.freeze([
  {
    id: 'lethal/chump-blockers-cannot-save-them',
    category: 'lethal',
    question: 'Four 3/3s into one 0/4 blocker, opponent at 5. Is the kill there?',
    why:
      'The wall eats one attacker; nine damage still lands and the opponent is at five. ' +
      'A pilot that counts blockers as a reason not to attack loses a won game here.',
    setUp() {
      const state = emptyGame();
      putOnBattlefield(state, 'A', [OGRE, OGRE, OGRE, OGRE]);
      putOnBattlefield(state, 'B', [WALL]);
      state.players.B.life = 5;
      atDeclareAttackers(state, 'A');
      return state;
    },
    accepts(action) {
      // The kill needs at least three of the four through: any declaration of
      // three or more is lethal, so grading on the property rather than on "all
      // four" keeps a different-but-winning line from failing.
      return (declaredAttackers(action)?.length ?? 0) >= 3;
    },
  },
  {
    id: 'lethal/evasion-is-the-whole-answer',
    category: 'lethal',
    question: 'A 4/4 flier and a 2/2, opponent at 4 behind three 3/3 ground blockers.',
    why:
      'Nothing they control can block a flier, so exactly four damage is guaranteed and ' +
      'four is lethal. Summed power says eight against three blockers and looks stopped; ' +
      'the flier has to be reasoned about separately, which is what the solver does.',
    setUp() {
      const state = emptyGame();
      putOnBattlefield(state, 'A', [ANGEL, BEAR]);
      putOnBattlefield(state, 'B', [OGRE, OGRE, OGRE]);
      state.players.B.life = 4;
      atDeclareAttackers(state, 'A');
      return state;
    },
    accepts(action, state) {
      // Found by DEFINITION rather than by an id smuggled through the state: a
      // puzzle whose grading depends on side-channel bookkeeping is a puzzle whose
      // grading can silently drift from the position it grades.
      const flier = state.battlefield.find((c) => c.controller === 'A' && c.def === ANGEL);
      return flier !== undefined && declaredAttackers(action)?.includes(flier.instanceId) === true;
    },
  },
  {
    id: 'lethal/reach-turns-it-off',
    category: 'lethal',
    question: 'The same 4/4 flier, but they hold a 5/5 with reach and are at 4.',
    why:
      'Reach blocks fliers, so the four damage is no longer guaranteed — and this ' +
      'particular blocker eats the Angel without dying. The previous puzzle must not be ' +
      'passed by a rule that treats "flying" as "unblockable"; this is that rule failing.',
    setUp() {
      const state = emptyGame();
      putOnBattlefield(state, 'A', [ANGEL]);
      putOnBattlefield(state, 'B', [REACH_GIANT]);
      state.players.B.life = 4;
      atDeclareAttackers(state, 'A');
      return state;
    },
    accepts: (action) => isNoAttack(action),
  },
  {
    id: 'combat/do-not-swing-into-a-wall-of-bigger-creatures',
    category: 'combat',
    question: 'Two 4/4s into three untapped 5/5s, both players at 20.',
    why:
      'Summed power is 8 against a 20 life total, so a "can I kill" read based on power ' +
      'alone sees nothing — but a pilot that attacks here simply hands over two creatures. ' +
      'This is the position the OLD lethal term mispriced in the other direction.',
    setUp() {
      const state = emptyGame();
      putOnBattlefield(state, 'A', [KNIGHT, KNIGHT]);
      putOnBattlefield(state, 'B', [GIANT, GIANT, GIANT]);
      atDeclareAttackers(state, 'A');
      return state;
    },
    accepts: (action) => isNoAttack(action),
  },
  {
    id: 'combat/attack-when-blocking-is-a-losing-trade-for-them',
    category: 'combat',
    question: 'A 3/3 into a single 2/2, opponent at 20.',
    why:
      'Blocking loses them the 2/2 and kills nothing; not blocking costs three life. ' +
      'Either way the attack profits, so declining it is a pure loss of tempo.',
    setUp() {
      const state = emptyGame();
      putOnBattlefield(state, 'A', [OGRE]);
      putOnBattlefield(state, 'B', [BEAR]);
      atDeclareAttackers(state, 'A');
      return state;
    },
    accepts: (action) => (declaredAttackers(action)?.length ?? 0) >= 1,
  },
  {
    id: 'combat/trample-still-gets-there',
    category: 'lethal',
    question: 'A 6/6 trampler into one 0/4 wall, opponent at 2.',
    why:
      'The wall absorbs four; two tramples over and that is exactly lethal. A solver that ' +
      'treats any blocker as stopping an attacker calls this "blocked" and passes.',
    setUp() {
      const state = emptyGame();
      putOnBattlefield(state, 'A', [TRAMPLER]);
      putOnBattlefield(state, 'B', [WALL]);
      state.players.B.life = 2;
      atDeclareAttackers(state, 'A');
      return state;
    },
    accepts: (action) => (declaredAttackers(action)?.length ?? 0) >= 1,
  },
  {
    id: 'anti-lethal/chump-block-to-survive',
    category: 'anti-lethal',
    question: 'At 4 life, facing three 3/3s, holding three 2/2s.',
    why:
      'Nine damage against four life. Every 2/2 dies whatever it blocks, so "block only ' +
      'for value" says take it — and taking it loses the game on the spot. Two blocks ' +
      'is the minimum that survives.',
    setUp() {
      const state = emptyGame();
      const attackers = putOnBattlefield(state, 'B', [OGRE, OGRE, OGRE]);
      putOnBattlefield(state, 'A', [BEAR, BEAR, BEAR]);
      state.players.A.life = 4;
      atDeclareBlockers(state, 'B', 'A', attackers);
      return state;
    },
    accepts: (action) => blockCount(action) >= 2,
  },
  {
    id: 'anti-lethal/do-not-tap-out-into-a-lethal-crackback',
    category: 'anti-lethal',
    question: 'At 5 life with three 3/3s, facing three tapped 3/3s and an opponent at 20.',
    why:
      'The alpha strike deals nine to a player at twenty and leaves us with no untapped ' +
      'blocker at all. Their nine power untaps and kills us from five before we get ' +
      'another turn. Attacking with everything here is a loss disguised as pressure.',
    setUp() {
      const state = emptyGame();
      putOnBattlefield(state, 'A', [OGRE, OGRE, OGRE]);
      const theirs = putOnBattlefield(state, 'B', [OGRE, OGRE, OGRE]);
      for (const c of theirs) c.tapped = true;
      state.players.A.life = 5;
      atDeclareAttackers(state, 'A');
      return state;
    },
    accepts(action) {
      const attackers = declaredAttackers(action);
      // Holding at least one blocker back is the property that matters; whether it
      // is one or three is a judgement the suite has no business grading.
      if (attackers === undefined) return action.kind === 'passPriority';
      return attackers.length <= 2;
    },
  },
  {
    id: 'removal/kill-the-thing-that-is-killing-you',
    category: 'removal',
    question: 'Murder in hand with the mana up, opponent has a 5/5 and we have a 2/2.',
    why:
      'The only card in hand answers the only threat on the board, and the mana is ' +
      'available this turn. A pilot that holds it here is not holding interaction, it is ' +
      'declining to interact.',
    setUp() {
      const state = emptyGame();
      putOnBattlefield(state, 'A', [SWAMP, SWAMP]);
      putOnBattlefield(state, 'A', [BEAR]);
      putOnBattlefield(state, 'B', [GIANT]);
      giveHand(state, 'A', [MURDER]);
      atPrecombatMain(state, 'A');
      return state;
    },
    accepts(action) {
      // The macro's FIRST ply funds the cast, so either the tap that starts it or
      // the cast itself is the right first action.
      if (action.kind === 'castSpell') return true;
      return action.kind === 'tapForMana';
    },
  },
  {
    id: 'sequencing/land-first-then-the-spell-it-pays-for',
    category: 'sequencing',
    question: 'One Mountain in play, a Mountain and a three-mana 3/3 in hand.',
    why:
      'The land drop is free and unlocks nothing this turn — but playing the creature ' +
      'is impossible and passing wastes the turn, so the only action that develops ' +
      'anything is the land. Sequencing puzzles are where a pilot that scores cards ' +
      'without scoring ORDER goes wrong.',
    setUp() {
      const state = emptyGame();
      putOnBattlefield(state, 'A', [MOUNTAIN]);
      giveHand(state, 'A', [MOUNTAIN, OGRE]);
      atPrecombatMain(state, 'A');
      return state;
    },
    accepts: (action) => action.kind === 'playLand',
  },
  {
    id: 'sequencing/play-the-land-that-casts-the-spell',
    category: 'sequencing',
    question: 'A Mountain in play; a Mountain, a Swamp and Murder ({1}{B}) in hand.',
    why:
      'Both land drops look identical to anything that scores cards one at a time — a ' +
      'land is a land. Only the Swamp makes the removal castable this turn; the Mountain ' +
      'is the same play a turn too late. This is the sequencing decision the brief calls ' +
      'out (§4 "sequence A before B"), and it cannot be reached by scoring the cards ' +
      'independently of what they unlock.',
    setUp() {
      const state = emptyGame();
      putOnBattlefield(state, 'A', [MOUNTAIN]);
      putOnBattlefield(state, 'B', [GIANT]);
      giveHand(state, 'A', [MOUNTAIN, SWAMP, MURDER]);
      atPrecombatMain(state, 'A');
      return state;
    },
    accepts(action, state) {
      if (action.kind !== 'playLand') return false;
      const played = state.players.A.hand.find((c) => c.instanceId === action.instanceId);
      return played?.def === SWAMP;
    },
  },
  {
    id: 'mana/tap-the-colour-the-spell-needs',
    category: 'mana',
    question: 'Murder ({1}{B}) in hand; an Island, a Mountain and one Swamp untapped.',
    why:
      'Only one source makes black, so the Swamp must be part of the payment. Tapping ' +
      'both an Island and a Mountain leaves the spell uncastable with the mana already ' +
      'spent — the exact "tap and cannot spend" failure the atomic action space exists ' +
      'to make unrepresentable.',
    setUp() {
      const state = emptyGame();
      putOnBattlefield(state, 'A', [ISLAND, MOUNTAIN, SWAMP]);
      putOnBattlefield(state, 'B', [GIANT]);
      giveHand(state, 'A', [MURDER]);
      atPrecombatMain(state, 'A');
      return state;
    },
    accepts(action, state) {
      if (action.kind !== 'tapForMana') return action.kind === 'castSpell';
      const source = state.battlefield.find((c) => c.instanceId === action.instanceId);
      // The generic half may be paid by anything, so a first tap of the Island or
      // Mountain is fine — what must never happen is a payment that cannot include
      // the Swamp. Requiring the Swamp to still be untapped catches that.
      const swamp = state.battlefield.find((c) => c.def === SWAMP);
      return source !== undefined && (source.def === SWAMP || swamp?.tapped === false);
    },
  },
]);

// --- the evaluator half -------------------------------------------------------------
//
// The puzzles above grade a PILOT, and on a small board a 160-simulation search
// solves most of them whatever its evaluator thinks — it simply plays the game out
// and sees the win. That is a real result and it is why these are here as well: the
// pilot half cannot isolate the leaf evaluator, and the leaf evaluator is what the
// measurements say is binding. So the second half grades `evaluateState` directly,
// on pairs of positions that are both REACHABLE SUCCESSORS OF THE SAME DECISION —
// which is precisely the comparison a search performs when it backs a reward up.

/** Two positions and the claim that one is better than the other for `player`. */
export interface EvaluationPuzzle {
  readonly id: string;
  readonly category: TacticalCategory;
  readonly question: string;
  readonly why: string;
  readonly player: PlayerId;
  /** The position that must score HIGHER. */
  readonly better: () => GameState;
  /** The position it must beat. */
  readonly worse: () => GameState;
}

/** One evaluator's answer to one ordering puzzle. */
export interface EvaluationPuzzleResult {
  readonly puzzle: EvaluationPuzzle;
  readonly correct: boolean;
  readonly betterScore: number;
  readonly worseScore: number;
}

/** An evaluator's score over the ordering puzzles. */
export interface EvaluationSuiteReport {
  readonly label: string;
  readonly correct: number;
  readonly total: number;
  readonly results: readonly EvaluationPuzzleResult[];
}

/** Declare `attackers` as having attacked — the state one ply after the swing. */
function withAttackDeclared(state: GameState, attacker: PlayerId, attackers: readonly CardInstance[]): GameState {
  for (const a of attackers) a.tapped = true;
  state.step = 'declareBlockers';
  state.activePlayer = attacker;
  state.priorityPlayer = attacker === 'A' ? 'B' : 'A';
  state.combat = {
    attackers: attackers.map((a) => a.instanceId),
    blocks: {},
    attackersDeclared: true,
    blockersDeclared: false,
  };
  return state;
}

/** Declare NO attackers — the state one ply after declining the swing. */
function withAttackDeclined(state: GameState, attacker: PlayerId): GameState {
  state.step = 'declareBlockers';
  state.activePlayer = attacker;
  state.priorityPlayer = attacker === 'A' ? 'B' : 'A';
  state.combat = { attackers: [], blocks: {}, attackersDeclared: true, blockersDeclared: false };
  return state;
}

export const EVALUATION_PUZZLES: readonly EvaluationPuzzle[] = Object.freeze([
  {
    id: 'eval/declaring-the-kill-must-not-be-scored-below-declining-it',
    category: 'lethal',
    question: 'Two 3/3s, opponent at 6 with no blockers. Swing, or decline?',
    why:
      'THE DEFECT THIS SUITE WAS BUILT TO CATCH. The old lethal term read "power of my ' +
      'UNTAPPED creatures >= their life" — and attackers TAP when they are declared. So ' +
      'the bonus was paid for the board that had not attacked yet and withdrawn the ' +
      'instant it did: the evaluator scored taking the kill BELOW passing on it. A search ' +
      'only escapes that by playing far enough forward to reach the win, which on a real ' +
      'board it often cannot afford to do.',
    player: 'A',
    better() {
      const state = emptyGame();
      const mine = putOnBattlefield(state, 'A', [OGRE, OGRE]);
      state.players.B.life = 6;
      return withAttackDeclared(state, 'A', mine);
    },
    worse() {
      const state = emptyGame();
      putOnBattlefield(state, 'A', [OGRE, OGRE]);
      state.players.B.life = 6;
      return withAttackDeclined(state, 'A');
    },
  },
  {
    id: 'eval/a-kill-that-blockers-stop-is-not-a-kill',
    category: 'lethal',
    question: 'Fifteen power against six life — behind three untapped 0/4 walls.',
    why:
      'The blocker-blind read fires here (15 >= 6) and pays a full lethal bonus for a ' +
      'board that cannot land a single point of damage. Scoring this ABOVE a board with ' +
      'genuinely unblockable damage is how a pilot talks itself into a pointless attack.',
    player: 'A',
    better() {
      const state = emptyGame();
      putOnBattlefield(state, 'A', [OGRE, OGRE]);
      state.players.B.life = 6;
      return state;
    },
    worse() {
      const state = emptyGame();
      putOnBattlefield(state, 'A', [GIANT, GIANT, GIANT]);
      putOnBattlefield(state, 'B', [WALL, WALL, WALL]);
      state.players.B.life = 6;
      return state;
    },
  },
  {
    id: 'eval/being-dead-on-board-must-cost-something',
    category: 'anti-lethal',
    question: 'At 5 life against three 3/3s: blockers up, or blockers tapped?',
    why:
      'Nine power against five life is a loss next turn unless something blocks. The ' +
      'evaluator had NO term of any kind for that — the two positions differed only by ' +
      'a `tapped` flag it never consulted for defence — so a pilot could tap its whole ' +
      'board out and read the result as unchanged.',
    player: 'A',
    better() {
      const state = emptyGame();
      putOnBattlefield(state, 'A', [BEAR, BEAR]);
      putOnBattlefield(state, 'B', [OGRE, OGRE, OGRE]);
      state.players.A.life = 5;
      return state;
    },
    worse() {
      const state = emptyGame();
      const mine = putOnBattlefield(state, 'A', [BEAR, BEAR]);
      for (const c of mine) c.tapped = true;
      putOnBattlefield(state, 'B', [OGRE, OGRE, OGRE]);
      state.players.A.life = 5;
      return state;
    },
  },
  {
    id: 'eval/board-that-can-attack-beats-board-that-cannot',
    category: 'combat',
    question: 'Twelve points of stats as two 3/3s, or as two 0/6 walls.',
    why:
      'Summed power-plus-toughness cannot tell these apart — both are twelve — but only ' +
      'one of them can ever end the game. This is the term `boardWeight` was missing: how ' +
      'much board there is, versus whether any of it threatens anything.',
    player: 'A',
    better() {
      const state = emptyGame();
      putOnBattlefield(state, 'A', [OGRE, OGRE]);
      return state;
    },
    worse() {
      const state = emptyGame();
      putOnBattlefield(state, 'A', [BIG_WALL, BIG_WALL]);
      return state;
    },
  },
  {
    id: 'eval/the-faster-clock-wins-the-long-game',
    category: 'combat',
    question: 'A 4/4 flier against a 4/4 ground creature — or the same board reversed.',
    why:
      'Every static count is identical: same life, same hands, same creature count, same ' +
      'four-plus-four of stats on each side. Only the CLOCK differs, and it differs ' +
      'completely — the flier attacks unopposed for five turns while the ground creature ' +
      'is blocked by that same flier every turn and never connects. Inevitability (§10) ' +
      'is the whole content of this position, and a stats-summing evaluator scores it a ' +
      'dead heat.',
    player: 'A',
    better() {
      const state = emptyGame();
      putOnBattlefield(state, 'A', [ANGEL]);
      putOnBattlefield(state, 'B', [KNIGHT]);
      return state;
    },
    worse() {
      const state = emptyGame();
      putOnBattlefield(state, 'A', [KNIGHT]);
      putOnBattlefield(state, 'B', [ANGEL]);
      return state;
    },
  },
]);

/** Score an evaluator against the ordering puzzles. */
export function runEvaluationSuite(
  label: string,
  evaluate: (state: GameState, player: PlayerId) => number,
  puzzles: readonly EvaluationPuzzle[] = EVALUATION_PUZZLES,
): EvaluationSuiteReport {
  const results = puzzles.map((puzzle) => {
    const betterScore = evaluate(puzzle.better(), puzzle.player);
    const worseScore = evaluate(puzzle.worse(), puzzle.player);
    return { puzzle, correct: betterScore > worseScore, betterScore, worseScore };
  });
  return { label, correct: results.filter((r) => r.correct).length, total: results.length, results };
}

// --- grading ----------------------------------------------------------------------

/** Everything `runTacticalSuite` needs beyond the pilot, named rather than positional. */
export interface TacticalSuiteOptions {
  /**
   * The effect bodies the look-ahead pilots roll out against. **Required, and that
   * is the fix** — see the warning on {@link runTacticalSuite}.
   */
  readonly registry: EffectRegistry;
  /** Which puzzles to grade. Defaults to the whole curated set. */
  readonly puzzles?: readonly TacticalPuzzle[];
}

/**
 * Run every puzzle against a pilot and score it.
 *
 * The effect registry is threaded into the decision context so a look-ahead pilot
 * rolls out at full fidelity — without it `Murder` no-ops inside the search and the
 * removal puzzle would be grading the pilot on a game where removal does nothing.
 * The RNG is rebuilt per puzzle from a fixed seed, so a report is reproducible and
 * two pilots are compared on identical randomness.
 *
 * ⚠️ **THAT PARAGRAPH WAS FALSE FOR AS LONG AS IT HAS BEEN WRITTEN, AND THIS
 * SIGNATURE IS WHY IT CANNOT BE AGAIN.** The body built its own registry with
 * `createTestRegistry()`, which knew `dealDamage` and nothing else — so `Murder`'s
 * `destroyTarget` fell through to core's silent-unknown path on **every one of the
 * 869 times** the search resolved it, and the removal category was graded against
 * precisely the game the comment promised it was not. A comment claiming fidelity
 * over a body that cannot deliver it is worse than no comment: it is a check
 * reporting something other than "I didn't check" (DESIGN §3.143).
 *
 * So the registry is now a REQUIRED argument the caller must supply, and it arrives
 * in an options object rather than as a third positional — `applyAction`'s
 * `(state, action, config, registry)` has been mis-called with `{ registry }` in
 * nine places for exactly the reason a bare positional invites. The caller is a
 * `*.test.ts`, which MAY import `@jonny-boi/cards`, so it passes the real bodies.
 */
export function runTacticalSuite(pilot: Pilot, options: TacticalSuiteOptions): TacticalSuiteReport {
  const { registry, puzzles = TACTICAL_PUZZLES } = options;
  const results: TacticalPuzzleResult[] = [];
  const byCategory = new Map<TacticalCategory, { solved: number; total: number }>();

  for (const puzzle of puzzles) {
    const state = puzzle.setUp();
    const legalActions = generateLegalActions(state);
    const action = pilot.chooseAction({
      view: state,
      legalActions,
      rng: createRng(SUITE_SEED),
      registry,
    });
    const solved = puzzle.accepts(action, state);
    results.push({ puzzle, solved, played: describe(action) });
    const bucket = byCategory.get(puzzle.category) ?? { solved: 0, total: 0 };
    bucket.total++;
    if (solved) bucket.solved++;
    byCategory.set(puzzle.category, bucket);
  }

  return {
    pilotId: pilot.id,
    solved: results.filter((r) => r.solved).length,
    total: results.length,
    results,
    byCategory,
  };
}

/** Fixed so a report is reproducible and two pilots see identical randomness. */
const SUITE_SEED = 4242;

/** A short, readable rendering of an action for a failure message. */
function describe(action: GameAction): string {
  switch (action.kind) {
    case 'declareAttackers':
      return `declareAttackers ×${action.attackers.length}`;
    case 'declareBlockers':
      return `declareBlockers ×${action.blocks.length}`;
    case 'castSpell':
      return `castSpell #${action.instanceId}`;
    case 'tapForMana':
      return `tapForMana #${action.instanceId}`;
    case 'playLand':
      return `playLand #${action.instanceId}`;
    default:
      return action.kind;
  }
}

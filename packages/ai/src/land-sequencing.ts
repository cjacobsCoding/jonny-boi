/**
 * LAND SEQUENCING — which land to play, scored by what it **unlocks**.
 *
 * The `heuristic` pilot used to treat every land drop as the same move: it scored
 * "play a land" once, at `weights.playLandScore`, and then took the FIRST offered
 * `playLand` action. That is correct exactly as long as your lands are
 * interchangeable, and wrong the moment they are not. The measured failure (pinned
 * by `tactical-suite.test.ts`): a Mountain in play, a Mountain, a Swamp and Murder
 * (`{1}{B}`) in hand — every pilot played the Mountain and left its own removal
 * uncastable for a turn.
 *
 * The fix is one idea: **a land is worth what it lets you do**, so a land drop is
 * ranked by the spells it makes castable, by the colours it stops us stranding, and
 * by whether this is the free turn to spend a land that arrives tapped.
 *
 * ## Castability is asked, never re-derived
 *
 * "Would this spell be payable if that land were in play" goes through core's
 * `planManaPayment` — the same planner the pilot funds its real casts with and the
 * same one `policyCandidates` builds its atomic macros with. There is therefore
 * exactly ONE answer to "which lands fund this" in the codebase, and this module
 * cannot drift from the pilot the way a private "do I have enough of the right
 * colour" check inevitably would. The hypothetical is expressed as data the planner
 * already understands: a battlefield with the land added and the `tapForMana`
 * actions that land would offer.
 *
 * ## Why this does not cost the hot path anything measurable
 *
 * The heuristic is `DEFAULT_PILOT_ID` *and* the search's rollout policy, so it runs
 * on the order of 20,000 times per look-ahead decision (DESIGN §1 rule 7). All of
 * the work below is behind one gate: **it only runs when there are at least two
 * genuinely different lands to choose between.** With one land drop offered — the
 * common case, and the only case a mono-coloured deck ever sees — the answer is the
 * same action the old scan returned, reached by the same single pass and with
 * nothing allocated.
 *
 * ## Everything is weight-driven, including "off"
 *
 * The three terms are named `HeuristicWeights` fields (DESIGN §1 — no magic
 * numbers). Zeroing all three makes every land drop tie, and a tie resolves to the
 * first offered action, which is byte-for-byte the pre-fix behaviour — that is what
 * `LAND_SEQUENCING_OFF_WEIGHTS` is for, and it is how the before/after strength
 * measurement runs both arms inside one process (see `bench/mcts-bench.mjs`).
 *
 * Determinism: pure, reads no clock and no `Math.random`, and every tie resolves
 * positionally rather than randomly.
 */

import type {
  CardDefinition,
  CardInstance,
  GameAction,
  GameState,
  InstanceId,
  ManaColor,
  ManaCost,
  PlayerId,
} from '@jonny-boi/core';
import {
  bestManaYield,
  convertedManaCost,
  entersTapped,
  isLand,
  MANA_COLORS,
  manaColorsOffered,
  manaModesOf,
  planManaPayment,
} from '@jonny-boi/core';
import { cardValue } from './card-value.js';
import type { PilotView } from './pilot.js';
import type { HeuristicWeights } from './weights.js';

/**
 * One land the pilot could play this window, with the sequencing merit that says
 * how much better it is than the alternatives.
 *
 * `merit` is a RELATIVE quantity in `cardValue` units and is meaningful only
 * against the other options from the same call — never as an absolute score. The
 * consumers turn it into an absolute score themselves, and both do it the same way:
 * the best land keeps exactly `weights.playLandScore`, so land-versus-spell
 * ordering is untouched and only land-versus-land ordering changes.
 */
export interface LandDropOption {
  /** The engine's own `playLand` action for this land. */
  readonly action: GameAction;
  /** The card in hand, when it could be resolved (it always can in a real game). */
  readonly card: CardInstance | undefined;
  /** Display name, used for candidate labels and for de-duplication. */
  readonly name: string;
  /** Sequencing merit — higher is better. Comparable only within one call. */
  readonly merit: number;
}

/**
 * Every DISTINCT land drop on offer, ranked by what it unlocks, best merit first
 * among equals preserved in offer order.
 *
 * "Distinct" is by card NAME, which is the contract `policyCandidates` already had
 * and is pinned by a test: playing either of two Mountains from hand is the same
 * decision (brief §4 Level 1), and a search that treats them as two options wastes
 * half its budget proving they are the same. (Name rather than definition identity
 * because a fixture may build two structurally identical `CardDefinition` objects,
 * and two Mountains are two Mountains however they were constructed.)
 *
 * Returns an empty array when no land can be played. When only one distinct land is
 * offered it returns that one with `merit: 0` **without doing any of the work** —
 * there is nothing to choose between, so there is nothing to pay for.
 */
export function rankLandDrops(
  view: PilotView,
  legalActions: readonly GameAction[],
  weights: HeuristicWeights,
): LandDropOption[] {
  const me = view.priorityPlayer;
  const hand = view.players[me].hand as unknown as readonly CardInstance[];

  const actions: GameAction[] = [];
  const cards: (CardInstance | undefined)[] = [];
  const names: string[] = [];
  for (let i = 0; i < legalActions.length; i++) {
    const action = legalActions[i] as GameAction;
    if (action.kind !== 'playLand') continue;
    const card = findInZone(hand, action.instanceId);
    const name = card?.def.name ?? String(action.instanceId);
    if (names.includes(name)) continue;
    actions.push(action);
    cards.push(card);
    names.push(name);
  }

  if (actions.length === 0) return [];
  if (actions.length === 1) {
    return [{ action: actions[0] as GameAction, card: cards[0], name: names[0] as string, merit: 0 }];
  }

  const merits = scoreLandDrops(view, me, cards, legalActions, weights);
  const options: LandDropOption[] = [];
  for (let i = 0; i < actions.length; i++) {
    options.push({
      action: actions[i] as GameAction,
      card: cards[i],
      name: names[i] as string,
      merit: merits[i] as number,
    });
  }
  return options;
}

/**
 * The single land drop the pilot should make, or undefined when it cannot play one.
 *
 * ⚠️ **The fast path matters more than the ranking does, and it is deliberately not
 * "just call `rankLandDrops`".** This runs on the pilot that is both
 * `DEFAULT_PILOT_ID` and the search's rollout policy, and the overwhelmingly common
 * hand offers land drops that are all the SAME land — three Mountains is one
 * decision, not three. Detecting that here costs one pass and **zero allocation**;
 * routing it through `rankLandDrops` would allocate three arrays and an option
 * object per decision to discover the same thing. So the scorer is reached only when
 * there are genuinely two different lands to choose between.
 *
 * Ties resolve to the FIRST offered action, which is what makes zeroed weights
 * reproduce the old pilot exactly.
 */
export function bestLandDrop(
  view: PilotView,
  legalActions: readonly GameAction[],
  weights: HeuristicWeights,
): GameAction | undefined {
  const hand = view.players[view.priorityPlayer].hand as unknown as readonly CardInstance[];
  let first: GameAction | undefined;
  let firstName: string | undefined;
  let distinct = false;
  for (let i = 0; i < legalActions.length; i++) {
    const action = legalActions[i] as GameAction;
    if (action.kind !== 'playLand') continue;
    const name = findInZone(hand, action.instanceId)?.def.name;
    if (first === undefined) {
      first = action;
      firstName = name;
      continue;
    }
    if (name !== firstName) {
      distinct = true;
      break;
    }
  }
  if (first === undefined || !distinct) return first;

  const options = rankLandDrops(view, legalActions, weights);
  let best = options[0];
  if (best === undefined) return first;
  for (let i = 1; i < options.length; i++) {
    const option = options[i] as LandDropOption;
    if (option.merit > best.merit) best = option;
  }
  return best.action;
}

/**
 * "Why this land?", for the decision trace the inspector and the sim log read
 * (DESIGN §1 rule 3 — a system is not done until you can watch it decide).
 *
 * Built ONLY when a caller is actually listening: this re-runs the ranking to
 * recover the numbers, which is exactly the work the hot path is written to avoid,
 * and no decision has ever depended on a reason string.
 */
export function describeLandDrop(
  view: PilotView,
  chosen: GameAction,
  legalActions: readonly GameAction[],
  weights: HeuristicWeights,
): string {
  const options = rankLandDrops(view, legalActions, weights);
  const picked = options.find((option) => option.action === chosen);
  if (picked === undefined) return 'develop mana — play a land';
  if (options.length === 1) return `develop mana — play ${picked.name} (the only land in hand)`;
  const rivals = options
    .filter((option) => option !== picked)
    .map((option) => `${option.name} ${option.merit.toFixed(0)}`)
    .join(', ');
  return `develop mana — play ${picked.name} (unlocks ${picked.merit.toFixed(0)} vs ${rivals})`;
}

/**
 * Weights that switch land sequencing OFF, reproducing the pre-fix pilot exactly.
 *
 * Not a debug toggle and not a supported way to play: it exists so the before/after
 * strength measurement can run BOTH arms in one process on interleaved seeds, which
 * is the only honest way to compare on a box whose wall clock drifts ±19%. A test
 * pins the equivalence behaviourally (identical decisions on the pinned position),
 * so this cannot quietly stop being the old behaviour.
 */
export const LAND_SEQUENCING_OFF_WEIGHTS: Readonly<Partial<HeuristicWeights>> = Object.freeze({
  landUnlocksSpellWeight: 0,
  landFixesNeededColorScore: 0,
  landTaplandFreerollScore: 0,
});

// --- scoring -------------------------------------------------------------------

/**
 * Merit for each candidate land, in offer order.
 *
 * Three terms, in the order they matter:
 *  1. **What it casts NOW** — the value of the best spell in hand that becomes
 *     payable with this land and is not payable without it. This is the term that
 *     fixes the pinned defect, and it is the only one that consults the planner.
 *  2. **What it stops stranding** — a colour our hand is asking for that no
 *     permanent we control can make yet. This is the future-turn half: it is what
 *     stops a two-colour deck holding the one Swamp that makes half its cards live.
 *  3. **Spend the tapland on a turn it is free** — when NOTHING in hand becomes
 *     castable this turn whichever land goes down, a land that arrives tapped costs
 *     nothing today and would cost a mana on some later turn when it might. So the
 *     tapland is the correct drop precisely on the turns nobody notices, and this
 *     term says so.
 *
 *     ⚠️ This is the INVERSE of the rule that shipped in the first draft ("prefer
 *     the untapped land"), and the inversion is the point. Preferring untapped is
 *     wrong twice over: term 1 already covers the only reason to want untapped mana
 *     today (there is something to cast with it), and holding the tapland only
 *     defers its cost onto a turn you cannot choose. The first draft measured
 *     **49.3% of discordant games [44.5, 54.1]** — i.e. nothing — which is what
 *     prompted looking at it again rather than leaving it in on plausibility.
 *
 * ## The prefilter, and why it is not an optimisation you may skip
 *
 * `planManaPayment` is the hottest function in the engine, and the naive shape of
 * term 1 asks it once per spell in hand per candidate land. Measured, that cost
 * **0.80x gauntlet throughput**, which rule 7 does not permit. So every spell first
 * goes through {@link couldPay}, a NECESSARY condition for payability that is pure
 * arithmetic over dense per-colour ceilings: you cannot pay a cost of five with four
 * mana, and you cannot pay two black pips when nothing you control makes more than
 * one black. Anything that fails it is unpayable for certain and never reaches the
 * planner; anything that passes is still decided BY the planner, which remains the
 * only authority on "can I pay for this". The filter can only remove calls whose
 * answer was already known — it can never change one.
 */
function scoreLandDrops(
  view: PilotView,
  me: PlayerId,
  cards: readonly (CardInstance | undefined)[],
  legalActions: readonly GameAction[],
  weights: HeuristicWeights,
): number[] {
  const battlefield = view.battlefield as unknown as readonly CardInstance[];
  const hand = view.players[me].hand as unknown as readonly CardInstance[];

  // The colour picture, gathered once for every candidate: what we can already
  // make, and what the cards we are holding are asking for.
  const boardColors = producibleColorMask(battlefield, me);
  const handColors = handColorMask(hand);

  // What this board could pay with RIGHT NOW, as a total and as a per-colour
  // ceiling. Both are deliberate UPPER bounds (a modal source counts toward every
  // colour it could make), which is what keeps `couldPay` a sound rejection.
  const pool = view.players[me].manaPool;
  const colorCap = new Int32Array(COLOR_COUNT);
  let availableMana = 0;
  for (let i = 0; i < COLOR_COUNT; i++) {
    const held = pool[MANA_COLORS[i] as ManaColor];
    colorCap[i] = held;
    availableMana += held;
  }
  for (let b = 0; b < battlefield.length; b++) {
    const perm = battlefield[b] as CardInstance;
    if (perm.controller !== me || perm.tapped) continue;
    availableMana += bestManaYield(perm.def);
    const yields = perColorYield(perm.def);
    for (let i = 0; i < COLOR_COUNT; i++) colorCap[i] = (colorCap[i] as number) + (yields[i] as number);
  }

  // The spells worth asking about at all, each with its cost densified once and its
  // value precomputed. Bounded by the most mana any candidate land could add, so a
  // six-drop on turn two never reaches the loop below.
  let bestExtraMana = 0;
  for (const card of cards) {
    if (card === undefined) continue;
    const yielded = bestManaYield(card.def);
    if (yielded > bestExtraMana) bestExtraMana = yielded;
  }
  const spells: CardInstance[] = [];
  const values: number[] = [];
  for (const card of hand) {
    if (isLand(card.def)) continue;
    const cost = card.def.cost;
    if (cost === undefined) continue;
    if (convertedManaCost(cost) > availableMana + bestExtraMana) continue;
    spells.push(card);
    values.push(cardValue(card, weights));
  }
  const pips = densePips(spells);
  /** Per spell, "is this already payable without any new land?" — filled lazily. */
  const payableNow: (boolean | undefined)[] = new Array(spells.length);
  const capWithLand = new Int32Array(COLOR_COUNT);

  // Pass 1 — what each land casts today. A land that arrives tapped funds nothing
  // this turn, so it is not even asked.
  const arrivesTapped: boolean[] = [];
  const unlocked: number[] = [];
  let anyUnlock = false;
  for (const card of cards) {
    if (card === undefined) {
      arrivesTapped.push(false);
      unlocked.push(0);
      continue;
    }
    const tapped = entersTapped(card.def, { controller: me, battlefield, self: card });
    arrivesTapped.push(tapped);
    if (tapped) {
      unlocked.push(0);
      continue;
    }
    const landYields = perColorYield(card.def);
    for (let i = 0; i < COLOR_COUNT; i++) capWithLand[i] = (colorCap[i] as number) + (landYields[i] as number);
    const value = bestUnlockedValue(view, me, card, battlefield, legalActions, {
      spells,
      values,
      pips,
      payableNow,
      colorCap,
      capWithLand,
      availableMana,
      availableWithLand: availableMana + bestManaYield(card.def),
    });
    if (value > 0) anyUnlock = true;
    unlocked.push(value);
  }

  // Pass 2 — the merits. The tapland freeroll needs pass 1's verdict for EVERY
  // candidate ("is this a turn where the mana matters at all?"), which is why the
  // two passes are separate rather than one loop.
  const merits: number[] = [];
  for (let i = 0; i < cards.length; i++) {
    const card = cards[i];
    if (card === undefined) {
      merits.push(0);
      continue;
    }
    let merit = weights.landUnlocksSpellWeight * (unlocked[i] as number);
    merit += weights.landFixesNeededColorScore * newNeededColorCount(card.def, boardColors, handColors);
    if (arrivesTapped[i] && !anyUnlock) merit += weights.landTaplandFreerollScore;
    merits.push(merit);
  }
  return merits;
}

/** Everything {@link bestUnlockedValue} needs that is the same for every candidate land. */
interface UnlockQuery {
  readonly spells: readonly CardInstance[];
  /** `cardValue` per spell, so the loop can skip anything that cannot beat the best found. */
  readonly values: readonly number[];
  /** Dense coloured pips + generic per spell — see {@link densePips}. */
  readonly pips: Int32Array;
  readonly payableNow: (boolean | undefined)[];
  readonly colorCap: Int32Array;
  readonly capWithLand: Int32Array;
  readonly availableMana: number;
  readonly availableWithLand: number;
}

/**
 * The value of the best spell this land makes castable that we could not cast
 * without it — 0 when it unlocks nothing.
 *
 * The hypothetical is handed to core's planner rather than reasoned about here: a
 * `ManaPlanView` whose battlefield includes the land, and the `tapForMana` actions
 * the engine would offer for it (one per mode, so a dual land is asked about in
 * every colour it could make). `planManaPayment` reads nothing else, so this is the
 * real answer and not an approximation of it.
 *
 * Three cheap rejections come first, in increasing order of cost, and between them
 * they keep the planner off the hot path: a spell that cannot beat the best unlock
 * found so far cannot change the answer; a spell the land still could not pay for is
 * not unlocked by it; and a spell that was payable anyway was not unlocked by
 * anything. Only what survives all three is planned — and the hypothetical board is
 * not even built until something does.
 */
function bestUnlockedValue(
  view: PilotView,
  me: PlayerId,
  land: CardInstance,
  battlefield: readonly CardInstance[],
  legalActions: readonly GameAction[],
  query: UnlockQuery,
): number {
  const spells = query.spells;
  if (spells.length === 0) return 0;
  const modes = manaModesOf(land.def);
  if (modes.length === 0) return 0; // a land that makes no mana unlocks nothing

  let withLand: { readonly battlefield: readonly CardInstance[]; readonly players: ManaPlanPlayers } | undefined;
  let actionsWithLand: GameAction[] | undefined;

  let best = 0;
  for (let i = 0; i < spells.length; i++) {
    const value = query.values[i] as number;
    if (value <= best) continue;
    if (!couldPay(query.pips, i, query.capWithLand, query.availableWithLand)) continue;
    const cost = (spells[i] as CardInstance).def.cost as ManaCost;

    let already = query.payableNow[i];
    if (already === undefined) {
      already = couldPay(query.pips, i, query.colorCap, query.availableMana)
        ? planManaPayment(view as unknown as GameState, me, cost, legalActions) !== undefined
        : false;
      query.payableNow[i] = already;
    }
    if (already) continue; // castable anyway — this land is not what makes it live

    if (withLand === undefined) {
      withLand = { battlefield: battlefield.concat(land), players: view.players as unknown as ManaPlanPlayers };
      actionsWithLand = legalActions.slice();
      for (let mode = 0; mode < modes.length; mode++) {
        actionsWithLand.push({ kind: 'tapForMana', player: me, instanceId: land.instanceId, mode });
      }
    }
    if (planManaPayment(withLand, me, cost, actionsWithLand as GameAction[]) === undefined) continue;
    best = value;
  }
  return best;
}

/** The shape `planManaPayment` needs from `players`, without a `GameState` cast. */
type ManaPlanPlayers = Readonly<Record<PlayerId, { readonly manaPool: Readonly<Record<ManaColor, number>> }>>;

// --- the cheap payability filter -------------------------------------------------

/**
 * Layout of {@link densePips}: `COLOR_COUNT` coloured amounts then the generic one.
 */
const COST_STRIDE = MANA_COLORS.length + 1;

/**
 * Coloured pips and generic for each spell, dense and contiguous.
 *
 * Same reasoning as core's `densifyInto`: a `ManaCost` is a SPARSE partial record,
 * so every card in a deck presents a different hidden class and `cost[color]` in a
 * filter loop is a megamorphic property load. Read once, compared many times.
 */
function densePips(spells: readonly CardInstance[]): Int32Array {
  const out = new Int32Array(spells.length * COST_STRIDE);
  for (let s = 0; s < spells.length; s++) {
    const cost = (spells[s] as CardInstance).def.cost as ManaCost;
    const at = s * COST_STRIDE;
    for (let i = 0; i < COLOR_COUNT; i++) out[at + i] = cost[MANA_COLORS[i] as ManaColor] ?? 0;
    out[at + COLOR_COUNT] = cost.generic ?? 0;
  }
  return out;
}

/**
 * A NECESSARY condition for "this cost is payable from this board": the total fits,
 * and no single colour is asked for more times than the board could ever make it.
 *
 * Deliberately NOT sufficient — two pips of different colours can compete for one
 * dual land and this says nothing about that. It exists only to prove a cost
 * UNPAYABLE without calling the planner, which is a claim it can make soundly
 * because both ceilings it reads are upper bounds.
 */
function couldPay(pips: Int32Array, index: number, colorCap: Int32Array, availableMana: number): boolean {
  const at = index * COST_STRIDE;
  let total = pips[at + COLOR_COUNT] as number;
  for (let i = 0; i < COLOR_COUNT; i++) {
    const need = pips[at + i] as number;
    if (need > (colorCap[i] as number)) return false;
    total += need;
  }
  return total <= availableMana;
}

/**
 * The most of each colour ONE activation of this source could make, dense and
 * memoized. A modal source counts in every colour it offers — that over-count is
 * exactly what makes the ceiling an upper bound and {@link couldPay} sound.
 */
function perColorYield(def: CardDefinition): Int32Array {
  const memo = COLOR_YIELD_MEMO.get(def);
  if (memo !== undefined) return memo;
  const out = new Int32Array(COLOR_COUNT);
  for (const mode of manaModesOf(def)) {
    for (let i = 0; i < COLOR_COUNT; i++) {
      const amount = mode[MANA_COLORS[i] as ManaColor] ?? 0;
      if (amount > (out[i] as number)) out[i] = amount;
    }
  }
  COLOR_YIELD_MEMO.set(def, out);
  return out;
}
const COLOR_YIELD_MEMO = new WeakMap<CardDefinition, Int32Array>();

/** How many mana colours there are — the width of every dense buffer above. */
const COLOR_COUNT = MANA_COLORS.length;

// --- colour bookkeeping ---------------------------------------------------------

/**
 * Colours are handled as a 5-bit mask rather than as sets, for the usual reason
 * everything in this pilot is: the alternative allocates a `Set` per decision per
 * candidate on a path that runs 20,000 times per search decision.
 */
function colorBit(color: ManaColor): number {
  return 1 << MANA_COLORS.indexOf(color);
}

/** Colours a permanent of this definition can tap for. Memoized — card data is immutable. */
function producedColorMask(def: CardDefinition): number {
  const memo = PRODUCED_MASK_MEMO.get(def);
  if (memo !== undefined) return memo;
  let mask = 0;
  for (const color of manaColorsOffered(def)) mask |= colorBit(color);
  PRODUCED_MASK_MEMO.set(def, mask);
  return mask;
}
const PRODUCED_MASK_MEMO = new WeakMap<CardDefinition, number>();

/** Coloured pips a cost demands (generic asks for no colour). Memoized per cost object. */
function costColorMask(cost: ManaCost): number {
  const memo = COST_MASK_MEMO.get(cost);
  if (memo !== undefined) return memo;
  let mask = 0;
  for (let i = 0; i < MANA_COLORS.length; i++) {
    const color = MANA_COLORS[i] as ManaColor;
    if ((cost[color] ?? 0) > 0) mask |= 1 << i;
  }
  COST_MASK_MEMO.set(cost, mask);
  return mask;
}
const COST_MASK_MEMO = new WeakMap<ManaCost, number>();

/** Every colour this player's permanents could already produce (tapped ones count — this is about future turns). */
function producibleColorMask(battlefield: readonly CardInstance[], me: PlayerId): number {
  let mask = 0;
  for (let i = 0; i < battlefield.length; i++) {
    const perm = battlefield[i] as CardInstance;
    if (perm.controller !== me) continue;
    mask |= producedColorMask(perm.def);
  }
  return mask;
}

/** Every colour the non-land cards in this hand are asking for. */
function handColorMask(hand: readonly CardInstance[]): number {
  let mask = 0;
  for (let i = 0; i < hand.length; i++) {
    const card = hand[i] as CardInstance;
    if (isLand(card.def)) continue;
    const cost = card.def.cost;
    if (cost === undefined) continue;
    mask |= costColorMask(cost);
  }
  return mask;
}

/** How many colours this land adds that the hand wants and the board cannot yet make. */
function newNeededColorCount(def: CardDefinition, boardColors: number, handColors: number): number {
  let mask = producedColorMask(def) & handColors & ~boardColors;
  let count = 0;
  while (mask !== 0) {
    mask &= mask - 1;
    count += 1;
  }
  return count;
}

// --- small helpers --------------------------------------------------------------

/** Indexed lookup — `Array.prototype.find` needs a closure over the id per call. */
function findInZone(zone: readonly CardInstance[], id: InstanceId): CardInstance | undefined {
  for (let i = 0; i < zone.length; i++) {
    const card = zone[i] as CardInstance;
    if (card.instanceId === id) return card;
  }
  return undefined;
}

/**
 * Total mana a player could produce this turn: current pool + untapped sources.
 *
 * A source contributes the value of its BEST single mode, because tapping it
 * activates exactly one — a five-color source is worth one mana, not five. (Reading
 * the mode count as an amount is what convinced the old pilot it could afford
 * spells it could not, so it tapped toward them and stranded the mana.)
 *
 * This is a cheap upper bound used only to skip obviously-unaffordable spells;
 * `planManaPayment` is the authority on whether a cost can actually be paid.
 *
 * It lives HERE rather than in `heuristic.ts` (where it started) only because both
 * modules need it and this one is the leaf: `heuristic.ts` imports this module, so
 * importing back would make a cycle. One definition, two callers — the alternative
 * was two copies of a bound that must agree.
 */
export function totalAvailableMana(view: PilotView, player: PlayerId): number {
  let total = 0;
  const pool = view.players[player].manaPool;
  for (const color of MANA_COLORS) total += pool[color];
  for (const perm of view.battlefield) {
    if (perm.controller !== player || perm.tapped) continue;
    total += bestManaYield(perm.def);
  }
  return total;
}

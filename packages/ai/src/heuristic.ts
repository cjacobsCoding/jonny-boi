/**
 * The `heuristic` pilot — a competent, non-random pilot good enough to play the
 * meta decks sensibly, so the sim's win-rate verdicts aren't drowned in noise.
 *
 * It is deliberately *not* optimal. It plays by a small set of justifiable rules,
 * all weighted by the tunable `HeuristicWeights` (DESIGN §1 — no magic numbers):
 *
 *   Main phase (priority windows):
 *     - Develop mana: always play a land if able (lands outrank most spells), and
 *       play the land that UNLOCKS the most — the one that makes a spell in hand
 *       castable, or stops a colour being stranded (see `land-sequencing.ts`).
 *     - Cast the most impactful affordable spell: removal on the opponent's
 *       biggest threat; burn to the face when it's lethal (or there's no better
 *       target); creatures to develop the board. Mana is tapped only as needed to
 *       fund the chosen spell, so we don't waste it.
 *     - Otherwise pass priority (nothing useful to do).
 *
 *   Combat:
 *     - Attack when profitable: send attackers that deal unblocked face damage or
 *       win their likely trade; hold back creatures that would just suicide.
 *     - Block to preserve life / make favourable trades; block much more readily
 *       when life is low (avoid lethal).
 *
 * The pilot only ever returns a legal action: an offered action, a tap toward a
 * spell it intends to cast, a constructed targeted cast, or a narrowed
 * attack/block subset the engine validates. On any unexpected state it passes.
 *
 * Determinism: the only nondeterminism is tie-breaking, taken from the seeded RNG.
 *
 * Allocation: this pilot is not only the sim's default — it is also the MCTS
 * pilot's ROLLOUT POLICY, so one MCTS decision calls `chooseAction` on the order
 * of `simulationsPerDecision * rolloutDepth` times. Every object this function
 * allocates is therefore multiplied by ~20,000 per look-ahead decision, which is
 * why the hot path scans arrays in place instead of `filter`/`map`ping them,
 * memoizes per-`CardDefinition` facts, and builds no explanation string unless a
 * caller actually asked for one (see `explain` / `NO_REASON`). None of that
 * changes a single decision: the reasons are observational, and the scans return
 * exactly what the array pipelines returned.
 */

import type {
  CardDefinition,
  CardInstance,
  EffectRef,
  GameAction,
  GameState,
  InstanceId,
  ManaCost,
  ManaProduction,
  PendingChoice,
  ManaTapPlan,
  PlayerId,
} from '@jonny-boi/core';
import {
  castTiming,
  convertedManaCost,
  isCreature,
  isLand,
  flashbackCostOf,
  isLegalTarget,
  isBattle,
  isPlaneswalker,
  protectorOf,
  legalTargetsFor,
  defenseOf,
  loyaltyOf,
  MANA_COLORS,
  planManaPayment,
  restrictionOfEffects,
  modalSpecOf,
  modeCountsFor,
  targetRestrictionOf,
} from '@jonny-boi/core';
import type { PermanentModification, TargetRestriction } from '@jonny-boi/core';
import { cardValue, cardValueContext } from './card-value.js';
import type { ContinuousIndex } from './board-stats.js';
import { boardIndex, keywordsOf, power, statTotal, toughness, toughnessLeft } from './board-stats.js';
import { valueOfEffects, valueOfMode } from './effect-value.js';
import { answerChoiceHeuristically, safeFallbackAction } from './choices.js';
import { bestLandDrop, describeLandDrop, rankLandDrops, totalAvailableMana } from './land-sequencing.js';
import type { DecisionContext, DecisionTrace, Pilot, PilotView } from './pilot.js';
import type { HeuristicWeights } from './weights.js';
import { DEFAULT_HEURISTIC_WEIGHTS } from './weights.js';

/** The id the heuristic pilot registers under and is selected by from data. */
export const HEURISTIC_PILOT_ID = 'heuristic';

/**
 * Recognised effect-primitive ids (DESIGN §2 — primitives are referenced by id).
 * The heuristic understands *intent* by primitive id without depending on the
 * `cards` package: it reads a card's `effects` and classifies the spell. Any
 * primitive it doesn't recognise falls through to "generic spell" — robust by
 * default, never a crash. These names mirror the §2 primitive vocabulary.
 */
const PRIMITIVE = Object.freeze({
  dealDamage: 'dealDamage',
  /** Targeted hard removal. NOTE: the registered id is `destroyTarget`, not
   *  `destroy` — an id typo here silently downgrades every removal spell to an
   *  untargeted "generic spell" that fizzles on resolution. */
  destroyTarget: 'destroyTarget',
  exileTarget: 'exileTarget',
  /** Combat trick (+X/+Y until end of turn). Also targeted. NOTE: the same
   *  primitive with NEGATIVE deltas is how the pool writes shrink-removal
   *  (Disfigure's -2/-2), which is a different play entirely — see `shrink`. */
  pumpUntilEndOfTurn: 'pumpUntilEndOfTurn',
  /** Counter target spell. Only ever castable with a spell on the stack. */
  counterSpell: 'counterSpell',
  /**
   * The SOFT counter — "counter target spell unless its controller pays {3}". It
   * is played exactly like a hard counter (hold it up, cast it in response); what
   * differs is what it is WORTH, which `effect-value` prices by asking whether
   * that player can actually pay. Missing from this list, a Mana Leak would be a
   * "generic spell" and the pilot would never hold it up at all.
   */
  counterUnlessPaid: 'counterUnlessPaid',
  /** A symmetric board sweeper (Wrath of God / Day of Judgment). */
  destroyAll: 'destroyAll',
  gainLife: 'gainLife',
  drawCards: 'drawCards',
  /** Library search. Recognised so a fetchland's ability can be identified. */
  searchLibrary: 'searchLibrary',
});

/** What we think a spell *does*, derived from its effect primitives. */
type SpellIntent =
  | {
      readonly kind: 'damage';
      readonly amount: number;
      readonly canTargetCreature: boolean;
      readonly canTargetPlayer: boolean;
      /** "Any target" / "…or planeswalker" — burn that can finish off a walker. */
      readonly canTargetWalker: boolean;
      /**
       * True when the printed amount is the cast-time X (`{ chosenX: true }`
       * param) rather than a number. The DEFINITION cannot know what X will be
       * — that depends on the board's mana — so classification marks it and
       * `scoreSpell` substitutes the X this board could actually fund.
       */
      readonly amountIsX?: boolean;
    }
  | { readonly kind: 'destroyCreature'; readonly exiles: boolean }
  | { readonly kind: 'shrink'; readonly toughness: number }
  | { readonly kind: 'pump'; readonly power: number; readonly toughness: number }
  | { readonly kind: 'counter' }
  | { readonly kind: 'sweeper' }
  | { readonly kind: 'creature' }
  /**
   * An Aura or an Equipment — a card whose value is "what it grants" times "who
   * is around to carry it". Recognised from `def.attachment`, which is CORE data
   * rather than a primitive id, so this classification cannot be broken by a
   * renamed primitive the way a mis-typed `destroy` once blanked every removal
   * spell in the pool.
   */
  | {
      readonly kind: 'attachment';
      /** Total P/T the attachment grants its host (negative for Dead Weight). */
      readonly stats: number;
      /** How many keyword abilities it grants. */
      readonly keywords: number;
      /** False when the modification makes its host WORSE — i.e. it is removal. */
      readonly helpful: boolean;
    }
  /**
   * A MODAL spell ("Choose two — …"). Its value is not any one thing it does:
   * it is the best set of modes this board lets it announce, which changes turn
   * to turn. Recognised from `def.modal`, which is CORE data (like `attachment`)
   * rather than a primitive id, so no rename can silently blank it.
   */
  | { readonly kind: 'modal' }
  | { readonly kind: 'other' };

/** Build the heuristic pilot with the given (tunable) weights. */
export function createHeuristicPilot(weights: HeuristicWeights = DEFAULT_HEURISTIC_WEIGHTS): Pilot {
  return {
    id: HEURISTIC_PILOT_ID,
    description: 'Plays sensibly: develops mana, removes threats, develops the board, attacks/blocks for value.',
    chooseAction(ctx: DecisionContext): GameAction {
      try {
        return decide(ctx, weights);
      } catch {
        // Robustness: never throw on a weird state. Fall back to the one move the
        // engine is guaranteed to accept — which is NOT always passing: while a
        // choice is parked, passing is rejected and only an answer moves the game.
        return safeFallbackAction(ctx.view as unknown as GameState);
      }
    },
  };
}

// --- top-level decision --------------------------------------------------------

/**
 * The empty reason used whenever no caller asked for an explanation. Building the
 * real string costs several allocations per decision (number→string conversions,
 * a rope per template) and the sim runs this ~20,000 times per MCTS decision, so
 * the strings are produced only when a `trace` sink is actually listening. The
 * chosen action is identical either way — a reason has never fed a decision.
 */
const NO_REASON = '';

function decide(ctx: DecisionContext, weights: HeuristicWeights): GameAction {
  const { view, legalActions } = ctx;
  const me = view.priorityPlayer;
  const explain = ctx.trace !== undefined;

  // A resolving spell is asking somebody a question. That preempts everything —
  // it is the only thing the game will accept — and it is answered on its own
  // terms (pick what is best for the chooser), not by scoring board plays.
  // (The cast strips the view's DeepReadonly wrapper; the answerer only reads.)
  const pending = view.pendingChoice as PendingChoice | null | undefined;
  if (pending) {
    const answer = answerChoiceHeuristically(view as unknown as GameState, pending, weights);
    return emit(ctx, answer, explain ? `answering "${pending.prompt}"` : NO_REASON);
  }

  // Nothing offered, or only passing is possible → pass.
  if (legalActions.length === 0) return emit(ctx, passAction(view), 'no legal actions — passing');
  const onlyPass = everyActionIsPass(legalActions);
  if (onlyPass) return emit(ctx, legalActions[0] as GameAction, 'nothing useful — passing');

  // A MADNESS window: a card of ours has been discarded to exile and the game is
  // waiting to hear whether we cast it. It preempts the priority window the same
  // way a pending choice does — those are the only actions the engine will
  // accept — so it is answered here rather than left to the spell scorer, which
  // reads the HAND and would never see the exiled card at all.
  const madness = view.madnessWindow;
  if (madness && madness.controller === me) {
    const play = decideMadness(ctx, weights);
    if (play) return play;
  }
  // ONE continuous index per decision, threaded into everything below. Built here
  // rather than per permanent because it is O(battlefield) and every stat read in
  // this decision wants the same answer — see `board-stats.ts` for what reading
  // without it cost (a Tarmogoyf evaluated as 0/0 and every anthem invisible).
  //
  // Built AFTER the three early returns above on purpose: answering a parked
  // question and "the only legal move is passing" are between them a large share
  // of all decisions in a real game, and none of them reads a creature's stats, so
  // an index built at the top of the function would be pure cost on every one.
  const index = boardIndex(view);

  // Combat declarations are their own decision shape.
  if (view.step === 'declareAttackers' && me === view.activePlayer) {
    const attack = chooseAttack(ctx, weights, index);
    if (attack) return attack;
  }
  if (view.step === 'declareBlockers' && me === defendingPlayer(view)) {
    const block = chooseBlock(ctx, weights, index);
    if (block) return block;
  }

  // Otherwise: a priority window. Plan the best spell goal and act toward it,
  // or play a land, or pass.
  return choosePriorityAction(ctx, weights, index);
}

/**
 * What to do about an open madness window: cast the exiled card, tap toward
 * being able to, or decline.
 *
 * The judgement is one-sided and that is not laziness — it is the shape of the
 * mechanic. The card has ALREADY been discarded: declining does not keep it, it
 * puts it in the graveyard. So the only thing being weighed is the madness cost
 * against a card that is otherwise simply lost, and casting is right whenever
 * the mana can be produced at all. The engine offers the cast only when the pool
 * already covers the cost, so the tap-toward step is what makes this reachable
 * from a board of untapped lands.
 */
function decideMadness(ctx: DecisionContext, weights: HeuristicWeights): GameAction | undefined {
  const { view, legalActions } = ctx;
  const me = view.priorityPlayer;
  const cast = legalActions.find(
    (a): a is Extract<GameAction, { kind: 'castSpell' }> => a.kind === 'castSpell' && a.fromZone === 'exile',
  );
  if (cast) {
    const name = findInstance(view, cast.instanceId)?.def.name ?? 'the discarded card';
    return emit(ctx, cast, ctx.trace ? `cast ${name} for its madness cost` : NO_REASON, weights.genericSpellScore);
  }
  const window = view.madnessWindow;
  const exiled = window ? view.players[me].exile.find((c) => c.instanceId === window.instanceId) : undefined;
  const cost = exiled?.def.madness;
  if (cost) {
    const plan = planManaPayment(
      view as GameState,
      me,
      cost,
      legalActions,
      exiled!.def,
      'cast',
    );
    const next = plan?.[0];
    if (next) {
      const tap: GameAction = { kind: 'tapForMana', player: me, instanceId: next.instanceId, mode: next.mode };
      return emit(ctx, tap, ctx.trace ? `tapping toward ${exiled!.def.name}'s madness cost` : NO_REASON);
    }
  }
  // Cannot pay: passing is the decline, and it is the only way to unblock the
  // game — leaving the window open would stall it forever.
  return emit(ctx, passAction(view), ctx.trace ? 'cannot pay the madness cost — declining' : NO_REASON);
}

// --- priority-window play (lands, mana, spells) --------------------------------

/**
 * A scored candidate "goal" the pilot could pursue this window: cast a specific
 * spell (with chosen targets) or play a land. The pilot picks the best goal, then
 * emits the next micro-action toward it (tap mana, then cast).
 */
interface SpellGoal {
  readonly score: number;
  readonly card: CardInstance;
  readonly cost: ManaCost;
  readonly targets: readonly (InstanceId | PlayerId)[];
  readonly reason: string;
  /**
   * Set when this goal casts the card out of the GRAVEYARD (flashback) — the
   * cast action must then carry `fromZone: 'graveyard'` and `cost` is the
   * card's flashback cost, not its printed one.
   */
  readonly fromZone?: 'graveyard';
}

function choosePriorityAction(
  ctx: DecisionContext,
  weights: HeuristicWeights,
  index: ContinuousIndex,
): GameAction {
  const { view, legalActions } = ctx;

  // An activated ability that fixes mana (a fetchland) is checked before
  // anything else: it costs no card from hand, and leaving it unused is the same
  // mistake as leaving a land in hand — the deck simply never does what it was
  // built to do.
  const ability = bestAbility(ctx, weights, index);
  if (ability) return ability;

  const canPlayLand = anyActionOfKind(legalActions, 'playLand');
  // Cycling competes with the plays below on the same scale — see `bestCycle`.
  const cycle = bestCycle(ctx, weights);
  const bestSpell = bestSpellGoal(ctx, weights, index);
  // Equipping is a real play competing with the others, not a reflex — see
  // `bestEquipPlay`. It is offered only at sorcery speed by the engine, so it can
  // only turn up in a window where a land or a spell is also possible.
  const equip = bestEquipPlay(ctx, weights, index);

  // Lands outrank most spells: developing mana is almost always correct. We play
  // a land unless a spell scores higher than the land (e.g. lethal burn now).
  //
  // WHICH land is its own question (`land-sequencing.ts`) and it is not the same
  // question as WHETHER to play one: the land drop is worth `playLandScore` however
  // we resolve it, so the comparison below is unchanged and only the action chosen
  // inside the branch differs. Taking the first offered land here is what left the
  // pilot's own removal spell uncastable for a turn.
  const landScore = canPlayLand ? weights.playLandScore : -Infinity;
  const spellScore = bestSpell ? bestSpell.goal.score : -Infinity;
  const equipScore = equip ? equip.score : -Infinity;
  const cycleScore = cycle ? cycle.score : -Infinity;

  if (landScore >= spellScore && landScore >= equipScore && landScore >= cycleScore && canPlayLand) {
    const landAction = bestLandDrop(view, legalActions, weights);
    if (landAction) {
      const why = ctx.trace ? describeLandDrop(view, landAction, legalActions, weights) : NO_REASON;
      return emit(ctx, landAction, why, weights.playLandScore);
    }
  }

  if (equip && equipScore >= spellScore && equipScore > weights.passScore) {
    return emit(ctx, equip.action, ctx.trace ? equip.label : NO_REASON, equipScore);
  }

  if (bestSpell && bestSpell.goal.score > weights.passScore && spellScore >= cycleScore) {
    return pursueSpell(ctx, bestSpell);
  }

  if (cycle && cycleScore > weights.passScore) {
    return pursueCycle(ctx, cycle);
  }

  // Nothing worth doing with our mana → pass.
  return emit(ctx, passAction(view), 'no profitable play — passing', weights.passScore);
}

/**
 * Pick an activated ability worth using right now, or `undefined`.
 *
 * The engine only offers abilities whose cost is fully payable and whose targets
 * are legal, so anything in `legalActions` is playable — the judgement here is
 * whether it is WORTH playing.
 *
 * Deliberately narrow: it activates land-fetching abilities, and nothing else.
 * A fetchland is unambiguous — it converts a land you already control into the
 * land you actually need, it costs no card, and declining it is never right on
 * an untapped board. Every other activated ability (a sacrifice outlet, a
 * damage pinger) needs real cost/benefit reasoning against the board, and
 * guessing at that would make pilots play worse, not better. Those are left
 * unused until they can be scored honestly, which is visible and safe rather
 * than confidently wrong.
 */
function bestAbility(
  ctx: DecisionContext,
  weights: HeuristicWeights,
  index: ContinuousIndex,
): GameAction | undefined {
  const { view, legalActions } = ctx;
  for (const action of legalActions) {
    if (action.kind !== 'activateAbility') continue;
    const source = findInstance(view, action.instanceId);
    const ability = source?.def.activated?.[action.abilityIndex];
    if (!ability) continue;
    if (!fetchesALand(ability)) continue;
    return emit(ctx, action, ctx.trace ? `activate ${ability.label}` : NO_REASON, weights.playLandScore);
  }
  return bestLoyaltyActivation(ctx, weights, index);
}

/**
 * The best LOYALTY activation offered right now, or `undefined`.
 *
 * A planeswalker on the table generates value exactly once per turn, so leaving
 * its abilities unused is the same class of mistake as a land left in hand — the
 * inert-card failure this pilot exists to avoid. Every offered loyalty action
 * (the engine already enumerated one per legal target) is scored as
 *
 *     base + loyaltyPerCounter × (signed cost) + value of its effects
 *
 * with the effects priced by the same `valueOfEffects` ruler that picks a modal
 * spell's modes and aims a trigger — so a plus that discards from both hands, an
 * edict, and the pile-split ultimate all price themselves with no walker-specific
 * card knowledge. The best positive-scoring activation wins; minus abilities pay
 * for their counters through their effect value or don't happen.
 */
function bestLoyaltyActivation(
  ctx: DecisionContext,
  weights: HeuristicWeights,
  index: ContinuousIndex,
): GameAction | undefined {
  const { view, legalActions } = ctx;
  const me = view.priorityPlayer;
  let best: { action: GameAction; score: number; label: string } | undefined;
  let cards: ReturnType<typeof cardValueContext> | undefined;
  for (const action of legalActions) {
    if (action.kind !== 'activateAbility') continue;
    const source = findInstance(view, action.instanceId);
    const ability = source?.def.activated?.[action.abilityIndex];
    const loyalty = ability?.cost.loyalty;
    if (!ability || loyalty === undefined) continue;
    cards ??= cardValueContext(view as GameState, index);
    const effectValue = valueOfEffects(ability.effects, {
      state: view as GameState,
      player: me,
      targets: action.targets ?? [],
      weights,
      cards,
      index,
    });
    const score = weights.loyaltyAbilityBaseScore + weights.loyaltyPerCounter * loyalty + effectValue;
    if (score <= weights.passScore) continue;
    if (!best || score > best.score) {
      best = { action, score, label: ctx.trace ? `activate ${ability.label}` : NO_REASON };
    }
  }
  return best ? emit(ctx, best.action, best.label, best.score) : undefined;
}

/**
 * Does this ability put a land onto the battlefield from the library? That is
 * the fetchland shape, and the one activated ability this pilot understands.
 */
function fetchesALand(ability: { readonly effects: readonly EffectRef[] }): boolean {
  const memo = FETCH_MEMO.get(ability);
  if (memo !== undefined) return memo;
  let found = false;
  for (let i = 0; i < ability.effects.length; i++) {
    const ref = ability.effects[i] as EffectRef;
    if (ref.primitive === PRIMITIVE.searchLibrary && ref.params?.destination === 'battlefield') {
      found = true;
      break;
    }
  }
  FETCH_MEMO.set(ability, found);
  return found;
}

/**
 * Memo for {@link fetchesALand}. An activated ability is immutable card data
 * shared by every instance of its definition, so the answer can never change —
 * and the question is asked once per offered ability on every rollout ply.
 * (Mirrors core's `RESTRICTION_MEMO` for exactly the same reason.)
 */
const FETCH_MEMO = new WeakMap<{ readonly effects: readonly EffectRef[] }, boolean>();

/**
 * The best "attach me to that creature" play right now — the Equip half of the
 * attachment system — together with the taps that fund it.
 *
 * Enumerated from the BATTLEFIELD rather than from `legalActions`, and that is the
 * whole trick: the engine only offers an activated ability whose mana cost the
 * FLOATING pool already covers, and the pilot never floats mana speculatively. A
 * version of this that read the offered actions therefore looked completely
 * correct and equipped exactly never. So the ability is found, scored, and funded
 * through the same `planManaPayment` a spell goes through, and the caller emits
 * either the next tap or the activation itself.
 *
 * An equip ability is recognised WITHOUT naming a primitive id: the permanent
 * declares `def.attachment` (core data) and the ability aims at
 * `'creatureYouControl'` (core's target vocabulary). A renamed primitive therefore
 * cannot silently turn this back into a no-op, which is exactly how this codebase
 * lost every removal spell once before.
 */
function bestEquipPlay(
  ctx: DecisionContext,
  weights: HeuristicWeights,
  index: ContinuousIndex,
): { readonly action: GameAction; readonly score: number; readonly label: string } | undefined {
  const { view, legalActions } = ctx;
  const me = view.priorityPlayer;
  // Every printed Equip is "activate only as a sorcery"; checking it here avoids
  // planning a play the engine would refuse.
  const sorcerySpeedOpen =
    me === view.activePlayer &&
    (view.step === 'precombatMain' || view.step === 'postcombatMain') &&
    view.stack.length === 0;
  if (!sorcerySpeedOpen) return undefined;

  let hosts: readonly (InstanceId | PlayerId)[] | undefined;
  let best: { action: GameAction; score: number; label: string } | undefined;

  // Indexed, and cheapest test first: this walks the whole battlefield on every
  // priority decision in a main phase, so the ordinary permanent must fall out
  // after ONE property read. `activated` is absent on almost everything (lands,
  // vanilla creatures); only then is the attachment data worth looking at.
  const battlefield = view.battlefield;
  for (let b = 0; b < battlefield.length; b++) {
    const perm = battlefield[b] as CardInstance;
    const abilities = perm.def.activated;
    if (abilities === undefined || perm.controller !== me) continue;
    const modifies = perm.def.attachment?.modifies;
    if (!modifies) continue;
    for (let a = 0; a < abilities.length; a++) {
      const ability = abilities[a]!;
      if (restrictionOfEffects(ability.effects) !== EQUIP_RESTRICTION) continue;
      const mana = ability.cost.mana;
      // A cost with a non-mana component is not the plain Equip this understands;
      // leaving it alone is safer than guessing at what paying it costs us.
      if (!mana || ability.cost.tap || ability.cost.sacrificeSelf || ability.cost.life) continue;

      hosts ??= legalTargetsFor(view as GameState, EQUIP_RESTRICTION, me, perm.def);
      const host = bestEquipHost(view, hosts, perm.attachedTo ?? null, index);
      if (!host) continue;

      const score = scoreEquip(modifies, host, weights, index);
      if (score === undefined || (best !== undefined && score <= best.score)) continue;
      const plan = planManaPayment(
        view as GameState,
        me,
        mana,
        legalActions,
        perm.def,
        'activate',
      );
      if (!plan) continue; // cannot fund it this turn
      const action: GameAction =
        plan.length > 0
          ? { kind: 'tapForMana', player: me, instanceId: plan[0]!.instanceId, mode: plan[0]!.mode }
          : {
              kind: 'activateAbility',
              player: me,
              instanceId: perm.instanceId,
              abilityIndex: a,
              targets: [host.instanceId],
            };
      best = {
        action,
        score,
        label: ctx.trace ? `${ability.label} onto ${host.def.name}` : NO_REASON,
      };
    }
  }
  return best;
}

/** The target restriction every printed `Equip {N}` aims with (CR 301.5c). */
const EQUIP_RESTRICTION: TargetRestriction = 'creatureYouControl';

/**
 * The creature that should carry an attachment: the biggest one it is not already
 * on. Excluding the CURRENT host is the guard that matters — re-equipping the
 * creature it is already attached to is legal, changes nothing, and costs mana
 * every single turn, which is how equipment turns into a mana sink in a sim.
 */
function bestEquipHost(
  view: PilotView,
  offered: readonly (InstanceId | PlayerId)[],
  currentHost: InstanceId | null,
  index: ContinuousIndex,
): CardInstance | undefined {
  let best: CardInstance | undefined;
  for (const id of offered) {
    if (typeof id !== 'number' || id === currentHost) continue;
    const candidate = findInstance(view, id);
    if (!candidate || !isCreature(candidate.def)) continue;
    if (!best || power(candidate, index) > power(best, index)) best = candidate;
  }
  return best;
}

/**
 * What moving an attachment granting `modifies` onto `host` is worth, or
 * `undefined` when there is nothing to gain.
 *
 * Bigger bodies carry equipment better (a +2/+0 on a 4/4 attacker beats the same
 * sword on a 0/1), so the host's own power counts toward the score — which is also
 * what makes the pilot move a sword onto a better creature when one arrives.
 */
function scoreEquip(
  modifies: PermanentModification,
  host: CardInstance,
  weights: HeuristicWeights,
  index: ContinuousIndex,
): number | undefined {
  const stats = (modifies.power ?? 0) + (modifies.toughness ?? 0);
  const keywords = modifies.keywords ? Object.values(modifies.keywords).filter(Boolean).length : 0;
  if (stats <= 0 && keywords === 0) return undefined;
  return (
    weights.attachBaseScore +
    weights.attachPerStat * stats +
    weights.attachPerKeyword * keywords +
    weights.castCreaturePerStat * power(host, index)
  );
}

/**
 * A goal together with the taps that actually fund it. Pairing the two is the
 * point: a goal we cannot pay for is not a goal, and an empty plan means the
 * floating pool already covers the cost, so the next action is the cast itself.
 */
interface FundedGoal {
  readonly goal: SpellGoal;
  readonly plan: readonly ManaTapPlan[];
}

/**
 * Find the highest-scoring spell the pilot can *actually fund right now*, with
 * targets chosen. Candidates are scored first, then walked best-first until one
 * has a real funding plan — so the pilot never commits to a spell it cannot pay
 * for and then strands mana tapping toward it.
 *
 * Returns undefined if nothing is worth casting or nothing is payable.
 */
function bestSpellGoal(
  ctx: DecisionContext,
  weights: HeuristicWeights,
  index: ContinuousIndex,
): FundedGoal | undefined {
  const scored = scoredSpellGoals(ctx.view, weights, ctx.trace !== undefined, index);
  // Best-first, but only a goal we can genuinely fund. Planning is the expensive
  // step, so it runs on ranked candidates and stops at the first payable one.
  const me = ctx.view.priorityPlayer;
  for (const goal of scored) {
    const plan = planManaPayment(
      ctx.view as GameState,
      me,
      goal.cost,
      ctx.legalActions,
      goal.card.def,
      'cast',
    );
    if (plan) return { goal, plan };
  }
  return undefined;
}

/**
 * Every spell in hand that is legal to cast right now, scored and targeted, best
 * first. Funding is deliberately NOT considered here — that is the caller's job,
 * because the two consumers want different things from it: {@link bestSpellGoal}
 * plans only until it finds one payable goal (cheapest possible), while the search
 * policy ({@link policyCandidates}) plans every goal so it can search them all.
 */
function scoredSpellGoals(
  view: PilotView,
  weights: HeuristicWeights,
  explain: boolean,
  index: ContinuousIndex,
): SpellGoal[] {
  const me = view.priorityPlayer;
  const opp = otherPlayer(me);
  const hand = view.players[me].hand;
  const availableMana = totalAvailableMana(view, me);

  // Only spells we may legally cast *right now* are worth pursuing — otherwise we
  // would construct a `castSpell` the engine rejects and spin forever. Sorcery-
  // speed spells need our main phase, empty stack, and our priority; instants are
  // always castable when we hold priority. (Mirrors core's timing gate.)
  const sorcerySpeedOpen =
    me === view.activePlayer && (view.step === 'precombatMain' || view.step === 'postcombatMain') && view.stack.length === 0;

  // The opponent's creatures are the same list for every card in hand, so they
  // are gathered ONCE here rather than rebuilt inside `scoreSpell` per candidate
  // — that filter was allocating an array per card in hand per rollout ply.
  // `undefined` means "not needed yet"; only a spell that targets asks for it.
  let oppCreatures: readonly CardInstance[] | undefined;

  const scored: SpellGoal[] = [];
  for (const card of hand) {
    const def = card.def;
    if (isLand(def)) continue;
    const timingOk = castTiming(def) === 'instant' ? true : sorcerySpeedOpen;
    if (!timingOk) continue;
    const cost = def.cost ?? {};
    // Cheap upper-bound prefilter; `planManaTaps` below is the real test.
    if (convertedManaCost(cost) > availableMana) continue;

    let intent = classifySpell(def);
    // An X spell's damage is whatever this board can fund: project X as the
    // mana left after the base cost, so Blaze is scored as the burn it would
    // actually be cast for. The engine will offer exactly this ceiling at cast
    // time and the choice answerer takes the maximum, so score and play agree.
    if (intent.kind === 'damage' && intent.amountIsX) {
      const perX = Math.max(def.xCost ?? 1, 1);
      const projected = Math.floor((availableMana - convertedManaCost(cost)) / perX);
      if (projected <= 0) continue; // an X of zero is a cast with no payload — hold it
      intent = { ...intent, amount: projected };
    }
    oppCreatures ??= creaturesControlledBy(view, opp);
    const goal = scoreSpell(view, opp, oppCreatures, card, intent, weights, explain, index);
    // A spell that prints a target restriction is only a goal if we can point it
    // somewhere legal. This runs on EVERY goal, not just the ones the scorer
    // understands, so a restricted card the scorer classifies as 'other' (and
    // would therefore cast with no target at all) still gets a legal target
    // instead of being rejected by the engine and retried forever.
    const legal = goal ? withLegalTargets(view, opp, goal, index) : undefined;
    if (legal) scored.push(legal);
  }

  // Flashback casts out of OUR graveyard — the same scoring, targeting and
  // timing rules as a hand cast, with the FLASHBACK cost in place of the
  // printed one and the goal marked so the cast action carries its source
  // zone. Without this loop a flashback card is inert to the pilot: legal,
  // never considered, and silently corrupting every A/B verdict that swaps one
  // in. (A card in the graveyard costs no card from hand, so the same score
  // reads as at least as attractive — free spells win ties naturally.)
  for (const card of view.players[me].graveyard) {
    const def = card.def;
    // Printed OR granted (Snapcaster). Read through core's one accessor, the
    // same one `generateLegalActions` and `applyCastSpell` use — a pilot that
    // read only the printed field would never take the recast its own ETB just
    // bought, and the ability would be inert in exactly the games it was cast in.
    const flashbackCost = flashbackCostOf(view as GameState, card);
    if (flashbackCost === undefined || isLand(def)) continue;
    const timingOk = castTiming(def) === 'instant' ? true : sorcerySpeedOpen;
    if (!timingOk) continue;
    if (convertedManaCost(flashbackCost) > availableMana) continue;

    const intent = classifySpell(def);
    oppCreatures ??= creaturesControlledBy(view, opp);
    const goal = scoreSpell(view, opp, oppCreatures, card, intent, weights, explain, index);
    const legal = goal ? withLegalTargets(view, opp, goal, index) : undefined;
    if (legal) {
      scored.push({
        ...legal,
        cost: flashbackCost,
        fromZone: 'graveyard',
        reason: explain ? `flashback — ${legal.reason}` : NO_REASON,
      });
    }
  }

  scored.sort((a, b) => b.score - a.score);
  return scored;
}

/**
 * Enforce the spell's printed TARGET RESTRICTION on a scored goal (core's
 * `targetRestrictionOf`): keep the scorer's own choice when it is legal, otherwise
 * substitute the least-bad legal target, and give up on the goal entirely when the
 * board offers none.
 *
 * Why the pilot needs this at all when the engine already rejects illegal targets:
 * the heuristic builds its cast action itself rather than picking one the engine
 * offered, so without this it would happily aim a creature-only spell at a face
 * (or a player-only spell at a creature), have the cast rejected, and re-choose
 * the same action on the next pass — a live-lock. It is also simply better play:
 * a burn spell that cannot hit players should never be scored as reach.
 */
function withLegalTargets(
  view: PilotView,
  opp: PlayerId,
  goal: SpellGoal,
  index: ContinuousIndex,
): SpellGoal | undefined {
  // A MODAL spell is aimed per mode at cast time, never as a whole card, and
  // the engine rejects a modal cast that carries a target — so the goal keeps
  // the empty target list `scoreSpell` gave it.
  if (modalSpecOf(goal.card.def)) return goal.targets.length === 0 ? goal : { ...goal, targets: [] };
  const restriction = targetRestrictionOf(goal.card.def);
  if (restriction === undefined) return goal; // unrestricted — the scorer's choice stands
  const state = view as GameState;
  // The spell's own definition rides along as the SOURCE so protection is
  // judged exactly as the engine will judge it — without it a red pilot would
  // aim burn at protection-from-red, have the cast rejected, and live-lock.
  for (const target of goal.targets) {
    if (!isLegalTarget(state, restriction, target, goal.card.controller, goal.card.def)) continue;
    return goal.targets.length === 1 ? goal : { ...goal, targets: [target] };
  }
  const fallback = defaultLegalTarget(view, opp, restriction, index, goal.card.def);
  return fallback === undefined ? undefined : { ...goal, targets: [fallback] };
}

/**
 * The target to use for a restricted spell the scorer didn't target itself: the
 * opponent's face when the spell may hit a player, otherwise their biggest
 * creature. A creature-only spell with no enemy creature is NOT redirected onto
 * one of our own — it is simply not cast.
 */
function defaultLegalTarget(
  view: PilotView,
  opp: PlayerId,
  restriction: TargetRestriction,
  index: ContinuousIndex,
  source?: CardDefinition,
): InstanceId | PlayerId | undefined {
  if (restriction === 'player' || restriction === 'playerOrPlaneswalker') return opp;
  // Only creatures the spell may actually be aimed at are candidates —
  // a fallback the engine would reject (hexproof, shroud, protection) is a
  // guaranteed rejected cast and a re-chosen goal, i.e. a live-lock. A
  // creature-or-planeswalker restriction falls back to 'creature' for this
  // legality probe — a creature candidate is legal for it exactly when it is
  // legal as a creature target.
  const state = view as GameState;
  const probe = restriction === 'any' || restriction === 'creatureOrPlaneswalker' ? 'creature' : restriction;
  const legal = creaturesControlledBy(view, opp).filter((creature) =>
    isLegalTarget(state, probe, creature.instanceId, undefined, source),
  );
  const biggest = biggestThreat(legal, index);
  if (biggest) return biggest.instanceId;
  if (restriction === 'creatureOrPlaneswalker') {
    return walkersControlledBy(view, opp)[0]?.instanceId;
  }
  return restriction === 'any' ? opp : undefined;
}

/**
 * Score a single spell and choose its targets. Returns the goal with its score, or
 * undefined if the spell isn't worth casting right now (e.g. removal with no valid
 * target). All weights are named config — no magic numbers.
 */
function scoreSpell(
  view: PilotView,
  opp: PlayerId,
  oppCreatures: readonly CardInstance[],
  card: CardInstance,
  intent: SpellIntent,
  weights: HeuristicWeights,
  explain: boolean,
  index: ContinuousIndex,
): SpellGoal | undefined {
  const cost = card.def.cost ?? {};

  switch (intent.kind) {
    case 'damage': {
      const life = view.players[opp].life;
      // Lethal to the face? Take the win.
      if (intent.canTargetPlayer && intent.amount >= life) {
        return {
          score: weights.lethalBurnScore,
          card,
          cost,
          targets: [opp],
          reason: explain ? `burn to face — lethal (${intent.amount} ≥ ${life})` : NO_REASON,
        };
      }
      // Otherwise WEIGH the two uses against each other rather than always
      // preferring the creature kill. A burn deck that spends every card killing
      // whatever happens to be blocking never actually closes: the previous rule
      // only allowed a face burn when no creature was killable at all.
      // (Scanned in place: the old `filter(...)` built a throwaway array per
      // candidate spell, and `biggestThreat` only ever wanted the maximum.)
      const target = intent.canTargetCreature
        ? biggestThreatWithin(oppCreatures, intent.amount, index)
        : undefined;
      const killScore = target
        ? weights.removalBaseScore + weights.removalPerPowerOfTarget * power(target, index)
        : -Infinity;
      const faceScore = intent.canTargetPlayer ? faceBurnScore(life, intent.amount, weights) : -Infinity;
      // A walker the burn can FINISH is removal too — priced per loyalty plus the
      // kill bonus, so Bolt answers a ticking walker but never chips one it
      // cannot kill (chip damage buys tempo the burn deck does not want to buy).
      const walker = intent.canTargetWalker ? biggestKillableWalker(view, opp, intent.amount) : undefined;
      const walkerScore = walker
        ? weights.removalBaseScore + weights.walkerThreatPerLoyalty * loyaltyOf(walker) + weights.walkerKillBonus
        : -Infinity;

      if (walkerScore > faceScore && walkerScore >= killScore && walker) {
        return {
          score: walkerScore,
          card,
          cost,
          targets: [walker.instanceId],
          reason: explain ? `burn removal — finish ${walker.def.name} (${loyaltyOf(walker)} loyalty)` : NO_REASON,
        };
      }
      if (faceScore >= killScore && faceScore > -Infinity) {
        return {
          score: faceScore,
          card,
          cost,
          targets: [opp],
          reason: explain ? `burn to face — ${life} life left` : NO_REASON,
        };
      }
      if (target) {
        return {
          score: killScore,
          card,
          cost,
          targets: [target.instanceId],
          reason: explain
          ? `burn removal — kill ${target.def.name} (${power(target, index)}/${toughness(target, index)})`
          : NO_REASON,
        };
      }
      return undefined;
    }
    case 'destroyCreature': {
      // An effect that says DESTROY does nothing at all to an indestructible
      // creature (CR 702.12b), so pointing removal at one is a wasted card. The
      // pilot looks past it for the biggest thing it CAN kill, and holds the
      // spell if the board is nothing but indestructible creatures. Exile-based
      // removal has no such exemption and keeps the whole list.
      const reachable = intent.exiles
        ? oppCreatures
        : oppCreatures.filter((c) => !isIndestructible(c, index));
      const target = biggestThreat(reachable, index);
      if (!target) return undefined; // no target → don't waste removal
      return {
        score: weights.removalBaseScore + weights.removalPerPowerOfTarget * power(target, index),
        card,
        cost,
        targets: [target.instanceId],
        reason: explain
          ? `removal — destroy ${target.def.name} (${power(target, index)}/${toughness(target, index)})`
          : NO_REASON,
      };
    }
    case 'shrink': {
      // Shrink-removal kills exactly what its toughness reduction can finish off,
      // so it is scored and targeted like burn: the biggest thing it can kill.
      const target = biggestThreatWithin(oppCreatures, intent.toughness, index);
      if (!target) return undefined; // it would shrink something that survives — hold it
      return {
        score: weights.removalBaseScore + weights.removalPerPowerOfTarget * power(target, index),
        card,
        cost,
        targets: [target.instanceId],
        reason: explain ? `removal — shrink ${target.def.name} (-${intent.toughness} toughness)` : NO_REASON,
      };
    }
    case 'counter': {
      const target = counterTarget(view, otherPlayer(opp));
      if (!target) return undefined; // nothing on the stack worth answering — hold it
      return {
        // Built here rather than per decision because a counterspell with something
        // worth countering on the stack is rare, and this is the only branch that
        // needs the card-value ruler. The decision's index is reused, so it costs
        // the land count and nothing else.
        score:
          weights.removalBaseScore +
          cardValue(target.card, weights, cardValueContext(view as GameState, index)),
        card,
        cost,
        targets: [target.instanceId],
        reason: explain ? `counter ${target.card.def.name}` : NO_REASON,
      };
    }
    case 'sweeper': {
      const net = sweeperValue(view, otherPlayer(opp), weights, index);
      if (net <= 0) return undefined; // our own board would pay for it — hold it
      return { score: net, card, cost, targets: [], reason: explain ? `sweep the board (net ${net})` : NO_REASON };
    }
    case 'creature': {
      const stat = (card.def.power ?? 0) + (card.def.toughness ?? 0);
      return {
        score: weights.castCreatureBaseScore + weights.castCreaturePerStat * stat,
        card,
        cost,
        targets: [],
        reason: explain ? `develop board — cast ${card.def.name}` : NO_REASON,
      };
    }
    case 'pump': {
      const play = bestPumpPlay(view, otherPlayer(opp), opp, intent, weights, explain, index);
      if (!play) return undefined; // no combat use right now — hold the trick
      return { score: play.score, card, cost, targets: [play.target], reason: play.reason };
    }
    case 'attachment': {
      // Who should carry it: our best creature for a buff, their best for a
      // shrink. An attachment with nobody to attach to is NOT cast — it would
      // enter attached to nothing and (for an Aura) die on the spot.
      const me = otherPlayer(opp);
      const hosts = intent.helpful ? creaturesControlledBy(view, me) : oppCreatures;
      const host = biggestThreat(hosts, index);
      if (!host) return undefined;
      return {
        score: attachmentScore(intent, weights),
        card,
        cost,
        targets: [host.instanceId],
        reason: explain
          ? `${intent.helpful ? 'suit up' : 'shrink'} ${host.def.name} with ${card.def.name}`
          : NO_REASON,
      };
    }
    case 'modal': {
      // Priced as the sum of the best modes it could announce RIGHT NOW, each
      // aimed as well as it could be — the same `valueOfMode` ruler the pilot
      // will use a moment later when it actually answers the mode question, so
      // "worth casting" and "which modes" cannot disagree.
      //
      // TARGETS ARE DELIBERATELY EMPTY: a modal spell names no whole-card
      // target (its aims are per mode, asked at cast), and the engine rejects a
      // modal cast that carries one.
      const me = otherPlayer(opp);
      const counts = modeCountsFor(view as GameState, card.def, me);
      if (!counts || counts.max <= 0) return undefined; // nothing announceable
      const cards = cardValueContext(view as GameState);
      const context = {
        state: view as GameState,
        player: me,
        targets: [] as readonly (InstanceId | PlayerId)[],
        weights,
        cards,
        index: cards.index,
      };
      const values = counts.choosable
        .map((mode) =>
          valueOfMode(
            { id: mode.id, effects: mode.effects, ...(mode.targets !== undefined ? { targets: mode.targets } : {}) },
            context,
          ),
        )
        .sort((a, b) => b - a);
      const take = Math.max(counts.min, Math.min(counts.max, values.filter((v) => v > 0).length));
      const score = values.slice(0, take).reduce((sum, v) => sum + v, 0);
      return {
        score,
        card,
        cost,
        targets: [],
        reason: explain ? `cast ${card.def.name} (${take} mode(s))` : NO_REASON,
      };
    }
    case 'other':
      return {
        score: weights.genericSpellScore,
        card,
        cost,
        targets: [],
        reason: explain ? `cast ${card.def.name}` : NO_REASON,
      };
  }
}

/**
 * What an attachment is worth, from the size of the modification it grants.
 *
 * `Math.abs` on the stats deliberately: a -2/-2 Aura is worth its magnitude as
 * removal exactly as a +2/+2 one is worth its magnitude as a buff. One formula,
 * both directions, no second weight to keep in sync.
 */
function attachmentScore(
  intent: Extract<SpellIntent, { kind: 'attachment' }>,
  weights: HeuristicWeights,
): number {
  return (
    weights.attachBaseScore +
    weights.attachPerStat * Math.abs(intent.stats) +
    weights.attachPerKeyword * intent.keywords
  );
}

/**
 * What pointing `amount` damage at a player on `life` is worth.
 *
 * The point of the curve is that the SAME burn spell is a different card at
 * different life totals. At twenty, three damage to the face is a poor rate and
 * killing a blocker is plainly better. At eight it is a quarter of the game and
 * beats killing almost anything, because the creature you did not kill will not
 * matter — you are two spells from winning. A flat "chip the face" score could
 * never express that, so an aggro deck piloted by the old rule spent its whole
 * hand answering creatures and then ran out of gas at twelve life.
 *
 * The value scales with the fraction of their remaining life the burn removes,
 * which is exactly the intuition, and is continuous — no cliff, no mode flag.
 */
function faceBurnScore(life: number, amount: number, weights: HeuristicWeights): number {
  const pressure = weights.burnFaceLifeReference / Math.max(life, 1);
  return weights.burnFaceBaseScore + weights.burnFacePerDamage * amount * pressure;
}

/**
 * The spell on the stack a counter should answer, or undefined for "hold it".
 *
 * Two rules keep a counterspell from being a blank card. It must have something to
 * counter at all — casting it into an empty stack resolves as a no-op that ate a
 * card, which is the same class of mistake as casting a pump in the main phase. And
 * it only answers the TOP object: if something of ours already sits above the
 * opponent's spell we have responded, and stacking a second counter on our own
 * answer just throws the extra card away.
 */
function counterTarget(view: PilotView, me: PlayerId) {
  const top = view.stack[view.stack.length - 1];
  if (!top || top.kind !== 'spell') return undefined;
  if (top.controller === me) return undefined; // already answered / it is ours
  return top as Extract<typeof top, { kind: 'spell' }>;
}

/**
 * What sweeping the board is worth to us right now: their creatures cleared, less
 * ours cleared with them, on the same scale as targeted removal. A sweeper with
 * nothing to sweep — or one that costs us more than it costs them — scores zero or
 * less and is held, instead of being fired into an empty board for value nobody got.
 */
function sweeperValue(
  view: PilotView,
  me: PlayerId,
  weights: HeuristicWeights,
  index: ContinuousIndex,
): number {
  let net = 0;
  for (const perm of view.battlefield) {
    if (!isCreature(perm.def)) continue;
    // A wipe neither kills their indestructible creatures nor costs us ours, so
    // neither belongs in the trade. Counting them makes the pilot cast a Wrath
    // into a board it cannot actually clear.
    if (isIndestructible(perm as CardInstance, index)) continue;
    const stats = statTotal(perm as CardInstance, index);
    net += perm.controller === me ? -stats * weights.ownCreatureLossPerStat : stats * weights.killEnemyPerStat;
  }
  return net * weights.removalPerPowerOfTarget;
}

/** A combat trick's best use right now: whom to pump, and what it buys us. */
interface PumpPlay {
  readonly target: InstanceId;
  readonly score: number;
  readonly reason: string;
}

/**
 * Where a +X/+Y trick actually earns its card. A pump is only worth casting when
 * combat is live and it CHANGES an outcome, so we score the three real uses and
 * decline otherwise:
 *
 *   - **push lethal** — an unblocked attacker's extra power finishes the opponent;
 *   - **win the fight** — our creature now kills the creature it is facing;
 *   - **survive** — our creature lives through damage that would have killed it.
 *
 * Returns undefined outside combat, or when the pump changes nothing: holding the
 * card beats spending it for nothing. (The previous pilot never classified pumps
 * at all, so it cast them target-less in its main phase and they silently
 * no-opped — a blank card that ate a mana.)
 */
function bestPumpPlay(
  view: PilotView,
  me: PlayerId,
  opp: PlayerId,
  intent: Extract<SpellIntent, { kind: 'pump' }>,
  weights: HeuristicWeights,
  explain: boolean,
  index: ContinuousIndex,
): PumpPlay | undefined {
  const combat = view.combat;
  if (!combat) return undefined;
  const iAmAttacking = view.activePlayer === me;

  // Our creatures currently in combat, each with the enemy creatures fighting it.
  const engagements: { own: CardInstance; enemies: CardInstance[] }[] = [];
  if (iAmAttacking) {
    for (const attackerId of combat.attackers) {
      const own = findInstance(view, attackerId);
      if (!own || own.controller !== me) continue;
      const enemies: CardInstance[] = [];
      // `for...in` over the block map rather than `Object.entries`: the same keys
      // in the same order, without materialising an array of pairs per attacker.
      for (const blockerId in combat.blocks) {
        const id = Number(blockerId) as InstanceId;
        if (combat.blocks[id] !== attackerId) continue;
        const blocker = findInstance(view, id);
        if (blocker) enemies.push(blocker);
      }
      engagements.push({ own, enemies });
    }
  } else {
    for (const blockerId in combat.blocks) {
      const id = Number(blockerId) as InstanceId;
      const own = findInstance(view, id);
      if (!own || own.controller !== me) continue;
      const attacker = findInstance(view, combat.blocks[id] as InstanceId);
      engagements.push({ own, enemies: attacker ? [attacker] : [] });
    }
  }
  if (engagements.length === 0) return undefined;

  // Face damage already coming through from our unblocked attackers — the baseline
  // the pump adds to when we're deciding whether it's lethal.
  let unblockedDamage = 0;
  if (iAmAttacking) {
    for (let i = 0; i < engagements.length; i++) {
      const e = engagements[i] as { own: CardInstance; enemies: CardInstance[] };
      if (e.enemies.length === 0) unblockedDamage += power(e.own, index);
    }
  }

  let best: PumpPlay | undefined;
  for (const { own, enemies } of engagements) {
    if (enemies.length === 0) {
      // Unblocked attacker: the pump is face damage. Lethal is the whole game.
      if (!iAmAttacking) continue;
      if (unblockedDamage + intent.power >= view.players[opp].life) {
        return {
          target: own.instanceId,
          score: weights.lethalBurnScore,
          reason: explain
            ? `pump ${own.def.name} for lethal (${unblockedDamage} + ${intent.power} ≥ ${view.players[opp].life})`
            : NO_REASON,
        };
      }
      const score = weights.pumpFaceDamagePerPower * intent.power;
      if (score > 0 && (!best || score > best.score)) {
        best = {
          target: own.instanceId,
          score,
          reason: explain ? `pump ${own.def.name} — +${intent.power} face damage` : NO_REASON,
        };
      }
      continue;
    }

    // In a fight: does the pump flip either outcome?
    const ownToughLeft = toughnessLeft(own, index);
    const ownPower = power(own, index);
    let incoming = 0;
    for (let i = 0; i < enemies.length; i++) incoming += power(enemies[i] as CardInstance, index);

    const diesNow = incoming >= ownToughLeft;
    const survivesWithPump = incoming < ownToughLeft + intent.toughness;
    // The biggest enemy we could newly kill with the power boost.
    let newlyKilled: CardInstance | undefined;
    for (const enemy of enemies) {
      const need = toughnessLeft(enemy, index);
      if (ownPower >= need) continue; // already killing it — the pump adds nothing here
      if (ownPower + intent.power < need) continue; // still can't kill it
      if (!newlyKilled || power(enemy, index) > power(newlyKilled, index)) newlyKilled = enemy;
    }

    let score = 0;
    let saves = false;
    if (diesNow && survivesWithPump) {
      score += weights.pumpSaveCreatureScore + weights.ownCreatureLossPerStat * (ownPower + toughness(own, index));
      saves = true;
    }
    if (newlyKilled) {
      score +=
        weights.pumpWinFightScore +
        weights.killEnemyPerStat * statTotal(newlyKilled, index);
    }
    if (score > 0 && (!best || score > best.score)) {
      best = {
        target: own.instanceId,
        score,
        reason: explain ? pumpFightReason(own, incoming, saves, newlyKilled) : NO_REASON,
      };
    }
  }
  return best;
}

/**
 * Emit the next micro-action toward casting `funded.goal`: cast it once the pool
 * covers the cost, otherwise make the next tap in its funding plan.
 *
 * Because the plan only ever contains taps that move us closer to paying, the
 * pilot stops tapping the moment the cost is covered — no more floating a fifth
 * mana for a four-mana turn.
 */
/** A cycling play the pilot wants to make: which card, how it is funded, why. */
interface CycleGoal {
  readonly action: Extract<GameAction, { kind: 'cycleCard' }>;
  readonly plan: readonly ManaTapPlan[];
  readonly score: number;
  readonly reason: string;
}

/**
 * The best CYCLING play right now, or `undefined`.
 *
 * Cycling exists to fix the two hands that lose games — the flooded one and the
 * one with nothing to do — so the policy is exactly those two cases and nothing
 * card-specific:
 *
 *  1. **Flooded.** We already control `floodedLandCount` lands, so another land
 *     in hand is worth less than an unknown card. Cycling it away is close to
 *     free, and this is the case that makes cycling lands worth playing at all.
 *  2. **The turn is ending with mana unspent.** Mana empties at end of step
 *     whatever we do, so converting it into a card costs nothing — scored barely
 *     above passing, so it never outbids a real play.
 *
 * Funding goes through the SAME `planManaPayment` every spell goal uses, which
 * matters more than it looks: the engine only OFFERS `cycleCard` once the pool
 * already covers the cost, so a pilot that did not plan its taps would never see
 * the action and cycling would be inert on a board of untapped lands.
 */
function bestCycle(ctx: DecisionContext, weights: HeuristicWeights): CycleGoal | undefined {
  const { view } = ctx;
  const me = view.priorityPlayer;
  const hand = view.players[me].hand;
  // CHEAPEST QUESTION FIRST, and it is not a micro-optimisation: this function
  // runs on every priority decision of every game in a 700-game gauntlet, and
  // almost no deck holds a cycling card at all. One property read per hand card
  // answers "is there anything to consider?" before anything walks the
  // battlefield — an unconditional board walk here measured on the sim's hot
  // path for a policy that then found nothing to do.
  let anyCycling = false;
  for (const card of hand) {
    const abilities = card.def.cycling;
    if (abilities && abilities.length > 0) {
      anyCycling = true;
      break;
    }
  }
  if (!anyCycling) return undefined;
  let landsInPlay = 0;
  for (const perm of view.battlefield) {
    if (perm.controller === me && isLand(perm.def)) landsInPlay += 1;
  }
  const flooded = landsInPlay >= weights.floodedLandCount;
  // "The turn is ending" is read off the step rather than guessed from the
  // absence of other plays: at the end step nothing else will use this mana.
  const turnEnding = view.step === 'end';

  let best: CycleGoal | undefined;
  for (const card of hand) {
    const abilities = card.def.cycling;
    if (!abilities || abilities.length === 0) continue;
    for (let index = 0; index < abilities.length; index++) {
      const ability = abilities[index]!;
      const surplusLand = flooded && isLand(card.def);
      const score = surplusLand
        ? weights.cycleFloodedScore
        : turnEnding
          ? weights.cycleIdleScore
          : -Infinity;
      if (score <= weights.passScore) continue;
      if (best && score <= best.score) continue;
      const plan = planManaPayment(
        view as GameState,
        me,
        ability.cost,
        ctx.legalActions,
        card.def,
        'activate',
      );
      if (!plan) continue;
      best = {
        action: { kind: 'cycleCard', player: me, instanceId: card.instanceId, abilityIndex: index },
        plan,
        score,
        reason: ctx.trace
          ? `${ability.label} ${card.def.name}${surplusLand ? ` (flooded at ${landsInPlay} lands)` : ' (mana would go unused)'}`
          : NO_REASON,
      };
    }
  }
  return best;
}

/** Take the next step toward a cycling play: tap for it, or cycle. */
function pursueCycle(ctx: DecisionContext, goal: CycleGoal): GameAction {
  const next = goal.plan[0];
  if (!next) return emit(ctx, goal.action, goal.reason, goal.score);
  const tap: GameAction = {
    kind: 'tapForMana',
    player: ctx.view.priorityPlayer,
    instanceId: next.instanceId,
    mode: next.mode,
  };
  return emit(ctx, tap, goal.reason, goal.score);
}

function pursueSpell(ctx: DecisionContext, funded: FundedGoal): GameAction {
  const { view } = ctx;
  const me = view.priorityPlayer;
  const { goal, plan } = funded;

  const next = plan[0];
  if (!next) {
    const cast: GameAction = {
      kind: 'castSpell',
      player: me,
      instanceId: goal.card.instanceId,
      targets: goal.targets.length > 0 ? goal.targets : undefined,
      // A flashback goal must say so, or the engine looks for the card in hand.
      fromZone: goal.fromZone,
    };
    return emit(ctx, cast, goal.reason, goal.score);
  }

  const tap: GameAction = { kind: 'tapForMana', player: me, instanceId: next.instanceId, mode: next.mode };
  if (!ctx.trace) return emit(ctx, tap, NO_REASON, goal.score);
  const source = findInstance(view, next.instanceId);
  const label = source ? `tap ${source.def.name} for ${describeProduction(next.production)}` : 'tap for mana';
  return emit(ctx, tap, `${label} → ${goal.reason}`, goal.score);
}

/** Render a production mode for a decision trace, e.g. `{G:1}` → "G", `{C:2}` → "CC". */
function describeProduction(production: ManaProduction): string {
  let out = '';
  for (const color of MANA_COLORS) out += color.repeat(production[color] ?? 0);
  return out || 'no mana';
}

// --- attacking -----------------------------------------------------------------

/**
 * Choose attackers: send each eligible creature that profits — it either gets in
 * for face damage (opponent has no blocker that survives + kills it for free) or
 * wins/breaks even on the likely trade. Returns a (possibly empty) narrowed
 * `declareAttackers` the engine validates.
 */
function chooseAttack(
  ctx: DecisionContext,
  weights: HeuristicWeights,
  index: ContinuousIndex,
): GameAction | undefined {
  const { view, legalActions } = ctx;
  const me = view.activePlayer;
  const opp = otherPlayer(me);

  const offered = legalActions.find((a) => a.kind === 'declareAttackers') as
    | Extract<GameAction, { kind: 'declareAttackers' }>
    | undefined;
  if (!offered) return undefined; // no eligible attackers — fall through to pass

  const eligible = offered.attackers;
  const enemyBlockers = creaturesControlledBy(view, opp).filter((c) => !c.tapped);

  const chosen: InstanceId[] = [];
  for (const id of eligible) {
    const attacker = findInstance(view, id);
    if (!attacker) continue;
    if (attackIsProfitable(attacker, enemyBlockers, weights, index)) chosen.push(id);
  }

  if (chosen.length === 0) {
    // Nothing profitable to attack with → declare no attackers (pass the step).
    return emit(ctx, passAction(view), 'no profitable attack — holding back', weights.passScore);
  }
  const attackTargets = planWalkerAttack(view, opp, chosen, weights, index);
  const action: GameAction = {
    kind: 'declareAttackers',
    player: me,
    attackers: chosen,
    ...(attackTargets !== undefined ? { attackTargets } : {}),
  };
  const why = ctx.trace
    ? attackTargets !== undefined
      ? `attack with ${chosen.length} creature(s), ${Object.keys(attackTargets).length} at a planeswalker`
      : `attack with ${chosen.length} creature(s)`
    : NO_REASON;
  return emit(ctx, action, why, weights.attackValueThreshold);
}

/**
 * Decide which of the chosen attackers should be sent at an enemy PLANESWALKER
 * instead of the player, or `undefined` when everyone should go face.
 *
 * The policy is deliberately simple and fully explainable:
 *   - if the whole attack is lethal to the PLAYER, nothing is diverted — winning
 *     now beats any walker;
 *   - otherwise, take the enemy walker with the most loyalty that the chosen
 *     attackers could actually FINISH if unblocked, and divert the smallest
 *     (fewest, largest-first) set of attackers whose power covers its loyalty.
 *     Chip damage on a walker nobody can kill is not bought: it trades real face
 *     damage for a discount the opponent controls.
 * The defender may still block the diverted attackers — that is combat.
 */
function planWalkerAttack(
  view: PilotView,
  opp: PlayerId,
  chosen: readonly InstanceId[],
  weights: HeuristicWeights,
  index: ContinuousIndex,
): Record<InstanceId, InstanceId | PlayerId> | undefined {
  // Both kinds of attackable object are considered TOGETHER against one budget of
  // power, because they compete for the same attackers: a walker the defender
  // controls, and a battle the defender PROTECTS (which is normally one this
  // pilot's own side cast). Whichever is worth more and is actually finishable
  // gets the diversion; ties go to the walker, which is the recurring threat.
  const walkers = walkersControlledBy(view, opp);
  const battles = battlesProtectedBy(view, opp);
  if (walkers.length === 0 && battles.length === 0) return undefined;

  const attackers = chosen
    .map((id) => findInstance(view, id))
    .filter((c): c is CardInstance => c !== undefined);
  let totalPower = 0;
  for (const attacker of attackers) totalPower += power(attacker, index);
  // Lethal to the player → nothing is diverted. Winning now beats any object.
  if (totalPower >= view.players[opp].life) return undefined;

  // The best object the whole attack could FINISH, priced by kind. Chip damage is
  // never bought for either kind: an unfinishable target trades real face damage
  // for a discount the opponent controls, and on a battle it buys literally
  // nothing, since the reward only pays on the last counter.
  let target: CardInstance | undefined;
  let targetNeed = 0;
  let targetWorth = 0;
  for (const walker of walkers) {
    const loyalty = loyaltyOf(walker);
    if (loyalty <= 0 || loyalty > totalPower) continue;
    const worth = weights.walkerThreatPerLoyalty * loyalty + weights.walkerKillBonus;
    if (target === undefined || worth > targetWorth) {
      target = walker;
      targetNeed = loyalty;
      targetWorth = worth;
    }
  }
  for (const battle of battles) {
    const defense = defenseOf(battle);
    if (defense <= 0 || defense > totalPower) continue;
    const worth = weights.battleThreatPerDefense * defense + weights.battleDefeatBonus;
    // Strictly greater, so a walker of equal worth keeps the diversion.
    if (target === undefined || worth > targetWorth) {
      target = battle;
      targetNeed = defense;
      targetWorth = worth;
    }
  }
  if (!target) return undefined;
  // Only divert when the object is worth more than the face damage given up.
  if (targetWorth < weights.faceDamageValue * targetNeed) return undefined;

  // Fewest attackers: biggest first until the need is covered.
  const byPowerDesc = [...attackers].sort((a, b) => power(b, index) - power(a, index));
  const assigned: Record<InstanceId, InstanceId | PlayerId> = {};
  let covered = 0;
  for (const attacker of byPowerDesc) {
    if (covered >= targetNeed) break;
    assigned[attacker.instanceId] = target.instanceId;
    covered += power(attacker, index);
  }
  return covered >= targetNeed ? assigned : undefined;
}

/**
 * Is sending this attacker worth it? It's profitable if, against the opponent's
 * best single blocker, the expected outcome's value clears the threshold. We model
 * the opponent blocking with the cheapest creature that profitably trades; if no
 * such blocker exists the attacker connects for face damage.
 */
function attackIsProfitable(
  attacker: CardInstance,
  enemyBlockers: readonly CardInstance[],
  weights: HeuristicWeights,
  index: ContinuousIndex,
): boolean {
  const myPower = power(attacker, index);
  const myTough = toughness(attacker, index);
  if (myPower <= 0) return false; // a 0-power attacker accomplishes nothing

  // The opponent will block if a blocker kills us and the trade favours them.
  // Find the blocker that would profitably kill us; if one exists, weigh the trade.
  let bestEnemyValue = -Infinity; // value to the OPPONENT of their best block
  let eligibleBlockers = 0;
  for (const b of enemyBlockers) {
    if (!canBlockByEvasion(attacker, b, index)) continue;
    eligibleBlockers += 1;
    const bPower = power(b, index);
    const bTough = toughness(b, index);
    const attackerDies = bPower >= myTough;
    const blockerDies = myPower >= bTough;
    // Value to the opponent: they gain by killing our creature, lose by losing theirs.
    const enemyValue =
      (attackerDies ? weights.killEnemyPerStat * (myPower + myTough) : 0) -
      (blockerDies ? weights.ownCreatureLossPerStat * (bPower + bTough) : 0);
    if (enemyValue > bestEnemyValue) bestEnemyValue = enemyValue;
  }

  // Our attacker's own blocking requirement decides how many of those eligible
  // blockers the defender actually needs: menace (or "except by N or more") means
  // a single blocker is not a legal block at all, so a lone potential blocker is
  // no deterrent and this attack is really unopposed.
  const blockersNeeded = needsMultipleBlockers(attacker) ? MENACE_BLOCKERS_NEEDED : 1;
  const blockerExists = eligibleBlockers >= blockersNeeded;

  // If the opponent has a block that's good for them (positive value) AND it kills
  // our attacker, attacking loses value — hold back unless we'd trade up.
  if (blockerExists && bestEnemyValue > 0) {
    // The opponent's best block nets them value → from our side this is a bad
    // attack. Our value is the negation; require it to clear the threshold.
    const ourValue = -bestEnemyValue;
    return ourValue >= weights.attackValueThreshold;
  }

  // No profitable block for the opponent: either they have no blocker (face
  // damage) or blocking only loses them value. Attack for the face-damage value.
  const faceValue = weights.faceDamageValue * myPower;
  return faceValue >= weights.attackValueThreshold;
}

// --- blocking ------------------------------------------------------------------

/**
 * Choose blocks: assign blockers to attackers to preserve life and make favourable
 * trades. Under lethal/low-life pressure, block readily to survive; otherwise only
 * block when the trade is at least break-even. Returns a constructed
 * `declareBlockers` the engine validates.
 */
function chooseBlock(
  ctx: DecisionContext,
  weights: HeuristicWeights,
  index: ContinuousIndex,
): GameAction | undefined {
  const { view } = ctx;
  const me = defendingPlayer(view);
  const combat = view.combat;
  if (!combat || combat.attackers.length === 0) return undefined;
  // Blocks are declared once per combat. If they're already declared (we're being
  // re-offered priority in the same step), there's nothing more to do here — fall
  // through to a normal priority pass rather than re-declaring (which the engine
  // would reject, spinning forever).
  if (Object.keys(combat.blocks).length > 0) return undefined;

  const myLife = view.players[me].life;
  const incomingDamage = totalIncomingDamage(view, combat.attackers, index);
  const facingLethal = incomingDamage >= myLife;
  const desperate = facingLethal || myLife <= weights.desperateLifeThreshold;

  const availableBlockers = creaturesControlledBy(view, me).filter((c) => !c.tapped);
  const used = new Set<InstanceId>();
  const blocks: { blocker: InstanceId; attacker: InstanceId }[] = [];

  // Sort attackers by power desc — block the biggest hits first (most life saved /
  // worst threat removed).
  const attackers = [...combat.attackers]
    .map((id) => findInstance(view, id))
    .filter((c): c is CardInstance => c !== undefined)
    .sort((a, b) => power(b, index) - power(a, index));

  for (const attacker of attackers) {
    const blocker = pickBlocker(attacker, availableBlockers, used, desperate, weights, index);
    if (blocker) {
      blocks.push({ blocker: blocker.instanceId, attacker: attacker.instanceId });
      used.add(blocker.instanceId);
    }
  }

  // Declaring zero blocks via an empty `declareBlockers` would leave combat.blocks
  // empty and get us re-offered the same choice forever. When we don't block, pass
  // priority instead — that lets combat damage resolve and the step advance.
  if (blocks.length === 0) {
    return emit(ctx, passAction(view), 'no profitable block — taking the hit', weights.passScore);
  }
  const action: GameAction = { kind: 'declareBlockers', player: me, blocks };
  if (!ctx.trace) return emit(ctx, action, NO_REASON);
  const reason = facingLethal
    ? `block to avoid lethal (${incomingDamage} incoming vs ${myLife} life)`
    : `block ${blocks.length} attacker(s) for value`;
  return emit(ctx, action, reason);
}

/**
 * Pick the best unused blocker for an attacker, or undefined to take the damage.
 * When desperate (facing lethal / low life) we chump-block to survive even at a
 * loss; otherwise we block only for a favourable-or-even trade.
 */
function pickBlocker(
  attacker: CardInstance,
  blockers: readonly CardInstance[],
  used: Set<InstanceId>,
  desperate: boolean,
  weights: HeuristicWeights,
  index: ContinuousIndex,
): CardInstance | undefined {
  // A creature that can only be blocked by two or more is one this pilot cannot
  // block at all: it assigns a single blocker per attacker, and a lone blocker on
  // a menacing attacker makes the WHOLE declaration illegal - so every other
  // block in the same action is lost with it.
  if (needsMultipleBlockers(attacker)) return undefined;
  const aPower = power(attacker, index);
  const aTough = toughness(attacker, index);

  let best: CardInstance | undefined;
  let bestValue = -Infinity;
  for (const b of blockers) {
    if (used.has(b.instanceId)) continue;
    if (!canBlockByEvasion(attacker, b, index)) continue;
    const bPower = power(b, index);
    const bTough = toughness(b, index);
    const blockerDies = aPower >= bTough;
    const attackerDies = bPower >= aTough;
    // Trade value to US: gain by killing the attacker, lose by losing our blocker.
    const value =
      (attackerDies ? weights.killEnemyPerStat * (aPower + aTough) : 0) -
      (blockerDies ? weights.ownCreatureLossPerStat * (bPower + bTough) : 0);
    if (value > bestValue) {
      bestValue = value;
      best = b;
    }
  }

  if (!best) return undefined;
  if (desperate) return best; // survive at any cost — chump if needed
  return bestValue >= weights.blockValueThreshold ? best : undefined;
}

// --- spell classification ------------------------------------------------------

/**
 * Memo for {@link classifySpell}. A spell's intent is a pure function of its
 * IMMUTABLE definition — the pool is frozen and every instance of a card points
 * at the same `CardDefinition` object — so the classification can be computed
 * once per printed card instead of once per card in hand per decision. That
 * matters because MCTS calls this pilot ~20,000 times per look-ahead decision.
 * (Same reasoning, and same shape, as core's `RESTRICTION_MEMO`.)
 */
const INTENT_MEMO = new WeakMap<CardDefinition, SpellIntent>();

/** Classify a spell's intent from its effect primitives (robust to unknowns). */
function classifySpell(def: CardDefinition): SpellIntent {
  const memoized = INTENT_MEMO.get(def);
  if (memoized !== undefined) return memoized;
  const intent = computeSpellIntent(def);
  INTENT_MEMO.set(def, intent);
  return intent;
}

function computeSpellIntent(def: CardDefinition): SpellIntent {
  // Checked FIRST: a modal card's whole script is its modes, so the primitive
  // scan below would find nothing at all and score Cryptic Command as a blank.
  if (modalSpecOf(def)) return { kind: 'modal' };
  // Checked before the creature branch so a creature Aura (bestow-style) is still
  // read as an attachment, and before the primitive scan because an attachment's
  // value is in its declared modification, not in the ref that attaches it.
  const attachment = def.attachment;
  if (attachment) {
    const mod = attachment.modifies;
    const stats = (mod?.power ?? 0) + (mod?.toughness ?? 0);
    const keywords = mod?.keywords ? Object.values(mod.keywords).filter(Boolean).length : 0;
    return {
      kind: 'attachment',
      stats,
      keywords,
      // A NEGATIVE attachment is removal wearing an Aura's clothes (Dead Weight),
      // and must be aimed at the OPPONENT's board. Getting this backwards would
      // have the pilot shrink its own creatures — a card played as the opposite of
      // what it prints, which is worse than not playing it at all.
      helpful: stats >= 0,
    };
  }
  if (isCreature(def)) return { kind: 'creature' };
  const effects = def.effects ?? [];
  for (const ref of effects) {
    if (ref.primitive === PRIMITIVE.dealDamage) {
      const raw = ref.params?.amount;
      const amountIsX =
        typeof raw === 'object' && raw !== null && (raw as { chosenX?: unknown }).chosenX === true;
      // A base/kicked pair ("deals 2… deals 4 instead if kicked") is priced at
      // its UNKICKED floor: the pilot may or may not kick, and the floor is the
      // one number the cast is guaranteed to be worth.
      const kickedPair =
        typeof raw === 'object' && raw !== null && typeof (raw as { base?: unknown }).base === 'number'
          ? ((raw as { base: number }).base)
          : undefined;
      const amount = amountIsX ? 0 : (kickedPair ?? numberParam(ref.params, 'amount', 0));
      // Convention: a damage primitive can target creatures and/or players. Default
      // to both unless params restrict it; robust if params are absent.
      const targets = stringParam(ref.params, 'targets', 'any');
      return {
        kind: 'damage',
        amount,
        canTargetCreature: targets === 'any' || targets === 'creature' || targets === 'creatureOrPlaneswalker',
        canTargetPlayer: targets === 'any' || targets === 'player' || targets === 'playerOrPlaneswalker',
        canTargetWalker:
          targets === 'any' || targets === 'playerOrPlaneswalker' || targets === 'creatureOrPlaneswalker',
        ...(amountIsX ? { amountIsX: true } : {}),
      };
    }
    if (ref.primitive === PRIMITIVE.destroyTarget || ref.primitive === PRIMITIVE.exileTarget) {
      // DESTROY and EXILE are the same play against almost every creature and
      // opposite plays against an indestructible one, so the two cannot share an
      // intent without the pilot "killing" a creature that shrugs it off. The
      // flag is what the targeting below reads.
      return { kind: 'destroyCreature', exiles: ref.primitive === PRIMITIVE.exileTarget };
    }
    if (ref.primitive === PRIMITIVE.counterSpell || ref.primitive === PRIMITIVE.counterUnlessPaid) {
      return { kind: 'counter' };
    }
    if (ref.primitive === PRIMITIVE.destroyAll) return { kind: 'sweeper' };
    if (ref.primitive === PRIMITIVE.pumpUntilEndOfTurn) {
      const power = numberParam(ref.params, 'power', 0);
      const toughness = numberParam(ref.params, 'toughness', 0);
      // A NEGATIVE "pump" is the pool's shrink-removal (Disfigure, Last Gasp,
      // Grasp of Darkness). Reading it as a combat trick made the pilot look for a
      // creature of its own to make *worse*, find none, and never cast the card at
      // all — a whole family of removal spells silently blank. It is removal.
      if (power < 0 || toughness < 0) return { kind: 'shrink', toughness: -toughness };
      return { kind: 'pump', power, toughness };
    }
  }
  return { kind: 'other' };
}

// --- evaluation helpers --------------------------------------------------------

// `totalAvailableMana` — the pilot's cheap "mana I could make this turn" upper
// bound — now lives in `land-sequencing.ts` and is imported back. Both modules need
// the identical bound and that one is the leaf of the two, so keeping it here would
// have meant two copies of a number that must agree.

/*
 * The three battlefield selectors below are indexed loops rather than `filter`,
 * for the same reason as the action predicates further down: each `filter` takes a
 * fresh closure, and these run several times per decision on the pilot that is
 * also MCTS's rollout policy. They return exactly what the `filter` returned.
 */

/** Creatures a player controls on the battlefield. */
function creaturesControlledBy(view: PilotView, player: PlayerId): CardInstance[] {
  const battlefield = view.battlefield;
  const out: CardInstance[] = [];
  for (let i = 0; i < battlefield.length; i++) {
    const perm = battlefield[i] as CardInstance;
    if (perm.controller === player && isCreature(perm.def)) out.push(perm);
  }
  return out;
}

/** Planeswalkers a player controls on the battlefield. */
function walkersControlledBy(view: PilotView, player: PlayerId): CardInstance[] {
  const battlefield = view.battlefield;
  const out: CardInstance[] = [];
  for (let i = 0; i < battlefield.length; i++) {
    const perm = battlefield[i] as CardInstance;
    if (perm.controller === player && isPlaneswalker(perm.def)) out.push(perm);
  }
  return out;
}

/**
 * Battles the given player PROTECTS — deliberately not the ones they control,
 * and getting that backwards is the one way to build an attack the engine will
 * reject.
 *
 * A battle is defended by its controller's OPPONENT (`protectorOf`, CR 310.11),
 * so the battles a pilot may attack are the ones the DEFENDING player protects —
 * in practice its own Sieges. That is the printed play pattern: you cast it, your
 * opponent is made its protector, and you attack it to collect the reward.
 */
function battlesProtectedBy(view: PilotView, player: PlayerId): CardInstance[] {
  const battlefield = view.battlefield;
  const out: CardInstance[] = [];
  for (let i = 0; i < battlefield.length; i++) {
    const perm = battlefield[i] as CardInstance;
    if (isBattle(perm.def) && protectorOf(perm) === player) out.push(perm);
  }
  return out;
}

/**
 * The most valuable enemy walker this much damage can FINISH (loyalty ≤ amount),
 * "most valuable" being the one with the most loyalty — it is the one making the
 * most trouble per turn it survives.
 */
function biggestKillableWalker(
  view: PilotView,
  opp: PlayerId,
  amount: number,
): CardInstance | undefined {
  let best: CardInstance | undefined;
  for (const walker of walkersControlledBy(view, opp)) {
    const loyalty = loyaltyOf(walker);
    if (loyalty <= 0 || loyalty > amount) continue;
    if (!best || loyalty > loyaltyOf(best)) best = walker;
  }
  return best;
}

/**
 * The biggest threat among creatures whose REMAINING toughness this much damage
 * (or toughness reduction) would finish off — the same answer as
 * `biggestThreat(creatures.filter((c) => toughnessLeft(c, index) <= amount))`, without
 * the throwaway array. Removal and burn each ask this once per candidate spell per
 * decision, and a decision happens ~20,000 times inside one MCTS look-ahead.
 */
function biggestThreatWithin(
  creatures: readonly CardInstance[],
  amount: number,
  index: ContinuousIndex,
): CardInstance | undefined {
  let best: CardInstance | undefined;
  for (const c of creatures) {
    if (toughnessLeft(c, index) > amount) continue;
    if (!best) {
      best = c;
      continue;
    }
    const cp = power(c, index);
    const bp = power(best, index);
    if (cp > bp || (cp === bp && toughness(c, index) > toughness(best, index))) best = c;
  }
  return best;
}

/** The biggest threat among creatures: highest power, then toughness. */
function biggestThreat(
  creatures: readonly CardInstance[],
  index: ContinuousIndex,
): CardInstance | undefined {
  let best: CardInstance | undefined;
  for (const c of creatures) {
    if (!best) {
      best = c;
      continue;
    }
    const cp = power(c, index);
    const bp = power(best, index);
    if (cp > bp || (cp === bp && toughness(c, index) > toughness(best, index))) best = c;
  }
  return best;
}

/** Total unblocked-if-unblocked damage the listed attackers represent. */
function totalIncomingDamage(
  view: PilotView,
  attackerIds: readonly InstanceId[],
  index: ContinuousIndex,
): number {
  let total = 0;
  for (const id of attackerIds) {
    const a = findInstance(view, id);
    if (a) total += power(a, index);
  }
  return total;
}

/**
 * Whether this permanent shrugs off an effect that says "destroy".
 *
 * Read through the continuous layer, not off `def.keywords`: an opponent who has
 * just cast Heroic Intervention has an indestructible board with nothing printed
 * on it, and a pilot that reads the printed set walks its removal straight into
 * that. The DECISION's index is passed in rather than rebuilt per permanent —
 * `aggregateFor` is a whole battlefield pass, and this runs once per candidate
 * creature per removal spell.
 */
function isIndestructible(perm: CardInstance, index: ContinuousIndex): boolean {
  return Boolean(keywordsOf(perm, index).indestructible);
}

/**
 * Whether `blocker` could legally block `attacker` PER PAIR. Mirrors core's
 * `canBlock` so the pilot only proposes declarations the engine will accept.
 *
 * ⚠️ It is deliberately the per-pair half only. Menace and "can't be blocked
 * except by N or more creatures" constrain the whole DECLARATION, and this pilot
 * assigns at most one blocker per attacker — so those are handled by
 * {@link needsMultipleBlockers} refusing to block such an attacker at all,
 * rather than by a pair test that cannot see the count.
 *
 * Keywords are read EFFECTIVE, not printed: flying granted by an Aura or an
 * until-end-of-turn effect is flying, and a pilot that read only the printed box
 * proposed blocks the engine then rejected — the rules path and the AI path
 * answering one question two ways. (This doc-comment previously said the opposite,
 * and said it for the same reason the rest of the file did: nothing passed an
 * index. See `board-stats.ts`.)
 */
function canBlockByEvasion(
  attacker: CardInstance,
  blocker: CardInstance,
  index: ContinuousIndex,
): boolean {
  const ak = keywordsOf(attacker, index);
  const bk = keywordsOf(blocker, index);
  // The blocker's own restriction disqualifies it whatever it would block.
  if (bk.cantBlock) return false;
  if (ak.unblockable) return false;
  if (ak.flying && !(bk.flying || bk.reach)) return false;
  return true;
}

/**
 * The smallest blocking requirement any printing of the rule states - menace's
 * "two or more". Used as the count a defender needs before such an attacker is
 * genuinely opposed.
 */
const MENACE_BLOCKERS_NEEDED = 2;

/**
 * Whether this attacker prints a blocking requirement of two or more creatures
 * (menace, or the general "except by N or more"). This pilot never assigns more
 * than one blocker to an attacker, so proposing ANY block on such a creature is
 * proposing an illegal declaration - the engine rejects the whole thing, and the
 * pilot loses every other block in it as well.
 */
function needsMultipleBlockers(attacker: CardInstance): boolean {
  const ak = attacker.def.keywords ?? {};
  return Boolean(ak.menace) || (ak.minBlockers ?? 0) > 1;
}

function findInstance(view: PilotView, id: InstanceId): CardInstance | undefined {
  // Indexed, closure-free: this is the single most-called helper in the file (every
  // attacker, blocker, tap plan and offered ability resolves an id through it).
  const battlefield = view.battlefield;
  for (let i = 0; i < battlefield.length; i++) {
    const perm = battlefield[i] as CardInstance;
    if (perm.instanceId === id) return perm;
  }
  return undefined;
}

// --- small utilities -----------------------------------------------------------

function otherPlayer(p: PlayerId): PlayerId {
  return p === 'A' ? 'B' : 'A';
}

/*
 * The three action-list predicates below are indexed loops rather than
 * `every`/`some`/`find`. Not style: each of those takes a fresh function literal,
 * and this pilot is MCTS's rollout policy, so the callbacks alone were tens of
 * thousands of throwaway closures per look-ahead decision. They return exactly
 * what the array methods returned.
 */

function everyActionIsPass(actions: readonly GameAction[]): boolean {
  for (let i = 0; i < actions.length; i++) {
    if ((actions[i] as GameAction).kind !== 'passPriority') return false;
  }
  return true;
}

function anyActionOfKind(actions: readonly GameAction[], kind: GameAction['kind']): boolean {
  for (let i = 0; i < actions.length; i++) {
    if ((actions[i] as GameAction).kind === kind) return true;
  }
  return false;
}

/**
 * The human-readable "why" for a combat trick cast in a fight. Split out of the
 * scoring loop so the loop itself never builds the string: it is observational,
 * and only a caller with a `trace` sink ever asks for it.
 */
function pumpFightReason(
  own: CardInstance,
  incoming: number,
  saves: boolean,
  newlyKilled: CardInstance | undefined,
): string {
  const parts: string[] = [];
  if (saves) parts.push(`saves ${own.def.name} from ${incoming} damage`);
  if (newlyKilled) parts.push(`kills ${newlyKilled.def.name}`);
  return `pump ${own.def.name} — ${parts.join(' + ')}`;
}

function defendingPlayer(view: PilotView): PlayerId {
  return view.activePlayer === 'A' ? 'B' : 'A';
}

function passAction(view: PilotView | GameState): GameAction {
  return { kind: 'passPriority', player: view.priorityPlayer };
}

function numberParam(params: Readonly<Record<string, unknown>> | undefined, key: string, fallback: number): number {
  const v = params?.[key];
  return typeof v === 'number' ? v : fallback;
}

function stringParam(params: Readonly<Record<string, unknown>> | undefined, key: string, fallback: string): string {
  const v = params?.[key];
  return typeof v === 'string' ? v : fallback;
}

// --- the policy seam a search consumes -------------------------------------------

/**
 * One STRATEGIC option the policy offers a search, and the whole point of Phase 2
 * of `docs/plans/superhuman-ai-program.md`.
 *
 * `plies` is the **atomic** sequence of engine actions that carries the option out
 * — the mana taps that fund a spell *and* the cast itself, together. That is the
 * measured defect this fixes. The old search taps a land in one action and casts
 * in another, so it evaluates "tap" through rollouts in which the heuristic later
 * spends that mana, while the real next mover treats it as sunk and declines: 0.71
 * wasted mana per turn against the heuristic's 0.00 (DESIGN §3.4). A search that
 * can only ever choose "tap AND cast" or "neither" cannot make that mistake,
 * because the option it prices is the option it takes.
 *
 * Funding runs through core's `planManaPayment` — the SAME planner the heuristic
 * itself pays with — so there is exactly one answer to "which lands fund this" in
 * the codebase and the search cannot drift from the pilot.
 */
export interface PolicyCandidate {
  /** The engine actions that carry this option out, in order. Never empty. */
  readonly plies: readonly GameAction[];
  /** The heuristic's score for the option — the raw prior a search softmaxes. */
  readonly score: number;
  /** A short human-readable label (empty unless a caller asked for reasons). */
  readonly label: string;
}

/**
 * Enumerate the strategic options at this decision, scored by the heuristic's own
 * MTG knowledge (brief §57: "do NOT remove the current heuristic engine — turn its
 * knowledge into reusable policy components").
 *
 * This is the policy half of the brief's §29–31 evaluator interface: the search
 * asks the existing heuristic "what would you consider, and how much do you like
 * each?" and then does its own thinking about the answer. Nothing here decides
 * anything — ranking is advisory, and a search is free to (and does) explore
 * options this function ranked last.
 *
 * `explain` is off by default because building the reason strings costs several
 * allocations per candidate and a search calls this at every node it expands.
 */
export function policyCandidates(
  view: PilotView,
  legalActions: readonly GameAction[],
  weights: HeuristicWeights = DEFAULT_HEURISTIC_WEIGHTS,
  explain = false,
  providedIndex?: ContinuousIndex,
): PolicyCandidate[] {
  const out: PolicyCandidate[] = [];
  const me = view.priorityPlayer;
  const state = view as GameState;
  // A caller that already built the index for this position hands it in (the
  // search does, once per node); anyone else gets one built here. It is never
  // omitted — that is the whole defect this parameter exists to close.
  const index = providedIndex ?? boardIndex(state);

  // A parked question is not a strategic decision — it is the only thing the game
  // will accept, and the heuristic answers it on its own terms. Level 0 of the
  // brief's action hierarchy: resolve, never search.
  const pending = view.pendingChoice as PendingChoice | null | undefined;
  if (pending) {
    return [{ plies: [answerChoiceHeuristically(state, pending, weights)], score: 0, label: NO_REASON }];
  }

  if (view.step === 'declareAttackers' && me === view.activePlayer) {
    collectAttackCandidates(view, legalActions, weights, explain, index, out);
  } else if (view.step === 'declareBlockers' && me === defendingPlayer(view)) {
    collectBlockCandidates(view, weights, explain, index, out);
  } else {
    collectPriorityCandidates(view, legalActions, weights, explain, index, out);
  }

  // Passing is ALWAYS on the menu. "Hold interaction / do nothing this window" is
  // a real MTG line the brief names explicitly (§4), and a search that could not
  // decline every play would be forced to make one.
  //
  // It is CONSTRUCTED rather than looked up, exactly as the heuristic constructs
  // it: at `declareAttackers` the engine offers the composite declaration and the
  // pass is the same "declare nothing" move the pilot already makes there. It is
  // legal in every window this function can reach, because a parked choice — the
  // one situation where passing is rejected — returned above.
  out.push({
    plies: [{ kind: 'passPriority', player: me }],
    score: weights.passScore,
    label: explain ? 'pass' : NO_REASON,
  });
  return out;
}

/**
 * Attack options. NOT every subset of eligible attackers — that is `2^n` and the
 * brief (§39) is explicit that combat must be classified before it is searched.
 * Three lines cover the decision that actually matters: the heuristic's own
 * value-judged attack, the all-in alpha strike (which the value judgement refuses
 * and which is nevertheless right whenever racing beats trading), and no attack.
 */
function collectAttackCandidates(
  view: PilotView,
  legalActions: readonly GameAction[],
  weights: HeuristicWeights,
  explain: boolean,
  index: ContinuousIndex,
  out: PolicyCandidate[],
): void {
  const offered = legalActions.find((a) => a.kind === 'declareAttackers') as
    | Extract<GameAction, { kind: 'declareAttackers' }>
    | undefined;
  if (!offered || offered.attackers.length === 0) return;
  const me = view.activePlayer;
  const opp = otherPlayer(me);
  const enemyBlockers = creaturesControlledBy(view, opp).filter((c) => !c.tapped);

  const profitable: InstanceId[] = [];
  for (const id of offered.attackers) {
    const attacker = findInstance(view, id);
    if (attacker && attackIsProfitable(attacker, enemyBlockers, weights, index)) profitable.push(id);
  }
  if (profitable.length > 0) {
    // The value-judged attack carries the same walker assignment the plain
    // heuristic would make, so the search's preferred line can actually kill a
    // planeswalker rather than walkers being reachable only outside search.
    const walkerPlan = planWalkerAttack(view, opp, profitable, weights, index);
    out.push({
      plies: [
        {
          kind: 'declareAttackers',
          player: me,
          attackers: profitable,
          ...(walkerPlan !== undefined ? { attackTargets: walkerPlan } : {}),
        },
      ],
      score: weights.attackValueThreshold,
      label: explain ? `attack with ${profitable.length}` : NO_REASON,
    });
    // When a walker plan exists, the all-face version stays on the menu too —
    // whether the race beats the walker kill is exactly a search question.
    if (walkerPlan !== undefined) {
      out.push({
        plies: [{ kind: 'declareAttackers', player: me, attackers: profitable }],
        score: weights.attackValueThreshold - 1,
        label: explain ? `attack with ${profitable.length} (all at the player)` : NO_REASON,
      });
    }
  }
  if (offered.attackers.length !== profitable.length) {
    out.push({
      plies: [{ kind: 'declareAttackers', player: me, attackers: [...offered.attackers] }],
      // Scored BELOW the value-judged attack so the prior prefers the sober line;
      // search is what gets to disagree, which is exactly the division of labour
      // the brief asks for.
      score: weights.attackValueThreshold - 1,
      label: explain ? `alpha strike ×${offered.attackers.length}` : NO_REASON,
    });
  }
}

/** Block options: the heuristic's assignment, and taking the damage. */
function collectBlockCandidates(
  view: PilotView,
  weights: HeuristicWeights,
  explain: boolean,
  index: ContinuousIndex,
  out: PolicyCandidate[],
): void {
  const me = defendingPlayer(view);
  const combat = view.combat;
  if (!combat || combat.attackers.length === 0) return;
  if (Object.keys(combat.blocks).length > 0) return; // already declared

  const myLife = view.players[me].life;
  const incoming = totalIncomingDamage(view, combat.attackers, index);
  const desperate = incoming >= myLife || myLife <= weights.desperateLifeThreshold;
  const available = creaturesControlledBy(view, me).filter((c) => !c.tapped);
  const attackers = [...combat.attackers]
    .map((id) => findInstance(view, id))
    .filter((c): c is CardInstance => c !== undefined)
    .sort((a, b) => power(b, index) - power(a, index));

  // Both the value-judged block and the survival block, when they differ: under
  // pressure "chump to live" and "only trade profitably" are genuinely different
  // plans, and which is right is precisely what a search can work out.
  for (const mode of desperate ? [true] : [false, true]) {
    const used = new Set<InstanceId>();
    const blocks: { blocker: InstanceId; attacker: InstanceId }[] = [];
    for (const attacker of attackers) {
      const blocker = pickBlocker(attacker, available, used, mode, weights, index);
      if (blocker) {
        blocks.push({ blocker: blocker.instanceId, attacker: attacker.instanceId });
        used.add(blocker.instanceId);
      }
    }
    if (blocks.length === 0) continue;
    out.push({
      plies: [{ kind: 'declareBlockers', player: me, blocks }],
      score: mode === desperate ? weights.blockValueThreshold : weights.blockValueThreshold - 1,
      label: explain ? `block ×${blocks.length}${mode ? ' (survive)' : ''}` : NO_REASON,
    });
  }
}

/**
 * Priority-window options, each as an ATOMIC macro: land drops, every castable
 * spell bundled with the taps that fund it, fetchland activations, and equips.
 */
function collectPriorityCandidates(
  view: PilotView,
  legalActions: readonly GameAction[],
  weights: HeuristicWeights,
  explain: boolean,
  index: ContinuousIndex,
  out: PolicyCandidate[],
): void {
  const me = view.priorityPlayer;
  const state = view as GameState;

  // Land drops. One candidate per DISTINCT land, because playing either of two
  // Mountains from hand is the same decision (brief §4 Level 1) — and ranked by
  // what each one UNLOCKS, so the prior does not tell a search that the Mountain
  // and the Swamp are the same move when only the Swamp casts the removal spell.
  //
  // The BEST land keeps exactly `playLandScore`; a worse one is discounted by how
  // much less it unlocks. That shape is deliberate: it changes land-versus-land
  // ordering (the defect) without moving land-versus-spell ordering (every recorded
  // baseline's most load-bearing assumption).
  const landOptions = rankLandDrops(view, legalActions, weights);
  let bestLandMerit = -Infinity;
  for (const option of landOptions) if (option.merit > bestLandMerit) bestLandMerit = option.merit;
  for (const option of landOptions) {
    out.push({
      plies: [option.action],
      score: weights.playLandScore - (bestLandMerit - option.merit),
      label: explain ? `play ${option.name}` : NO_REASON,
    });
  }

  // Fetchland-style abilities the heuristic understands. Offered by the engine
  // already fully payable, so they need no funding plan.
  for (const action of legalActions) {
    if (action.kind !== 'activateAbility') continue;
    const source = findInstance(view, action.instanceId);
    const ability = source?.def.activated?.[action.abilityIndex];
    if (!ability || !fetchesALand(ability)) continue;
    out.push({
      plies: [action],
      score: weights.playLandScore,
      label: explain ? `activate ${ability.label}` : NO_REASON,
    });
  }

  // THE ATOMIC CASTS. Every legal, scored spell, each bundled with its funding.
  for (const goal of scoredSpellGoals(view, weights, explain, index)) {
    const plan = planManaPayment(
      state,
      me,
      goal.cost,
      legalActions,
      goal.card.def,
      'cast',
    );
    if (!plan) continue; // cannot be funded from this board — not an option at all
    const plies: GameAction[] = [];
    for (const tap of plan) plies.push({ kind: 'tapForMana', player: me, instanceId: tap.instanceId, mode: tap.mode });
    plies.push({
      kind: 'castSpell',
      player: me,
      instanceId: goal.card.instanceId,
      targets: goal.targets.length > 0 ? goal.targets : undefined,
      fromZone: goal.fromZone,
    });
    out.push({ plies, score: goal.score, label: goal.reason });
  }

  // Equipping, funded the same way (it is an activated ability with a mana cost,
  // so the engine will not offer it until the pool already pays — see the note on
  // `bestEquipPlay`, which is why this plans rather than reads the offered list).
  const equip = bestEquipMacro(view, legalActions, weights, explain, index);
  if (equip) out.push(equip);
}

/**
 * The best equip play as ONE atomic macro (taps + activation), mirroring
 * {@link bestEquipPlay} but returning the whole sequence rather than only the next
 * micro-step. Same recognition rules, so the two cannot classify differently.
 */
function bestEquipMacro(
  view: PilotView,
  legalActions: readonly GameAction[],
  weights: HeuristicWeights,
  explain: boolean,
  index: ContinuousIndex,
): PolicyCandidate | undefined {
  const me = view.priorityPlayer;
  const sorcerySpeedOpen =
    me === view.activePlayer &&
    (view.step === 'precombatMain' || view.step === 'postcombatMain') &&
    view.stack.length === 0;
  if (!sorcerySpeedOpen) return undefined;

  let hosts: readonly (InstanceId | PlayerId)[] | undefined;
  let best: PolicyCandidate | undefined;
  const battlefield = view.battlefield;
  for (let b = 0; b < battlefield.length; b++) {
    const perm = battlefield[b] as CardInstance;
    const abilities = perm.def.activated;
    if (abilities === undefined || perm.controller !== me) continue;
    const modifies = perm.def.attachment?.modifies;
    if (!modifies) continue;
    for (let a = 0; a < abilities.length; a++) {
      const ability = abilities[a]!;
      if (restrictionOfEffects(ability.effects) !== EQUIP_RESTRICTION) continue;
      const mana = ability.cost.mana;
      if (!mana || ability.cost.tap || ability.cost.sacrificeSelf || ability.cost.life) continue;
      hosts ??= legalTargetsFor(view as GameState, EQUIP_RESTRICTION, me, perm.def);
      const host = bestEquipHost(view, hosts, perm.attachedTo ?? null, index);
      if (!host) continue;
      const score = scoreEquip(modifies, host, weights, index);
      if (score === undefined || (best !== undefined && score <= best.score)) continue;
      const plan = planManaPayment(
        view as GameState,
        me,
        mana,
        legalActions,
        perm.def,
        'activate',
      );
      if (!plan) continue;
      const plies: GameAction[] = [];
      for (const tap of plan) plies.push({ kind: 'tapForMana', player: me, instanceId: tap.instanceId, mode: tap.mode });
      plies.push({
        kind: 'activateAbility',
        player: me,
        instanceId: perm.instanceId,
        abilityIndex: a,
        targets: [host.instanceId],
      });
      best = { plies, score, label: explain ? `${ability.label} onto ${host.def.name}` : NO_REASON };
    }
  }
  return best;
}

/** Emit an optional trace and return the action (keeps decision sites terse). */
function emit(ctx: DecisionContext, action: GameAction, reason: string, score?: number): GameAction {
  const sink = ctx.trace;
  if (sink === undefined) return action; // nobody listening => no trace object to build
  const trace: DecisionTrace = score === undefined ? { action, reason } : { action, reason, score };
  sink(trace);
  return action;
}

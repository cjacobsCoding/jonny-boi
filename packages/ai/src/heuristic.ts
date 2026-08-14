/**
 * The `heuristic` pilot — a competent, non-random pilot good enough to play the
 * meta decks sensibly, so the sim's win-rate verdicts aren't drowned in noise.
 *
 * It is deliberately *not* optimal. It plays by a small set of justifiable rules,
 * all weighted by the tunable `HeuristicWeights` (DESIGN §1 — no magic numbers):
 *
 *   Main phase (priority windows):
 *     - Develop mana: always play a land if able (lands outrank most spells).
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
 */

import type {
  CardDefinition,
  CardInstance,
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
  bestManaYield,
  castTiming,
  convertedManaCost,
  effectivePower,
  effectiveToughness,
  isCreature,
  isLand,
  MANA_COLORS,
  planManaPayment,
  remainingToughness,
} from '@jonny-boi/core';
import { cardValue, cardValueContext } from './card-value.js';
import { answerChoiceHeuristically, safeFallbackAction } from './choices.js';
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
  /** A symmetric board sweeper (Wrath of God / Day of Judgment). */
  destroyAll: 'destroyAll',
  gainLife: 'gainLife',
  drawCards: 'drawCards',
});

/** What we think a spell *does*, derived from its effect primitives. */
type SpellIntent =
  | { readonly kind: 'damage'; readonly amount: number; readonly canTargetCreature: boolean; readonly canTargetPlayer: boolean }
  | { readonly kind: 'destroyCreature' }
  | { readonly kind: 'shrink'; readonly toughness: number }
  | { readonly kind: 'pump'; readonly power: number; readonly toughness: number }
  | { readonly kind: 'counter' }
  | { readonly kind: 'sweeper' }
  | { readonly kind: 'creature' }
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

function decide(ctx: DecisionContext, weights: HeuristicWeights): GameAction {
  const { view, legalActions } = ctx;
  const me = view.priorityPlayer;

  // A resolving spell is asking somebody a question. That preempts everything —
  // it is the only thing the game will accept — and it is answered on its own
  // terms (pick what is best for the chooser), not by scoring board plays.
  // (The cast strips the view's DeepReadonly wrapper; the answerer only reads.)
  const pending = view.pendingChoice as PendingChoice | null | undefined;
  if (pending) {
    const answer = answerChoiceHeuristically(view as unknown as GameState, pending, weights);
    return emit(ctx, answer, `answering "${pending.prompt}"`);
  }

  // Nothing offered, or only passing is possible → pass.
  if (legalActions.length === 0) return emit(ctx, passAction(view), 'no legal actions — passing');
  const onlyPass = legalActions.every((a) => a.kind === 'passPriority');
  if (onlyPass) return emit(ctx, legalActions[0] as GameAction, 'nothing useful — passing');

  // Combat declarations are their own decision shape.
  if (view.step === 'declareAttackers' && me === view.activePlayer) {
    const attack = chooseAttack(ctx, weights);
    if (attack) return attack;
  }
  if (view.step === 'declareBlockers' && me === defendingPlayer(view)) {
    const block = chooseBlock(ctx, weights);
    if (block) return block;
  }

  // Otherwise: a priority window. Plan the best spell goal and act toward it,
  // or play a land, or pass.
  return choosePriorityAction(ctx, weights);
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
}

function choosePriorityAction(ctx: DecisionContext, weights: HeuristicWeights): GameAction {
  const { view, legalActions } = ctx;

  const canPlayLand = legalActions.some((a) => a.kind === 'playLand');
  const bestSpell = bestSpellGoal(ctx, weights);

  // Lands outrank most spells: developing mana is almost always correct. We play
  // a land unless a spell scores higher than the land (e.g. lethal burn now).
  const landScore = canPlayLand ? weights.playLandScore : -Infinity;
  const spellScore = bestSpell ? bestSpell.goal.score : -Infinity;

  if (landScore >= spellScore && canPlayLand) {
    const landAction = legalActions.find((a) => a.kind === 'playLand');
    if (landAction) return emit(ctx, landAction, 'develop mana — play a land', weights.playLandScore);
  }

  if (bestSpell && bestSpell.goal.score > weights.passScore) {
    return pursueSpell(ctx, bestSpell);
  }

  // Nothing worth doing with our mana → pass.
  return emit(ctx, passAction(view), 'no profitable play — passing', weights.passScore);
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
function bestSpellGoal(ctx: DecisionContext, weights: HeuristicWeights): FundedGoal | undefined {
  const { view } = ctx;
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

  const scored: SpellGoal[] = [];
  for (const card of hand) {
    const def = card.def;
    if (isLand(def)) continue;
    const timingOk = castTiming(def) === 'instant' ? true : sorcerySpeedOpen;
    if (!timingOk) continue;
    const cost = def.cost ?? {};
    // Cheap upper-bound prefilter; `planManaTaps` below is the real test.
    if (convertedManaCost(cost) > availableMana) continue;

    const intent = classifySpell(def);
    const goal = scoreSpell(view, opp, card, intent, weights);
    if (goal) scored.push(goal);
  }

  // Best-first, but only a goal we can genuinely fund. Planning is the expensive
  // step, so it runs on ranked candidates and stops at the first payable one.
  scored.sort((a, b) => b.score - a.score);
  for (const goal of scored) {
    const plan = planManaPayment(view as GameState, me, goal.cost, ctx.legalActions);
    if (plan) return { goal, plan };
  }
  return undefined;
}

/**
 * Score a single spell and choose its targets. Returns the goal with its score, or
 * undefined if the spell isn't worth casting right now (e.g. removal with no valid
 * target). All weights are named config — no magic numbers.
 */
function scoreSpell(
  view: PilotView,
  opp: PlayerId,
  card: CardInstance,
  intent: SpellIntent,
  weights: HeuristicWeights,
): SpellGoal | undefined {
  const cost = card.def.cost ?? {};
  const oppCreatures = creaturesControlledBy(view, opp);

  switch (intent.kind) {
    case 'damage': {
      // Lethal to the face? Take the win.
      if (intent.canTargetPlayer && intent.amount >= view.players[opp].life) {
        return {
          score: weights.lethalBurnScore,
          card,
          cost,
          targets: [opp],
          reason: `burn to face — lethal (${intent.amount} ≥ ${view.players[opp].life})`,
        };
      }
      // Otherwise prefer killing the biggest threat this burn can actually kill.
      const killable = intent.canTargetCreature
        ? oppCreatures.filter((c) => remainingToughness(c) <= intent.amount)
        : [];
      const target = biggestThreat(killable);
      if (target) {
        return {
          score: weights.removalBaseScore + weights.removalPerPowerOfTarget * effectivePower(target),
          card,
          cost,
          targets: [target.instanceId],
          reason: `burn removal — kill ${target.def.name} (${effectivePower(target)}/${effectiveToughness(target)})`,
        };
      }
      // No good creature target → chip the face if we can.
      if (intent.canTargetPlayer) {
        return { score: weights.burnFaceBaseScore, card, cost, targets: [opp], reason: 'burn to face — no better target' };
      }
      return undefined;
    }
    case 'destroyCreature': {
      const target = biggestThreat(oppCreatures);
      if (!target) return undefined; // no target → don't waste removal
      return {
        score: weights.removalBaseScore + weights.removalPerPowerOfTarget * effectivePower(target),
        card,
        cost,
        targets: [target.instanceId],
        reason: `removal — destroy ${target.def.name} (${effectivePower(target)}/${effectiveToughness(target)})`,
      };
    }
    case 'shrink': {
      // Shrink-removal kills exactly what its toughness reduction can finish off,
      // so it is scored and targeted like burn: the biggest thing it can kill.
      const killable = oppCreatures.filter((c) => remainingToughness(c) <= intent.toughness);
      const target = biggestThreat(killable);
      if (!target) return undefined; // it would shrink something that survives — hold it
      return {
        score: weights.removalBaseScore + weights.removalPerPowerOfTarget * effectivePower(target),
        card,
        cost,
        targets: [target.instanceId],
        reason: `removal — shrink ${target.def.name} (-${intent.toughness} toughness)`,
      };
    }
    case 'counter': {
      const target = counterTarget(view, otherPlayer(opp));
      if (!target) return undefined; // nothing on the stack worth answering — hold it
      return {
        score: weights.removalBaseScore + cardValue(target.card, weights, cardValueContext(view as GameState)),
        card,
        cost,
        targets: [target.instanceId],
        reason: `counter ${target.card.def.name}`,
      };
    }
    case 'sweeper': {
      const net = sweeperValue(view, otherPlayer(opp), weights);
      if (net <= 0) return undefined; // our own board would pay for it — hold it
      return { score: net, card, cost, targets: [], reason: `sweep the board (net ${net})` };
    }
    case 'creature': {
      const stat = (card.def.power ?? 0) + (card.def.toughness ?? 0);
      return {
        score: weights.castCreatureBaseScore + weights.castCreaturePerStat * stat,
        card,
        cost,
        targets: [],
        reason: `develop board — cast ${card.def.name}`,
      };
    }
    case 'pump': {
      const play = bestPumpPlay(view, otherPlayer(opp), opp, intent, weights);
      if (!play) return undefined; // no combat use right now — hold the trick
      return { score: play.score, card, cost, targets: [play.target], reason: play.reason };
    }
    case 'other':
      return { score: weights.genericSpellScore, card, cost, targets: [], reason: `cast ${card.def.name}` };
  }
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
function sweeperValue(view: PilotView, me: PlayerId, weights: HeuristicWeights): number {
  let net = 0;
  for (const perm of view.battlefield) {
    if (!isCreature(perm.def)) continue;
    const stats = effectivePower(perm as CardInstance) + effectiveToughness(perm as CardInstance);
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
      for (const [blockerId, blockedId] of Object.entries(combat.blocks)) {
        if (blockedId !== attackerId) continue;
        const blocker = findInstance(view, Number(blockerId) as InstanceId);
        if (blocker) enemies.push(blocker);
      }
      engagements.push({ own, enemies });
    }
  } else {
    for (const [blockerId, attackerId] of Object.entries(combat.blocks)) {
      const own = findInstance(view, Number(blockerId) as InstanceId);
      if (!own || own.controller !== me) continue;
      const attacker = findInstance(view, attackerId);
      engagements.push({ own, enemies: attacker ? [attacker] : [] });
    }
  }
  if (engagements.length === 0) return undefined;

  // Face damage already coming through from our unblocked attackers — the baseline
  // the pump adds to when we're deciding whether it's lethal.
  const unblockedDamage = iAmAttacking
    ? engagements.reduce((sum, e) => (e.enemies.length === 0 ? sum + effectivePower(e.own) : sum), 0)
    : 0;

  let best: PumpPlay | undefined;
  for (const { own, enemies } of engagements) {
    if (enemies.length === 0) {
      // Unblocked attacker: the pump is face damage. Lethal is the whole game.
      if (!iAmAttacking) continue;
      if (unblockedDamage + intent.power >= view.players[opp].life) {
        return {
          target: own.instanceId,
          score: weights.lethalBurnScore,
          reason: `pump ${own.def.name} for lethal (${unblockedDamage} + ${intent.power} ≥ ${view.players[opp].life})`,
        };
      }
      const score = weights.pumpFaceDamagePerPower * intent.power;
      if (score > 0 && (!best || score > best.score)) {
        best = { target: own.instanceId, score, reason: `pump ${own.def.name} — +${intent.power} face damage` };
      }
      continue;
    }

    // In a fight: does the pump flip either outcome?
    const ownToughLeft = remainingToughness(own);
    const ownPower = effectivePower(own);
    const incoming = enemies.reduce((sum, e) => sum + effectivePower(e), 0);

    const diesNow = incoming >= ownToughLeft;
    const survivesWithPump = incoming < ownToughLeft + intent.toughness;
    // The biggest enemy we could newly kill with the power boost.
    let newlyKilled: CardInstance | undefined;
    for (const enemy of enemies) {
      const need = remainingToughness(enemy);
      if (ownPower >= need) continue; // already killing it — the pump adds nothing here
      if (ownPower + intent.power < need) continue; // still can't kill it
      if (!newlyKilled || effectivePower(enemy) > effectivePower(newlyKilled)) newlyKilled = enemy;
    }

    let score = 0;
    const reasons: string[] = [];
    if (diesNow && survivesWithPump) {
      score += weights.pumpSaveCreatureScore + weights.ownCreatureLossPerStat * (ownPower + effectiveToughness(own));
      reasons.push(`saves ${own.def.name} from ${incoming} damage`);
    }
    if (newlyKilled) {
      score +=
        weights.pumpWinFightScore +
        weights.killEnemyPerStat * (effectivePower(newlyKilled) + effectiveToughness(newlyKilled));
      reasons.push(`kills ${newlyKilled.def.name}`);
    }
    if (score > 0 && (!best || score > best.score)) {
      best = { target: own.instanceId, score, reason: `pump ${own.def.name} — ${reasons.join(' + ')}` };
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
    };
    return emit(ctx, cast, goal.reason, goal.score);
  }

  const source = findInstance(view, next.instanceId);
  const tap: GameAction = { kind: 'tapForMana', player: me, instanceId: next.instanceId, mode: next.mode };
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
function chooseAttack(ctx: DecisionContext, weights: HeuristicWeights): GameAction | undefined {
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
    if (attackIsProfitable(attacker, enemyBlockers, weights)) chosen.push(id);
  }

  if (chosen.length === 0) {
    // Nothing profitable to attack with → declare no attackers (pass the step).
    return emit(ctx, passAction(view), 'no profitable attack — holding back', weights.passScore);
  }
  const action: GameAction = { kind: 'declareAttackers', player: me, attackers: chosen };
  return emit(ctx, action, `attack with ${chosen.length} creature(s)`, weights.attackValueThreshold);
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
): boolean {
  const myPower = effectivePower(attacker);
  const myTough = effectiveToughness(attacker);
  if (myPower <= 0) return false; // a 0-power attacker accomplishes nothing

  // The opponent will block if a blocker kills us and the trade favours them.
  // Find the blocker that would profitably kill us; if one exists, weigh the trade.
  let bestEnemyValue = -Infinity; // value to the OPPONENT of their best block
  let blockerExists = false;
  for (const b of enemyBlockers) {
    if (!canBlockByEvasion(attacker, b)) continue;
    blockerExists = true;
    const bPower = effectivePower(b);
    const bTough = effectiveToughness(b);
    const attackerDies = bPower >= myTough;
    const blockerDies = myPower >= bTough;
    // Value to the opponent: they gain by killing our creature, lose by losing theirs.
    const enemyValue =
      (attackerDies ? weights.killEnemyPerStat * (myPower + myTough) : 0) -
      (blockerDies ? weights.ownCreatureLossPerStat * (bPower + bTough) : 0);
    if (enemyValue > bestEnemyValue) bestEnemyValue = enemyValue;
  }

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
function chooseBlock(ctx: DecisionContext, weights: HeuristicWeights): GameAction | undefined {
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
  const incomingDamage = totalIncomingDamage(view, combat.attackers);
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
    .sort((a, b) => effectivePower(b) - effectivePower(a));

  for (const attacker of attackers) {
    const blocker = pickBlocker(attacker, availableBlockers, used, desperate, weights);
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
): CardInstance | undefined {
  const aPower = effectivePower(attacker);
  const aTough = effectiveToughness(attacker);

  let best: CardInstance | undefined;
  let bestValue = -Infinity;
  for (const b of blockers) {
    if (used.has(b.instanceId)) continue;
    if (!canBlockByEvasion(attacker, b)) continue;
    const bPower = effectivePower(b);
    const bTough = effectiveToughness(b);
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

/** Classify a spell's intent from its effect primitives (robust to unknowns). */
function classifySpell(def: CardDefinition): SpellIntent {
  if (isCreature(def)) return { kind: 'creature' };
  const effects = def.effects ?? [];
  for (const ref of effects) {
    if (ref.primitive === PRIMITIVE.dealDamage) {
      const amount = numberParam(ref.params, 'amount', 0);
      // Convention: a damage primitive can target creatures and/or players. Default
      // to both unless params restrict it; robust if params are absent.
      const targets = stringParam(ref.params, 'targets', 'any');
      return {
        kind: 'damage',
        amount,
        canTargetCreature: targets === 'any' || targets === 'creature',
        canTargetPlayer: targets === 'any' || targets === 'player',
      };
    }
    if (ref.primitive === PRIMITIVE.destroyTarget || ref.primitive === PRIMITIVE.exileTarget) {
      return { kind: 'destroyCreature' };
    }
    if (ref.primitive === PRIMITIVE.counterSpell) return { kind: 'counter' };
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

/**
 * Total mana a player could produce this turn: current pool + untapped sources.
 *
 * A source contributes the value of its BEST single mode, because tapping it
 * activates exactly one — a five-color source is worth one mana, not five. (Reading
 * the mode count as an amount is what convinced the old pilot it could afford
 * spells it could not, so it tapped toward them and stranded the mana.)
 *
 * This is a cheap upper bound used only to skip obviously-unaffordable spells;
 * `planManaTaps` is the authority on whether a cost can actually be paid.
 */
function totalAvailableMana(view: PilotView, player: PlayerId): number {
  let total = 0;
  const pool = view.players[player].manaPool;
  for (const color of MANA_COLORS) total += pool[color];
  for (const perm of view.battlefield) {
    if (perm.controller !== player || perm.tapped) continue;
    total += bestManaYield(perm.def);
  }
  return total;
}



/** Creatures a player controls on the battlefield. */
function creaturesControlledBy(view: PilotView, player: PlayerId): CardInstance[] {
  return view.battlefield.filter((c) => c.controller === player && isCreature(c.def)) as CardInstance[];
}

/** The biggest threat among creatures: highest power, then toughness. */
function biggestThreat(creatures: readonly CardInstance[]): CardInstance | undefined {
  let best: CardInstance | undefined;
  for (const c of creatures) {
    if (!best) {
      best = c;
      continue;
    }
    const cp = effectivePower(c);
    const bp = effectivePower(best);
    if (cp > bp || (cp === bp && effectiveToughness(c) > effectiveToughness(best))) best = c;
  }
  return best;
}

/** Total unblocked-if-unblocked damage the listed attackers represent. */
function totalIncomingDamage(view: PilotView, attackerIds: readonly InstanceId[]): number {
  let total = 0;
  for (const id of attackerIds) {
    const a = findInstance(view, id);
    if (a) total += effectivePower(a);
  }
  return total;
}

/**
 * Whether `blocker` could legally block `attacker` by evasion (flying needs
 * flying/reach). Mirrors core's combat rule so the pilot only proposes legal
 * blocks. (Tapped-ness is filtered by callers.)
 */
function canBlockByEvasion(attacker: CardInstance, blocker: CardInstance): boolean {
  const ak = attacker.def.keywords ?? {};
  const bk = blocker.def.keywords ?? {};
  if (ak.flying && !(bk.flying || bk.reach)) return false;
  return true;
}

function findInstance(view: PilotView, id: InstanceId): CardInstance | undefined {
  return view.battlefield.find((c) => c.instanceId === id) as CardInstance | undefined;
}

// --- small utilities -----------------------------------------------------------

function otherPlayer(p: PlayerId): PlayerId {
  return p === 'A' ? 'B' : 'A';
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

/** Emit an optional trace and return the action (keeps decision sites terse). */
function emit(ctx: DecisionContext, action: GameAction, reason: string, score?: number): GameAction {
  const trace: DecisionTrace = score === undefined ? { action, reason } : { action, reason, score };
  ctx.trace?.(trace);
  return action;
}

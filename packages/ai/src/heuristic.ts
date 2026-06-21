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
  PlayerId,
} from '@jonny-boi/core';
import {
  canPay,
  castTiming,
  convertedManaCost,
  effectivePower,
  effectiveToughness,
  isCreature,
  isLand,
  remainingToughness,
} from '@jonny-boi/core';
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
  destroy: 'destroy',
  gainLife: 'gainLife',
  drawCards: 'drawCards',
});

/** What we think a spell *does*, derived from its effect primitives. */
type SpellIntent =
  | { readonly kind: 'damage'; readonly amount: number; readonly canTargetCreature: boolean; readonly canTargetPlayer: boolean }
  | { readonly kind: 'destroyCreature' }
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
        // Robustness: never throw on a weird state. Fall back to passing.
        return passAction(ctx.view);
      }
    },
  };
}

// --- top-level decision --------------------------------------------------------

function decide(ctx: DecisionContext, weights: HeuristicWeights): GameAction {
  const { view, legalActions } = ctx;
  const me = view.priorityPlayer;

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
  const spellScore = bestSpell ? bestSpell.score : -Infinity;

  if (landScore >= spellScore && canPlayLand) {
    const landAction = legalActions.find((a) => a.kind === 'playLand');
    if (landAction) return emit(ctx, landAction, 'develop mana — play a land', weights.playLandScore);
  }

  if (bestSpell && bestSpell.score > weights.passScore) {
    return pursueSpell(ctx, bestSpell);
  }

  // Nothing worth doing with our mana → pass.
  return emit(ctx, passAction(view), 'no profitable play — passing', weights.passScore);
}

/**
 * Find the highest-scoring spell the pilot can *afford this turn* (using its
 * current pool plus all untapped mana sources), with targets chosen. Returns
 * undefined if no spell is worth casting.
 */
function bestSpellGoal(ctx: DecisionContext, weights: HeuristicWeights): SpellGoal | undefined {
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

  let best: SpellGoal | undefined;
  for (const card of hand) {
    const def = card.def;
    if (isLand(def)) continue;
    const timingOk = castTiming(def) === 'instant' ? true : sorcerySpeedOpen;
    if (!timingOk) continue;
    const cost = def.cost ?? {};
    // Affordable this turn if we could tap enough to pay it.
    if (convertedManaCost(cost) > availableMana) continue;

    const intent = classifySpell(def);
    const scored = scoreSpell(view, opp, card, intent, weights);
    if (!scored) continue;
    if (!best || scored.score > best.score) best = scored;
  }
  return best;
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
    case 'other':
      return { score: weights.genericSpellScore, card, cost, targets: [], reason: `cast ${card.def.name}` };
  }
}

/**
 * Emit the next micro-action toward casting `goal`: if we can already pay, cast it
 * (with targets); otherwise tap an untapped mana source to build toward the cost.
 */
function pursueSpell(ctx: DecisionContext, goal: SpellGoal): GameAction {
  const { view } = ctx;
  const me = view.priorityPlayer;
  const pool = view.players[me].manaPool;

  if (canPay(pool, goal.cost)) {
    const cast: GameAction = {
      kind: 'castSpell',
      player: me,
      instanceId: goal.card.instanceId,
      targets: goal.targets.length > 0 ? goal.targets : undefined,
    };
    return emit(ctx, cast, goal.reason, goal.score);
  }

  // Need more mana: tap an untapped source we control.
  const source = view.battlefield.find(
    (perm) => perm.controller === me && !perm.tapped && (perm.def.produces?.length ?? 0) > 0,
  );
  if (source) {
    const tap: GameAction = { kind: 'tapForMana', player: me, instanceId: source.instanceId };
    return emit(ctx, tap, `tap for mana → ${goal.reason}`, goal.score);
  }

  // Couldn't fund it after all → pass rather than spin.
  return emit(ctx, passAction(view), 'cannot fund desired spell — passing');
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
    if (ref.primitive === PRIMITIVE.destroy) {
      return { kind: 'destroyCreature' };
    }
  }
  return { kind: 'other' };
}

// --- evaluation helpers --------------------------------------------------------

/** Total mana a player could produce this turn: current pool + untapped sources. */
function totalAvailableMana(view: PilotView, player: PlayerId): number {
  let total = 0;
  const pool = view.players[player].manaPool;
  for (const color of ['W', 'U', 'B', 'R', 'G', 'C'] as const) total += pool[color];
  for (const perm of view.battlefield) {
    if (perm.controller === player && !perm.tapped) total += perm.def.produces?.length ?? 0;
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

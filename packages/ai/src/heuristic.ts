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
  RulesConfig,
} from '@jonny-boi/core';
import {
  backFaceCastZonesOf,
  castPermissionFor,
  castTiming,
  convertedManaCost,
  minimumManaValue,
  phyrexianLifeOptions,
  DEFAULT_RULES,
  delayedRemovalTargets,
  landPlayZonesFor,
  maxLandPlaysFor,
  forcedBlockAssignment,
  hasCardGrants,
  hasCastableBackFace,
  playableFaceOf,
  isCreature,
  isLand,
  // §3.112 — the cast-alternative family.
  ALTERNATIVE_COSTS,
  alternativeCostKindsOf,
  definitionCastAs,
  turnFactHolds,
  FORETELL_COST,
  isLegalTarget,
  isBattle,
  isPlaneswalker,
  protectorOf,
  legalTargetsFor,
  defenseOf,
  loyaltyOf,
  MANA_COLORS,
  manaExtrasOf,
  manaModesOf,
  poolTotal,
  planManaPayment,
  tapActionFor,
  restrictionOfEffects,
  sorcerySpeedWindowFor,
  modalSpecOf,
  modeCountsFor,
  targetRestrictionOf,
  unpayableAdditionalCostReason,
  DEFAULT_TRIGGER_WATCHES,
  // §3.113 — the spell-count family: pricing storm/cascade, and the free windows.
  castTriggerCount,
  isFreeCastWindow,
  spellsCastThisTurn,
} from '@jonny-boi/core';
import type { TargetRestriction, TargetSpec, TriggeredAbility } from '@jonny-boi/core';
// §3.111 — the graveyard-casting family: every way a card in the graveyard can
// be cast (flashback and its siblings, through ONE accessor) and the abilities
// that activate from there.
import {
  additionalCostPool,
  canPayAdditionalCost,
  graveyardCastOptionsOf,
  matchesCardFilter,
  type AdditionalCastCost,
  type GraveyardAbility,
  type GraveyardCastKind,
} from '@jonny-boi/core';
/*
 * THE COMBAT KEYWORD FAMILY (DESIGN §3.107), and the block-legality rules ASKED
 * OF CORE rather than mirrored here. This file used to carry its own copy of CR
 * 509.1a/b, and every time it did the copy was core's minus a clause — first
 * protection, then landwalk, then "except by N or more creatures". Each cost
 * the defender an entire declaration, because one illegal pair rejects all of
 * it. `canBlock` (the pair), `blockerCountAllowed` (the count, from both sides)
 * and `illegalBlockDeclaration` (the finished declaration, restrictions and CR
 * 509.1c/d requirements together) are the engine's OWN answers.
 */
import {
  blockerCountAllowed,
  canBlock,
  illegalBlockDeclaration,
  requiredBlockerCount,
  splitSecondOnStack,
} from '@jonny-boi/core';
import { boardOf, withRequiredAttackers } from './attack-requirements.js';
import { cardValue, cardValueContext } from './card-value.js';
import type { ContinuousIndex } from './board-stats.js';
import { boardIndex, keywordsOf, power, statTotal, toughness, toughnessLeft } from './board-stats.js';
import { resolveFight } from './combat-math.js';
import { resolutionValueContext, valueOfEffects, valueOfMode } from './effect-value.js';
import { answerChoiceHeuristically, safeFallbackAction } from './choices.js';
import { bestLandDrop, describeLandDrop, rankLandDrops, totalAvailableMana } from './land-sequencing.js';
import { manaPreferenceOf } from './mana-preference.js';
// §3.141 — the ability that gives back exactly what it takes. ONE predicate, read
// by every scorer that can choose an activation, so a mana ability the pilot must
// not repeat cannot be refused on one path and taken on another.
import { manaExchangeIsNoOp, manaExchangeIsNoOpOnceFunded } from './mana-exchange.js';
import { activationCostValue } from './activation-cost.js';
import type { DecisionContext, DecisionTrace, Pilot, PilotView } from './pilot.js';
import type { HeuristicWeights } from './weights.js';
// poison family (§3.105): the two lethal clocks, kept apart.
import { attackPressure, attackerPressure, faceThreat, lifeEquivalent, poisonRemaining, pressureIsLethal } from './poison-pressure.js';
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
  /**
   * COPY TARGET INSTANT OR SORCERY SPELL (CR 707.10). Played on the same clock
   * as a counterspell and for the opposite reason: both are only castable with a
   * spell on the stack, so both must be HELD UP rather than fired in a main
   * phase. Missing from this list, a Reverberate classified as a "generic
   * spell", and a generic spell is offered only with an EMPTY stack — so the
   * pilot could never cast it at all, and the full-pool soak reported the whole
   * mechanic INERT. That is what caught it.
   */
  copySpell: 'copySpell',
  /**
   * BLINK — exile a permanent you control and return it (CR 400.7). Recognised
   * for the same reason `copySpell` is: unlisted it classifies as a "generic
   * spell", and the full-pool measurement showed the consequence exactly —
   * Conjurer's Closet (a `you may` TRIGGER the pilot accepts) blinked 94 times
   * across 20 games while Cloudshift, the one-mana instant doing the same
   * thing, was cast ZERO times. A mechanic half-played is worse than one that
   * is absent, because the deck looks functional while its best card rots.
   */
  blinkTarget: 'blinkTarget',
  /** A symmetric board sweeper (Wrath of God / Day of Judgment). */
  destroyAll: 'destroyAll',
  gainLife: 'gainLife',
  drawCards: 'drawCards',
  /** Library search. Recognised so a fetchland's ability can be identified. */
  searchLibrary: 'searchLibrary',
  /**
   * THE FOG — "prevent all combat damage that would be dealt this turn". Missing
   * from this list it would classify as a "generic spell", and a generic spell is
   * cast in a main phase for a flat score, which is the one moment a fog is worth
   * exactly nothing. It has to be recognised to be held, and held to be worth
   * anything at all.
   */
  preventDamage: 'preventDamage',
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
  /**
   * "Copy target instant or sorcery spell" — a counterspell's timing with the
   * opposite sign. It answers the TOP of the stack like a counter does, but it
   * wants that spell to be GOOD (its own, usually) rather than an opposing
   * threat, and it is worth exactly what the spell it copies is worth.
   */
  | { readonly kind: 'copySpell' }
  /**
   * "Exile target creature you control, then return it" — worth whatever
   * re-running that creature's enters-the-battlefield trigger is worth, which
   * is why it is its own goal rather than a generic spell: the value is
   * entirely in the TARGET, and a pilot that picked the wrong creature would
   * spend a card blinking a vanilla body.
   */
  | { readonly kind: 'blink' }
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
  /**
   * A FOG — a one-shot prevention effect (core's CR 615 layer). Its value is not
   * a property of the card at all: it is exactly the damage it stops, which is
   * zero in a main phase and the whole game in front of a lethal attack. So the
   * intent carries only what the printed line RESTRICTS, and the scorer asks the
   * board what that is worth right now.
   */
  | { readonly kind: 'fog'; readonly combatOnly: boolean; readonly protectsMeOnly: boolean }
  | { readonly kind: 'other' };

/**
 * Behaviour switches for the heuristic — the A/B seam.
 *
 * ⚠️ THESE EXIST TO BE MEASURED, NOT TO BE CONFIGURED. Comparing two BUILDS of
 * one pilot is impossible in a single process (both cannot hold the same id), and
 * the only exact method is to run two ids head-to-head — so a behaviour under
 * evaluation gets a flag and is measured with `bench/feature-ab.mjs --feature
 * <name>`. A flag that WINS keeps its seam so the claim stays re-checkable when
 * the pilot changes; a flag that LOSES is deleted with the behaviour behind it
 * (see §3.75, where holding attackers back measured 18 slots ahead against 39
 * behind and went). What must never happen is a flag that outlives its
 * measurement: that is a fork of the pilot nobody is testing.
 */
export interface HeuristicFeatures {
  /**
   * Swing with everything when no blocking assignment can survive it — see
   * `lethalAlphaStrike`. Default ON; measured stronger, DESIGN §3.74.
   */
  readonly alphaStrike?: boolean;
  /**
   * Score whole ATTACK SETS against the defence's best answer, instead of judging
   * each attacker as if every blocker were free to meet it. DESIGN §3.83.
   */
  readonly setAttack?: boolean;
  /**
   * Put TWO blockers in front of an attacker that neither could profitably
   * block alone — when together they kill it and the trade comes out ahead —
   * and block a MENACE attacker at all, which a one-blocker-per-attacker rule
   * never can. DESIGN §3.108.
   */
  readonly gangBlock?: boolean;
}

/** Every switch resolved to a value — what `decide` and its callees read. */
interface ResolvedFeatures {
  readonly alphaStrike: boolean;
  readonly setAttack: boolean;
  readonly gangBlock: boolean;
}

/** Is set-level attack scoring on by default? See DESIGN §3.83 for the A/B. */
const SET_ATTACK_DEFAULT = true;
/**
 * Defaults for the §3.108 features — each set by its A/B verdict, recorded there.
 * Gang blocks ship ON: CONFIRMED STRONGER on both pilots, held-out 85/50 for
 * this one and 110/45 for `lookahead`, which delegates its blocks here.
 */
const GANG_BLOCK_DEFAULT = true;

/** The switches as `decide` reads them, defaults filled in. */
export function resolveFeatures(features: HeuristicFeatures): ResolvedFeatures {
  return {
    alphaStrike: features.alphaStrike ?? true,
    setAttack: features.setAttack ?? SET_ATTACK_DEFAULT,
    gangBlock: features.gangBlock ?? GANG_BLOCK_DEFAULT,
  };
}

/** Build the heuristic pilot with the given (tunable) weights. */
export function createHeuristicPilot(
  weights: HeuristicWeights = DEFAULT_HEURISTIC_WEIGHTS,
  features: HeuristicFeatures = {},
): Pilot {
  const resolved = resolveFeatures(features);
  return {
    id: HEURISTIC_PILOT_ID,
    description: 'Plays sensibly: develops mana, removes threats, develops the board, attacks/blocks for value.',
    chooseAction(ctx: DecisionContext): GameAction {
      try {
        return decide(ctx, weights, resolved);
      } catch {
        // Robustness: never throw on a weird state. Fall back to the one move the
        // engine is guaranteed to accept — which is NOT always passing: while a
        // choice is parked, passing is rejected and only an answer moves the game.
        return safeFallbackAction(ctx.view as unknown as GameState);
      }
    },
    willPassPriority(view: GameState, rulesConfig?: RulesConfig): boolean {
      return heuristicWillPass(view, rulesConfig ?? DEFAULT_RULES);
    },
    chooseActions(ctx: DecisionContext): readonly GameAction[] {
      // The SAME decision as `chooseAction`, plus whatever continuation the
      // pursuit of a funded goal wrote into the sink on the way — see
      // `pursueSpell`. The sink is module-level scratch rather than a return
      // value so `decide` and everything under it keep their shapes (and their
      // allocation profile) for the callers that only want one action.
      const plan: GameAction[] = [];
      planSink = plan;
      try {
        plan.unshift(decide(ctx, weights, resolved));
      } catch {
        plan.length = 0;
        plan.push(safeFallbackAction(ctx.view as unknown as GameState));
      } finally {
        planSink = null;
      }
      return plan;
    },
  };
}

/**
 * Where the pursuit of a goal writes the actions it would take NEXT — the plan
 * seam's continuation (`Pilot.chooseActions`). `null` for every caller that
 * asked for one action, so the ordinary path allocates nothing for it.
 */
let planSink: GameAction[] | null = null;

/**
 * Windows in which this pilot provably cannot do anything but pass — decided
 * from the state alone, without building the legal menu.
 *
 * ⚠️ EVERY LINE IS A "RETURN FALSE WHEN UNSURE". The seam's contract (see
 * `Pilot.willPassPriority`) is one-sided: a wrong `true` takes the pass without
 * anybody checking, so this only ever answers `true` when the alternative is
 * impossible, never when it merely looks unlikely.
 *
 * Worth having because of what a game actually looks like: 592 decision windows,
 * of which this pilot passes 81.7% (`bench/window-stats.mjs`). Every one of
 * those built a full menu — dominated by mana taps, 73% of all offers ever
 * enumerated — scored it, and threw it away.
 */
function heuristicWillPass(view: GameState, rules: RulesConfig): boolean {
  // A parked question is not a priority window at all: passing is REJECTED while
  // one stands, and only an answer moves the game.
  if (view.pendingChoice) return false;
  // A madness window is answered by its controller (`decideMadness`), and the
  // answer is a cast whenever the cost can be paid — never a promised pass.
  if (view.madnessWindow) return false;
  const me = view.priorityPlayer;
  const combat = view.combat;
  /*
   * A COMBAT DECLARATION THIS SEAT HAS NOT YET MADE is a real decision — the
   * attack or the block — and is never judged here. But the same step names
   * TWO windows: the declaration, and the ordinary priority round that follows
   * it (the engine flips `attackersDeclared` / `blockersDeclared` the moment the
   * declaration is applied, and offers the composite action only while the
   * flag is down). The old gate refused the whole step for both seats, which
   * was 15% of all windows refused for a decision that had already been made
   * — see DESIGN §3.108. Everything below the two checks is the priority
   * reasoning the pilot itself runs in those windows (`choosePriorityAction`).
   *
   * The defender's undeclared window is handed over only when this seat has no
   * untapped creature: `chooseBlock` then has nothing to assign, builds no
   * declaration, and falls through to exactly the priority reasoning below.
   * (§3.79's "no creature ⇒ nothing to declare" pre-check measured that window
   * as UNSAFE because the engine still OFFERS the empty declaration — but the
   * promise is about what THIS PILOT does with the menu, and it never picks
   * that offer. What it can still do there is cast a fog, which the mana and
   * intent reasoning below sees.)
   */
  const attackPending = view.step === 'declareAttackers' && me === view.activePlayer;
  if (attackPending && combat?.attackersDeclared !== true) return false;
  const blockPending =
    view.step === 'declareBlockers' && me !== view.activePlayer && combat?.blockersDeclared !== true;
  // A card grant can make a graveyard card castable in ways not visible on the
  // card itself (Snapcaster's granted flashback). Rare, and not worth reasoning
  // about cheaply — if any grant is live, ask properly.
  if ((view.cardGrants?.length ?? 0) > 0) return false;

  // Is this the seat's own SORCERY window? It decides which cards are playable
  // at all, and whether a land drop is on offer.
  const sorceryOpen =
    me === view.activePlayer &&
    (view.step === 'precombatMain' || view.step === 'postcombatMain') &&
    view.stack.length === 0;

  // ⚠️ THE MANA BOUND IS AN UPPER BOUND ON PURPOSE. Counting untapped sources
  // over-estimates what is really available (a source may be colour-wrong, or
  // carry a restriction), and over-estimating is the SAFE direction: it can only
  // ever make this function answer `false` and build the menu that would have
  // been built anyway. Under-estimating would skip a window where the pilot could
  // really have acted, which is the one thing this must never do.
  //
  // The battlefield is walked FIRST because the intent reasoning over the hand
  // needs three facts from it: whether the opponent has a creature or a walker
  // (removal with nothing to aim at is held, never cast), and whether this seat
  // has an untapped creature (the block-window rule above).
  //
  // ⚠️ EVERY PER-CARD FACT IS READ THROUGH `gateFactsOf`, ONE MEMO LOOKUP PER
  // CARD. This function runs on every window of every game — the match-loop
  // profile put it at 14% of the whole run when each card cost five accessor
  // calls (`hasType` walking a type list, `manaModesOf`, `castTiming`,
  // `convertedManaCost`, the intent memo) — and a definition's answers never
  // change, so they are computed once per printed card and read back as flags.
  let available = poolTotal(view.players[me]?.manaPool);
  let myUntappedCreature = false;
  let theirCreature = false;
  let theirWalker = false;
  const battlefield = view.battlefield;
  for (let i = 0; i < battlefield.length; i++) {
    const permanent = battlefield[i] as CardInstance;
    const facts = gateFactsOf(permanent.def);
    if (permanent.controller !== me) {
      if (facts.creature) theirCreature = true;
      else if (facts.walker) theirWalker = true;
      continue;
    }
    // A non-mana activated ability is a play in its own right, at any speed.
    if (facts.activated) return false;
    if (permanent.tapped) continue;
    if (facts.creature) myUntappedCreature = true;
    if (facts.manaSource) available += 1;
  }
  if (blockPending && myUntappedCreature) return false;
  // A land drop is played for no mana, so nothing about the mana bound can rule
  // it out: it is refused outright whenever one is on offer. The engine's own
  // count of drops (an Exploration widens it) and its own list of extra zones
  // (a Crucible plays them from the graveyard) are read rather than assumed —
  // "one drop, from the hand" is the common case, not the rule.
  const landDropOpen =
    sorceryOpen && (view.players[me]?.landsPlayedThisTurn ?? 0) < maxLandPlaysFor(view, me, rules);
  if (landDropOpen && landPlayZonesFor(view, me).length > 0) return false;

  // Everything below asks ONE question in two halves: what is the cheapest thing
  // this seat could play in THIS window, and could it possibly pay for it?
  const stackHasSpell = view.stack.length > 0;
  const combatLive = combat !== null && combat !== undefined && combat.attackers.length > 0;
  /** Could `scoreSpell` make a goal of a card with these facts, on this board? */
  const couldBeAGoal = (facts: GateFacts): boolean =>
    facts.goalAlways ||
    (stackHasSpell && facts.goalOnStack) ||
    (combatLive && facts.goalInCombat) ||
    (theirCreature && facts.goalWithTheirCreature) ||
    (theirWalker && facts.goalWithTheirWalker);
  let cheapestPlay = Infinity;
  const hand = view.players[me]?.hand ?? [];
  for (let i = 0; i < hand.length; i++) {
    const facts = gateFactsOf((hand[i] as CardInstance).def);
    // CYCLING (and its typed variants) is an activated ability of a card in
    // HAND, usable at instant speed. Cheap to spot and easy to forget.
    if (facts.cycling) return false;
    // A LAND is not cast — it is played, for no mana, and only in a sorcery
    // window with a drop left. Nothing about the mana bound can rule it out.
    if (facts.land) {
      if (landDropOpen) return false;
      continue;
    }
    // A two-halved card prints its own timing and cost per half; the scorer
    // splits it (`castableHalvesInHand`) and this gate does not — so it is
    // never ruled out from the combined face alone.
    if (facts.twoFaced) return false;
    if (!sorceryOpen && !facts.instant) continue;
    if (!couldBeAGoal(facts)) continue;
    if (facts.cmc < cheapestPlay) cheapestPlay = facts.cmc;
  }
  // The graveyard is castable-from via flashback (which keeps the card's own
  // timing — a sorcery with flashback is sorcery-speed, so off-turn it cannot be
  // played whatever its cost) and via an AFTERMATH half printed "cast only from
  // your graveyard", which carries its own timing and cost.
  const graveyard = view.players[me]?.graveyard ?? [];
  for (let i = 0; i < graveyard.length; i++) {
    const facts = gateFactsOf((graveyard[i] as CardInstance).def);
    if (facts.graveHalfCmc >= 0 && (sorceryOpen || facts.graveHalfInstant) && facts.graveHalfCmc < cheapestPlay) {
      cheapestPlay = facts.graveHalfCmc;
    }
    // §3.111 — a graveyard ABILITY (unearth, scavenge, …) is a play at its own
    // timing whatever the scorer thinks of the card as a spell, so it bounds
    // the window on its own; a retrace/jump-start/escape cast is a spell goal
    // like flashback and shares its gate below.
    if (facts.graveyardAbilityCmc >= 0 && (sorceryOpen || facts.graveyardAbilityInstant)) {
      if (facts.graveyardAbilityCmc < cheapestPlay) cheapestPlay = facts.graveyardAbilityCmc;
    }
    if (facts.flashbackCmc < 0) continue;
    if (!sorceryOpen && !facts.instant) continue;
    if (!couldBeAGoal(facts)) continue;
    if (facts.flashbackCmc < cheapestPlay) cheapestPlay = facts.flashbackCmc;
  }
  return available < cheapestPlay;
}

/**
 * Everything the fast-pass gate asks about a printed card, computed once per
 * definition. The `goal*` flags are the conditions under which `scoreSpell`
 * could make a goal of the card — see {@link goalFlagsOf}.
 */
interface GateFacts {
  readonly land: boolean;
  readonly creature: boolean;
  readonly walker: boolean;
  readonly cycling: boolean;
  readonly twoFaced: boolean;
  /** Prints an activated ability — a play in its own right, at any speed. */
  readonly activated: boolean;
  /** Taps for mana (an UPPER-bound read: any production at all counts). */
  readonly manaSource: boolean;
  /** Castable at instant speed (printed timing, or flash). */
  readonly instant: boolean;
  readonly cmc: number;
  /** Flashback cost's mana value, or -1 when the card prints no flashback. */
  readonly flashbackCmc: number;
  /** An aftermath half castable from the graveyard: its mana value, or -1. */
  readonly graveHalfCmc: number;
  readonly graveHalfInstant: boolean;
  /**
   * §3.111 — the cheapest graveyard ABILITY the card prints (unearth, scavenge,
   * embalm, eternalize, encore, a self-return): its mana value, or -1. A play
   * in its own right, at the ability's own timing.
   */
  readonly graveyardAbilityCmc: number;
  /** Whether any of those abilities is activatable at instant speed. */
  readonly graveyardAbilityInstant: boolean;
  readonly goalAlways: boolean;
  readonly goalOnStack: boolean;
  readonly goalInCombat: boolean;
  readonly goalWithTheirCreature: boolean;
  readonly goalWithTheirWalker: boolean;
}

const GATE_FACTS_MEMO = new WeakMap<CardDefinition, GateFacts>();

/**
 * §3.111 — the cheapest mana value at which this card could be cast from the
 * graveyard by any printed keyword (flashback, retrace, jump-start, escape),
 * or -1 when it prints none. An UPPER bound on what the window could need, as
 * every gate fact is: a granted flashback (Snapcaster) is not a printed fact
 * and is handled by the grant check above the gate.
 */
function cheapestGraveyardCastCmc(def: CardDefinition): number {
  let cheapest = def.flashback === undefined ? -1 : convertedManaCost(def.flashback);
  const casts = def.graveyardCasts;
  if (casts !== undefined) {
    for (const cast of casts) {
      const cmc = convertedManaCost(cast.cost ?? def.cost ?? {});
      if (cheapest < 0 || cmc < cheapest) cheapest = cmc;
    }
  }
  return cheapest;
}

/** §3.111 — the cheapest graveyard ability's mana value, or -1 when the card prints none. */
function cheapestGraveyardAbilityCmc(def: CardDefinition): number {
  const abilities = def.graveyardAbilities;
  if (abilities === undefined || abilities.length === 0) return -1;
  let cheapest = -1;
  for (const ability of abilities) {
    const cmc = convertedManaCost(ability.cost.mana ?? {});
    if (cheapest < 0 || cmc < cheapest) cheapest = cmc;
  }
  return cheapest;
}

function gateFactsOf(def: CardDefinition): GateFacts {
  const memo = GATE_FACTS_MEMO.get(def);
  if (memo !== undefined) return memo;
  const graveHalf =
    hasCastableBackFace(def) && backFaceCastZonesOf(def).includes('graveyard')
      ? (def.backFace as CardDefinition)
      : undefined;
  const facts: GateFacts = {
    land: isLand(def),
    creature: isCreature(def),
    walker: isPlaneswalker(def),
    cycling: (def.cycling?.length ?? 0) > 0,
    twoFaced: def.frontFace !== undefined || def.backFace !== undefined,
    activated: (def.activated?.length ?? 0) > 0,
    manaSource: manaModesOf(def).length > 0,
    instant: castTiming(def) === 'instant',
    cmc: convertedManaCost(def.cost ?? {}),
    // §3.111 — the cheapest of the card's graveyard casts is the flashback-shaped
    // bound (retrace and jump-start pay the printed cost; escape its own), and
    // the graveyard abilities bound the window on their own.
    flashbackCmc: cheapestGraveyardCastCmc(def),
    graveHalfCmc: graveHalf === undefined ? -1 : convertedManaCost(graveHalf.cost ?? {}),
    graveHalfInstant: graveHalf !== undefined && castTiming(graveHalf) === 'instant',
    graveyardAbilityCmc: cheapestGraveyardAbilityCmc(def),
    graveyardAbilityInstant: (def.graveyardAbilities ?? []).some((ability) => (ability.timing ?? 'instant') === 'instant'),
    ...goalFlagsOf(def),
  };
  GATE_FACTS_MEMO.set(def, facts);
  return facts;
}

/**
 * Under which board conditions could `scoreSpell` make a goal of this card?
 *
 * ⚠️ A SUPERSET OF THE SCORER'S "YES", NEVER A SUBSET. Each branch names the ONE
 * condition under which the scorer returns `undefined` unconditionally — a
 * counter with an empty stack (`counterTarget`), a trick with no combat
 * (`bestPumpPlay`), a fog before attackers are declared (`fogValue`), removal
 * with no creature to aim at — and `goalAlways` for everything else, including
 * every intent whose "hold it" depends on values this gate does not compute.
 * Ruling a card out where the scorer would have cast it is the one lie the
 * fast-pass contract forbids, so when in doubt the answer is "always".
 */
function goalFlagsOf(
  def: CardDefinition,
): Pick<GateFacts, 'goalAlways' | 'goalOnStack' | 'goalInCombat' | 'goalWithTheirCreature' | 'goalWithTheirWalker'> {
  const intent = classifySpell(def);
  const flags = {
    goalAlways: false,
    goalOnStack: false,
    goalInCombat: false,
    goalWithTheirCreature: false,
    goalWithTheirWalker: false,
  };
  switch (intent.kind) {
    case 'counter':
    case 'copySpell':
      flags.goalOnStack = true;
      break;
    case 'pump':
    case 'fog':
      flags.goalInCombat = true;
      break;
    case 'destroyCreature':
    case 'shrink':
      flags.goalWithTheirCreature = true;
      break;
    case 'damage':
      flags.goalAlways = intent.canTargetPlayer;
      flags.goalWithTheirCreature = intent.canTargetCreature;
      flags.goalWithTheirWalker = intent.canTargetWalker;
      break;
    default:
      flags.goalAlways = true;
  }
  return flags;
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

function decide(ctx: DecisionContext, weights: HeuristicWeights, features: ResolvedFeatures): GameAction {
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
    const attack = chooseAttack(ctx, weights, index, features);
    if (attack) return attack;
  }
  if (view.step === 'declareBlockers' && me === defendingPlayer(view)) {
    const block = chooseBlock(ctx, weights, index, features);
    if (block) return block;
  }

  /*
   * SPLIT SECOND (CR 702.61, DESIGN §3.107) — ASKED OF CORE, at the one seam
   * every play below has to pass through.
   *
   * While such a spell is on the stack nobody may cast a spell, cycle a card or
   * activate a non-mana ability, and `generateLegalActions` withdraws exactly
   * those offers. The priority reasoning below does NOT read the offered menu to
   * decide what to play: it scores the hand itself and CONSTRUCTS the cast
   * (`castActionFor`), so it happily proposed one under the lock — an action the
   * menu never contained and the apply path refuses. Both halves of the soak
   * saw it at once (`legalActionsOnly` and `noRejectedActions`, seed 3736754678
   * turn 27: B tapped two lands under its own Siege Smash and then cast into it).
   *
   * The cause is the same one as the block mirrors: `scoredSpellGoals` derives
   * castability from its own timing rule ("mirrors core's timing gate") instead
   * of asking. So the lock is asked of core here, once, rather than threaded as
   * a fourth condition through every scorer that might build a play.
   *
   * Passing is the whole answer: mana abilities are still legal but buy nothing
   * (no cast can follow), and the combat declarations — which core still offers
   * under the lock — are decided ABOVE this line, so they are unaffected.
   */
  if (splitSecondOnStack(view as GameState)) {
    return emit(ctx, passAction(view), explain ? 'split second is on the stack — nothing can be played' : NO_REASON);
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
  // §3.113 — a FREE window (suspend, cascade, ripple) lists one cast per legal
  // target. Aim it the way a hand cast is aimed — the spell scorer's target,
  // filtered by `withLegalTargets` — rather than taking the first the engine
  // listed, which for a cascaded Bituminous Blast is as likely to be our own
  // creature as theirs. Falls through to the plain "cast it" below when the
  // scorer has no opinion, so a free spell is never declined for want of one.
  const freeWindow = view.madnessWindow;
  if (freeWindow && isFreeCastWindow(freeWindow)) {
    const casts = legalActions.filter(
      (a): a is Extract<GameAction, { kind: 'castSpell' }> => a.kind === 'castSpell' && a.fromZone === 'exile',
    );
    const exiled = view.players[me].exile.find((c) => c.instanceId === freeWindow.instanceId);
    if (casts.length > 0 && exiled) {
      const opp: PlayerId = me === 'A' ? 'B' : 'A';
      const index = boardIndex(view);
      const goal = scoreSpell(
        view,
        opp,
        creaturesControlledBy(view, opp),
        exiled,
        classifySpell(exiled.def),
        weights,
        false,
        index,
      );
      const legal = goal ? withLegalTargets(view, opp, goal, index, weights) : undefined;
      if (legal && legal.targets.length > 0) {
        // Two offer shapes, one answer. A spell with a NARROWER restriction is
        // offered once per legal target, so the scored aim is picked out of the
        // menu; a spell whose restriction is the unpoliced default ("any
        // target" — Bituminous Blast, the commonest thing to cascade into) is
        // offered ONCE with no targets, exactly as the hand path offers it, and
        // the pilot supplies the aim itself there too (`withLegalTargets`).
        const fromMenu = casts.find((a) => {
          const targets = a.targets ?? [];
          return targets.length === legal.targets.length && targets.every((t, i) => t === legal.targets[i]);
        });
        const untargetedOffer = casts.find((a) => (a.targets ?? []).length === 0);
        const aimed = fromMenu ?? (untargetedOffer ? { ...untargetedOffer, targets: [...legal.targets] } : undefined);
        if (aimed) {
          return emit(
            ctx,
            aimed,
            ctx.trace ? `cast ${exiled.def.name} for free at its best target` : NO_REASON,
            weights.genericSpellScore,
          );
        }
      }
    }
  }
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
      manaPreferenceOf(weights),
    );
    const next = plan?.[0];
    if (next) {
      const tap: GameAction = tapActionFor(me, next);
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
   * Set when this goal casts the card out of a zone other than the hand — the
   * GRAVEYARD (flashback, or an aftermath half) or EXILE (an adventurer's
   * creature half, a defeated Siege's reward). The cast action must then carry
   * the same `fromZone`, and `cost` is whatever that path pays rather than the
   * printed cost.
   */
  readonly fromZone?: 'graveyard' | 'exile';
  /**
   * §3.111 — WHICH graveyard-cast keyword a `fromZone: 'graveyard'` goal uses
   * (retrace, jump-start, escape); absent means flashback. The cast action
   * must carry the same kind, or the engine charges the flashback cost.
   */
  readonly graveyardCast?: GraveyardCastKind;
  /**
   * Set when this goal casts the SECOND HALF of a two-halved card — a split
   * card's right half, an aftermath half, an adventure. The cast action must
   * name the face or the engine casts the other one.
   */
  readonly face?: 'back';
  // --- the cast-alternative family (§3.112) -----------------------------------------
  /**
   * Set when this goal pays an ALTERNATIVE cost (evoke, dash, blitz, surge,
   * prototype, warp): the cast action must carry the kind, and `cost` is that
   * cost. The goal's `card.def` is the definition the spell is cast AS — the
   * prototype face for a prototype goal — so every downstream reader prices
   * the body that will actually arrive.
   */
  readonly alternative?: keyof typeof ALTERNATIVE_COSTS;
  /**
   * Set when this goal is a CHANNEL / BLOODRUSH activation from hand rather
   * than a cast: the index into the card's `cycling` list. The action built is
   * a `cycleCard`, funded as an activation, with the goal's targets.
   */
  readonly handAbilityIndex?: number;
  /**
   * §3.143 — the life this goal pays toward its cost's PHYREXIAN symbols. Set
   * by {@link planGoalPayment}, which is the only thing that can know it: the
   * price is only worth paying when the BOARD cannot produce the colour, and
   * that is exactly what planning the taps answers.
   */
  readonly phyrexianLife?: number;
}

/**
 * One castable HALF of a card in hand, as the scorer wants it: a card instance
 * whose `def` IS the half, so every downstream reader — the scorer, the target
 * legality check, the mana planner — sees the half's own cost, types, script
 * and target restriction with no second code path.
 *
 * A card with no second half yields exactly itself and allocates nothing, which
 * is every card in every deck the sim plays today; the synthetic instance is
 * built only for the cards that actually print two halves.
 */
interface CastableHalf {
  readonly card: CardInstance;
  readonly face?: 'back';
}

/**
 * The halves of a card in hand the pilot may consider casting.
 *
 * Reads exactly the accessors core's offer loop reads, so the pilot cannot come
 * to a different conclusion about which halves exist than the engine will: a
 * SPLIT card's own definition is not castable and its left half is what
 * `playableFaceOf` hands back; an AFTERMATH right half is castable only from
 * the graveyard and so is not offered here at all.
 */
function castableHalvesInHand(card: CardInstance): readonly CastableHalf[] {
  const def = card.def;
  const second = hasCastableBackFace(def) && backFaceCastZonesOf(def).includes('hand');
  if (def.frontFace === undefined && !second) return [{ card }];
  const halves: CastableHalf[] = [{ card: { ...card, def: playableFaceOf(def, 'front') as CardDefinition } }];
  if (second) halves.push({ card: { ...card, def: def.backFace as CardDefinition }, face: 'back' });
  return halves;
}

// --- §3.112 the cast-alternative family: one more candidate per printed cost ---------

/** What an alternative cast is scored AS, and what it costs. */
interface AlternativeCandidate {
  readonly def: CardDefinition;
  readonly cost: ManaCost;
}

/**
 * The candidate an alternative cost of `def` makes on this board, or
 * `undefined` when proposing it would be a mistake the printed card does not
 * invite. The POLICY, per kind:
 *
 *  - **evoke** — scored as the ETB trigger's body cast as a spell for the evoke
 *    cost (the whole point of Mulldrifter), proposed only when the printed
 *    cost is out of reach this turn: with the mana for the body, the body is
 *    at least as good. A creature with no ETB has nothing to evoke for.
 *  - **dash / blitz** — the same body for less, with haste, proposed only in
 *    OUR PRECOMBAT MAIN (so the hasty body attacks) and only when the printed
 *    cost is out of reach: the body is returned or sacrificed at end of turn,
 *    so paying full price for a body that stays is the better buy when both
 *    are open. Blitz's death draw makes the trade a card up, which is why it
 *    shares the rule rather than a stricter one.
 *  - **warp** — the same body for less, exiled at end of turn and castable
 *    again later for full price: proposed under the dash rule, so an ETB or a
 *    turn's worth of blocking is bought only with mana that had no better use.
 *  - **surge** — strictly cheaper; proposed whenever its turn fact holds and
 *    left to compete (the same score, the same body, a lower price).
 *  - **prototype** — scored as the SMALLER body it arrives as, at its cost,
 *    and left to compete with the full cast: the scorer prices the body, so
 *    the 5/4 wins when its {6} is there and the 1/1 deathtoucher when it is not.
 *
 * Every candidate is a definition the scorer already understands — no second
 * scoring vocabulary — and every one is a cast the engine offers.
 */
function alternativeCandidate(
  view: PilotView,
  def: CardDefinition,
  kind: keyof typeof ALTERNATIVE_COSTS,
  availableMana: number,
  sorcerySpeedOpen: boolean,
): AlternativeCandidate | undefined {
  const alt = def.alternativeCosts?.[kind];
  if (alt === undefined) return undefined;
  if (convertedManaCost(alt.cost) > availableMana) return undefined;
  // The card's own timing still applies to an alternative cast (CR 601.2b
  // changes the price, not the window) — the same gate the printed cast's
  // prefilter applies, asked here because this candidate is built before it.
  if (castTiming(def) !== 'instant' && !sorcerySpeedOpen) return undefined;
  const me = view.priorityPlayer;
  const needsFact = ALTERNATIVE_COSTS[kind].requiresTurnFact;
  if (needsFact !== undefined && !turnFactHolds(view as GameState, needsFact, me)) return undefined;
  const printedAffordable = convertedManaCost(def.cost ?? {}) <= availableMana;
  switch (kind) {
    case 'evoke': {
      if (printedAffordable) return undefined;
      const etb = def.triggers?.find((trigger) => trigger.condition.on === 'etb');
      if (etb === undefined || etb.effects.length === 0) return undefined;
      const timing = castTiming(def);
      return {
        cost: alt.cost,
        def: {
          id: `${def.id}#evoke`,
          name: def.name,
          types: [timing === 'instant' ? 'instant' : 'sorcery'],
          timing,
          cost: alt.cost,
          effects: etb.effects,
        },
      };
    }
    case 'dash':
    case 'blitz':
    case 'warp': {
      if (printedAffordable) return undefined;
      if (!sorcerySpeedOpen || view.step !== 'precombatMain') return undefined;
      return { cost: alt.cost, def: { ...def, cost: alt.cost } };
    }
    case 'surge':
      return { cost: alt.cost, def: { ...def, cost: alt.cost } };
    case 'prototype':
      return { cost: alt.cost, def: definitionCastAs(def, kind) };
    default: {
      const _exhaustive: never = kind;
      void _exhaustive;
      return undefined;
    }
  }
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
  // Every OTHER mana-costed activated ability, funded the same way — see
  // `bestFundedActivation`. It competes on the same scale as the plays above
  // rather than firing as a reflex, so an ability only happens when it beats the
  // land drop and the spell it is spending the mana against.
  const activation = bestFundedActivation(ctx, weights, index);
  // Offered-but-unowned activations (Kiki's tap) compete on the same scale.
  const offered = bestOfferedActivation(ctx, weights, index);
  // §3.111 — an ability activated from the GRAVEYARD (unearth, scavenge,
  // embalm, eternalize, encore, a self-return) competes on the same scale.
  const graveyardPlay = bestGraveyardAbility(ctx, weights, index);
  const bestBattlefieldActivation =
    offered && (!activation || offered.score > activation.score) ? offered : activation;
  const bestActivation =
    graveyardPlay && (!bestBattlefieldActivation || graveyardPlay.score > bestBattlefieldActivation.score)
      ? graveyardPlay
      : bestBattlefieldActivation;

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
  const activationScore = bestActivation ? bestActivation.score : -Infinity;

  if (
    landScore >= spellScore &&
    landScore >= equipScore &&
    landScore >= cycleScore &&
    landScore >= activationScore &&
    canPlayLand
  ) {
    const landAction = bestLandDrop(view, legalActions, weights);
    if (landAction) {
      const why = ctx.trace ? describeLandDrop(view, landAction, legalActions, weights) : NO_REASON;
      return emit(ctx, landAction, why, weights.playLandScore);
    }
  }

  if (equip && equipScore >= spellScore && equipScore >= activationScore && equipScore > weights.passScore) {
    return emit(ctx, equip.action, ctx.trace ? equip.label : NO_REASON, equipScore);
  }

  if (bestActivation && activationScore >= spellScore && activationScore > weights.passScore) {
    return emit(ctx, bestActivation.action, ctx.trace ? bestActivation.label : NO_REASON, activationScore);
  }

  if (bestSpell && bestSpell.goal.score > weights.passScore && spellScore >= cycleScore) {
    return pursueSpell(ctx, bestSpell);
  }

  if (cycle && cycleScore > weights.passScore) {
    return pursueCycle(ctx, cycle);
  }

  // §3.106 — SUSPEND a card that cannot be cast this turn (see `bestSuspend`).
  // Judged after every real play: a land, a castable spell, an equip and a
  // cycle all outrank it, so the mana it spends is mana nothing else wanted.
  const suspend = bestSuspend(ctx, weights);
  if (suspend && suspend.score > weights.passScore) {
    return pursueSuspend(ctx, suspend);
  }
  // §3.112 — FORETELL / PLOT a card that cannot be cast this turn, on the
  // same footing as suspend (see `bestSetAside`).
  const setAside = bestSetAside(ctx, weights);
  if (setAside && setAside.score > weights.passScore) {
    return pursueSetAside(ctx, setAside);
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
 * §3.164 — how many nonland cards a two-seat parley is expected to reveal: two
 * tops from constructed decks of roughly 40% land, rounded DOWN to one so the
 * pilot never counts on the second. A named constant rather than a read of the
 * libraries, which are hidden information the pilot must not consult.
 */
const PARLEY_EXPECTED_NONLAND_REVEALS = 1;

/**
 * Memo for {@link fetchesALand}. An activated ability is immutable card data
 * shared by every instance of its definition, so the answer can never change —
 * and the question is asked once per offered ability on every rollout ply.
 * (Mirrors core's `RESTRICTION_MEMO` for exactly the same reason.)
 */
const FETCH_MEMO = new WeakMap<{ readonly effects: readonly EffectRef[] }, boolean>();

/**
 * The best OFFERED activation the specialised scorers do not own (§3.55).
 *
 * §3.40 built \`bestFundedActivation\` for abilities the engine CANNOT offer
 * (their mana is not yet floating) and deliberately left offered ones to their
 * owners: land-fetch (\`bestAbility\`), loyalty (\`bestLoyaltyActivation\`), Equip
 * (\`bestEquipPlay\`). That partition had a hole: a TAP-COST value ability —
 * Kiki-Jiki — is offered by the engine (nothing to fund), is none of those
 * three, and so fell through EVERY scorer. The pilot never activated it once,
 * which surfaced as the soak reporting \`delayed-trigger\` inert the day Kiki
 * entered the pool: the mechanic was fine, the pilot was blind.
 *
 * Scored with the same \`valueOfEffects\` ruler as everything else, aimed with
 * the targets the engine already enumerated on the offered action. Fetch,
 * loyalty and Equip actions are excluded so no ability is priced twice.
 */
function bestOfferedActivation(
  ctx: DecisionContext,
  weights: HeuristicWeights,
  index: ContinuousIndex,
): { readonly action: GameAction; readonly score: number; readonly label: string } | undefined {
  const { view, legalActions } = ctx;
  const me = view.priorityPlayer;
  let best: { action: GameAction; score: number; label: string } | undefined;
  let cards: ReturnType<typeof cardValueContext> | undefined;
  for (const action of legalActions) {
    // §3.164 — a PARLEY (Selvala, Explorer Returned) is a mana ability the
    // planner deliberately plans nothing from: its amount is decided by a
    // reveal. It is still a play — the reveal draws both players a card and
    // gains a life per nonland card revealed — so it is priced here by the life
    // it is expected to gain, and whatever mana it earns is floating for the
    // next decision. The symmetric draw is priced at nothing: a card each way.
    if (action.kind === 'tapForMana') {
      const source = findInstance(view, action.instanceId);
      const parley =
        source?.def.manaAbilities === undefined ? undefined : manaExtrasOf(source.def)?.[action.mode ?? 0]?.ability.rider?.parley;
      if (parley === undefined) continue;
      const score = parley.lifePerNonland * PARLEY_EXPECTED_NONLAND_REVEALS * weights.modeLifePerPointValue;
      if (score <= weights.passScore) continue;
      if (best !== undefined && score <= best.score) continue;
      best = { action, score, label: ctx.trace ? `parley with ${source!.def.name}` : NO_REASON };
      continue;
    }
    if (action.kind !== "activateAbility") continue;
    const source = findInstance(view, action.instanceId);
    const ability = source?.def.activated?.[action.abilityIndex];
    if (!ability) continue;
    // Owned elsewhere — never price an ability twice.
    if (ability.cost.loyalty !== undefined) continue;
    if (fetchesALand(ability)) continue;
    if (source!.def.attachment !== undefined) continue;
    // §3.141 — the engine offers this one because the pool ALREADY pays for it,
    // so the pool it would leave behind is decidable right here, with no plan to
    // predict. An exchange that leaves it identical is the runaway.
    if (manaExchangeIsNoOp(ability, source!.def, view.players[me].manaPool)) continue;
    cards ??= cardValueContext(view as GameState, index);
    // NET of the non-mana cost (`activation-cost.ts`): the counters, the
    // sacrifice or the life the offer would spend, priced in the body's units.
    // Without it "Remove a +1/+1 counter from ~: You gain 2 life" was worth
    // 2 life and nothing else, and a Spike Feeder stripped itself dead.
    const score =
      valueOfEffects(ability.effects, {
        state: view as GameState,
        player: me,
        targets: action.targets ?? [],
        weights,
        cards,
        index,
      }) + activationCostValue(ability.cost, source!, { state: view as GameState, player: me, weights, index });
    if (score <= weights.passScore) continue;
    if (best !== undefined && score <= best.score) continue;
    best = { action, score, label: ctx.trace ? `activate ${ability.label}` : NO_REASON };
  }
  return best;
}

/**
 * The best MANA-COSTED ACTIVATED ABILITY worth using right now, together with the
 * taps that fund it — the general case {@link bestEquipPlay} solved for Equip
 * alone.
 *
 * Why enumerate the battlefield instead of reading `legalActions`: the engine
 * offers an activation only once the FLOATING pool already covers its cost, and
 * this pilot never floats mana speculatively. So every ability whose cost is not
 * already paid for is invisible to the offered list — which is why the pool's
 * activated abilities were, measurably, never used. Strionic Resonator sat
 * untapped with a trigger on the stack 122 times across six games and was offered
 * its own ability 0 times.
 *
 * ⚠️ This function deliberately does NOT own the abilities that already have a
 * home. Loyalty is `bestLoyaltyActivation` (it prices counters), Equip is
 * `bestEquipPlay` (it prices a host), and a land-fetch is `bestAbility` (it is
 * unconditionally right and needs no scoring). Two paths bidding for the same
 * ability would double-count it against the spell it competes with.
 *
 * Everything else is scored by `valueOfEffects` — the SAME ruler that picks a
 * modal spell's modes, aims a trigger and prices a loyalty ability. The old
 * comment here said such abilities were "left unused until they can be scored
 * honestly"; this is that ruler, not a guess, and an ability that cannot beat
 * `passScore` still goes unused.
 */
/**
 * The engine's OWN offer for this activation, or undefined when it is not on the
 * menu.
 *
 * ⚠️ THE PILOT MUST NOT BUILD AN ACTIVATION ITSELF, and this helper exists
 * because it used to. An `activateAbility` was assembled from the permanent, the
 * ability index and the chosen targets — which is every part of the action the
 * pilot knows about, and not every part the ENGINE requires. An ability whose
 * cost sacrifices a permanent (CR 602.2b: paid at activation, so the payer rides
 * on the action) needs `costInstanceIds`, and the hand-built action carried
 * none. The engine answered "…needs 1 legal permanent(s) to sacrifice" and the
 * pilot had spent its decision on an action that could never be taken.
 *
 * `generateLegalActions` already enumerates one offer per legal payer. Taking
 * the offer instead of rebuilding it means every cost component the engine
 * carries — the ones that exist today and the ones added later — arrives for
 * free, and an action the engine would refuse is never chosen.
 *
 * The soak's cloning-vs-in-place comparison is what surfaced it: one path
 * happened to choose the doomed activation and the other passed, so two runs of
 * the same game diverged (§3.71).
 */
function offeredActivation(
  legalActions: readonly GameAction[],
  instanceId: InstanceId,
  abilityIndex: number,
  targets: readonly (InstanceId | PlayerId)[],
): GameAction | undefined {
  let fallback: GameAction | undefined;
  for (const action of legalActions) {
    if (action.kind !== 'activateAbility') continue;
    if (action.instanceId !== instanceId || action.abilityIndex !== abilityIndex) continue;
    const offeredTargets = action.targets ?? [];
    if (
      offeredTargets.length === targets.length &&
      offeredTargets.every((target, i) => target === targets[i])
    ) {
      return action;
    }
    // A targetless ability is offered once per sacrifice payer, all equivalent
    // to the pilot; the first is as good as any, and taking it keeps the choice
    // deterministic.
    if (targets.length === 0) fallback ??= action;
  }
  return fallback;
}

function bestFundedActivation(
  ctx: DecisionContext,
  weights: HeuristicWeights,
  index: ContinuousIndex,
): { readonly action: GameAction; readonly score: number; readonly label: string } | undefined {
  const { view, legalActions } = ctx;
  const me = view.priorityPlayer;
  const sorcerySpeedOpen =
    me === view.activePlayer &&
    (view.step === 'precombatMain' || view.step === 'postcombatMain') &&
    view.stack.length === 0;

  let best: { action: GameAction; score: number; label: string } | undefined;
  let cards: ReturnType<typeof cardValueContext> | undefined;

  const battlefield = view.battlefield;
  for (let b = 0; b < battlefield.length; b++) {
    const perm = battlefield[b] as CardInstance;
    const abilities = perm.def.activated;
    // Cheapest test first: this runs on every priority decision, and `activated`
    // is absent on almost every permanent (lands, vanilla creatures).
    if (abilities === undefined || perm.controller !== me) continue;
    // Equip has its own scorer, which knows about hosts.
    if (perm.def.attachment !== undefined) continue;

    for (let a = 0; a < abilities.length; a++) {
      const ability = abilities[a]!;
      const mana = ability.cost.mana;
      // No mana cost ⇒ the engine already offers it (nothing to fund), so it is
      // not ours. A cost we cannot price — sacrificing this permanent, paying
      // life — is left alone rather than guessed at, exactly as before.
      if (!mana || ability.cost.loyalty !== undefined) continue;
      if (ability.cost.sacrificeSelf || ability.cost.life) continue;
      if (fetchesALand(ability)) continue; // `bestAbility` owns it
      if ((ability.timing ?? 'instant') === 'sorcery' && !sorcerySpeedOpen) continue;
      // A {T} cost the permanent cannot pay: already tapped, or summoning-sick.
      // Checked here so we never spend taps funding an activation the engine
      // would refuse (DESIGN §3.36 — the offer and the apply must agree).
      if (ability.cost.tap && (perm.tapped || perm.summoningSick)) continue;

      const restriction = restrictionOfEffects(ability.effects);
      let targets: readonly (InstanceId | PlayerId)[] = [];
      if (restriction !== undefined) {
        // "ANOTHER target …" — the engine will not offer the source to itself,
        // so an aim planned here without the exclusion could never be taken.
        const options = legalTargetsFor(
          view as GameState,
          restriction,
          me,
          perm.def,
          ability.targetsExcludeSelf === true ? perm.instanceId : undefined,
        );
        if (options.length === 0) continue; // nothing to aim at — not a play
        cards ??= cardValueContext(view as GameState, index);
        // Score each aim and take the best, the same way the loyalty path does.
        let bestAim: { ref: InstanceId | PlayerId; value: number } | undefined;
        for (const ref of options) {
          const value = valueOfEffects(ability.effects, {
            state: view as GameState,
            player: me,
            targets: [ref],
            weights,
            cards,
            index,
          });
          if (!bestAim || value > bestAim.value) bestAim = { ref, value };
        }
        if (!bestAim) continue;
        targets = [bestAim.ref];
      }

      cards ??= cardValueContext(view as GameState, index);
      // Net of the non-mana cost, as `bestOfferedActivation` prices it: "{2},
      // Remove a +1/+1 counter from ~: Put a +1/+1 counter on target creature"
      // moves a counter, it does not make one.
      const score =
        valueOfEffects(ability.effects, {
          state: view as GameState,
          player: me,
          targets: [...targets],
          weights,
          cards,
          index,
        }) + activationCostValue(ability.cost, perm, { state: view as GameState, player: me, weights, index });
      // Not worth the mana — and this is the line that keeps the change honest:
      // an ability the ruler cannot price scores 0 and is still never used.
      if (score <= weights.passScore) continue;
      if (best !== undefined && score <= best.score) continue;

      const plan = planManaPayment(view as GameState, me, mana, legalActions, perm.def, 'activate', manaPreferenceOf(weights));
      if (!plan) continue; // cannot fund it right now

      // §3.141 — asked of the pool AS IT WILL BE WHEN THE ABILITY IS ACTIVATED,
      // which is the current pool plus everything this plan taps for. Asking
      // against the pre-tap pool would let the pilot spend a land on the first
      // tap and only then discover the activation was worthless: the mana is
      // stranded (pools empty at end of step) and the source a real spell wanted
      // is gone. Deciding before the tap costs nothing and strands nothing.
      if (manaExchangeIsNoOpOnceFunded(ability, perm.def, view, me, plan)) continue;

      // The activation itself is taken from the ENGINE's menu, never rebuilt —
      // see `offeredActivation`. When mana still has to be tapped there is no
      // offer yet, and the tap is the ply.
      const offer = plan.length > 0 ? undefined : offeredActivation(legalActions, perm.instanceId, a, targets);
      if (plan.length === 0 && offer === undefined) continue;
      const action: GameAction =
        plan.length > 0
          ? tapActionFor(me, plan[0]!)
          : offer!;
      best = { action, score, label: ctx.trace ? `activate ${ability.label}` : NO_REASON };
    }
  }
  return best;
}

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
    // `attachment`, not `attachment.modifies`. An Equipment whose whole printed
    // text is a triggered ability on its HOST (Skullclamp; Sword of the Animist)
    // has no modification at all, and gating the search on one made every such
    // card INERT: the pilot never equipped it, so its trigger never fired, in
    // every game ever simulated. What the card is WORTH is `scoreEquip`'s
    // question — this loop only asks whether it is an attachment at all.
    if (perm.def.attachment === undefined) continue;
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

      const score = scoreEquip(perm.def, host, weights, index);
      if (score === undefined || (best !== undefined && score <= best.score)) continue;
      if (!equipIsAnUpgrade(view, perm, score, weights, index)) continue;
      const plan = planManaPayment(
        view as GameState,
        me,
        mana,
        legalActions,
        perm.def,
        'activate',
        manaPreferenceOf(weights),
      );
      if (!plan) continue; // cannot fund it this turn
      const offer =
        plan.length > 0 ? undefined : offeredActivation(legalActions, perm.instanceId, a, [host.instanceId]);
      if (plan.length === 0 && offer === undefined) continue;
      const action: GameAction =
        plan.length > 0
          ? tapActionFor(me, plan[0]!)
          : offer!;
      best = {
        action,
        score,
        label: ctx.trace ? `${ability.label} onto ${host.def.name}` : NO_REASON,
      };
    }
  }
  return best;
}

/**
 * Whether MOVING an already-attached attachment onto `host` is an improvement.
 *
 * ⚠️ THE GUARD THAT KEEPS AN EQUIP {0} FROM LOOPING FOREVER. {@link bestEquipHost}
 * excludes the creature the Equipment is already on, which stops it re-equipping
 * the same body — but with TWO hosts and a free equip cost (Lightning Greaves)
 * the pilot moves it A → B, then finds A is the best non-host and moves it back,
 * forever, at no cost and with nothing else on the menu ever winning. The
 * full-pool soak caught it as three games that burned the 6000-action cap
 * without ending, all three holding Lightning Greaves.
 *
 * Requiring the destination to STRICTLY beat the current host makes the move
 * monotone in `scoreEquip`, so the cycle cannot close. An unattached Equipment
 * is unaffected: there is no host to beat.
 */
function equipIsAnUpgrade(
  view: PilotView,
  perm: CardInstance,
  score: number,
  weights: HeuristicWeights,
  index: ContinuousIndex,
): boolean {
  if (perm.attachedTo === undefined || perm.attachedTo === null) return true;
  const current = findInstance(view, perm.attachedTo);
  if (!current) return true;
  const currentScore = scoreEquip(perm.def, current, weights, index);
  return currentScore === undefined || score > currentScore;
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
 * What moving the attachment `def` onto `host` is worth, or `undefined` when
 * there is nothing to gain.
 *
 * THREE things an attachment can give its host, and it is worth equipping if it
 * gives ANY of them: stats, keywords, and TRIGGERED ABILITIES that watch the
 * host. The third is not decoration — it is the whole of Skullclamp and of
 * Sword of the Animist, and while this score read only the first two those
 * cards scored `undefined` and were never picked up by anyone, ever.
 *
 * Bigger bodies carry equipment better (a +2/+0 on a 4/4 attacker beats the same
 * sword on a 0/1), so the host's own power counts toward the score — which is also
 * what makes the pilot move a sword onto a better creature when one arrives.
 */
function scoreEquip(
  def: CardDefinition,
  host: CardInstance,
  weights: HeuristicWeights,
  index: ContinuousIndex,
): number | undefined {
  const modifies = def.attachment?.modifies;
  const stats = (modifies?.power ?? 0) + (modifies?.toughness ?? 0);
  const keywords = modifies?.keywords ? Object.values(modifies.keywords).filter(Boolean).length : 0;
  const hostTriggers = countHostWatchingTriggers(def);
  if (stats <= 0 && keywords === 0 && hostTriggers === 0) return undefined;
  return (
    weights.attachBaseScore +
    weights.attachPerStat * stats +
    weights.attachPerKeyword * keywords +
    weights.attachPerHostTrigger * hostTriggers +
    weights.castCreaturePerStat * power(host, index)
  );
}

/**
 * How many of this card's triggered abilities fire off its HOST rather than off
 * itself — the "whenever equipped/enchanted creature …" family.
 *
 * The scope is read from core's `TriggerCondition.watches`, which is the data
 * the ENGINE matches on, so a card cannot be valued for a trigger the engine
 * would not fire (nor the reverse). The attachment's OWN triggers ("when ~
 * enters, …") are deliberately not counted: they are a reason to have played
 * the card, never a reason to spend mana equipping it.
 */
function countHostWatchingTriggers(def: CardDefinition): number {
  const triggers = def.triggers;
  if (triggers === undefined) return 0;
  let count = 0;
  for (let i = 0; i < triggers.length; i++) {
    if ((triggers[i] as TriggeredAbility).condition.watches === 'attachedHost') count += 1;
  }
  return count;
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
    const funded = planGoalPayment(ctx.view, me, goal, ctx.legalActions, weights);
    if (funded) return funded;
  }
  return undefined;
}

/**
 * Plan the taps that fund one goal, CHOOSING the Phyrexian life price along the
 * way (§3.143) — one helper, because the pilot and the search must fund the same
 * goal at the same price or the search would be exploring a game the pilot never
 * plays.
 *
 * THE POLICY, in two rules:
 *
 *  1. **Mana before life.** `phyrexianLifeOptions` is ascending, so the first
 *     fundable reading wins and life is spent only when the board genuinely
 *     cannot produce the colour. That is what stops the pilot paying 2 life for
 *     a saving it did not need — the failure mode a "always pay life" pilot has,
 *     and a real strength bug, because the mana it saves goes unused anyway.
 *  2. **Never below the danger line.** The remaining total must stay above
 *     `desperateLifeThreshold`, which is the SAME line `answerPayLife` holds a
 *     shockland to and the same one the combat and burn math treat as desperate.
 *     One answer to "how low may I take myself by choice", not a second number
 *     that could disagree with it. Options are ascending, so the first one that
 *     crosses the line ends the search — every later one costs more life.
 */
function planGoalPayment(
  view: PilotView,
  me: PlayerId,
  goal: SpellGoal,
  legalActions: readonly GameAction[],
  weights: HeuristicWeights,
): FundedGoal | undefined {
  const life = view.players[me].life;
  const options = phyrexianLifeOptions(goal.cost, life);
  for (let i = 0; i < options.length; i++) {
    const spend = options[i] as number;
    if (spend > 0 && life - spend <= weights.desperateLifeThreshold) break;
    const plan = planManaPayment(
      view as GameState,
      me,
      goal.cost,
      legalActions,
      goal.card.def,
      spendPurposeOfGoal(goal),
      manaPreferenceOf(weights),
      spend,
    );
    if (plan) return { goal: spend > 0 ? { ...goal, phyrexianLife: spend } : goal, plan };
  }
  return undefined;
}

/**
 * §3.112 — what restricted mana is being spent ON for a goal: a channel /
 * bloodrush activation is an ACTIVATED ability of a card in hand (CR 702.29a's
 * shape), everything else a cast. Read by both funding planners, so the
 * heuristic and the search cannot fund the same goal from different pools.
 */
function spendPurposeOfGoal(goal: SpellGoal): 'cast' | 'activate' {
  return goal.handAbilityIndex !== undefined ? 'activate' : 'cast';
}

/**
 * Every spell in hand that is legal to cast right now, scored and targeted, best
 * first. Funding is deliberately NOT considered here — that is the caller's job,
 * because the two consumers want different things from it: {@link bestSpellGoal}
 * plans only until it finds one payable goal (cheapest possible), while the search
 * policy ({@link policyCandidates}) plans every goal so it can search them all.
 */
/**
 * Whether any card in `hand` could be cast at INSTANT speed — the cheap gate
 * {@link scoredSpellGoals} asks before doing any per-card work outside a main
 * phase. Reads the printed timing only: it is a filter, and the real castability
 * test still runs per candidate below.
 */
function handHasInstantSpeedCard(hand: readonly CardInstance[]): boolean {
  for (let i = 0; i < hand.length; i++) {
    const def = (hand[i] as CardInstance).def;
    if (castTiming(def) === 'instant') return true;
    // A two-halved card can print a different timing on its other half, so it
    // is never ruled out from the front face alone.
    if (def.frontFace !== undefined || def.backFace !== undefined) return true;
  }
  return false;
}

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
  // NOTHING is castable at sorcery speed outside our own main phase, and a hand
  // with no instant-speed card then has no goal at all — so the whole scoring
  // pass (and the per-card half-splitting it allocates) is skipped. This runs on
  // EVERY priority window of every game, and most windows are exactly this one:
  // the profiler put spell scoring at 19% of a full run before this early-out.
  if (!sorcerySpeedOpen && !handHasInstantSpeedCard(hand)) return scored;
  for (const handCard of hand) {
    // A two-halved card is scored HALF BY HALF: a pilot that only ever looked at
    // `card.def` would score a split card's combined object (which has no script
    // and a cost equal to both halves) and would never cast an adventure at all,
    // making the whole layout inert in exactly the decks that bought it.
    for (const half of castableHalvesInHand(handCard)) {
      const card = half.card;
      const def = card.def;
      if (isLand(def)) continue;
      /*
       * §3.112 — THE ALTERNATIVE CASTS of this half, each ONE MORE CANDIDATE
       * with its own price, so the pilot WEIGHS them against the printed cast
       * rather than following a rule: an evoke is scored as the ETB spell it
       * buys (Mulldrifter evoked IS "draw two cards" for {2}{U}); a prototype
       * is scored as the body it arrives as; dash, blitz, surge and warp are
       * the same body for less. `alternativeCandidate` decides which kinds are
       * worth proposing on this board, and why.
       *
       * ⚠️ ABOVE the printed-cost prefilters below, and that is the whole
       * point: the cheap cast exists precisely when the printed one is
       * unaffordable, so a `continue` on the printed mana value would skip
       * every evoke, dash and prototype the pilot is meant to be weighing.
       * (It did — the pilot passed the turn with Mulldrifter and three
       * Islands in front of it.)
       */
      for (const kind of alternativeCostKindsOf(def)) {
        const candidate = alternativeCandidate(view, def, kind, availableMana, sorcerySpeedOpen);
        if (candidate === undefined) continue;
        const altCard = { ...card, def: candidate.def };
        oppCreatures ??= creaturesControlledBy(view, opp);
        const altGoal = scoreSpell(view, opp, oppCreatures, altCard, classifySpell(candidate.def), weights, explain, index);
        const altLegal = altGoal ? withLegalTargets(view, opp, altGoal, index, weights) : undefined;
        if (!altLegal) continue;
        scored.push({
          ...altLegal,
          cost: candidate.cost,
          alternative: kind,
          // An evoke's aim belongs to the ETB TRIGGER, chosen as that ability
          // goes on the stack; the creature spell itself targets nothing.
          ...(kind === 'evoke' ? { targets: [] } : {}),
          ...(half.face === undefined ? {} : { face: half.face }),
          reason: explain ? `${kind} — ${altLegal.reason}` : NO_REASON,
        });
      }
      // §3.106 — CR 202.1b: a card with no mana cost cannot be cast from hand
      // (the engine refuses it); it reaches the stack through suspend instead.
      if (def.noManaCost === true) continue;
      const timingOk = castTiming(def) === 'instant' ? true : sorcerySpeedOpen;
      if (!timingOk) continue;
      const cost = def.cost ?? {};
      // Cheap prefilter; `planManaTaps` below is the real test. §3.143 — the
      // bound is the CHEAPEST reading of the cost, because a Phyrexian symbol
      // paid with life needs no mana at all: comparing Dismember's mana value of
      // 3 against one untapped land would have made it invisible on exactly the
      // boards its printed alternative exists for.
      if (minimumManaValue(cost, view.players[me].life) > availableMana) continue;

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
      const legal = goal ? withLegalTargets(view, opp, goal, index, weights) : undefined;
      if (legal) scored.push(half.face === undefined ? legal : { ...legal, face: half.face });
    }

    // §3.112 — CHANNEL and BLOODRUSH: the card's from-hand activation, scored
    // as the spell its body is (a bloodrush is a combat trick; Ghost-Lit
    // Raider's channel is four damage to a creature) and carried out as a
    // `cycleCard` with the goal's targets. The engine offers the activation
    // only once the pool pays, so the goal plans its own taps like a cast.
    const handAbilities = handCard.def.cycling;
    if (handAbilities !== undefined) {
      for (let index_ = 0; index_ < handAbilities.length; index_++) {
        const ability = handAbilities[index_]!;
        if (ability.kind !== 'channel' && ability.kind !== 'bloodrush') continue;
        const timing = ability.timing ?? 'instant';
        if (timing !== 'instant' && !sorcerySpeedOpen) continue;
        if (convertedManaCost(ability.cost) > availableMana) continue;
        const abilityDef: CardDefinition = {
          id: `${handCard.def.id}#${ability.kind}${index_}`,
          name: handCard.def.name,
          types: [timing === 'instant' ? 'instant' : 'sorcery'],
          timing,
          cost: ability.cost,
          effects: ability.effects,
        };
        const synthetic = { ...handCard, def: abilityDef };
        oppCreatures ??= creaturesControlledBy(view, opp);
        const abilityGoal = scoreSpell(view, opp, oppCreatures, synthetic, classifySpell(abilityDef), weights, explain, index);
        const abilityLegal = abilityGoal ? withLegalTargets(view, opp, abilityGoal, index, weights) : undefined;
        if (!abilityLegal) continue;
        scored.push({
          ...abilityLegal,
          cost: ability.cost,
          handAbilityIndex: index_,
          reason: explain ? `${ability.kind} — ${abilityLegal.reason}` : NO_REASON,
        });
      }
    }
  }

  // Flashback casts out of OUR graveyard — the same scoring, targeting and
  // timing rules as a hand cast, with the FLASHBACK cost in place of the
  // printed one and the goal marked so the cast action carries its source
  // zone. Without this loop a flashback card is inert to the pilot: legal,
  // never considered, and silently corrupting every A/B verdict that swaps one
  // in. (A card in the graveyard costs no card from hand, so the same score
  // reads as at least as attractive — free spells win ties naturally.)
  for (const card of view.players[me].graveyard) {
    // AFTERMATH first: a right half printed "cast this spell only from your
    // graveyard" is a real cast for its own printed cost, and is the one
    // graveyard cast that is not a flashback.
    if (hasCastableBackFace(card.def) && backFaceCastZonesOf(card.def).includes('graveyard')) {
      const half = { ...card, def: card.def.backFace as CardDefinition };
      const cost = half.def.cost ?? {};
      if (
        (castTiming(half.def) === 'instant' || sorcerySpeedOpen) &&
        convertedManaCost(cost) <= availableMana
      ) {
        oppCreatures ??= creaturesControlledBy(view, opp);
        const goal = scoreSpell(view, opp, oppCreatures, half, classifySpell(half.def), weights, explain, index);
        const legal = goal ? withLegalTargets(view, opp, goal, index, weights) : undefined;
        if (legal) {
          scored.push({
            ...legal,
            cost,
            fromZone: 'graveyard',
            face: 'back',
            reason: explain ? `aftermath — ${legal.reason}` : NO_REASON,
          });
        }
      }
    }
    const def = card.def;
    // Printed OR granted (Snapcaster), and — §3.111 — flashback OR one of its
    // siblings (retrace, jump-start, escape). Read through core's one accessor,
    // the same one `generateLegalActions` and `applyCastSpell` use — a pilot
    // that read only the printed field would never take the recast its own ETB
    // just bought, and the ability would be inert in exactly the games it was
    // cast in.
    if (isLand(def)) continue;
    const graveyardCasts = graveyardCastOptionsOf(view as GameState, card, def);
    if (graveyardCasts.length === 0) continue;
    const timingOk = castTiming(def) === 'instant' ? true : sorcerySpeedOpen;
    if (!timingOk) continue;
    let goal: SpellGoal | undefined;
    let goalScored = false;
    for (const option of graveyardCasts) {
      if (convertedManaCost(option.cost) > availableMana) continue;
      /*
       * A FLASHBACK COST CAN PRINT A LIFE RIDER — "Flashback—{1}{B}, Pay 3 life"
       * (Crippling Fatigue). It is part of the cost, so core's
       * `generateLegalActions` does not offer the cast and `applyCastSpell`
       * rejects it.
       *
       * Without this gate the pilot still WANTED the spell, and what that cost it
       * was worse than a rejection: it committed the taps first, so it **tapped
       * every land toward a cast it could never make and then passed**, floating
       * the whole pool and throwing the turn away EXACTLY when it was at low life
       * (measured: 5 taps, 0 casts, at 1 and 2 life against a 3-life rider). When
       * the macro path did reach the cast, the engine refused it and the sim harness
       * passed priority after `maxConsecutiveRejectedActions` — same lost turn,
       * louder. Found by the full-pool soak, seed 3329123684.
       */
      if (option.lifeCost > 0 && view.players[me].life < option.lifeCost) continue;
      // §3.111 — the same rule for a keyword's NON-MANA rider: a retrace with
      // no land in hand, an escape with a thin graveyard, a Dread Return with
      // two creatures are casts the engine never offers (CR 601.2h).
      if (option.additional !== undefined && !canPayAdditionalCost(view as GameState, option.additional, me, card.instanceId)) {
        continue;
      }
      if (!goalScored) {
        goalScored = true;
        const intent = classifySpell(def);
        oppCreatures ??= creaturesControlledBy(view, opp);
        const base = scoreSpell(view, opp, oppCreatures, card, intent, weights, explain, index);
        goal = base ? withLegalTargets(view, opp, base, index, weights) : undefined;
      }
      if (!goal) break;
      // §3.111 — "when the graveyard has fuel and the spell is worth it": the
      // rider is PRICED against the spell — the worst land in hand for a
      // retrace, the worst card for a jump-start, a point of yard per exiled
      // card for an escape, the creatures a Dread Return eats — so a
      // Glimpse of Freedom is escaped for a draw only when five cards of yard
      // are worth less than the card, and a Flame Jab is retraced when the
      // land it pitches is chaff.
      const riderCost = option.additional === undefined ? 0 : additionalCostPrice(view as GameState, me, option.additional, card.instanceId, weights, index);
      const label = option.kind === 'flashback' ? 'flashback' : option.kind;
      scored.push({
        ...goal,
        score: goal.score - riderCost,
        cost: option.cost,
        fromZone: 'graveyard',
        ...(option.kind === 'flashback' ? {} : { graveyardCast: option.kind }),
        reason: explain ? `${label} — ${goal.reason}` : NO_REASON,
      });
    }
  }

  // Casts out of EXILE the card has explicit permission for — an adventurer's
  // creature half waiting after its adventure resolved (CR 715.3d), or a
  // defeated Siege's reward (CR 310.4). Without this loop the whole adventure
  // layout is inert to the pilot: it would cast Stomp and then never take the
  // Giant, which is strictly worse than not owning the card. Behind the same
  // empty check every other card-grant reader starts with.
  if (hasCardGrants(view as GameState)) {
    for (const card of view.players[me].exile) {
      const permission = castPermissionFor(view as GameState, card);
      if (permission === undefined) continue;
      const castDef = playableFaceOf(card.def, permission.face);
      if (castDef === undefined || isLand(castDef)) continue;
      // §3.112 — a plotted card is cast as a sorcery, a foretold card for its
      // foretell cost: both read off the same permission core offers by.
      if ((castTiming(castDef) !== 'instant' || permission.asSorcery) && !sorcerySpeedOpen) continue;
      const cost = permission.free ? {} : (permission.cost ?? castDef.cost ?? {});
      if (minimumManaValue(cost, view.players[me].life) > availableMana) continue;
      const half = castDef === card.def ? card : { ...card, def: castDef };
      oppCreatures ??= creaturesControlledBy(view, opp);
      const goal = scoreSpell(view, opp, oppCreatures, half, classifySpell(castDef), weights, explain, index);
      const legal = goal ? withLegalTargets(view, opp, goal, index, weights) : undefined;
      if (legal) {
        scored.push({
          ...legal,
          cost,
          fromZone: 'exile',
          ...(permission.face === 'back' ? { face: 'back' as const } : {}),
          reason: explain ? `from exile — ${legal.reason}` : NO_REASON,
        });
      }
    }
  }

  scored.sort((a, b) => b.score - a.score);
  /*
   * CR 601.2h: a MANDATORY additional cost this board cannot pay makes the cast
   * ILLEGAL — not cost-free. Filtered here, at the one exit, so both consumers
   * inherit it: `bestSpellGoal` and the search policy.
   *
   * Without it the pilot builds a `castSpell` the engine refuses, and — because
   * nothing about the board changed — proposes the SAME cast on the next
   * priority, and the next. That is the "spin forever" this function's own
   * header warns about, and the full-pool soak caught it the moment the pool
   * gained a card with one: Altar's Reap and Harrow with nothing to sacrifice
   * burned the 6000-action cap without the game ending.
   *
   * The reader is core's, not a second opinion: `generateLegalActions` withholds
   * the offer and `applyCastSpell` rejects the action from this same function.
   */
  return scored.filter(
    (goal) =>
      unpayableAdditionalCostReason(
        view as GameState,
        goal.card.def,
        me,
        goal.card.instanceId,
      ) === undefined,
  );
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
// --- the spell-count family (§3.113): what a cast trigger adds to a goal -------
/**
 * The score a spell's CAST TRIGGERS add: storm once per spell already cast
 * this turn (each is a copy the cast will make — CR 702.40a), cascade once per
 * printed instance (a free spell off the top). Zero for the ordinary spell,
 * so the common path pays one property read.
 */
function castTriggerBonus(view: PilotView, def: CardDefinition, weights: HeuristicWeights): number {
  if (def.castTriggers === undefined) return 0;
  const storm = castTriggerCount(def, 'storm');
  const cascade = castTriggerCount(def, 'cascade');
  return storm * spellsCastThisTurn(view as GameState) * weights.stormPerSpellCast + cascade * weights.cascadePerInstance;
}

function withLegalTargets(
  view: PilotView,
  opp: PlayerId,
  goal: SpellGoal,
  index: ContinuousIndex,
  weights: HeuristicWeights,
): SpellGoal | undefined {
  // §3.113 — every goal passes through here exactly once, whichever of the
  // four scoring sites built it, so this is where a storm or cascade spell's
  // extra worth is added rather than in each `scoreSpell` return.
  const castBonus = castTriggerBonus(view, goal.card.def, weights);
  if (castBonus > 0) goal = { ...goal, score: goal.score + castBonus };
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
  const fallback = defaultLegalTarget(view, opp, restriction, index, weights, goal.card.def);
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
  restriction: TargetSpec,
  index: ContinuousIndex,
  weights: HeuristicWeights,
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
  const biggest = biggestThreat(legal, index, weights);
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
        ? biggestThreatWithin(oppCreatures, intent.amount, index, weights)
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
      const target = biggestThreat(reachable, index, weights);
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
      const target = biggestThreatWithin(oppCreatures, intent.toughness, index, weights);
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
    case 'fog': {
      const score = fogValue(view, otherPlayer(opp), intent, weights, index);
      // A fog with nothing to prevent is NOT cast — that is the whole discipline
      // of the card, and a pilot that fires it in its own main phase has thrown
      // it away. Returning undefined leaves it in hand for the attack.
      if (score <= 0) return undefined;
      return {
        score,
        card,
        cost,
        targets: [],
        reason: explain ? `fog the attack with ${card.def.name}` : NO_REASON,
      };
    }
    case 'blink': {
      const pick = bestBlinkTarget(view, otherPlayer(opp), weights, index);
      if (!pick) return undefined; // nothing whose ETB is worth re-running — hold it
      return {
        score: pick.score,
        card,
        cost,
        targets: [pick.instanceId],
        reason: explain ? `blink ${pick.name} to re-trigger it` : NO_REASON,
      };
    }
    case 'copySpell': {
      const target = copyTarget(view, otherPlayer(opp));
      if (!target) return undefined; // nothing on the stack worth copying — hold it
      return {
        // Worth what the copy is worth, on the same card ruler removal uses — so
        // a Reverberate held for a Cryptic Command outscores one spent on a
        // cantrip, which is the whole discipline of the card.
        score: cardValue(target.card, weights, cardValueContext(view as GameState, index)),
        card,
        cost,
        targets: [target.instanceId],
        reason: explain ? `copy ${target.card.def.name}` : NO_REASON,
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
      const host = biggestThreat(hosts, index, weights);
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
 * WHICH of our creatures is worth blinking, and what that is worth.
 *
 * A blink is worth re-running an enters-the-battlefield trigger, so the answer
 * is "the creature whose ETB is worth the most, priced through the same
 * `valueOfEffects` ruler every other effect uses". Three things this must get
 * right, each of which is a way the card gets misplayed:
 *
 *  - A creature with NO enters trigger is worth nothing to blink. Worse than
 *    nothing, in fact — it comes back summoning sick and loses its counters —
 *    so it is never offered and the spell is simply held.
 *  - A LEAVES trigger counts too. Blinking Thragtusk fires both halves: the 3/3
 *    on the way out and the five life on the way back, which is what makes it
 *    the best blink target in the pool by a distance.
 *  - A creature already summoning sick is still fine to blink (nothing is lost),
 *    but an ATTACKING one is not: returning it removes it from combat. Combat is
 *    not modelled here, and the pilot only casts spells in its main phases, so
 *    this stays a main-phase value question exactly as printed.
 */
function bestBlinkTarget(
  view: PilotView,
  me: PlayerId,
  weights: HeuristicWeights,
  index: ContinuousIndex,
): { readonly instanceId: InstanceId; readonly score: number; readonly name: string } | undefined {
  const base = resolutionValueContext(view as GameState, me, weights, cardValueContext(view as GameState, index));
  let best: { instanceId: InstanceId; score: number; name: string } | undefined;
  for (const permanent of view.battlefield) {
    if (permanent.controller !== me) continue;
    const triggers = permanent.def.triggers ?? [];
    // Both halves of the blink: what leaving fires, and what entering fires.
    const fired = triggers.filter((t) => t.condition.on === 'etb' || t.condition.on === 'leaves');
    if (fired.length === 0) continue;
    let score = 0;
    for (const trigger of fired) score += valueOfEffects(trigger.effects, { ...base, targets: [] });
    if (score <= 0) continue; // nothing worth re-running
    if (!best || score > best.score) best = { instanceId: permanent.instanceId, score, name: permanent.def.name };
  }
  return best;
}

/**
 * The spell on the stack a COPY should point at, or undefined for "hold it".
 *
 * The mirror image of {@link counterTarget}, and the differences are the card:
 *
 *  - it answers the TOP object, for the same reason a counter does — anything
 *    below has already been responded to;
 *  - the spell must be an INSTANT OR SORCERY, because that is what the printed
 *    restriction allows and offering anything else builds a cast the engine
 *    rejects, which is the loop `scoredSpellGoals` exists to avoid;
 *  - unlike a counter, OUR OWN spell is the good case, not the disqualifying
 *    one. Casting a burn spell and copying it before it resolves is the line the
 *    card is printed for. An opponent's spell is legal to copy too (the copy is
 *    ours — CR 707.10), and worth exactly as much.
 */
function copyTarget(view: PilotView, me: PlayerId) {
  void me;
  const top = view.stack[view.stack.length - 1];
  if (!top || top.kind !== 'spell') return undefined;
  const types = top.card.def.types;
  if (!types.includes('instant') && !types.includes('sorcery')) return undefined;
  return top as Extract<typeof top, { kind: 'spell' }>;
}

/**
 * What sweeping the board is worth to us right now: their creatures cleared, less
 * ours cleared with them, on the same scale as targeted removal. A sweeper with
 * nothing to sweep — or one that costs us more than it costs them — scores zero or
 * less and is held, instead of being fired into an empty board for value nobody got.
 */
/**
 * WHAT A FOG IS WORTH RIGHT NOW — which is the only honest way to price one.
 *
 * A prevention spell has no intrinsic value: it is worth exactly the damage it
 * stops, and that number is zero at every moment except one. So this asks the
 * board three questions, in the order that lets the answer be "nothing" as
 * cheaply as possible:
 *
 *  1. **Is there an attack to fog?** Attackers must be DECLARED. A fog cast
 *     before blockers are declared, or on our own turn, prevents nothing —
 *     `combat.attackersDeclared` is the engine's own answer to "has the swing
 *     happened yet", and it is what keeps this from being cast on curve like a
 *     three-drop.
 *  2. **Is it aimed at us?** A prevention that only guards our own seat is worth
 *     nothing while WE are the attacker.
 *  3. **How much would actually land?** The incoming total is read through the
 *     SAME replacement projection the rest of the pilot uses, so a fog held
 *     against a Gratuitous Violence board is priced against the doubled swing —
 *     and a swing already prevented by a Dolmen Gate prices the second fog at
 *     nothing, correctly.
 *
 * Lethal is the whole game and is scored as such; anything short of it is priced
 * per point of life saved, so a fog against a two-power poke stays in hand while
 * a fog against a real attack gets cast.
 */
function fogValue(
  view: PilotView,
  me: PlayerId,
  intent: Extract<SpellIntent, { kind: 'fog' }>,
  weights: HeuristicWeights,
  index: ContinuousIndex,
): number {
  const combat = view.combat;
  if (!combat || !combat.attackersDeclared || combat.attackers.length === 0) return 0;
  // The defending player is the one being attacked; a fog does nothing for the
  // attacker, and one that guards only its own controller does nothing at all.
  if (view.activePlayer === me) return 0;
  if (intent.protectsMeOnly && defendingPlayer(view) !== me) return 0;
  // Both clocks (§3.105): lethal is asked of each; the fog's VALUE is priced on
  // the life scale, so a fog against an infect swing is worth what it saves.
  const pressure = attackPressure(view, combat.attackers, me, index);
  const incoming = lifeEquivalent(pressure, weights);
  if (incoming <= 0) return 0;
  const life = view.players[me].life;
  if (pressureIsLethal(view, me, pressure)) return weights.lethalBurnScore;
  // A fog is a whole card, so a poke is not worth one — unless we are already in
  // the red, where every point is worth spending a card on.
  if (incoming < weights.fogMinimumDamagePrevented && life > weights.desperateLifeThreshold) return 0;
  return incoming * weights.fogValuePerDamagePrevented;
}

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
  // Kept as the two clocks (§3.105): an unblocked infect attacker is poison,
  // and pumping it adds to the POISON clock, never to the life one.
  let unblockedDamage = 0;
  let unblockedPoison = 0;
  if (iAmAttacking) {
    for (let i = 0; i < engagements.length; i++) {
      const e = engagements[i] as { own: CardInstance; enemies: CardInstance[] };
      if (e.enemies.length === 0) {
        const p = attackerPressure(e.own, power(e.own, index), index);
        unblockedDamage += p.damage;
        unblockedPoison += p.poison;
      }
    }
  }

  let best: PumpPlay | undefined;
  for (const { own, enemies } of engagements) {
    if (enemies.length === 0) {
      // Unblocked attacker: the pump is face damage. Lethal is the whole game.
      if (!iAmAttacking) continue;
      const pumped = attackerPressure(own, intent.power, index);
      const withPump = { damage: unblockedDamage + pumped.damage, poison: unblockedPoison + pumped.poison };
      if (pressureIsLethal(view, opp, withPump)) {
        return {
          target: own.instanceId,
          score: weights.lethalBurnScore,
          reason: explain
            ? `pump ${own.def.name} for lethal (${unblockedDamage} + ${intent.power} ≥ ${view.players[opp].life}` +
              (withPump.poison > 0 ? `, or ${withPump.poison} poison ≥ ${poisonRemaining(view, opp)} remaining)` : ')')
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
  /*
   * §3.147 — A CYCLING-SHAPED ABILITY MAY PRINT SORCERY TIMING, and this policy
   * is one of the few places the pilot BUILDS an action instead of taking one
   * off the menu (the engine offers a `cycleCard` only once the pool already
   * covers its cost, so a pilot that had not planned its taps would never see
   * cycling at all). That design is right and it carries one debt: everything
   * the offer loop checks, this policy must check too.
   *
   * Plain cycling prints no timing restriction, so there was nothing to check —
   * until transmute (CR 702.53a, "activate only as a sorcery") arrived as a
   * cycling-shaped ability. The only case that scores for a non-land here is
   * `turnEnding`, the END STEP, which is precisely when a sorcery-timed ability
   * is illegal. Asked through core's one reader so this cannot drift from the
   * engine's answer.
   */
  const sorceryOpen = sorcerySpeedWindowFor(view, me);

  let best: CycleGoal | undefined;
  for (const card of hand) {
    const abilities = card.def.cycling;
    if (!abilities || abilities.length === 0) continue;
    for (let index = 0; index < abilities.length; index++) {
      const ability = abilities[index]!;
      if ((ability.timing ?? 'instant') !== 'instant' && !sorceryOpen) continue;
      /*
       * …AND IT MAY REQUIRE A TARGET (§3.147). The same trap one question on: a
       * cycling-shaped body that targets — a channel line, bloodrush's pump — is
       * refused outright unless the action names exactly one legal target, and
       * this policy builds a bare `cycleCard`. The soak's answer was "Channel —
       * {R} targets exactly one a creature".
       *
       * SKIPPED rather than aimed, deliberately. This policy's two reasons are
       * "the hand is flooded" and "the turn is ending with mana unspent", which
       * are arguments for DISCARDING a card, not for pointing a pump at a
       * creature; choosing that target well is the combat scorer's job, and the
       * engine still offers these per legal target for the paths that reason
       * about targets (`actionForGoal`, which does pass them).
       */
      if (restrictionOfEffects(ability.effects) !== undefined) continue;
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
        manaPreferenceOf(weights),
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
  const me = ctx.view.priorityPlayer;
  const tap: GameAction = tapActionFor(me, next);
  // The remaining taps only — the same promise `pursueSpell` makes, for the
  // same reason: the play at the end is re-decided against the floating pool.
  if (planSink !== null) {
    for (let i = 1; i < goal.plan.length; i++) planSink.push(tapActionFor(me, goal.plan[i] as ManaTapPlan));
  }
  return emit(ctx, tap, goal.reason, goal.score);
}

// --- §3.106 suspend (CR 702.62) ---------------------------------------------------

/** A suspend play the pilot wants to make: which card, how it is funded, why. */
interface SuspendGoal {
  readonly action: Extract<GameAction, { kind: 'suspendCard' }>;
  readonly plan: readonly ManaTapPlan[];
  readonly score: number;
  readonly reason: string;
}

/**
 * The best SUSPEND play right now, or `undefined`.
 *
 * The policy is the keyword's own reason to exist: a card the pilot CANNOT CAST
 * this turn — its mana cost is beyond this turn's mana, or it has no mana cost
 * at all (Ancestral Vision, Lotus Bloom) — is suspended for its cheap suspend
 * cost and arrives free some turns later. A card the pilot could cast is left
 * to the spell scorer: casting now is at least as good as waiting, so the
 * engine's suspend offer for it is simply never taken.
 *
 * Scored between passing and a generic spell (`suspendScore`, plus a little per
 * mana value so the seven-drop is suspended before the three-drop), and funded
 * through the SAME `planManaPayment` every spell goal uses — the engine only
 * OFFERS `suspendCard` once the pool covers the suspend cost, so a pilot that
 * did not plan its taps would never see the action at all.
 *
 * Cheapest question first, for the same reason `bestCycle` asks it: this runs
 * on every priority decision, and almost no deck holds a suspend card.
 */
function bestSuspend(ctx: DecisionContext, weights: HeuristicWeights): SuspendGoal | undefined {
  const { view, legalActions } = ctx;
  const me = view.priorityPlayer;
  const hand = view.players[me].hand;
  let anySuspend = false;
  for (const card of hand) {
    if (card.def.suspend !== undefined) {
      anySuspend = true;
      break;
    }
  }
  if (!anySuspend) return undefined;
  const sorcerySpeedOpen =
    me === view.activePlayer && (view.step === 'precombatMain' || view.step === 'postcombatMain') && view.stack.length === 0;
  const availableMana = totalAvailableMana(view, me);

  let best: SuspendGoal | undefined;
  for (const card of hand) {
    const suspend = card.def.suspend;
    if (suspend === undefined) continue;
    // Mirrors core's `unsuspendableReason`: "any time you could begin to cast
    // this card" is the card's own timing.
    if (castTiming(card.def) !== 'instant' && !sorcerySpeedOpen) continue;
    const cost = card.def.cost;
    const manaValue = cost === undefined ? 0 : convertedManaCost(cost);
    // Castable this turn ⇒ not a suspend candidate (see the policy above).
    if (cost !== undefined && manaValue <= availableMana) continue;
    const score = weights.suspendScore + manaValue * weights.suspendPerManaValue;
    if (score <= weights.passScore) continue;
    if (best && score <= best.score) continue;
    const plan = planManaPayment(
      view as GameState,
      me,
      suspend.cost,
      legalActions,
      card.def,
      'activate',
      manaPreferenceOf(weights),
    );
    if (!plan) continue;
    best = {
      action: { kind: 'suspendCard', player: me, instanceId: card.instanceId },
      plan,
      score,
      reason: ctx.trace ? `suspend ${card.def.name} for ${suspend.count} (cannot cast it this turn)` : NO_REASON,
    };
  }
  return best;
}

/** Take the next step toward a suspend play: tap for it, or suspend. */
function pursueSuspend(ctx: DecisionContext, goal: SuspendGoal): GameAction {
  const next = goal.plan[0];
  if (!next) return emit(ctx, goal.action, goal.reason, goal.score);
  const tap: GameAction = tapActionFor(ctx.view.priorityPlayer, next);
  return emit(ctx, tap, goal.reason, goal.score);
}

// --- §3.112 foretell (CR 702.143a) and plot (CR 702.170a) ------------------------------

/** A set-aside play the pilot wants to make: which card, by which action, how funded, why. */
interface SetAsideGoal {
  readonly action: Extract<GameAction, { kind: 'foretellCard' | 'plotCard' }>;
  readonly plan: readonly ManaTapPlan[];
  readonly score: number;
  readonly reason: string;
}

/**
 * The best FORETELL or PLOT play right now, or `undefined` — the suspend
 * policy, applied to the two keywords that share its shape: a card the pilot
 * CANNOT CAST this turn is set aside on a turn with spare mana and arrives
 * cheaper (foretell) or free (plot) later. A card the pilot could cast is left
 * to the spell scorer, for the reason `bestSuspend` gives. Judged after every
 * real play, so the mana it spends is mana nothing else wanted.
 *
 * Timing is core's: foretell any time during our own turn (`FORETELL_COST`
 * is the fixed {2}), plot only in a main phase with the stack empty — the
 * engine offers each action exactly then, and the plan funds it through the
 * same planner every goal uses.
 */
function bestSetAside(ctx: DecisionContext, weights: HeuristicWeights): SetAsideGoal | undefined {
  const { view, legalActions } = ctx;
  const me = view.priorityPlayer;
  const hand = view.players[me].hand;
  let any = false;
  for (const card of hand) {
    if (card.def.foretell !== undefined || card.def.plot !== undefined) {
      any = true;
      break;
    }
  }
  if (!any) return undefined;
  if (me !== view.activePlayer) return undefined;
  const sorcerySpeedOpen =
    (view.step === 'precombatMain' || view.step === 'postcombatMain') && view.stack.length === 0;
  const availableMana = totalAvailableMana(view, me);

  let best: SetAsideGoal | undefined;
  for (const card of hand) {
    const def = card.def;
    const method: 'foretell' | 'plot' | undefined =
      def.foretell !== undefined ? 'foretell' : def.plot !== undefined ? 'plot' : undefined;
    if (method === undefined) continue;
    if (method === 'plot' && !sorcerySpeedOpen) continue;
    const printed = def.cost;
    const manaValue = printed === undefined ? 0 : convertedManaCost(printed);
    // Castable this turn ⇒ not a set-aside candidate (see the policy above).
    if (printed !== undefined && def.noManaCost !== true && manaValue <= availableMana) continue;
    const score = weights.setAsideScore + manaValue * weights.setAsidePerManaValue;
    if (score <= weights.passScore) continue;
    if (best && score <= best.score) continue;
    const cost = method === 'foretell' ? FORETELL_COST : (def.plot as ManaCost);
    const plan = planManaPayment(view as GameState, me, cost, legalActions, def, 'activate', manaPreferenceOf(weights));
    if (!plan) continue;
    best = {
      action: { kind: method === 'foretell' ? 'foretellCard' : 'plotCard', player: me, instanceId: card.instanceId },
      plan,
      score,
      reason: ctx.trace ? `${method} ${def.name} (cannot cast it this turn)` : NO_REASON,
    };
  }
  return best;
}

/** Take the next step toward a set-aside play: tap for it, or set it aside. */
function pursueSetAside(ctx: DecisionContext, goal: SetAsideGoal): GameAction {
  const next = goal.plan[0];
  if (!next) return emit(ctx, goal.action, goal.reason, goal.score);
  const tap: GameAction = tapActionFor(ctx.view.priorityPlayer, next);
  return emit(ctx, tap, goal.reason, goal.score);
}


// --- §3.111 the graveyard-casting family --------------------------------------------

/**
 * What paying a keyword's NON-MANA rider costs the pilot, in the same points a
 * spell is scored in — read off the SAME candidate pool the engine will offer
 * the cast-time question from, so the pilot prices what it will actually pay.
 *
 *  - a DISCARD (retrace's land, jump-start's card) and a SACRIFICE (Dread
 *    Return's three creatures) are the `count` cheapest qualifying cards by
 *    `cardValue` — exactly the cards the pilot's own loss policy will hand over
 *    when the question is asked (`answerSelectCards`), so the price and the
 *    payment agree;
 *  - an EXILE from the graveyard (escape) and a TAP (Battle Screech) are a
 *    flat `graveyardFuelCardValue` per card: exiling yard is an option cost,
 *    not a card, and a tapped creature is a lost attack this turn, not a
 *    lost creature.
 */
function additionalCostPrice(
  state: GameState,
  me: PlayerId,
  cost: AdditionalCastCost,
  excludeInstanceId: InstanceId,
  weights: HeuristicWeights,
  index: ContinuousIndex,
): number {
  const count = cost.count ?? 1;
  if (cost.kind === 'exileFromGraveyard' || cost.kind === 'tap') return count * weights.graveyardFuelCardValue;
  const cards = cardValueContext(state, index);
  const values: number[] = [];
  for (const card of additionalCostPool(state, cost, me)) {
    if (card.instanceId === excludeInstanceId) continue;
    if (!matchesCardFilter(card, cost.filter)) continue;
    values.push(cardValue(card, weights, cards));
  }
  values.sort((a, b) => a - b);
  let total = 0;
  for (let i = 0; i < count && i < values.length; i++) total += values[i] as number;
  return total;
}

/** A graveyard-ability play the pilot wants to make: the offer (or the tap toward it), how good it is, why. */
interface GraveyardAbilityGoal {
  readonly action: GameAction;
  readonly score: number;
  readonly label: string;
}

/**
 * The best ability to activate FROM THE GRAVEYARD right now, or `undefined` —
 * unearth (CR 702.84a), scavenge (702.96a), embalm (702.128a), eternalize
 * (702.129a), encore (702.141a) and the "{cost}: Return ~ from your graveyard
 * to your hand" template. Priced by KIND, the closed vocabulary core defines,
 * because every one of these bodies reads its SOURCE and the effect-value
 * table has no source to read:
 *
 *  - **unearth / encore** buy ONE ATTACK — a hasty body that is exiled or
 *    sacrificed at the next end step — so they are worth the face damage it
 *    can deliver (the Kiki-Jiki pricing in `createTokenCopy`), plus whatever
 *    the creature's own enters-the-battlefield trigger does (Scrapwork Cohort's
 *    Soldier, Rotting Rats' discard), and NOTHING outside the precombat main
 *    phase, where the attack has already happened;
 *  - **scavenge** is +1/+1 counters equal to the card's printed power, put on
 *    the pilot's BEST attacker — the creature with the most stats it controls,
 *    which is what a permanent pump is worth the most on;
 *  - **embalm / eternalize** are a real body: the token's own P/T (eternalize's
 *    4/4 is printed in the exception), priced as a creature cast is;
 *  - **return to hand** is the card back, discounted by `graveyardReturnShare`
 *    because it still has to be cast.
 *
 * Funded through the SAME `planManaPayment` every spell goal uses, for the
 * reason `bestCycle` gives: the engine only OFFERS the activation once the pool
 * covers it. Cheapest question first — almost no deck holds one of these.
 */
function bestGraveyardAbility(
  ctx: DecisionContext,
  weights: HeuristicWeights,
  index: ContinuousIndex,
): GraveyardAbilityGoal | undefined {
  const { view, legalActions } = ctx;
  const me = view.priorityPlayer;
  const graveyard = view.players[me].graveyard;
  let any = false;
  for (const card of graveyard) {
    if (card.def.graveyardAbilities !== undefined && card.def.graveyardAbilities.length > 0) {
      any = true;
      break;
    }
  }
  if (!any) return undefined;
  const sorcerySpeedOpen =
    me === view.activePlayer && (view.step === 'precombatMain' || view.step === 'postcombatMain') && view.stack.length === 0;
  const attackAhead = me === view.activePlayer && view.step === 'precombatMain';
  let cards: ReturnType<typeof cardValueContext> | undefined;
  let best: GraveyardAbilityGoal | undefined;

  for (const card of graveyard) {
    const abilities = card.def.graveyardAbilities;
    if (abilities === undefined) continue;
    for (let a = 0; a < abilities.length; a++) {
      const ability = abilities[a] as GraveyardAbility;
      if ((ability.timing ?? 'instant') === 'sorcery' && !sorcerySpeedOpen) continue;
      // A sacrifice or life rider on one of these is not priced — no printed
      // card of the family carries one today — so it is left alone, never
      // guessed at (the `bestFundedActivation` discipline).
      if (ability.cost.sacrificeAnother !== undefined || (ability.cost.life ?? 0) > 0) continue;
      const mana = ability.cost.mana ?? {};

      let targets: readonly (InstanceId | PlayerId)[] = [];
      let score: number;
      switch (ability.kind) {
        case 'unearth':
        case 'encore': {
          if (!attackAhead) continue;
          const printedPower = Math.max(card.def.power ?? 0, 0);
          score = weights.faceDamageValue * printedPower;
          if (ability.kind === 'unearth' && card.def.triggers !== undefined) {
            cards ??= cardValueContext(view as GameState, index);
            for (const trigger of card.def.triggers) {
              if (trigger.condition.on !== 'etb') continue;
              score += valueOfEffects(trigger.effects, { state: view as GameState, player: me, targets: [], weights, cards, index });
            }
          }
          break;
        }
        case 'scavenge': {
          const counters = Math.max(card.def.power ?? 0, 0);
          if (counters === 0) continue;
          const restriction = restrictionOfEffects(ability.effects);
          if (restriction === undefined) continue;
          let bestAim: { ref: InstanceId; stats: number } | undefined;
          for (const ref of legalTargetsFor(view as GameState, restriction, me, card.def)) {
            if (typeof ref !== 'number') continue;
            const perm = view.battlefield.find((p) => p.instanceId === ref);
            if (!perm || perm.controller !== me) continue;
            const stats = statTotal(perm, index);
            if (!bestAim || stats > bestAim.stats) bestAim = { ref, stats };
          }
          if (!bestAim) continue;
          targets = [bestAim.ref];
          score = counters * 2 * weights.choiceCreaturePerStatValue;
          break;
        }
        case 'embalm':
        case 'eternalize': {
          const except = tokenExceptOf(ability);
          const tokenPower = except?.power ?? card.def.power ?? 0;
          const tokenToughness = except?.toughness ?? card.def.toughness ?? 0;
          score = weights.castCreatureBaseScore + weights.castCreaturePerStat * (tokenPower + tokenToughness);
          break;
        }
        case 'returnToHand': {
          cards ??= cardValueContext(view as GameState, index);
          score = cardValue(card, weights, cards) * weights.graveyardReturnShare;
          break;
        }
      }
      if (score <= weights.passScore) continue;
      if (best !== undefined && score <= best.score) continue;
      const plan = planManaPayment(view as GameState, me, mana, legalActions, card.def, 'activate', manaPreferenceOf(weights));
      if (!plan) continue;
      const offer = plan.length > 0 ? undefined : offeredGraveyardActivation(legalActions, card.instanceId, a, targets);
      if (plan.length === 0 && offer === undefined) continue;
      const action: GameAction = plan.length > 0 ? tapActionFor(me, plan[0] as ManaTapPlan) : (offer as GameAction);
      best = { action, score, label: ctx.trace ? `${ability.label} (${card.def.name})` : NO_REASON };
    }
  }
  return best;
}

/** The `except` tail an embalm/eternalize body carries, for the token's printed size. */
function tokenExceptOf(ability: GraveyardAbility): { readonly power?: number; readonly toughness?: number } | undefined {
  const raw = ability.effects[0]?.params?.except;
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  return raw as { readonly power?: number; readonly toughness?: number };
}

/**
 * The engine's own offer for this graveyard activation, never a rebuilt action
 * (the `offeredActivation` discipline): an action the menu did not contain is
 * an action the engine would refuse.
 */
function offeredGraveyardActivation(
  legalActions: readonly GameAction[],
  instanceId: InstanceId,
  abilityIndex: number,
  targets: readonly (InstanceId | PlayerId)[],
): GameAction | undefined {
  for (const action of legalActions) {
    if (action.kind !== 'activateGraveyardAbility') continue;
    if (action.instanceId !== instanceId || action.abilityIndex !== abilityIndex) continue;
    const offered = action.targets ?? [];
    if (offered.length !== targets.length) continue;
    let same = true;
    for (let i = 0; i < targets.length; i++) if (offered[i] !== targets[i]) same = false;
    if (same) return action;
  }
  return undefined;
}

/** The cast that carries out a scored goal, once its cost is in the pool. */
function castActionFor(me: PlayerId, goal: SpellGoal): GameAction {
  return {
    kind: 'castSpell',
    player: me,
    instanceId: goal.card.instanceId,
    targets: goal.targets.length > 0 ? goal.targets : undefined,
    // A flashback / aftermath / from-exile goal must say so, or the engine
    // looks for the card in hand; a second-half goal must name its face, or
    // the engine casts the other one.
    fromZone: goal.fromZone,
    face: goal.face,
    // §3.112 — an alternative-cost goal names its cost, or the engine charges
    // the printed one and the scored price was a lie.
    alternative: goal.alternative,
    // §3.111 — a retrace / jump-start / escape goal names its kind.
    ...(goal.graveyardCast !== undefined ? { graveyardCast: goal.graveyardCast } : {}),
    // §3.143 — a goal that chose to pay life for a Phyrexian symbol names the
    // amount, or the engine charges the all-mana reading the plan did not fund.
    ...(goal.phyrexianLife !== undefined ? { phyrexianLife: goal.phyrexianLife } : {}),
  };
}

/**
 * §3.112 — the action that carries out a goal: a `cycleCard` for a channel /
 * bloodrush activation from hand, the cast for everything else. One exit so
 * the two consumers (`pursueSpell`, the search policy) cannot disagree.
 */
function actionForGoal(me: PlayerId, goal: SpellGoal): GameAction {
  if (goal.handAbilityIndex !== undefined) {
    return {
      kind: 'cycleCard',
      player: me,
      instanceId: goal.card.instanceId,
      abilityIndex: goal.handAbilityIndex,
      ...(goal.targets.length > 0 ? { targets: goal.targets } : {}),
    };
  }
  return castActionFor(me, goal);
}

function pursueSpell(ctx: DecisionContext, funded: FundedGoal): GameAction {
  const { view } = ctx;
  const me = view.priorityPlayer;
  const { goal, plan } = funded;

  const next = plan[0];
  if (!next) return emit(ctx, actionForGoal(me, goal), goal.reason, goal.score);

  const tap: GameAction = tapActionFor(me, next);
  /*
   * THE PLAN SEAM'S CONTINUATION: the REST OF THE TAPS — and deliberately not
   * the cast. This is a promise (`Pilot.chooseActions`), kept because the next
   * decision re-derives exactly these taps: `totalAvailableMana` (pool plus
   * untapped sources) is invariant under a tap, so every goal keeps its score
   * and rank; the sort is stable over an unchanged hand; and `planManaPayment`
   * is greedy from the CURRENT pool, so the plan it returns after tap k is this
   * plan from k+1.
   *
   * ⚠️ THE CAST IS NOT PROMISED because the pilot does not always cast what it
   * tapped for, and the seam must reproduce the pilot, not improve it. Core's
   * planner cannot fund a HYBRID pip ({G/W}) from an empty pool, so a hand of
   * Kitchen Finks and Eternal Witness ranks Finks first, finds it "unfundable",
   * taps for Witness — and then, with G G B floating, re-scores the hand and
   * casts the Finks the pool now covers. Promising the cast turned that into a
   * different game (transcript diff, Mono-Green vs Golgari, seed 1). The taps
   * are the same either way, and they are 57% of the windows the seam takes.
   * Pinned by `packages/sim/src/action-plan.test.ts`.
   */
  if (planSink !== null) {
    for (let i = 1; i < plan.length; i++) planSink.push(tapActionFor(me, plan[i] as ManaTapPlan));
  }
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
 * THE ALPHA STRIKE — every eligible attacker, when swinging with all of them
 * cannot fail to end the game. `undefined` when it can fail.
 *
 * The defender's best case is assumed throughout, so a `true` here is a
 * GUARANTEE and never a hope:
 *
 *  - each untapped enemy creature blocks ONE attacker (CR 509.1 — one blocker
 *    may block one attacker unless something says otherwise), so N untapped
 *    creatures stop at most N attackers;
 *  - they stop the BIGGEST ones, which is the worst arrangement for us;
 *  - every remaining attacker connects for its effective power.
 *
 * If that pessimistic remainder still meets the opponent's life total, no
 * blocking assignment they can choose saves them, and the attack is correct
 * whatever it costs in creatures.
 *
 * ⚠️ WHAT IT DELIBERATELY DOES NOT MODEL, all in the direction of caution: an
 * untapped creature that CANNOT legally block (a flyer facing ground attackers,
 * a menace attacker needing two) is still counted as a blocker, and instant-speed
 * tricks, damage prevention and lifegain are ignored. Every one of those makes
 * this refuse an attack that was in fact lethal — a missed win, not a thrown
 * game. The reverse mistake is the one that must not happen.
 */
function lethalAlphaStrike(
  view: PilotView,
  opp: PlayerId,
  eligible: readonly InstanceId[],
  index: ContinuousIndex,
): readonly InstanceId[] | undefined {
  const life = view.players[opp]?.life ?? 0;
  if (life <= 0) return undefined; // already won; nothing to plan
  // TWO CLOCKS, judged separately (§3.105). An infect attacker's power is
  // poison and cannot be added to the life sum; a toxic attacker's power is
  // life damage with poison riding on it. Each clock is asked "is this group
  // alone lethal even if EVERY blocker is spent on it?" — the conservative
  // direction: however the defender actually splits blockers between the two
  // groups, the group they under-block connects for at least that much.
  const damagePowers: number[] = [];
  const poisonPowers: number[] = [];
  let total = 0;
  for (const id of eligible) {
    const attacker = findInstance(view, id);
    if (!attacker) continue;
    total += 1;
    const p = attackerPressure(attacker, power(attacker, index), index);
    if (p.damage > 0) damagePowers.push(p.damage);
    if (p.poison > 0) poisonPowers.push(p.poison);
  }
  if (total === 0) return undefined;
  const blockers = creaturesControlledBy(view, opp).filter((c) => !c.tapped).length;
  if (blockers >= total) return undefined; // they can block everything
  // Sort descending and drop the ones the defender would most want to stop.
  const connecting = (powers: number[]): number => {
    powers.sort((a, b) => b - a);
    let sum = 0;
    for (let i = blockers; i < powers.length; i++) sum += powers[i] as number;
    return sum;
  };
  if (connecting(damagePowers) >= life) return eligible;
  const remaining = poisonRemaining(view, opp);
  return poisonPowers.length > 0 && connecting(poisonPowers) >= remaining ? eligible : undefined;
}

/**
 * Choose attackers: send each eligible creature that profits — it either gets in
 * for face damage (opponent has no blocker that survives + kills it for free) or
 * wins/breaks even on the likely trade. Returns a (possibly empty) narrowed
 * `declareAttackers` the engine validates.
 */
/*
 * ATTACKING IS A SET DECISION, NOT N INDEPENDENT ONES (§3.83).
 *
 * `attackIsProfitable` judges each attacker as though every enemy blocker were
 * free to meet it. That is true of the FIRST attacker and false of every one
 * after: blockers are a finite, SHARED resource, and a defender with two bodies
 * cannot punish four attackers however bad each looks alone. The measurement that
 * pointed here (`bench/disagreement.mjs`): 100% of this pilot's disagreements with
 * `lookahead` are in `declareAttackers`, and 36.2% of those are both pilots
 * attacking with a DIFFERENT SET — not a different appetite, a different roster.
 *
 * So the set is scored as a whole: propose a few candidate attacks, model the
 * defence's best answer to each, and send the one that comes out ahead.
 *
 * ⚠️ THE DEFENDER MODEL IS GREEDY, AND DELIBERATELY SO. Optimal block assignment
 * is a matching problem, and this runs inside a decision that costs microseconds
 * (`bench/pilot-decide-bench.mjs`). A greedy defender — best block first — is the
 * same model the per-attacker code already uses, applied once to the whole attack
 * instead of once per attacker. Sharing the model matters more than sharpening it:
 * if this scored attacks with a better defender than the rest of the pilot
 * assumes, the two halves would disagree about the same board.
 *
 * ⚠️ PERFORMANCE IS WHY THIS READS AS IT DOES. The first version recomputed
 * `power`/`toughness`/`canBlockByEvasion` inside every candidate's scoring loop
 * and cost 11% of sim throughput — a rule-7 regression that would have had to be
 * paid back later. Everything that depends only on the BOARD is computed once
 * into flat arrays below, and each candidate set is then scored by reading them.
 */

/** One decision's worth of pre-computed combat facts — built once, read per set. */
interface AttackMatrix {
  readonly ids: readonly InstanceId[];
  readonly power: Float64Array;
  readonly toughness: Float64Array;
  /** Face value of connecting: damage plus whatever the hit sets off. */
  readonly faceValue: Float64Array;
  /** Our loss if this attacker dies (already weighted); 0 when it is doomed anyway. */
  readonly ourLoss: Float64Array;
  readonly blockerPower: Float64Array;
  readonly blockerToughness: Float64Array;
  /** Their loss if this blocker dies (already weighted). */
  readonly theirLoss: Float64Array;
  /** Value to the DEFENDER of blocker b meeting attacker a, or -1 when illegal. */
  readonly blockValue: Float64Array;
  readonly attackerCount: number;
  readonly blockerCount: number;
}

const ILLEGAL_BLOCK = -1;

function buildAttackMatrix(
  eligible: readonly InstanceId[],
  enemyBlockers: readonly CardInstance[],
  weights: HeuristicWeights,
  index: ContinuousIndex,
  view: PilotView,
): AttackMatrix | undefined {
  const doomed = delayedRemovalTargets(view);
  /*
   * ⚠️ ONE PASS FOR ATTACHMENTS, NOT ONE PER ATTACKER. `saboteurTriggerCount`
   * walks the whole battlefield looking for things attached to its argument, so
   * calling it per eligible attacker is O(attackers x battlefield) inside a
   * decision that runs hundreds of thousands of times a sim. The hosts are
   * collected here in a single sweep and read back in O(1) below.
   */
  const attachedSaboteurs = new Map<InstanceId, number>();
  const battlefield = view.battlefield;
  for (let i = 0; i < battlefield.length; i++) {
    const perm = battlefield[i] as CardInstance;
    const host = perm.attachedTo;
    // `!= null` for the same reason the engine uses it: an instance built before
    // this field existed must read as unattached.
    if (host == null) continue;
    const extra = countCombatDamageTriggers(perm.def.triggers, 'attachedHost');
    if (extra > 0) attachedSaboteurs.set(host, (attachedSaboteurs.get(host) ?? 0) + extra);
  }
  const attackers: CardInstance[] = [];
  const ids: InstanceId[] = [];
  for (const id of eligible) {
    const found = findInstance(view, id);
    if (found) {
      attackers.push(found);
      ids.push(id);
    }
  }
  if (attackers.length === 0) return undefined;

  const n = attackers.length;
  const m = enemyBlockers.length;
  const matrix: AttackMatrix = {
    ids,
    power: new Float64Array(n),
    toughness: new Float64Array(n),
    faceValue: new Float64Array(n),
    ourLoss: new Float64Array(n),
    blockerPower: new Float64Array(m),
    blockerToughness: new Float64Array(m),
    theirLoss: new Float64Array(m),
    blockValue: new Float64Array(n * m),
    attackerCount: n,
    blockerCount: m,
  };

  for (let a = 0; a < n; a++) {
    const attacker = attackers[a] as CardInstance;
    const pow = power(attacker, index);
    const tou = toughness(attacker, index);
    matrix.power[a] = pow;
    matrix.toughness[a] = tou;
    const saboteurs =
      countCombatDamageTriggers(attacker.def.triggers, 'self') +
      (attachedSaboteurs.get(attacker.instanceId) ?? 0);
    matrix.faceValue[a] = weights.faceDamageValue * pow + weights.attackSaboteurTriggerValue * saboteurs;
    // A creature the rules are about to take away costs its controller nothing —
    // the same pricing `attackIsProfitable` applies (CR 603.7).
    matrix.ourLoss[a] = doomed.has(attacker.instanceId) ? 0 : weights.ownCreatureLossPerStat * (pow + tou);
  }
  for (let b = 0; b < m; b++) {
    const blocker = enemyBlockers[b] as CardInstance;
    const pow = power(blocker, index);
    const tou = toughness(blocker, index);
    matrix.blockerPower[b] = pow;
    matrix.blockerToughness[b] = tou;
    matrix.theirLoss[b] = weights.killEnemyPerStat * (pow + tou);
  }
  for (let a = 0; a < n; a++) {
    const attacker = attackers[a] as CardInstance;
    // Menace and friends: a lone blocker cannot legally block at all, so no
    // single-blocker assignment may spend one pretending it can.
    const needsMany = needsMultipleBlockers(attacker, index);
    for (let b = 0; b < m; b++) {
      const blocker = enemyBlockers[b] as CardInstance;
      if (needsMany || !canBlockByEvasion(attacker, blocker, index, boardOf(view))) {
        matrix.blockValue[a * m + b] = ILLEGAL_BLOCK;
        continue;
      }
      const attackerDies = (matrix.blockerPower[b] as number) >= (matrix.toughness[a] as number);
      const blockerDies = (matrix.power[a] as number) >= (matrix.blockerToughness[b] as number);
      matrix.blockValue[a * m + b] =
        (attackerDies ? weights.killEnemyPerStat * ((matrix.power[a] as number) + (matrix.toughness[a] as number)) : 0) -
        (blockerDies ? (matrix.theirLoss[b] as number) : 0) +
        // Blocking always stops the damage, which is worth something even when
        // nothing dies — otherwise a wall reads as having no reason to block.
        (matrix.faceValue[a] as number);
    }
  }
  return matrix;
}

/**
 * Score one candidate attack from OUR side, after the defence answers it.
 *
 * `inSet` is a bitmask over the matrix's attacker order, so a candidate costs no
 * allocation at all — this is called once per candidate and the candidates are
 * enumerated per attack.
 */
function scoreAttackSet(matrix: AttackMatrix, inSet: number): number {
  const { attackerCount: n, blockerCount: m } = matrix;
  let blockedMask = 0;
  let usedBlockers = 0;
  let ourLoss = 0;
  let theirLoss = 0;

  // Greedy: repeatedly take the single best remaining block for the defender,
  // until no blocker gains by blocking (a defender never blocks for negative value).
  for (;;) {
    let bestValue = 0;
    let bestA = -1;
    let bestB = -1;
    for (let a = 0; a < n; a++) {
      if ((inSet & (1 << a)) === 0 || (blockedMask & (1 << a)) !== 0) continue;
      for (let b = 0; b < m; b++) {
        if ((usedBlockers & (1 << b)) !== 0) continue;
        const value = matrix.blockValue[a * m + b] as number;
        if (value === ILLEGAL_BLOCK) continue;
        if (value > bestValue) {
          bestValue = value;
          bestA = a;
          bestB = b;
        }
      }
    }
    if (bestA < 0 || bestB < 0) break;
    blockedMask |= 1 << bestA;
    usedBlockers |= 1 << bestB;
    if ((matrix.blockerPower[bestB] as number) >= (matrix.toughness[bestA] as number)) {
      ourLoss += matrix.ourLoss[bestA] as number;
    }
    if ((matrix.power[bestA] as number) >= (matrix.blockerToughness[bestB] as number)) {
      theirLoss += matrix.theirLoss[bestB] as number;
    }
  }

  let damage = 0;
  for (let a = 0; a < n; a++) {
    if ((inSet & (1 << a)) === 0 || (blockedMask & (1 << a)) !== 0) continue;
    damage += matrix.faceValue[a] as number;
  }
  return damage + theirLoss - ourLoss;
}

/**
 * Choose the attack by scoring whole SETS rather than creatures.
 *
 * The candidates are deliberately few: the greedy set the per-attacker rule
 * produces, the all-in set, and each single add/remove from greedy. That is O(n)
 * scored sets rather than the 2^n of a real search — and the local moves are
 * exactly the ones the per-attacker rule cannot see, since its error is always
 * "one more body than the defence can answer" or "one body that should have
 * stayed home".
 */
function bestAttackSet(
  eligible: readonly InstanceId[],
  greedy: readonly InstanceId[],
  enemyBlockers: readonly CardInstance[],
  weights: HeuristicWeights,
  index: ContinuousIndex,
  view: PilotView,
): InstanceId[] | undefined {
  // ⚠️ THE BITMASK CAPS THE ROSTER. Above 30 eligible attackers the masks would
  // overflow, and a wrong answer from a silent overflow is far worse than
  // declining to refine — the per-attacker roster is still a legal, sane attack.
  if (eligible.length === 0 || eligible.length > 30) return undefined;
  // With no blockers at all there is nothing to assign: every attacker connects,
  // so the best set is "everything that deals damage" and no search is needed.
  // This is the common case in the games that matter, and skipping it here is
  // most of why this rule is affordable.
  if (enemyBlockers.length === 0 || enemyBlockers.length > 30) return undefined;

  const matrix = buildAttackMatrix(eligible, enemyBlockers, weights, index, view);
  if (!matrix) return undefined;

  const indexOf = new Map<InstanceId, number>();
  matrix.ids.forEach((id, at) => indexOf.set(id, at));
  let greedyMask = 0;
  for (const id of greedy) {
    const at = indexOf.get(id);
    if (at !== undefined) greedyMask |= 1 << at;
  }
  const allMask = (1 << matrix.attackerCount) - 1;

  // The incumbent must be BEATEN, not merely matched: an equal score means the
  // change bought nothing, and holding still is the option with no variance.
  let bestMask = greedyMask;
  let bestScore = scoreAttackSet(matrix, greedyMask);
  const consider = (mask: number): void => {
    if (mask === bestMask) return;
    const value = scoreAttackSet(matrix, mask);
    if (value > bestScore) {
      bestScore = value;
      bestMask = mask;
    }
  };
  consider(allMask);
  for (let a = 0; a < matrix.attackerCount; a++) consider(greedyMask ^ (1 << a));

  // Never send a set that scores worse than staying home entirely.
  if (bestScore <= 0) return [];
  const chosen: InstanceId[] = [];
  for (let a = 0; a < matrix.attackerCount; a++) {
    if ((bestMask & (1 << a)) !== 0) chosen.push(matrix.ids[a] as InstanceId);
  }
  return chosen;
}

function chooseAttack(
  ctx: DecisionContext,
  weights: HeuristicWeights,
  index: ContinuousIndex,
  features: ResolvedFeatures,
): GameAction | undefined {
  const { view, legalActions } = ctx;
  const me = view.activePlayer;
  const opp = otherPlayer(me);
  const { alphaStrike, setAttack } = features;

  const offered = legalActions.find((a) => a.kind === 'declareAttackers') as
    | Extract<GameAction, { kind: 'declareAttackers' }>
    | undefined;
  if (!offered) return undefined; // no eligible attackers — fall through to pass

  const eligible = offered.attackers;
  const enemyBlockers = creaturesControlledBy(view, opp).filter((c) => !c.tapped);

  // ⚠️ LETHAL IS CHECKED BEFORE PROFIT, because profit is the wrong question when
  // the game can be ended. Every attacker below is judged INDEPENDENTLY — "does
  // this creature come out ahead against their blockers?" — and three 2/2s each
  // individually lose to one 4/4, so a swing that wins on the spot was being
  // declined one creature at a time. A pilot that can win this turn and does not
  // is not being careful, it is misplaying.
  const alpha = alphaStrike ? lethalAlphaStrike(view, opp, eligible, index) : undefined;
  const chosen: InstanceId[] = [];
  if (alpha) {
    chosen.push(...alpha);
  } else {
    for (const id of eligible) {
      const attacker = findInstance(view, id);
      if (!attacker) continue;
      if (attackIsProfitable(attacker, enemyBlockers, weights, index, view)) chosen.push(id);
    }
    if (setAttack) {
      // The per-attacker pass above is the STARTING POINT, not the answer: it
      // cannot see that blockers are shared. Re-judge the roster as a set — and
      // keep the per-attacker roster when the refiner declines (no blockers to
      // assign, or a board too large for the bitmask).
      const refined = bestAttackSet(eligible, chosen, enemyBlockers, weights, index, view);
      if (refined !== undefined) {
        chosen.length = 0;
        chosen.push(...refined);
      }
    }
  }

  // ATTACK REQUIREMENTS (CR 508.1d, §3.107): a creature that "attacks each
  // combat if able" is added whatever the profit judgement said — leaving it
  // home is an illegal declaration, and passing would only have the engine
  // declare it alone. Same reference back when nothing was required.
  const roster = withRequiredAttackers(view, index, chosen, eligible);
  if (roster !== chosen) {
    chosen.length = 0;
    chosen.push(...roster);
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
export function planWalkerAttack(
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

  // Fewest attackers: biggest first until the need is covered — and among equals,
  // the one with the LEAST to lose by being diverted.
  //
  // "Whenever ~ deals combat damage to a PLAYER" pays nothing when its creature
  // is sent at a planeswalker, so diverting the saboteur and leaving the vanilla
  // to hit the face throws the trigger away for free. Two attackers of the same
  // size are otherwise interchangeable here, which is exactly the case where
  // getting this backwards is invisible.
  const byPowerDesc = [...attackers].sort((a, b) => {
    const byPower = power(b, index) - power(a, index);
    if (byPower !== 0) return byPower;
    return saboteurTriggerCount(a, view) - saboteurTriggerCount(b, view);
  });
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
 *
 * ⚠️ **THIS READS THE PRINTED BOXES ON PURPOSE, AND THE PURPOSE IS A
 * MEASUREMENT (DESIGN §3.43).** `pickBlocker` asks `resolveFight` who dies;
 * this does not, so the pilot knowingly over-rates its own attacks into a
 * deathtoucher — 946 of them per 100 gauntlet games against Mono-Green Ramp.
 * Two further things were built, measured and REJECTED, and re-deriving them is
 * a day of work that ends where it started:
 *
 *  1. **Teaching this function `resolveFight` too.** Correct, and it makes the
 *     pilot passive: nothing profitably attacks into a Deadly Recluse, both
 *     seats sit, and the board locks. Selesnya Blink vs Mono-Green Ramp went
 *     51% → 27%, the gauntlet's timeout draws 10 → 29 and throughput 45 → 43
 *     games/sec (20 g/s in that matchup) — a stalled game is not a better one.
 *  2. **Also allocating the defender's blockers**, so one 1/2 cannot deter three
 *     attackers at once. That un-stalls it beautifully (draws 29 → 1, throughput
 *     to 63 g/s, Selesnya to 74%) and it loses the deck-neutral A/B against
 *     `main`'s pilot 1406–1422 — because it frees marginal attackers and this
 *     pilot has NO model of the crack-back it just tapped out for.
 *
 * The gauntlet row and the pilot's strength moved in opposite directions, and
 * the row is the one that lies: both seats run this pilot, so a change that
 * suits one archetype tilts the meta rather than raising the ceiling. The
 * honest next step is a crack-back model (what my board can still block after
 * these attackers tap), not another pass at this predicate.
 */
function attackIsProfitable(
  attacker: CardInstance,
  enemyBlockers: readonly CardInstance[],
  weights: HeuristicWeights,
  index: ContinuousIndex,
  view: PilotView,
): boolean {
  const myPower = power(attacker, index);
  const myTough = toughness(attacker, index);
  if (myPower <= 0) return false; // a 0-power attacker accomplishes nothing

  /*
   * ⚠️ A CREATURE THE RULES ARE ABOUT TO TAKE AWAY IS FREE TO ATTACK WITH, and
   * this is the line that makes a delayed sacrifice (CR 603.7) a COST the pilot
   * actually prices. Kiki-Jiki's token is sacrificed at the beginning of the
   * next end step whatever happens, so trading it for a blocker is pure profit
   * and holding it back as a blocker throws it away for nothing — attacking with
   * it is the entire point of the card.
   *
   * Expressed as "the opponent gains nothing by killing it" rather than as a
   * bonus, because that is exactly what is true: the opponent's best block is
   * still weighed, their own blocker is still a real loss to them, and only OUR
   * side of the trade is written down to zero.
   */
  const doomed = delayedRemovalTargets(view).has(attacker.instanceId);

  // The opponent will block if a blocker kills us and the trade favours them.
  // Find the blocker that would profitably kill us; if one exists, weigh the trade.
  let bestEnemyValue = -Infinity; // value to the OPPONENT of their best block
  let eligibleBlockers = 0;
  for (const b of enemyBlockers) {
    if (!canBlockByEvasion(attacker, b, index, boardOf(view))) continue;
    eligibleBlockers += 1;
    const bPower = power(b, index);
    const bTough = toughness(b, index);
    const attackerDies = !doomed && bPower >= myTough;
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
  // no deterrent and this attack is really unopposed. CORE'S count, so Pathrazer
  // of Ulamog's three is three here rather than menace's two — a local constant
  // for "how many" is the same mirror that produced §3.121.
  const blockersNeeded = Math.max(1, requiredBlockerCount(attacker, index));
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
  // damage) or blocking only loses them value. Attack for the face-damage value
  // PLUS what connecting is worth beyond the damage — every triggered ability
  // that fires on combat damage to a player, the attacker's own and the ones its
  // Equipment lends it.
  //
  // Counted only HERE, in the branch where the attack is expected to get
  // through. A saboteur trigger pays nothing when the attacker is blocked, so
  // adding it to the trade branch above would be a pilot walking into removal
  // for a benefit it is not going to collect.
  const faceValue =
    weights.faceDamageValue * myPower +
    weights.attackSaboteurTriggerValue * saboteurTriggerCount(attacker, view);
  return faceValue >= weights.attackValueThreshold;
}


/**
 * How many "whenever ~ deals combat damage to a player" abilities THIS creature
 * would set off by connecting — the ones printed on it, plus the ones its
 * attached Auras and Equipment watch it with.
 *
 * The attachments are searched from the battlefield rather than read off the
 * creature, because the relationship only exists in one direction: an
 * attachment knows its host (`attachedTo`), a host knows nothing about what is
 * on it. Both halves are read from the same core data the ENGINE matches on
 * (`TriggerCondition.on` / `.watches`), so the pilot cannot value a trigger the
 * engine would not fire.
 *
 * Cost: the battlefield walk happens only for a creature that got as far as the
 * unblocked branch of the attack evaluation, and it stops at one property read
 * per permanent for every board with no attachment on it.
 */
export function saboteurTriggerCount(attacker: CardInstance, view: PilotView): number {
  let count = countCombatDamageTriggers(attacker.def.triggers, 'self');
  const battlefield = view.battlefield;
  for (let i = 0; i < battlefield.length; i++) {
    const perm = battlefield[i] as CardInstance;
    if (perm.attachedTo !== attacker.instanceId) continue;
    count += countCombatDamageTriggers(perm.def.triggers, 'attachedHost');
  }
  return count;
}

/** Triggers on `combatDamageToPlayer` with the given watch scope. */
function countCombatDamageTriggers(
  triggers: readonly TriggeredAbility[] | undefined,
  watches: 'self' | 'attachedHost',
): number {
  if (triggers === undefined) return 0;
  let count = 0;
  for (let i = 0; i < triggers.length; i++) {
    const condition = (triggers[i] as TriggeredAbility).condition;
    if (condition.on !== 'combatDamageToPlayer') continue;
    if ((condition.watches ?? DEFAULT_TRIGGER_WATCHES) !== watches) continue;
    count += 1;
  }
  return count;
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
  features: ResolvedFeatures,
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
  // Both clocks (§3.105): lethal asked of each, desperation when EITHER is short
  // — nine poison is the poison clock's "one life", whatever the life total says.
  const pressure = attackPressure(view, combat.attackers, me, index);
  const incomingDamage = lifeEquivalent(pressure, weights);
  const facingLethal = pressureIsLethal(view, me, pressure);
  // ⚠️ A FIXED LIFE TOTAL, ON PURPOSE. Replacing it with the clock — chump only
  // when the opponent's PROVEN crack-back would finish what this attack starts
  // — measured CONFIRMED WEAKER (held-out 24/43, §3.108), on top of §3.89's
  // finding that the threshold is at its optimum in both directions.
  const desperate =
    facingLethal ||
    myLife <= weights.desperateLifeThreshold ||
    poisonRemaining(view, me) * weights.poisonCounterLifeEquivalent <= weights.desperateLifeThreshold;

  const availableBlockers = creaturesControlledBy(view, me).filter((c) => !c.tapped);
  const used = new Set<InstanceId>();
  const blocks: { blocker: InstanceId; attacker: InstanceId }[] = [];

  // Sort attackers by face threat desc — block the biggest hits first (most life
  // saved / worst threat removed). Face threat is power on the life scale, so an
  // infect attacker sorts ahead of a vanilla one of the same power.
  const attackers = [...combat.attackers]
    .map((id) => findInstance(view, id))
    .filter((c): c is CardInstance => c !== undefined)
    .sort((a, b) => faceThreat(b, index, weights) - faceThreat(a, index, weights));

  // BLOCK REQUIREMENTS FIRST (CR 509.1c/d). These are not a preference — a
  // declaration that satisfies fewer requirements than it could is REJECTED
  // WHOLESALE, so a pilot that picked its favourite blocks first and then noticed
  // the lure would lose every one of them. Core's own solver answers it, so the
  // pilot and the engine cannot disagree about what the rule demands; it returns
  // `undefined` after one keyword pass when nothing on the board requires
  // anything, which is every ordinary combat.
  // The live board rides into the solver and the per-pair check for LANDWALK
  // (§3.107): "able to block" must read the same lands the engine reads.
  const board = boardOf(view);
  const forced = forcedBlockAssignment(attackers, availableBlockers, index, board);
  if (forced) {
    for (const assignment of forced) {
      blocks.push(assignment);
      used.add(assignment.blocker);
    }
  }

  // Read ONCE per block decision, not per candidate: it is the shared frozen
  // empty set by reference in every game with no delayed ability at all.
  const doomed = delayedRemovalTargets(view);
  for (const attacker of attackers) {
    const blocker = pickBlocker(attacker, availableBlockers, used, desperate, weights, index, doomed, board);
    if (blocker) {
      blocks.push({ blocker: blocker.instanceId, attacker: attacker.instanceId });
      used.add(blocker.instanceId);
    }
  }
  if (features.gangBlock) {
    addGangBlocks(attackers, availableBlockers, used, blocks, desperate, weights, index, doomed, board);
  }

  // THE LAST GATE: ask the ENGINE whether this declaration stands, and drop
  // blocks until it does. See {@link legalizeBlocks} — this is the guard that
  // makes the recurring "the pilot's copy of a rule was missing a clause"
  // defect cost a block instead of the whole declaration.
  const forcedAttackers = new Set((forced ?? []).map((a) => a.attacker));
  legalizeBlocks(attackers, blocks, forcedAttackers, index, availableBlockers, board);

  // Declaring zero blocks via an empty `declareBlockers` would leave combat.blocks
  // empty and get us re-offered the same choice forever, so no block declaration
  // is made. What happens INSTEAD is a fall-through, not a pass.
  //
  // ⚠️ This used to `return` a pass, and that short-circuit made every
  // instant-speed response in the declare-blockers step unreachable for a pilot
  // that had decided not to block — a fog, a combat trick, a burn spell to
  // finish the turn. "Nothing is worth blocking" is an answer to WHICH BLOCKS,
  // not to what to do with priority; the priority logic below ends in the same
  // pass when nothing is worth casting, so the loop-avoidance is unchanged and
  // only the considered options grow.
  if (blocks.length === 0) return undefined;
  const action: GameAction = { kind: 'declareBlockers', player: me, blocks };
  if (!ctx.trace) return emit(ctx, action, NO_REASON);
  const reason =
    facingLethal ? `block to avoid lethal (${incomingDamage} incoming vs ${myLife} life)`
    : forced ? `block ${blocks.length} attacker(s) — ${forced.length} forced by a block requirement`
    : `block ${blocks.length} attacker(s) for value`;
  return emit(ctx, action, reason);
}

/**
 * THE ASK-CORE GATE on a finished block declaration: hand `blocks` to the
 * engine's own judge and shed pairs, in place, until it stands.
 *
 * ## Why this exists at all
 * Everything above already tries to propose only legal blocks — and three times
 * now it has been WRONG in the same way, because it was answering a rules
 * question with a local copy of the rule that was missing a clause (protection,
 * landwalk, "can't be blocked by more than one creature"). The copies are gone
 * (`canBlockByEvasion` and `blockCountAllowedFor` are core's answers now), but
 * "the pilot got the rule right" is a claim that has failed repeatedly, and the
 * PRICE of it failing is what makes this worth a check: one illegal pair makes
 * the WHOLE `declareBlockers` illegal, the harness passes priority after three
 * rejections, and the defender takes the ENTIRE attack unblocked. A guard that
 * turns "lose every block" into "lose one block" is worth its cost.
 *
 * ## What it drops, and what it will not
 * Pairs are shed one ATTACKER AT A TIME, last-proposed first, because the count
 * rules (menace, "except by N or more") are about the group: dropping one of a
 * menacing attacker's two blockers makes the declaration illegal for a new
 * reason. Attackers whose block came from core's CR 509.1c/d solver are never
 * dropped — those blocks are REQUIRED, and shedding one is the other way to
 * have a declaration rejected.
 *
 * ## Cost
 * One `illegalBlockDeclaration` call per declaration on the happy path, which
 * returns after a single keyword read per attacker when nothing on the board
 * prints a count rule or a requirement — the ordinary combat. The shedding loop
 * runs only when the engine has actually refused something.
 *
 * EXPORTED for its own test. A safety net whose behaviour is only ever reached
 * when something else is already broken is a net nobody can prove is there —
 * `gang-block-landwalk.test.ts` hands it a declaration the engine refuses and
 * checks WHICH blocks survive.
 */
export function legalizeBlocks(
  attackers: readonly CardInstance[],
  blocks: { blocker: InstanceId; attacker: InstanceId }[],
  forcedAttackers: ReadonlySet<InstanceId>,
  index: ContinuousIndex,
  defenders: readonly CardInstance[],
  battlefield: readonly CardInstance[],
): void {
  // Bounded by the number of attackers: every pass either returns or removes one
  // attacker's whole group, and a group is never re-added.
  for (let guard = attackers.length; guard >= 0; guard--) {
    if (blocks.length === 0) return;
    if (illegalBlockDeclaration(attackers, blocks, index, defenders, battlefield) === undefined) return;
    let dropped = false;
    for (let i = blocks.length - 1; i >= 0; i--) {
      const attacker = (blocks[i] as { attacker: InstanceId }).attacker;
      if (forcedAttackers.has(attacker)) continue;
      for (let j = blocks.length - 1; j >= 0; j--) {
        if ((blocks[j] as { attacker: InstanceId }).attacker === attacker) blocks.splice(j, 1);
      }
      dropped = true;
      break;
    }
    // Only required blocks are left and the engine still refuses them: that is
    // core's own solver disagreeing with core's own judge, which this pilot
    // cannot repair. Declare nothing rather than something rejected.
    if (!dropped) {
      blocks.length = 0;
      return;
    }
  }
  blocks.length = 0;
}

/**
 * Pick the best unused blocker for an attacker, or undefined to take the damage.
 * When desperate (facing lethal / low life) we chump-block to survive even at a
 * loss; otherwise we block only for a favourable-or-even trade.
 *
 * Who dies is `resolveFight`'s answer, not the printed boxes — so a deathtoucher
 * is a blocker, a first-striker that kills outright is not a trade, and against a
 * TRAMPLER the body chosen is the one that soaks the most (DESIGN §3.43).
 *
 * Exported (with `canBlockByEvasion`, `needsMultipleBlockers`, `planWalkerAttack`
 * and `saboteurTriggerCount`) for `combat-forecast.ts`
 * (DESIGN §3.47): the lookahead pilot predicts the DEFENDER's response with this
 * exact function, so the model and the modelled defender cannot drift apart.
 * Export-only — no behaviour here changed.
 */
export function pickBlocker(
  attacker: CardInstance,
  blockers: readonly CardInstance[],
  used: Set<InstanceId>,
  desperate: boolean,
  weights: HeuristicWeights,
  index: ContinuousIndex,
  /** Permanents a delayed ability will remove anyway — see {@link attackIsProfitable}. */
  doomed: ReadonlySet<InstanceId>,
  /** The live board, for LANDWALK's read of the defender's lands (§3.107). Required — see `canBlockByEvasion`. */
  battlefield: readonly CardInstance[],
): CardInstance | undefined {
  // A creature that can only be blocked by two or more is one this pilot cannot
  // block at all: it assigns a single blocker per attacker, and a lone blocker on
  // a menacing attacker makes the WHOLE declaration illegal - so every other
  // block in the same action is lost with it.
  if (needsMultipleBlockers(attacker, index)) return undefined;
  const aPower = power(attacker, index);
  const aTough = toughness(attacker, index);

  let best: CardInstance | undefined;
  let bestValue = -Infinity;
  for (const b of blockers) {
    if (used.has(b.instanceId)) continue;
    if (!canBlockByEvasion(attacker, b, index, battlefield)) continue;
    const bPower = power(b, index);
    const bTough = toughness(b, index);
    // Who actually dies — deathtouch, first strike, indestructible and damage
    // already marked, rather than `aPower >= bTough`. See `combat-math.ts` for
    // the four cards' worth of difference that makes, and for why the ATTACK
    // decision deliberately still reads the printed boxes.
    const outcome = resolveFight(attacker, b, index);
    const { attackerDies, blockerDies } = outcome;
    // Trade value to US: gain by killing the attacker, lose by losing our blocker,
    // and pay for whatever this body fails to stop — see `blockTrampleLeakPerPoint`.
    // A blocker the rules will remove at end of turn anyway costs us NOTHING
    // when it dies — the free chump block. Only OUR side of the trade is
    // written down to zero; the attacker's fate is still the real fight.
    const blockerLossCounts = blockerDies && !doomed.has(b.instanceId);
    const value =
      (attackerDies ? weights.killEnemyPerStat * (aPower + aTough) : 0) -
      (blockerLossCounts ? weights.ownCreatureLossPerStat * (bPower + bTough) : 0) -
      weights.blockTrampleLeakPerPoint * outcome.damageThrough;
    if (value > bestValue) {
      bestValue = value;
      best = b;
    }
  }

  if (!best) return undefined;
  if (desperate) return best; // survive at any cost — chump if needed
  return bestValue >= weights.blockValueThreshold ? best : undefined;
}

/**
 * GANG BLOCKS — two blockers on one attacker that neither can profitably meet
 * alone (§3.108). Added after the single-blocker pass, for the attackers it left
 * unblocked, from the blockers it left unused; so nothing the shipped rule
 * decided is revisited, only what it could not express.
 *
 * The fight is priced exactly as the engine resolves it: the attacker assigns
 * lethal damage to its blockers in ASCENDING INSTANCE-ID order (`combat.blocks`
 * is a map keyed by blocker id, and the engine walks its entries), tramples the
 * remainder, and both blockers strike back at once. A first-striker on either
 * side changes that sequence and is left to the single-block rule, which reads
 * `resolveFight` — this pricing does not pretend to know what it does not model.
 *
 * Two shapes are taken:
 *   - a pair that KILLS the attacker and comes out ahead on the same trade
 *     ruler `pickBlocker` uses (`blockValueThreshold`);
 *   - a MENACE attacker (or any "except by two or more") when this seat is
 *     desperate — the one attacker a lone chump can never stop, so the best
 *     pair stops it whatever it costs, exactly as `pickBlocker`'s desperate
 *     rule spends one body.
 */
function addGangBlocks(
  attackers: readonly CardInstance[],
  blockers: readonly CardInstance[],
  used: Set<InstanceId>,
  blocks: { blocker: InstanceId; attacker: InstanceId }[],
  desperate: boolean,
  weights: HeuristicWeights,
  index: ContinuousIndex,
  doomed: ReadonlySet<InstanceId>,
  /** The live board — landwalk reads the defender's lands (§3.107). */
  battlefield: readonly CardInstance[],
): void {
  if (blockers.length - used.size < 2) return;
  const blocked = new Set<InstanceId>();
  for (let i = 0; i < blocks.length; i++) blocked.add((blocks[i] as { attacker: InstanceId }).attacker);

  for (const attacker of attackers) {
    if (blocked.has(attacker.instanceId)) continue;
    const ak = keywordsOf(attacker, index);
    if (ak.firstStrike === true || ak.doubleStrike === true || ak.indestructible === true) continue;
    const aPower = power(attacker, index);
    const aTough = toughness(attacker, index);
    const aToughLeft = Math.max(1, toughnessLeft(attacker, index));
    // This search forms PAIRS, so the only question it has about the count rule
    // is "is a block of exactly two legal here?" — asked of core, which answers
    // from BOTH bounds at once. Pathrazer of Ulamog needs three and Bristling
    // Boar permits one; pairing two onto either makes the whole declaration
    // illegal and costs every other block in it (§3.121, soak 3455580742).
    if (!blockCountAllowedFor(attacker, GANG_BLOCK_SIZE, index)) continue;
    // A lone blocker would be illegal here, so the pair is the ONLY way this
    // attacker can be opposed — the desperate case spends a pair whatever it costs.
    const mustGang = !blockCountAllowedFor(attacker, 1, index);
    const kill = weights.killEnemyPerStat * (aPower + aTough);

    let bestValue = -Infinity;
    let bestFirst: CardInstance | undefined;
    let bestSecond: CardInstance | undefined;
    for (let i = 0; i < blockers.length; i++) {
      const one = blockers[i] as CardInstance;
      if (used.has(one.instanceId) || !canBlockByEvasion(attacker, one, index, battlefield)) continue;
      const oneK = keywordsOf(one, index);
      if (oneK.firstStrike === true || oneK.doubleStrike === true) continue;
      for (let j = i + 1; j < blockers.length; j++) {
        const two = blockers[j] as CardInstance;
        if (used.has(two.instanceId) || !canBlockByEvasion(attacker, two, index, battlefield)) continue;
        const twoK = keywordsOf(two, index);
        if (twoK.firstStrike === true || twoK.doubleStrike === true) continue;
        // The engine's order: the lower id takes lethal first.
        const first = one.instanceId < two.instanceId ? one : two;
        const second = first === one ? two : one;
        const firstK = first === one ? oneK : twoK;
        const secondK = first === one ? twoK : oneK;

        const dealt = power(first, index) + power(second, index);
        const attackerDies =
          dealt >= aToughLeft ||
          (power(first, index) > 0 && firstK.deathtouch === true) ||
          (power(second, index) > 0 && secondK.deathtouch === true);
        if (!attackerDies && !(desperate && mustGang)) continue;

        let remaining = aPower;
        const needFirst = ak.deathtouch === true ? 1 : Math.max(1, toughnessLeft(first, index));
        const toFirst = Math.min(remaining, needFirst);
        remaining -= toFirst;
        const firstDies = toFirst > 0 && toFirst >= needFirst && firstK.indestructible !== true;
        const needSecond = ak.deathtouch === true ? 1 : Math.max(1, toughnessLeft(second, index));
        const toSecond = Math.min(remaining, needSecond);
        remaining -= toSecond;
        const secondDies = toSecond > 0 && toSecond >= needSecond && secondK.indestructible !== true;
        const through = ak.trample === true ? remaining : 0;

        const value =
          (attackerDies ? kill : 0) -
          (firstDies && !doomed.has(first.instanceId)
            ? weights.ownCreatureLossPerStat * statTotal(first, index)
            : 0) -
          (secondDies && !doomed.has(second.instanceId)
            ? weights.ownCreatureLossPerStat * statTotal(second, index)
            : 0) -
          weights.blockTrampleLeakPerPoint * through;
        if (value > bestValue) {
          bestValue = value;
          bestFirst = first;
          bestSecond = second;
        }
      }
    }
    if (bestFirst === undefined || bestSecond === undefined) continue;
    if (!(desperate && mustGang) && bestValue < weights.blockValueThreshold) continue;
    blocks.push({ blocker: bestFirst.instanceId, attacker: attacker.instanceId });
    blocks.push({ blocker: bestSecond.instanceId, attacker: attacker.instanceId });
    used.add(bestFirst.instanceId);
    used.add(bestSecond.instanceId);
    blocked.add(attacker.instanceId);
    if (blockers.length - used.size < 2) return;
  }
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
    if (ref.primitive === PRIMITIVE.copySpell) return { kind: 'copySpell' };
    if (ref.primitive === PRIMITIVE.blinkTarget) return { kind: 'blink' };
    if (ref.primitive === PRIMITIVE.destroyAll) return { kind: 'sweeper' };
    if (ref.primitive === PRIMITIVE.preventDamage) {
      return {
        kind: 'fog',
        combatOnly: ref.params?.combat === true,
        // "…dealt to YOU this turn" (Riot Control) guards one seat; a plain fog
        // (Fog, Darkness) stops the whole combat damage step for everybody, which
        // on this side of the table is the same thing when we are being attacked.
        protectsMeOnly: stringParam(ref.params, 'scope', 'any') === 'you',
      };
    }
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
  weights: HeuristicWeights,
): CardInstance | undefined {
  let best: CardInstance | undefined;
  for (const c of creatures) {
    if (toughnessLeft(c, index) > amount) continue;
    if (!best) {
      best = c;
      continue;
    }
    const cp = threatRank(c, index, weights);
    const bp = threatRank(best, index, weights);
    if (cp > bp || (cp === bp && toughness(c, index) > toughness(best, index))) best = c;
  }
  return best;
}

/**
 * How threatening a creature is, in POWER UNITS — its effective power plus what a
 * printed block requirement is worth.
 *
 * A LURE IS A THREAT, NOT A GIFT. "Must be blocked if able" does not make the
 * creature easier to deal with; it takes the defender's blockers away from every
 * other attacker, so a 1/1 carrying one can be the card that decides the combat.
 * A pilot ranking removal targets by body size alone points its removal at the
 * biggest body and then loses to the attack the lure enabled.
 *
 * Adding to POWER rather than replacing the comparison keeps the existing
 * power-then-toughness ordering byte-for-byte unchanged on every board where
 * nothing requires a block — which is every board this pool could build before
 * requirements existed.
 */
function threatRank(creature: CardInstance, index: ContinuousIndex, weights: HeuristicWeights): number {
  // `faceThreat` is `power` priced on the life scale (§3.105): an infect 2/2
  // is the four-damage clock it actually is, a toxic 1/1 carries its counters.
  // Byte-identical to bare power on every creature without either keyword.
  return (
    faceThreat(creature, index, weights) +
    (hasBlockRequirement(creature, index) ? weights.blockRequirementThreatValue : 0)
  );
}

/** The biggest threat among creatures: highest threat rank, then toughness. */
function biggestThreat(
  creatures: readonly CardInstance[],
  index: ContinuousIndex,
  weights: HeuristicWeights,
): CardInstance | undefined {
  let best: CardInstance | undefined;
  for (const c of creatures) {
    if (!best) {
      best = c;
      continue;
    }
    const cp = threatRank(c, index, weights);
    const bp = threatRank(best, index, weights);
    if (cp > bp || (cp === bp && toughness(c, index) > toughness(best, index))) best = c;
  }
  return best;
}

// `totalIncomingDamage` used to live here. It became `attackPressure` in
// `poison-pressure.ts` (§3.105), which answers the same question as a PAIR —
// life damage and poison — with the same once-per-swing replacement projection.

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
 * Whether `blocker` could legally block `attacker` PER PAIR — CORE'S OWN
 * ANSWER, not a mirror of it.
 *
 * ⚠️ This function used to be a hand-written copy of `canBlock`, and every
 * revision of it was core's rule MINUS A CLAUSE: protection (§3.102 — every
 * white creature kept proposing a block on Black Knight, seed 1948110550),
 * landwalk (§3.110 — the gang search called it with no board), fear/intimidate,
 * the comparing restrictions. One illegal pair rejects the WHOLE declaration,
 * so each omission cost the defender every other block in the same action. The
 * copy is deleted; the rule is asked of the engine that judges it.
 *
 * It stays a named function (and stays exported) because `combat-forecast.ts`
 * models the defender with it and the call sites read as "could this block
 * happen" — but it is now a one-line delegation, so there is nothing left to
 * drift.
 *
 * ⚠️ It is still only the PER-PAIR half (CR 509.1a). The COUNT rules are
 * {@link blockerCountAllowed} and the whole declaration is
 * `illegalBlockDeclaration`; both are core's too.
 */
export function canBlockByEvasion(
  attacker: CardInstance,
  blocker: CardInstance,
  index: ContinuousIndex,
  // REQUIRED, not defaulted (§3.110 integration): a default of "no lands" is
  // what let the gang-block search (§3.108) call this without the board and
  // propose a block on an islandwalker whose defender controlled an Island —
  // the engine refused the whole declaration and the soak caught it. Every
  // caller holds a view; make it say so.
  battlefield: readonly CardInstance[],
): boolean {
  // `canBlock` also refuses a TAPPED blocker, which every caller here has
  // already filtered out (`chooseBlock` builds `availableBlockers` from untapped
  // creatures, and the forecast models the same list) — so the delegation is
  // exact for these callers and strictly safer for any future one.
  return canBlock(attacker, blocker, index, battlefield);
}

/**
 * Whether this creature carries a block REQUIREMENT — "must be blocked if able" /
 * "all creatures able to block it do so".
 *
 * Read EFFECTIVE, because both are grantable (Irresistible Prey hands one out for
 * a turn) and a pilot reading the printed box would miss exactly the case the
 * card was played for.
 */
function hasBlockRequirement(creature: CardInstance, index: ContinuousIndex): boolean {
  const keywords = keywordsOf(creature, index);
  return keywords.mustBeBlocked === true || keywords.blockedByAllAble === true;
}

/**
 * How many blockers the gang-block search assigns to one attacker. It builds
 * PAIRS, so an attacker whose legal count window excludes exactly two is one it
 * cannot block at all — see `addGangBlocks`.
 */
const GANG_BLOCK_SIZE = 2;

/**
 * May exactly `count` creatures block this attacker? CORE'S ANSWER (CR 509.1b),
 * asked rather than mirrored.
 *
 * ⚠️ The mirror this replaces is the repo's most-repeated defect. It began as a
 * boolean "needs two?", which read Pathrazer of Ulamog (three) and a menacing
 * 2/2 as the same case and had the gang search pair two blockers onto the
 * Pathrazer; it was widened to a NUMBER (the minimum) and then read Bristling
 * Boar ("can't be blocked by MORE than one creature") as unconstrained and
 * paired two blockers onto that (soak seed 3455580742). Both halves of the rule
 * are one question, and `blockerCountAllowed` is where that question is
 * answered — so the next printing of it needs no change here at all.
 */
function blockCountAllowedFor(attacker: CardInstance, count: number, index: ContinuousIndex): boolean {
  return blockerCountAllowed(attacker, count, index);
}

/**
 * Whether this attacker needs more than one blocker at all — the question the
 * single-blocker path asks, kept as a named predicate because "proposing ANY
 * lone block on this creature is proposing an illegal declaration" is what it
 * means at that call site. Asked of core, which also makes it true for an
 * attacker that may take no blockers at all.
 */
export function needsMultipleBlockers(attacker: CardInstance, index: ContinuousIndex): boolean {
  return !blockCountAllowedFor(attacker, 1, index);
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
  } else if (!splitSecondOnStack(state)) {
    // SPLIT SECOND (CR 702.61, DESIGN §3.142) — the SAME gate `decide` applies,
    // at the matching seam, because this function has the same defect: every
    // priority candidate below is a CONSTRUCTED cast, cycle or activation, and
    // the lock forbids all three. The combat declarations above are untouched
    // (core still offers those under the lock), and the pass appended below
    // keeps the menu non-empty, so a search always has a move.
    //
    // Fixed here rather than left for the next soak because it is one defect
    // with two homes: the DEFAULT pilot reaches `decide`, the search pilots
    // reach this, and the soak only ever walks the first. A class fixed in one
    // of its two homes is not fixed.
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

  const judged: InstanceId[] = [];
  for (const id of offered.attackers) {
    const attacker = findInstance(view, id);
    if (attacker && attackIsProfitable(attacker, enemyBlockers, weights, index, view)) judged.push(id);
  }
  // Plus the required attackers (CR 508.1d, §3.107) — a candidate that left one
  // home would be rejected by the engine, and a search cannot score a line it
  // is never allowed to play.
  const profitable = withRequiredAttackers(view, index, judged, offered.attackers) as InstanceId[];
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
  // The same two-clock read as `chooseBlock` (§3.105), so the search and the
  // live pilot cannot disagree about what "desperate" means.
  const pressure = attackPressure(view, combat.attackers, me, index);
  const desperate =
    pressureIsLethal(view, me, pressure) ||
    myLife <= weights.desperateLifeThreshold ||
    poisonRemaining(view, me) * weights.poisonCounterLifeEquivalent <= weights.desperateLifeThreshold;
  const available = creaturesControlledBy(view, me).filter((c) => !c.tapped);
  const attackers = [...combat.attackers]
    .map((id) => findInstance(view, id))
    .filter((c): c is CardInstance => c !== undefined)
    .sort((a, b) => faceThreat(b, index, weights) - faceThreat(a, index, weights));

  // Both the value-judged block and the survival block, when they differ: under
  // pressure "chump to live" and "only trade profitably" are genuinely different
  // plans, and which is right is precisely what a search can work out.
  // The same read as `chooseBlock`'s, hoisted out of both loops: a creature a
  // delayed ability will remove anyway is the free chump block.
  const doomed = delayedRemovalTargets(view);
  for (const mode of desperate ? [true] : [false, true]) {
    const used = new Set<InstanceId>();
    const blocks: { blocker: InstanceId; attacker: InstanceId }[] = [];
    for (const attacker of attackers) {
      const blocker = pickBlocker(attacker, available, used, mode, weights, index, doomed, boardOf(view));
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
  for (const scoredGoal of scoredSpellGoals(view, weights, explain, index)) {
    // §3.143 — the SAME funding helper the pilot uses, so the search explores
    // the Phyrexian price the pilot would actually pay.
    const funded = planGoalPayment(view, me, scoredGoal, legalActions, weights);
    if (!funded) continue; // cannot be funded from this board — not an option at all
    const { goal, plan } = funded;
    const plies: GameAction[] = [];
    for (const tap of plan) plies.push(tapActionFor(me, tap));
    // §3.112 — the SAME action builder the heuristic uses, so a second-half,
    // alternative-cost or channel goal cannot be carried out differently by
    // the search than by the pilot (this used to rebuild the cast here and
    // dropped `face`).
    plies.push(actionForGoal(me, goal));
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
    // `attachment`, not `attachment.modifies`. An Equipment whose whole printed
    // text is a triggered ability on its HOST (Skullclamp; Sword of the Animist)
    // has no modification at all, and gating the search on one made every such
    // card INERT: the pilot never equipped it, so its trigger never fired, in
    // every game ever simulated. What the card is WORTH is `scoreEquip`'s
    // question — this loop only asks whether it is an attachment at all.
    if (perm.def.attachment === undefined) continue;
    for (let a = 0; a < abilities.length; a++) {
      const ability = abilities[a]!;
      if (restrictionOfEffects(ability.effects) !== EQUIP_RESTRICTION) continue;
      const mana = ability.cost.mana;
      if (!mana || ability.cost.tap || ability.cost.sacrificeSelf || ability.cost.life) continue;
      hosts ??= legalTargetsFor(view as GameState, EQUIP_RESTRICTION, me, perm.def);
      const host = bestEquipHost(view, hosts, perm.attachedTo ?? null, index);
      if (!host) continue;
      const score = scoreEquip(perm.def, host, weights, index);
      if (score === undefined || (best !== undefined && score <= best.score)) continue;
      if (!equipIsAnUpgrade(view, perm, score, weights, index)) continue;
      const plan = planManaPayment(
        view as GameState,
        me,
        mana,
        legalActions,
        perm.def,
        'activate',
        manaPreferenceOf(weights),
      );
      if (!plan) continue;
      const plies: GameAction[] = [];
      for (const tap of plan) plies.push(tapActionFor(me, tap));
      // A PLY LIST taps first, so the activation is not on the menu yet and
      // cannot be looked up. It is built here with every component the engine
      // needs for THIS shape: equip prints a target and no other cost, which is
      // why an equip ply is safe to assemble where a general activation is not.
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

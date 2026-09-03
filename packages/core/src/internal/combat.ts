/**
 * Combat system. Reads keyword flags as data and applies pure-combat rules:
 *   - flying: an attacker with flying can only be blocked by reach/flying.
 *   - vigilance: attacking doesn't tap.
 *   - haste: can attack the turn it enters (handled by clearing sickness, but
 *     legality also checks it).
 *   - first strike / double strike: a first-strike damage step precedes the
 *     normal step; double strike deals in both.
 *   - deathtouch: any damage > 0 from a deathtouch source is lethal.
 *   - trample: excess damage beyond a blocker's lethal threshold tramples to the
 *     defending player.
 *   - lifelink: damage dealt also gains its controller that much life.
 *   - infect / wither / toxic (§3.105): what damage DOES once it lands — marks or
 *     -1/-1 counters, life or poison, lifelink and toxic on top — is CR 120.3's
 *     table, applied in ONE place (`damage-result.ts`) for combat and noncombat
 *     damage alike; this file only decides how much is assigned to whom.
 *
 * Keywords and P/T are read through the continuous-effects layer (internal/
 * continuous.ts): a `ContinuousIndex` is built once per combat pass and threaded so
 * an "until end of turn" pump, a granted keyword (e.g. temporary trample), and any
 * anthem-style STATIC on the battlefield all affect this combat through one path.
 * Combat damage is assigned and then dealt; SBAs (run by the engine afterward)
 * destroy lethally-damaged creatures.
 *
 * The index is built at the START of a damage step and used for that whole step,
 * which is exactly right: a creature that dies during the step — an anthem included
 * — is still on the battlefield while damage is being assigned. Its departure is
 * observed by the SBA pass that follows, which rebuilds the index from scratch, so a
 * creature the dead anthem was propping up dies in that same pass.
 */

import type { CardInstance, GameState, InstanceId, PlayerId } from '../state.js';
import type { GameEvent } from '../events.js';
import type { BlockerQuality, BlockRestriction, KeywordFlags } from '../card.js';
import {
  defenseOf,
  effectivePower,
  effectiveToughness,
  effectiveKeywords,
  loyaltyOf,
  remainingToughness,
} from './stats.js';
import { hasType, isBattle, isPlaneswalker } from '../card.js';
import { protectionBlocksSource } from '../protection.js';
import { findOnBattlefield } from './zones.js';
import { attackingCreatureIds, isRemovedFromCombat } from '../combat-removal.js';
import { controlsLandMatchingAny } from '../land-conditions.js';
import type { ContinuousIndex } from './continuous.js';
import { indexContinuous, NO_MOD } from './continuous.js';
import { blockRequirementProblem } from './block-solver.js';
import type { ReplacementIndex } from './replacement.js';
import { indexReplacements, replaceDamage } from './replacement.js';
import { applyDamageResult } from './damage-result.js';

/**
 * The battlefield `canBlock` reads when its caller passes none. Shared and
 * frozen: it says "the defender controls no lands", which is the right answer
 * for every board test that builds two creatures and nothing else — and for
 * every call site that carries a real board, the real one is passed. Only
 * LANDWALK reads it (DESIGN §3.107).
 */
const NO_PERMANENTS: readonly CardInstance[] = Object.freeze([]);

/** Effective keywords for an instance under the given continuous index. */
function kw(inst: CardInstance, index: ContinuousIndex): KeywordFlags {
  return effectiveKeywords(inst, index.get(inst.instanceId) ?? NO_MOD);
}

/** Effective power for an instance under the given continuous index. */
function power(inst: CardInstance, index: ContinuousIndex): number {
  return effectivePower(inst, index.get(inst.instanceId) ?? NO_MOD);
}

/** Effective toughness for an instance under the given continuous index. */
function toughness(inst: CardInstance, index: ContinuousIndex): number {
  return effectiveToughness(inst, index.get(inst.instanceId) ?? NO_MOD);
}

/**
 * Whether `blocker` may legally block `attacker` given evasion keywords.
 *
 * The index is REQUIRED, not optional: evasion can be granted by an until-EOT effect
 * *or* by an anthem-style static, and a caller that omitted the index would silently
 * judge legality against printed keywords only — letting a groundling block a
 * creature that a static has given flying. Build it once with `indexContinuous` and
 * thread it through (the engine already does, for exactly this reason).
 */
export function canBlock(
  attacker: CardInstance,
  blocker: CardInstance,
  index: ContinuousIndex,
  battlefield: readonly CardInstance[] = NO_PERMANENTS,
): boolean {
  if (blocker.tapped) return false;
  const idx = index;
  const ak = kw(attacker, idx);
  const bk = kw(blocker, idx);
  // "~ can't block" disqualifies the BLOCKER whatever it would be blocking, so it
  // is asked first and independently of anything about the attacker.
  if (bk.cantBlock) return false;
  // "Can't be blocked" is absolute — checked before evasion, which it subsumes.
  if (ak.unblockable) return false;
  if (ak.flying && !(bk.flying || bk.reach)) return false;
  // --- the combat keyword family (DESIGN §3.107) ------------------------------
  // SHADOW (CR 702.28b) is SYMMETRIC: a shadow creature can't be blocked by a
  // creature without shadow, AND a creature without shadow can't be blocked by
  // one with it. One inequality states both halves, so neither can be forgotten.
  if ((ak.shadow === true) !== (bk.shadow === true)) return false;
  // "~ can block ONLY creatures with flying" — the blocker's own restriction on
  // what it may block (Welkin Tern). The attacker must carry one of the named
  // keywords; an empty list (two printed lines that agree on nothing) blocks
  // nothing, which is what both lines together say.
  const blockOnly = bk.blockOnly;
  if (blockOnly !== undefined) {
    let allowed = false;
    for (const keyword of blockOnly.attackerMustHaveAnyOf) {
      if (ak[keyword] === true) {
        allowed = true;
        break;
      }
    }
    if (!allowed) return false;
  }
  // LANDWALK (CR 702.18b): unblockable while the DEFENDING player — the
  // blocker's controller — controls a land the walk names. The only evasion
  // rule that reads something other than the two creatures, which is why
  // `battlefield` is a parameter; a caller that omits it is asserting the
  // defender controls no lands at all (see `NO_PERMANENTS`).
  if (ak.landwalk !== undefined && controlsLandMatchingAny(battlefield, blocker.controller, ak.landwalk)) {
    return false;
  }
  // Protection's fourth half: an attacker with protection from [quality] can't
  // be blocked by creatures having that quality (protection from creatures
  // therefore makes it unblockable, since every blocker is a creature).
  if (ak.protectionFrom !== undefined && protectionBlocksSource(ak.protectionFrom, blocker.def)) {
    return false;
  }
  // A COMPARING restriction — "except by creatures with haste", "by creatures with
  // power 2 or less", skulk. Last because it is the only test that reads effective
  // P/T, so a pair already rejected by evasion never pays for it.
  if (ak.blockRestriction !== undefined && !passesBlockRestriction(ak.blockRestriction, attacker, blocker, idx)) {
    return false;
  }
  return true;
}

/**
 * Whether `blocker` satisfies an attacker's comparing block restriction.
 *
 * Every bound is measured against EFFECTIVE power/toughness, through the index the
 * caller already built — a 1/1 pumped to 3/3 really has stopped being a legal
 * blocker for "except by creatures with power 2 or less", and reading the printed
 * box would let it through.
 */
/**
 * Does `blocker` have the quality an evasion keyword's exception names?
 *
 * ⚠️ READ OFF THE PRINTED DEFINITION, not the continuous index. Colour and card
 * type CAN be changed by effects, and doing this properly would mean routing both
 * through the layer system — which core does not model for either yet. Reading
 * the printed values is the honest approximation ONLY because it is also what the
 * rest of core does for colour and type today; the moment either becomes
 * layer-aware, this must move with it or a Fear creature will start being
 * blockable by a creature that only LOOKS black.
 */
function blockerHasQuality(quality: BlockerQuality, attacker: CardInstance, blocker: CardInstance): boolean {
  switch (quality.kind) {
    case 'artifact':
      return hasType(blocker.def, 'artifact');
    case 'color':
      return (blocker.def.colors ?? []).includes(quality.color);
    case 'sharesColorWithAttacker': {
      const mine = attacker.def.colors ?? [];
      // A COLOURLESS attacker shares a colour with nothing, so intimidate on one
      // reads as "except by artifact creatures" — which is exactly CR 702.13a.
      return (blocker.def.colors ?? []).some((color) => mine.includes(color));
    }
  }
}

function passesBlockRestriction(
  restriction: BlockRestriction,
  attacker: CardInstance,
  blocker: CardInstance,
  index: ContinuousIndex,
): boolean {
  const required = restriction.blockerMustHaveAnyOf;
  if (required !== undefined) {
    const bk = kw(blocker, index);
    let has = false;
    for (const keyword of required) {
      if (bk[keyword] === true) {
        has = true;
        break;
      }
    }
    if (!has) return false;
  }
  const qualities = restriction.blockerMustMatchAnyOf;
  if (qualities !== undefined && !qualities.some((quality) => blockerHasQuality(quality, attacker, blocker))) {
    return false;
  }
  const needsPower =
    restriction.maxBlockerPower !== undefined ||
    restriction.minBlockerPower !== undefined ||
    restriction.blockerPowerAtMostMine === true;
  if (needsPower) {
    const blockerPower = power(blocker, index);
    if (restriction.maxBlockerPower !== undefined && blockerPower > restriction.maxBlockerPower) return false;
    if (restriction.minBlockerPower !== undefined && blockerPower < restriction.minBlockerPower) return false;
    // SKULK: the bound is the attacker's OWN effective power, read now.
    if (restriction.blockerPowerAtMostMine === true && blockerPower > power(attacker, index)) return false;
  }
  if (restriction.maxBlockerToughness !== undefined || restriction.minBlockerToughness !== undefined) {
    const blockerToughness = toughness(blocker, index);
    if (restriction.maxBlockerToughness !== undefined && blockerToughness > restriction.maxBlockerToughness) {
      return false;
    }
    if (restriction.minBlockerToughness !== undefined && blockerToughness < restriction.minBlockerToughness) {
      return false;
    }
  }
  return true;
}

/**
 * The minimum number of creatures that must block this attacker TOGETHER for the
 * block to be legal, or 0 when it prints no such requirement.
 *
 * Menace and `minBlockers` are the same printed rule at two values — "can't be
 * blocked except by two or more creatures" and Pathrazer of Ulamog's "except by
 * three or more" — so they are folded here by taking the LARGER, which is the
 * only reading under which both restrictions hold at once.
 */
export function requiredBlockerCount(attacker: CardInstance, index: ContinuousIndex): number {
  return minimumBlockersFor(kw(attacker, index));
}

/**
 * The same answer as {@link requiredBlockerCount}, from a keyword set already in
 * hand. Split out so a caller that has just read the effective keywords for
 * another reason does not pay for the merge twice — `illegalBlockDeclaration`
 * reads them once and asks both halves of CR 509.1 from that one read.
 */
function minimumBlockersFor(k: KeywordFlags): number {
  const menaceMinimum = k.menace ? MENACE_MINIMUM_BLOCKERS : 0;
  return Math.max(menaceMinimum, k.minBlockers ?? 0);
}

/** Menace is the N = 2 printing of the "except by N or more creatures" rule. */
const MENACE_MINIMUM_BLOCKERS = 2;

/**
 * Why this whole block DECLARATION is illegal, or `undefined` if it stands.
 *
 * Menace lives here rather than in {@link canBlock} because it constrains the
 * assignment as a whole: each blocker individually *can* block a menacing
 * creature, and what the rule forbids is exactly one of them doing it. A
 * per-pair check cannot see that, so it would let a single blocker through.
 * Every "can't be blocked except by N or more creatures" printing has that same
 * shape, which is why they share this check rather than getting a flag each.
 *
 * Block REQUIREMENTS ("~ must be blocked if able", "all creatures able to block ~
 * do so") are the OTHER half of CR 509.1c/d and are resolved here too, in
 * `internal/block-solver.ts` — after the restrictions, because the rule is
 * "satisfy the maximum number of requirements **without violating any
 * restriction**", which makes the restrictions the outer constraint. The solver
 * returns after one pass over the attackers when none of them requires anything,
 * so an ordinary combat pays a single keyword read for it.
 *
 * `defenders` is the defending player's untapped creatures — everything that could
 * have been assigned. It is only read by the requirement half; a caller with no
 * requirement on the board can pass an empty list and change no answer.
 */
export function illegalBlockDeclaration(
  attackers: readonly CardInstance[],
  blocks: ReadonlyArray<{ readonly blocker: InstanceId; readonly attacker: InstanceId }>,
  index: ContinuousIndex,
  defenders: readonly CardInstance[] = [],
  battlefield: readonly CardInstance[] = NO_PERMANENTS,
): string | undefined {
  // ONE keyword read per attacker, used by BOTH halves. `effectiveKeywords` merges
  // the printed set with whatever the continuous layer granted, so it is the most
  // expensive thing this function does; the requirement pre-check rides along on
  // the read the restriction check already needed rather than repeating it, which
  // is what keeps the ordinary board — no requirement anywhere — at the cost it
  // had before requirements existed.
  let anyRequirement = false;
  for (const attacker of attackers) {
    const keywords = kw(attacker, index);
    if (keywords.mustBeBlocked === true || keywords.blockedByAllAble === true) anyRequirement = true;
    const required = minimumBlockersFor(keywords);
    // "~ can't be blocked by MORE THAN one creature" (DESIGN §3.107) — the dual
    // of the minimum, read off the same keyword set in the same pass. A cap and a
    // minimum together are both in force: menace plus a cap of one is a creature
    // nobody can legally block, which is what the two printed lines say.
    const cap = keywords.maxBlockers;
    if (required === 0 && cap === undefined) continue;
    const assigned = blocks.filter((b) => b.attacker === attacker.instanceId).length;
    // Zero is fine — the rule forbids being blocked by TOO FEW, not being unblocked.
    if (assigned > 0 && assigned < required) {
      return required === MENACE_MINIMUM_BLOCKERS
        ? `${attacker.def.name} has menace and can't be blocked by exactly one creature`
        : `${attacker.def.name} can't be blocked except by ${required} or more creatures`;
    }
    if (cap !== undefined && assigned > cap) {
      return `${attacker.def.name} can't be blocked by more than ${cap === 1 ? 'one creature' : `${cap} creatures`}`;
    }
  }
  // THE EMPTY CHECK, and the whole reason a rules-complete CR 509.1c/d solver can
  // live on this path: with nothing on the board requiring a block there is
  // nothing to maximise, and the function returns having allocated nothing and
  // walked no defender.
  if (!anyRequirement) return undefined;
  // Requirements LAST: every restriction above is now known to hold, which is
  // exactly the condition CR 509.1d maximises under.
  return blockRequirementProblem(attackers, defenders, blocks, index, battlefield);
}

/** Does this creature deal damage in the first-strike step? */
function dealsFirstStrike(inst: CardInstance, index: ContinuousIndex): boolean {
  const k = kw(inst, index);
  return Boolean(k.firstStrike || k.doubleStrike);
}

/** Does this creature deal damage in the normal step? */
function dealsNormal(inst: CardInstance, index: ContinuousIndex): boolean {
  const k = kw(inst, index);
  // First-strikers (without double strike) deal only in the first step.
  return !k.firstStrike || Boolean(k.doubleStrike);
}

/** Is there any first-striker among the combatants this combat? */
export function hasAnyFirstStrike(state: GameState, combat: GameState['combat']): boolean {
  if (!combat) return false;
  const index = indexContinuous(state);
  for (const id of attackingCreatureIds(combat)) {
    const a = findOnBattlefield(state, id);
    if (a && dealsFirstStrike(a, index)) return true;
  }
  for (const blockerIdStr of Object.keys(combat.blocks)) {
    const blockerId = Number(blockerIdStr);
    if (isRemovedFromCombat(combat, blockerId)) continue;
    const b = findOnBattlefield(state, blockerId);
    if (b && dealsFirstStrike(b, index)) return true;
  }
  return false;
}

/** Lethal-damage threshold for a creature (deathtouch makes any damage lethal). */
function lethalNeeded(target: CardInstance, source: CardInstance, index: ContinuousIndex): number {
  if (kw(source, index).deathtouch) return 1;
  return Math.max(remainingToughness(target, index.get(target.instanceId) ?? NO_MOD), 0);
}

function applyDamage(
  state: GameState,
  source: CardInstance,
  target: CardInstance | PlayerId,
  requested: number,
  index: ContinuousIndex,
  replacements: ReplacementIndex,
  emit: (e: GameEvent) => void,
): void {
  if (requested <= 0) return;
  // PROTECTION FIRST. It is an absolute prevention (CR 702.16e), so nothing a
  // replacement effect could do changes the outcome — and running it first means
  // a "prevent the next 3 damage" SHIELD is not spent on a hit that was never
  // going to land. Only a plain permanent can carry it; a player, a walker's
  // loyalty and a battle's defense are handled below.
  if (typeof target !== 'string' && !isPlaneswalker(target.def) && !isBattle(target.def)) {
    const protection = kw(target, index).protectionFrom;
    if (protection !== undefined && protectionBlocksSource(protection, source.def)) {
      emit({
        type: 'damagePrevented',
        source: source.instanceId,
        target: target.instanceId,
        amount: requested,
        combat: true,
      });
      return;
    }
  }
  // THE ONE REPLACEMENT SEAM (CR 614/615). Every damage site in the engine asks
  // this same question — combat here, `dealDamage`/`dealDamageToEach`/`fight` in
  // the primitives — so a damage doubler and a fog cannot mean two different
  // things depending on where the damage came from. Inert when the index is
  // empty: one `.length` read, no allocation.
  let amount = requested;
  if (replacements.length > 0) {
    const recipient = typeof target === 'string' ? undefined : target;
    const affectedPlayer = typeof target === 'string' ? target : target.controller;
    const result = replaceDamage(
      state,
      replacements,
      source,
      source.controller,
      recipient,
      affectedPlayer,
      amount,
      true,
      emit,
    );
    if (result.prevented > 0) {
      emit({
        type: 'damagePrevented',
        source: source.instanceId,
        target: typeof target === 'string' ? target : target.instanceId,
        amount: result.prevented,
        combat: true,
      });
    }
    amount = result.amount;
    // Fully prevented: no damage, and no LIFELINK either — the source dealt
    // nothing, so there is nothing to link (the same reading protection's half
    // already had).
    if (amount <= 0) return;
  }
  // THE ONE DAMAGE-RESULT FUNNEL (CR 120.3, §3.105). Life loss or poison, loyalty,
  // defense, marked damage or -1/-1 counters, deathtouch, lifelink and toxic are
  // decided in `damage-result.ts` for combat and noncombat damage alike, so an
  // infect creature that FIGHTS lands counters exactly as one that attacks.
  // Protection's second half (CR 702.16e) was already applied at the top of this
  // function, before the replacement layer — see the comment there for why.
  applyDamageResult(state, source, target, amount, true, index, emit);
}

/**
 * Deal an attacker's player-facing damage to WHAT IT WAS DECLARED ATTACKING —
 * the defending player, or an attacked permanent (a planeswalker).
 *
 * Three rules live here, and only here, so every damage site agrees:
 *   - an attacked permanent that has LEFT the battlefield absorbs nothing and
 *     redirects nothing: the attacker was attacking that object, the object is
 *     gone, and it deals no combat damage (CR 506.4c / 510.1a — the old
 *     planeswalker damage-redirection rule was removed in 2017);
 *   - a TRAMPLING attacker attacking a planeswalker assigns at most the
 *     walker's remaining loyalty to it and the excess to the defending player
 *     (CR 702.19i);
 *   - everything else goes to the attacked object whole.
 */
function dealToAttackedObject(
  state: GameState,
  attacker: CardInstance,
  attacked: InstanceId | PlayerId,
  amount: number,
  index: ContinuousIndex,
  replacements: ReplacementIndex,
  defendingPlayer: PlayerId,
  emit: (e: GameEvent) => void,
): void {
  if (amount <= 0) return;
  if (typeof attacked === 'string') {
    applyDamage(state, attacker, attacked, amount, index, replacements, emit);
    return;
  }
  const object = findOnBattlefield(state, attacked);
  if (!object) return; // the attacked permanent is gone — no damage, no redirect
  if (kw(attacker, index).trample && (isPlaneswalker(object.def) || isBattle(object.def))) {
    // CR 702.19i/702.19j: trampling past an attacked walker (its loyalty is
    // lethal) or an attacked battle (its remaining defense is lethal) carries
    // the excess to the defending player — who, for a battle, IS its protector.
    const lethal = isBattle(object.def) ? defenseOf(object) : loyaltyOf(object);
    const toObject = Math.min(amount, lethal);
    applyDamage(state, attacker, object, toObject, index, replacements, emit);
    applyDamage(state, attacker, defendingPlayer, amount - toObject, index, replacements, emit);
    return;
  }
  applyDamage(state, attacker, object, amount, index, replacements, emit);
}

/** What this attacker was declared attacking (the defending player by default). */
export function attackedObjectOf(
  combat: NonNullable<GameState['combat']>,
  attackerId: InstanceId,
  defendingPlayer: PlayerId,
): InstanceId | PlayerId {
  return combat.attackTargets?.[attackerId] ?? defendingPlayer;
}

/**
 * Run one combat-damage step (first-strike or normal), determined by `firstStep`.
 * Each unblocked attacker hits the defending player; blocked attackers split
 * damage to their blocker(s), trampling overflow when applicable; blockers deal
 * back to their attacker. Mutates the draft; emits damage/life events.
 */
function runDamageStep(
  state: GameState,
  combat: NonNullable<GameState['combat']>,
  defendingPlayer: PlayerId,
  firstStep: boolean,
  index: ContinuousIndex,
  replacements: ReplacementIndex,
  emit: (e: GameEvent) => void,
): void {
  const participates = (inst: CardInstance): boolean =>
    firstStep ? dealsFirstStrike(inst, index) : dealsNormal(inst, index);

  // "Was this attacker blocked this combat?" is determined from the DECLARED
  // blocks, not from whether a blocker is currently alive. Once a creature is
  // blocked it stays blocked for the whole combat (CR 509.1b/510.1c): even if
  // its blocker dies (e.g. to a first-strike step before the normal step), a
  // non-trample attacker assigns no damage in later steps, and a trample
  // attacker tramples its full power through (the dead blocker absorbs 0 lethal).
  const blockedAttackers = new Set<InstanceId>(Object.values(combat.blocks));

  // Group *living* blockers by the attacker they block, for lethal assignment.
  // A blocker REMOVED from combat (CR 506.4 — blinked away and back as a new
  // object) is skipped here exactly as a dead one is: it absorbs no damage. Its
  // `blocks` entry still stands above, so its attacker stays blocked.
  const blockersByAttacker = new Map<InstanceId, CardInstance[]>();
  for (const [blockerIdStr, attackerId] of Object.entries(combat.blocks)) {
    const blockerId = Number(blockerIdStr);
    if (isRemovedFromCombat(combat, blockerId)) continue;
    const blocker = findOnBattlefield(state, blockerId);
    if (!blocker) continue;
    const list = blockersByAttacker.get(attackerId) ?? [];
    list.push(blocker);
    blockersByAttacker.set(attackerId, list);
  }

  // Attackers deal damage.
  for (const attackerId of attackingCreatureIds(combat)) {
    const attacker = findOnBattlefield(state, attackerId);
    if (!attacker || !participates(attacker)) continue;
    const atkPower = power(attacker, index);
    if (atkPower <= 0) continue;
    const blockers = blockersByAttacker.get(attackerId);
    const wasBlocked = blockedAttackers.has(attackerId);
    // The player-facing half of this attacker's damage goes to what it was
    // DECLARED attacking — the defending player, or that player's planeswalker.
    const attacked = attackedObjectOf(combat, attackerId, defendingPlayer);
    if (!blockers || blockers.length === 0) {
      if (wasBlocked) {
        // Blocked, but no living blocker remains (blocker died earlier this
        // combat). A blocked creature stays blocked: without trample it deals
        // no damage; with trample it tramples its full power through (all
        // "lethal" was absorbed by the now-dead blocker = 0 remaining to assign).
        if (kw(attacker, index).trample) {
          dealToAttackedObject(state, attacker, attacked, atkPower, index, replacements, defendingPlayer, emit);
        }
        continue;
      }
      // Genuinely unblocked → straight to the attacked player/permanent.
      dealToAttackedObject(state, attacker, attacked, atkPower, index, replacements, defendingPlayer, emit);
      continue;
    }
    // Blocked → assign lethal to each blocker in order, trample overflow.
    let remaining = atkPower;
    for (const blocker of blockers) {
      if (remaining <= 0) break;
      const need = lethalNeeded(blocker, attacker, index);
      const assign = Math.min(remaining, need);
      applyDamage(state, attacker, blocker, assign, index, replacements, emit);
      remaining -= assign;
    }
    if (remaining > 0 && kw(attacker, index).trample) {
      dealToAttackedObject(state, attacker, attacked, remaining, index, replacements, defendingPlayer, emit);
    }
  }

  // Blockers deal damage back to the attacker they block. Neither half may have
  // been removed from combat: a blinked blocker deals nothing, and nothing is
  // dealt back to a blinked ATTACKER, which is no longer being blocked at all.
  for (const [blockerIdStr, attackerId] of Object.entries(combat.blocks)) {
    const blockerId = Number(blockerIdStr);
    if (isRemovedFromCombat(combat, blockerId) || isRemovedFromCombat(combat, attackerId)) continue;
    const blocker = findOnBattlefield(state, blockerId);
    const attacker = findOnBattlefield(state, attackerId);
    if (!blocker || !attacker || !participates(blocker)) continue;
    const blkPower = power(blocker, index);
    if (blkPower <= 0) continue;
    applyDamage(state, blocker, attacker, blkPower, index, replacements, emit);
  }
}

/**
 * Deal all combat damage. If any first-striker is present, a first-strike step
 * runs first; SBAs between steps are run by the engine. Returns whether a
 * first-strike step was performed (the engine then runs SBAs and the normal step).
 */
export function assignAndDealCombatDamage(
  state: GameState,
  emit: (e: GameEvent) => void,
  step: 'firstStrike' | 'normal',
): void {
  const combat = state.combat;
  if (!combat) return;
  const index = indexContinuous(state);
  // ONE replacement index per damage STEP, exactly like the continuous index
  // above and for the same reason: all combat damage in a step is dealt
  // simultaneously, so an effect that was live when the step began is live for
  // every assignment in it. A prevention SHIELD spent by the first assignment is
  // still not reusable by the second — the record it was read from is written
  // through and spliced out of the state (see `internal/replacement.ts`).
  const replacements = indexReplacements(state);
  const defendingPlayer = defendingPlayerOf(state);
  runDamageStep(state, combat, defendingPlayer, step === 'firstStrike', index, replacements, emit);
}

/** The non-active player is the defender in this 2-player MVP. */
export function defendingPlayerOf(state: GameState): PlayerId {
  return state.activePlayer === 'A' ? 'B' : 'A';
}

/** Tap attackers that lack vigilance when they're declared. */
export function tapAttackers(state: GameState, attackerIds: readonly InstanceId[], emit: (e: GameEvent) => void): void {
  const index = indexContinuous(state);
  for (const id of attackerIds) {
    const a = findOnBattlefield(state, id);
    if (!a) continue;
    if (!kw(a, index).vigilance) {
      a.tapped = true;
      emit({ type: 'tapped', instanceId: a.instanceId });
    }
  }
}

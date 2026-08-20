/**
 * State cloning at the action boundary. `applyAction` clones the incoming state
 * once, then systems mutate the draft in place — so the caller's previous state
 * is never altered (the sim/replay relies on that). We clone the mutable shells
 * (players, zone arrays, instances, stack, combat) but SHARE the immutable
 * `CardDefinition` records by reference (they never change), keeping the clone
 * cheap. One clone per action, not per event.
 */

import type {
  CardInstance,
  GameState,
  PlayerId,
  PlayerState,
  StackObject,
  CombatState,
} from '../state.js';
import type { ManaPool } from '../mana.js';
import type { ContinuousEffect } from './continuous.js';
import { NO_COUNTERS, PLAYER_IDS } from '../state.js';
import type { PendingChoice, ResolutionFrame } from '../choices.js';
import type { CardGrant } from '../card-grants.js';
import { cloneChoiceAnswer } from '../choices.js';

/**
 * Copy an instance's counters — or, when there are none, hand back the shared
 * frozen empty record.
 *
 * Nearly every instance in a game carries no counters (a whole library, a whole
 * hand, every vanilla creature), and that empty `{}` was measured at 40% of
 * everything a clone allocates: ~66 bytes each, ~120 of them per action. Sharing
 * one is safe because `CardInstance.counters` is contractually REPLACED and never
 * mutated in place — see the field's own documentation in state.ts — and the
 * shared record is frozen, so a violation throws at the offending line instead of
 * quietly aliasing two states together.
 */
function cloneCounters(counters: Record<string, number>): Record<string, number> {
  for (const kind in counters) {
    // Something is actually in there — pay for the real copy.
    void kind;
    return { ...counters };
  }
  return NO_COUNTERS;
}

function cloneInstance(inst: CardInstance): CardInstance {
  const copy: CardInstance = {
    instanceId: inst.instanceId,
    def: inst.def, // immutable — shared by reference
    controller: inst.controller,
    owner: inst.owner,
    zone: inst.zone,
    tapped: inst.tapped,
    summoningSick: inst.summoningSick,
    damageMarked: inst.damageMarked,
    markedByDeathtouch: inst.markedByDeathtouch,
    counters: cloneCounters(inst.counters),
  };
  // Written only when the instance is actually attached to something, which is a
  // handful of permanents in a game that has any attachments at all and NONE in a
  // game that has none. Cloning is the engine's single hottest allocation — a whole
  // library and a whole hand copied on every action — so an unconditional tenth
  // property measured as a real (~4%) throughput regression across the gauntlet for
  // a field that is almost always null. Copying it conditionally keeps the ordinary
  // instance byte-for-byte the object it has always been.
  if (inst.attachedTo != null) copy.attachedTo = inst.attachedTo;
  // Same conditional-copy argument as `attachedTo`: only a planeswalker whose
  // loyalty ability has been activated ever carries this, and an unconditional
  // extra property on every clone measurably costs sim throughput.
  if (inst.loyaltyActivatedTurn !== undefined) copy.loyaltyActivatedTurn = inst.loyaltyActivatedTurn;
  // Same conditional-copy rule as `attachedTo`, and the same stakes as a
  // dropped stack-object field: `def` is the ACTIVE face (a transformed DFC
  // points at its nested back face), and `printedDef` is the only way back to
  // the front. Dropping it here would silently freeze a transformed permanent
  // on its back face for the rest of the game — and losing the pair together
  // would untransform it — on the very next action's clone.
  if (inst.printedDef != null) copy.printedDef = inst.printedDef;
  // Same conditional-copy rule again: only a permanent that entered off a
  // KICKED spell carries this, and it is what an "for each time it was kicked"
  // ETB trigger reads after the resolution frame is gone — drop it here and the
  // trigger silently sees an unkicked spell one action boundary later.
  if (inst.timesKicked !== undefined) copy.timesKicked = inst.timesKicked;
  // Same conditional-copy rule again, and the same stakes: this is the value the
  // permanent NAMED as it entered, and every "of the chosen type / color" filter,
  // mana mode and type-line read on the board resolves through it. Dropping it
  // here would blank a Cavern of Souls or an Adaptive Automaton one action
  // boundary after it entered — and blank it INVISIBLY, because "nothing chosen"
  // is a legal state that matches nothing rather than a crash.
  if (inst.chosenAsEntered !== undefined) copy.chosenAsEntered = inst.chosenAsEntered;
  return copy;
}

function cloneInstances(list: readonly CardInstance[]): CardInstance[] {
  return list.map(cloneInstance);
}

/**
 * A fresh pool with the same contents. Spelled out rather than spread: the six
 * colours are a fixed, known shape, so the literal compiles to a straight
 * allocate-and-store instead of a generic property copy.
 */
function clonePool(pool: ManaPool): ManaPool {
  return { W: pool.W, U: pool.U, B: pool.B, R: pool.R, G: pool.G, C: pool.C };
}

function clonePlayer(p: PlayerState): PlayerState {
  return {
    id: p.id,
    life: p.life,
    manaPool: clonePool(p.manaPool),
    landsPlayedThisTurn: p.landsPlayedThisTurn,
    hasLost: p.hasLost,
    library: cloneInstances(p.library),
    hand: cloneInstances(p.hand),
    graveyard: cloneInstances(p.graveyard),
    exile: cloneInstances(p.exile),
    command: cloneInstances(p.command),
  };
}

function cloneStackObject(o: StackObject): StackObject {
  if (o.kind === 'trigger') {
    return {
      kind: 'trigger',
      instanceId: o.instanceId,
      sourceInstanceId: o.sourceInstanceId,
      controller: o.controller,
      effects: o.effects.map((e) => ({ ...e })),
      targets: [...o.targets],
      label: o.label,
      // Field-by-field on purpose (see the header), which means a NEW field is
      // dropped unless it is added here — and dropping this one would lose a
      // trigger's "still needs aiming" marker on the clone `applyAction` makes at
      // every action boundary, silently resolving it at nothing.
      ...(o.awaitingTargets !== undefined ? { awaitingTargets: o.awaitingTargets } : {}),
      // Same field-by-field stakes as `awaitingTargets`: dropping this would
      // lose the TRIGGERING PLAYER at the very next action boundary, and every
      // "that player draws a card" body would silently fall back to the source's
      // controller — Howling Mine drawing its own controller a card on both
      // turns. `clone.test.ts` pins it.
      ...(o.triggeringPlayer !== undefined ? { triggeringPlayer: o.triggeringPlayer } : {}),
      // Shared by reference on purpose: an `InterveningIf` is frozen compile-time
      // data hanging off an immutable `CardDefinition`, exactly like `effects`'
      // primitive ids — nothing mutates it. Dropping it would let a trigger whose
      // condition had lapsed resolve anyway.
      ...(o.intervening !== undefined ? { intervening: o.intervening } : {}),
    };
  }
  return {
    kind: 'spell',
    instanceId: o.instanceId,
    card: cloneInstance(o.card),
    controller: o.controller,
    resolvesTo: o.resolvesTo,
    targets: [...o.targets],
    // Conditional for the same reason as `awaitingTargets` above: dropping any
    // of these would lose a chosen X / kicked flag (the spell would resolve as
    // if unpaid), lose the "cast still being finished" marker, or turn a cloned
    // flashback cast back into an ordinary one (slipping into the graveyard on
    // resolution instead of exile) — on the clone made at every action
    // boundary. Conditional so the ordinary spell object stays byte-for-byte
    // what it always was.
    ...(o.xValue !== undefined ? { xValue: o.xValue } : {}),
    ...(o.kicked !== undefined ? { kicked: o.kicked } : {}),
    ...(o.kickCount !== undefined ? { kickCount: o.kickCount } : {}),
    // Deep-copied, not aliased: a pick's `targets` array is written into as the
    // engine collects each chosen mode's aim, so sharing the array between a
    // state and its clone would let one cast's aiming rewrite the other's.
    // Dropping it entirely would resolve a modal spell with NO modes at all.
    ...(o.modePicks !== undefined
      ? {
          modePicks: o.modePicks.map((pick) => ({
            modeId: pick.modeId,
            ...(pick.targets !== undefined ? { targets: [...pick.targets] } : {}),
          })),
        }
      : {}),
    // Dropping this one would turn a bought-back spell back into an ordinary
    // one — it would hit the graveyard on resolution instead of returning to
    // hand — at the very next action boundary. Same stakes, same shape.
    ...(o.boughtBack !== undefined ? { boughtBack: o.boughtBack } : {}),
    ...(o.additionalCostPaid !== undefined ? { additionalCostPaid: o.additionalCostPaid } : {}),
    ...(o.awaitingCastChoice !== undefined ? { awaitingCastChoice: o.awaitingCastChoice } : {}),
    ...(o.castFrom !== undefined ? { castFrom: o.castFrom } : {}),
  };
}

function cloneCombat(c: CombatState | null): CombatState | null {
  if (!c) return null;
  return {
    attackers: [...c.attackers],
    blocks: { ...c.blocks },
    attackersDeclared: c.attackersDeclared,
    blockersDeclared: c.blockersDeclared,
    // Copied only when present — absent means "everyone attacks the player", and
    // most combats never declare an attack on a permanent at all.
    ...(c.attackTargets !== undefined ? { attackTargets: { ...c.attackTargets } } : {}),
  };
}

/**
 * Deep-copy a parked choice. Choices are treated as immutable once raised, so this
 * is only about breaking ALIASING: after a clone, nothing the caller still holds
 * can observe (or be observed through) the copy's arrays.
 */
function clonePendingChoice(choice: PendingChoice): PendingChoice {
  switch (choice.kind) {
    case 'selectCards':
      return { ...choice, candidates: choice.candidates.map((c) => ({ ...c })) };
    case 'selectPlayers':
      return { ...choice, candidates: [...choice.candidates] };
    case 'chooseModes':
      return { ...choice, modes: choice.modes.map((m) => ({ ...m })) };
    case 'payMana':
      return { ...choice, cost: { ...choice.cost } };
    case 'selectTargets':
      return { ...choice, candidates: choice.candidates.map((c) => ({ ...c })) };
    default:
      return { ...choice };
  }
}

/** Deep-copy a suspended resolution, including the card caught mid-resolution. */
function cloneResolution(frame: ResolutionFrame): ResolutionFrame {
  return {
    ...frame,
    effects: frame.effects.map((e) => ({ ...e })),
    answers: frame.answers.map(cloneChoiceAnswer),
    // The spread above would ALIAS this array (and every target list in it)
    // between the state and its clone — and it is mutated in lockstep with
    // `effects` by `enqueueEffects`, so an alias means one resolution's
    // enqueued modes shifting another's targets. Copied two levels deep.
    ...(frame.effectTargets
      ? { effectTargets: frame.effectTargets.map((t) => (t === undefined ? undefined : [...t])) }
      : {}),
    ...(frame.card ? { card: cloneInstance(frame.card) } : {}),
  };
}

/**
 * Copy one continuous effect. Hoisted to module scope rather than written inline
 * as an arrow inside `cloneState`: an arrow in the hot function is re-created on
 * every call, and this one runs on every clone whether or not any effect exists.
 */
function cloneContinuousEffect(effect: ContinuousEffect): ContinuousEffect {
  return { ...effect, keywords: effect.keywords ? { ...effect.keywords } : undefined };
}

/** Deep-clone the mutable parts of a GameState; share immutable card defs. */
export function cloneState(state: GameState): GameState {
  const players = {} as Record<PlayerId, PlayerState>;
  for (const id of PLAYER_IDS) {
    players[id] = clonePlayer(state.players[id]);
  }
  const next: GameState = {
    nextInstanceId: state.nextInstanceId,
    turnNumber: state.turnNumber,
    activePlayer: state.activePlayer,
    priorityPlayer: state.priorityPlayer,
    step: state.step,
    players,
    battlefield: cloneInstances(state.battlefield),
    stack: state.stack.map(cloneStackObject),
    continuous: state.continuous.map(cloneContinuousEffect),
    combat: cloneCombat(state.combat),
    winner: state.winner,
    gameOver: state.gameOver,
    consecutivePasses: state.consecutivePasses,
    seed: state.seed,
    rngState: state.rngState,
  };
  // Only pay for the choice machinery when a choice is actually in flight — the
  // overwhelming majority of clones (every action of every sim game) see two null
  // checks and nothing else. Assigned rather than conditionally spread: spreading
  // `cond ? {...} : {}` allocated the empty object BOTH times, on every clone,
  // purely to add no properties. Key order is unchanged (these still land last),
  // which matters because a serialized state is compared field-for-field.
  //
  // Tested for `!== undefined` rather than for truthiness, so a state that has
  // ANSWERED a question (`pendingChoice === null`) clones as one that has
  // answered a question, not as one that was never asked. Both mean "no choice"
  // to every reader, but they are different OBJECT SHAPES — and
  // `applyActionInPlace` never clones, so a clone that normalised `null` away
  // made the two engine paths disagree byte-for-byte on a state neither had
  // played differently. Same one comparison per clone as before.
  if (state.pendingChoice !== undefined) {
    next.pendingChoice = state.pendingChoice ? clonePendingChoice(state.pendingChoice) : null;
  }
  if (state.resolution !== undefined) {
    next.resolution = state.resolution ? cloneResolution(state.resolution) : null;
  }
  // Same conditional rule as the two above, and the same stakes as any dropped
  // field: forgetting this line would silently strip an active "gains flashback
  // until end of turn" grant at the very next action boundary. Only paid for
  // when a grant is actually in flight (nearly never).
  if (state.cardGrants !== undefined && state.cardGrants.length > 0) {
    next.cardGrants = state.cardGrants.map(cloneCardGrant);
  }
  // Two NUMBERS, so the turn's fact memory costs the clone no allocation at all
  // (a nested { A, B } record here measured ~3% of sim throughput). Numbers copy
  // by value, so two states can never alias each other's memory of the turn.
  // Same conditional rule and the same stakes: dropping an open madness window
  // would strand the exiled card — nothing could cast it and nothing would ever
  // put it in the graveyard — on the clone made at every action boundary.
  // Same `!== undefined` rule and the same reason as the two choice fields above:
  // a window that was DECLINED (`null`) is a different shape from one that never
  // opened, and only one of the two engine paths ever re-clones.
  if (state.madnessWindow !== undefined) {
    next.madnessWindow = state.madnessWindow ? { ...state.madnessWindow } : null;
  }
  if (state.turnFactsA !== undefined) next.turnFactsA = state.turnFactsA;
  if (state.turnFactsB !== undefined) next.turnFactsB = state.turnFactsB;
  return next;
}

/** Copy one card grant, breaking aliasing on its cost object. */
function cloneCardGrant(grant: CardGrant): CardGrant {
  return grant.flashback !== undefined ? { ...grant, flashback: { ...grant.flashback } } : { ...grant };
}

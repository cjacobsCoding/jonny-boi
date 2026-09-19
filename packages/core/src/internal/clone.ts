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
import type { FloatingReplacement } from './replacement.js';
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
  // Same conditional-copy rule as `attachedTo`: only a permanent whose modal
  // trigger prints "that hasn't been chosen this turn" ever carries this, and
  // the array is COPIED (not shared) — a draft state that appended to the
  // previous state's list would rewrite history.
  if (inst.modesChosenThisTurn !== undefined) copy.modesChosenThisTurn = [...inst.modesChosenThisTurn];
  // Same conditional-copy rule: only a permanent that has actually been
  // regenerated this turn carries a shield count.
  if (inst.regenerationShields !== undefined) copy.regenerationShields = inst.regenerationShields;
  // Same conditional-copy argument as `attachedTo`: only a planeswalker whose
  // loyalty ability has been activated ever carries this, and an unconditional
  // extra property on every clone measurably costs sim throughput.
  if (inst.loyaltyActivatedTurn !== undefined) copy.loyaltyActivatedTurn = inst.loyaltyActivatedTurn;
  // Same conditional-copy rule (§3.168), and the record is COPIED, not shared:
  // a draft state that wrote a new turn into the previous state's record would
  // rewrite history.
  if (inst.onceEachTurnActivated !== undefined) copy.onceEachTurnActivated = { ...inst.onceEachTurnActivated };
  // Same conditional-copy rule as `attachedTo` (§3.150): only a permanent
  // something has actually frozen carries a skip count, and dropping it here
  // would untap a Frost Trickster's victim at the very next action boundary.
  if (inst.untapSkips !== undefined) copy.untapSkips = inst.untapSkips;
  // Same conditional-copy rule as `attachedTo`, and the same stakes as a
  // dropped stack-object field: `def` is the ACTIVE face (a transformed DFC
  // points at its nested back face), and `printedDef` is the only way back to
  // the front. Dropping it here would silently freeze a transformed permanent
  // on its back face for the rest of the game — and losing the pair together
  // would untransform it — on the very next action's clone.
  if (inst.printedDef != null) copy.printedDef = inst.printedDef;
  // Same conditional-copy rule, with the sharpest stakes of the lot — the exact
  // bug the transform branch hit with `printedDef`, one layer down. `def` may be
  // a COPY effect's result (CR 707, layer 1) and `uncopiedDef` is the only
  // record of what the card really is. Drop it here and a Clone silently
  // REVERTS to its own printed 0/0 body at the very next action boundary: the
  // copy looks right for exactly one action and then stops being the creature it
  // copied, mid-combat, with no event saying so.
  if (inst.uncopiedDef != null) copy.uncopiedDef = inst.uncopiedDef;
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
  // The O-Ring link (§3.56): dropping this here is how "release the jailed
  // cards" became a no-op — the link only ever lived until the next clone.
  if (inst.exiledUntilLeavesBy !== undefined) copy.exiledUntilLeavesBy = inst.exiledUntilLeavesBy;
  // §3.106 — the turn an echo permanent came under its controller's control.
  // Same conditional-copy rule (only echo permanents carry it) and the same
  // stakes: drop it and every echo bill reads "not owed" one action later.
  if (inst.controlledSinceTurn !== undefined) copy.controlledSinceTurn = inst.controlledSinceTurn;
  // §3.112 — which alternative cost this permanent's spell paid (the rider
  // bodies read it), and the foretold card's face-down marker. Same rule.
  if (inst.castWith !== undefined) copy.castWith = inst.castWith;
  if (inst.faceDown !== undefined) copy.faceDown = inst.faceDown;
  // §3.111 — unearth's "if it would leave the battlefield, exile it instead"
  // (CR 702.84c). Same conditional-copy rule (only an unearthed permanent
  // carries it) and the same stakes: drop it and the creature dies to the
  // graveyard one action boundary later, to be unearthed again next turn.
  if (inst.exileIfLeaves !== undefined) copy.exileIfLeaves = inst.exileIfLeaves;
  // §3.110 — the RENOWNED designation (CR 702.112a). Same conditional-copy
  // rule (only a renown creature that has connected carries it) and the same
  // stakes: drop it and a Rhox Maulers grows again on its next connection.
  if (inst.renowned !== undefined) copy.renowned = inst.renowned;
  // NOTE FOR THE NEXT FIELD, because this copy has now dropped one four times:
  // a fact that belongs to the CARD rather than to this object's runtime state
  // needs no line here at all. `def` is shared by reference above, so a
  // DEFINITION field (`colors`, `subtypes`, `isToken`, `keywords`, …) survives
  // every clone by construction and cannot be lost to a field-by-field copy.
  //
  // That is a real reason to prefer the definition when the new fact is about
  // the card - token-ness is on `CardDefinition`, not here, for exactly this
  // reason. Put a field on the INSTANCE only when it is genuinely per-object
  // state, and then add it above with its own conditional AND its own test.
  // `token-clone.test.ts` pins both halves of that rule.
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
  // ⚠️ THE SPEND RESTRICTIONS TRAVEL WITH THE POOL. A clone that dropped them
  // would hand the next action a pool whose Ancient Ziggurat mana had silently
  // become able to pay for anything — a strictly better card, produced by a
  // field-by-field copy that merely forgot one field. Asserted in `clone.test.ts`.
  //
  // The ARRAY is copied by reference and its parcels are shared, which is safe
  // because parcels are immutable: every path that spends restricted mana
  // (`payCost`) builds new parcels in a new array rather than editing one. A deep
  // copy here would allocate on the per-action clone, the largest allocation site
  // in the sim, to defend against a mutation nothing performs.
  if (pool.restricted === undefined) {
    return { W: pool.W, U: pool.U, B: pool.B, R: pool.R, G: pool.G, C: pool.C };
  }
  return {
    W: pool.W,
    U: pool.U,
    B: pool.B,
    R: pool.R,
    G: pool.G,
    C: pool.C,
    restricted: pool.restricted,
  };
}

function clonePlayer(p: PlayerState): PlayerState {
  return {
    id: p.id,
    life: p.life,
    manaPool: clonePool(p.manaPool),
    landsPlayedThisTurn: p.landsPlayedThisTurn,
    hasLost: p.hasLost,
    // poison family (§3.105): copied only when present, so a state that never had
    // the field stays byte-identical to one cloned before poison existed.
    ...(p.poison !== undefined ? { poison: p.poison } : {}),
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
      ...(o.origin !== undefined ? { origin: o.origin } : {}),
      ...(o.awaitingTargetsExcludeSelf !== undefined
        ? { awaitingTargetsExcludeSelf: o.awaitingTargetsExcludeSelf }
        : {}),
      ...(o.awaitingTargetCount !== undefined ? { awaitingTargetCount: o.awaitingTargetCount } : {}),
      // Frozen compile-time data — shared by reference like an InterveningIf.
      ...(o.awaitingModes !== undefined ? { awaitingModes: o.awaitingModes } : {}),
      ...(o.triggeringAmount !== undefined ? { triggeringAmount: o.triggeringAmount } : {}),
      // "That creature" (DESIGN §3.107): a fresh array, because the frame that
      // reads it outlives this stack object and nothing may alias across a clone.
      ...(o.triggeringInstances !== undefined ? { triggeringInstances: [...o.triggeringInstances] } : {}),
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
    // §3.106 — dropping this one would land a suspend-cast creature summoning
    // sick: the two priority passes between the cast and its resolution are
    // two action boundaries, and the marker rode neither. Found by the first
    // test that cast a suspended creature.
    ...(o.hasteOnEntry !== undefined ? { hasteOnEntry: o.hasteOnEntry } : {}),
    // §3.112 — the alternative cost paid and the entwine answer ride the cast.
    ...(o.alternative !== undefined ? { alternative: o.alternative } : {}),
    ...(o.entwined !== undefined ? { entwined: o.entwined } : {}),
    // §3.111 — which graveyard-cast keyword this spell was cast by. Dropping it
    // would turn a retraced spell into a flashback one at the first action
    // boundary and EXILE it as it resolved — a card playing weaker than
    // printed, silently.
    ...(o.graveyardCast !== undefined ? { graveyardCast: o.graveyardCast } : {}),
    // Dropping this one would re-ask the as-enters COPY question every time the
    // resolution is re-entered — and a DECLINE leaves nothing on the instance to
    // notice, so the spell would never finish resolving. Same shape, same rule.
    ...(o.copyAsEntersDecided !== undefined ? { copyAsEntersDecided: o.copyAsEntersDecided } : {}),
    // Dropping this one has the sharpest consequence of any field in this
    // object: `spellLeaveDestination` would stop answering `'ceaseToExist'`
    // (CR 704.5e) at the very next action boundary, and the copy of a spell —
    // which is NOT A CARD — would come to rest in a GRAVEYARD as a phantom card
    // that delirium, flashback and Tarmogoyf all count. The copy looks right for
    // exactly one action and then leaves litter behind it. `clone.test.ts` pins
    // the field; `spell-copy.test.ts` pins the phantom it prevents.
    ...(o.isSpellCopy !== undefined ? { isSpellCopy: o.isSpellCopy } : {}),
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
    // Copied only when present — absent means "nothing has left combat", which
    // is every combat that contains no blink (see `combat-removal.ts`).
    ...(c.removedFromCombat !== undefined ? { removedFromCombat: [...c.removedFromCombat] } : {}),
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
  // purely to add no properties.
  //
  // ⚠️ THE KEY IS ALWAYS WRITTEN, even when there is no choice, and that is not
  // decoration. `applyAction` is `applyActionInPlace` over a clone, and
  // `selfplay-lock.test.ts` compares the two states as SERIALIZED TEXT — so the
  // two paths must agree on key ORDER, not just on values. A conditional key
  // diverges the moment a choice survives an action boundary: the pure path
  // re-inserts it here (in the middle), while the in-place path appends it to the
  // end at the moment it is first parked, and the two states stringify
  // differently while being identical. Writing `null` costs no allocation and
  // pins the position for both paths; `createGame`'s state literal carries the
  // same field at the same place for the same reason.
  next.pendingChoice = state.pendingChoice ? clonePendingChoice(state.pendingChoice) : null;
  next.resolution = state.resolution ? cloneResolution(state.resolution) : null;
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
  // Same conditional rule and the same stakes: a dropped fog would let combat
  // damage through on the very next action's clone, and a dropped SHIELD would
  // silently un-spend itself (the `remaining` count lives on this record). The
  // records are copied one by one rather than shared, because `remaining` is
  // written as a shield is consumed — an aliased array would let one state spend
  // the other's shield.
  if (state.replacements !== undefined && state.replacements.length > 0) {
    next.replacements = state.replacements.map(cloneFloatingReplacement);
  }
  // Same conditional rule, and the sharpest stakes of any state-level field
  // here: this is where a DELAYED triggered ability lives (CR 603.7), and it
  // lives here precisely because it belongs to no object. Drop this line and
  // Kiki-Jiki's token stops being sacrificed at end of turn at the very next
  // action boundary — a permanent hasty copy with no drawback, i.e. strictly
  // better than the printed card, produced by a field-by-field copy that merely
  // forgot a field.
  //
  // The ARRAY is copied and the RECORDS are shared, and the asymmetry with
  // `replacements` above is deliberate rather than an oversight: a
  // `FloatingReplacement` carries a mutable `remaining`, while a delayed record
  // is written once and only ever removed WHOLE (see `delayed.ts`) — so an
  // aliased record cannot be edited by one state behind the other's back, and
  // copying the array is exactly enough to keep one state's creations and
  // firings out of the other's list. `clone.test.ts` pins both halves.
  if (state.delayedTriggers !== undefined && state.delayedTriggers.length > 0) {
    next.delayedTriggers = state.delayedTriggers.slice();
  }
  // Same `!== undefined` rule and the same reason as the two choice fields above:
  // a window that was DECLINED (`null`) is a different shape from one that never
  // opened, and only one of the two engine paths ever re-clones.
  if (state.madnessWindow !== undefined) {
    next.madnessWindow = state.madnessWindow ? { ...state.madnessWindow } : null;
  }
  if (state.turnFactsA !== undefined) next.turnFactsA = state.turnFactsA;
  if (state.turnFactsB !== undefined) next.turnFactsB = state.turnFactsB;
  // §3.113 — storm's count, the same `!== undefined` rule as the facts beside it.
  // (A pile window's `pile` rides the `{ ...madnessWindow }` spread above; it
  // is never mutated in place, so sharing the array is safe.)
  if (state.spellsCastThisTurn !== undefined) next.spellsCastThisTurn = state.spellsCastThisTurn;
  return next;
}

/** Copy one card grant, breaking aliasing on its cost object. */
function cloneCardGrant(grant: CardGrant): CardGrant {
  return grant.flashback !== undefined ? { ...grant, flashback: { ...grant.flashback } } : { ...grant };
}

/**
 * Copy one floating replacement/prevention effect. Spread-copied rather than
 * shared for the reason the call site gives: `remaining` is mutable state.
 */
function cloneFloatingReplacement(record: FloatingReplacement): FloatingReplacement {
  return { ...record };
}

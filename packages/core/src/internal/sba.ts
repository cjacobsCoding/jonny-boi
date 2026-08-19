/**
 * State-based actions (SBAs). Checked at the right times (after each resolution,
 * after combat damage, on priority). They are not actions players take — the game
 * performs them automatically. MVP set:
 *   - A creature with lethal marked damage or ≤0 toughness is destroyed.
 *   - A player at ≤0 life loses.
 *   - A player who attempted to draw from an empty library loses (flagged at draw).
 *
 *   - An attachment (Aura / Equipment) that is not legally attached does what its
 *     data says — see {@link checkAttachments}.
 *
 * SBAs loop until none apply, which is what makes the cascades right: an Aura's
 * host dies, the Aura falls into the graveyard on the next pass, and a creature
 * that only that Aura's +0/+2 was keeping alive dies on the pass after.
 */

import type { CardInstance, GameState, PlayerId } from '../state.js';
import { PLAYER_IDS } from '../state.js';
import type { GameEvent } from '../events.js';
import { isBattle, isCreature, isPlaneswalker } from '../card.js';
import { cardOption, choiceOptionCount, normalizeChoiceRequest } from '../choices.js';
import { defenseOf, effectiveToughness, loyaltyOf, remainingToughness } from './stats.js';
import { moveToZone, resetInstanceForNewZone } from './zones.js';
import { indexContinuous, NO_MOD, pruneOrphanContinuousEffects } from './continuous.js';
import { detachFromHost, isLegallyAttached } from '../attachments.js';

/** Run all pending SBAs until a fixpoint. Mutates the draft; emits events. */
export function checkStateBasedActions(state: GameState, emit: (e: GameEvent) => void): void {
  // The attachments on the battlefield are discovered ONCE per call, not once per
  // fixpoint pass. Nothing ENTERS the battlefield while state-based actions run, so
  // the set can only shrink — and this is the difference between one extra walk of
  // the battlefield per SBA check and one per pass, on a check that runs after every
  // resolution, every draw and every combat-damage step. A board with no attachment
  // (the overwhelmingly common case, and the one the sim spends its life in) gets
  // `null` back and every pass below costs it nothing at all.
  const attachments = collectAttachments(state);
  let changed = true;
  while (changed && !state.gameOver) {
    changed = false;

    // Attachments first (CR 704.5m/n). An Aura falling off changes what its host
    // is, so this must settle BEFORE the death check reads effective toughness —
    // otherwise a creature kept alive by an Aura whose own host just died would be
    // judged against a buff that no longer exists. When anything changed we restart
    // the pass rather than continuing on a stale index.
    if (attachments !== null && checkAttachments(state, attachments, emit)) {
      changed = true;
      continue;
    }

    // Effective toughness/damage are read through the continuous layer so an
    // until-EOT pump that raises toughness keeps a creature alive, and a negative
    // buff can be lethal. Rebuilt each fixpoint pass (effects can change between).
    const index = indexContinuous(state);

    // Creature death: lethal damage or non-positive toughness.
    //
    // Walked with an explicit cursor over the LIVE battlefield rather than over a
    // spread copy of it. The copy existed because `moveToZone` splices the dying
    // creature out from under the loop — but it was one full array allocation per
    // fixpoint pass, on a check that runs after every resolution, every draw and
    // every combat-damage step. Removing the creature at `cursor` shifts the next
    // one into that slot, so NOT advancing after a death visits exactly the same
    // permanents in exactly the same order the snapshot did. (If a death somehow
    // failed to shorten the array, advance anyway — a stuck cursor here would hang
    // the game, and a permanent visited twice is far cheaper than that.)
    for (let cursor = 0; cursor < state.battlefield.length; ) {
      const inst = state.battlefield[cursor] as CardInstance;
      // CR 704.5i: a planeswalker with no loyalty is put into its owner's
      // graveyard. Checked in the same pass as creature death because both are
      // "this permanent stops existing on the battlefield" rules and the cursor
      // walk already handles the splice-under-the-loop mechanics.
      if (isPlaneswalker(inst.def) && !isCreature(inst.def)) {
        if (loyaltyOf(inst) > 0) {
          cursor += 1;
          continue;
        }
        const walkerSizeBefore = state.battlefield.length;
        emit({ type: 'planeswalkerDied', instanceId: inst.instanceId, name: inst.def.name });
        moveToZone(state, inst, 'graveyard', emit, inst.owner);
        resetInstanceForNewZone(inst);
        changed = true;
        if (state.battlefield.length >= walkerSizeBefore) cursor += 1;
        continue;
      }
      // CR 704.5x (generic outcome): a battle with no defense counters is put
      // into its owner's graveyard. Sieges additionally print an exile-and-cast
      // reward — that half needs the castable-second-face system, and cards
      // printing it stay reported by the compiler, so a battle reaching 0 here
      // gives up nothing the game claimed to play. Same cursor mechanics as the
      // walker check above.
      if (isBattle(inst.def) && !isCreature(inst.def)) {
        if (defenseOf(inst) > 0) {
          cursor += 1;
          continue;
        }
        const battleSizeBefore = state.battlefield.length;
        emit({ type: 'battleDefeated', instanceId: inst.instanceId, name: inst.def.name });
        moveToZone(state, inst, 'graveyard', emit, inst.owner);
        resetInstanceForNewZone(inst);
        changed = true;
        if (state.battlefield.length >= battleSizeBefore) cursor += 1;
        continue;
      }
      if (!isCreature(inst.def)) {
        cursor += 1;
        continue;
      }
      const mod = index.get(inst.instanceId) ?? NO_MOD;
      const dead =
        effectiveToughness(inst, mod) <= 0 ||
        remainingToughness(inst, mod) <= 0 ||
        (inst.markedByDeathtouch && inst.damageMarked > 0);
      if (!dead) {
        cursor += 1;
        continue;
      }
      const sizeBefore = state.battlefield.length;
      emit({ type: 'creatureDied', instanceId: inst.instanceId, name: inst.def.name });
      moveToZone(state, inst, 'graveyard', emit, inst.owner);
      resetInstanceForNewZone(inst);
      changed = true;
      if (state.battlefield.length >= sizeBefore) cursor += 1;
    }

    // Player loss by life total.
    for (const pid of PLAYER_IDS) {
      const p = state.players[pid];
      if (!p.hasLost && p.life <= 0) {
        loseGame(state, pid, 'life total 0 or less', emit);
        changed = true;
      }
    }

    // If exactly one player remains, the other wins.
    if (resolveWinner(state, emit)) changed = true;

    // The legend rule (CR 704.5j) — checked LAST in the pass, once nothing else
    // is changing the board, because it may have to STOP the fixpoint: which
    // copy survives is the controlling player's choice, and a state-based action
    // cannot decide it for them. When a duplicate exists the choice is parked
    // and this whole check returns; the answer handler removes the losers and
    // re-runs the SBAs, so cascades (an Aura on the discarded copy, a second
    // duplicated name, the OTHER player's duplicates) settle then.
    if (!changed && !state.gameOver && checkLegendRule(state, emit)) return;
  }

  // A temporary modification only exists while its permanent is on the battlefield.
  // Dropping orphans only at cleanup left a window in which a permanent could leave
  // (die, be bounced) and COME BACK inside the same turn still carrying its old
  // "until end of turn" pump — a re-cast 2/2 read as a 5/5. SBAs run at every point
  // a permanent can have just changed zones, so this is the right place to let go.
  pruneOrphanContinuousEffects(state);
}

/**
 * The attachment state-based actions (CR 704.5m / 704.5n): a permanent with an
 * {@link AttachmentSpec} that is **not legally attached** does what its data says —
 * an Aura is put into its owner's graveyard, an Equipment simply becomes unattached.
 *
 * "Not legally attached" is deliberately ONE question ({@link isLegallyAttached}),
 * because the three ways it happens are the three ways this rule is usually got
 * wrong, and they all have the same answer:
 *   - the host left the battlefield (died, bounced, exiled);
 *   - it is attached to nothing at all (an Aura whose target was gone on
 *     resolution, an Equipment nobody has equipped yet);
 *   - the host no longer satisfies the printed "Enchant …" line.
 *
 * Returns true when it changed anything, so the caller can rebuild the continuous
 * index before judging creature deaths against it.
 *
 * Cost: the early return is what keeps this off the sim's hot path — a board with
 * no attachment pays one property read per permanent and allocates nothing.
 */
function checkAttachments(
  state: GameState,
  attachments: readonly CardInstance[],
  emit: (e: GameEvent) => void,
): boolean {
  let changed = false;
  for (let i = 0; i < attachments.length; i++) {
    const inst = attachments[i] as CardInstance;
    // Already dealt with on an earlier pass (it is in a graveyard now). Skipping by
    // ZONE rather than by rebuilding the list is what keeps this loop from
    // re-reporting the same Aura forever.
    if (inst.zone !== 'battlefield') continue;
    const spec = inst.def.attachment as NonNullable<CardInstance['def']['attachment']>;
    if (isLegallyAttached(state, inst)) continue;
    if (spec.whenIllegal === 'toGraveyard') {
      detachFromHost(inst, emit);
      emit({ type: 'attachmentPutIntoGraveyard', instanceId: inst.instanceId, name: inst.def.name });
      moveToZone(state, inst, 'graveyard', emit, inst.owner);
      resetInstanceForNewZone(inst);
      changed = true;
      continue;
    }
    // `detach` — it stays on the battlefield as an ordinary permanent. Only a
    // change when it was actually attached to something.
    if (inst.attachedTo != null) {
      detachFromHost(inst, emit);
      changed = true;
    }
  }
  return changed;
}

/**
 * Every permanent on the battlefield that declares an attachment, or `null` when
 * there are none.
 *
 * `null` rather than an empty array is the entire performance story: it lets the
 * fixpoint loop skip the attachment rule with a single reference comparison on the
 * boards that have no Aura and no Equipment, which is nearly all of them. (The same
 * shape, and the same reason, as `indexContinuous`'s static-source discovery.)
 */
function collectAttachments(state: GameState): CardInstance[] | null {
  let found: CardInstance[] | null = null;
  const battlefield = state.battlefield;
  for (let i = 0; i < battlefield.length; i++) {
    const perm = battlefield[i] as CardInstance;
    if (perm.def.attachment !== undefined) (found ??= []).push(perm);
  }
  return found;
}

/** Mark a player as having lost, emitting the event. */
export function loseGame(state: GameState, player: PlayerId, reason: string, emit: (e: GameEvent) => void): void {
  const p = state.players[player];
  if (p.hasLost) return;
  p.hasLost = true;
  emit({ type: 'playerLost', player, reason });
}

/** If the game is decided, set winner/gameOver. Returns true if it changed. */
export function resolveWinner(state: GameState, emit: (e: GameEvent) => void): boolean {
  if (state.gameOver) return false;
  const alive = PLAYER_IDS.filter((pid) => !state.players[pid].hasLost);
  if (alive.length <= 1) {
    const winner = alive.length === 1 ? (alive[0] as PlayerId) : null;
    state.winner = winner;
    state.gameOver = true;
    emit({ type: 'gameOver', winner });
    return true;
  }
  return false;
}

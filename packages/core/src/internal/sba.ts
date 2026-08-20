/**
 * State-based actions (SBAs). Checked at the right times (after each resolution,
 * after combat damage, on priority). They are not actions players take — the game
 * performs them automatically. MVP set:
 *   - A creature with lethal marked damage or ≤0 toughness leaves the battlefield —
 *     two DIFFERENT rules, only one of which indestructible exempts (see below).
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

import type { CardInstance, GameState, InstanceId, PlayerId } from '../state.js';
import { NO_COUNTERS, PLAYER_IDS } from '../state.js';
import type { GameEvent } from '../events.js';
import { hasCastableBackFace, isBattle, isCreature, isPlaneswalker } from '../card.js';
import { addCardGrant } from '../card-grants.js';
import { cardOption, choiceOptionCount, normalizeChoiceRequest } from '../choices.js';
import {
  defenseOf,
  effectiveKeywords,
  effectiveToughness,
  loyaltyOf,
  MINUS_ONE_COUNTER,
  PLUS_ONE_COUNTER,
  remainingToughness,
} from './stats.js';
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

    // Creature death: lethal damage (destruction — indestructible exempts it) or
    // non-positive toughness (not destruction — indestructible does not).
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
      // into its owner's graveyard. A SIEGE instead prints its reward (CR
      // 310.4): "exile it, then you may cast it transformed without paying its
      // mana cost". Both endings are the same move to a different zone, plus -
      // for the Siege - the permission that makes the reward reachable, which
      // is recorded as a card grant on the exiled card exactly as an adventure's
      // is. Same cursor mechanics as the walker check above.
      if (isBattle(inst.def) && !isCreature(inst.def)) {
        if (defenseOf(inst) > 0) {
          cursor += 1;
          continue;
        }
        // Read BEFORE the move: `resetInstanceForNewZone` reverts the active
        // face, and the reward is a property of the definition either way, but
        // the controller (who gets to cast it) is battlefield state.
        const reward = hasCastableBackFace(inst.def) ? inst.controller : undefined;
        const battleSizeBefore = state.battlefield.length;
        emit({ type: 'battleDefeated', instanceId: inst.instanceId, name: inst.def.name });
        moveToZone(state, inst, reward === undefined ? 'graveyard' : 'exile', emit, inst.owner);
        resetInstanceForNewZone(inst);
        if (reward !== undefined) {
          addCardGrant(
            state,
            {
              targetInstanceId: inst.instanceId,
              sourceInstanceId: inst.instanceId,
              zone: 'exile',
              duration: 'permanent',
              castFace: 'back',
              castFree: true,
            },
            emit,
          );
        }
        changed = true;
        if (state.battlefield.length >= battleSizeBefore) cursor += 1;
        continue;
      }
      if (!isCreature(inst.def)) {
        cursor += 1;
        continue;
      }
      const mod = index.get(inst.instanceId) ?? NO_MOD;
      // The creature-death state-based actions are TWO DIFFERENT RULES, and
      // indestructible exempts exactly one of them. Keeping them as separate
      // questions here is the entire point:
      //   - CR 704.5f — toughness 0 or less puts the creature into its owner's
      //     graveyard. Indestructible does not mention this rule and does not
      //     stop it, so a -N/-N that takes toughness to 0 kills an indestructible
      //     creature. Asked FIRST, and never gated on the flag.
      //   - CR 704.5g — LETHAL MARKED DAMAGE destroys the creature, and CR 702.2b
      //     deathtouch makes any nonzero damage lethal. Both are destruction, so
      //     CR 702.12b exempts both.
      // Collapsing the two into one expression guarded by the flag is the classic
      // wrong implementation: it makes an indestructible creature survive having
      // no toughness at all.
      //
      // Cost: the keyword read is placed AFTER the damage test on purpose, so a
      // creature that is not dying at all — nearly every creature on nearly every
      // pass of this loop — never pays for it.
      const destroyedByDamage =
        remainingToughness(inst, mod) <= 0 || (inst.markedByDeathtouch && inst.damageMarked > 0);
      const dead =
        effectiveToughness(inst, mod) <= 0 ||
        (destroyedByDamage && !effectiveKeywords(inst, mod).indestructible);
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

    // CR 704.5q — a permanent with both +1/+1 and -1/-1 counters has N of each
    // removed, where N is the smaller number. See {@link annihilateCounters}.
    if (annihilateCounters(state, emit)) changed = true;

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
 * CR 704.5q — "if a permanent has both a +1/+1 counter and a -1/-1 counter on it,
 * N +1/+1 and N -1/-1 counters are removed from it, where N is the smaller of the
 * two numbers."
 *
 * ## Why it lives HERE and not in the primitive that puts the counters on
 * `putCountersOn` used to do this itself, which is right for the one path that
 * calls it and wrong for every other. Counters arrive on a permanent by several
 * routes — a resolving effect, a trigger, persist returning a creature with a
 * -1/-1 counter, a token created with counters, and whatever the next branch adds
 * — and a rule implemented inside ONE of those routes is a rule the others do not
 * have. CR 704.5q is a state-based action, so the state-based action pass is the
 * seam: every route now gets it, at the moment the rules say, and there is one
 * implementation to keep right instead of one per producer.
 *
 * The arithmetic is unchanged either way ({@link counterShift} nets the tallies),
 * so what this fixes is the STATE rather than the numbers: after it runs, "does
 * this permanent have a -1/-1 counter on it?" — which persist, undying and
 * "remove a counter" all ask — has the answer the printed card gives.
 *
 * Returns true when it removed anything, so the fixpoint runs another pass.
 *
 * Cost: one reference comparison per permanent on a board where nothing carries a
 * counter, and no allocation at all. `NO_COUNTERS` is the shared frozen empty
 * record every counter-free permanent points at, so the common board never even
 * enumerates a key.
 */
function annihilateCounters(state: GameState, emit: (e: GameEvent) => void): boolean {
  let removedAny = false;
  const battlefield = state.battlefield;
  for (let i = 0; i < battlefield.length; i++) {
    const perm = battlefield[i] as CardInstance;
    const counters = perm.counters;
    if (counters === NO_COUNTERS) continue;
    const plus = counters[PLUS_ONE_COUNTER] ?? 0;
    const minus = counters[MINUS_ONE_COUNTER] ?? 0;
    // Both kinds must be genuinely PRESENT. A negative tally is not a counter of
    // the other kind (nothing in the rules can put "minus one +1/+1 counter" on a
    // permanent), so `Math.min` alone would happily "annihilate" a pair that is
    // not there.
    if (plus <= 0 || minus <= 0) continue;
    const n = Math.min(plus, minus);
    // REPLACE the record, never write into it — `CardInstance.counters` is shared
    // and frozen while a permanent has none. Same contract `putCountersOn` obeys.
    perm.counters = { ...counters, [PLUS_ONE_COUNTER]: plus - n, [MINUS_ONE_COUNTER]: minus - n };
    // Reported as the two removals it is, through the existing counter event with
    // a NEGATIVE amount — the vocabulary persist already speaks. A dedicated
    // "annihilated" event would be a second way to say "these counters left".
    emit({ type: 'counterAdded', instanceId: perm.instanceId, kind: PLUS_ONE_COUNTER, amount: -n });
    emit({ type: 'counterAdded', instanceId: perm.instanceId, kind: MINUS_ONE_COUNTER, amount: -n });
    removedAny = true;
  }
  return removedAny;
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

/**
 * If the game is decided, set winner/gameOver. Returns true if it changed.
 *
 * The two seats are read DIRECTLY rather than through `PLAYER_IDS.filter(...)`,
 * which allocated a predicate closure and a result array on every state-based
 * action check — after every resolution, every draw, every combat-damage step
 * and (now) every priority boundary — to decide a question about two booleans.
 * Same answer, no allocation. (The same reason `indexContinuous` reads the two
 * command zones directly instead of looping `PLAYER_IDS`.)
 */
export function resolveWinner(state: GameState, emit: (e: GameEvent) => void): boolean {
  if (state.gameOver) return false;
  const aLost = state.players.A.hasLost;
  const bLost = state.players.B.hasLost;
  if (!aLost && !bLost) return false;
  // Both out at once is a draw, exactly as `alive.length === 0` was.
  const winner: PlayerId | null = aLost && bLost ? null : aLost ? 'B' : 'A';
  state.winner = winner;
  state.gameOver = true;
  emit({ type: 'gameOver', winner });
  return true;
}

/**
 * Whether any state-based action could POSSIBLY apply right now — the cheap gate
 * in front of the CR 704.3 priority-boundary check.
 *
 * ## Why a gate exists at all
 * CR 704.3 checks state-based actions whenever a player would receive priority,
 * which in this engine is the single hottest thing a game does: a sim game passes
 * priority hundreds of times, and every one of those passes is followed by an
 * action that already ran the full check at its own mutation site. The boundary
 * check is a BACKSTOP for the next mutation path that forgets, so it must be
 * approximately free on the overwhelming majority of passes where it has nothing
 * to do (rule 7).
 *
 * ## The direction it is allowed to be wrong in
 * It may answer **true** on a board where the real check turns out to do nothing;
 * that costs one wasted check. It must NEVER answer false on a board where the
 * real check would act — that would silently defer a state-based action, which is
 * the whole defect this backstop exists to prevent. Every test of it is written in
 * that direction, and every clause below is either the rule's own condition or a
 * conservative superset of it.
 *
 * The one subtle clause is creature death. Effective toughness is printed base +
 * counters + everything the continuous layer contributes, and the layer's
 * contributions come from exactly four places — an "until end of turn" effect
 * (`state.continuous`), a static ability, an attachment, and a `*` P/T formula
 * (plus emblems radiating statics from a command zone). When NONE of those exists
 * on the board, `NO_MOD` is not an approximation, it is the true aggregate, so the
 * printed-plus-counters read below is the SAME arithmetic the real check performs
 * — via the same `remainingToughness`/`effectiveToughness` functions, so the two
 * cannot drift into a second opinion. When any of them does exist, this returns
 * true without trying to reason about it.
 */
export function stateBasedActionsPossible(state: GameState): boolean {
  // A decided game performs no more state-based actions.
  if (state.gameOver) return false;
  const a = state.players.A;
  const b = state.players.B;
  // CR 704.5a/b — a lost seat that has not yet been resolved into a winner, or a
  // life total the check has not seen yet.
  if (a.hasLost || b.hasLost || a.life <= 0 || b.life <= 0) return true;
  // Anything that can make effective toughness differ from the printed box, or
  // that can be an orphaned modification waiting to be pruned.
  if (state.continuous.length > 0) return true;
  // Emblems radiate statics from the command zone (CR 114), so a non-empty
  // command zone is a modifier source exactly as a permanent with statics is.
  if (a.command.length > 0 || b.command.length > 0) return true;

  let legendary = 0;
  const battlefield = state.battlefield;
  for (let i = 0; i < battlefield.length; i++) {
    const perm = battlefield[i] as CardInstance;
    const def = perm.def;
    // Modifier sources — see the note above. Any of these and the printed box is
    // not the answer, so the real check has to run.
    if (def.statics !== undefined || def.characteristicPT !== undefined) return true;
    // An attachment is both a modifier source (layer 3a) and its own state-based
    // action (CR 704.5m/n), so either end of the relationship is enough.
    if (def.attachment !== undefined || perm.attachedTo != null) return true;
    // Counters change the box (+1/+1 / -1/-1), ARE the box for a walker's loyalty
    // (CR 704.5i) and a battle's defense (CR 704.5x), and are the subject of CR
    // 704.5q. One reference comparison for the counter-free permanent that is
    // nearly every permanent; the loop only runs for one that carries something.
    if (perm.counters !== NO_COUNTERS) {
      for (const kind in perm.counters) {
        void kind;
        return true;
      }
    }
    // CR 704.5j — two legendary permanents may share a name. Counting is enough:
    // deciding whether the names actually match is the real check's job.
    if (def.legendary === true && ++legendary > 1) return true;
    if (!isCreature(def)) continue;
    // CR 704.5f / 704.5g, read with the aggregate that is genuinely empty here.
    if (effectiveToughness(perm) <= 0) return true;
    if (perm.damageMarked > 0 && (remainingToughness(perm) <= 0 || perm.markedByDeathtouch)) return true;
  }
  return false;
}

// --- the legend rule (CR 704.5j) -------------------------------------------------

/**
 * The legend rule, as ONE state-based action for every legendary permanent kind
 * - creatures, planeswalkers, battles, artifacts, enchantments, lands alike.
 *
 * CR 704.5j: if a player controls two or more legendary permanents **with the
 * same name**, that player chooses one of them and the rest are put into their
 * owners' graveyards. Three details a walker-only or creature-only version gets
 * wrong, and which are why this is shared:
 *   - it is **per PLAYER, not global**: each player may control their own copy of
 *     the same legend quite legally, and nothing happens;
 *   - the **controller chooses**, not the game - so unlike every other SBA this
 *     one cannot be decided here, and instead parks a question;
 *   - the discarded copies go to their **OWNERS'** graveyards, which is not
 *     necessarily the chooser's (a stolen legend goes home).
 *
 * Returns true when it PARKED a choice, which tells the SBA loop to stop: the
 * board cannot settle until the question is answered. {@link applyLegendRuleChoice}
 * finishes the job and re-runs the SBAs, so cascades (a second duplicated name,
 * the other player's duplicates, an Aura orphaned by the copy that left) settle
 * on that pass rather than being missed here.
 *
 * Cost: one property read per permanent on a board with fewer than two legendary
 * permanents - which is nearly every board in the sim - and no allocation at all.
 */
function checkLegendRule(state: GameState, emit: (e: GameEvent) => void): boolean {
  // Never stack two questions. A choice already parked belongs to somebody (a
  // resolving spell, a shockland, an earlier legend-rule pass) and overwriting it
  // would silently drop the game's outstanding decision. The rule is not skipped,
  // only deferred: answering re-runs the SBAs.
  if (state.pendingChoice) return false;

  const duplicates = findLegendDuplicates(state);
  if (duplicates === null) return false;

  const choice = normalizeChoiceRequest(
    {
      kind: 'selectCards',
      chooser: duplicates.controller,
      prompt: `Legend rule: choose which ${duplicates.name} to keep`,
      candidates: duplicates.copies.map(cardOption),
      min: LEGEND_RULE_KEEP_COUNT,
      max: LEGEND_RULE_KEEP_COUNT,
      // Being selected is being KEPT, so the AI's "pick your best" steer is the
      // right one - the copies share a name, but one may be untapped, wearing an
      // Aura, or no longer summoning sick.
      valence: 'gain',
    },
    {
      id: state.nextInstanceId++,
      sourceInstanceId: (duplicates.copies[0] as CardInstance).instanceId,
      sourceName: duplicates.name,
    },
  );
  if (!choice) return false;
  // The marker is what routes the answer: this question has no resolution frame
  // behind it (a state-based action is not a resolution), so `applyAnswerChoice`
  // must be able to tell it apart from an ordinary card selection.
  state.pendingChoice = { ...choice, context: 'legendRule' };
  state.priorityPlayer = duplicates.controller;
  state.consecutivePasses = 0;
  emit({
    type: 'choiceAsked',
    choiceId: choice.id,
    chooser: choice.chooser,
    choiceKind: choice.kind,
    prompt: choice.prompt,
    sourceInstanceId: choice.sourceInstanceId,
    optionCount: choiceOptionCount(choice),
  });
  return true;
}

/** The legend rule keeps exactly one of the duplicates (CR 704.5j). */
const LEGEND_RULE_KEEP_COUNT = 1;

/** A set of same-named legendary permanents one player controls. */
interface LegendDuplicates {
  readonly controller: PlayerId;
  readonly name: string;
  readonly copies: readonly CardInstance[];
}

/**
 * The FIRST group of same-named legendary permanents a single player controls,
 * or `null` when the rule does not apply.
 *
 * "First" is deterministic - battlefield order decides, and the battlefield is
 * stably ordered - so a seeded sim always asks about the same group first when
 * two different names are duplicated at once. (The second group is found by the
 * re-check after the first is answered.)
 *
 * The two-phase shape is the whole performance story: a board with fewer than two
 * legendary permanents answers with one property read each and NO map, which is
 * what keeps this off the sim's hot path. Names are compared as printed
 * (CR 201.2), and by the ACTIVE face's name, since `inst.def` is the face that is
 * up - a transformed DFC is legend-checked as what it currently is.
 */
function findLegendDuplicates(state: GameState): LegendDuplicates | null {
  const battlefield = state.battlefield;
  let legendaryCount = 0;
  for (let i = 0; i < battlefield.length; i++) {
    if ((battlefield[i] as CardInstance).def.legendary === true) legendaryCount += 1;
  }
  if (legendaryCount < 2) return null;

  // Keyed on controller AND name: the same legend under two different players is
  // not a legend-rule violation, and folding them together is precisely the
  // "global instead of per player" bug this shape exists to prevent.
  const groups = new Map<string, CardInstance[]>();
  for (let i = 0; i < battlefield.length; i++) {
    const perm = battlefield[i] as CardInstance;
    if (perm.def.legendary !== true) continue;
    const key = `${perm.controller} ${perm.def.name}`;
    const group = groups.get(key);
    if (group === undefined) groups.set(key, [perm]);
    else group.push(perm);
  }
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const first = group[0] as CardInstance;
    return { controller: first.controller, name: first.def.name, copies: group };
  }
  return null;
}

/**
 * Finish the legend rule once its controller has named the copy they keep: every
 * OTHER legendary permanent that player controls with that name is put into its
 * **owner's** graveyard (CR 704.5j).
 *
 * The losing set is re-derived from the kept permanent rather than read from a
 * list captured when the question was asked - a board can change between the two
 * moments, and a stale list would try to bury a permanent that has already left.
 *
 * Exported for `applyAnswerChoice`, which is the only caller.
 */
export function applyLegendRuleChoice(
  state: GameState,
  keptInstanceId: InstanceId,
  emit: (e: GameEvent) => void,
): void {
  const kept = state.battlefield.find((perm) => perm.instanceId === keptInstanceId);
  // The kept copy left the battlefield between question and answer: the rule has
  // no chosen survivor, so nothing is buried here. The re-check below sees
  // whatever board actually exists and asks again if it must.
  if (!kept) {
    checkStateBasedActions(state, emit);
    return;
  }
  const controller = kept.controller;
  const name = kept.def.name;
  // Snapshot first: `moveToZone` splices the battlefield under any live walk.
  const losers = state.battlefield.filter(
    (perm) =>
      perm.instanceId !== keptInstanceId &&
      perm.def.legendary === true &&
      perm.controller === controller &&
      perm.def.name === name,
  );
  emit({ type: 'legendRuleApplied', player: controller, name, keptInstanceId });
  for (const loser of losers) {
    // A legendary CREATURE leaving this way is still a creature dying - the same
    // event every other death emits, so dies-triggers and any log reader see it
    // through the one mechanism. Walkers and battles announce themselves in kind.
    if (isCreature(loser.def)) {
      emit({ type: 'creatureDied', instanceId: loser.instanceId, name: loser.def.name });
    } else if (isPlaneswalker(loser.def)) {
      emit({ type: 'planeswalkerDied', instanceId: loser.instanceId, name: loser.def.name });
    } else if (isBattle(loser.def)) {
      emit({ type: 'battleDefeated', instanceId: loser.instanceId, name: loser.def.name });
    }
    moveToZone(state, loser, 'graveyard', emit, loser.owner);
    resetInstanceForNewZone(loser);
  }
  // Everything the departures set off - an orphaned Aura, a creature an anthem
  // was propping up, a SECOND duplicated name - settles now.
  checkStateBasedActions(state, emit);
}

/**
 * CARD GRANTS — continuous effects on cards in NON-battlefield zones.
 *
 * The continuous layer (`internal/continuous.ts`) modifies PERMANENTS: its index
 * is keyed on battlefield instances, its statics radiate from battlefield
 * sources, and its orphan-pruning drops anything not in play. A grant like
 * Snapcaster Mage's — "target instant or sorcery card **in your graveyard**
 * gains flashback until end of turn" — modifies a card that is, by definition,
 * not on the battlefield, so it cannot live there without breaking that layer's
 * assumptions. It lives here instead, as its own small list with its own rules.
 *
 * ## The zone-change rule (CR 400.7)
 * A card that changes zones becomes a NEW object, and a continuous effect that
 * was affecting the old object does not affect the new one. So a grant records
 * the zone it was made in, and it is DROPPED the moment its card leaves that
 * zone — including a card that leaves and comes back (same instance id, same
 * zone, but a new object per the rule; active pruning at the zone-move
 * chokepoints is what makes that corner faithful, and the recorded zone is the
 * belt-and-braces read-time check behind it).
 *
 * The one deliberate exception mirrors CR 400.7g: an effect that allows a card
 * to be CAST continues to apply to the spell it becomes on the stack. In this
 * engine that continuation is structural, not stored: casting via flashback
 * reads the granted cost at announcement, and everything after that — the
 * exile on leaving the stack, countered or resolved — derives from the stack
 * object's own `castFrom` (`spellLeaveDestination`), never from the grant. So
 * pruning the grant as the card leaves the graveyard loses nothing.
 *
 * ## Performance (DESIGN §1.7)
 * `GameState.cardGrants` is OPTIONAL and absent in every game that never grants
 * anything — which is every game today that doesn't cast a Snapcaster. Every
 * reader and every pruning hook starts with the same empty check the continuous
 * layer's fast path uses (`hasCardGrants`), so the hot loops (legal-action
 * generation, cloning, zone moves) pay one property read when no grant exists.
 */

import type { ManaCost } from './mana.js';
import type { CardInstance, GameState, InstanceId, PlayerId, ZoneName } from './state.js';
import type { ContinuousDuration } from './internal/continuous.js';
import type { GameEvent } from './events.js';

/**
 * One active grant to a single card in a non-battlefield zone. Instance-scoped:
 * it names exactly one card instance, in exactly one zone, for one duration.
 *
 * Only `flashback` is grantable today. The field is optional so the record's
 * shape can grow the way `KeywordFlags` did — a future "gains 'this card may
 * block as though…'"-style grant adds a field, not a second list.
 */
export interface CardGrant {
  /** Stable id (minted from `GameState.nextInstanceId`) for debug/dedupe. */
  readonly id: number;
  /** The card instance this grant modifies. */
  readonly targetInstanceId: InstanceId;
  /** The instance that created the grant (for the event log / inspector). */
  readonly sourceInstanceId: InstanceId;
  readonly duration: ContinuousDuration;
  /**
   * The zone the card occupied when granted. A grant applies only while its
   * card is STILL in this zone — the read-time half of the CR 400.7 rule; the
   * zone-move chokepoints prune the record itself (see module header).
   */
  readonly zone: ZoneName;
  /**
   * A granted flashback cost — "gains flashback until end of turn". Read by
   * {@link flashbackCostOf}; the printed `CardDefinition.flashback` wins when
   * both exist (they never conflict today: a card with printed flashback is
   * a pointless grant target, and the printed cost is the conservative pick).
   */
  readonly flashback?: ManaCost;
  /**
   * PERMISSION TO CAST THIS CARD from {@link zone}, naming which face — the
   * shape shared by the two "you may cast it later" effects the rules print:
   *
   *  - an ADVENTURE (CR 715.3d): the adventure spell exiles its own card on
   *    resolution and its owner may then cast the CREATURE half (`'front'`)
   *    from exile;
   *  - a defeated SIEGE (CR 310.4): the battle is exiled and its controller may
   *    cast the reward half (`'back'`) from exile, without paying its cost.
   *
   * It is a GRANT rather than a field on the instance for one reason that is
   * worth keeping: CR 400.7 says the permission dies with the object, and the
   * grant list already prunes itself at every zone-move chokepoint. A card that
   * leaves exile and comes back is a new object with no permission, for free.
   *
   * The grant's {@link duration} is `'permanent'` for both — an adventure waits
   * in exile indefinitely — so it survives the cleanup step's expiry sweep.
   */
  readonly castFace?: import('./actions.js').CastFace;
  /** The granted cast pays no mana cost (a Siege reward — CR 310.4). */
  readonly castFree?: boolean;
  // --- the cast-alternative family (§3.112) -----------------------------------------
  /**
   * The granted cast pays THIS cost instead of the printed one — a foretold
   * card's foretell cost (CR 702.143a). Ignored when {@link castFree} is set.
   */
  readonly castCost?: ManaCost;
  /**
   * The permission opens only AFTER this turn number — "after the current turn
   * has ended" (foretell, CR 702.143a; warp, CR 702.185a) and "on a later
   * turn" (plot, CR 702.170a). Absent means the permission is open at once.
   */
  readonly castAfterTurn?: number;
  /**
   * The granted cast is sorcery-speed whatever the card's own timing — a
   * plotted card is "cast as a sorcery" (CR 702.170a).
   */
  readonly castAsSorcery?: boolean;
  /**
   * WHO may cast under this permission, when it is not the card's owner.
   *
   * Every permission before Jace's −8 was the owner's own — an adventurer, a
   * Siege reward, a foretold card all sit in their owner's exile and are cast by
   * that owner. "You may cast those cards without paying their mana costs",
   * said of cards exiled from EACH player's library, is the first grant whose
   * caster is another seat: the card sits in its owner's exile (this engine
   * models exile per player) and Jace's controller is the one allowed to cast
   * it. Absent means the owner, which keeps every existing grant byte-identical.
   * `castPermissionFor` resolves it to {@link CastPermission.by}, and the offer
   * loop, the cast path and the pilot all compare THAT to the acting player.
   */
  readonly castBy?: PlayerId;
}

/** What `castPermissionFor` answers — see the grant fields it reads. */
export interface CastPermission {
  readonly face: import('./actions.js').CastFace;
  readonly free: boolean;
  /** The seat this permission belongs to: `CardGrant.castBy`, else the card's owner. */
  readonly by: PlayerId;
  /** §3.112 — the cost the permission charges in place of the printed one. */
  readonly cost?: ManaCost;
  /**
   * §3.112 — the cast is sorcery-speed regardless of the card's own timing (a
   * plotted card, CR 702.170a). Present only when it HOLDS, for the reason
   * {@link cost} is: an adventurer's and a Siege's permission then answer with
   * exactly the object every consumer has always seen, which is what
   * `split-cards.test.ts` compares whole.
   */
  readonly asSorcery?: true;
}

/**
 * The permission `card` currently has to be cast from the zone it is sitting
 * in, or `undefined`. THE accessor, exactly as {@link flashbackCostOf} is for
 * flashback: `generateLegalActions` offers by it and `applyCastSpell` accepts
 * by it, so a hostile client cannot cast an exiled card the offer loop would
 * never have shown.
 */
export function castPermissionFor(state: GameState, card: CardInstance): CastPermission | undefined {
  const grants = state.cardGrants;
  if (grants === undefined || grants.length === 0) return undefined;
  for (let i = 0; i < grants.length; i++) {
    const grant = grants[i] as CardGrant;
    if (grant.castFace === undefined) continue;
    if (grant.targetInstanceId !== card.instanceId) continue;
    if (grant.zone !== card.zone) continue;
    // §3.112 — "after the current turn has ended": a foretold, plotted or
    // warped card is not castable on the turn it was set aside. Judged here,
    // in THE accessor, so the offer loop, the cast path and the pilot agree.
    if (grant.castAfterTurn !== undefined && state.turnNumber <= grant.castAfterTurn) continue;
    return {
      face: grant.castFace,
      free: grant.castFree === true,
      by: grant.castBy ?? card.owner,
      ...(grant.castCost !== undefined ? { cost: grant.castCost } : {}),
      ...(grant.castAsSorcery === true ? { asSorcery: true } : {}),
    };
  }
  return undefined;
}

/**
 * Whether any grant exists at all — the ONE empty check every consumer starts
 * with, mirroring the `state.continuous.length === 0` fast-path discipline in
 * targeting. A game that never grants pays exactly this much, everywhere.
 */
export function hasCardGrants(state: GameState): boolean {
  const grants = state.cardGrants;
  return grants !== undefined && grants.length > 0;
}

/**
 * The flashback cost `card` can actually be cast for right now: its printed
 * cost, or an active grant's. This is THE accessor — `generateLegalActions`,
 * `applyCastSpell` and the AI pilots all read flashback through here, so
 * "can this card flash back, and for how much?" has exactly one answer.
 *
 * A grant is honoured only while the card sits in the zone it was granted in
 * (CR 400.7 — see the module header); anything else reads as no grant.
 */
export function flashbackCostOf(state: GameState, card: CardInstance): ManaCost | undefined {
  const printed = card.def.flashback;
  if (printed !== undefined) return printed;
  const grants = state.cardGrants;
  if (grants === undefined || grants.length === 0) return undefined;
  for (let i = 0; i < grants.length; i++) {
    const grant = grants[i] as CardGrant;
    if (grant.targetInstanceId !== card.instanceId) continue;
    if (grant.zone !== card.zone) continue;
    if (grant.flashback !== undefined) return grant.flashback;
  }
  return undefined;
}

/** The fields a granter supplies; identity and bookkeeping are minted here. */
export interface CardGrantRequest {
  readonly targetInstanceId: InstanceId;
  readonly sourceInstanceId: InstanceId;
  /** The zone the target currently occupies (the granter has it in hand). */
  readonly zone: ZoneName;
  readonly duration?: ContinuousDuration;
  readonly flashback?: ManaCost;
  readonly castFace?: import('./actions.js').CastFace;
  readonly castFree?: boolean;
  /** §3.112 — see `CardGrant.castCost` / `castAfterTurn` / `castAsSorcery`. */
  readonly castCost?: ManaCost;
  readonly castAfterTurn?: number;
  readonly castAsSorcery?: boolean;
  /** See `CardGrant.castBy` — the caster when it is not the owner. */
  readonly castBy?: PlayerId;
}

/**
 * Register a grant on the draft state, emitting `cardGrantAdded`. Returns the
 * new grant's id. The list is created on first use — a state that never grants
 * never carries the field at all (see the module header's perf note).
 */
export function addCardGrant(
  state: GameState,
  request: CardGrantRequest,
  emit: (e: GameEvent) => void,
): number {
  const id = state.nextInstanceId++;
  const grant: CardGrant = {
    id,
    targetInstanceId: request.targetInstanceId,
    sourceInstanceId: request.sourceInstanceId,
    duration: request.duration ?? 'endOfTurn',
    zone: request.zone,
    ...(request.flashback !== undefined ? { flashback: { ...request.flashback } } : {}),
    ...(request.castFace !== undefined ? { castFace: request.castFace } : {}),
    ...(request.castFree === true ? { castFree: true } : {}),
    // §3.112
    ...(request.castCost !== undefined ? { castCost: { ...request.castCost } } : {}),
    ...(request.castAfterTurn !== undefined ? { castAfterTurn: request.castAfterTurn } : {}),
    ...(request.castAsSorcery === true ? { castAsSorcery: true } : {}),
    ...(request.castBy !== undefined ? { castBy: request.castBy } : {}),
  };
  (state.cardGrants ??= []).push(grant);
  emit({
    type: 'cardGrantAdded',
    targetInstanceId: grant.targetInstanceId,
    sourceInstanceId: grant.sourceInstanceId,
    duration: grant.duration,
  });
  return id;
}

/**
 * Remove every grant of the given duration (the cleanup step's "until end of
 * turn" expiry), emitting `cardGrantExpired` per removed grant so the
 * inspector/sim-log can show the flashback wearing off. Returns how many left.
 */
export function expireCardGrants(
  state: GameState,
  duration: ContinuousDuration,
  emit: (e: GameEvent) => void,
): number {
  const grants = state.cardGrants;
  if (grants === undefined || grants.length === 0) return 0;
  let removed = 0;
  const kept: CardGrant[] = [];
  for (const grant of grants) {
    if (grant.duration === duration) {
      removed += 1;
      emit({
        type: 'cardGrantExpired',
        targetInstanceId: grant.targetInstanceId,
        sourceInstanceId: grant.sourceInstanceId,
      });
    } else {
      kept.push(grant);
    }
  }
  if (removed > 0) state.cardGrants = kept;
  return removed;
}

/**
 * Drop every grant targeting `instanceId` — the CR 400.7 zone-change hook,
 * called from the zone-move chokepoints (core's `moveToZone`, the flashback
 * cast's graveyard→stack move, and the `cards` package's own zone movers via
 * this export) the moment a card changes zones. Pure bookkeeping; emits
 * nothing — the `zoneChange` event already tells the story, and the grant
 * simply stops being true.
 *
 * Cheap by construction: the empty check is the whole cost for every game that
 * has no grant in flight, which is nearly all of them.
 */
export function pruneCardGrantsFor(state: GameState, instanceId: InstanceId): void {
  const grants = state.cardGrants;
  if (grants === undefined || grants.length === 0) return;
  let any = false;
  for (let i = 0; i < grants.length; i++) {
    if ((grants[i] as CardGrant).targetInstanceId === instanceId) {
      any = true;
      break;
    }
  }
  if (!any) return;
  state.cardGrants = grants.filter((grant) => grant.targetInstanceId !== instanceId);
}

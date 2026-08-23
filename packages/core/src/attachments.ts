/**
 * ATTACHMENT SEAM — one permanent attached to another. Auras ("Enchant creature")
 * and Equipment ("Equip {2}") are the same relationship; they differ only in *how*
 * they become attached and *what happens* when the attachment stops being legal.
 *
 * ## Why one system, not two
 * An "aura system" and an "equipment system" would duplicate the relationship, the
 * layering, and the state-based actions three times over — and every future
 * attachment kind (Fortifications, "attach to a land") would be a fourth. What an
 * attachment IS is a single reference (`CardInstance.attachedTo`) plus a
 * {@link PermanentModification} the host receives while the relationship holds.
 * The two printed forms are then just two rows of DATA:
 *
 *   - an Aura attaches when its spell RESOLVES (the `attachToTarget` effect ref in
 *     its ETB script), and is put into its owner's graveyard when it is not
 *     legally attached (CR 704.5m);
 *   - an Equipment attaches through an ACTIVATED ability (`Equip {N}` = "{N}:
 *     Attach to target creature you control. Activate only as a sorcery."), and
 *     merely becomes unattached (CR 704.5n).
 *
 * Both are expressed by {@link AttachmentSpec}: a host filter, a modification, and
 * `whenIllegal`. Core never asks "is this an aura".
 *
 * ## Lifetime is DERIVED, exactly as it is for statics
 * The modification is never pushed into `GameState.continuous`. Every effective-P/T
 * read re-derives it from the permanents currently on the battlefield (see
 * `internal/continuous.ts`), so the instant the attachment leaves play its buff is
 * gone with no bookkeeping, no expiry, and no window where a stale buff outlives
 * its source. See `statics.ts` for the same argument in full.
 *
 * ## Legality is checked by ONE predicate, in ONE place
 * {@link isLegallyAttached} is asked by the state-based actions (`internal/sba.ts`)
 * and by {@link attachTo} before it forms the relationship, so an attachment can
 * never be created in a state the SBAs would immediately undo — the two cannot
 * disagree because they are the same function.
 */

import type { CardInstance, GameState, InstanceId, PlayerId } from './state.js';
import type { CardFilter } from './choices.js';
import { matchesCardFilter } from './choices.js';
import type { CardDefinition } from './card.js';
import { effectiveProtectionOf, protectionBlocksSource } from './protection.js';
import type { PermanentModification, StaticControllerScope } from './statics.js';

/**
 * What the game does when a permanent with an {@link AttachmentSpec} is not
 * legally attached to anything.
 *
 * - `toGraveyard` — CR 704.5m, the Aura rule: an Aura attached to an illegal
 *   object, or to nothing at all, is put into its owner's graveyard.
 * - `detach` — CR 704.5n, the Equipment rule: it simply becomes unattached and
 *   stays on the battlefield as an ordinary permanent.
 *
 * This is the ONLY behavioural difference between the two printed forms, which is
 * why it is a data field rather than two subsystems.
 */
export type AttachmentIllegalAction = 'toGraveyard' | 'detach';

/** CR 704.5m — an Aura not legally attached dies. */
export const AURA_WHEN_ILLEGAL: AttachmentIllegalAction = 'toGraveyard';
/** CR 704.5n — an Equipment not legally attached just falls off. */
export const EQUIPMENT_WHEN_ILLEGAL: AttachmentIllegalAction = 'detach';

/**
 * What a given attachment may legally be attached to — the printed "Enchant
 * creature" / "creature you control" line.
 *
 * Extends the shared {@link CardFilter} vocabulary rather than inventing a second
 * filter language (the same choice `StaticAffects` makes), and adds the one thing
 * only a battlefield relationship needs: whose permanents are eligible, relative to
 * the attachment's own controller.
 */
export interface AttachmentHostFilter extends CardFilter {
  /**
   * Whose permanents may host this. Defaults to {@link DEFAULT_HOST_SCOPE}, which
   * is `any`: "Enchant creature" means *any* creature, and a card that means "you
   * control" (every Equip ability does) says so explicitly.
   */
  readonly controller?: StaticControllerScope;
}

/**
 * The host scope assumed when an attachment does not say otherwise.
 *
 * Deliberately `any`, which is the opposite of the statics default — and for the
 * opposite reason. An anthem that forgets to say "you control" would become a
 * symmetric anthem that also pumps the opponent's board; an *attachment* that
 * forgets would become NARROWER than printed and refuse legal hosts. Each default
 * is the one that cannot make a card better than its printed text.
 */
export const DEFAULT_HOST_SCOPE: StaticControllerScope = 'any';

/**
 * The data a card declares to be an attachment: what it can be attached to, what
 * it does to its host while attached, and what happens when it isn't legally
 * attached.
 */
export interface AttachmentSpec {
  /** The printed "Enchant …" / "…creature you control" line. */
  readonly attachesTo: AttachmentHostFilter;
  /**
   * The continuous modification the HOST receives while this is attached to it —
   * "Enchanted creature gets +2/+0 and has trample". Omit for an attachment whose
   * text does something else entirely (a triggered ability on the aura itself).
   */
  readonly modifies?: PermanentModification;
  /** CR 704.5m/n: what the state-based actions do when it isn't legally attached. */
  readonly whenIllegal: AttachmentIllegalAction;
  /** Human-readable label for the inspector / event log. Never read by the rules. */
  readonly label?: string;
}

/**
 * The attachment spec a definition declares, or `undefined`. One accessor so "is
 * this an attachment" has a single answer everywhere.
 */
export function attachmentOf(def: CardDefinition): AttachmentSpec | undefined {
  return def.attachment;
}

/**
 * Why this definition's attachment data cannot be honoured, or `undefined` when it
 * is usable — the rule-6 "clear unsupported signal, never a silently wrong board".
 *
 * Checked by the pool loader (`cards`' `loadCardPool`) so a card authored with an
 * attachment shape core cannot express is *reported* at load, rather than entering
 * play and sitting there doing nothing.
 */
export function attachmentProblem(def: CardDefinition): string | undefined {
  const spec = def.attachment;
  if (!spec) return undefined;
  if (!spec.attachesTo) return `${def.name}: an attachment must declare what it attaches to`;
  if (spec.whenIllegal !== 'toGraveyard' && spec.whenIllegal !== 'detach') {
    return `${def.name}: unknown attachment illegality rule '${String(spec.whenIllegal)}'`;
  }
  // An attachment that can never be on the battlefield can never be attached.
  if (!def.types.some((type) => type === 'artifact' || type === 'enchantment' || type === 'creature')) {
    return `${def.name}: only a permanent can be attached (types: ${def.types.join('/')})`;
  }
  return undefined;
}

/**
 * Whether `host` is a legal thing for `attachment` to be attached to, given the
 * attachment's controller.
 *
 * Both are assumed to be on the battlefield — an attachment can only be attached
 * to a permanent in play, which is what makes the SBA below able to answer "is this
 * still legal" by looking at nothing but the current board.
 */
export function isLegalHost(
  spec: AttachmentSpec,
  attachmentController: PlayerId,
  host: CardInstance,
  /**
   * The attachment's own card + the game state, for protection's third half:
   * a host with protection from a quality the ATTACHMENT has can't be
   * enchanted/equipped by it (CR 702.16d). Optional so a caller with no state
   * in hand keeps the pre-protection behaviour; every rules path (the SBA and
   * `attachTo`) passes both, which is what knocks an Aura off the moment its
   * host gains protection from it.
   */
  attachmentDef?: CardDefinition,
  state?: GameState,
): boolean {
  const scope = spec.attachesTo.controller ?? DEFAULT_HOST_SCOPE;
  if (scope === 'you') {
    if (host.controller !== attachmentController) return false;
  } else if (scope === 'opponent') {
    if (host.controller === attachmentController) return false;
  }
  if (attachmentDef !== undefined) {
    const protection = state !== undefined
      ? effectiveProtectionOf(state, host)
      : host.def.keywords?.protectionFrom;
    if (protectionBlocksSource(protection, attachmentDef)) return false;
  }
  return matchesCardFilter(host, spec.attachesTo);
}

/**
 * Whether this permanent is right now *legally attached*.
 *
 * `false` covers all three failure shapes with one answer, which is exactly what
 * CR 704.5m/n want: attached to nothing, attached to something that has left the
 * battlefield, and attached to a permanent that no longer satisfies the printed
 * "Enchant …" line.
 *
 * A permanent that is not an attachment at all is trivially fine.
 */
export function isLegallyAttached(state: GameState, permanent: CardInstance): boolean {
  const spec = permanent.def.attachment;
  if (!spec) return true;
  // `== null` covers both "attached to nothing" and an instance from older code
  // that never carried the field — see internal/continuous.ts for the full note.
  if (permanent.attachedTo == null) return false;
  const host = findAttachmentHost(state, permanent.attachedTo);
  if (host === undefined) return false;
  return isLegalHost(spec, permanent.controller, host, permanent.def, state);
}

/**
 * The battlefield permanent an id names, or `undefined`.
 *
 * Local to this module rather than reusing `internal/zones.ts`, for the same reason
 * `internal/continuous.ts` keeps its own: the layering and legality code must not
 * import the zone-movement code, which itself reads effective stats.
 */
function findAttachmentHost(state: GameState, id: InstanceId): CardInstance | undefined {
  const battlefield = state.battlefield;
  for (let i = 0; i < battlefield.length; i++) {
    const perm = battlefield[i] as CardInstance;
    if (perm.instanceId === id) return perm;
  }
  return undefined;
}

/** Why `attachment` cannot be attached to `hostId` right now, or `undefined`. */
export function illegalAttachmentReason(
  state: GameState,
  attachment: CardInstance,
  hostId: InstanceId,
): string | undefined {
  const spec = attachment.def.attachment;
  if (!spec) return `${attachment.def.name} is not an attachment`;
  if (hostId === attachment.instanceId) return `${attachment.def.name} cannot be attached to itself`;
  const host = findAttachmentHost(state, hostId);
  if (host === undefined) return `${attachment.def.name} has no permanent to attach to`;
  if (!isLegalHost(spec, attachment.controller, host, attachment.def, state)) {
    return `${attachment.def.name} cannot be attached to ${host.def.name}`;
  }
  return undefined;
}

/**
 * Attach `attachment` to the permanent `hostId`, moving it off whatever it was
 * attached to before (attaching is always a MOVE — "Attach to target creature you
 * control" on an already-equipped Equipment is the common case).
 *
 * Returns `false` and emits `attachmentFailed` when the host is not legal, so a
 * caller that got its target from somewhere other than the engine's own offer
 * cannot produce a board the state-based actions would have to undo. Never throws.
 *
 * The attachment itself does NOT have to be on the battlefield yet: an Aura's
 * script runs while the Aura is still a resolving spell, and setting the reference
 * there is precisely what makes it "enter the battlefield attached" (CR 303.4f)
 * rather than entering loose and being fixed up afterwards.
 */
export function attachTo(
  state: GameState,
  attachment: CardInstance,
  hostId: InstanceId,
  emit: (event: import('./events.js').GameEvent) => void,
): boolean {
  const reason = illegalAttachmentReason(state, attachment, hostId);
  if (reason !== undefined) {
    emit({ type: 'attachmentFailed', instanceId: attachment.instanceId, reason });
    return false;
  }
  attachment.attachedTo = hostId;
  emit({ type: 'permanentAttached', instanceId: attachment.instanceId, hostInstanceId: hostId });
  return true;
}

/**
 * Break the attachment relationship (CR 704.5n's "becomes unattached"), emitting
 * the event so a replay/inspector folding the log sees the buff go away. A no-op
 * on a permanent that was not attached.
 */
export function detachFromHost(
  attachment: CardInstance,
  emit: (event: import('./events.js').GameEvent) => void,
): void {
  const previous = attachment.attachedTo;
  if (previous == null) return;
  attachment.attachedTo = null;
  emit({ type: 'permanentUnattached', instanceId: attachment.instanceId, hostInstanceId: previous });
}

/**
 * Unattach everything attached to `hostId` — used when that host has LEFT the
 * battlefield but its instance id is coming straight back (a blink).
 *
 * Normally nothing has to say this: {@link isLegallyAttached} asks whether the
 * host is still on the battlefield, so a died/bounced/exiled host knocks its
 * Auras and Equipment off at the next state-based-action pass all by itself. A
 * blink returns the SAME id, so that question answers "yes" about an object
 * CR 400.7 says is a different one, and an Aura would stay on a creature it
 * never enchanted.
 *
 * Only the LINK is broken here. What each attachment then does about it —
 * an Aura to its owner's graveyard, an Equipment simply unattached — is the
 * `whenIllegal` data the SBA already reads, so there is exactly one place that
 * decides the consequence.
 */
export function unattachDependentsOf(
  state: GameState,
  hostId: InstanceId,
  emit: (event: import('./events.js').GameEvent) => void,
): void {
  const battlefield = state.battlefield;
  for (let i = 0; i < battlefield.length; i++) {
    const perm = battlefield[i] as CardInstance;
    if (perm.attachedTo === hostId) detachFromHost(perm, emit);
  }
}

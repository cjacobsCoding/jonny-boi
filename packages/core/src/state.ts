/**
 * GameState as plain data. This is the single explicit state object the engine
 * threads through every system — no module globals, no hidden mutable singletons.
 *
 * State-update strategy (perf note): the engine mutates a *working copy* produced
 * by structurally cloning only the parts a transition touches, rather than deep-
 * cloning the whole world per event. `applyAction` clones once at the boundary
 * (see engine.ts `cloneState`) and systems mutate that draft in place; callers
 * outside never see a half-applied draft. This keeps the hot path allocation-
 * conscious (one clone per action, not per event) while preserving the "previous
 * state is untouched" guarantee the sim/replay relies on. A future optimization
 * hook: swap `cloneState` for structural sharing (persistent maps) if profiling
 * shows the per-action clone dominates.
 */

import type { CardDefinition } from './card.js';
import { isBattle } from './card.js';
import type { ManaPool } from './mana.js';
import { emptyPool } from './mana.js';
import type { ContinuousEffect } from './internal/continuous.js';
import type { FloatingReplacement } from './internal/replacement.js';
import type { DelayedTriggeredAbility } from './delayed.js';
import type { CardGrant } from './card-grants.js';
import type { PendingChoice, ResolutionFrame } from './choices.js';
import type { TargetRestriction } from './targeting.js';

/** Opaque, stable identity for a player. */
export type PlayerId = 'A' | 'B';

export const PLAYER_IDS: readonly PlayerId[] = ['A', 'B'];

/**
 * The other seat. One accessor so "my opponent" is spelled the same everywhere —
 * card effects that put a choice to the OPPONENT (targeted discard) reach for this
 * constantly.
 */
export function opponentOf(player: PlayerId): PlayerId {
  return player === 'A' ? 'B' : 'A';
}

/**
 * The player who DEFENDS an attackable permanent — i.e. the seat that must be
 * the defending player for an attack on it to be legal, and the seat whose
 * creatures may block those attackers.
 *
 *  - A **planeswalker** is defended by its controller (you attack an OPPONENT's
 *    walker).
 *  - A **battle** is defended by its PROTECTOR (CR 310.11): the opponent of its
 *    controller. With two players the printed "choose its protector" has exactly
 *    one legal answer, so it is derived rather than stored — which is also what
 *    keeps it correct if control of the battle ever changes (the protector is
 *    always re-read as the current controller's opponent, CR 310.11c's
 *    redesignation collapsing to the same single choice).
 *
 * The consequence worth spelling out: a battle's controller attacks their OWN
 * battle (its protector is the defending player on their turn), which is the
 * printed play pattern of every Siege.
 */
export function protectorOf(inst: { readonly def: CardDefinition; readonly controller: PlayerId }): PlayerId {
  return isBattle(inst.def) ? opponentOf(inst.controller) : inst.controller;
}

/** Opaque per-object id assigned to every card instance and stack object. */
export type InstanceId = number;

/** The zones a card instance can occupy. */
export type ZoneName = 'library' | 'hand' | 'battlefield' | 'graveyard' | 'exile' | 'stack' | 'command';

/**
 * A runtime card instance. Distinct from its immutable `CardDefinition`: the
 * instance carries identity and mutable per-object state. Most fields are only
 * meaningful on the battlefield (tapped/damage/etc.) but live here uniformly so a
 * card keeps identity across zone changes.
 */
export interface CardInstance {
  readonly instanceId: InstanceId;
  /**
   * The card data this instance is CURRENTLY an instance of — the **active
   * face**. For every single-faced card this is simply the printed definition
   * and never changes. For a transforming double-faced card it is the front
   * face until the permanent transforms, and the nested `backFace` definition
   * after — which is what routes EVERY characteristic read (name, types, P/T,
   * keywords, triggers, statics, mana production, the AI's evaluation, the
   * renderer's art lookup) through the face that is up, with no second code
   * path anywhere.
   *
   * The ONLY writer is `transformPermanent` (transform.ts) plus the
   * leave-the-battlefield reset (`resetInstanceForNewZone`), which turns the
   * card front-face-up again as CR 712.8a requires. Everything else must treat
   * it as read-only.
   */
  def: CardDefinition;
  /**
   * While this permanent is TRANSFORMED (back face up), the printed front-face
   * definition it reverts to — the way back that keeps `CardDefinition` itself
   * acyclic. `null`/absent means the card is front-face-up, which is every
   * instance in the game except a transformed DFC on the battlefield.
   *
   * OPTIONAL and written only when a card actually transforms, for the same
   * object-shape/throughput reason as {@link CardInstance.attachedTo} — readers
   * test `!= null`, and `cloneInstance` copies it conditionally.
   */
  printedDef?: CardDefinition | null;
  /**
   * While this permanent is a **COPY** of something else (CR 707 — layer 1, the
   * bottom of the layer system), the definition it would be if the copy ended:
   * its own printed card. `null`/absent means "this is really what it says it
   * is", which is every instance in the game except a Clone that has made its
   * as-enters choice.
   *
   * The copy itself lives in {@link CardInstance.def}, exactly as a transformed
   * face does — which is what routes every characteristic read (P/T, types,
   * keywords, triggers, mana production, art) through the copied card with no
   * second code path, and what automatically leaves counters (7d), anthems (7c)
   * and until-end-of-turn pumps applying ON TOP of it. See `copy.ts`.
   *
   * ⚠️ SEPARATE from {@link printedDef}, and not redundant with it: `printedDef`
   * answers "which FACE is up", this answers "which CARD is this really". A copy
   * of a transforming DFC that then transforms needs both answers at once, and
   * one field can only give one of them. The leave-the-battlefield reset
   * (`resetInstanceForNewZone`) restores this one first — a bounced Clone is a
   * Clone in hand, never the Bear it was copying (CR 707.2 / CR 400.7).
   *
   * OPTIONAL and written only when a permanent actually becomes a copy, for the
   * same object-shape/throughput reason as {@link CardInstance.attachedTo} —
   * readers test `!= null`, and `cloneInstance` copies it conditionally. Anyone
   * adding a field here must also edit `internal/clone.ts`.
   */
  uncopiedDef?: CardDefinition | null;
  /** Controller (who plays/controls it). For MVP, owner === controller. */
  controller: PlayerId;
  owner: PlayerId;
  zone: ZoneName;
  // --- battlefield/runtime state ---
  tapped: boolean;
  /** True until the controller has controlled it since their most recent turn began. */
  summoningSick: boolean;
  /** Damage marked this turn; cleared in cleanup. */
  damageMarked: number;
  /**
   * True once this creature has been dealt any damage by a deathtouch source this
   * turn — that damage is lethal regardless of amount (SBA destroys it). Cleared
   * in cleanup alongside marked damage.
   */
  markedByDeathtouch: boolean;
  /**
   * Generic +1/+1-style counters etc., keyed by counter kind.
   *
   * **Contract: REPLACE this object, never mutate it in place.** To add a counter,
   * assign a new record (`inst.counters = { ...inst.counters, [kind]: n }`); to
   * clear them, assign {@link NO_COUNTERS}. Every write in the codebase already
   * works this way — the field is only ever assigned wholesale.
   *
   * That is what lets the empty case be a single shared, frozen object instead of
   * a fresh `{}` per instance. It is worth spelling out because the saving is not
   * small: nearly every instance in a game carries no counters, and that one empty
   * object was **40% of everything `cloneState` allocates** — the whole library,
   * the whole hand, every vanilla creature, copied on every action. Because the
   * shared object is frozen, an in-place write fails loudly at the offending line
   * rather than silently aliasing two states together.
   */
  counters: Record<string, number>;
  /**
   * The permanent this one is ATTACHED TO (an Aura's enchanted creature, an
   * Equipment's equipped creature), or `null` when it is attached to nothing —
   * which is every card in the game except the handful that are attachments.
   *
   * Stored as one forward reference and no reverse index, deliberately. The
   * reverse direction ("what is attached to me") is needed only inside the
   * continuous-layering pass, which already walks the whole battlefield once, so
   * it is derived there for free (`internal/continuous.ts`) rather than being a
   * second structure that can fall out of sync with this one.
   *
   * OPTIONAL in the type, and always WRITTEN by every path that mints an instance
   * (`makeInstance`, token creation, `cloneInstance`). Those two facts together are
   * deliberate: real gameplay instances all carry the field, so they keep one
   * object shape on the engine's hottest reads, while a state serialized before
   * this field existed — or a hand-built literal in another package's test — still
   * type-checks and reads as "attached to nothing" instead of failing to compile
   * or, worse, being mistaken for an attachment with an undefined host. Every
   * reader therefore tests `!= null`, never `!== null`.
   *
   * See `attachments.ts` for the relationship's rules.
   */
  attachedTo?: InstanceId | null;
  /**
   * The turn number on which a LOYALTY ability of this permanent was last
   * activated — the once-per-turn rule (CR 606.3 modern form) is enforced by
   * comparing this to `GameState.turnNumber`, so no per-turn reset pass is
   * needed and a stale value from a previous turn is simply not equal.
   *
   * OPTIONAL and written only when a loyalty ability is actually activated, for
   * the same object-shape/throughput reason as {@link attachedTo}: nearly every
   * instance in a game never touches it, and `cloneInstance` copies it only when
   * present. Anyone adding a field here must also edit `internal/clone.ts`.
   */
  loyaltyActivatedTurn?: number;
  /**
   * How many times this permanent's spell was kicked as it was cast — written
   * when a kicked (or multikicked) PERMANENT spell resolves to the battlefield,
   * so an enters-the-battlefield trigger ("create a token for each time it was
   * kicked") can still read the count after the resolution frame is gone. A
   * single kicker records 1. Cleared when the permanent leaves the battlefield
   * (a re-cast is a new announcement).
   *
   * OPTIONAL and written only on the kicked entry, for the same object-shape/
   * throughput reason as {@link attachedTo}. Anyone adding a field here must
   * also edit `internal/clone.ts`.
   */
  timesKicked?: number;
  /**
   * The value NAMED AS THIS PERMANENT ENTERED — "As ~ enters, choose a creature
   * type / a color / a player" (CR 614.1c). A colour letter, a printed subtype,
   * a card-type word, or a `PlayerId`, depending on
   * `CardDefinition.asEntersChoice.subject`.
   *
   * **This field is the whole system.** The prompt is the easy half; what makes
   * Cavern of Souls a card rather than a question is that the answer PERSISTS on
   * the permanent and is READ later — by a static ("creatures you control of the
   * chosen type get +1/+1", `StaticAffects.ofChosenSubtype`), by a mana ability
   * ("add one mana of the chosen color", the `chosen` mana mode), and by the
   * card's own type line ("this creature is the chosen type in addition to its
   * other types", `CardDefinition.isChosenSubtype`).
   *
   * **ABSENT — OR THE EMPTY STRING — MEANS NOTHING WAS CHOSEN, AND MATCHES
   * NOTHING.** That is the one inert default (`NOTHING_CHOSEN` in `choices.ts`),
   * and no reader may invent a value for it. The two spellings are the two ways
   * of reaching it, and the difference is bookkeeping rather than meaning:
   * ABSENT is a permanent that was never asked (reanimation, another card's "put
   * it onto the battlefield", a token, a hand-built test instance), while the
   * EMPTY STRING is one that was asked and declined — which the asking paths need
   * to tell apart from "not asked yet", because the land-play path re-enters its
   * question step after every answer and would otherwise ask again forever.
   *
   * Cleared when the permanent leaves the battlefield (`resetInstanceForNewZone`):
   * a new entry is a new naming, so a bounced-and-recast Adaptive Automaton must
   * not still be lording over the type it named last time.
   *
   * OPTIONAL and written only by the permanents that name something, for the same
   * object-shape/throughput reason as {@link attachedTo}. Anyone adding a field
   * here must also edit `internal/clone.ts`.
   */
  chosenAsEntered?: string;
  /**
   * Modes this permanent's modal trigger has already chosen THIS TURN — the
   * printed memory in "choose one that hasn't been chosen **this turn**" (Gala
   * Greeters, Monument to Endurance).
   *
   * Per INSTANCE, not per card: two copies of Gala Greeters each remember
   * their own picks. Cleared for every permanent at the start of each turn
   * (see `beginTurn`), which is the printed words and the whole of them — the
   * TURNLESS form ("choose one that hasn't been chosen", Silent Hallcreeper)
   * is a game-long memory this field deliberately does not model, and the
   * compiler refuses that wording rather than resetting it every turn.
   *
   * Written only on a permanent whose trigger prints the memory, for the same
   * object-shape/throughput reason as {@link attachedTo}. Anyone adding a field
   * here must also edit `internal/clone.ts`.
   */
  // A READONLY array on a WRITABLE property: the engine replaces the list
  // wholesale (never pushes), which is also what keeps a cloned draft state
  // from rewriting the previous one, and what lets the AI's DeepReadonly view
  // of an instance stay assignable to this type.
  modesChosenThisTurn?: readonly string[];
  /**
   * REGENERATION SHIELDS standing on this permanent (CR 701.15) — "The next
   * time this permanent would be destroyed this turn, instead tap it, remove it
   * from combat, and remove all damage from it."
   *
   * A COUNT, not a flag: two activations of "{B}: Regenerate this creature"
   * survive two destructions, which is the whole reason a regenerator holds off
   * a board wipe AND a blocker in the same turn. Each shield is consumed by the
   * destruction it replaces.
   *
   * Cleared in the cleanup step with damage, because the printed word is "this
   * turn". Written only on a permanent that has actually been shielded, for the
   * same object-shape reason as {@link attachedTo}; anyone adding a field here
   * must also edit `internal/clone.ts`.
   */
  regenerationShields?: number;
  /**
   * The permanent that exiled this card "until it leaves the battlefield"
   * (the O-Ring link — Banisher Priest, Fiend Hunter, Angel of Serenity).
   *
   * A CORE field even though the mechanic lives in the cards package, for one
   * hard-won reason: the pure `applyAction` path deep-clones state through
   * `cloneInstance`'s FIXED field list, so a link written as an ad-hoc extra
   * property survived exactly one action and then silently vanished — the
   * jailer left, the release trigger ran, and found nothing to free. §3.56.
   */
  exiledUntilLeavesBy?: InstanceId;
  /**
   * §3.106 — the turn on which this permanent CAME UNDER ITS CURRENT
   * CONTROLLER'S CONTROL: written as it enters the battlefield and again on
   * every control change, read by echo's intervening "if this permanent came
   * under your control since the beginning of your last upkeep" (CR 702.30a).
   *
   * Written ONLY on permanents whose definition asks the question
   * (`definitionTracksControlSince` in upkeep-costs.ts), so the ordinary
   * permanent keeps the object shape `cloneInstance` was measured on — the
   * same discipline as {@link attachedTo}. Cleared as the permanent leaves
   * the battlefield (CR 400.7). Anyone adding a field here must also edit
   * `internal/clone.ts`.
   */
  controlledSinceTurn?: number;
}

/**
 * The shared, frozen "no counters" record. See {@link CardInstance.counters} for
 * the replace-never-mutate contract that makes sharing it safe.
 */
export const NO_COUNTERS: Record<string, number> = Object.freeze({}) as Record<string, number>;

/** Per-player state. */
export interface PlayerState {
  readonly id: PlayerId;
  life: number;
  manaPool: ManaPool;
  /** Lands played so far this turn (reset each turn). */
  landsPlayedThisTurn: number;
  /** Set when this player has lost (and why is in the event log). */
  hasLost: boolean;
  // --- poison family (§3.105) ---------------------------------------------------
  /**
   * POISON COUNTERS (CR 122.1f) — the one counter a PLAYER can carry in this
   * engine. Ten or more loses the game as a state-based action (CR 704.5c).
   *
   * OPTIONAL, for the reason `turnFactsA` is: every state serialized, persisted
   * or hand-built before poison existed has no field here, and "absent" must
   * read as zero rather than as `undefined` arithmetic. Never read it directly —
   * `poisonOf` / `addPoisonCounters` in `poison.ts` are the one reader and the
   * one writer, exactly as `life` has one damage funnel.
   */
  poison?: number;
  // Zones owned by this player. Battlefield instances are addressed globally too
  // (see GameState.battlefield) but each card's `controller` is authoritative.
  library: CardInstance[];
  hand: CardInstance[];
  graveyard: CardInstance[];
  exile: CardInstance[];
  command: CardInstance[];
}

/** The turn steps, in order, that make up a turn. */
export type Step =
  | 'untap'
  | 'upkeep'
  | 'draw'
  | 'precombatMain'
  | 'beginCombat'
  | 'declareAttackers'
  | 'declareBlockers'
  | 'combatDamage'
  | 'endCombat'
  | 'postcombatMain'
  | 'end'
  | 'cleanup';

/** Canonical step order for one turn. */
export const STEP_ORDER: readonly Step[] = [
  'untap',
  'upkeep',
  'draw',
  'precombatMain',
  'beginCombat',
  'declareAttackers',
  'declareBlockers',
  'combatDamage',
  'endCombat',
  'postcombatMain',
  'end',
  'cleanup',
];

/** The two main phases are sorcery-speed windows; identify them by step. */
export const MAIN_STEPS: readonly Step[] = ['precombatMain', 'postcombatMain'];

/**
 * ONE announced mode of a modal spell — which mode was chosen, and what that
 * mode was aimed at.
 *
 * Modes and their targets are both chosen as the spell is CAST (CR 601.2b/c),
 * so a pick is finished data by the time the spell can resolve. Its own
 * `targets` list is what makes "Choose two — • Counter target spell • Return
 * target permanent to its owner's hand" possible at all: the two chosen modes
 * point at DIFFERENT objects, which one `SpellStackObject.targets` list cannot
 * express.
 *
 * One entry per PICK, not per mode: a spell that lets you choose the same mode
 * more than once records it once per time it was chosen, each with its own aim.
 */
export interface ModePick {
  /** The chosen `SpellMode.id`. */
  readonly modeId: string;
  /**
   * What this mode points at — one target, or empty for a target-free mode.
   * Absent (rather than empty) while the engine is still asking for it.
   */
  readonly targets?: ReadonlyArray<InstanceId | PlayerId>;
}

/**
 * A spell (or permanent) on the stack: a card instance moving through the stack.
 * Carries the resolving instance and resolves to a zone. Resolution is LIFO.
 */
export interface SpellStackObject {
  /** Discriminator; a spell/permanent moving through the stack. */
  readonly kind: 'spell';
  readonly instanceId: InstanceId;
  /** The card instance this stack object represents. */
  readonly card: CardInstance;
  /** Who put it on the stack. */
  readonly controller: PlayerId;
  /**
   * Where the card goes after resolving: battlefield for permanents, graveyard
   * for ordinary spells, exile for spells cast via flashback (CR 702.34a).
   */
  readonly resolvesTo: 'battlefield' | 'graveyard' | 'exile';
  /** Targets chosen at cast time (instance ids and/or players); empty if none. */
  readonly targets: ReadonlyArray<InstanceId | PlayerId>;
  /**
   * The value chosen for the spell's `{X}` cost, recorded once the caster has
   * answered (and the mana has been charged). Absent while unanswered and for
   * spells with no X — an unanswered X resolves as 0, the direction that can
   * never play better than printed.
   */
  readonly xValue?: number;
  /** Whether the kicker was paid. Absent for spells with no kicker / unanswered. */
  readonly kicked?: boolean;
  /**
   * How many times the MULTIKICKER was paid, recorded once the caster has
   * answered (and the mana has been charged). Absent while unanswered and for
   * spells without multikicker; any positive count also sets {@link kicked}.
   */
  readonly kickCount?: number;
  /**
   * §3.106 — set when this creature spell was cast through a SUSPEND window
   * (CR 702.62a: "if you cast a creature spell this way, it gains haste until
   * you lose control of the spell or the permanent it becomes"). Rides the
   * stack object into the resolution frame exactly as {@link kicked} does, so
   * the entry can arrive unsick. Absent for every other cast.
   */
  readonly hasteOnEntry?: boolean;
  /**
   * The MODES chosen for a modal spell, in PRINTED order, one entry per pick
   * (a repeated mode appears once per time it was chosen). Each pick's
   * `targets` is recorded as its cast-time aim is answered; a pick whose
   * `targets` is still absent is the one the engine is currently asking about.
   * Absent entirely until the mode question is answered, and for non-modal
   * spells. Public information, exactly as announced modes are in paper.
   */
  readonly modePicks?: readonly ModePick[];
  /**
   * Set while this spell sits on the stack with a CAST-TIME question still
   * unanswered — "choose your modes", "choose X", "pay the kicker?", "aim this
   * mode". Like a trigger's `awaitingTargets`, the waiting lives ON the stack
   * object so "is a cast still being finished?" is answered by the stack
   * itself; it is cleared the instant the answer is recorded. Anyone adding a
   * stack-object field must also copy it in `internal/clone.ts` (field-by-field
   * cloning drops unknown fields).
   */
  /**
   * Whether the BUYBACK cost was paid (CR 702.27a). Absent for spells with no
   * buyback / unanswered. Read only through {@link spellLeaveDestination} —
   * where the card goes is one answer, not a flag each exit interprets.
   */
  readonly boughtBack?: boolean;
  /**
   * Whether this spell's MANDATORY additional cost has been paid
   * ({@link CardDefinition.additionalCost}). Absent for spells that print none.
   *
   * Recorded rather than inferred because the payment is a real sacrifice or
   * discard performed once: without a marker the cast-question loop would ask
   * again every time it re-ran, and the caster would pay twice.
   */
  readonly additionalCostPaid?: boolean;
  readonly awaitingCastChoice?:
    | 'modes'
    | 'x'
    | 'kicker'
    | 'multikicker'
    | 'modeTarget'
    | 'buyback'
    | 'additionalCost';
  /**
   * The zone this spell was CAST FROM. Optional, and absent means `'hand'` —
   * which keeps every state serialized before non-hand casting existed (and
   * every hand-built test literal) valid, exactly like `pendingChoice`.
   *
   * `'graveyard'` marks a flashback cast, and it is tracked HERE — on the stack
   * object, not looked up from the card — because the exile replacement follows
   * the CAST, not the card: the same card countered off an ordinary cast still
   * goes to the graveyard. Every exit from the stack (resolution, countering)
   * reads it through {@link spellLeaveDestination}.
   */
  readonly castFrom?: 'hand' | 'graveyard' | 'exile';
  /**
   * Set once the as-enters COPY question (`CardDefinition.copyAsEnters`, CR 707)
   * has been answered for this spell — including when it was answered "no".
   *
   * It has to live on the STACK OBJECT rather than on the instance because a
   * DECLINE leaves no trace on the permanent: `uncopiedDef` stays absent, which
   * is indistinguishable from "never asked". Without this marker the resolution
   * re-entry after the answer would ask again, forever.
   */
  readonly copyAsEntersDecided?: boolean;
  /**
   * **CR 707.10 — this stack object is a COPY OF A SPELL, and it is not a card.**
   *
   * A copy is put onto the stack by an effect rather than cast, and the object
   * it puts there has no card behind it: {@link CardInstance} is still the
   * carrier (every characteristic read in the engine routes through a
   * definition, so a second carrier shape would be a second code path), but the
   * instance was MINTED by the copying effect and belongs to no zone.
   *
   * That is why the flag exists rather than another `resolvesTo` value: where a
   * spell goes is asked through {@link spellLeaveDestination},
   * and this is the ONE fact that outranks every answer it can give. A copy of a
   * flashback cast is not exiled, a copy of a bought-back spell does not return
   * to a hand, and a copy that is countered does not reach a graveyard — CR
   * 704.5e: **a copy of a spell in any zone other than the stack ceases to
   * exist.** Leaving it in any of those zones would put a phantom CARD where
   * delirium, flashback, Tarmogoyf and every graveyard count would see it.
   *
   * `true` or absent, never `false`: absence is the answer for every spell ever
   * cast, and a two-valued field would add a property to the object the clone
   * allocates at every action boundary.
   */
  readonly isSpellCopy?: true;
}

/**
 * Why a spell is leaving the stack. The destination differs between the two —
 * that difference IS buyback — so every exit says which one it is rather than
 * letting the default decide for it.
 */
export type SpellLeaveReason = 'resolve' | 'counter';

/**
 * Where a spell's CARD goes when it leaves the stack WITHOUT resolving to the
 * battlefield — the one answer both resolution (of a non-permanent) and
 * countering must agree on. A spell cast from the graveyard (flashback) is
 * exiled instead of going to the graveyard, and that applies even when it is
 * COUNTERED (CR 702.34a: "…if it would leave the stack, exile it instead") —
 * countering is precisely a way of leaving the stack.
 *
 * `'ceaseToExist'` is the fourth answer and it names an object that goes to NO
 * ZONE AT ALL (CR 704.5e) — see {@link SpellStackObject.isSpellCopy}. Every
 * caller must handle it explicitly, which is why it is in the return type rather
 * than expressed by a caller-side `if`: the two exits from the stack live in two
 * packages, and a rule enforced in one of them is a rule that depends on how the
 * spell happened to leave.
 */
export function spellLeaveDestination(
  spell: SpellStackObject,
  reason: SpellLeaveReason,
): 'graveyard' | 'exile' | 'hand' | 'ceaseToExist' {
  // CR 704.5e OUTRANKS EVERY OTHER ANSWER, so it is asked first. A copy of a
  // spell is not a card: there is no card to exile for flashback, none to hand
  // back for buyback, and none to put in a graveyard when it is countered. Any
  // of those would leave a phantom card in a zone the rest of the engine counts.
  if (spell.isSpellCopy === true) return 'ceaseToExist';
  // Flashback next: exiling a card cast from the graveyard applies however it
  // leaves the stack, so it outranks everything else here. It is also what
  // AFTERMATH (CR 702.127a) rides — its second half is cast only from the
  // graveyard and is exiled after it resolves, which is the same sentence.
  if (spell.castFrom === 'graveyard') return 'exile';
  // An ADVENTURE exiles its own card, but ONLY as it resolves (CR 715.3d): an
  // adventure spell that is countered goes to the graveyard like anything else,
  // and the creature half is then gone for good. Reading the face that is on
  // the stack — a card is only ever an Adventure while its adventure half is
  // being cast — is what keeps the creature half out of this branch.
  if (reason === 'resolve' && spell.card.def.adventure === true) return 'exile';
  // Buyback returns the card to its owner's HAND — but only as it RESOLVES
  // (CR 702.27a). A bought-back spell that is countered goes to the graveyard
  // like any other countered spell; a caller that forgets the distinction
  // cannot express it, because the reason is a required argument.
  if (reason === 'resolve' && spell.boughtBack === true) return 'hand';
  return 'graveyard';
}

/**
 * A MADNESS WINDOW: a discarded card sitting in exile whose owner may still
 * cast it for its madness cost (CR 702.35a), or decline.
 *
 * Modelled as state rather than as a triggered ability on the stack because the
 * window is a *cast opportunity*, not an effect: what it needs is for one
 * player to be handed priority with exactly two legal actions — cast that card
 * from exile, or pass, which declines and drops it into the graveyard where the
 * ordinary discard would have put it. Both of those are things the existing
 * action seam already expresses, so every consumer (the pilots, the hotseat UI,
 * the online server) needs no new transport to play a madness card.
 */
export interface MadnessWindow {
  /** The exiled card that may still be cast. */
  readonly instanceId: InstanceId;
  /** Whose window it is — the discarding player, who alone may act on it. */
  readonly controller: PlayerId;
  /**
   * §3.106 — WHICH printed window this is. Absent means madness, which keeps
   * every state written before suspend existed meaning what it always meant.
   *
   * SUSPEND (CR 702.62a) reuses this record rather than growing a second one
   * because the two are the same shape of moment: one player is handed priority
   * with exactly two moves — cast this exiled card, or pass to decline — and
   * `dispatchAction`, the offer loop and the pilots already know how to play
   * that. The kind decides the two things that differ: what the cast COSTS
   * (madness pays `def.madness`; suspend pays nothing) and where a DECLINE
   * leaves the card (madness buries it; a declined suspend "remains exiled").
   */
  readonly kind?: CastWindowKind;
}

/** See {@link MadnessWindow.kind}. */
export type CastWindowKind = 'madness' | 'suspend';

/**
 * A triggered ability on the stack (DESIGN §3.9). Unlike a spell it carries no card
 * moving zones — it runs its effects against its source then leaves the stack.
 */
export interface TriggeredStackObject {
  readonly kind: 'trigger';
  /** A unique id for this stack object (distinct from the source instance). */
  readonly instanceId: InstanceId;
  /** The permanent whose ability this is. */
  readonly sourceInstanceId: InstanceId;
  /** Who controls the ability. */
  readonly controller: PlayerId;
  /** Effect refs to run on resolution. */
  readonly effects: ReadonlyArray<import('./card.js').EffectRef>;
  /** Targets, if any (resolved when the trigger went on the stack). */
  readonly targets: ReadonlyArray<InstanceId | PlayerId>;
  /** Debug label for the inspector/event log. */
  readonly label: string;
  /**
   * Set while this trigger is on the stack but its controller has NOT yet chosen
   * what it points at (CR 603.3d — targets are chosen as the ability is put on
   * the stack, which is a decision made at a moment when no resolution frame
   * exists). The value is what may be chosen.
   *
   * It is cleared the instant the targets are recorded, so "is anything still
   * waiting to be aimed?" is answered by the STACK itself rather than by a
   * separate bookkeeping record that could drift out of step with it — the same
   * reason state-based actions are derived from the board rather than queued.
   */
  readonly awaitingTargets?: TargetRestriction;
  /**
   * "ANOTHER target …" — this trigger's own source may not be chosen. Rides the
   * stack object beside {@link awaitingTargets} for the same reason: the choice
   * is made while the trigger sits on the stack, so everything the choice needs
   * has to be reachable from the stack alone.
   */
  readonly awaitingTargetsExcludeSelf?: boolean;
  /**
   * How many targets this trigger is waiting for ("up to three"). Rides the
   * stack object for the same reason as {@link awaitingTargets}: the choice is
   * made while the trigger sits on the stack.
   */
  readonly awaitingTargetCount?: { readonly min: number; readonly max: number };
  /**
   * A modal trigger waiting for its "Choose one —" answer (CR 603.3c) — the
   * ability's ModalSpec, carried on the stack object exactly as
   * {@link awaitingTargets} is. Cleared when the answer replaces `effects`.
   */
  awaitingModes?: import('./card.js').ModalSpec;
  /**
   * Stamped `'activated'` when this stack object is an ACTIVATED ability
   * (`applyActivateAbility`, cycling); absent for a genuine triggered ability.
   *
   * The two share this one stack-object kind on purpose (identical from the
   * stack's point of view), but a printed card may name only one of them:
   * "copy target TRIGGERED ability" (Strionic Resonator) must refuse an
   * activated ability, and "target activated or triggered ability" takes both.
   * Without the marker the triggered-only wording was quietly wider than
   * printed.
   */
  readonly origin?: 'activated';
  /**
   * The player the EVENT that set this ability off was about — the referent of
   * a body's "that player" / "them". Rides the stack object so it survives into
   * the resolution frame and then into `EffectContext`, exactly the way a cast's
   * `xValue`/`kicked` do (see `PendingTrigger.triggeringPlayer` for why the
   * source's controller is NOT the answer).
   */
  readonly triggeringPlayer?: PlayerId;
  /**
   * HOW MUCH the triggering event was for — the printed "that much" (Vito,
   * Exquisite Blood). Carried beside {@link triggeringPlayer} and for the same
   * reason: the body reads it as the ability RESOLVES, after the event is gone.
   */
  readonly triggeringAmount?: number;
  /**
   * WHICH OBJECTS the triggering event was about — "that creature", "the
   * blocking creature" (DESIGN §3.107). Carried beside {@link triggeringPlayer}
   * for the same reason: the body reads it as the ability RESOLVES, after the
   * declaration event is gone. See `PendingTrigger.triggeringInstances`.
   */
  readonly triggeringInstances?: readonly InstanceId[];
  /**
   * The trigger's printed intervening "if", carried so it can be re-checked as
   * the ability RESOLVES (CR 603.4's second check). Absent for every trigger
   * that prints no such clause, which is almost all of them.
   */
  readonly intervening?: import('./intervening.js').InterveningIf;
}

/** Anything that can sit on the stack. */
export type StackObject = SpellStackObject | TriggeredStackObject;

/** Combat bookkeeping for the current turn (null outside combat). */
export interface CombatState {
  /** Attacker instance ids declared this combat. */
  attackers: InstanceId[];
  /** Blocker assignment: blocker instanceId -> the attacker it blocks. */
  blocks: Record<InstanceId, InstanceId>;
  /**
   * Whether the declare step has HAPPENED — which is not the same as whether it
   * produced anything. Declaring no attackers (or no blockers) is a legal, common
   * choice, so emptiness cannot stand in for "not yet declared": without these
   * flags an empty declaration is accepted forever, and because declaring resets
   * the consecutive-pass counter, the step can never end. A pilot that searches
   * its options (rather than passing by convention) falls straight into that loop.
   */
  attackersDeclared: boolean;
  blockersDeclared: boolean;
  /**
   * What each attacker was declared attacking, when it is NOT the defending
   * player: attacker instanceId → the attacked permanent (a planeswalker today;
   * the seam is `isAttackable`, so battles reuse it). An attacker with no entry
   * here attacks the defending player — the overwhelmingly common case, which is
   * why the map is OPTIONAL and usually absent: every pre-existing consumer
   * (tests, serialized states, the replay) reads combat exactly as before.
   *
   * Anyone adding a field here must also edit `cloneCombat` in
   * `internal/clone.ts` — a field-by-field cloner drops what it does not know.
   */
  attackTargets?: Record<InstanceId, InstanceId | PlayerId>;
  /**
   * Ids that have been REMOVED FROM COMBAT (CR 506.4) while their instance is
   * still — or again — on the battlefield. See `combat-removal.ts` for the whole
   * story: a blink returns the same id to the battlefield, so the id-based reads
   * that handle every other departure cannot tell the returned NEW OBJECT
   * (CR 400.7) from the one that left.
   *
   * An OVERLAY on `attackers`/`blocks`, never a rewrite of them, because those
   * two are the declaration and other rules are read off it — deleting a removed
   * blocker's entry would turn its attacker into an unblocked one.
   *
   * OPTIONAL and usually absent, like `attackTargets`, so every pre-existing
   * consumer reads combat exactly as before and a combat with no blink allocates
   * nothing. Anyone adding a field here must also edit `cloneCombat` in
   * `internal/clone.ts` — a field-by-field cloner drops what it does not know.
   */
  removedFromCombat?: InstanceId[];
}

/** The whole game world as one plain-data object. */
export interface GameState {
  /** Monotonic id source for new instances/stack objects. */
  nextInstanceId: InstanceId;
  turnNumber: number;
  activePlayer: PlayerId;
  /** Who currently holds priority. */
  priorityPlayer: PlayerId;
  step: Step;
  /** Players keyed by id for O(1) access; iterate via PLAYER_IDS for order. */
  players: Record<PlayerId, PlayerState>;
  /** All battlefield permanents, in stable order. */
  battlefield: CardInstance[];
  /** The stack, index 0 = bottom, last = top (resolves first). */
  stack: StackObject[];
  /**
   * Active continuous effects (DESIGN §3.9): temporary P/T buffs and keyword grants,
   * mostly "until end of turn", removed in cleanup. Effective P/T and keywords are
   * computed by layering these over each permanent's base (see internal/continuous).
   */
  continuous: ContinuousEffect[];
  /**
   * Active grants to cards in NON-battlefield zones (Snapcaster Mage's "gains
   * flashback until end of turn" on a graveyard card) — see `card-grants.ts`.
   *
   * OPTIONAL, like `pendingChoice`, and for the same two reasons: every state
   * serialized (or hand-built in a test) before grants existed stays valid,
   * and a game that never grants anything never touches the field at all —
   * every consumer starts with the same one-property empty check
   * (`hasCardGrants`), so the hot paths stay exactly as fast as before.
   */
  cardGrants?: CardGrant[];
  /**
   * FLOATING replacement and prevention effects (CR 614/615) — a fog's "prevent
   * all combat damage that would be dealt this turn", a "prevent the next N
   * damage" shield. See `internal/replacement.ts`. The ones PRINTED on a
   * permanent are derived from `battlefield` on every read and never stored, for
   * the same reason an anthem is.
   *
   * OPTIONAL, like `cardGrants`, and for the same two reasons: every state
   * serialized (or hand-built in a test) before this existed stays valid, and a
   * game that never creates one never touches the field — `indexReplacements`
   * starts with the same one-property empty check, so the damage and counter hot
   * paths stay exactly as fast as they were.
   */
  replacements?: FloatingReplacement[];
  /**
   * DELAYED triggered abilities (CR 603.7) — "sacrifice it at the beginning of
   * the next end step", "at the beginning of your next upkeep, pay {3}{U}{U}".
   * See `delayed.ts`.
   *
   * ⚠️ **This field IS the mechanism by which a delayed ability survives its
   * source leaving.** The ability is created by an effect in mid-resolution and
   * belongs to no object: it is not on the stack (nobody may respond to it until
   * its moment arrives) and not on a permanent (Kiki-Jiki may be destroyed the
   * instant it has tapped), so a home on the STATE is the only one that outlives
   * both. The record is removed the moment it MATCHES, which is what makes
   * CR 603.7a's "it triggers only once" structural rather than a flag.
   *
   * OPTIONAL and normally ABSENT, like `cardGrants` and `replacements`: every
   * state serialized (or hand-built in a test) before this existed stays valid,
   * and a game that never creates one pays a single property read per event.
   */
  delayedTriggers?: DelayedTriggeredAbility[];
  combat: CombatState | null;
  /** Set once the game is decided. */
  winner: PlayerId | null;
  /** True once the game is over (winner set, or a draw). */
  gameOver: boolean;
  /**
   * Tracks consecutive priority passes since the last action/stack change, used
   * to decide when a step advances or the top of the stack resolves.
   */
  consecutivePasses: number;
  /** The seed the game was created with (for replay/debug). */
  readonly seed: number;
  /** Current RNG cursor, snapshotted into state for serialization. */
  rngState: number;
  /**
   * A question a resolving spell/ability is waiting on (DESIGN §3.11 "player
   * choice during resolution"). While it is set, `pendingChoice.chooser` — who may
   * be the OPPONENT of the spell's controller — is the only seat that may act, and
   * the only action they may take is `answerChoice`.
   *
   * Optional so that every existing state literal (and every serialized state
   * written before choices existed) stays valid: absent and `null` both mean "no
   * question outstanding", and a game containing no choice-asking card never
   * touches these two fields at all.
   */
  pendingChoice?: PendingChoice | null;
  /**
   * The half-finished resolution the pending choice belongs to — the bookmark that
   * lets the spell finish resolving after the answer. Set only while suspended.
   */
  resolution?: ResolutionFrame | null;
  /**
   * An open MADNESS window (see {@link MadnessWindow}) — a card discarded to
   * exile whose owner has not yet cast it or declined.
   *
   * Optional and normally absent, exactly like `pendingChoice`: a state
   * serialized (or hand-built in a test) before madness existed stays valid, and
   * a game containing no madness card never touches the field. While it is set,
   * the ONLY legal actions are its controller casting that card from exile or
   * passing priority to decline.
   */
  madnessWindow?: MadnessWindow | null;
  /**
   * What has happened SO FAR THIS TURN, for the printed cards that ask — revolt
   * ("a permanent you controlled left the battlefield this turn"), morbid, and
   * the lifegain check. One BITMASK PER PLAYER over the closed `TurnFact`
   * vocabulary, cleared as each turn begins.
   *
   * Two flat numbers rather than a `{ A, B }` record on purpose: the state is
   * cloned at every action boundary, and a nested object is an allocation per
   * clone — measured at ~3% of sim throughput for a game that never reads a
   * fact. Never index these directly; go through `turnFactHolds` /
   * `setTurnFact` in `turn-facts.ts`, which is also what keeps the absent case
   * ("nothing recorded", so every fact is false) correct for every state
   * serialized or hand-built before this existed.
   */
  turnFactsA?: number;
  turnFactsB?: number;
}

/** Build a fresh, empty player. */
export function createPlayer(id: PlayerId, startingLife: number): PlayerState {
  return {
    id,
    life: startingLife,
    manaPool: emptyPool(),
    landsPlayedThisTurn: 0,
    hasLost: false,
    library: [],
    hand: [],
    graveyard: [],
    exile: [],
    command: [],
  };
}

/** The non-stack, non-shared zone arrays a player owns, by zone name. */
export function playerZone(player: PlayerState, zone: ZoneName): CardInstance[] | null {
  switch (zone) {
    case 'library':
      return player.library;
    case 'hand':
      return player.hand;
    case 'graveyard':
      return player.graveyard;
    case 'exile':
      return player.exile;
    case 'command':
      return player.command;
    default:
      return null;
  }
}

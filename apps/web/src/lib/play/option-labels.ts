/**
 * The words a picker row is labeled with (pure, DOM-free, unit-tested) — OWNER +
 * ZONE for the §3.57 fix ("there was no way to tell which cards were mine vs
 * theirs vs battlefield vs graveyard"), and the PRICE for the §3.143 one (a card
 * offering several ways to pay must say what each of them costs).
 *
 * The engine's option snapshots already carry the facts (`CardOption.controller`
 * + `CardOption.zone`; `TargetOption.controller`): this module turns those ids
 * into words a human reads, from the CHOOSER's perspective — "yours" for the
 * seat answering, the seat's display name for everything else. It never guesses
 * from names and it never reaches into hidden zones: everything rendered comes
 * either from the choice's own candidate snapshot (which the engine addressed to
 * exactly one chooser) or from a {@link RefIndex} built ONLY from public zones.
 *
 * ## Hidden information
 * Two rules keep this leak-free by construction:
 * 1. Annotations are a pure function of the candidate list the engine already
 *    handed the chooser — no annotation can say more than the choice itself did.
 * 2. A {@link RefIndex} is built from PUBLIC zones (battlefield, graveyards,
 *    exiles, the stack) plus the viewer's OWN hand. An id it does not know
 *    resolves to `undefined`, never to a lookup somewhere private.
 */
import {
  convertedManaCost,
  formatManaCost,
  isLifeComponent,
  type CardOption,
  type HybridComponent,
  type InstanceId,
  type ManaCost,
  type PlayerId,
  type TargetOption,
} from '@jonny-boi/core';
import { zoneLabel } from './choice-view.js';
import type { TargetOption as CastTargetOption } from './targeting.js';

// --- copy (data, not strings scattered through components) -------------------------

/** What the chooser's own cards are labeled as. */
const OWN_LABEL = 'yours';

/** Possessive form of another seat's display name ("Computer's"). */
function possessive(name: string): string {
  return name.endsWith('s') ? `${name}’` : `${name}’s`;
}

/** The owner label for a controller, from `perspective`'s point of view. */
export function ownerLabel(
  controller: PlayerId,
  perspective: PlayerId,
  names: Readonly<Record<PlayerId, string>>,
): string {
  if (controller === perspective) return OWN_LABEL;
  return possessive(names[controller] ?? controller);
}

/** One picker row's annotation: whose card it is, and (when shown) where it sits. */
export interface OwnerZoneNote {
  readonly owner: string;
  /** Human zone label — present only when the zone is worth saying (see rules). */
  readonly zone?: string;
}

/** Render a note as the single meta line a row shows ("yours · graveyard"). */
export function formatOwnerZone(note: OwnerZoneNote): string {
  return note.zone === undefined ? note.owner : `${note.owner} · ${note.zone}`;
}

// --- selectCards candidates ---------------------------------------------------------

/**
 * Annotate a `selectCards` candidate list. Every row gets its OWNER; the ZONE is
 * added when the candidates SPAN more than one zone (Angel of Serenity offers
 * battlefield creatures beside graveyard cards, and rows that all say "card"
 * are exactly the report's complaint). A single-zone list leaves the zone to the
 * prompt's requirement line ("Choose 2 cards from the graveyard"), which already
 * says it once instead of N times.
 */
export function annotateCardOptions(
  candidates: readonly CardOption[],
  chooser: PlayerId,
  names: Readonly<Record<PlayerId, string>>,
): readonly OwnerZoneNote[] {
  const zones = new Set<string>();
  for (const candidate of candidates) zones.add(candidate.zone);
  const showZone = zones.size > 1;
  return candidates.map((candidate) => {
    const owner = ownerLabel(candidate.controller, chooser, names);
    if (!showZone) return { owner };
    return { owner, zone: zoneLabel(candidate.zone) ?? candidate.zone };
  });
}

// --- selectTargets candidates -------------------------------------------------------

/** Resolve where an instance publicly sits right now (see {@link RefIndex}). */
export type ZoneOfRef = (ref: InstanceId | PlayerId) => string | undefined;

/**
 * Annotate a `selectTargets` candidate list. A PLAYER candidate is labeled
 * `(player)` — a seat has no owner or zone. An instance candidate gets its
 * OWNER always, and its ZONE when a resolver is supplied and the resolved zones
 * either span more than one zone or include something that is not the
 * battlefield — "target creature" defaults to the battlefield in every player's
 * head, so only a departure from that is worth a word (Angel of Serenity's list
 * mixes battlefield and graveyards; Mortuary Mire's is all graveyard).
 */
export function annotateTargetOptions(
  candidates: readonly TargetOption[],
  chooser: PlayerId,
  names: Readonly<Record<PlayerId, string>>,
  zoneOf?: ZoneOfRef,
): readonly (OwnerZoneNote | 'player')[] {
  const resolved = candidates.map((candidate) =>
    isPlayerRef(candidate.ref) ? undefined : zoneOf?.(candidate.ref),
  );
  const zones = new Set<string>();
  for (const zone of resolved) if (zone !== undefined) zones.add(zone);
  const showZone = zones.size > 1 || [...zones].some((zone) => zone !== BATTLEFIELD_ZONE);
  return candidates.map((candidate, index) => {
    if (isPlayerRef(candidate.ref)) return 'player';
    const owner = ownerLabel(candidate.controller, chooser, names);
    const zone = resolved[index];
    if (!showZone || zone === undefined) return { owner };
    return { owner, zone: zoneLabel(zone) ?? zone };
  });
}

/** The zone every "target creature" lives in by default (label suppression rule). */
const BATTLEFIELD_ZONE = 'battlefield';

/** Whether a target ref names a seat rather than an instance. */
function isPlayerRef(ref: InstanceId | PlayerId): ref is PlayerId {
  return ref === 'A' || ref === 'B';
}

// --- the public-zone ref index ------------------------------------------------------

/** One publicly visible card, as the index stores it. */
export interface KnownRef {
  readonly instanceId: InstanceId;
  readonly name: string;
  readonly controller: PlayerId;
  readonly zone: string;
}

/**
 * A lookup over the PUBLIC board — battlefield, graveyards, exiles, the stack,
 * plus the viewer's own hand — used to describe a bare instance id (an online
 * target set, an ability's offered target) with a name, an owner and a zone.
 * Ids it does not know (the opponent's hand or library) resolve to `undefined`:
 * the index cannot leak what it was never given.
 */
export interface RefIndex {
  /** "Grizzly Bears (yours)" / "Acidic Slime (Computer’s · graveyard)" / "Caleb (player)". */
  readonly describe: (ref: InstanceId | PlayerId) => string;
  /** The zone an instance publicly sits in, or undefined for unknown/seat refs. */
  readonly zoneOf: ZoneOfRef;
  /** The owner label alone ("yours"), or undefined for unknown/seat refs. */
  readonly ownerOf: (ref: InstanceId | PlayerId) => string | undefined;
  /**
   * The parenthetical note for one ref — "yours" on the battlefield,
   * "yours · graveyard" off it, undefined for seats/unknowns. What a prompt
   * appends to a label it already has.
   */
  readonly noteOf: (ref: InstanceId | PlayerId) => string | undefined;
}

/**
 * Build a {@link RefIndex} for one viewer. `refs` must come from public zones
 * (the caller's discipline — both boards feed battlefield/graveyard/exile/stack
 * and the viewer's own hand). The describe rule mirrors
 * {@link annotateTargetOptions}: owner always, zone only when it is not the
 * battlefield.
 */
export function makeRefIndex(
  refs: Iterable<KnownRef>,
  viewer: PlayerId,
  names: Readonly<Record<PlayerId, string>>,
): RefIndex {
  const byId = new Map<InstanceId, KnownRef>();
  for (const ref of refs) byId.set(ref.instanceId, ref);
  const ownerOf = (ref: InstanceId | PlayerId): string | undefined => {
    if (isPlayerRef(ref)) return undefined;
    const known = byId.get(ref);
    return known === undefined ? undefined : ownerLabel(known.controller, viewer, names);
  };
  const zoneOf: ZoneOfRef = (ref) => {
    if (isPlayerRef(ref)) return undefined;
    return byId.get(ref)?.zone;
  };
  const noteOf = (ref: InstanceId | PlayerId): string | undefined => {
    if (isPlayerRef(ref)) return undefined;
    const known = byId.get(ref);
    if (known === undefined) return undefined;
    const owner = ownerLabel(known.controller, viewer, names);
    if (known.zone === BATTLEFIELD_ZONE) return owner;
    return `${owner} · ${zoneLabel(known.zone) ?? known.zone}`;
  };
  const describe = (ref: InstanceId | PlayerId): string => {
    if (isPlayerRef(ref)) return `${names[ref] ?? ref} (player)`;
    const known = byId.get(ref);
    // An id the public board can't name degrades to a readable placeholder —
    // same convention the session's own nameOf uses, never a crash.
    if (known === undefined) return `#${ref}`;
    const note = noteOf(ref);
    return note === undefined ? known.name : `${known.name} (${note})`;
  };
  return { describe, zoneOf, ownerOf, noteOf };
}

/**
 * Describe a CAST-TIME target option (the hotseat "Choose a target for X"
 * prompt renders `lib/play/targeting.ts` options, which carry their controller
 * but no zone — they are all battlefield/stack objects). Owner rides every
 * instance row; a seat stays "(player)".
 */
export function describeCastTarget(
  option: CastTargetOption,
  viewer: PlayerId,
  names: Readonly<Record<PlayerId, string>>,
): string {
  if (option.kind === 'player') return `${option.name} (player)`;
  const owner = ownerLabel(option.controller, viewer, names);
  // Where it sits when that is not the battlefield: a spell or an ability on
  // the stack, a card in a graveyard/exile. Board permanents say nothing extra.
  const where =
    option.kind === 'spell' || option.kind === 'ability'
      ? ' · stack'
      : option.kind === 'card'
        ? ` · ${zoneLabel(option.zone) ?? option.zone}`
        : '';
  return `${option.name} (${owner}${where})`;
}

/**
 * Describe one legal target set (the online cast prompt's button label). Every
 * member is described with owner + zone through the index, so "which Forest is
 * whose" stops being a guess.
 */
export function describeTargetSetWithOwners(
  set: ReadonlyArray<InstanceId | PlayerId>,
  index: RefIndex,
): string {
  if (set.length === 0) return 'No target';
  return set.map((ref) => index.describe(ref)).join(', ');
}

// --- how a CAST OPTION is priced (§3.143) -------------------------------------------

/** What labelling one cast option needs to know — its name and how it pays. */
export interface CastPricing {
  readonly name: string;
  /** The cost this cast pays (flashback/madness costs included); `undefined` = free. */
  readonly cost: ManaCost | undefined;
  /** Life put toward the cost's Phyrexian symbols — absent/0 = the all-mana reading. */
  readonly phyrexianLife?: number;
}

/** What a cast that pays nothing at all says instead of a price. */
const FREE_PRICE_TEXT = 'no cost';

/**
 * The printed cost with the Phyrexian symbols `lifeSpend` buys REMOVED, so a
 * label can read "{1} + 4 life" instead of reprinting symbols this cast will not
 * pay mana for.
 *
 * ⚠️ DISPLAY ONLY, exactly like `mana-picker.ts`'s `manaStillNeeded`. WHICH
 * symbols the life pays for is the engine payment search's call, and it is
 * unobservable while a printed card's Phyrexian symbols all print the same
 * price — so this takes them in printed order until the budget runs out. Whole
 * symbols only: one that the budget cannot buy keeps its printed form, because
 * a `{B/P}` the player is paying {B} for is still the symbol on the card.
 */
function manaAfterPhyrexianLife(cost: ManaCost, lifeSpend: number): ManaCost {
  if (lifeSpend <= 0) return cost;
  const symbols = cost.hybrid ?? [];
  let budget = lifeSpend;
  const kept: (readonly HybridComponent[])[] = [];
  for (const symbol of symbols) {
    const life = symbol.find(isLifeComponent);
    if (life !== undefined && life.life <= budget) {
      budget -= life.life;
      continue;
    }
    kept.push(symbol);
  }
  return kept.length === symbols.length ? cost : { ...cost, hybrid: kept };
}

/**
 * What one cast option COSTS, said in one phrase: "{1}{B/P}{B/P}" for the
 * all-mana reading, "{1} + 4 life" for the one that buys both Phyrexian symbols
 * (§3.143, CR 107.4f), "4 life" when life buys the whole cost.
 *
 * One function so the hand menu, the badge and anything that comes later price a
 * cast the same way — the printed cost alone is not an identity once a card can
 * be cast three ways for three different prices.
 */
export function castPriceText(option: CastPricing): string {
  const life = option.phyrexianLife ?? 0;
  if (option.cost === undefined) return FREE_PRICE_TEXT;
  if (life === 0) return formatManaCost(option.cost);
  const mana = manaAfterPhyrexianLife(option.cost, life);
  const lifeText = `${life} life`;
  // A cost the life bought outright would render as "{0}", which reads as a
  // price rather than as "there is no mana in this one".
  return convertedManaCost(mana) === 0 ? lifeText : `${formatManaCost(mana)} + ${lifeText}`;
}

/**
 * The button copy for ONE way to cast a card, given how many ways the card is
 * offering. A card with a single way says "Cast it" — there is nothing to tell
 * apart. A card with several names its half AND its price, because the halves of
 * a split card and the readings of a Phyrexian cost are distinguished by
 * different facts (name, price) and a button that showed only one of them would
 * be ambiguous for the other.
 */
export function castWayLabel(option: CastPricing, ways: number): string {
  if (ways <= 1) return 'Cast it';
  return `Cast ${option.name} — ${castPriceText(option)}`;
}

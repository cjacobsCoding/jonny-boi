/**
 * The PURE view-model for an OPENABLE ZONE — the panel both play UIs (hotseat
 * and online) raise when a player clicks a zone chip to look inside it.
 *
 * ## One panel, one table, a ROW per zone (rule 12)
 *
 * This file used to be `graveyard-cast.ts` and answered one question for one
 * zone. UX-10 then needed the identical surface for EXILE — "list a zone's
 * cards, every one of them hoverable, some of them castable" — and a second
 * component answering the same question is how the two end up disagreeing about
 * what a disabled card's tooltip says. So the zone is DATA: {@link ZONE_PANELS}
 * carries a row per zone and one `zonePanelView` judges all of them. A third
 * public zone later is a ROW, not a third component.
 *
 * ## Honesty rule, same as `why-disabled.ts`
 *
 * Every message must be TRUE from the information the board actually has. The
 * board knows whose priority it is and the step; whether the zone offers a cast
 * of a given card AT ALL is a question only some zones can answer, so
 * {@link ZoneCard.castableEver} is a THREE-valued field and `null` ("this board
 * cannot tell") produces a sentence about right now rather than a claim about
 * always. A graveyard can say "this card has no flashback"; exile cannot say
 * the equivalent, because the permissions that let a card be cast from exile
 * (an adventure's creature half, a defeated Siege's reward) live in game state,
 * not on the card.
 *
 * ## Hidden information is a ZONE PROPERTY, and it is enforced upstream
 *
 * The graveyard is a fully public zone (CR 404.2); exile is NOT — a foretold
 * card sits there face down and only its owner may look at it (CR 702.143a).
 * The view models that feed this one (`view-model.ts` for the hotseat,
 * `lib/online/board-adapter.ts` for the online board) therefore hand over the
 * cards the viewer is ENTITLED to see plus a COUNT of the ones they are not:
 * a withheld card's identity never reaches this module, so no consumer of it
 * can leak one. `hidesCards` on the row is what makes a surprise visible rather
 * than silent — see {@link UNEXPECTED_HIDDEN_LABEL}.
 */
import type { InstanceId } from '@jonny-boi/core';

/** The zones a player can open and look inside. CLOSED — a new zone is a ROW. */
export type ZonePanelKey = 'graveyard' | 'exile';

/** Everything that varies between one openable zone and the next. */
export interface ZonePanelSpec {
  /** The zone's name in prose — "Bob's graveyard". */
  readonly title: string;
  /** The glyph on the panel's heading, matching the seat rail's zone chip. */
  readonly icon: string;
  /** Corner badge stamped on a card this zone can be cast from right now. */
  readonly castBadge: string;
  /** What an empty zone says instead of showing nothing at all. */
  readonly emptyText: string;
  /**
   * Can this zone hold cards whose identity the viewer is not entitled to?
   * `false` for a fully public zone — and a `false` zone that turns up holding
   * one reports it (see {@link UNEXPECTED_HIDDEN_LABEL}) rather than hiding the
   * contradiction.
   */
  readonly hidesCards: boolean;
  /** What a withheld card is called on screen; `null` when the zone never hides one. */
  readonly hiddenLabel: string | null;
  /**
   * This zone offers no cast of this card, EVER — the permanent truth, which
   * must never read as "wrong moment, try later". `null` when the zone cannot
   * know it, in which case {@link noCastNowText} is the strongest honest answer.
   */
  readonly noCastEverText: string | null;
  /** The zone's casts are sorcery-speed; said when the step is not a main phase. */
  readonly wrongStepText: string | null;
  /** No cast is on offer right now — the weakest claim, and always true. */
  readonly noCastNowText: string;
}

/**
 * THE ZONE TABLE. Each row is one openable zone, and every difference between
 * the two panels a player sees is one of these fields.
 */
export const ZONE_PANELS: Readonly<Record<ZonePanelKey, ZonePanelSpec>> = Object.freeze({
  graveyard: Object.freeze({
    title: 'graveyard',
    icon: '⚰',
    castBadge: 'flashback',
    emptyText: 'Empty graveyard',
    // CR 404.2 — a graveyard is a public zone; every card in it is face up.
    hidesCards: false,
    hiddenLabel: null,
    noCastEverText: 'This card has no flashback — it stays in the graveyard.',
    wrongStepText: 'Only instant-speed flashback is allowed in this step.',
    noCastNowText: "Can't flashback this yet — tap lands for mana, or it costs more than you can pay.",
  }),
  exile: Object.freeze({
    title: 'exile',
    icon: '✦',
    // Not "madness": a card can be castable from exile for several unrelated
    // reasons (madness, an adventure's creature half, a defeated Siege's
    // reward, a suspend/cascade window), and the badge names the ZONE the cast
    // comes out of, which is the one thing all of them share.
    castBadge: 'from exile',
    emptyText: 'Nothing in exile',
    // CR 702.143a — a foretold card is exiled FACE DOWN, and only its owner may
    // look at it. That is why this panel exists in two halves.
    hidesCards: true,
    hiddenLabel: 'Face down in exile — only its owner may look at it',
    // Deliberately null. Whether a card in exile may ever be cast depends on a
    // permission recorded in game state, not on anything printed on the card,
    // so this board would be guessing — and rule 2's closed table REPORTS
    // rather than widening to the nearest thing that happens to exist.
    noCastEverText: null,
    wrongStepText: null,
    noCastNowText: 'Nothing lets you cast this from exile right now.',
  }),
});

/**
 * What a card withheld from a zone that claims never to withhold one is called.
 *
 * The point is that it is VISIBLE. A face-down card arriving in a `hidesCards:
 * false` zone means either the table's row is wrong or the mask upstream is —
 * both worth finding — and the safe rendering is still a card back, because the
 * one thing this module must never do is invent an identity to fill the gap.
 */
export const UNEXPECTED_HIDDEN_LABEL = 'Hidden card — this zone was not expected to hold one';

/** One card of a zone as the BOARD knows it, before the panel judges it. */
export interface ZoneCard {
  readonly instanceId: InstanceId;
  readonly cardId: string;
  readonly name: string;
  /**
   * Does this zone offer a cast of this card at all, ignoring timing and mana?
   * `null` when the board cannot tell — see the module doc. Explicit rather
   * than optional so every call site has to state its answer.
   */
  readonly castableEver: boolean | null;
}

/** What a zone HOLDS from the viewer's side of the hidden-information line. */
export interface ZoneContents {
  /** The cards the viewer is entitled to see, in zone order. */
  readonly cards: readonly ZoneCard[];
  /**
   * How many further cards are in the zone with their identity WITHHELD. A
   * count and nothing else, on purpose: there is no field here for a name or a
   * card id to travel in, so the panel cannot render one by accident.
   */
  readonly hiddenCount: number;
}

/** One visible card as the panel renders it. */
export interface ZoneCardView {
  readonly instanceId: InstanceId;
  readonly cardId: string;
  readonly name: string;
  /** Corner badge (the zone's {@link ZonePanelSpec.castBadge}) when castable now. */
  readonly badge?: string;
  /** True when clicking the card starts a cast (routed by the board). */
  readonly actionable: boolean;
  /** Why the card is NOT castable right now (tooltip on a disabled card). */
  readonly reason?: string;
}

/** One withheld card as the panel renders it: a back, a label, and no identity. */
export interface HiddenCardView {
  /** React list identity. Positional — a withheld card has nothing else. */
  readonly key: string;
  readonly label: string;
}

/** A whole opened zone, ready to render. */
export interface ZonePanelView {
  readonly cards: readonly ZoneCardView[];
  readonly hidden: readonly HiddenCardView[];
}

/** Board context a disabled zone card is judged against. */
export interface ZoneDisabledContext {
  /**
   * Is this the VIEWER'S OWN zone? The graveyard panel only ever opened the
   * viewer's, so the question never came up; exile opens either seat's, and a
   * card in someone else's zone is not a control the viewer failed to use. So a
   * foreign zone offers no cast and says nothing about why — "nothing lets you
   * cast this right now" is true of an opponent's card and still reads as an
   * invitation to try again later.
   */
  readonly yours: boolean;
  /** Does this seat hold priority (hotseat: is it the viewer's window)? */
  readonly yourTurn: boolean;
  /** Display name of whoever currently holds priority / must act. */
  readonly waitingOn: string;
  /** The current step. */
  readonly step: string;
}

/**
 * Judge a whole opened zone for the panel. `castableIds` is the union of the
 * casts the engine/server already offers and the ones the seat could fund by
 * tapping first — the board computes it from the engine's own offers, this
 * decides what it looks like.
 */
export function zonePanelView(
  zone: ZonePanelKey,
  contents: ZoneContents,
  castableIds: ReadonlySet<InstanceId>,
  ctx: ZoneDisabledContext,
): ZonePanelView {
  const spec = ZONE_PANELS[zone];
  const cards = contents.cards.map((c) => {
    // `yours` is asked HERE as well as at the call site on purpose: the board
    // hands a foreign zone an empty offer set, and this is the second lock on
    // the same door — nothing in someone else's zone can become clickable
    // because a set arrived with the wrong ids in it.
    const actionable = ctx.yours && ctx.yourTurn && castableIds.has(c.instanceId);
    return {
      instanceId: c.instanceId,
      cardId: c.cardId,
      name: c.name,
      badge: actionable ? spec.castBadge : undefined,
      actionable,
      reason: actionable || !ctx.yours ? undefined : reasonZoneCardIsDisabled(zone, ctx, c),
    };
  });
  // A zone that declares it never withholds a card still RENDERS one it is
  // handed — labelled as the surprise it is. Dropping it would make a masking
  // bug invisible, which is the failure mode this whole branch exists to stop.
  const label = spec.hiddenLabel ?? UNEXPECTED_HIDDEN_LABEL;
  const hidden = Array.from({ length: Math.max(0, contents.hiddenCount) }, (_, i) => ({
    key: `hidden:${i}`,
    label,
  }));
  return { cards, hidden };
}

/** The two steps in which a sorcery-speed cast out of a zone is legal. */
function isMainPhase(step: string): boolean {
  return step === 'precombatMain' || step === 'postcombatMain';
}

/** Said when the viewer does not hold priority — the same sentence for every zone. */
function waitingText(waitingOn: string): string {
  return `Waiting for ${waitingOn} — you don't have priority yet.`;
}

/**
 * A one-line reason the given card is not castable out of `zone` right now, or
 * `undefined` when it actually is. Total: safe to call for every card in the
 * panel, actionable or not.
 *
 * Ordered strongest-claim-first, and each step is skipped rather than guessed
 * at when the zone's row has no text for it.
 *
 * ⚠️ Only ever asked about the viewer's OWN zone — `zonePanelView` is the one
 * caller and it checks `ctx.yours` first. Kept private for that reason: every
 * sentence below is addressed to the person who could have cast the card, and
 * on an opponent's zone every one of them would be the wrong thing to say.
 */
function reasonZoneCardIsDisabled(
  zone: ZonePanelKey,
  ctx: ZoneDisabledContext,
  card: { readonly castableEver: boolean | null },
): string | undefined {
  const spec = ZONE_PANELS[zone];
  // The permanent truth first: most graveyard cards are simply not castable
  // from there, and that must never read as "wrong moment, try later".
  if (card.castableEver === false && spec.noCastEverText !== null) return spec.noCastEverText;
  if (!ctx.yourTurn) return waitingText(ctx.waitingOn);
  if (spec.wrongStepText !== null && !isMainPhase(ctx.step)) return spec.wrongStepText;
  return spec.noCastNowText;
}

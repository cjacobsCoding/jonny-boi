/**
 * THE WALKER-RESIDUE PRIMITIVES (DESIGN §3.153) — the bodies the two residues
 * §3.150 pinned on Tamiyo, the Moon Sage and Jace, Architect of Thought need,
 * and nothing else.
 *
 * Its own module for the reason `blink-primitives` and `exile-until-leaves` are:
 * each body below is about an object the resolution did NOT target and did not
 * create — the card a trigger's event was about, or a set revealed off the top
 * of a library — and that referent is the whole mechanic. Folding them into
 * `primitives.ts` would put them next to the targeting helpers they must not
 * use.
 */

import type { CardOption, EffectContext, EffectPrimitive, InstanceId, PlayerId } from '@jonny-boi/core';
import { collectCardOptions } from '@jonny-boi/core';
import { moveOwnedCard, otherPlayer } from './effect-helpers.js';

/**
 * `returnTriggeringCardToHand` — Tamiyo's emblem: "Whenever a card is put into
 * your graveyard from anywhere, **you may return it to your hand**."
 *
 * ## The referent is the trigger's subject, never a target
 * "It" is the card the event was about, which reaches the resolution as
 * `ctx.triggeringInstances` because the condition asked (`carriesSubject`). The
 * card was never targeted — it could not be, since the ability triggers on the
 * move that put it there — so every targeting helper in `effect-helpers` is the
 * wrong reader here, and none is used.
 *
 * ## Why it re-checks the graveyard
 * The ability goes on the stack and players get priority, so the card can be
 * gone by the time this runs (another Tamiyo emblem took it first, an exile
 * effect answered, a second trigger moved it). Finding nothing is a complete,
 * printed outcome — CR 608.2b — and is a silent no-op rather than a guess at
 * which card was meant.
 *
 * ## Whose hand
 * The card's OWNER's, which is also the emblem controller's: a card is only ever
 * put into its owner's graveyard (CR 404.3), and the trigger already scoped
 * "your graveyard" by that owner. So there is exactly one seat this can mean,
 * and it is read off the instance rather than assumed from `ctx.controller` —
 * an `undefined` owner returns nothing instead of moving the card to the wrong
 * hand.
 */
export const returnTriggeringCardToHand: EffectPrimitive = (ctx) => {
  const ids = ctx.triggeringInstances;
  if (ids === undefined || ids.length === 0) return;
  for (const id of ids) {
    const owner = graveyardOwnerOf(ctx, id);
    if (owner === undefined) continue;
    moveOwnedCard(ctx, owner, id, 'graveyard', 'hand');
  }
};

/** Which player's graveyard currently holds `id`, or `undefined` if none does. */
function graveyardOwnerOf(ctx: EffectContext, id: InstanceId): PlayerId | undefined {
  for (const player of ['A', 'B'] as const) {
    if (ctx.state.players[player].graveyard.some((c) => c.instanceId === id)) return player;
  }
  return undefined;
}

/**
 * `revealAndOpponentSplitsPiles` — Jace, Architect of Thought's −2: "Reveal the
 * top three cards of your library. An **opponent** separates those cards into
 * two piles. Put one pile into your hand and the other on the bottom of your
 * library in any order."
 *
 * ## The finding this primitive is evidence for
 * §3.150 filed this clause as "a prompt-seam question" — whether the engine can
 * ask a NON-CONTROLLING player something mid-resolution at all. It can, and it
 * already did: `pileSplitSacrifice` (Liliana's −6) has asked its VICTIM which
 * pile to sacrifice since that rule landed, through the same `chooseCards` /
 * `chooseModes` pair with an explicit `chooser`. Parking, replay from
 * `frame.answers` and the masked game view all come with the seam. So this body
 * is the existing pile machinery pointed at a different zone, not a new one.
 *
 * ## Two questions, two choosers, in the printed order
 *   1. the OPPONENT splits — a `selectCards` over the three revealed cards; the
 *      chosen ones are pile one, the rest pile two. An empty or whole pile is a
 *      legal (if poor) split, exactly as it is on Liliana.
 *   2. the CONTROLLER picks which pile goes to HAND — the printed sentence gives
 *      that choice to nobody else, and Jace's controller is who "put one pile
 *      into your hand" is addressed to.
 *
 * ## Where the OTHER pile goes is DATA
 * Jace bottoms it ("on the bottom of your library in any order"); Fact or
 * Fiction bins it ("into your graveyard"). One printed sentence, two
 * destinations, so the destination is a param read from {@link REST_DESTINATIONS}
 * — a CLOSED table, because a destination outside it must report rather than be
 * approximated to the nearest zone that happens to exist.
 *
 * The printed "in any order" is the controller's, and the cards are pushed in
 * the order the split left them. A prompt per ordering would stop the game for a
 * decision no pilot here can use, and — unlike the pile split — getting it wrong
 * cannot make the card stronger or weaker: the same cards reach the same place.
 */
export const revealAndOpponentSplitsPiles: EffectPrimitive = (ctx) => {
  const count = countParam(ctx);
  const you = ctx.controller;
  const rest = ctx.params.rest;
  // A destination the table does not carry moves nothing rather than guessing a
  // zone — the same closed-table refusal every other vocabulary here makes.
  if (typeof rest !== 'string' || !REST_DESTINATIONS.has(rest)) return;
  const library = ctx.state.players[you].library;
  if (library.length === 0) return;
  // The top `count` cards, through core's ONE option collector — so the snapshot
  // a choice carries to a UI (and, online, over a socket to one seat) is built
  // exactly as every other choice's is, rather than hand-rolled here into a
  // shape the renderer has never seen.
  const options: readonly CardOption[] = collectCardOptions(ctx.state, 'library', {
    controller: you,
    limit: count,
    fromTop: true,
  });
  if (options.length === 0) return;
  const splitter = otherPlayer(you);
  const pileOne = ctx.chooseCards({
    chooser: splitter,
    prompt: `Separate the revealed cards into two piles`,
    candidates: options,
    min: 0,
    max: options.length,
    // Neutral for the reason Liliana's split is: "half my picks are good for me"
    // has no per-card direction, and the searchless pilot's pile is built by the
    // AI layer, which knows values, rather than by a valence hint.
    valence: 'neutral',
    fromZone: 'library',
  });
  if (!pileOne) return; // parked — nothing has moved

  const inPileOne = new Set(pileOne);
  const pileTwo = options.filter((option) => !inPileOne.has(option.instanceId));
  const describe = (list: readonly CardOption[]): string =>
    list.length === 0 ? '(empty)' : list.map((option) => option.name).join(', ');
  const picked = ctx.chooseModes({
    chooser: you,
    prompt: 'Put one pile into your hand',
    modes: [
      { id: PILE_ONE, label: `Take pile 1: ${describe(options.filter((o) => inPileOne.has(o.instanceId)))}` },
      { id: PILE_TWO, label: `Take pile 2: ${describe(pileTwo)}` },
    ],
    min: 1,
    max: 1,
    valence: 'gain',
  });
  if (!picked) return; // parked — the split is replayed from `frame.answers`

  const takeOne = picked[0] === PILE_ONE;
  const toHand = options.filter((o) => inPileOne.has(o.instanceId) === takeOne);
  const toRest = options.filter((o) => inPileOne.has(o.instanceId) !== takeOne);
  for (const option of toHand) moveOwnedCard(ctx, you, option.instanceId, 'library', 'hand');
  for (const option of toRest) {
    // 'bottom' is `moveOwnedCard`'s default position, spelled out because the
    // printed line says it and a silent default is how a reader learns the wrong
    // thing about this card.
    if (rest === 'libraryBottom') moveOwnedCard(ctx, you, option.instanceId, 'library', 'library', 'bottom');
    else moveOwnedCard(ctx, you, option.instanceId, 'library', 'graveyard');
  }
};

/**
 * Where the pile the controller did NOT take goes — the printed tail, as a
 * closed vocabulary rather than a branch per card.
 *
 * `'libraryBottom'` is Jace's "on the bottom of your library in any order";
 * `'graveyard'` is Fact or Fiction's "into your graveyard". A param outside this
 * set moves nothing and the compiler never emits one, which is the direction
 * that cannot play better than printed.
 */
export const REST_DESTINATIONS: ReadonlySet<string> = new Set(['libraryBottom', 'graveyard']);

/** The printed depth of the reveal ("the top **three** cards"), never an inline literal. */
function countParam(ctx: EffectContext): number {
  const value = ctx.params.count;
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;
}

/** The two pile ids, named rather than spelled at every use (they reach a UI). */
const PILE_ONE = 'pile-1';
const PILE_TWO = 'pile-2';

/**
 * `installUntilYourNextTurnTrigger` — Jace, Architect of Thought's +1: "**Until
 * your next turn**, whenever a creature an opponent controls attacks, it gets
 * -1/-0 until end of turn."
 *
 * ## The lifetime is the whole residue
 * §3.150 filed this as "a duration-scoped delayed trigger", and that was exact.
 * The loyalty half was finished; what did not exist was an ability that fires an
 * unbounded number of times and stops at a MOMENT. `createDelayedTrigger`'s
 * `untilTurnOf` is that lifetime, and core removes the record as the named
 * player's turn begins — before the untap step, so nothing in that turn can
 * still see it.
 *
 * ## The condition and body ride in params
 * Both are baked by the compiler and handed through, exactly as
 * `sacrificeNamed`'s subject is: the ability this creates is an ordinary
 * `TriggeredAbility`, matched by the ordinary matcher, so there is no second
 * vocabulary for "whenever a creature attacks" and no second stack-object kind.
 *
 * A malformed or absent condition installs NOTHING rather than an ability that
 * watches everything — the direction that cannot play better than printed.
 */
export const installUntilYourNextTurnTrigger: EffectPrimitive = (ctx) => {
  const condition = ctx.params.condition;
  const effects = ctx.params.effects;
  if (typeof condition !== 'object' || condition === null) return;
  if (!Array.isArray(effects) || effects.length === 0) return;
  ctx.createDelayedTrigger({
    condition: condition as never,
    effects: effects as never,
    label: typeof ctx.params.label === 'string' ? ctx.params.label : 'until your next turn',
    untilTurnOf: ctx.controller,
  });
};

/** Self-registering into the shared primitive registry — DESIGN §2's seam. */
export const WALKER_RESIDUE_PRIMITIVES: Readonly<Record<string, EffectPrimitive>> = Object.freeze({
  returnTriggeringCardToHand,
  revealAndOpponentSplitsPiles,
  installUntilYourNextTurnTrigger,
});

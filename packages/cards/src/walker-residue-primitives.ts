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
 * ## "…on the bottom of your library in any order"
 * The other pile goes to the bottom, and the printed "in any order" is the
 * controller's: the cards are pushed in the order the split left them, which is
 * library order, and no question is asked for it. A prompt per ordering would
 * stop the game for a decision no pilot in this engine can use — and, unlike the
 * pile split, getting it wrong cannot make the card stronger or weaker, because
 * the same cards reach the same place either way.
 */
export const revealAndOpponentSplitsPiles: EffectPrimitive = (ctx) => {
  const count = countParam(ctx);
  const you = ctx.controller;
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
  const toBottom = options.filter((o) => inPileOne.has(o.instanceId) !== takeOne);
  for (const option of toHand) moveOwnedCard(ctx, you, option.instanceId, 'library', 'hand');
  for (const option of toBottom) {
    // 'bottom' is `moveOwnedCard`'s default position, spelled out because the
    // printed line says it and a silent default is how a reader learns the wrong
    // thing about this card.
    moveOwnedCard(ctx, you, option.instanceId, 'library', 'library', 'bottom');
  }
};

/** The printed depth of the reveal ("the top **three** cards"), never an inline literal. */
function countParam(ctx: EffectContext): number {
  const value = ctx.params.count;
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;
}

/** The two pile ids, named rather than spelled at every use (they reach a UI). */
const PILE_ONE = 'pile-1';
const PILE_TWO = 'pile-2';

/** Self-registering into the shared primitive registry — DESIGN §2's seam. */
export const WALKER_RESIDUE_PRIMITIVES: Readonly<Record<string, EffectPrimitive>> = Object.freeze({
  returnTriggeringCardToHand,
  revealAndOpponentSplitsPiles,
});

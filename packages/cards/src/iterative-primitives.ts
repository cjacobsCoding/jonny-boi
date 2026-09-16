/**
 * THE ITERATIVE-EFFECTS FAMILY — `repeat this process`.
 *
 * ## What was measured before any of this was written
 *
 * `scripts/repeat-blame.mjs`, over a 32,341-card corpus: **44 cards print the
 * word "repeat" and all 44 are blocked.** 38 refused clauses across **38 distinct
 * shapes — 1.00 cards per shape**, the §3.120 aggregation artifact at its floor
 * for the second time in this campaign: every card in this family prints a
 * sentence no other card prints. There is no iteration row in
 * `UNSUPPORTED_HINTS` at all, so the family is scattered across **14** other
 * rows and selecting it by hint would have found none of it.
 *
 * The blame split is the finding that scoped this file. The gap is the **BODIES**
 * (23 clauses) more than the **ITERATION** (15), and the number that matters is
 * the last one: **exactly one corpus card compiles the moment its repeat sentence
 * is removed** (Grindstone). Primal Surge is not that card — its body refuses
 * too. So this family is not "add a loop"; it is two printed bodies plus a loop,
 * for two cards, and that honest two is the deliverable.
 *
 * ## The termination argument is the CARD's, not the budget's
 *
 * Both printed iterations here consume a finite zone on every step and put
 * nothing back into it:
 *
 *   - `exileTopMayPlay` moves the top card of the library to exile before it
 *     does anything else, so the library is strictly one shorter per step and
 *     the step that finds it empty returns without repeating.
 *   - `millSharedColorRepeat` mills `amount` cards per step and stops the moment
 *     it cannot mill that many, so the same argument holds on the milled
 *     player's library.
 *
 * That, not a cap, is why these terminate. Core's
 * {@link MAX_EFFECT_STEPS_PER_RESOLUTION} exists to catch an AUTHORING mistake —
 * a future body that iterates without consuming — and it ABANDONS THE RESOLUTION
 * WITH AN EVENT when it trips, because a silent cap would make an iterative card
 * play weaker than printed and bias an A/B verdict exactly as badly as playing
 * stronger (§1a). There is deliberately **no second budget in this file**: two
 * counters answering "has this iteration run away" would eventually disagree,
 * and the engine's is the one the sim, the soak and the replay already read.
 *
 * ## Ask first, then mutate — which is why the body is TWO refs
 *
 * The contract `choice-primitives.ts` and `spell-count-primitives.ts` both state:
 * a parked question re-runs its effect ref FROM THE TOP, so anything mutated
 * before an unanswered ask happens twice. Primal Surge exiles a card and THEN
 * asks about it, which is exactly that shape — so the exile and the question are
 * two refs, with the exiled card's id baked into the second one's params at the
 * one moment anything knows it. `millThenReturn`/`returnMilledCard` is the
 * idiom; this is the same split for the same reason.
 */

import type { CardFilter, CardInstance, EffectContext, EffectPrimitive, InstanceId } from '@jonny-boi/core';
import { colorsOfDefinition, matchesCardFilter } from '@jonny-boi/core';
import {
  boolParam,
  firstPlayerTarget,
  intParam,
  millTopCards,
  moveOwnedCard,
  otherPlayer,
  putOntoBattlefield,
  strParam,
} from './effect-helpers.js';

/** The `filter` param as a {@link CardFilter}, or none — the same reader the spell-count family uses. */
function filterParam(ctx: EffectContext): CardFilter | undefined {
  const raw = ctx.params.filter;
  return typeof raw === 'object' && raw !== null ? (raw as CardFilter) : undefined;
}

/**
 * `repeat this process` — schedule this same effect ref to run again as the next
 * step of the SAME resolution.
 *
 * One line, and it is a named function anyway, because it is the seam: every
 * iterative body says "repeat" in exactly one way, so a later body cannot invent
 * a second spelling with different re-entry behaviour. The primitive id is passed
 * rather than read from the context because an `EffectContext` does not carry the
 * id of the primitive running in it — and naming it at the call site keeps the
 * loop visible in the body that loops.
 *
 * ⚠️ The params are forwarded UNCHANGED. There is no step counter in them: the
 * bound lives in core (`MAX_EFFECT_STEPS_PER_RESOLUTION`) so that one place
 * decides a resolution has run away, and a per-card budget here would be a second
 * answer to that question — the DRY failure rule 12 names.
 */
function repeatProcess(ctx: EffectContext, primitive: string): void {
  ctx.enqueueEffects([{ primitive, params: { ...ctx.params } }]);
}

/**
 * `exileTopMayPlay` — Primal Surge's first sentence: **"Exile the top card of
 * your library."**
 *
 * It exiles and stops. The printed second sentence ("If it's a permanent card,
 * you may put it onto the battlefield") asks a question ABOUT the card just
 * exiled, so it is a separate ref with that card's id in its params — see the
 * header for why a mutate-then-ask primitive is a bug rather than a style.
 *
 * An empty library ends the iteration by doing nothing, which is also CR
 * 701.x-correct: there is no card to exile, so the "if" is false and the process
 * does not repeat. The player does not lose the game for it — losing happens on
 * a DRAW from an empty library, not on an exile.
 */
export const exileTopMayPlay: EffectPrimitive = (ctx) => {
  const top = ctx.state.players[ctx.controller].library[0];
  if (top === undefined) return; // the library is empty — the iteration ends here
  const id = top.instanceId;
  if (moveOwnedCard(ctx, ctx.controller, id, 'library', 'exile') === undefined) return;
  ctx.enqueueEffects([
    {
      primitive: 'mayPlayExiledCard',
      params: { ...ctx.params, instanceId: id },
    },
  ]);
};

/**
 * `mayPlayExiledCard` — Primal Surge's second and third sentences: **"If it's a
 * permanent card, you may put it onto the battlefield. If you do, repeat this
 * process."**
 *
 * Never authored by the compiler on its own: `instanceId` is runtime knowledge
 * and only {@link exileTopMayPlay} knows it.
 *
 * ⚠️ EVERY EXIT THAT IS NOT "I PUT IT ONTO THE BATTLEFIELD" ENDS THE ITERATION,
 * and that is the printed card rather than a convenience. "If you do" is false
 * when the exiled card was not a permanent card, when the controller declined,
 * and when the card is no longer in exile to be put anywhere — so a body that
 * repeated on any of those would play STRONGER than printed, which §1a says
 * corrupts an A/B verdict exactly as badly as playing weaker.
 */
export const mayPlayExiledCard: EffectPrimitive = (ctx) => {
  const id = ctx.params.instanceId;
  if (typeof id !== 'number') return;
  const exiled = ctx.state.players[ctx.controller].exile.find((c) => c.instanceId === (id as InstanceId));
  if (exiled === undefined) return; // it left exile — "if you do" cannot become true
  // The printed condition, asked BEFORE the question: declining is a real answer,
  // but a non-permanent card was never offered the choice in the first place.
  if (!matchesCardFilter(exiled, filterParam(ctx))) return;
  const yes = ctx.confirm({
    chooser: ctx.controller,
    prompt: `Put ${exiled.def.name} onto the battlefield?`,
    valence: 'gain',
  });
  if (yes === undefined) return; // parked — nothing has moved
  if (!yes) return; // declined: "if you do" is false, so the process does not repeat
  if (putOntoBattlefield(ctx, ctx.controller, id as InstanceId, 'exile') === undefined) return;
  if (boolParam(ctx, 'repeat', false)) repeatProcess(ctx, 'exileTopMayPlay');
};

/**
 * The printed characteristics two milled cards may be required to SHARE, as a
 * CLOSED table of predicates.
 *
 * Closed on purpose (project rule 2): Grindstone prints `color`, and the same
 * template printed with "card type" (The Tale of Tamiyo) is a ROW here rather
 * than a second primitive. A `share` value outside this table makes the
 * primitive refuse rather than fall through to the nearest predicate that
 * happens to exist — "shares a colour" and "shares a card type" are genuinely
 * different cards, and silent approximation is worse than a clear refusal.
 *
 * Colour is read through core's `colorsOfDefinition` — the one colour reader
 * that protection, anthems and every `anyOfColors` filter already use — so "red"
 * cannot mean one thing here and another there. A colourless card shares a
 * colour with NOTHING, including another colourless card, which is exactly what
 * makes Grindstone stop against an artifact deck.
 */
const SHARED_CHARACTERISTICS: Readonly<
  Record<string, (a: CardInstance, b: CardInstance) => boolean>
> = Object.freeze({
  color: (a, b) => {
    const left = colorsOfDefinition(a.def);
    return colorsOfDefinition(b.def).some((color) => left.includes(color));
  },
  type: (a, b) => a.def.types.some((t) => b.def.types.includes(t)),
});

/**
 * `millSharedColorRepeat` — Grindstone: **"Target player mills two cards. If two
 * cards that share a color were milled this way, repeat this process."**
 *
 * ⚠️ THIS IS THE ITERATION THAT ASKS NOTHING, and that is why it is here rather
 * than deferred with the rest of the family. An iteration that asks is already
 * bounded by machinery that exists — the per-resolution ask budget, the sim's
 * per-turn action bound, and through it the soak's `gameCanEnd` invariant. An
 * iteration that asks nothing produces no question, no action and no turn, so
 * before `MAX_EFFECT_STEPS_PER_RESOLUTION` it was bounded by nothing at all and
 * a mis-authored one would have hung the process. Shipping the card that has
 * that shape is what keeps the new bound honest: it is exercised by a real
 * printed card rather than only by a fixture.
 *
 * Params: `amount` (the printed count), `share` (a key of
 * {@link SHARED_CHARACTERISTICS}). The mill goes through the ONE mill funnel
 * (`millTopCards`) so a card milled here lands in the same graveyard order and
 * emits the same `cardsMilled` as a card milled by any other effect.
 *
 * Milling FEWER than `amount` ends the iteration: the printed condition names
 * two cards, and one card cannot share a colour with a card that was never
 * milled. That is also the termination argument — the library is strictly
 * `amount` shorter every step.
 */
export const millSharedColorRepeat: EffectPrimitive = (ctx) => {
  const amount = intParam(ctx, 'amount', 0);
  if (amount <= 0) return;
  const predicate = SHARED_CHARACTERISTICS[strParam(ctx, 'share') ?? 'color'];
  if (predicate === undefined) return; // outside the closed table — refuse, never approximate
  const victim = firstPlayerTarget(ctx) ?? otherPlayer(ctx.controller);
  // The milled cards are READ off the library before the mill and compared after
  // it: `millTopCards` returns ids, and resolving ids back to instances would ask
  // a second question ("where are they now?") that the graveyard can answer
  // differently once a replacement effect is involved.
  const milling = ctx.state.players[victim].library.slice(0, amount);
  const milled = millTopCards(ctx, victim, amount);
  // Fewer than the printed count: the condition names two cards, and one card
  // cannot share a colour with a card that was never milled. This is also the
  // termination argument — the library is strictly `amount` shorter every step.
  if (milled.length < amount) return;
  const shared = milling.some((a, i) => milling.some((b, j) => j > i && predicate(a, b)));
  if (shared) repeatProcess(ctx, 'millSharedColorRepeat');
};

/**
 * The `share` values {@link millSharedColorRepeat} can honour, exported ONLY so
 * `iterative-effects.test.ts` can pin them against the compiler's own closed
 * table (`SHARED_MILL_PARAM_VALUES` in `compile/rules.ts`).
 *
 * The duplication is unavoidable — a rule table may not import a primitive's
 * private map — so the test that fails when they diverge is what makes it safe.
 * §8a item 5 is the same shape: `DERIVED_COUNTS`' spread order costs 8 cards
 * silently and is pinned by a test for exactly this reason.
 */
export const SHARED_MILL_PREDICATE_KEYS: readonly string[] = Object.freeze(
  Object.keys(SHARED_CHARACTERISTICS),
);

/** The primitives this module contributes to the shared registry. */
export const ITERATIVE_PRIMITIVES: Readonly<Record<string, EffectPrimitive>> = Object.freeze({
  exileTopMayPlay,
  mayPlayExiledCard,
  millSharedColorRepeat,
});

/**
 * THE SPELL-COUNT FAMILY (DESIGN §3.113) — the bodies of storm, cascade and
 * ripple's cast triggers, plus the small library and hand primitives the same
 * measurement picked up: learn, "mill, then put a card from among them into
 * your hand", "double the power", and "reveal the top card; if it's a … card,
 * draw a card".
 *
 * ## The cast-trigger bodies read the SPELL off the stack
 * A cast trigger's source is the spell that was cast (`cast-triggers.ts`), and
 * core's `frameSource` finds it on the stack — so `ctx.source` is the live
 * card, and `spellOnStackById` the stack object with the decisions made for it
 * (targets, X). Storm copies THAT object; cascade compares against ITS mana
 * value (CR 202.3b — X counts on the stack).
 *
 * ⚠️ A storm spell COUNTERED before its trigger resolves makes no copies here.
 * The rules still copy it (the trigger is independent of the spell — it is why
 * players counter the trigger, not the spell), but a copy is built from a
 * stack object and a countered spell's has left the stack. That plays WEAKER
 * than printed, never stronger, and it is written down rather than silently
 * approximated by copying the card from the graveyard with no targets and no X.
 *
 * ## Ask first, then mutate
 * The same contract `choice-primitives.ts` states: every `ask` may park the
 * resolution, and a parked ref is re-run from the top with the answers
 * replayed — so nothing here is pushed or moved until the last question has an
 * answer.
 */

import type { CardFilter, EffectContext, EffectPrimitive, InstanceId, SpellStackObject } from '@jonny-boi/core';
import {
  aggregateFor,
  collectCardOptions,
  drawCardForPlayer,
  effectivePower,
  makeSpellCopy,
  matchesCardFilter,
  performCascade,
  performRipple,
  spellOnStackById,
  stackManaValueOf,
} from '@jonny-boi/core';
import { retargetCopy } from './copy-primitives.js';
import { boolParam, intParam, manaValueOf, millTopCards, moveOwnedCard, strParam } from './effect-helpers.js';

/** Ripple's printed count when a hand-authored ref omits it — every printed ripple is 4. */
const RIPPLE_DEFAULT_COUNT = 4;

/** The `filter` param as a {@link CardFilter}, or none. */
function filterParam(ctx: EffectContext): CardFilter | undefined {
  const raw = ctx.params.filter;
  return typeof raw === 'object' && raw !== null ? (raw as CardFilter) : undefined;
}

/**
 * `stormCopies` — **CR 702.40a**: "copy it for each other spell that was cast
 * before it this turn. If the spell has any targets, you may choose new
 * targets for any of the copies."
 *
 * The count rides the trigger as `triggeringAmount` (read as the trigger was
 * pushed, so a response cast after the storm spell is not counted). Each copy
 * is aimed on its own through the one re-aim question `copySpell` asks, and a
 * copy of a permanent spell becomes a token through `makeSpellCopy`'s own rule
 * ("Copies become tokens" is reminder text for CR 707.10 — Stormscale Scion).
 */
export const stormCopies: EffectPrimitive = (ctx) => {
  const count = ctx.triggeringAmount ?? 0;
  if (count <= 0) return;
  const original = spellOnStackById(ctx.state, ctx.source.instanceId);
  if (original === undefined) return; // countered before the trigger resolved — see the header
  const copies: SpellStackObject[] = [];
  for (let i = 0; i < count; i++) {
    let copy = makeSpellCopy(ctx.state, original, ctx.controller);
    if (original.targets.length > 0 || original.modePicks !== undefined) {
      const aimed = retargetCopy(ctx, copy);
      if (aimed === undefined) return; // parked — nothing pushed yet
      copy = aimed;
    }
    copies.push(copy);
  }
  for (const copy of copies) {
    ctx.state.stack.push(copy);
    ctx.emit({
      type: 'spellCopied',
      instanceId: copy.instanceId,
      copiedInstanceId: original.instanceId,
      controller: copy.controller,
      name: copy.card.def.name,
    });
  }
};

/**
 * `cascade` — **CR 702.85a**, the exile half; the cast is the window core opens
 * (`cascade.ts`). The mana value compared against is the SPELL's on the stack
 * when it is still there, and the card's printed one when the spell has been
 * countered — the ability functions on its own (CR 702.85a says nothing about
 * the spell resolving), so a countered Bloodbraid Elf still cascades.
 */
export const cascade: EffectPrimitive = (ctx) => {
  const spell = spellOnStackById(ctx.state, ctx.source.instanceId);
  const manaValue = spell !== undefined ? stackManaValueOf(spell) : manaValueOf(ctx.source.def);
  performCascade(ctx.state, ctx.controller, manaValue, ctx.emit);
};

/**
 * `ripple` — **CR 702.60a**: "you may reveal the top N cards of your library
 * … you may cast any of those cards with the same name as this spell without
 * paying their mana costs, then put all revealed cards not cast this way on
 * the bottom of your library in any order."
 *
 * The reveal is a printed MAY, asked as one; the casts are the window chain
 * core runs (`cascade.ts`). `count` is the printed N.
 */
export const ripple: EffectPrimitive = (ctx) => {
  const count = intParam(ctx, 'count', RIPPLE_DEFAULT_COUNT);
  if (count <= 0) return;
  const reveal = ctx.confirm({
    chooser: ctx.controller,
    prompt: `Ripple ${count}: reveal the top ${count} cards of your library?`,
    valence: 'gain',
  });
  if (reveal === undefined) return; // parked
  if (!reveal) return;
  performRipple(ctx.state, ctx.controller, ctx.source.def.name, count, ctx.emit);
};

/**
 * `learn` — **CR 701.48a**: "You may discard a card. If you do, draw a card.
 * If you didn't discard a card, you may reveal a Lesson card you own from
 * outside the game and put it into your hand."
 *
 * The first two sentences, exactly. The third names a zone this engine does
 * not have (outside the game — a sideboard), so it does not exist here; and
 * because it is only ever an ALTERNATIVE the player may decline, its absence
 * cannot make the card play stronger than printed — a player who chooses the
 * discard-to-draw half in paper gets exactly this.
 *
 * Its own primitive rather than `mayEffects` around a discard and a draw,
 * because "if you do" is a CONDITION on the draw: a `discardCard` with an
 * empty hand auto-answers "none" and the wrapped draw would still happen — a
 * free card off an empty hand, which the printed card does not give.
 */
export const learn: EffectPrimitive = (ctx) => {
  const hand = ctx.state.players[ctx.controller].hand;
  if (hand.length === 0) return; // nothing to discard, so nothing to draw
  const yes = ctx.confirm({
    chooser: ctx.controller,
    prompt: 'Learn: discard a card to draw a card?',
    valence: 'gain',
  });
  if (yes === undefined) return; // parked
  if (!yes) return;
  const chosen = ctx.chooseCards({
    chooser: ctx.controller,
    prompt: 'Learn: discard a card',
    candidates: collectCardOptions(ctx.state, 'hand', { controller: ctx.controller }),
    min: 1,
    max: 1,
    valence: 'loss',
    fromZone: 'hand',
  });
  if (!chosen) return; // parked
  const discarded = chosen[0];
  if (discarded === undefined) return;
  if (moveOwnedCard(ctx, ctx.controller, discarded, 'hand', 'graveyard') === undefined) return;
  drawCardForPlayer(ctx.state, ctx.controller, ctx.emit);
};

/**
 * `millThenReturn` — "Mill N cards. You may put a PERMANENT card from among
 * the milled cards into your hand" (Seed of Hope, Wasteful Harvest, Midnight
 * Tilling). Params: `amount`, `filter` (the printed card noun), `optional`
 * (the printed "you may"). The mill goes through the one mill funnel, and
 * "from among them" is exactly the ids that funnel returns — never "the last N
 * cards of the graveyard", which a replacement or a token could make wrong.
 */
export const millThenReturn: EffectPrimitive = (ctx) => {
  const amount = intParam(ctx, 'amount', 0);
  if (amount <= 0) return;
  const filter = filterParam(ctx);
  const optional = boolParam(ctx, 'optional', false);
  const milled = new Set<InstanceId>(millTopCards(ctx, ctx.controller, amount));
  const candidates = collectCardOptions(ctx.state, 'graveyard', { controller: ctx.controller, filter }).filter((o) =>
    milled.has(o.instanceId),
  );
  if (candidates.length === 0) return;
  const chosen = ctx.chooseCards({
    chooser: ctx.controller,
    prompt: `Put a card milled this way into your hand${optional ? ' (or none)' : ''}`,
    candidates,
    min: optional ? 0 : 1,
    max: 1,
    valence: 'gain',
    fromZone: 'graveyard',
  });
  if (!chosen) return; // parked — the mill is already replayed by the frame, nothing else moved
  for (const id of chosen) moveOwnedCard(ctx, ctx.controller, id, 'graveyard', 'hand');
};

/**
 * `doublePower` — **CR 701.10b**: "that creature gets +X/+0, where X is that
 * creature's power as the spell or ability that doubles its power resolves."
 * `each: 'yours'` is Double Trouble's "each creature you control"; otherwise
 * the target. Read through the continuous index so a pumped or anthem'd
 * creature doubles its REAL power, and applied as an ordinary until-end-of-turn
 * modification (701.10a — a modification, never a set).
 */
export const doublePower: EffectPrimitive = (ctx) => {
  const subjects =
    strParam(ctx, 'each') === 'yours'
      ? ctx.state.battlefield.filter((c) => c.controller === ctx.controller && c.def.types.includes('creature'))
      : ctx.state.battlefield.filter((c) => c.instanceId === ctx.targets[0]);
  // Read every X before any is applied: "each creature" doubles from the
  // powers as the ability resolves, and a lord doubling first would inflate
  // the creatures it pumps.
  const amounts = subjects.map((c) => effectivePower(c, aggregateFor(ctx.state, c.instanceId)));
  for (let i = 0; i < subjects.length; i++) {
    const power = amounts[i]!;
    if (power === 0) continue;
    ctx.addContinuousEffect({ target: subjects[i]!.instanceId, duration: 'endOfTurn', power });
  }
};

/**
 * `revealTopDrawIf` — "reveal the top card of your library. If it's a creature
 * or land card, draw a card" (Track Down); with `optional`, "you may reveal…
 * If a creature card is revealed this way, draw a card" (Elven Farsight). The
 * revealed card stays on top; the reveal itself is public information the
 * engine has no event for yet, so the only trace is the draw.
 */
export const revealTopDrawIf: EffectPrimitive = (ctx) => {
  const top = ctx.state.players[ctx.controller].library[0];
  if (top === undefined) return;
  if (boolParam(ctx, 'optional', false)) {
    const reveal = ctx.confirm({
      chooser: ctx.controller,
      prompt: 'Reveal the top card of your library?',
      valence: 'gain',
    });
    if (reveal === undefined) return; // parked
    if (!reveal) return;
  }
  if (!matchesCardFilter(top, filterParam(ctx))) return;
  drawCardForPlayer(ctx.state, ctx.controller, ctx.emit);
};

/** The primitives this module contributes to the shared registry. */
export const SPELL_COUNT_PRIMITIVES: Readonly<Record<string, EffectPrimitive>> = Object.freeze({
  stormCopies,
  cascade,
  ripple,
  learn,
  millThenReturn,
  doublePower,
  revealTopDrawIf,
});

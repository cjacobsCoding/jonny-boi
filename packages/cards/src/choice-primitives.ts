/**
 * The CHOICE-driven half of the effect-primitive library — the primitives that ask
 * the player a question mid-resolution (core's `GameState.pendingChoice`, DESIGN
 * §3.11) instead of guessing on their behalf.
 *
 * Every primitive here is GENERAL, exactly like the ones in `./primitives`: it
 * reads what to ask from `ctx.params` and knows nothing about any specific card.
 * Brainstorm is `putFromHandOnTop { count: 2 }`; Ponder is `reorderTopOfLibrary
 * { count: 3 }` + `mayShuffleLibrary`; Thoughtseize is `discardCard` with
 * `chosenBy: 'controller'` and a nonland filter. Adding the next "you may search /
 * choose / put back" card is a DATA edit, never a new branch in here.
 *
 * ## The one contract every primitive below obeys: ASK FIRST, THEN MUTATE
 * `ctx.ask` (and the typed `chooseCards` / `confirm` / `chooseModes` /
 * `payOrDecline` helpers)
 * returns `undefined` when the question has been PARKED. The engine then re-runs
 * this same effect ref from the top once the answer arrives, replaying the
 * already-answered questions. So anything mutated *before* an unanswered ask would
 * happen twice. Each primitive therefore collects every answer it needs first and
 * only then touches the state.
 *
 * ## Valence is how the AI plays a card it has never seen
 * `ChoiceValence` says whether being selected is good or bad *for the chooser*, so
 * a pilot picks its best cards on a `'gain'` and its worst on a `'loss'` without
 * any card knowledge. Getting it wrong does not make a choice illegal — it makes
 * the AI play the card badly, which is worse, because the whole point of the sim
 * is that its numbers reflect real play.
 */

import type {
  CardFilter,
  CardOption,
  EffectContext,
  EffectPrimitive,
  EffectRef,
  InstanceId,
  PlayerId,
  CardType,
} from '@jonny-boi/core';
import { collectCardOptions, formatManaCost, isCreature, matchesCardFilter, transformPermanent } from '@jonny-boi/core';
import {
  boolParam,
  counterSpellOnStack,
  firstPlayerTarget,
  firstTargetInstance,
  intParam,
  manaCostParam,
  moveOwnedCard,
  movePermanentTo,
  otherPlayer,
  putOntoBattlefield,
  strArrayParam,
  strParam,
  targetedSpellOnStack,
} from './effect-helpers.js';

// --- param shapes shared by several primitives -----------------------------------

/**
 * Read a `CardFilter` param ("nonland card", "creature with mana value ≤ 2"). The
 * filter is plain serializable data on the card, which is what lets the same
 * predicate be applied by the engine and read by the UI/AI.
 */
function filterParam(ctx: EffectContext, key = 'filter'): CardFilter | undefined {
  const v = ctx.params[key];
  return typeof v === 'object' && v !== null ? (v as CardFilter) : undefined;
}

/**
 * Restrict candidate options to a list of exact card names (`params.nameAnyOf`).
 *
 * This is how "a **basic** land card" is written: `CardFilter` has no supertype
 * field, and the five basics are a fixed, data-authored list (see
 * `BASIC_LAND_NAMES` in `../data/pool`), so the card carries the names it means.
 * An absent/empty list keeps every candidate.
 */
function restrictToNames(ctx: EffectContext, options: readonly CardOption[]): readonly CardOption[] {
  const names = strArrayParam(ctx, 'nameAnyOf');
  if (names.length === 0) return options;
  const allowed = new Set(names);
  return options.filter((o) => allowed.has(o.name));
}

/**
 * Resolve the player a primitive acts on from `params[key]`:
 *   - `'controller'` — the source's controller (the default),
 *   - `'opponent'` — the controller's opponent,
 *   - `'targetPlayer'` — the first targeted player, falling back to the opponent,
 *   - `'targetController'` — whoever controlled the targeted *permanent*, looked up
 *     wherever that card now is (it may already have been exiled by an earlier
 *     effect of the same spell — that is Path to Exile's shape exactly). With no
 *     such target this yields `undefined`, and the caller degrades to a no-op.
 */
function playerParam(ctx: EffectContext, key: string, fallback: string): PlayerId | undefined {
  switch (strParam(ctx, key) ?? fallback) {
    case 'opponent':
      return otherPlayer(ctx.controller);
    case 'targetPlayer':
      return firstPlayerTarget(ctx) ?? otherPlayer(ctx.controller);
    case 'targetController':
      return firstTargetInstance(ctx)?.controller;
    default:
      return ctx.controller;
  }
}

// --- library ordering / selection --------------------------------------------------

/**
 * `putFromHandOnTop` — put `params.count` cards from a player's hand on top of
 * their library **in an order they choose** (Brainstorm's back half).
 *
 * The selection is `ordered`, which is the whole mechanic: the answer's order IS
 * the answer, first-chosen ending up on top (drawn first). Valence `'loss'` —
 * these cards leave your hand, so a pilot puts back its *worst* two, best-first
 * within them.
 */
export const putFromHandOnTop: EffectPrimitive = (ctx) => {
  const count = intParam(ctx, 'count', 1);
  if (count <= 0) return;
  const who = playerParam(ctx, 'who', 'controller');
  if (!who) return;
  const candidates = collectCardOptions(ctx.state, 'hand', { controller: who, filter: filterParam(ctx) });
  const chosen = ctx.chooseCards({
    chooser: who,
    prompt: `Put ${count} card(s) from your hand on top of your library, in any order`,
    candidates,
    min: count,
    max: count,
    ordered: true,
    valence: 'loss',
    fromZone: 'hand',
  });
  if (!chosen) return; // parked — nothing mutated, this ref will be re-run
  // The FIRST chosen card must end up on top, so place them back-to-front.
  for (let i = chosen.length - 1; i >= 0; i--) {
    const id = chosen[i] as InstanceId;
    moveOwnedCard(ctx, who, id, 'hand', 'library', 'top');
  }
};

/**
 * `reorderTopOfLibrary` — look at the top `params.count` cards of a library and put
 * them back **in any order** (Ponder's first half; also Brainstorm-family scry-less
 * "rearrange" clauses).
 *
 * Asked as one ordered selection of *all* the cards looked at: choosing the order
 * is choosing the answer. Valence `'gain'` — the front of the answer is what you
 * draw first, so a pilot puts its best card on top.
 */
export const reorderTopOfLibrary: EffectPrimitive = (ctx) => {
  const count = intParam(ctx, 'count', 1);
  if (count <= 0) return;
  const who = playerParam(ctx, 'who', 'controller');
  if (!who) return;
  const candidates = collectCardOptions(ctx.state, 'library', { controller: who, limit: count, fromTop: true });
  if (candidates.length === 0) return;
  const chosen = ctx.chooseCards({
    chooser: who,
    prompt: `Put the top ${candidates.length} card(s) of your library back in any order`,
    candidates,
    // Every card looked at goes back, so the count is fixed and only the ORDER is
    // in question. (Core clamps to the candidate count for a short library.)
    min: candidates.length,
    max: candidates.length,
    ordered: true,
    valence: 'gain',
    fromZone: 'library',
  });
  if (!chosen) return;
  // Re-seat them front-to-back: pull each chosen card out and push it back on top
  // in reverse, so the first choice ends up on top.
  for (let i = chosen.length - 1; i >= 0; i--) {
    const id = chosen[i] as InstanceId;
    const library = ctx.state.players[who].library;
    const index = library.findIndex((c) => c.instanceId === id);
    if (index < 0) continue; // already gone — safe, never a throw
    const [card] = library.splice(index, 1);
    if (card) library.unshift(card);
  }
};

/**
 * `mayShuffleLibrary` — a yes/no "you may shuffle" (Ponder's middle clause).
 *
 * Valence: `'loss'` by default, and deliberately so. The card that offers this has
 * just let you *arrange* the top of your library, and shuffling throws that
 * arrangement away — so for a pilot that ordered its top cards best-first,
 * declining is the better play. Both answers stay perfectly legal; valence only
 * steers the AI. A card where shuffling is the upside can say so with
 * `params.valence: 'gain'`.
 */
export const mayShuffleLibrary: EffectPrimitive = (ctx) => {
  const who = playerParam(ctx, 'who', 'controller');
  if (!who) return;
  const valence = strParam(ctx, 'valence') === 'gain' ? 'gain' : 'loss';
  const yes = ctx.confirm({ chooser: who, prompt: 'You may shuffle your library', valence });
  if (yes === undefined) return; // parked
  if (!yes) return;
  ctx.shuffleLibrary(who);
};

/**
 * `searchLibrary` — "search your library for a card, put it into <zone>, then
 * shuffle" (Path to Exile's compensation; any tutor).
 *
 * Params: `who` (whose library — see {@link playerParam}), `optional` (ask a
 * yes/no first, which is what "**may** search" means), `filter` + `nameAnyOf`
 * (what may be found — the two together express "a basic land card"),
 * `count` (how many, default 1), `destination` (`'hand'` by default or
 * `'battlefield'`) and `tapped` (for "…onto the battlefield tapped").
 *
 * `requiresTargetInZone` gates the search on the targeted card having actually
 * ended up in that zone — the honest way to tie a compensation clause to the
 * effect that earned it while the engine has no target-legality (fizzle) check:
 * Path to Exile only hands out a land when its creature really was exiled.
 *
 * Searching always ends in a shuffle off the state-carried seeded RNG, so the
 * whole thing stays reproducible. Declining the optional search shuffles nothing —
 * a library nobody searched was never disturbed.
 */
export const searchLibrary: EffectPrimitive = (ctx) => {
  const requiredZone = strParam(ctx, 'requiresTargetInZone');
  if (requiredZone !== undefined && firstTargetInstance(ctx)?.zone !== requiredZone) return;
  const who = playerParam(ctx, 'who', 'controller');
  if (!who) return; // e.g. the target permanent is gone — nothing to compensate
  const count = intParam(ctx, 'count', 1);
  if (count <= 0) return;

  // ASK FIRST, in a fixed order, mutating nothing until every answer is in.
  if (boolParam(ctx, 'optional', false)) {
    const yes = ctx.confirm({ chooser: who, prompt: 'You may search your library', valence: 'gain' });
    if (yes === undefined) return; // parked
    if (!yes) return; // declined — no search, and therefore no shuffle
  }
  const candidates = restrictToNames(ctx, collectCardOptions(ctx.state, 'library', { controller: who, filter: filterParam(ctx) }));
  const chosen = ctx.chooseCards({
    chooser: who,
    prompt: `Search your library for ${count} card(s)`,
    candidates,
    // A search may always FAIL to find, so the floor is zero.
    min: 0,
    max: count,
    valence: 'gain',
    fromZone: 'library',
  });
  if (!chosen) return; // parked

  const destination = strParam(ctx, 'destination') === 'battlefield' ? 'battlefield' : 'hand';
  const tapped = boolParam(ctx, 'tapped', false);

  // A fetched SHOCKLAND asks its "you may pay 2 life" here, mid-resolution,
  // BEFORE anything moves (the ask-first contract): the engine has already
  // charged the life by the time `paid` comes back true. Only a battlefield
  // destination raises it — a card searched to hand pays nothing.
  const shockPaid = new Map<InstanceId, boolean>();
  if (destination === 'battlefield') {
    for (const id of chosen) {
      const found = ctx.state.players[who].library.find((c) => c.instanceId === id);
      const shockCost = found?.def.entersTappedUnlessLifePaid;
      if (shockCost === undefined) continue;
      const paid = ctx.payLifeOrDecline({
        chooser: who,
        amount: shockCost,
        prompt: `Pay ${shockCost} life, or ${found!.def.name} enters tapped`,
        valence: 'neutral',
      });
      if (paid === undefined) return; // parked — nothing has moved yet
      shockPaid.set(id, paid);
    }
  }

  for (const id of chosen) {
    if (destination === 'battlefield') {
      // `putOntoBattlefield` consults `entersTapped`, whose answer for a
      // shockland is the unpaid default (tapped); a paid entry overrides it.
      const enters = shockPaid.get(id) === true ? { tapped: false, ignoreEntersTapped: true } : { tapped };
      putOntoBattlefield(ctx, who, id, 'library', enters);
    } else {
      moveOwnedCard(ctx, who, id, 'library', 'hand');
    }
  }
  // Searching a library shuffles it, found or not.
  ctx.shuffleLibrary(who);
};

/**
 * `revealTopCard` — a player reveals the top card of their library; if it matches
 * `params.filter` it goes to their hand, otherwise it stays exactly where it is
 * (Goblin Guide's attack trigger).
 *
 * No question is asked: nothing about it is optional. It lives here because it is
 * the *information* half of the same family — and because the engine has no
 * `cardsRevealed` event yet, the reveal itself is not in the log; every mechanical
 * consequence of it is exact.
 */
export const revealTopCard: EffectPrimitive = (ctx) => {
  const who = playerParam(ctx, 'who', 'controller');
  if (!who) return;
  const top = ctx.state.players[who].library[0];
  if (!top) return;
  if (!matchesCardFilter(top, filterParam(ctx))) return; // revealed, and put back
  moveOwnedCard(ctx, who, top.instanceId, 'library', 'hand');
};

// --- hand / graveyard selection -----------------------------------------------------

/**
 * `discardCard` — a player discards `params.count` (default 1) cards, **chosen by
 * somebody**: themselves (a plain "discard a card") or the spell's controller (a
 * Thoughtseize-style "reveal your hand, I choose").
 *
 * Params: `who` (whose hand — defaults to the targeted player, else the opponent),
 * `chosenBy` (`'self'`, the default, or `'controller'`), and `filter` (what may be
 * chosen: `{ noneOfTypes: ['land'] }` is "a nonland card").
 *
 * Valence follows from who is choosing, with no card knowledge: picking your own
 * discard is a `'loss'` (give up your worst), picking somebody else's is a
 * `'gain'` (take their best). An empty/filtered-out hand leaves zero candidates,
 * which core auto-answers as "none" rather than stopping the game.
 */
export const discardCard: EffectPrimitive = (ctx) => {
  const count = intParam(ctx, 'count', 1);
  if (count <= 0) return;
  const victim = playerParam(ctx, 'who', 'targetPlayer');
  if (!victim) return;
  const chooserIsController = strParam(ctx, 'chosenBy') === 'controller';
  const chooser = chooserIsController ? ctx.controller : victim;
  const candidates = collectCardOptions(ctx.state, 'hand', { controller: victim, filter: filterParam(ctx) });
  const chosen = ctx.chooseCards({
    chooser,
    prompt: chooser === victim ? `Discard ${count} card(s)` : `Choose ${count} card(s) for ${victim} to discard`,
    candidates,
    min: count,
    max: count,
    valence: chooser === victim ? 'loss' : 'gain',
    fromZone: 'hand',
  });
  if (!chosen) return; // parked
  for (const id of chosen) moveOwnedCard(ctx, victim, id, 'hand', 'graveyard');
};

/**
 * `returnFromGraveyard` — return `params.count` (default 1) **chosen** cards from a
 * player's graveyard to their hand (Eternal Witness's enters-the-battlefield
 * trigger; any regrowth effect).
 *
 * Valence `'gain'`: the chooser takes back their best card. `params.filter`
 * narrows what may be returned ("a creature card", "an instant or sorcery"), and
 * `params.optional` is the printed "**you may** return…" — a floor of zero rather
 * than a forced return. The source itself is never a candidate, so a creature's
 * own ETB cannot return the creature that just entered.
 */
export const returnFromGraveyard: EffectPrimitive = (ctx) => {
  const count = intParam(ctx, 'count', 1);
  if (count <= 0) return;
  const who = playerParam(ctx, 'who', 'controller');
  if (!who) return;
  const candidates = collectCardOptions(ctx.state, 'graveyard', {
    controller: who,
    filter: filterParam(ctx),
  }).filter((o) => o.instanceId !== ctx.source.instanceId);
  const chosen = ctx.chooseCards({
    chooser: who,
    prompt: `Return ${count} card(s) from your graveyard to your hand`,
    candidates,
    min: boolParam(ctx, 'optional', false) ? 0 : count,
    max: count,
    valence: 'gain',
    fromZone: 'graveyard',
  });
  if (!chosen) return; // parked
  for (const id of chosen) moveOwnedCard(ctx, who, id, 'graveyard', 'hand');
};

// --- modal spells --------------------------------------------------------------------

/** One mode of a modal card, as authored in the card's data. */
interface ModeSpec {
  readonly id: string;
  readonly label: string;
  /** What this mode does — ordinary effect refs, run if the mode is chosen. */
  readonly effects?: readonly EffectRef[];
  /**
   * What the mode needs in order to be CHOOSABLE at all. MTG only lets you pick a
   * mode whose targets are legal (CR 700.2), which is exactly why a Cryptic
   * Command cast with no spell to counter is still a real card: the counter mode
   * simply is not on the menu.
   */
  readonly requires?: ModeRequirement;
}

/** The target shapes a mode can require. Data, so the card states its own needs. */
type ModeRequirement = 'targetSpell' | 'targetPermanent' | 'targetCreature';

/** Whether this resolution's targets satisfy a mode's requirement. */
function modeIsAvailable(ctx: EffectContext, requires: ModeRequirement | undefined): boolean {
  if (!requires) return true;
  switch (requires) {
    case 'targetSpell':
      return ctx.targets.some((t) => ctx.state.stack.some((o) => o.kind === 'spell' && o.instanceId === t));
    case 'targetPermanent':
      return ctx.targets.some((t) => ctx.state.battlefield.some((c) => c.instanceId === t));
    case 'targetCreature':
      return ctx.targets.some((t) => ctx.state.battlefield.some((c) => c.instanceId === t && isCreature(c.def)));
    default:
      return false;
  }
}

/** Read the `modes` param, keeping only well-formed entries. */
function modesParam(ctx: EffectContext): readonly ModeSpec[] {
  const v = ctx.params.modes;
  if (!Array.isArray(v)) return [];
  return v.filter((m): m is ModeSpec => typeof m === 'object' && m !== null && typeof (m as ModeSpec).id === 'string');
}

/**
 * `modal` — "choose `params.count` —" then run the chosen modes' effects inside
 * this same resolution (Cryptic Command; every future modal card).
 *
 * The modes are DATA on the card; this primitive knows only how to ask and how to
 * enqueue. Chosen modes run in the order the card PRINTS them, not the order they
 * were picked, which is how MTG resolves a modal spell. Modes whose targets are
 * not legal for this cast are not offered (see {@link ModeSpec.requires}), and
 * core clamps the count to what is left, so a spell cast with nothing to counter
 * still resolves as the best legal version of itself instead of fizzling.
 */
export const modal: EffectPrimitive = (ctx) => {
  const count = intParam(ctx, 'count', 1);
  const modes = modesParam(ctx);
  if (modes.length === 0 || count <= 0) return;
  const available = modes.filter((m) => modeIsAvailable(ctx, m.requires));
  if (available.length === 0) return;
  const chosen = ctx.chooseModes({
    prompt: `Choose ${count} —`,
    modes: available.map((m) => ({ id: m.id, label: m.label })),
    min: count,
    max: count,
    valence: 'gain',
  });
  if (!chosen) return; // parked
  const picked = new Set(chosen);
  // Printed order, not answer order.
  const refs = modes.filter((m) => picked.has(m.id)).flatMap((m) => m.effects ?? []);
  ctx.enqueueEffects(refs);
};

// --- small battlefield primitives the modal card needs -------------------------------

/**
 * `returnToHand` — return the targeted permanent to its owner's hand (Cryptic
 * Command's bounce mode). No valid target → safe no-op.
 */
export const returnToHand: EffectPrimitive = (ctx) => {
  const target = ctx.targets.find((t) => ctx.state.battlefield.some((c) => c.instanceId === t));
  if (target === undefined) return;
  const perm = ctx.state.battlefield.find((c) => c.instanceId === target);
  if (!perm) return;
  movePermanentTo(ctx, perm, 'hand');
};

/**
 * `tapPermanents` — tap every permanent matching `params.types` (default:
 * creatures) controlled by `params.who` (default: the opponent). Cryptic Command's
 * "tap all creatures your opponents control"; a Falter-style effect is the same
 * primitive with different data.
 */
export const tapPermanents: EffectPrimitive = (ctx) => {
  // `'all'` means every controller, so it is the one scope that is NOT a single
  // player id; anything else resolves to one seat.
  const everyone = strParam(ctx, 'who') === 'all';
  const who = everyone ? undefined : playerParam(ctx, 'who', 'opponent');
  if (!everyone && who === undefined) return;
  const types = strArrayParam(ctx, 'types');
  const wanted: readonly CardType[] = types.length > 0 ? (types as readonly CardType[]) : DEFAULT_TAP_TYPES;
  for (const perm of ctx.state.battlefield) {
    if (who !== undefined && perm.controller !== who) continue;
    if (!wanted.some((t) => perm.def.types.includes(t))) continue;
    if (perm.tapped) continue;
    perm.tapped = true;
    ctx.emit({ type: 'tapped', instanceId: perm.instanceId });
  }
};

/** "Tap all creatures" is the overwhelmingly common form, so it is the default. */
const DEFAULT_TAP_TYPES: readonly CardType[] = Object.freeze(['creature'] as const);

// --- optional payment ------------------------------------------------------------------

/**
 * `counterUnlessPaid` — "Counter target spell **unless its controller pays {N}**"
 * (Mana Leak, Force Spike, Miscalculation, Daze's printed half).
 *
 * The question goes to the SPELL'S CONTROLLER, not to this card's — they are the
 * one being asked to pay, and on a counterspell they are always the opponent. The
 * cost is `params.unlessPaid`; the counter itself is the same move
 * `counterSpell` makes.
 *
 * ## Why this cannot be "ask, then pay yourself"
 * `ctx.payOrDecline` returning `true` means the mana is ALREADY SPENT — the engine
 * charges it as it accepts the answer (see `PayManaAnswer.pay`). So there is
 * exactly one thing left to decide here, and it is the thing the card prints:
 * whether the spell dies.
 *
 * ## The two ways to get this card wrong, both refused
 * A player who *cannot* pay is never asked (core settles an unaffordable payment
 * as a decline), so this never stops a game to collect an impossible answer — and
 * it never lets one through either: a cost of nothing is not a payment, which is
 * why `manaCostParam` rejects an empty cost and this primitive then counters
 * unconditionally rather than treating "paid {0}" as a save.
 */
export const counterUnlessPaid: EffectPrimitive = (ctx) => {
  const spell = targetedSpellOnStack(ctx);
  if (!spell) return; // already gone, or not a spell — safe no-op
  const cost = manaCostParam(ctx, UNLESS_PAID_PARAM);
  if (cost) {
    // ASK FIRST, THEN MUTATE: nothing above this line has touched the state.
    const paid = ctx.payOrDecline({
      chooser: spell.controller,
      cost,
      prompt: `Pay ${formatManaCost(cost)} or ${ctx.source.def.name} counters ${spell.card.def.name}`,
      // Paying keeps your spell, so agreeing is the favourable branch FOR THE
      // CHOOSER — which is what tells a pilot holding the mana to pay.
      valence: 'gain',
    });
    if (paid === undefined) return; // parked — resume later, nothing mutated
    if (paid) return; // paid in full: the spell resolves as normal
  }
  counterSpellOnStack(ctx, spell);
};

/** Where the optional payment's cost lives in a card's params. */
const UNLESS_PAID_PARAM = 'unlessPaid';

// --- transforming double-faced cards -------------------------------------------------

/**
 * `transformRevealTop` — Delver of Secrets' upkeep body: "look at the top card of
 * your library. You may reveal that card. If a card matching `params.filter` is
 * revealed this way, transform ~."
 *
 * The look and the "you may reveal" are ONE question: a `min: 0, max: 1`
 * selection whose single candidate is the top card. Offering the candidate IS
 * the look (the choice travels only to its chooser, so nobody else sees it — the
 * `choiceAsked` event carries just a count), selecting it is the reveal, and the
 * PROMPT is deliberately constant so the public log cannot leak whether the top
 * card matched when the reveal is declined.
 *
 * Valence is computed from the top card: revealing a matching card transforms
 * the source (`'gain'`), revealing a non-matching one does nothing but hand the
 * opponent information (`'loss'`) — so a pilot reveals exactly when it should,
 * with no card knowledge. Both answers stay legal either way; a human may still
 * reveal a blank to bluff.
 *
 * Same documented gap as {@link revealTopCard}: the engine has no
 * `cardsRevealed` event yet, so the reveal itself is not in the log — every
 * MECHANICAL consequence (the transform, or nothing) is exact.
 *
 * The transform itself is core's `transformPermanent` (CR 701.28/712): a source
 * that is not on the battlefield, or is not a transforming DFC, transforms
 * nothing — never a crash.
 */
export const transformRevealTop: EffectPrimitive = (ctx) => {
  const who = playerParam(ctx, 'who', 'controller');
  if (!who) return;
  const candidates = collectCardOptions(ctx.state, 'library', { controller: who, limit: 1, fromTop: true });
  if (candidates.length === 0) return; // empty library — nothing to look at
  const filter = filterParam(ctx);
  const top = ctx.state.players[who].library[0];
  const matches = top !== undefined && matchesCardFilter(top, filter);
  const chosen = ctx.chooseCards({
    chooser: who,
    prompt: 'You may reveal the top card of your library',
    candidates,
    min: 0,
    max: 1,
    valence: matches ? 'gain' : 'loss',
    fromZone: 'library',
  });
  if (chosen === undefined) return; // parked — nothing mutated
  if (chosen.length === 0) return; // declined — the card stays hidden on top
  if (!matches) return; // revealed a non-matching card — nothing happens
  transformPermanent(ctx.state, ctx.source.instanceId, ctx.emit);
};

// --- registry ------------------------------------------------------------------------

/**
 * The choice-driven primitives, keyed by the stable id cards reference. Merged
 * into `CORE_PRIMITIVES` by `./primitives`, so there is still exactly one registry
 * to register.
 */
export const CHOICE_PRIMITIVES: Readonly<Record<string, EffectPrimitive>> = Object.freeze({
  putFromHandOnTop,
  reorderTopOfLibrary,
  mayShuffleLibrary,
  searchLibrary,
  revealTopCard,
  discardCard,
  returnFromGraveyard,
  modal,
  returnToHand,
  tapPermanents,
  counterUnlessPaid,
  transformRevealTop,
});

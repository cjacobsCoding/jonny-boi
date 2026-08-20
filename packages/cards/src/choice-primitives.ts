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
  CardInstance,
  CardOption,
  EffectContext,
  EffectPrimitive,
  InstanceId,
  ManaCost,
  PlayerId,
  CardType,
} from '@jonny-boi/core';
import {
  collectCardOptions,
  formatManaCost,
  isCreature,
  isPlayerTarget,
  matchesCardFilter,
  transformPermanent,
} from '@jonny-boi/core';
import type { StackObject } from '@jonny-boi/core';
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
  // "Each player discards a card" (Liliana of the Veil's +1): BOTH seats choose
  // their own discards, in APNAP order — the active player answers first
  // (CR 101.4). Handled inside this primitive because it is the same question
  // asked twice, and BOTH answers are collected before either card moves, per
  // the ask-first-then-mutate contract in this file's header.
  if (strParam(ctx, 'who') === 'eachPlayer') {
    discardEachPlayer(ctx, count);
    return;
  }
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

/** The "each player discards" branch of {@link discardCard}. */
function discardEachPlayer(ctx: EffectContext, count: number): void {
  const active = ctx.state.activePlayer;
  const order: readonly PlayerId[] = [active, otherPlayer(active)];
  const chosen: (readonly InstanceId[])[] = [];
  for (const victim of order) {
    const candidates = collectCardOptions(ctx.state, 'hand', {
      controller: victim,
      filter: filterParam(ctx),
    });
    const picked = ctx.chooseCards({
      chooser: victim,
      prompt: `Discard ${count} card(s)`,
      candidates,
      min: count,
      max: count,
      valence: 'loss',
      fromZone: 'hand',
    });
    if (!picked) return; // parked — nothing mutated yet
    chosen.push(picked);
  }
  // Both answers are in; the discards happen "at the same time" (both were
  // chosen from un-discarded hands, so neither choice saw the other's result).
  for (let i = 0; i < order.length; i++) {
    for (const id of chosen[i]!) moveOwnedCard(ctx, order[i]!, id, 'hand', 'graveyard');
  }
}

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

// --- modal spells -------------------------------------------------------------------
//
// There is deliberately NO `modal` PRIMITIVE. A modal spell's modes are chosen
// as it is CAST (CR 601.2b), not as it resolves, and a primitive only ever runs
// during a resolution — so a primitive-based modal card could not help but let
// its controller see the opponent's response before committing to a mode, which
// is strictly better than the printed card.
//
// The system lives on the cast seam instead: `CardDefinition.modal` (core's
// `ModalSpec`), announced and aimed by the engine's cast-time question pipeline,
// and flattened into this resolution by `picksToResolution` (core's
// `modal.ts`). The modes' own effects are ordinary primitives from this file
// and `../primitives.ts`, which is exactly the composition the seam is for.

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
 * `tapPermanents` — tap (or UNTAP) every permanent matching `params.types`
 * (default: creatures) controlled by `params.who` (default: the opponent).
 * Cryptic Command's "tap all creatures your opponents control"; a Falter-style
 * effect is the same primitive with different data.
 *
 * Params:
 *   - `who` — whose permanents (`'all'` for every controller).
 *   - `types` — the card types to match (default: creatures).
 *   - `excludeTypes` — types to SKIP, which is how "all **nonland** permanents"
 *     is written. Applied after `types`, so `types: [every permanent type]` plus
 *     `excludeTypes: ['land']` is exactly the printed set.
 *   - `untap` — run the loop in the other direction. Untapping is the same
 *     traversal with the flag and the event flipped, so it is a parameter rather
 *     than a second primitive; a card that untaps is not a different mechanic
 *     from one that taps, and splitting them would duplicate the filter logic.
 */
export const tapPermanents: EffectPrimitive = (ctx) => {
  // `'all'` means every controller, so it is the one scope that is NOT a single
  // player id; anything else resolves to one seat.
  const everyone = strParam(ctx, 'who') === 'all';
  const who = everyone ? undefined : playerParam(ctx, 'who', 'opponent');
  if (!everyone && who === undefined) return;
  const types = strArrayParam(ctx, 'types');
  const wanted: readonly CardType[] = types.length > 0 ? (types as readonly CardType[]) : DEFAULT_TAP_TYPES;
  const excluded = strArrayParam(ctx, 'excludeTypes') as readonly CardType[];
  const untapping = boolParam(ctx, 'untap', false);
  for (const perm of ctx.state.battlefield) {
    if (who !== undefined && perm.controller !== who) continue;
    if (!wanted.some((t) => perm.def.types.includes(t))) continue;
    if (excluded.length > 0 && excluded.some((t) => perm.def.types.includes(t))) continue;
    if (perm.tapped === !untapping) continue; // already in the state we would set
    perm.tapped = !untapping;
    ctx.emit(
      untapping
        ? { type: 'untapped', instanceId: perm.instanceId, player: perm.controller }
        : { type: 'tapped', instanceId: perm.instanceId },
    );
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
  // "…unless its controller pays {X}" (Condescend): the cost is the X the
  // CASTER chose (and paid for) at cast time, read off the resolution. X = 0
  // prints a cost of {0}, which any player trivially pays (CR 118.5) — so the
  // spell simply survives, exactly like the printed card cast for zero.
  if (boolParam(ctx, UNLESS_PAID_X_PARAM, false)) {
    const x = ctx.xValue ?? 0;
    if (x <= 0) return; // "pays {0}" — always paid, never a counter
    const cost: ManaCost = { generic: x };
    const paid = ctx.payOrDecline({
      chooser: spell.controller,
      cost,
      prompt: `Pay ${formatManaCost(cost)} or ${ctx.source.def.name} counters ${spell.card.def.name}`,
      valence: 'gain',
    });
    if (paid === undefined) return; // parked — resume later, nothing mutated
    if (paid) return; // paid in full: the spell resolves as normal
    counterSpellOnStack(ctx, spell);
    return;
  }
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

/** Boolean param: the payment is the {X} chosen at cast time (Condescend). */
const UNLESS_PAID_X_PARAM = 'unlessPaidX';

/**
 * `wardCounterUnlessPaid` — the resolution of a WARD trigger (CR 702.21):
 * "counter the spell or ability that targeted this permanent unless its
 * controller pays the ward cost".
 *
 * The id is core's reserved {@link WARD_COUNTER_PRIMITIVE} seam: core raises
 * the trigger itself when an opponent's spell/ability targets a warded
 * permanent ("becomes the target" is a moment only the engine sees), and this
 * primitive supplies the behaviour through the SAME optional-payment machinery
 * Mana Leak uses — the engine enriches affordability, charges the mana as the
 * answer is accepted, and never asks a player who cannot pay.
 *
 * Unlike `counterUnlessPaid` this must counter ABILITIES too — ward reads
 * "spell or ability", and a Flametongue-style trigger aimed at a warded
 * creature is the ability case. Countering a trigger object is simply removing
 * it from the stack (no card changes zones), reported with the same event a
 * fizzled trigger emits so the log always says why the stack shrank.
 */
export const wardCounterUnlessPaid: EffectPrimitive = (ctx) => {
  const target = ctx.targets[0];
  if (target === undefined || isPlayerTarget(target)) return;
  const object = ctx.state.stack.find((o) => o.instanceId === target);
  if (!object) return; // already resolved or countered — safe no-op
  const cost = manaCostParam(ctx, UNLESS_PAID_PARAM);
  if (cost) {
    // ASK FIRST, THEN MUTATE — nothing above this line has touched the state.
    const paid = ctx.payOrDecline({
      chooser: object.controller,
      cost,
      prompt: `Pay ${formatManaCost(cost)} (ward) or ${ctx.source.def.name}'s ward counters ${describeStackObject(object)}`,
      // Paying keeps your spell/ability, so agreeing is the favourable branch
      // for the chooser — exactly as with a soft counterspell.
      valence: 'gain',
    });
    if (paid === undefined) return; // parked — resume later, nothing mutated
    if (paid) return; // paid in full: the targeting object resolves as normal
  }
  if (object.kind === 'spell') {
    counterSpellOnStack(ctx, object);
    return;
  }
  const idx = ctx.state.stack.indexOf(object);
  if (idx < 0) return;
  ctx.state.stack.splice(idx, 1);
  ctx.emit({
    type: 'triggerRemovedFromStack',
    sourceInstanceId: object.sourceInstanceId,
    controller: object.controller,
    label: object.label,
    reason: `countered by ${ctx.source.def.name}'s ward`,
  });
};

/** How a countered stack object reads in the ward prompt. */
function describeStackObject(object: StackObject): string {
  return object.kind === 'spell' ? object.card.def.name : object.label;
}

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

// --- scry & surveil ------------------------------------------------------------------

/**
 * The shared first half of scry and surveil: look at the top `count` cards of
 * `who`'s library and ask which of them STAY on top, in the order they will be
 * drawn. Returns the answer plus the candidates it was asked over, or
 * `undefined` while the question is parked.
 *
 * One deliberately constant-shaped question (a `keepOnTop`-marked ordered
 * `selectCards`, min 0): offering the candidates IS the look — the choice
 * travels only to its chooser, and the public `choiceAsked` event carries only
 * a count, so a spectator learns exactly what paper Magic shows the table: that
 * N cards were looked at (the `transformRevealTop` precedent). The prompt names
 * only the count and where the rest go, never a card.
 */
function askKeepOnTop(
  ctx: EffectContext,
  who: PlayerId,
  count: number,
  restFate: string,
): { kept: readonly InstanceId[]; candidates: readonly CardOption[] } | undefined {
  const candidates = collectCardOptions(ctx.state, 'library', { controller: who, limit: count, fromTop: true });
  if (candidates.length === 0) return { kept: [], candidates };
  const kept = ctx.chooseCards({
    chooser: who,
    prompt: `Look at the top ${candidates.length} card(s) of your library. Choose the cards to keep on top, in order — the rest ${restFate}`,
    candidates,
    min: 0,
    max: candidates.length,
    ordered: true,
    keepOnTop: true,
    valence: 'neutral',
    fromZone: 'library',
  });
  if (kept === undefined) return undefined; // parked — nothing mutated
  return { kept, candidates };
}

/**
 * Re-seat the kept cards so the FIRST chosen ends up on top — the same
 * back-to-front `moveOwnedCard 'top'` walk `reorderTopOfLibrary` uses, so the
 * two library-arranging primitives cannot disagree about what "in order" means.
 */
function placeKeptOnTop(ctx: EffectContext, who: PlayerId, kept: readonly InstanceId[]): void {
  for (let i = kept.length - 1; i >= 0; i--) {
    moveOwnedCard(ctx, who, kept[i] as InstanceId, 'library', 'library', 'top');
  }
}

/**
 * Log the LOOK itself, as a count and nothing more — the public half of a scry
 * or a surveil (see core's `cardsLookedAt`). Called from the mutate phase, once
 * every answer is in: emitting it before an unanswered ask would log the same
 * look again on every re-run of the effect.
 */
function emitLookedAt(ctx: EffectContext, who: PlayerId, amount: number): void {
  if (amount > 0) ctx.emit({ type: 'cardsLookedAt', player: who, amount });
}

/**
 * `scry` — "Scry N" (CR 701.18): look at the top `params.count` cards of your
 * library, put any number of them on the bottom and the rest back on top, both
 * groups in any order.
 *
 * TWO questions, both collected before anything moves (the ask-first contract):
 *   1. which cards stay on TOP, in draw order ({@link askKeepOnTop});
 *   2. the ORDER of the bottomed cards — asked only when there are two or more
 *      to order (one or zero is not a decision; core would auto-answer anyway).
 * In both ordered answers the FIRST chosen card is the one that comes up
 * soonest: topmost of the kept, and the highest-placed (drawn first if the
 * library empties) of the bottomed — the one meaning `ordered` always has.
 *
 * A library shorter than N scries what is there (core clamps the look). The
 * bottom placement is `moveOwnedCard`'s `'bottom'` position — the same funnel
 * every zone move uses, so each move emits the standard `zoneChange`, which the
 * observation layer already anonymises (its destination is a hidden zone).
 */
export const scry: EffectPrimitive = (ctx) => {
  const count = intParam(ctx, 'count', 1);
  if (count <= 0) return;
  const who = playerParam(ctx, 'who', 'controller');
  if (!who) return;

  const look = askKeepOnTop(ctx, who, count, 'go to the bottom of your library');
  if (look === undefined) return; // parked
  const { kept, candidates } = look;
  if (candidates.length === 0) return; // empty library — nothing to scry

  const keptSet = new Set(kept);
  const restOptions = candidates.filter((option) => !keptSet.has(option.instanceId));
  let bottomOrder: readonly InstanceId[] = restOptions.map((option) => option.instanceId);
  if (restOptions.length > 1) {
    const chosen = ctx.chooseCards({
      chooser: who,
      prompt: `Put ${restOptions.length} card(s) on the bottom of your library, in any order`,
      candidates: restOptions,
      min: restOptions.length,
      max: restOptions.length,
      ordered: true,
      valence: 'neutral',
      fromZone: 'library',
    });
    if (chosen === undefined) return; // parked — still nothing mutated
    bottomOrder = chosen;
  }

  // MUTATE, only now. Bottoms first (the kept cards are still on top and out of
  // the way), each appended to the library's end: the first-chosen bottom card
  // is pushed first and every later one lands BELOW it, so first = surfaces
  // soonest. Then the kept cards are re-seated in chosen order.
  emitLookedAt(ctx, who, candidates.length);
  for (const id of bottomOrder) {
    moveOwnedCard(ctx, who, id, 'library', 'library', 'bottom');
  }
  placeKeptOnTop(ctx, who, kept);
};

/**
 * `surveil` — "Surveil N" (CR 701.42): look at the top `params.count` cards of
 * your library, put any number into your graveyard and the rest back on top in
 * any order.
 *
 * ONE question suffices: the kept-on-top pick ({@link askKeepOnTop}) decides
 * everything, because a graveyard has no order worth asking about. The
 * graveyarded cards move through the same `moveOwnedCard` funnel, whose
 * `zoneChange` into a PUBLIC zone carries the instance id — exactly paper
 * Magic, where surveilled-away cards are placed face up for the table to see,
 * while the kept cards stay hidden.
 *
 * Filling a graveyard this way triggers nothing extra by construction: the
 * moves emit only the standard `zoneChange`s, and no trigger condition in core
 * watches cards ARRIVING in a graveyard from a library (dying is its own
 * event).
 */
export const surveil: EffectPrimitive = (ctx) => {
  const count = intParam(ctx, 'count', 1);
  if (count <= 0) return;
  const who = playerParam(ctx, 'who', 'controller');
  if (!who) return;

  const look = askKeepOnTop(ctx, who, count, 'go to your graveyard');
  if (look === undefined) return; // parked
  const { kept, candidates } = look;
  if (candidates.length === 0) return; // empty library — nothing to surveil

  emitLookedAt(ctx, who, candidates.length);
  const keptSet = new Set(kept);
  for (const option of candidates) {
    if (keptSet.has(option.instanceId)) continue;
    moveOwnedCard(ctx, who, option.instanceId, 'library', 'graveyard');
  }
  placeKeptOnTop(ctx, who, kept);
};

// --- registry ------------------------------------------------------------------------

/**
 * The choice-driven primitives, keyed by the stable id cards reference. Merged
 * into `CORE_PRIMITIVES` by `./primitives`, so there is still exactly one registry
 * to register.
 */
// --- sacrifice (a player chooses what leaves their own board) ----------------------

/**
 * Sacrifice a permanent: its controller's own choice moved to its owner's
 * graveyard through the same zone path death uses, so dies-triggers and instance
 * reset behave identically. `creatureDied` / `planeswalkerDied` are emitted for
 * the kinds that have death events, because a sacrificed creature DIES.
 */
function sacrificePermanent(ctx: EffectContext, perm: CardInstance): void {
  const wasCreature = isCreature(perm.def);
  const wasWalker = perm.def.types.includes('planeswalker');
  if (wasCreature) {
    ctx.emit({ type: 'creatureDied', instanceId: perm.instanceId, name: perm.def.name });
  } else if (wasWalker) {
    ctx.emit({ type: 'planeswalkerDied', instanceId: perm.instanceId, name: perm.def.name });
  }
  movePermanentTo(ctx, perm, 'graveyard');
}

/**
 * `sacrificeChosen` — "target player sacrifices a creature" (Liliana of the
 * Veil's −2; every edict). The VICTIM chooses which of their own permanents is
 * sacrificed — that choice is the entire card, which is why this is not
 * `destroyTarget`: nothing here targets a creature, so hexproof does not save
 * it and the victim gives up their worst body, not the caster's pick.
 *
 * Params: `who` (whose board — `'targetPlayer'` by default), `count` (how many,
 * default 1), `filter` (what qualifies — `{ anyOfTypes: ['creature'] }` is
 * "a creature"). A board with nothing that qualifies sacrifices nothing (zero
 * candidates auto-answer as "none" — the printed card does nothing either).
 */
export const sacrificeChosen: EffectPrimitive = (ctx) => {
  const count = intParam(ctx, 'count', 1);
  if (count <= 0) return;
  const victim = playerParam(ctx, 'who', 'targetPlayer');
  if (!victim) return;
  const candidates = collectCardOptions(ctx.state, 'battlefield', {
    controller: victim,
    filter: filterParam(ctx),
  });
  const chosen = ctx.chooseCards({
    chooser: victim,
    prompt: `Sacrifice ${count} permanent(s)`,
    candidates,
    min: count,
    max: count,
    valence: 'loss',
    fromZone: 'battlefield',
  });
  if (!chosen) return; // parked
  for (const id of chosen) {
    const perm = ctx.state.battlefield.find((c) => c.instanceId === id);
    if (perm) sacrificePermanent(ctx, perm);
  }
};

/** The two pile ids the split offers — data the UI/AI answer refers back to. */
const PILE_ONE = 'pile1';
const PILE_TWO = 'pile2';

/**
 * `pileSplitSacrifice` — Liliana of the Veil's −6: "Separate all permanents
 * target player controls into two piles. That player sacrifices all permanents
 * in the pile of their choice."
 *
 * Two questions, in the printed order, both collected before anything moves:
 *   1. the CONTROLLER splits — a `selectCards` over every permanent the victim
 *      controls; the chosen cards are pile one, the rest are pile two (choosing
 *      none, or everything, is a legal — if poor — split);
 *   2. the VICTIM picks which pile is sacrificed — a two-mode `chooseModes`
 *      whose labels list each pile's contents so the decision is renderable by
 *      a UI that knows no rules.
 * Then every permanent in the chosen pile is sacrificed at once.
 *
 * The split is valence-`'neutral'` deliberately: "half my picks are good for me"
 * has no per-card direction, and the searchless pilot's pile is built by the AI
 * layer (which knows values), not by a valence hint.
 */
export const pileSplitSacrifice: EffectPrimitive = (ctx) => {
  const victim = playerParam(ctx, 'who', 'targetPlayer');
  if (!victim) return;
  const all = collectCardOptions(ctx.state, 'battlefield', { controller: victim });
  if (all.length === 0) return; // no permanents — nothing to split, nothing to do

  const pileOne = ctx.chooseCards({
    chooser: ctx.controller,
    prompt: `Separate ${victim}'s permanents into two piles`,
    candidates: all,
    min: 0,
    max: all.length,
    valence: 'neutral',
    fromZone: 'battlefield',
  });
  if (!pileOne) return; // parked

  const inPileOne = new Set(pileOne);
  const pileTwo = all.filter((option) => !inPileOne.has(option.instanceId));
  const describe = (options: readonly CardOption[]): string =>
    options.length === 0 ? '(empty)' : options.map((option) => option.name).join(', ');
  const picked = ctx.chooseModes({
    chooser: victim,
    prompt: 'Sacrifice all permanents in the pile of your choice',
    modes: [
      { id: PILE_ONE, label: `Sacrifice pile 1: ${describe(all.filter((o) => inPileOne.has(o.instanceId)))}` },
      { id: PILE_TWO, label: `Sacrifice pile 2: ${describe(pileTwo)}` },
    ],
    min: 1,
    max: 1,
    valence: 'neutral',
  });
  if (!picked) return; // parked — the split is replayed from `frame.answers`

  const sacrificed = picked[0] === PILE_ONE ? [...inPileOne] : pileTwo.map((o) => o.instanceId);
  for (const id of sacrificed) {
    const perm = ctx.state.battlefield.find((c) => c.instanceId === id);
    if (perm) sacrificePermanent(ctx, perm);
  }
};

export const CHOICE_PRIMITIVES: Readonly<Record<string, EffectPrimitive>> = Object.freeze({
  putFromHandOnTop,
  reorderTopOfLibrary,
  mayShuffleLibrary,
  searchLibrary,
  revealTopCard,
  discardCard,
  returnFromGraveyard,
  returnToHand,
  tapPermanents,
  counterUnlessPaid,
  sacrificeChosen,
  pileSplitSacrifice,
  wardCounterUnlessPaid,
  transformRevealTop,
  scry,
  surveil,
});

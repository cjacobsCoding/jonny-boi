/**
 * THE COUNTER KEYWORD FAMILY (DESIGN §3.110) — the primitives behind the
 * keywords and templates that PLACE +1/+1 COUNTERS: undying (CR 702.93),
 * modular (702.43), renown (702.112), bloodthirst (702.54), riot (702.136),
 * unleash (702.98), devour (702.82), fabricate (702.122 — the Servo half;
 * the counter half is `addCounters`), amass (701.47), bolster (701.37),
 * backup (702.165) and explore (701.42).
 *
 * Every one of them is a BODY of a trigger, an entry script or a spell the
 * compiler builds from the existing vocabulary; what this file adds is the
 * handful of verbs the existing primitives did not speak — a return from the
 * graveyard that brings a counter, a counter move read from last-known
 * information, a once-only designation, an as-enters choice with a stake, a
 * counter placed by a toughness comparison, a token that grows instead of
 * multiplying, a reveal that becomes a land or a counter.
 *
 * Every question here is ask-then-mutate (see `EffectContext.ask`): a parked
 * answer re-runs the primitive from the top with nothing to undo. Every counter
 * goes through the ONE CR 614 counter site (`replaceCounters`), so a Hardened
 * Scales scales a riot counter exactly as it scales a placed one. Every
 * sacrifice goes through the one sacrifice funnel, every battlefield entry
 * through `putOntoBattlefield`, so dies-triggers and entry facts behave exactly
 * as they do everywhere else.
 */

import type {
  CardDefinition,
  CardFilter,
  CardInstance,
  EffectContext,
  EffectPrimitive,
  InstanceId,
  KeywordFlags,
} from '@jonny-boi/core';
import {
  aggregateFor,
  cardOption,
  effectiveToughness,
  indexReplacements,
  isCreature,
  matchesCardFilter,
  PLUS_ONE_COUNTER,
  replaceCounters,
  turnFactHolds,
} from '@jonny-boi/core';
import { sacrificePermanent } from './choice-primitives.js';
import {
  firstPermanentTarget,
  intParam,
  keywordsParam,
  isEmptyKeywords,
  moveOwnedCard,
  permanentById,
  putOntoBattlefield,
  selfIfCreature,
  strParam,
} from './effect-helpers.js';

// --- the printed constants, spelled once -------------------------------------------

/** Undying returns the creature with this many +1/+1 counters (CR 702.93a). */
export const UNDYING_PLUS_COUNTERS = 1;
/** Riot's and unleash's counter (CR 702.136a, 702.98a): one. */
export const ENTRY_CHOICE_COUNTERS = 1;
/** Explore's counter when the revealed card is not a land (CR 701.42a). */
export const EXPLORE_COUNTERS = 1;
/** The Army token amass creates when you control none (CR 701.47a): a 0/0 black Army. */
export const ARMY_TOKEN = Object.freeze({ power: 0, toughness: 0, colors: ['B'] as const, subtype: 'Army' });
/** Fabricate's Servo (CR 702.122a): a 1/1 colourless Servo artifact creature. */
export const SERVO_TOKEN = Object.freeze({ power: 1, toughness: 1, subtype: 'Servo' });

/** The prompts a UI shows for the two as-enters choices, spelled once for the tests. */
export const RIOT_PROMPT = 'Riot: enter with a +1/+1 counter (yes) or with haste (no)?';
export const UNLEASH_PROMPT = "Unleash: enter with a +1/+1 counter? (It can't block while it has one.)";
export const EXPLORE_GRAVEYARD_PROMPT = 'Explore: put the revealed nonland card into your graveyard?';

/**
 * The `context` a devour sacrifice question carries, so a pilot can tell "which
 * of my creatures do I FEED this" from an edict. See `SelectCardsRequest.context`.
 */
export const DEVOUR_CHOICE_CONTEXT = 'devour';
/** The `context` of explore's "put it into your graveyard?" — the surveil judgement, one card wide. */
export const EXPLORE_CHOICE_CONTEXT = 'explore';
/** The `context` of riot's "counter or haste?" (yes = the counter) and unleash's "counter?". */
export const RIOT_CHOICE_CONTEXT = 'riot';
export const UNLEASH_CHOICE_CONTEXT = 'unleash';

/** The param names shared by the compiler's rows and these bodies — one spelling. */
export const COUNTER_PARAM = {
  amount: 'amount',
  keywords: 'keywords',
  subtype: 'subtype',
  filter: 'filter',
  counter: 'counter',
} as const;

// --- shared helpers -------------------------------------------------------------------

/**
 * Put `amount` counters of `kind` on `target` through the ONE CR 614 counter
 * replacement site — the same call `addCountersOfKind` in primitives.ts makes,
 * repeated here rather than imported because that module imports this one's
 * table (an import back would be a load-order cycle; `upkeep-cost-primitives`
 * carries the same note).
 */
function putCountersOfKind(ctx: EffectContext, target: CardInstance, kind: string, amount: number): void {
  if (amount <= 0) return;
  const magnitude = replaceCounters(ctx.state, indexReplacements(ctx.state), ctx.source, target, kind, amount, ctx.emit);
  if (magnitude <= 0) return;
  // REPLACE the record, never write into it — see `CardInstance.counters`.
  target.counters = { ...target.counters, [kind]: (target.counters[kind] ?? 0) + magnitude };
  ctx.emit({ type: 'counterAdded', instanceId: target.instanceId, kind, amount: magnitude });
}

/**
 * The source as an entry-script subject: the permanent on the battlefield if it
 * is already there, otherwise the card CURRENTLY RESOLVING into play — the same
 * reading `addCounters`' `enteringOrResidentSelf` makes, because "enters with"
 * happens while the spell resolves and before it is pushed (CR 614.1c).
 */
function enteringSelf(ctx: EffectContext): CardInstance | undefined {
  return selfIfCreature(ctx) ?? (isCreature(ctx.source.def) ? ctx.source : undefined);
}

/** A creature token face from a printed word set, built the way `makeToken` builds one. */
function tokenDef(
  name: string,
  power: number,
  toughness: number,
  colors: readonly string[],
  subtypes: readonly string[],
  types: readonly CardDefinition['types'][number][],
): CardDefinition {
  return {
    id: `token:${[...types].join('-')}:${colors.join('') || 'c'}:${subtypes.join('-')}:${power}/${toughness}`,
    name,
    types,
    subtypes,
    power,
    toughness,
    colors: colors as CardDefinition['colors'],
  };
}

// --- undying (CR 702.93) -------------------------------------------------------------

/**
 * `undyingReturn` — the body of undying's trigger: "return it to the battlefield
 * under its owner's control with a +1/+1 counter on it" (CR 702.93a). The
 * printed "if it had no +1/+1 counters on it" is the trigger's INTERVENING "if"
 * (`sourceDiedWithoutCounter`, read from the LKI snapshot the runtime carries
 * as `triggeringAmount`), so by the time this runs the condition has already
 * held twice (CR 603.4) — the body only returns.
 *
 * The return goes through `putOntoBattlefield` (the one cards-side entry
 * funnel: ETB triggers fire, the entry facts are stamped) and the counter
 * through the one counter site, so a Hardened Scales makes a returning Young
 * Wolf a 3/3. Persist's return stays its own primitive because its no-second-
 * return mechanism differs (it strips the trigger); undying's is the "if".
 */
export const undyingReturn: EffectPrimitive = (ctx) => {
  const source = ctx.source;
  const returned = putOntoBattlefield(ctx, source.owner, source.instanceId, 'graveyard', { controller: source.owner });
  if (!returned) return; // not in the graveyard any more (already moved) — safe no-op
  putCountersOfKind(ctx, returned, PLUS_ONE_COUNTER, intParam(ctx, COUNTER_PARAM.amount, UNDYING_PLUS_COUNTERS));
};

// --- modular (CR 702.43) -------------------------------------------------------------

/**
 * `modularMove` — modular's death half: "you may put its +1/+1 counters on
 * target artifact creature" (CR 702.43a). "Its counters" is LAST-KNOWN
 * information (CR 603.10a): the graveyard card's are wiped, so the count is
 * the runtime's snapshot (`triggeringAmount`). The "may" is the target choice
 * itself — the trigger aims at UP TO one artifact creature, and choosing none
 * declines. A snapshot of zero moves nothing, as printed.
 */
export const modularMove: EffectPrimitive = (ctx) => {
  const moving = ctx.triggeringAmount ?? 0;
  if (moving <= 0) return;
  const target = firstPermanentTarget(ctx);
  if (!target || !isCreature(target.def)) return;
  putCountersOfKind(ctx, target, PLUS_ONE_COUNTER, moving);
};

// --- renown (CR 702.112) -------------------------------------------------------------

/**
 * `becomeRenowned` — "put N +1/+1 counters on it and it becomes renowned" (CR
 * 702.112a). The "if it isn't renowned" is the trigger's intervening "if"
 * (`sourceNotRenowned`); this body stamps the designation the "if" reads, so
 * the second connection never reaches the stack. The stamp is written ONLY
 * here, which is what keeps it off every other permanent's object shape.
 */
export const becomeRenowned: EffectPrimitive = (ctx) => {
  const self = permanentById(ctx.state, ctx.source.instanceId);
  if (!self || self.renowned === true) return;
  putCountersOfKind(ctx, self, PLUS_ONE_COUNTER, intParam(ctx, COUNTER_PARAM.amount, 0));
  self.renowned = true;
  ctx.emit({ type: 'becameRenowned', instanceId: self.instanceId, name: self.def.name });
};

// --- bloodthirst (CR 702.54) ---------------------------------------------------------

/**
 * `bloodthirstCounters` — "if an opponent was dealt damage this turn, this
 * creature enters with N +1/+1 counters on it" (CR 702.54a). An ENTRY-SCRIPT
 * body (the same seat "~ enters with N +1/+1 counters" occupies), reading the
 * turn-fact memory (`opponentWasDealtDamage`) as the spell resolves — which is
 * exactly when the printed replacement checks it.
 */
export const bloodthirstCounters: EffectPrimitive = (ctx) => {
  if (!turnFactHolds(ctx.state, 'opponentWasDealtDamage', ctx.controller)) return;
  const self = enteringSelf(ctx);
  if (!self) return;
  putCountersOfKind(ctx, self, PLUS_ONE_COUNTER, intParam(ctx, COUNTER_PARAM.amount, 0));
};

// --- riot (CR 702.136) and unleash (CR 702.98) ----------------------------------------

/**
 * `riotChoice` — "enters with your choice of a +1/+1 counter or haste" (CR
 * 702.136a). ONE question (yes = the counter, no = haste — see `RIOT_PROMPT`),
 * asked as the spell resolves. The haste half is a PERMANENT keyword grant on
 * the entering creature (the printed haste never expires), read by the same
 * effective-keyword check every attack and {T} legality goes through — and
 * not a cleared `summoningSick`, because the entry funnel sets sickness AFTER
 * the script runs, from the printed keywords, and would set it back.
 */
export const riotChoice: EffectPrimitive = (ctx) => {
  const self = enteringSelf(ctx);
  if (!self) return;
  const counter = ctx.confirm({ chooser: ctx.controller, prompt: RIOT_PROMPT, valence: 'neutral', context: RIOT_CHOICE_CONTEXT });
  if (counter === undefined) return; // parked — nothing mutated
  if (counter) {
    putCountersOfKind(ctx, self, PLUS_ONE_COUNTER, ENTRY_CHOICE_COUNTERS);
    return;
  }
  ctx.addContinuousEffect({ target: self.instanceId, keywords: { haste: true }, duration: 'permanent' });
};

/**
 * `unleashChoice` — "you may have this creature enter with a +1/+1 counter on
 * it" (CR 702.98a). The "can't block as long as it has a +1/+1 counter" half is
 * a self-only static the compiler builds beside this (`StaticAffects.onlySource`
 * + `hasCounterKind`), so it is read wherever blockers are declared.
 */
export const unleashChoice: EffectPrimitive = (ctx) => {
  const self = enteringSelf(ctx);
  if (!self) return;
  const counter = ctx.confirm({ chooser: ctx.controller, prompt: UNLEASH_PROMPT, valence: 'neutral', context: UNLEASH_CHOICE_CONTEXT });
  if (counter === undefined) return; // parked
  if (counter) putCountersOfKind(ctx, self, PLUS_ONE_COUNTER, ENTRY_CHOICE_COUNTERS);
};

// --- devour (CR 702.82) --------------------------------------------------------------

/**
 * `devourChoice` — "as this creature enters, you may sacrifice any number of
 * [creatures | artifacts | lands | Foods]. It enters with N times that many
 * +1/+1 counters on it" (CR 702.82a). Params: `amount` (N), `filter` (what may
 * be fed — `{ anyOfTypes: ['creature'] }` for the plain form; the compiler's
 * closed noun table decides).
 *
 * The question carries `context: 'devour'` so a pilot can weigh each candidate
 * against the N counters it becomes rather than treating the list as an edict.
 * The entering creature itself is never a candidate — it is not on the
 * battlefield while its spell resolves, and the CR's "sacrifice … creatures"
 * cannot reach a spell.
 */
export const devourChoice: EffectPrimitive = (ctx) => {
  const self = enteringSelf(ctx);
  if (!self) return;
  const perCreature = intParam(ctx, COUNTER_PARAM.amount, 0);
  const filter = ctx.params[COUNTER_PARAM.filter] as CardFilter | undefined;
  const candidates = ctx.state.battlefield.filter(
    (permanent) =>
      permanent.controller === ctx.controller &&
      permanent.instanceId !== self.instanceId &&
      matchesCardFilter(permanent, filter),
  );
  if (candidates.length === 0 || perCreature <= 0) return;
  const chosen = ctx.chooseCards({
    chooser: ctx.controller,
    prompt: `Devour ${perCreature}: sacrifice any number — ${self.def.name} enters with ${perCreature} +1/+1 counter(s) per sacrifice`,
    candidates: candidates.map(cardOption),
    min: 0,
    max: candidates.length,
    valence: 'neutral',
    fromZone: 'battlefield',
    context: DEVOUR_CHOICE_CONTEXT,
  });
  if (chosen === undefined) return; // parked — nothing mutated
  let devoured = 0;
  for (const id of chosen) {
    const permanent = permanentById(ctx.state, id);
    if (!permanent) continue;
    sacrificePermanent(ctx, permanent);
    devoured += 1;
  }
  putCountersOfKind(ctx, self, PLUS_ONE_COUNTER, devoured * perCreature);
};

// --- fabricate (CR 702.122) ----------------------------------------------------------

/**
 * `createServos` — fabricate's second mode: "create N 1/1 colorless Servo
 * artifact creature tokens" (CR 702.122a). The counter mode is the ordinary
 * `addCounters` self form; the choice between them is the trigger's MODAL spec
 * (CR 603.3c), which is why the pilot prices the two modes as it prices any
 * charm's. One `createTokens` call with the count, so a doubler sees N once.
 */
export const createServos: EffectPrimitive = (ctx) => {
  const count = intParam(ctx, COUNTER_PARAM.amount, 0);
  if (count <= 0) return;
  ctx.createTokens(
    tokenDef(SERVO_TOKEN.subtype, SERVO_TOKEN.power, SERVO_TOKEN.toughness, [], [SERVO_TOKEN.subtype], ['artifact', 'creature']),
    count,
  );
};

// --- amass (CR 701.47) ---------------------------------------------------------------

/**
 * `amass` — "Amass [subtype] N: put N +1/+1 counters on an Army you control.
 * It's also a [subtype]. If you don't control an Army, create a 0/0 black
 * [subtype] Army creature token first" (CR 701.47a). Params: `amount` (N),
 * `subtype` (the printed word — data, so "Amass Orcs" and "Amass Zombies" are
 * two rows of one primitive).
 *
 * WHICH Army, when you control several, is the controller's choice (CR
 * 701.47a "an Army you control"); one Army — the overwhelmingly common case —
 * is no question. "It's also a [subtype]" on an EXISTING Army is a type-adding
 * effect with no duration (CR 701.47b): the permanent's definition is replaced
 * by one carrying the subtype, which is the honest reading of an effect that
 * never ends — an Orc Army amassed as Zombies is a Zombie for the rest of the
 * game, for every lord and every "sacrifice a Zombie" cost.
 */
export const amass: EffectPrimitive = (ctx) => {
  const amount = intParam(ctx, COUNTER_PARAM.amount, 0);
  const subtype = strParam(ctx, COUNTER_PARAM.subtype);
  if (subtype === undefined) return;
  const armies = ctx.state.battlefield.filter(
    (permanent) =>
      permanent.controller === ctx.controller &&
      (permanent.def.subtypes ?? []).some((s) => s.toLowerCase() === ARMY_TOKEN.subtype.toLowerCase()),
  );
  let armyId: InstanceId | undefined;
  if (armies.length > 1) {
    const chosen = ctx.chooseCards({
      chooser: ctx.controller,
      prompt: `Amass ${subtype} ${amount}: choose the Army that grows`,
      candidates: armies.map(cardOption),
      min: 1,
      max: 1,
      valence: 'gain',
      fromZone: 'battlefield',
    });
    if (chosen === undefined) return; // parked — nothing mutated
    armyId = chosen[0];
  } else if (armies.length === 1) {
    armyId = armies[0]!.instanceId;
  }
  // MUTATE, only now.
  if (armyId === undefined) {
    const [created] = ctx.createTokens(
      tokenDef(`${subtype} ${ARMY_TOKEN.subtype}`, ARMY_TOKEN.power, ARMY_TOKEN.toughness, ARMY_TOKEN.colors, [subtype, ARMY_TOKEN.subtype], ['creature']),
      1,
    );
    armyId = created;
  }
  if (armyId === undefined) return; // a token doubler-refusal left nothing to grow
  const army = permanentById(ctx.state, armyId);
  if (!army) return;
  if (!(army.def.subtypes ?? []).some((s) => s.toLowerCase() === subtype.toLowerCase())) {
    army.def = { ...army.def, subtypes: [...(army.def.subtypes ?? []), subtype] };
  }
  putCountersOfKind(ctx, army, PLUS_ONE_COUNTER, amount);
};

// --- bolster (CR 701.37) -------------------------------------------------------------

/**
 * `bolster` — "choose a creature with the least toughness among creatures you
 * control and put N +1/+1 counters on it" (CR 701.37a). EFFECTIVE toughness
 * (counters and anthems included — the board the player is looking at); a tie
 * is the controller's choice, asked only when there is one to make.
 */
export const bolster: EffectPrimitive = (ctx) => {
  const amount = intParam(ctx, COUNTER_PARAM.amount, 0);
  if (amount <= 0) return;
  let least = Number.POSITIVE_INFINITY;
  const mine: { readonly permanent: CardInstance; readonly toughness: number }[] = [];
  for (const permanent of ctx.state.battlefield) {
    if (permanent.controller !== ctx.controller || !isCreature(permanent.def)) continue;
    const toughness = effectiveToughness(permanent, aggregateFor(ctx.state, permanent.instanceId));
    mine.push({ permanent, toughness });
    if (toughness < least) least = toughness;
  }
  const tied = mine.filter((entry) => entry.toughness === least).map((entry) => entry.permanent);
  if (tied.length === 0) return;
  let chosen: CardInstance | undefined = tied[0];
  if (tied.length > 1) {
    const answer = ctx.chooseCards({
      chooser: ctx.controller,
      prompt: `Bolster ${amount}: choose a creature with the least toughness`,
      candidates: tied.map(cardOption),
      min: 1,
      max: 1,
      valence: 'gain',
      fromZone: 'battlefield',
    });
    if (answer === undefined) return; // parked
    chosen = permanentById(ctx.state, answer[0] as InstanceId);
  }
  if (!chosen) return;
  putCountersOfKind(ctx, chosen, PLUS_ONE_COUNTER, amount);
};

// --- backup (CR 702.165) -------------------------------------------------------------

/**
 * `backup` — "put N +1/+1 counters on target creature. If that's another
 * creature, it gains the following abilities until end of turn" (CR 702.165a/b).
 * Params: `amount` (N), `keywords` (the granted abilities, as a `KeywordFlags`
 * — the compiler emits this primitive ONLY when every printed ability below
 * the backup line is expressible as one, so a card whose "following ability"
 * is an activated or triggered ability keeps reporting).
 *
 * The grant is the same continuous effect every "gains … until end of turn"
 * uses, so it expires at cleanup through the one path.
 */
export const backup: EffectPrimitive = (ctx) => {
  const target = firstPermanentTarget(ctx);
  if (!target || !isCreature(target.def)) return;
  putCountersOfKind(ctx, target, PLUS_ONE_COUNTER, intParam(ctx, COUNTER_PARAM.amount, 0));
  if (target.instanceId === ctx.source.instanceId) return; // "if that's ANOTHER creature"
  const keywords: KeywordFlags = keywordsParam(ctx);
  if (isEmptyKeywords(keywords)) return;
  ctx.addContinuousEffect({ target: target.instanceId, keywords, duration: 'endOfTurn' });
};

// --- explore (CR 701.42) -------------------------------------------------------------

/**
 * `explore` — "reveal the top card of your library. If it's a land card, put it
 * into your hand. Otherwise, put a +1/+1 counter on this creature, then you may
 * put the revealed card into your graveyard" (CR 701.42a). The graveyard
 * question is the surveil question in miniature and is answered by the same
 * pilot judgement (keep what is worth drawing). An empty library explores
 * nothing (CR 701.42c: the creature still "explored", but nothing is revealed
 * and no counter is put on — there was no nonland card).
 */
export const explore: EffectPrimitive = (ctx) => {
  const player = ctx.state.players[ctx.controller];
  const top = player.library[0];
  if (top === undefined) return;
  const self = selfIfCreature(ctx);
  if (top.def.types.includes('land')) {
    ctx.emit({ type: 'cardRevealed', player: ctx.controller, instanceId: top.instanceId, name: top.def.name });
    moveOwnedCard(ctx, ctx.controller, top.instanceId, 'library', 'hand');
    return;
  }
  // Ask BEFORE anything moves (ask-then-mutate): a parked answer re-runs this
  // from the top with the card still on top and no counter yet placed.
  const bin = ctx.confirm({
    chooser: ctx.controller,
    prompt: EXPLORE_GRAVEYARD_PROMPT,
    valence: 'neutral',
    context: EXPLORE_CHOICE_CONTEXT,
  });
  if (bin === undefined) return; // parked — nothing mutated
  ctx.emit({ type: 'cardRevealed', player: ctx.controller, instanceId: top.instanceId, name: top.def.name });
  if (self) putCountersOfKind(ctx, self, PLUS_ONE_COUNTER, intParam(ctx, COUNTER_PARAM.counter, EXPLORE_COUNTERS));
  if (bin) moveOwnedCard(ctx, ctx.controller, top.instanceId, 'library', 'graveyard');
};

/** The table `primitives.ts` merges into the registry. */
export const COUNTER_KEYWORD_PRIMITIVES: Readonly<Record<string, EffectPrimitive>> = Object.freeze({
  undyingReturn,
  modularMove,
  becomeRenowned,
  bloodthirstCounters,
  riotChoice,
  unleashChoice,
  devourChoice,
  createServos,
  amass,
  bolster,
  backup,
  explore,
});

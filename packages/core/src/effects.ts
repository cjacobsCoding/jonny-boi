/**
 * Effect-primitive registry SEAM. Core owns the *resolution machinery* and the
 * registry interface; package `cards` (§3.2) registers the actual primitives
 * (`dealDamage`, `drawCards`, `gainLife`, …) by id. The engine resolves a spell
 * by looking each `EffectRef` up here and invoking it against an `EffectContext`.
 *
 * Robustness rule: an unknown primitive id is a safe no-op + an `effectUnsupported`
 * event — never a crash. This lets `cards` ship a card whose mechanic core doesn't
 * yet model without breaking the engine.
 */

import type { CardInstance, GameState, PlayerId, InstanceId } from './state.js';
import { NO_COUNTERS } from './state.js';
import type { GameEvent } from './events.js';
import type { CardDefinition, EffectRef } from './card.js';
import { entersTapped } from './card.js';
import { attachTo } from './attachments.js';
import type { ContinuousDuration } from './internal/continuous.js';
import { applyControlChange } from './internal/continuous.js';
import { hasAnyReplacement, indexReplacements, replaceTokenCount } from './internal/replacement.js';
import type { ReplacementAbility } from './replacement.js';
import { addFloatingReplacement } from './internal/replacement.js';
import { applyEnteringDefense, applyEnteringLoyalty } from './internal/stats.js';
import type {
  ChooseModesRequest,
  ChooseValueRequest,
  ChoiceAnswer,
  ChoiceRequest,
  ConfirmRequest,
  PayLifeRequest,
  PayManaRequest,
  SelectCardsRequest,
  SelectPlayersRequest,
} from './choices.js';
import { defaultAnswerFor, normalizeChoiceRequest } from './choices.js';
import { createRng, shuffle } from './rng.js';

/**
 * The handle a primitive receives. It mutates the *draft* state in place (the
 * engine has already cloned at the action boundary) and pushes events. Targets,
 * if any, are passed through; for the MVP targeting is simple (resolved at cast).
 */
export interface EffectContext {
  /** The mutable draft game state. Primitives mutate this. */
  readonly state: GameState;
  /** The source spell/permanent instance running the effect. */
  readonly source: CardInstance;
  /** The controller of the source. */
  readonly controller: PlayerId;
  /** Pre-selected targets for this resolution (instance ids and/or players). */
  readonly targets: ReadonlyArray<InstanceId | PlayerId>;
  /** The effect's params blob (opaque to core, defined by the primitive). */
  readonly params: Readonly<Record<string, unknown>>;
  /**
   * The value chosen for the spell's `{X}` cost at cast time, or `undefined`
   * when this resolution has no X (a trigger, an ordinary spell). This is how
   * "deals X damage" reads the number that was actually paid for — including
   * AFTER the spell has left the stack, because the value rides the resolution
   * frame, not the stack object.
   */
  readonly xValue?: number;
  /** Whether the spell's kicker was paid at cast time ("if this spell was kicked"). */
  readonly kicked?: boolean;
  /**
   * How many times the spell's MULTIKICKER was paid at cast time — what "for
   * each time it was kicked" counts. `undefined` for a resolution with no
   * multikicker; a single (non-multi) kicker leaves this alone and is read
   * through {@link kicked}.
   */
  readonly kickCount?: number;
  /**
   * For a TRIGGERED ability: the player the event that set it off was about —
   * whose step began, who drew the card, who controlled the permanent that
   * entered or died. This is what a body's printed "**that player**" / "**them**"
   * points at.
   *
   * It is NOT `controller`, and the difference is the whole reason the field
   * exists: an "at the beginning of EACH player's draw step" ability resolves
   * under its source's controller on both players' turns, so a body reading
   * `controller` would make Howling Mine draw its own controller a card every
   * turn instead of drawing whoever's draw step it is.
   *
   * `undefined` for spells and for triggers whose event names no player — a
   * primitive asked for the triggering player then falls back to the controller,
   * matching how every other player param degrades.
   */
  readonly triggeringPlayer?: PlayerId;
  /** Append an event to the log. */
  emit(event: GameEvent): void;
  /**
   * Register a temporary continuous modification (DESIGN §3.9) on a permanent — the
   * channel a Giant-Growth-style pump or keyword grant uses. With `duration:
   * 'endOfTurn'` (the default) the modification is removed in the cleanup step, so
   * the buff genuinely wears off. Returns the new effect's id. This is the proper
   * replacement for modelling pumps as permanent +1/+1 counters.
   */
  addContinuousEffect(mod: ContinuousModRequest): number;
  /**
   * Register a FLOATING replacement/prevention effect (CR 614/615) — the channel
   * every fog uses ("prevent all combat damage that would be dealt this turn"),
   * and every shield ("prevent the next 3 damage that would be dealt to target
   * creature"). Returns the new record's id.
   *
   * `controller` defaults to the source's controller and is what every `'you'` /
   * `'opponent'` scope in the filter is read against; `duration` defaults to
   * `'endOfTurn'`, which is what every printed one-shot prints. A shield's
   * ceiling comes from `outcome.preventUpTo` and is consumed as it prevents.
   */
  addReplacementEffect(request: ReplacementEffectRequest): number;
  /**
   * Create a token permanent on the battlefield under `controller` (defaults to the
   * source's controller) from a token card definition. Returns the new instance id.
   * Tokens enter summoning-sick (unless they have haste) and trigger ETB like any
   * permanent. Used by token-makers (e.g. a cast-trigger that makes a 1/1).
   */
  createToken(def: CardDefinition, controller?: PlayerId): InstanceId;
  /**
   * Create an EMBLEM in `controller`'s command zone (defaults to the source's
   * controller) — what a planeswalker ultimate leaves behind. Returns the new
   * instance id.
   *
   * An emblem is NOT a permanent: it never touches the battlefield, so it emits
   * no `zoneChange` into it, sets off no enters-the-battlefield trigger, and can
   * never be targeted, destroyed, exiled or wiped. Its statics and triggers are
   * live from the moment it exists, for the rest of the game, because the
   * continuous layer and the trigger collector both read the command zone.
   */
  createEmblem(def: CardDefinition, controller?: PlayerId): InstanceId;
  /**
   * Attach the SOURCE of this effect to the permanent `hostInstanceId` — the
   * channel an Aura's "enters attached to the creature it targets" and an
   * Equipment's `Equip {N}` both use (see `attachments.ts`).
   *
   * Returns false (and says why in the log) when the host is not a legal one for
   * the source's printed `attachment` data, or when the source is not an
   * attachment at all. It never throws and never produces a board the state-based
   * actions would immediately have to undo.
   */
  attach(hostInstanceId: InstanceId): boolean;

  // --- player choice (choices.ts) ------------------------------------------------
  /**
   * Ask a player a question mid-resolution. Returns their answer, or `undefined`
   * when the question has been PARKED — in which case the primitive **must return
   * immediately without mutating anything**.
   *
   * The contract in one line: **ask everything first, then mutate.** When the
   * answer arrives the engine re-runs this same effect ref from the top, replaying
   * the questions already answered (they return their recorded answers without
   * stopping) until execution reaches the point it left off. Anything the
   * primitive did *before* an unanswered ask would therefore happen twice;
   * anything after an ask happens exactly once.
   *
   *     const chosen = ctx.chooseCards({ prompt: 'Discard a card', candidates });
   *     if (!chosen) return;          // parked — resume later, nothing mutated
   *     for (const id of chosen) discard(id);
   *
   * Prefer the typed helpers ({@link EffectContext.chooseCards} and friends); this
   * is the general form for generic code.
   */
  ask(request: ChoiceRequest): ChoiceAnswer | undefined;
  /**
   * Choose `min..max` cards. Returns the chosen ids — IN THE CHOSEN ORDER when the
   * request set `ordered` — or `undefined` if parked. An empty array is a real
   * answer ("chose none"), which is what a `min: 0` "you may" looks like when
   * declined; only `undefined` means "stop and come back".
   * `chooser` defaults to the source's controller.
   */
  chooseCards(request: ChoiceRequestArgs<SelectCardsRequest>): readonly InstanceId[] | undefined;
  /** Choose `min..max` players (defaults to exactly one). `undefined` ⇒ parked. */
  choosePlayers(request: ChoiceRequestArgs<SelectPlayersRequest>): readonly PlayerId[] | undefined;
  /**
   * Choose `min..max` of the listed modes; returns the chosen mode ids. Pair it
   * with {@link EffectContext.enqueueEffects} to run the chosen modes' effects —
   * that is all a modal card needs, and it needs no new primitive per card.
   */
  chooseModes(request: ChoiceRequestArgs<ChooseModesRequest>): readonly string[] | undefined;
  /** Ask a yes/no ("you may …"). `undefined` ⇒ parked; `false` ⇒ declined. */
  confirm(request: ChoiceRequestArgs<ConfirmRequest>): boolean | undefined;
  /**
   * Ask a player to pay a mana cost, or decline — the "**unless** its controller
   * pays {3}" half of a card. `undefined` ⇒ parked; `true` ⇒ **the mana has
   * already been spent** by the engine; `false` ⇒ they did not (or could not) pay,
   * and nothing was taken.
   *
   * `chooser` is usually NOT the source's controller: the player who has to pay is
   * the one being punished, so a countering spell passes the target's controller.
   *
   * The engine, not the effect, works out whether the cost is affordable and
   * performs the payment (tapping what it must). That division is deliberate — see
   * {@link PayManaAnswer.pay} — and it is why `true` means "paid", never "agreed
   * to pay".
   */
  payOrDecline(request: ChoiceRequestArgs<PayManaRequest>): boolean | undefined;
  /**
   * Ask a player to pay LIFE, or decline — a shockland's "you may pay 2 life"
   * asked mid-resolution (a fetch effect putting it onto the battlefield).
   * `undefined` ⇒ parked; `true` ⇒ **the life is already gone** (deducted by the
   * engine as it accepted the answer, for the same re-run reason as
   * {@link EffectContext.payOrDecline}); `false` ⇒ nothing was taken.
   */
  payLifeOrDecline(request: ChoiceRequestArgs<PayLifeRequest>): boolean | undefined;
  /**
   * NAME a value — a colour, a creature type, a card type, a player ("As ~
   * enters, choose a creature type"). `undefined` ⇒ parked; otherwise the named
   * option's `value`, or `NOTHING_CHOSEN` (`''`) when nothing was named, which is
   * a real answer and not a parked one.
   *
   * The caller stores the answer; see `recordChosenAsEntered` in `as-enters.ts`,
   * which is the one writer both entry paths use.
   */
  chooseValue(request: ChoiceRequestArgs<ChooseValueRequest>): string | undefined;
  /**
   * Schedule further effect refs to run inside THIS resolution, immediately after
   * the current one. The composition seam for modal spells and for any effect
   * whose follow-up depends on an answer — the extra effects resolve as part of
   * the same spell, may ask their own questions, and are not new stack objects.
   */
  enqueueEffects(refs: readonly EffectRef[]): void;
  /**
   * Shuffle a player's library using the game's seeded RNG (state-carried, so it
   * stays reproducible). The mandatory tail of every library search.
   */
  shuffleLibrary(player: PlayerId): void;
}

/**
 * The argument shape of the typed `choose*` helpers: the request without its
 * `kind` discriminator (the helper supplies it) and with `chooser` optional
 * (defaulting to the source's controller, which is right for every card except
 * the ones that deliberately hand the decision to the opponent).
 */
export type ChoiceRequestArgs<T extends ChoiceRequest> = Omit<T, 'kind' | 'chooser'> & { readonly chooser?: PlayerId };

/**
 * How an effect's questions reach the engine. Supplied by the resolution loop; an
 * `applyEffectRef` call made WITHOUT one (a direct call outside a resolution)
 * still works — every question is auto-answered with its safe default — so a
 * primitive is never the thing that crashes.
 */
export interface ChoiceChannel {
  /** Raise (or replay) one question. `undefined` ⇒ the resolution is now parked. */
  ask(request: ChoiceRequest): ChoiceAnswer | undefined;
  /** Insert effect refs to run next within the same resolution. */
  enqueueEffects(refs: readonly EffectRef[]): void;
  /** Shuffle a library from the state-carried seeded RNG. */
  shuffleLibrary(player: PlayerId): void;
}

/**
 * The data a primitive supplies to register a continuous effect. `target` defaults
 * to the source instance; `duration` defaults to `'endOfTurn'`.
 */
/**
 * What a primitive asks for when it registers a floating replacement/prevention
 * effect. The ability half is the same {@link ReplacementAbility} a card prints,
 * so a fog and a printed prevention static say the same thing in the same words;
 * only the lifetime fields are extra.
 */
export interface ReplacementEffectRequest extends ReplacementAbility {
  /** Whose "you" the filter's controller scopes mean. Defaults to the source's controller. */
  readonly controller?: PlayerId;
  /** Defaults to `'endOfTurn'`, which is what every printed one-shot prints. */
  readonly duration?: ContinuousDuration;
}

export interface ContinuousModRequest {
  readonly target?: InstanceId;
  readonly duration?: ContinuousDuration;
  readonly power?: number;
  readonly toughness?: number;
  readonly keywords?: CardDefinition['keywords'];
  /**
   * Take control of the target permanent for this effect's duration ("Gain
   * control of target creature until end of turn").
   *
   * Unlike the P/T and keyword fields, which are read THROUGH the continuous
   * layer at every use, a control change is applied to `CardInstance.controller`
   * directly when the effect is registered and reverted when it expires. See
   * `applyControlChange` in `internal/continuous.ts` for why that is the safe
   * shape here rather than an `effectiveController()` accessor.
   */
  readonly takeControl?: boolean;
}

/** A primitive: a small pure function mutating the draft via the context. */
export type EffectPrimitive = (ctx: EffectContext) => void;

/**
 * The registry `cards` populates. Core ships an empty default registry; the
 * `cards` package registers primitives at module load. Kept as an interface +
 * factory (not a global singleton) so tests and sims can construct isolated
 * registries — no shared mutable global.
 */
export interface EffectRegistry {
  register(id: string, primitive: EffectPrimitive): void;
  get(id: string): EffectPrimitive | undefined;
  has(id: string): boolean;
  readonly ids: readonly string[];
}

/** Create a fresh, isolated effect registry. */
export function createEffectRegistry(): EffectRegistry {
  const map = new Map<string, EffectPrimitive>();
  return {
    register(id, primitive) {
      map.set(id, primitive);
    },
    get(id) {
      return map.get(id);
    },
    has(id) {
      return map.has(id);
    },
    get ids() {
      return [...map.keys()];
    },
  };
}

/**
 * Run one effect ref against the draft. Resolves the primitive from the registry;
 * unknown ids emit `effectUnsupported` and are skipped (no throw). Pure w.r.t.
 * inputs other than the draft state it intentionally mutates.
 */
export function applyEffectRef(
  registry: EffectRegistry,
  ref: EffectRef,
  base: EffectContextBase,
  emit: (event: GameEvent) => void,
  targets: ReadonlyArray<InstanceId | PlayerId>,
  channel?: ChoiceChannel,
): void {
  const primitive = registry.get(ref.primitive);
  if (!primitive) {
    emit({ type: 'effectUnsupported', primitive: ref.primitive, sourceInstanceId: base.source.instanceId });
    return;
  }
  // Without a resolution to park into, a question cannot wait for anybody: answer
  // it with its safe default so a primitive called outside the resolution loop
  // still completes instead of silently doing nothing.
  const ask: ChoiceChannel['ask'] = channel
    ? (request) => channel.ask(request)
    : (request) => detachedAnswer(request, base.source.instanceId, emit);
  const ctx: EffectContext = {
    state: base.state,
    source: base.source,
    controller: base.controller,
    targets,
    params: ref.params ?? {},
    xValue: base.xValue,
    kicked: base.kicked,
    kickCount: base.kickCount,
    triggeringPlayer: base.triggeringPlayer,
    emit,
    addContinuousEffect(mod) {
      return addContinuousEffectToState(base.state, base.source.instanceId, base.controller, mod, emit);
    },
    addReplacementEffect(request) {
      return addFloatingReplacement(base.state, {
        event: request.event,
        applies: request.applies,
        outcome: request.outcome,
        sourceInstanceId: base.source.instanceId,
        controller: request.controller ?? base.controller,
        duration: request.duration ?? 'endOfTurn',
        ...(request.label !== undefined ? { label: request.label } : {}),
      });
    },
    createToken(def, controller) {
      return createTokenInState(base.state, def, controller ?? base.controller, emit);
    },
    createEmblem(def, controller) {
      return createEmblemInState(base.state, def, controller ?? base.controller, emit);
    },
    attach(hostInstanceId) {
      return attachTo(base.state, base.source, hostInstanceId, emit);
    },
    ask,
    chooseCards(request) {
      const answer = ask({ ...request, kind: 'selectCards', chooser: request.chooser ?? base.controller });
      return answer && answer.kind === 'selectCards' ? answer.instanceIds : undefined;
    },
    choosePlayers(request) {
      const answer = ask({ ...request, kind: 'selectPlayers', chooser: request.chooser ?? base.controller });
      return answer && answer.kind === 'selectPlayers' ? answer.players : undefined;
    },
    chooseModes(request) {
      const answer = ask({ ...request, kind: 'chooseModes', chooser: request.chooser ?? base.controller });
      return answer && answer.kind === 'chooseModes' ? answer.modeIds : undefined;
    },
    confirm(request) {
      const answer = ask({ ...request, kind: 'confirm', chooser: request.chooser ?? base.controller });
      return answer && answer.kind === 'confirm' ? answer.yes : undefined;
    },
    payOrDecline(request) {
      const answer = ask({ ...request, kind: 'payMana', chooser: request.chooser ?? base.controller });
      return answer && answer.kind === 'payMana' ? answer.pay : undefined;
    },
    payLifeOrDecline(request) {
      const answer = ask({ ...request, kind: 'payLife', chooser: request.chooser ?? base.controller });
      return answer && answer.kind === 'payLife' ? answer.pay : undefined;
    },
    chooseValue(request) {
      const answer = ask({ ...request, kind: 'chooseValue', chooser: request.chooser ?? base.controller });
      return answer && answer.kind === 'chooseValue' ? answer.value : undefined;
    },
    enqueueEffects(refs) {
      channel?.enqueueEffects(refs);
    },
    shuffleLibrary(player) {
      if (channel) channel.shuffleLibrary(player);
      else shuffleLibraryInState(base.state, player);
    },
  };
  primitive(ctx);
  emit({ type: 'effectApplied', primitive: ref.primitive, sourceInstanceId: base.source.instanceId });
}

/** The parts of an `EffectContext` the caller supplies; the rest are wired here. */
export type EffectContextBase = Pick<
  EffectContext,
  'state' | 'source' | 'controller' | 'xValue' | 'kicked' | 'kickCount' | 'triggeringPlayer'
>;

/**
 * Answer a question raised with no resolution to park into: normalise it, take the
 * safe default, and say so in the log. Never returns `undefined`, so a primitive
 * invoked this way runs straight through rather than parking forever.
 */
function detachedAnswer(
  request: ChoiceRequest,
  sourceInstanceId: InstanceId,
  emit: (event: GameEvent) => void,
): ChoiceAnswer | undefined {
  const choice = normalizeChoiceRequest(request, { id: 0, sourceInstanceId, sourceName: '' });
  if (!choice) {
    emit({ type: 'choiceAbandoned', sourceInstanceId, reason: `unknown choice kind '${String(request.kind)}'` });
    return undefined;
  }
  const answer = defaultAnswerFor(choice);
  emit({
    type: 'choiceAutoAnswered',
    choiceId: choice.id,
    chooser: choice.chooser,
    choiceKind: choice.kind,
    answer,
    reason: 'asked outside a resolution — took the default answer',
  });
  return answer;
}

/**
 * Shuffle a player's library from the state-carried RNG cursor, advancing it. The
 * cursor lives in state (not in a module-level generator), which is precisely what
 * makes a search-and-shuffle reproducible under a fixed seed.
 */
export function shuffleLibraryInState(state: GameState, player: PlayerId): void {
  const rng = createRng(state.rngState);
  state.players[player].library = shuffle(state.players[player].library, rng);
  state.rngState = rng.state;
}

/** Register a continuous modification on the draft state; returns its id. */
function addContinuousEffectToState(
  state: GameState,
  sourceInstanceId: InstanceId,
  controller: PlayerId,
  mod: ContinuousModRequest,
  emit: (event: GameEvent) => void,
): number {
  const id = state.nextInstanceId++;
  const duration: ContinuousDuration = mod.duration ?? 'endOfTurn';
  const target = mod.target ?? sourceInstanceId;

  // A control change is applied to the instance NOW (and recorded so expiry can
  // revert it); every other field is a layered read left to the index. The
  // resolving effect's controller is the stealer when the source is a SPELL —
  // a resolving Act of Treason is on the stack, not the battlefield, and
  // without this fallback its control change silently did nothing.
  const controlChange = mod.takeControl
    ? applyControlChange(state, target, sourceInstanceId, emit, controller)
    : undefined;

  state.continuous.push({
    id,
    targetInstanceId: target,
    sourceInstanceId,
    duration,
    power: mod.power,
    toughness: mod.toughness,
    keywords: mod.keywords,
    ...(controlChange ? { controlChange } : {}),
  });
  emit({ type: 'continuousEffectAdded', targetInstanceId: target, sourceInstanceId, duration });
  return id;
}

/**
 * Create an emblem in a player's command zone; returns its instance id.
 *
 * Deliberately NOT a battlefield entry, and the differences from
 * {@link createTokenInState} are the whole point of the object:
 *   - it lands in `players[controller].command`, so no removal path can reach it;
 *   - it emits `emblemCreated` and NO `zoneChange` into the battlefield, so no
 *     enters-the-battlefield trigger fires off it (an emblem does not "enter");
 *   - it carries none of the battlefield-only per-object state that would be
 *     meaningless on it, beyond the shape every `CardInstance` must have.
 *
 * The definition is stamped `isEmblem` here rather than trusted from the caller,
 * so an emblem is always identifiable as one however it was authored.
 */
function createEmblemInState(
  state: GameState,
  def: CardDefinition,
  controller: PlayerId,
  emit: (event: GameEvent) => void,
): InstanceId {
  const instanceId = state.nextInstanceId++;
  const emblem: CardInstance = {
    instanceId,
    def: def.isEmblem === true ? def : { ...def, isEmblem: true },
    controller,
    owner: controller,
    zone: 'command',
    tapped: false,
    summoningSick: false,
    damageMarked: 0,
    markedByDeathtouch: false,
    counters: NO_COUNTERS,
  };
  state.players[controller].command.push(emblem);
  emit({ type: 'emblemCreated', instanceId, controller, name: emblem.def.name });
  return instanceId;
}

/** Create a token permanent on the battlefield; returns its instance id. */
function createTokenInState(
  state: GameState,
  def: CardDefinition,
  controller: PlayerId,
  emit: (event: GameEvent) => void,
): InstanceId {
  // "If one or more tokens would be created under your control, twice that
  // many…" — the count is replaced HERE, at the one funnel every token-creating
  // primitive uses, so a doubler cannot be dodged by a new primitive. The extra
  // copies are created by the same inner loop rather than by re-entering the
  // funnel, so a doubled token can never double itself.
  const created = hasAnyReplacement(state)
    ? replaceTokenCount(state, indexReplacements(state), controller, def, 1, emit)
    : 1;
  let firstId: InstanceId | undefined;
  for (let n = 0; n < created; n++) {
    firstId = createOneTokenInState(state, def, controller, emit);
  }
  // Zero is only reachable through a hand-built prevention; a caller holding an
  // id contract still gets a real (if inert) token rather than a lie.
  return firstId ?? createOneTokenInState(state, def, controller, emit);
}

/** The unreplaced single-token entry `createTokenInState` loops over. */
function createOneTokenInState(
  state: GameState,
  def: CardDefinition,
  controller: PlayerId,
  emit: (e: GameEvent) => void,
): InstanceId {
  const instanceId = state.nextInstanceId++;
  const hasHaste = Boolean(def.keywords?.haste);
  const isCreatureToken = def.types.includes('creature');
  // CR 111.1: token-ness is a property of HOW the object was created, not of the
  // characteristics it was created with. Stamping it here rather than trusting
  // the caller is what makes it true of EVERY token the engine will ever make -
  // including one built from a definition that came from somewhere else, which is
  // exactly what a token COPY ("create a token that's a copy of target creature")
  // will be: `copiableDefOf` returns the copied CARD, which naturally carries no
  // token flag, and a token copy that answered "no" to "are you a token" would be
  // wrong for the nontoken filters and would never cease to exist.
  //
  // The definition is REPLACED, never written into: pool definitions are frozen
  // and shared, and this one may be a copy of one.
  const tokenDef: CardDefinition = def.isToken === true ? def : { ...def, isToken: true };
  const token: CardInstance = {
    instanceId,
    def: tokenDef,
    controller,
    owner: controller,
    zone: 'battlefield',
    // Tokens obey the same "enters tapped" rule as printed permanents — asked
    // through the one shared accessor so every entry path agrees.
    tapped: entersTapped(def),
    summoningSick: isCreatureToken ? !hasHaste : false,
    damageMarked: 0,
    markedByDeathtouch: false,
    counters: NO_COUNTERS,
    // Absent, not null — see `makeInstance` in engine.ts for why the unattached
    // shape must match the one `cloneInstance` produces.
  };
  state.battlefield.push(token);
  // A planeswalker token (or copy) enters with its printed loyalty, exactly as
  // the cast walker does — one shared helper so no entry path can disagree. A
  // battle token enters with its printed defense the same way.
  applyEnteringLoyalty(token, emit);
  applyEnteringDefense(token, emit);
  emit({ type: 'tokenCreated', instanceId, controller, name: tokenDef.name });
  // A token entering is a zoneChange into the battlefield — this is what ETB
  // triggers (its own and others') observe, keeping one mechanism for "enters".
  emit({ type: 'zoneChange', instanceId, from: 'stack', to: 'battlefield' });
  // Say it out loud for the event log — a replay folds entering permanents as
  // untapped, so a token that arrives tapped must emit the same `tapped` event
  // every other battlefield-entry path emits.
  if (token.tapped) emit({ type: 'tapped', instanceId });
  return instanceId;
}

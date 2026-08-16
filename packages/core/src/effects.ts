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
import type {
  ChooseModesRequest,
  ChoiceAnswer,
  ChoiceRequest,
  ConfirmRequest,
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
   * Create a token permanent on the battlefield under `controller` (defaults to the
   * source's controller) from a token card definition. Returns the new instance id.
   * Tokens enter summoning-sick (unless they have haste) and trigger ETB like any
   * permanent. Used by token-makers (e.g. a cast-trigger that makes a 1/1).
   */
  createToken(def: CardDefinition, controller?: PlayerId): InstanceId;
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
    emit,
    addContinuousEffect(mod) {
      return addContinuousEffectToState(base.state, base.source.instanceId, mod, emit);
    },
    createToken(def, controller) {
      return createTokenInState(base.state, def, controller ?? base.controller, emit);
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
export type EffectContextBase = Pick<EffectContext, 'state' | 'source' | 'controller'>;

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
  mod: ContinuousModRequest,
  emit: (event: GameEvent) => void,
): number {
  const id = state.nextInstanceId++;
  const duration: ContinuousDuration = mod.duration ?? 'endOfTurn';
  const target = mod.target ?? sourceInstanceId;

  // A control change is applied to the instance NOW (and recorded so expiry can
  // revert it); every other field is a layered read left to the index.
  const controlChange = mod.takeControl
    ? applyControlChange(state, target, sourceInstanceId, emit)
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

/** Create a token permanent on the battlefield; returns its instance id. */
function createTokenInState(
  state: GameState,
  def: CardDefinition,
  controller: PlayerId,
  emit: (event: GameEvent) => void,
): InstanceId {
  const instanceId = state.nextInstanceId++;
  const hasHaste = Boolean(def.keywords?.haste);
  const isCreatureToken = def.types.includes('creature');
  const token: CardInstance = {
    instanceId,
    def,
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
  emit({ type: 'tokenCreated', instanceId, controller, name: def.name });
  // A token entering is a zoneChange into the battlefield — this is what ETB
  // triggers (its own and others') observe, keeping one mechanism for "enters".
  emit({ type: 'zoneChange', instanceId, from: 'stack', to: 'battlefield' });
  // Say it out loud for the event log — a replay folds entering permanents as
  // untapped, so a token that arrives tapped must emit the same `tapped` event
  // every other battlefield-entry path emits.
  if (token.tapped) emit({ type: 'tapped', instanceId });
  return instanceId;
}

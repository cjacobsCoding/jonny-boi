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
import type { GameEvent } from './events.js';
import type { CardDefinition, EffectRef } from './card.js';
import type { ContinuousDuration } from './internal/continuous.js';

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
  base: Omit<EffectContext, 'params' | 'emit' | 'targets' | 'addContinuousEffect' | 'createToken'>,
  emit: (event: GameEvent) => void,
  targets: ReadonlyArray<InstanceId | PlayerId>,
): void {
  const primitive = registry.get(ref.primitive);
  if (!primitive) {
    emit({ type: 'effectUnsupported', primitive: ref.primitive, sourceInstanceId: base.source.instanceId });
    return;
  }
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
  };
  primitive(ctx);
  emit({ type: 'effectApplied', primitive: ref.primitive, sourceInstanceId: base.source.instanceId });
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
  state.continuous.push({
    id,
    targetInstanceId: target,
    sourceInstanceId,
    duration,
    power: mod.power,
    toughness: mod.toughness,
    keywords: mod.keywords,
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
    tapped: false,
    summoningSick: isCreatureToken ? !hasHaste : false,
    damageMarked: 0,
    markedByDeathtouch: false,
    counters: {},
  };
  state.battlefield.push(token);
  emit({ type: 'tokenCreated', instanceId, controller, name: def.name });
  // A token entering is a zoneChange into the battlefield — this is what ETB
  // triggers (its own and others') observe, keeping one mechanism for "enters".
  emit({ type: 'zoneChange', instanceId, from: 'stack', to: 'battlefield' });
  return instanceId;
}

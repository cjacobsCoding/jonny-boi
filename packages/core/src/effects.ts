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
import type { EffectRef } from './card.js';

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
  base: Omit<EffectContext, 'params' | 'emit' | 'targets'>,
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
  };
  primitive(ctx);
  emit({ type: 'effectApplied', primitive: ref.primitive, sourceInstanceId: base.source.instanceId });
}

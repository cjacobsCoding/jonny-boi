/**
 * Runtime glue between the event log and the triggered-ability machinery
 * (triggers.ts). The engine does NOT hard-code any card: instead, as events are
 * emitted, this collector scans the permanents currently on the battlefield for
 * declared triggers whose condition matches the event, and queues them. When the
 * engine reaches a stable point (about to grant priority), it flushes the queue —
 * ordering simultaneous triggers by APNAP — onto the stack as `TriggeredStackObject`s.
 *
 * Why an emit-interceptor seam: every meaningful mutation already emits a typed
 * event. Wrapping `emit` lets triggers observe state changes without the core loop
 * special-casing draws, casts, combat, deaths, etc. — one mechanism, no per-feature
 * branches in the turn machine.
 *
 * Determinism: the queue preserves emission order; APNAP ordering at flush time is a
 * stable sort keyed by controller (active first), then battlefield position, then
 * ability index — so the same seed always produces the same trigger order.
 */

import type { GameEvent } from '../events.js';
import type { GameState, InstanceId } from '../state.js';
import type { PendingTrigger, TriggerSource } from '../triggers.js';
import { matchTriggers, orderPendingTriggers } from '../triggers.js';

/**
 * A trigger collector bound to a draft state and a base emit. Call `emit` exactly
 * as before; matched triggers accumulate in an internal queue. Call `flush` to move
 * the queue onto the stack (APNAP-ordered) — it reports how many it moved, which is
 * all the engine needs to decide whether priority resets.
 *
 * One collector is built per action, so its own footprint is on the hot path: it
 * holds exactly two closures and allocates its queue, its known-source map and the
 * scan list only if something actually needs them.
 */
export interface TriggerCollector {
  /** Emit an event AND scan it for triggers (the wrapped emit the engine uses). */
  emit(event: GameEvent): void;
  /** Move queued triggers onto the stack in APNAP order. Returns count flushed. */
  flush(): number;
}

/**
 * Create a collector wrapping `baseEmit`. The collector emits each event to the log
 * first, then matches it against the battlefield's triggers and queues any that fire.
 *
 * Note on `dies`/`leaves`: those triggers reference a creature that has just left the
 * battlefield, so it is no longer in `state.battlefield` when the event is scanned.
 * We therefore also retain a snapshot of triggerful permanents seen this action, so a
 * leaves/dies trigger on the departing permanent itself still fires ("last known
 * information"). This matches MTG's leave-the-battlefield trigger handling.
 */
export function createTriggerCollector(state: GameState, baseEmit: (e: GameEvent) => void): TriggerCollector {
  // Allocated on the first trigger that actually fires — most actions set nothing
  // off, and this is built once per action for every action of every game.
  let queue: PendingTrigger[] | null = null;
  // Remember triggerful permanents that have been on the battlefield this action,
  // so leave/dies triggers on the departing permanent still resolve. Created lazily:
  // a board with no triggerful permanent — an opening hand, a land-only turn, and
  // most of the sim's hot path — never allocates the map or the snapshot at all.
  let seenSources: Map<InstanceId, TriggerSource> | null = null;
  // A reusable array view of `seenSources`, rebuilt only when the set changes.
  // `matchTriggers` wants a list, and spreading the map's values on EVERY emitted
  // event was one array plus one `TriggerSource` per triggerful permanent, several
  // times per action, for a scan that almost never matches anything.
  let snapshot: TriggerSource[] | null = null;

  /**
   * Fold the currently-on-battlefield triggerful permanents into the known set.
   *
   * Runs per event, so it must not allocate when nothing has changed — which is
   * the normal case. A permanent already known under the same controller is left
   * exactly as it is: its name and abilities come from the immutable definition,
   * so `controller` is the only field that can go stale. First-seen order (which
   * is what `matchTriggers` scans in) is preserved, because re-`set`ting an
   * existing key would not move it and we no longer re-set at all.
   */
  const rememberSources = (): void => {
    const battlefield = state.battlefield;
    for (let i = 0; i < battlefield.length; i++) {
      const inst = battlefield[i] as (typeof battlefield)[number];
      const triggers = inst.def.triggers;
      if (triggers === undefined || triggers.length === 0) continue;
      const known = seenSources?.get(inst.instanceId);
      if (known !== undefined && known.controller === inst.controller) continue;
      (seenSources ??= new Map()).set(inst.instanceId, {
        instanceId: inst.instanceId,
        controller: inst.controller,
        name: inst.def.name,
        triggers,
      });
      snapshot = null;
    }
  };
  rememberSources();

  const emit = (event: GameEvent): void => {
    baseEmit(event);
    // Refresh the known-source set so a permanent that entered earlier in this same
    // action can trigger on a later event.
    rememberSources();
    // Perf early-exit: with no triggerful permanent ever seen this action, no event
    // can match — skip the scan entirely. Behavior is unchanged: matchTriggers over
    // an empty source list always returns nothing.
    if (seenSources === null) return;
    snapshot ??= [...seenSources.values()];
    const matched = matchTriggers(snapshot, event);
    if (matched.length === 0) return;
    if (queue === null) queue = [];
    for (const m of matched) queue.push(m);
  };

  const flush = (): number => {
    if (queue === null || queue.length === 0) return 0;
    const batch = queue.splice(0, queue.length);
    const order = new Map<InstanceId, number>();
    for (let i = 0; i < state.battlefield.length; i++) {
      order.set((state.battlefield[i] as { instanceId: InstanceId }).instanceId, i);
    }
    const ordered = orderPendingTriggers(batch, state.activePlayer, order);
    for (const pending of ordered) {
      const label = pending.ability.label ?? `${pending.ability.condition.on} trigger`;
      state.stack.push({
        kind: 'trigger',
        instanceId: state.nextInstanceId++,
        sourceInstanceId: pending.sourceInstanceId,
        controller: pending.controller,
        effects: pending.ability.effects,
        targets: [],
        label,
      });
      baseEmit({
        type: 'triggerPutOnStack',
        sourceInstanceId: pending.sourceInstanceId,
        controller: pending.controller,
        label,
      });
    }
    return ordered.length;
  };

  return { emit, flush };
}

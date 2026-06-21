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
 * the queue onto the stack (APNAP-ordered). `hasPending` lets the engine know
 * whether a flush is needed before granting priority.
 */
export interface TriggerCollector {
  /** Emit an event AND scan it for triggers (the wrapped emit the engine uses). */
  emit(event: GameEvent): void;
  /** Whether any triggers are queued awaiting a flush. */
  hasPending(): boolean;
  /** Move queued triggers onto the stack in APNAP order. Returns count flushed. */
  flush(): number;
}

/** Build the list of trigger sources from the current battlefield. */
function battlefieldTriggerSources(state: GameState): TriggerSource[] {
  const sources: TriggerSource[] = [];
  for (const inst of state.battlefield) {
    const triggers = inst.def.triggers;
    if (!triggers || triggers.length === 0) continue;
    sources.push({
      instanceId: inst.instanceId,
      controller: inst.controller,
      name: inst.def.name,
      triggers,
    });
  }
  return sources;
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
  const queue: PendingTrigger[] = [];
  // Remember triggerful permanents that have been on the battlefield this action,
  // so leave/dies triggers on the departing permanent still resolve.
  const seenSources = new Map<InstanceId, TriggerSource>();

  const rememberSources = () => {
    for (const src of battlefieldTriggerSources(state)) {
      seenSources.set(src.instanceId, src);
    }
  };
  rememberSources();

  const emit = (event: GameEvent): void => {
    baseEmit(event);
    // Refresh the known-source set so a permanent that entered earlier in this same
    // action can trigger on a later event.
    rememberSources();
    const matched = matchTriggers([...seenSources.values()], event);
    for (const m of matched) queue.push(m);
  };

  const flush = (): number => {
    if (queue.length === 0) return 0;
    const batch = queue.splice(0, queue.length);
    const order = new Map<InstanceId, number>();
    state.battlefield.forEach((c, i) => order.set(c.instanceId, i));
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

  return {
    emit,
    hasPending: () => queue.length > 0,
    flush,
  };
}

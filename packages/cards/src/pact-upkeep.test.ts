/**
 * THE PACT BILL — "At the beginning of your next upkeep, pay {3}{U}{U}. If you
 * don't, you lose the game." (Pact of Negation and its cycle.)
 *
 * The whole card is the drawback, so the assertions are about the drawback:
 *
 *  - the bill is a DELAYED ability (CR 603.7) scheduled as the free spell
 *    resolves — a Pact is an instant sitting in the graveyard when the upkeep
 *    comes, so nothing on the battlefield could carry the trigger;
 *  - an UNPAID bill loses the game. A "you may"-shaped reading, or a bill that
 *    silently no-ops when the pool is empty, is a free counterspell — the
 *    single most broken thing this compiler could ship;
 *  - a PAID bill does nothing at all.
 */

import { describe, expect, it } from 'vitest';
import type { CardDefinition, GameState, PlayerId } from '@jonny-boi/core';
import { buildRegistry } from './pool.js';

/** Run one primitive against a hand-built state, capturing what it did. */
function runPrimitive(
  id: string,
  params: Record<string, unknown>,
  hooks: Partial<{
    payOrDecline: (request: unknown) => boolean | undefined;
    createDelayedTrigger: (request: unknown) => number;
    enqueueEffects: (refs: Array<{ primitive: string }>) => void;
  }>,
): void {
  const registry = buildRegistry();
  const primitive = registry.get(id);
  expect(primitive, `${id} must be registered`).toBeDefined();
  const state = {
    nextInstanceId: 100,
    battlefield: [],
    stack: [],
    continuous: [],
    players: {
      A: { life: 20, hand: [], library: [], graveyard: [], exile: [], command: [], manaPool: {} },
      B: { life: 20, hand: [], library: [], graveyard: [], exile: [], command: [], manaPool: {} },
    },
  } as unknown as GameState;
  primitive!({
    state,
    source: { instanceId: 1, def: { id: 'pact', name: 'Pact of Negation', types: ['instant'] } as CardDefinition },
    controller: 'A' as PlayerId,
    targets: [],
    params,
    emit: () => {},
    ask: () => undefined,
    payOrDecline: hooks.payOrDecline ?? (() => true),
    createDelayedTrigger: hooks.createDelayedTrigger ?? (() => 1),
    enqueueEffects: hooks.enqueueEffects ?? (() => {}),
  } as never);
}

describe('the Pact schedules its bill as a delayed ability', () => {
  it('schedules "your next upkeep" with the payment as the BODY', () => {
    let scheduled: { condition?: { on?: string; who?: string }; effects?: Array<{ primitive: string; params?: Record<string, unknown> }> } | undefined;
    runPrimitive(
      'scheduleDelayedPayment',
      { cost: { generic: 3, U: 2 }, effects: [{ primitive: 'loseTheGame' }], label: 'pact bill' },
      {
        createDelayedTrigger: (request) => {
          scheduled = request as typeof scheduled;
          return 1;
        },
      },
    );
    expect(scheduled?.condition).toEqual({ on: 'upkeep', who: 'you' });
    const body = scheduled?.effects?.[0];
    expect(body?.primitive).toBe('payManaOrElse');
    expect(body?.params?.cost).toEqual({ generic: 3, U: 2 });
    expect(body?.params?.effects).toEqual([{ primitive: 'loseTheGame' }]);
  });

  it('schedules NOTHING when the consequence is missing — never a free spell', () => {
    let scheduledCount = 0;
    runPrimitive(
      'scheduleDelayedPayment',
      { cost: { generic: 3, U: 2 }, effects: [] },
      { createDelayedTrigger: () => (scheduledCount += 1) },
    );
    expect(scheduledCount).toBe(0);
  });
});

describe('the bill itself', () => {
  it('DECLINING runs the consequence', () => {
    const ran: string[] = [];
    runPrimitive(
      'payManaOrElse',
      { cost: { generic: 3, U: 2 }, effects: [{ primitive: 'loseTheGame' }] },
      {
        payOrDecline: () => false,
        enqueueEffects: (refs) => void ran.push(...refs.map((r) => r.primitive)),
      },
    );
    expect(ran).toEqual(['loseTheGame']);
  });

  it('PAYING runs nothing', () => {
    const ran: string[] = [];
    runPrimitive(
      'payManaOrElse',
      { cost: { generic: 3, U: 2 }, effects: [{ primitive: 'loseTheGame' }] },
      {
        payOrDecline: () => true,
        enqueueEffects: (refs) => void ran.push(...refs.map((r) => r.primitive)),
      },
    );
    expect(ran).toEqual([]);
  });

  it('a PARKED payment question mutates nothing (ask-then-mutate)', () => {
    const ran: string[] = [];
    runPrimitive(
      'payManaOrElse',
      { cost: { generic: 3, U: 2 }, effects: [{ primitive: 'loseTheGame' }] },
      {
        payOrDecline: () => undefined,
        enqueueEffects: (refs) => void ran.push(...refs.map((r) => r.primitive)),
      },
    );
    expect(ran).toEqual([]);
  });
});

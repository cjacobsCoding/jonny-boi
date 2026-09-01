/**
 * "THAT MUCH" — a trigger body reading the SIZE of the event that set it off
 * (Exquisite Blood, Vito, Sanguine Bond, Mindcrank).
 *
 * The amount travels with the ability (`triggeringAmount`), because the body is
 * read as the trigger RESOLVES — long after the event is gone. Reading a life
 * TOTAL instead would be wrong in the ordinary case: a player who gained 3 and
 * then lost 1 has a total that answers neither question.
 *
 * Also pinned here: life LOSS is `lifeChanged` with a negative delta, so DAMAGE
 * counts as life loss (CR 118.3) — which is exactly what Exquisite Blood means
 * and what a `gainLife`-mirror event would have missed.
 */

import { describe, expect, it } from 'vitest';
import {
  applyAction,
  createGame,
  DEFAULT_RULES,
  defaultAnswerFor,
  type CardDefinition,
  type GameAction,
  type GameState,
  type PlayerId,
} from './index.js';
import { createEffectRegistry, type EffectRegistry } from './effects.js';
import { deckOf, giveHand, landDef } from './test-fixtures.js';

const ISLAND = landDef('Island', 'U');

/** Exquisite Blood's shape: whenever an opponent loses life, you gain that much. */
const BLOOD: CardDefinition = {
  id: 'blood',
  name: 'Test Blood',
  types: ['enchantment'],
  triggers: [
    {
      condition: { on: 'lifeLoss', who: 'opponent' },
      effects: [{ primitive: 'gainLife', params: { amount: { countOf: 'triggeringAmount' } } }],
      label: 'an opponent loses life: you gain that much',
    },
  ],
};

/** A sorcery-speed way to make the opponent lose a known amount. */
const DRAIN: CardDefinition = {
  id: 'drain',
  name: 'Test Drain',
  types: ['sorcery'],
  cost: { generic: 0 },
  effects: [{ primitive: 'loseLife', params: { amount: 3, whichPlayer: 'opponent' } }],
};

function act(state: GameState, action: GameAction, reg: EffectRegistry): GameState {
  const r = applyAction(state, action, DEFAULT_RULES, reg);
  const rejected = r.events.find((e) => e.type === 'actionRejected');
  if (rejected) throw new Error(`unexpected rejection: ${(rejected as { reason: string }).reason}`);
  return r.state;
}

describe('a trigger body that reads "that much"', () => {
  it('gains exactly what the opponent lost — not a life total, not a constant', () => {
    const reg = createEffectRegistry();
    // The pool's real primitives are not needed: only the two this test names.
    reg.register('loseLife', (ctx) => {
      const amount = ctx.params.amount as number;
      const victim = ctx.params.whichPlayer === 'opponent' ? (ctx.controller === 'A' ? 'B' : 'A') : ctx.controller;
      const seat = ctx.state.players[victim];
      seat.life -= amount;
      ctx.emit({ type: 'lifeChanged', player: victim, delta: -amount, to: seat.life });
    });
    reg.register('gainLife', (ctx) => {
      // Read through the SAME derived descriptor the compiler emits.
      const raw = ctx.params.amount as { countOf?: string } | number;
      const amount = typeof raw === 'number' ? raw : (ctx.triggeringAmount ?? 0);
      const seat = ctx.state.players[ctx.controller];
      seat.life += amount;
      ctx.emit({ type: 'gainLife', player: ctx.controller, amount });
    });

    const { state } = createGame({
      seed: 5,
      decks: { A: deckOf(ISLAND, 40), B: deckOf(ISLAND, 40) },
      registry: reg,
    });
    // Placed directly, so the test position never depends on a shuffle.
    const [drainCard] = giveHand(state, 'A', [DRAIN]);
    state.battlefield.push({
      instanceId: state.nextInstanceId++,
      def: BLOOD,
      controller: 'A',
      owner: 'A',
      zone: 'battlefield',
      tapped: false,
      summoningSick: false,
      damageMarked: 0,
      markedByDeathtouch: false,
      counters: {},
    });

    let s = state;
    const startingLife = s.players.A.life;
    // Walk to A's main phase, answering anything asked on the way.
    let guard = 0;
    while (s.step !== 'precombatMain' && !s.gameOver && guard++ < 400) {
      const q = s.pendingChoice;
      s = q
        ? act(s, { kind: 'answerChoice', player: q.chooser, choiceId: q.id, answer: defaultAnswerFor(q) }, reg)
        : act(s, { kind: 'passPriority', player: s.priorityPlayer }, reg);
    }
    s = act(s, { kind: 'castSpell', player: 'A' as PlayerId, instanceId: drainCard!.instanceId }, reg);
    // Resolve the spell and then the trigger it set off.
    guard = 0;
    while (s.stack.length > 0 && !s.gameOver && guard++ < 60) {
      const q = s.pendingChoice;
      s = q
        ? act(s, { kind: 'answerChoice', player: q.chooser, choiceId: q.id, answer: defaultAnswerFor(q) }, reg)
        : act(s, { kind: 'passPriority', player: s.priorityPlayer }, reg);
    }

    expect(s.players.B.life).toBe(DEFAULT_RULES.startingLife - 3);
    // Gained EXACTLY the 3 that were lost.
    expect(s.players.A.life).toBe(startingLife + 3);
  });
});

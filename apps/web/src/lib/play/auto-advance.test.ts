/**
 * Auto-advancing empty priority windows.
 *
 * MTG hands both players priority in every step. In pass-and-play each transfer
 * of control costs a physical device handoff, so a window where the player can do
 * NOTHING is not neutral — it stops the game to ask a question with one answer.
 * Un-skipped, a single turn cost ten-plus handoffs (upkeep, draw, every combat
 * step, end step), which is what made the mode miserable to actually play.
 *
 * These tests pin both halves of the fix: empty windows are skipped, and windows
 * with a real decision are NEVER skipped.
 */
import { describe, expect, it } from 'vitest';
import { buildRegistry, loadCardPool } from '@jonny-boi/cards';
import { createGame, type CardDefinition, type CardInstance, type GameState, type PlayerId } from '@jonny-boi/core';
import { GameSession } from './session.js';
import { HOTSEAT_CONFIG } from './play-config.js';

const SEAT_NAMES: Readonly<Record<PlayerId, string>> = { A: 'Alice', B: 'Bob' };
const pool = loadCardPool({ onWarn: () => {} });
const registry = buildRegistry();

function card(name: string): CardDefinition {
  const found = pool.getByName(name);
  if (!found) throw new Error(`no pool card named "${name}"`);
  return found;
}

/** A fresh game, optionally sculpted, as a session. */
function session(build?: (state: GameState) => void): GameSession {
  const forest = card('Forest');
  const created = createGame({
    seed: 9,
    decks: {
      A: { cards: Array.from({ length: 40 }, () => forest) },
      B: { cards: Array.from({ length: 40 }, () => forest) },
    },
    registry,
  });
  build?.(created.state);
  return GameSession.fromCreated(created, registry, SEAT_NAMES);
}

function place(state: GameState, def: CardDefinition, controller: PlayerId): CardInstance {
  const inst: CardInstance = {
    instanceId: state.nextInstanceId++,
    def,
    controller,
    owner: controller,
    zone: 'battlefield',
    tapped: false,
    summoningSick: false,
    damageMarked: 0,
    markedByDeathtouch: false,
    counters: {},
  };
  state.battlefield.push(inst);
  return inst;
}

describe('auto-advancing priority', () => {
  it('carries a fresh game from upkeep to the first real decision', () => {
    const start = session();
    expect(start.state.step).toBe('upkeep');
    // At upkeep with an empty board there is nothing any player can do.
    expect(start.hasMeaningfulChoice()).toBe(false);

    const advanced = start.autoAdvancePriority();

    // It stops at the main phase, where a land can actually be played.
    expect(advanced.state.step).toBe('precombatMain');
    expect(advanced.hasMeaningfulChoice()).toBe(true);
    expect(advanced.playableLands().length).toBeGreaterThan(0);
  });

  it('does not skip a window where the player has a decision', () => {
    const start = session().autoAdvancePriority();
    // Already at a meaningful window: advancing must be a no-op, and must return
    // the SAME object so the caller's setState cannot loop.
    expect(start.autoAdvancePriority()).toBe(start);
  });

  it('does not skip the attack declaration when a creature can attack', () => {
    const start = session((state) => {
      place(state, card('Goblin Guide'), 'A'); // 2/2, ready to attack
    });
    // Walk forward from upkeep; the first stop is the main phase (land in hand).
    let s = start.autoAdvancePriority();
    expect(s.state.step).toBe('precombatMain');

    // Pass out of the main phase; auto-advance must STOP at declare-attackers
    // rather than skipping the attack.
    s = s.passPriority().session.autoAdvancePriority();
    expect(s.state.step).toBe('declareAttackers');
    expect(s.hasMeaningfulChoice()).toBe(true);
  });

  it('never makes more passes than its bound, so it cannot spin the UI', () => {
    // An empty-handed board has long stretches with nothing to do, so this walks
    // many windows. Capped at two passes, it must stop exactly where two manual
    // passes would land — the bound is a hard limit, not a suggestion.
    const start = session((state) => {
      state.players.A.hand = [];
      state.players.B.hand = [];
    });
    expect(start.hasMeaningfulChoice()).toBe(false);

    const bounded = start.autoAdvancePriority(2);
    const manual = start.passPriority().session.passPriority().session;

    expect(bounded.state.turnNumber).toBe(manual.state.turnNumber);
    expect(bounded.state.step).toBe(manual.state.step);
    expect(bounded.priorityPlayer).toBe(manual.priorityPlayer);
  });

  it('uses the configured bound by default', () => {
    // Pin that the safety cap is the named config value, not an inline literal.
    expect(HOTSEAT_CONFIG.maxAutoAdvanceSteps).toBeGreaterThan(0);
    const start = session();
    const where = (s: GameSession) => ({ turn: s.state.turnNumber, step: s.state.step, priority: s.priorityPlayer });
    expect(where(start.autoAdvancePriority())).toEqual(
      where(start.autoAdvancePriority(HOTSEAT_CONFIG.maxAutoAdvanceSteps)),
    );
  });
});

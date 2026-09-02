/**
 * §3.67 — the AI co-pilot suggests the move the PILOT would make, and explains
 * it in the pilot's own words.
 *
 * The properties worth pinning are the ones that make the feature trustworthy
 * rather than decorative:
 *  - the suggested action is one the engine would actually accept;
 *  - the reason comes from the pilot's trace, so it describes the decision that
 *    was made rather than being prose written about it afterwards;
 *  - it advises only on the viewer's own decision, never the opponent's;
 *  - it never mutates the game.
 */
import { describe, expect, it } from 'vitest';
import { createRng } from '@jonny-boi/core';
import { createDefaultAiRegistry, DEFAULT_PILOT_ID, HEURISTIC_PILOT_ID } from '@jonny-boi/ai';
import { GameSession } from './session.js';
import { startHotseatGame } from './setup.js';
import { SAMPLE_DECKS } from '@jonny-boi/sim';
import { suggestMove, suggestionTarget, suggestionText } from './copilot.js';
import type { DeckChoice } from './setup.js';

const NAMES = { A: 'Player 1', B: 'Computer' } as const;

function choice(name: string): DeckChoice {
  const deck = SAMPLE_DECKS.find((d) => d.name === name);
  if (!deck) throw new Error(`no sample deck "${name}"`);
  return { source: 'sample', deck };
}

function freshGame(seed = 0xc0ffee): GameSession {
  const started = startHotseatGame({
    choiceA: choice('Selesnya Blink'),
    choiceB: choice('Mono-Red Aggro'),
    seed,
    startingPlayer: 'A',
  });
  if (!started.ok) throw new Error('setup failed');
  return GameSession.fromCreated(started.game.created, started.game.registry, NAMES);
}

const registry = createDefaultAiRegistry();
const heuristic = registry.getPilot(HEURISTIC_PILOT_ID);
if (!heuristic) throw new Error('no heuristic pilot');

describe('the co-pilot suggests a move the engine would accept', () => {
  it('suggests something legal for the seat that holds priority', () => {
    const session = freshGame();
    const viewer = session.state.priorityPlayer;
    const suggestion = suggestMove(session, viewer, heuristic, createRng(1));
    expect(suggestion).not.toBeNull();
    if (!suggestion) return;
    // "Legal" is not a claim to take on trust: submit it.
    const result = session.submit(suggestion.action);
    expect(result.rejected).toBeNull();
  });

  it('explains itself in the PILOT’s words, not this module’s', () => {
    const session = freshGame();
    const suggestion = suggestMove(session, session.state.priorityPlayer, heuristic, createRng(1));
    expect(suggestion?.reason, 'the heuristic traces a reason for every decision').toBeTruthy();
    // The reason is whatever the pilot said; this module only prefixes the move.
    const text = suggestionText(suggestion!, () => 'Forest');
    expect(text).toContain(suggestion!.reason!);
  });

  it('offers no advice on the opponent’s decision', () => {
    const session = freshGame();
    const other = session.state.priorityPlayer === 'A' ? 'B' : 'A';
    expect(suggestMove(session, other, heuristic, createRng(1))).toBeNull();
  });

  it('never changes the game it is asked about', () => {
    const session = freshGame();
    const before = JSON.stringify({
      turn: session.state.turnNumber,
      step: session.state.step,
      hand: session.state.players.A.hand.map((c) => c.instanceId),
      life: session.state.players.A.life,
    });
    suggestMove(session, session.state.priorityPlayer, heuristic, createRng(1));
    const after = JSON.stringify({
      turn: session.state.turnNumber,
      step: session.state.step,
      hand: session.state.players.A.hand.map((c) => c.instanceId),
      life: session.state.players.A.life,
    });
    expect(after).toBe(before);
  });

  it('recomputes rather than ageing: a later state gets its own answer', () => {
    let session = freshGame();
    const first = suggestMove(session, session.state.priorityPlayer, heuristic, createRng(1));
    expect(first).not.toBeNull();
    session = session.submit(first!.action).session;
    const second = suggestMove(session, session.state.priorityPlayer, heuristic, createRng(1));
    // Either the seat changed hands (no advice) or the advice is freshly derived
    // from the new state — what must NOT happen is the old action being reused.
    if (second) expect(second.action).not.toBe(first!.action);
  });

  it('says nothing once the game is over', () => {
    const session = freshGame();
    const loser = session.state.priorityPlayer;
    const conceded = session.concede(loser, loser === 'A' ? 'B' : 'A');
    expect(suggestMove(conceded, conceded.state.priorityPlayer, heuristic, createRng(1))).toBeNull();
  });

  it('works with the default pilot too, not just the heuristic', () => {
    const pilot = registry.getPilot(DEFAULT_PILOT_ID);
    expect(pilot).toBeTruthy();
    const session = freshGame();
    const suggestion = suggestMove(session, session.state.priorityPlayer, pilot!, createRng(1));
    expect(suggestion).not.toBeNull();
    if (suggestion) expect(session.submit(suggestion.action).rejected).toBeNull();
  });
});

describe('where the hint points', () => {
  it('points at the card for the actions that have one', () => {
    expect(suggestionTarget({ kind: 'playLand', player: 'A', instanceId: 7 } as never)).toEqual({
      kind: 'card',
      instanceId: 7,
    });
    expect(suggestionTarget({ kind: 'castSpell', player: 'A', instanceId: 9, targets: [] } as never)).toEqual({
      kind: 'card',
      instanceId: 9,
    });
  });

  it('points at the action bar for the moves whose control lives there', () => {
    expect(suggestionTarget({ kind: 'passPriority', player: 'A' } as never)).toEqual({ kind: 'bar' });
    expect(suggestionTarget({ kind: 'declareAttackers', player: 'A', attackers: [] } as never)).toEqual({
      kind: 'bar',
    });
  });

  it('names an unfamiliar action rather than hiding it', () => {
    const text = suggestionText({ action: { kind: 'somethingNew' } as never, reason: null }, () => 'x');
    expect(text).toBe('somethingNew');
  });

  it('reads as advice even when the pilot offered no reason', () => {
    const text = suggestionText(
      { action: { kind: 'playLand', player: 'A', instanceId: 3 } as never, reason: null },
      () => 'Forest',
    );
    expect(text).toBe('Play Forest');
  });
});

/**
 * The online client's half of the player-choice loop, tested against views produced
 * by the REAL masking function rather than hand-written fixtures — so a change to
 * what the server sends breaks these tests instead of silently changing the UI.
 *
 * The load-bearing case is the non-chooser: it must end up with a waiting line and
 * NO renderable question, because rendering one would mean the client held
 * candidates it was never entitled to.
 */
import type { GameState, PendingChoice, PlayerId } from '@jonny-boi/core';
import { collectInstanceIds, maskStateForSeat, maskStateForSpectator } from '@jonny-boi/protocol';
import { SAMPLE_DECKS } from '@jonny-boi/sim';
import { describe, expect, it } from 'vitest';
import { startHotseatGame } from '../play/setup.js';
import { answerChoiceAction, onlineChoiceView } from './pending-choice.js';

const NAMES: Readonly<Record<PlayerId, string>> = { A: 'Alice', B: 'Bob' };

/** A real game state (real cards, real instance ids) to mask. */
function realState(): GameState {
  const red = SAMPLE_DECKS.find((d) => d.name.toLowerCase().includes('red'))!;
  const started = startHotseatGame({
    choiceA: { source: 'sample', deck: red },
    choiceB: { source: 'sample', deck: red },
    seed: 12345,
    startingPlayer: 'A',
  });
  if (!started.ok) throw new Error('sample decks should be legal');
  return started.game.created.state;
}

/**
 * Park a Thoughtseize-shaped question on a real state: seat `chooser` is asked to
 * pick from seat `owner`'s HAND — the case where the candidates are cards the other
 * seat must never receive.
 */
function withChoiceOverHand(state: GameState, chooser: PlayerId, owner: PlayerId): GameState {
  const hand = state.players[owner].hand;
  const choice: PendingChoice = {
    kind: 'selectCards',
    id: 31,
    chooser,
    prompt: `Choose 1 card(s) for ${owner} to discard`,
    valence: 'gain',
    sourceInstanceId: hand[0]!.instanceId,
    sourceName: 'Thoughtseize',
    min: 1,
    max: 1,
    ordered: false,
    fromZone: 'hand',
    candidates: hand.map((c) => ({
      instanceId: c.instanceId,
      cardId: c.def.id,
      name: c.def.name,
      zone: 'hand' as const,
      controller: owner,
    })),
  };
  return { ...state, pendingChoice: choice };
}

describe('online pending choice', () => {
  it('has nothing to show when no question is parked', () => {
    const view = maskStateForSeat(realState(), 'A');
    expect(onlineChoiceView(view, NAMES)).toEqual({ answerable: null, waitingText: null });
  });

  it('gives the CHOOSER a renderable question with its candidates', () => {
    const state = withChoiceOverHand(realState(), 'A', 'B');
    const { answerable, waitingText } = onlineChoiceView(maskStateForSeat(state, 'A'), NAMES);
    expect(waitingText).toBeNull();
    expect(answerable).not.toBeNull();
    expect(answerable!.prompt).toContain('discard');
    expect(answerable!.kind).toBe('selectCards');
    // The candidates really are there — this is what the shared ChoicePrompt renders.
    expect(collectInstanceIds(answerable).size).toBeGreaterThan(0);
  });

  it('gives the OTHER seat a waiting line and nothing to render', () => {
    const base = realState();
    const state = withChoiceOverHand(base, 'B', 'B');
    const { answerable, waitingText } = onlineChoiceView(maskStateForSeat(state, 'A'), NAMES);
    expect(answerable).toBeNull();
    expect(waitingText).toBe('Waiting for Bob to answer Thoughtseize…');
    // The line names the chooser and the card — and no card of B's.
    const bHandIds = collectInstanceIds(base.players.B.hand);
    for (const id of bHandIds) expect(waitingText).not.toContain(`#${id}`);
  });

  it('gives a SPECTATOR the same waiting line and no question', () => {
    const state = withChoiceOverHand(realState(), 'A', 'B');
    const view = maskStateForSpectator(state);
    const { answerable, waitingText } = onlineChoiceView(view, NAMES);
    expect(answerable).toBeNull();
    expect(waitingText).toBe('Waiting for Alice to answer Thoughtseize…');
  });

  it('refuses to render a full question addressed to the other seat', () => {
    // Belt and braces: a buggy or hostile server that skipped redaction must still
    // not get this client to render the opponent's private candidates.
    const state = withChoiceOverHand(realState(), 'B', 'B');
    const unmasked = { ...maskStateForSeat(state, 'A'), pendingChoice: state.pendingChoice! };
    const { answerable, waitingText } = onlineChoiceView(unmasked, NAMES);
    expect(answerable).toBeNull();
    expect(waitingText).toContain('Bob');
  });

  it('answers by naming the choice id, so a stale reply is rejectable', () => {
    const state = withChoiceOverHand(realState(), 'A', 'B');
    const { answerable } = onlineChoiceView(maskStateForSeat(state, 'A'), NAMES);
    const pick = answerable!.kind === 'selectCards' ? answerable!.candidates[0]!.instanceId : 0;
    expect(answerChoiceAction('A', answerable!, { kind: 'selectCards', instanceIds: [pick] })).toEqual({
      kind: 'answerChoice',
      player: 'A',
      choiceId: 31,
      answer: { kind: 'selectCards', instanceIds: [pick] },
    });
  });
});

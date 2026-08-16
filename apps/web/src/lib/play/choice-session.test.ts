/**
 * End-to-end tests for ANSWERING a parked choice through the hotseat client seam.
 *
 * `choice-view.test.ts` proves the draft model never builds an illegal answer; this
 * file proves the other half — that the answer the UI submits really goes through
 * the engine's `answerChoice` action, resumes the half-finished resolution, and
 * that a wrong/stale/foreign answer is refused without corrupting the session.
 *
 * The pool ships no choice-asking card yet (`packages/cards` is wiring them), so
 * the test registers its OWN primitive on the session's effect registry and parks a
 * real choice through core's own `normalizeChoiceRequest` + `ResolutionFrame`. That
 * is the same shape the engine parks, so nothing here is a stand-in for the engine's
 * behaviour — only for a card that will exist later.
 */
import { describe, expect, it } from 'vitest';
import {
  normalizeChoiceRequest,
  type ChoiceRequest,
  type EffectRegistry,
  type GameState,
  type PlayerId,
  type ResolutionFrame,
} from '@jonny-boi/core';
import { SAMPLE_DECKS } from '@jonny-boi/sim';
import { GameSession } from './session.js';
import { startHotseatGame, type DeckChoice } from './setup.js';
import { draftStatus, emptyDraft, setConfirm, toggleOption } from './choice-view.js';

const SEAT_NAMES: Readonly<Record<PlayerId, string>> = { A: 'Alice', B: 'Bob' };
/** How much life the test primitive grants, so no bare number appears in asserts. */
const TEST_LIFE_GAIN = 3;
/** The effect id the test registers; namespaced so it cannot shadow a real card. */
const ASK_EFFECT_ID = 'test.mayGainLife';
/** The fabricated choice's id — any number the engine has not used. */
const TEST_CHOICE_ID = 4242;

function sampleChoice(fragment: string): DeckChoice {
  const deck = SAMPLE_DECKS.find((d) => d.name.toLowerCase().includes(fragment));
  if (!deck) throw new Error(`no sample deck matching "${fragment}"`);
  return { source: 'sample', deck };
}

/**
 * A session sitting on a parked question, plus the life total to compare against.
 * The primitive follows the engine's contract exactly — ask first, mutate only once
 * the answer is in hand — so re-running it on resume is safe.
 */
function sessionAwaiting(request: ChoiceRequest): { session: GameSession; lifeBefore: number } {
  const started = startHotseatGame({
    choiceA: sampleChoice('red'),
    choiceB: sampleChoice('red'),
    seed: 99,
    startingPlayer: 'A',
  });
  if (!started.ok) throw new Error('sample decks should be legal');
  const registry: EffectRegistry = started.game.registry;
  registry.register(ASK_EFFECT_ID, (ctx) => {
    const answer = ctx.ask(request);
    if (!answer) return; // parked — mutate nothing
    const gained =
      answer.kind === 'confirm'
        ? answer.yes
        : answer.kind === 'selectCards'
          ? answer.instanceIds.length > 0
          : answer.kind === 'selectPlayers'
            ? answer.players.length > 0
            : answer.kind === 'chooseModes'
              ? answer.modeIds.length > 0
              : answer.kind === 'payMana'
                ? answer.pay
                : answer.targets.length > 0;
    if (gained) ctx.state.players[ctx.controller].life += TEST_LIFE_GAIN;
  });

  const state = structuredClone(started.game.created.state) as GameState;
  const choice = normalizeChoiceRequest(request, {
    id: TEST_CHOICE_ID,
    sourceInstanceId: 0,
    sourceName: 'Test Oracle',
  });
  if (!choice) throw new Error('the request should normalise');
  const frame: ResolutionFrame = {
    origin: 'trigger',
    controller: 'A',
    targets: [],
    effects: [{ primitive: ASK_EFFECT_ID }],
    next: 0,
    answers: [],
    askCount: 1,
    sourceInstanceId: 0,
    label: 'Test ability',
  };
  state.pendingChoice = choice;
  state.resolution = frame;
  state.priorityPlayer = choice.chooser;
  const session = GameSession.fromCreated({ state, events: [] }, registry, SEAT_NAMES);
  return { session, lifeBefore: state.players.A.life };
}

const CONFIRM_REQUEST: ChoiceRequest = {
  kind: 'confirm',
  chooser: 'A',
  prompt: 'Gain 3 life?',
};

describe('answering a parked choice through the session', () => {
  it('exposes the pending choice and blocks every other action', () => {
    const { session } = sessionAwaiting(CONFIRM_REQUEST);
    expect(session.pendingChoice?.id).toBe(TEST_CHOICE_ID);
    expect(session.legalActions().every((a) => a.kind === 'answerChoice')).toBe(true);
    // Auto-advance must never pass a parked question away.
    expect(session.hasMeaningfulChoice()).toBe(true);
    expect(session.autoAdvancePriority()).toBe(session);
  });

  it('a Yes answer resumes the resolution and applies the effect', () => {
    const { session, lifeBefore } = sessionAwaiting(CONFIRM_REQUEST);
    const choice = session.pendingChoice!;
    const status = draftStatus(choice, setConfirm(emptyDraft(choice), true));
    const result = session.answerChoice(status.answer!);
    expect(result.rejected).toBeNull();
    expect(result.session.pendingChoice).toBeNull();
    expect(result.session.state.players.A.life).toBe(lifeBefore + TEST_LIFE_GAIN);
  });

  it('a No answer resumes the resolution and applies nothing', () => {
    const { session, lifeBefore } = sessionAwaiting(CONFIRM_REQUEST);
    const choice = session.pendingChoice!;
    const status = draftStatus(choice, setConfirm(emptyDraft(choice), false));
    const result = session.answerChoice(status.answer!);
    expect(result.rejected).toBeNull();
    expect(result.session.pendingChoice).toBeNull();
    expect(result.session.state.players.A.life).toBe(lifeBefore);
  });

  it('an ordered card selection submits in the order the human picked', () => {
    const { session } = sessionAwaiting({
      kind: 'selectCards',
      chooser: 'A',
      prompt: 'Put these back on top in any order',
      candidates: [
        { instanceId: 501, cardId: 'x1', name: 'Alpha', zone: 'hand', controller: 'A' },
        { instanceId: 502, cardId: 'x2', name: 'Beta', zone: 'hand', controller: 'A' },
        { instanceId: 503, cardId: 'x3', name: 'Gamma', zone: 'hand', controller: 'A' },
      ],
      ordered: true,
      min: 3,
      max: 3,
    });
    const choice = session.pendingChoice!;
    let draft = emptyDraft(choice);
    for (const id of [503, 501, 502]) draft = toggleOption(choice, draft, id);
    const answer = draftStatus(choice, draft).answer!;
    const result = session.answerChoice(answer);
    expect(result.rejected).toBeNull();
    const answered = result.events.find((e) => e.type === 'choiceAnswered');
    expect(answered && answered.type === 'choiceAnswered' && answered.answer).toEqual({
      kind: 'selectCards',
      instanceIds: [503, 501, 502],
    });
  });

  it('rejects an over-sized answer without touching the session', () => {
    const { session } = sessionAwaiting({
      kind: 'selectCards',
      chooser: 'A',
      prompt: 'Discard a card',
      candidates: [
        { instanceId: 601, cardId: 'y1', name: 'One', zone: 'hand', controller: 'A' },
        { instanceId: 602, cardId: 'y2', name: 'Two', zone: 'hand', controller: 'A' },
      ],
      min: 1,
      max: 1,
    });
    const result = session.answerChoice({ kind: 'selectCards', instanceIds: [601, 602] });
    expect(result.rejected).toBeTruthy();
    expect(result.session).toBe(session);
    expect(result.session.pendingChoice?.id).toBe(TEST_CHOICE_ID);
  });

  it('rejects a stale answer aimed at a different choice id', () => {
    const { session } = sessionAwaiting(CONFIRM_REQUEST);
    const stale = session.submit({
      kind: 'answerChoice',
      player: 'A',
      choiceId: TEST_CHOICE_ID + 1,
      answer: { kind: 'confirm', yes: true },
    });
    expect(stale.rejected).toBeTruthy();
    expect(stale.session).toBe(session);
  });

  it('rejects an answer from the seat that was not asked', () => {
    const { session } = sessionAwaiting(CONFIRM_REQUEST);
    const wrongSeat = session.submit({
      kind: 'answerChoice',
      player: 'B',
      choiceId: TEST_CHOICE_ID,
      answer: { kind: 'confirm', yes: true },
    });
    expect(wrongSeat.rejected).toBeTruthy();
    expect(wrongSeat.session).toBe(session);
  });

  it('answering when nothing is pending is refused, not thrown', () => {
    const started = startHotseatGame({
      choiceA: sampleChoice('red'),
      choiceB: sampleChoice('red'),
      seed: 5,
      startingPlayer: 'A',
    });
    if (!started.ok) throw new Error('sample decks should be legal');
    const session = GameSession.fromCreated(started.game.created, started.game.registry, SEAT_NAMES);
    const result = session.answerChoice({ kind: 'confirm', yes: true });
    expect(result.rejected).toBeTruthy();
    expect(result.session).toBe(session);
  });
});

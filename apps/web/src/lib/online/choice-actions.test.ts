import { describe, expect, it } from 'vitest';
import type { GameAction, PlayerId } from '@jonny-boi/core';
import { maskStateForSeat } from '@jonny-boi/protocol';
import { SAMPLE_DECKS } from '@jonny-boi/sim';
import { startHotseatGame } from '../play/setup.js';
import {
  choiceAnswerActions,
  isAwaitingChoiceAnswer,
  onlineChoiceOptions,
} from './choice-actions.js';

const NAMES: Readonly<Record<PlayerId, string>> = { A: 'Alice', B: 'Bob' };
const CHOICE_ID = 31;

/** A real masked view for `seat`, exactly as the server would send it. */
function maskedFor(seat: PlayerId) {
  const red = SAMPLE_DECKS.find((d) => d.name.toLowerCase().includes('red'))!;
  const started = startHotseatGame({
    choiceA: { source: 'sample', deck: red },
    choiceB: { source: 'sample', deck: red },
    seed: 12345,
    startingPlayer: 'A',
  });
  if (!started.ok) throw new Error('sample decks should be legal');
  return maskStateForSeat(started.game.created.state, seat);
}

describe('online pending-choice fallback', () => {
  it('detects the dead-end condition: nothing legal but answering', () => {
    const pass: GameAction = { kind: 'passPriority', player: 'A' };
    const ans: GameAction = {
      kind: 'answerChoice',
      player: 'A',
      choiceId: CHOICE_ID,
      answer: { kind: 'confirm', yes: true },
    };
    expect(isAwaitingChoiceAnswer([])).toBe(false);
    expect(isAwaitingChoiceAnswer([pass])).toBe(false);
    expect(isAwaitingChoiceAnswer([pass, ans])).toBe(false);
    expect(isAwaitingChoiceAnswer([ans])).toBe(true);
    expect(choiceAnswerActions([pass, ans])).toEqual([ans]);
  });

  it('labels a yes/no answer readably', () => {
    const view = maskedFor('A');
    const actions: GameAction[] = [
      { kind: 'answerChoice', player: 'A', choiceId: CHOICE_ID, answer: { kind: 'confirm', yes: true } },
      { kind: 'answerChoice', player: 'A', choiceId: CHOICE_ID, answer: { kind: 'confirm', yes: false } },
    ];
    const options = onlineChoiceOptions(actions, view, NAMES);
    expect(options.map((o) => o.label)).toEqual(['Yes', 'No']);
    expect(options.every((o) => o.fullyNamed)).toBe(true);
    // Keys are unique so React can render the menu.
    expect(new Set(options.map((o) => o.key)).size).toBe(options.length);
  });

  it("names cards the seat CAN see, and admits when it can't", () => {
    const view = maskedFor('A');
    const own = view.players.A.hand!;
    expect(own.length).toBeGreaterThan(0);
    const known = own[0]!;
    const actions: GameAction[] = [
      {
        kind: 'answerChoice',
        player: 'A',
        choiceId: CHOICE_ID,
        answer: { kind: 'selectCards', instanceIds: [known.instanceId] },
      },
      {
        // An id from a zone the masked view does not carry (the library).
        kind: 'answerChoice',
        player: 'A',
        choiceId: CHOICE_ID,
        answer: { kind: 'selectCards', instanceIds: [-1] },
      },
    ];
    const [named, unknown] = onlineChoiceOptions(actions, view, NAMES);
    expect(named!.label).toBe(known.def.name);
    expect(named!.fullyNamed).toBe(true);
    expect(unknown!.label).toContain('#-1');
    expect(unknown!.fullyNamed).toBe(false);
  });

  it('labels an empty selection as a decline, and players by their names', () => {
    const view = maskedFor('A');
    const actions: GameAction[] = [
      { kind: 'answerChoice', player: 'A', choiceId: CHOICE_ID, answer: { kind: 'selectCards', instanceIds: [] } },
      { kind: 'answerChoice', player: 'A', choiceId: CHOICE_ID, answer: { kind: 'selectPlayers', players: ['B'] } },
    ];
    const options = onlineChoiceOptions(actions, view, NAMES);
    expect(options[0]!.label).toBe('Choose none');
    expect(options[1]!.label).toBe('Bob');
  });

  it('offers nothing when the menu holds no answerChoice actions', () => {
    const view = maskedFor('A');
    expect(onlineChoiceOptions([{ kind: 'passPriority', player: 'A' }], view, NAMES)).toEqual([]);
  });

  it("never surfaces the opponent's hidden hand through a label", () => {
    const view = maskedFor('A');
    // B's hand is masked away entirely, so its ids cannot resolve to names here.
    expect(view.players.B.hand).toBeNull();
    const actions: GameAction[] = [
      { kind: 'answerChoice', player: 'A', choiceId: CHOICE_ID, answer: { kind: 'selectCards', instanceIds: [999999] } },
    ];
    const [only] = onlineChoiceOptions(actions, view, NAMES);
    expect(only!.label).toBe('card #999999');
  });
});

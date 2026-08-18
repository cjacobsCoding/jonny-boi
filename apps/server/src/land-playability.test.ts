/**
 * Can a seated online player actually PLAY A LAND?
 *
 * Reported from a live two-player game: "I joined with someone but I can't even
 * drag lands out to play them. Tried clicking, dragging, nothing works."
 *
 * The board disables a hand card unless `yourTurn` AND the card's `instanceId`
 * appears in a `playLand` action the server sent. That is three independent
 * things that must line up — priority, the legal-action list, and the ids in the
 * MASKED hand — and nothing covered them together, so a break in any one shows
 * up as a silently dead hand rather than an error.
 *
 * These drive the transport-free `Room` with fake connections through a real
 * game and assert the alignment for BOTH seats, since a bug that only strands
 * the joiner would have been invisible to whoever tested as the host.
 */
import { DEFAULT_RULES, PLAYER_IDS, type GameAction, type PlayerId } from '@jonny-boi/core';
import type { DeckList, ServerMessage } from '@jonny-boi/protocol';
import { describe, expect, it } from 'vitest';
import { Room, type Connection } from './room.js';

class FakeConnection implements Connection {
  readonly id: string;
  readonly sent: ServerMessage[] = [];
  constructor(id: string) {
    this.id = id;
  }
  send(message: ServerMessage): void {
    this.sent.push(message);
  }
  last<T extends ServerMessage['t']>(t: T): Extract<ServerMessage, { t: T }> | undefined {
    for (let i = this.sent.length - 1; i >= 0; i--) {
      if (this.sent[i]!.t === t) return this.sent[i] as Extract<ServerMessage, { t: T }>;
    }
    return undefined;
  }
}

/** A deck that is nothing but basics, so an opening hand is always all lands. */
const ALL_FOREST: DeckList = {
  name: 'Forests',
  // `cardId` is the card NAME. A lowercase id is silently an unknown card, the
  // deck is rejected, and the room never starts a game at all.
  cards: [{ cardId: 'Forest', count: 60 }],
};
const DECKS = { A: ALL_FOREST, B: ALL_FOREST } as const;

interface Game {
  readonly room: Room;
  readonly conns: Readonly<Record<PlayerId, FakeConnection>>;
}

/** Seat both players, ready up, and keep both opening hands. */
function startedGame(seed = 1): Game {
  const room = new Room('TEST', DEFAULT_RULES, seed);
  const conns = { A: new FakeConnection('a'), B: new FakeConnection('b') } as const;
  room.createSeat(conns.A, 'Alice', DECKS.A);
  room.join(conns.B, 'Bob', DECKS.B);
  for (const id of PLAYER_IDS) room.setReady(conns[id], true);
  for (const id of PLAYER_IDS) room.mulligan(conns[id], true);
  return { room, conns };
}

const frameOf = (conn: FakeConnection) => {
  const state = conn.last('state');
  if (!state) throw new Error(`${conn.id} was never sent a state`);
  return state;
};

/** Pass priority until `player` holds it in their own precombat main phase. */
function passToMainPhaseOf(game: Game, player: PlayerId): void {
  for (let i = 0; i < 200; i++) {
    const view = frameOf(game.conns[player]).view;
    if (view.step === 'precombatMain' && view.activePlayer === player && view.priorityPlayer === player) return;
    const holder = view.priorityPlayer;
    game.room.submitAction(game.conns[holder], { kind: 'passPriority', player: holder });
  }
  throw new Error(`never reached ${player}'s main phase`);
}

describe('online: a seated player can play a land', () => {
  it('deals both seats a hand once the mulligan is kept', () => {
    const game = startedGame();
    for (const id of PLAYER_IDS) {
      const view = frameOf(game.conns[id]).view;
      expect(view.players[id].hand, `${id} sees their own hand`).toBeTruthy();
      expect((view.players[id].hand ?? []).length).toBeGreaterThan(0);
    }
  });

  it.each(PLAYER_IDS)('offers seat %s a playLand for a land in its own hand', (seat) => {
    const game = startedGame();
    passToMainPhaseOf(game, seat);
    const frame = frameOf(game.conns[seat]);

    expect(frame.yourTurn, `seat ${seat} should hold priority in its own main phase`).toBe(true);

    const handIds = new Set((frame.view.players[seat].hand ?? []).map((c) => c.instanceId));
    const landActions = frame.legalActions.filter(
      (a: GameAction): a is Extract<GameAction, { kind: 'playLand' }> => a.kind === 'playLand',
    );

    expect(landActions.length, `seat ${seat} was offered no playLand at all`).toBeGreaterThan(0);
    // The board keys off this exact match; a renumbered id greys out the whole hand.
    for (const action of landActions) {
      expect(handIds.has(action.instanceId), `playLand id ${action.instanceId} is not in ${seat}'s hand`).toBe(true);
    }
  });

  it.each(PLAYER_IDS)('actually puts the land onto the battlefield for seat %s', (seat) => {
    const game = startedGame();
    passToMainPhaseOf(game, seat);
    const before = frameOf(game.conns[seat]);
    const play = before.legalActions.find(
      (a: GameAction): a is Extract<GameAction, { kind: 'playLand' }> => a.kind === 'playLand',
    );
    expect(play, `seat ${seat} had no playLand to submit`).toBeDefined();

    const landsBefore = before.view.battlefield.filter((p) => p.controller === seat).length;
    game.room.submitAction(game.conns[seat], play!);

    const after = frameOf(game.conns[seat]);
    const landsAfter = after.view.battlefield.filter((p) => p.controller === seat).length;
    expect(landsAfter, `seat ${seat}'s land never reached the battlefield`).toBe(landsBefore + 1);
  });

  it('gives the seat WITHOUT priority an empty menu, so its hand is inert by design', () => {
    const game = startedGame();
    passToMainPhaseOf(game, 'A');
    const waiting = frameOf(game.conns.B);
    expect(waiting.yourTurn).toBe(false);
    expect(waiting.legalActions).toEqual([]);
  });
});

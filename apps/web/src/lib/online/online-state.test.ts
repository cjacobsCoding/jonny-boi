import { describe, expect, it } from 'vitest';
import type { ServerMessage } from '@jonny-boi/protocol';
import {
  INITIAL_ONLINE_STATE,
  friendlyError,
  onlineReducer,
  type OnlineState,
} from './online-state.js';
import {
  canPass,
  castChoices,
  declareAttackersAction,
  playableLandIds,
} from './legal-actions.js';
import type { GameAction } from '@jonny-boi/core';

/** Fold a sequence of server messages through the reducer from the initial state. */
function applyServer(msgs: ServerMessage[], start: OnlineState = INITIAL_ONLINE_STATE): OnlineState {
  return msgs.reduce((s, msg) => onlineReducer(s, { kind: 'server', msg }), start);
}

describe('onlineReducer — lobby & flow', () => {
  it('starts on the menu screen, closed', () => {
    expect(INITIAL_ONLINE_STATE.screen).toBe('menu');
    expect(INITIAL_ONLINE_STATE.status).toBe('closed');
  });

  it('a create request moves to the connecting screen and clears errors', () => {
    const withErr = onlineReducer(INITIAL_ONLINE_STATE, {
      kind: 'server',
      msg: { t: 'error', code: 'internal', message: 'boom' },
    });
    const s = onlineReducer(withErr, { kind: 'requestCreate' });
    expect(s.screen).toBe('connecting');
    expect(s.error).toBeNull();
  });

  it('roomJoined records the code + seat and enters the lobby', () => {
    const s = applyServer([{ t: 'roomJoined', code: 'WXYZ12', yourSeat: 'A', spectator: false }]);
    expect(s.code).toBe('WXYZ12');
    expect(s.yourSeat).toBe('A');
    expect(s.spectator).toBe(false);
    expect(s.screen).toBe('lobby');
  });

  it('lobby message mirrors phase + players and routes the screen', () => {
    const s = applyServer([
      { t: 'roomJoined', code: 'WXYZ12', yourSeat: 'A', spectator: false },
      {
        t: 'lobby',
        code: 'WXYZ12',
        phase: 'deckSelect',
        players: [
          { seat: 'A', name: 'Alice', ready: false, hasDeck: true },
          { seat: 'B', name: 'Bob', ready: false, hasDeck: false },
        ],
      },
    ]);
    expect(s.roomPhase).toBe('deckSelect');
    expect(s.lobbyPlayers).toHaveLength(2);
    expect(s.screen).toBe('lobby');
  });

  it('tracks local deck-chosen and ready intents', () => {
    let s = onlineReducer(INITIAL_ONLINE_STATE, { kind: 'localDeckChosen' });
    expect(s.deckChosen).toBe(true);
    s = onlineReducer(s, { kind: 'localReady', ready: true });
    expect(s.ready).toBe(true);
  });

  it('mulliganPrompt enters the mulligan screen with the hand', () => {
    const hand = [] as never[]; // shape is opaque to the reducer
    const s = applyServer([{ t: 'mulliganPrompt', hand, mulligansTaken: 1 }]);
    expect(s.screen).toBe('mulligan');
    expect(s.mulligansTaken).toBe(1);
    expect(s.mulliganHand).toBe(hand);
  });

  it('a state frame enters playing and stores the latest frame', () => {
    const frameMsg: ServerMessage = {
      t: 'state',
      view: { viewer: 'A' } as never,
      legalActions: [],
      yourTurn: true,
      log: ['Turn 1'],
    };
    const s = applyServer([frameMsg]);
    expect(s.screen).toBe('playing');
    expect(s.frame?.yourTurn).toBe(true);
    expect(s.frame?.log).toEqual(['Turn 1']);
    expect(s.mulliganHand).toBeNull();
  });

  it('gameOver moves to finished with the result', () => {
    const s = applyServer([{ t: 'gameOver', winner: 'B', reason: 'Alice conceded' }]);
    expect(s.screen).toBe('finished');
    expect(s.result).toEqual({ winner: 'B', reason: 'Alice conceded' });
  });

  it('opponent disconnect / reconnect toggles connectivity', () => {
    let s = applyServer([{ t: 'opponentDisconnected' }]);
    expect(s.opponentConnected).toBe(false);
    s = onlineReducer(s, { kind: 'server', msg: { t: 'opponentReconnected' } });
    expect(s.opponentConnected).toBe(true);
  });

  it('error sets a banner; dismissError clears it', () => {
    let s = applyServer([{ t: 'error', code: 'roomNotFound', message: 'nope' }]);
    expect(s.error).toEqual({ code: 'roomNotFound', message: 'nope' });
    s = onlineReducer(s, { kind: 'dismissError' });
    expect(s.error).toBeNull();
  });

  it('pong is a no-op (no state change)', () => {
    const before = applyServer([{ t: 'roomJoined', code: 'AAA111', yourSeat: 'A', spectator: false }]);
    const after = onlineReducer(before, { kind: 'server', msg: { t: 'pong' } });
    expect(after).toBe(before);
  });

  it('leave resets to the menu but keeps the connection status', () => {
    let s = applyServer([{ t: 'roomJoined', code: 'AAA111', yourSeat: 'A', spectator: false }]);
    s = onlineReducer(s, { kind: 'status', status: 'open' });
    s = onlineReducer(s, { kind: 'leave' });
    expect(s.screen).toBe('menu');
    expect(s.code).toBeNull();
    expect(s.status).toBe('open');
  });
});

describe('friendlyError', () => {
  it('gives a human message for each known code', () => {
    expect(friendlyError('roomNotFound')).toMatch(/code/i);
    expect(friendlyError('roomFull')).toMatch(/full/i);
    expect(friendlyError('invalidDeck')).toMatch(/deck/i);
  });
});

describe('legal-actions derivation', () => {
  const actions: GameAction[] = [
    { kind: 'passPriority', player: 'A' },
    { kind: 'playLand', player: 'A', instanceId: 10 },
    { kind: 'castSpell', player: 'A', instanceId: 20, targets: [] },
    { kind: 'castSpell', player: 'A', instanceId: 21, targets: [99] },
    { kind: 'castSpell', player: 'A', instanceId: 21, targets: ['B'] },
    { kind: 'declareAttackers', player: 'A', attackers: [30, 31] },
  ];

  it('extracts playable land ids', () => {
    expect([...playableLandIds(actions)]).toEqual([10]);
  });

  it('groups cast choices by spell, separating targeted vs untargeted', () => {
    const casts = castChoices(actions);
    expect(casts.get(20)?.canCastUntargeted).toBe(true);
    const targeted = casts.get(21)!;
    expect(targeted.canCastUntargeted).toBe(false);
    expect(targeted.targetSets).toEqual([[99], ['B']]);
  });

  it('withholds a modal DFC’s BACK-face offers rather than merging them', () => {
    // A modal DFC offers two casts (and possibly a land play) for ONE instance.
    // These helpers key on the instance alone, so merging the two would put the
    // back face's legal targets on a menu that submits the FRONT face — a
    // wrong action, not a missing one. Until the board can render two faces per
    // card, only the front-face offers are surfaced.
    const mdfc: GameAction[] = [
      { kind: 'castSpell', player: 'A', instanceId: 40 },
      { kind: 'castSpell', player: 'A', instanceId: 40, targets: [99], face: 'back' },
      { kind: 'playLand', player: 'A', instanceId: 41, face: 'back' },
    ];
    const casts = castChoices(mdfc);
    expect(casts.get(40)?.canCastUntargeted).toBe(true);
    expect(casts.get(40)?.targetSets).toEqual([]);
    expect([...playableLandIds(mdfc)]).toEqual([]);
  });

  it('keeps the CHEAPEST Phyrexian reading rather than merging them (§3.143)', () => {
    // The server offers one cast per fundable life amount, and this map holds one
    // choice per instance. Merged, the 4-life reading's targets would ride a
    // button that submits a 0-life cast — a WRONG action, the same shape the
    // modal-DFC case above guards against.
    const readings: GameAction[] = [
      { kind: 'castSpell', player: 'A', instanceId: 50, targets: [99] },
      { kind: 'castSpell', player: 'A', instanceId: 50, targets: [77], phyrexianLife: 2 },
      { kind: 'castSpell', player: 'A', instanceId: 50, targets: [88], phyrexianLife: 4 },
    ];
    const cheapest = castChoices(readings).get(50)!;
    expect(cheapest.phyrexianLife, 'the all-mana reading spends no life').toBeUndefined();
    expect(cheapest.targetSets, 'and carries only its OWN targets').toEqual([[99]]);

    // …and when the all-mana reading is not offered at all — Dismember off a lone
    // Wastes — the life one is taken AND said, because a cast submitted without
    // the field is one the server never offered.
    const lifeOnly = castChoices([readings[2] as GameAction]).get(50)!;
    expect(lifeOnly.phyrexianLife).toBe(4);
    expect(lifeOnly.targetSets).toEqual([[88]]);
  });

  it('finds the declare-attackers template and pass availability', () => {
    expect(declareAttackersAction(actions)?.attackers).toEqual([30, 31]);
    expect(canPass(actions)).toBe(true);
    expect(canPass([{ kind: 'playLand', player: 'A', instanceId: 1 }])).toBe(false);
  });
});

/**
 * `useOnlineGame` — the React glue around the pure pieces:
 *   - owns one `OnlineConnection` (the single socket) for the component's lifetime,
 *   - folds its status + every `ServerMessage` through the pure `onlineReducer`,
 *   - exposes the derived `OnlineState` plus typed senders (create/join/chooseDeck/
 *     setReady/mulligan/submitAction/concede/rematch) that serialize to `ClientMessage`.
 *
 * All game/lobby logic lives in the pure reducer (online-state.ts) and the connection
 * module; this hook is intentionally thin so the testable surface stays pure.
 */
import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import {
  PROTOCOL_VERSION,
  type ClientMessage,
  type DeckList,
  type ErrorCode,
} from '@jonny-boi/protocol';
import { isLegacyVersion, negotiateOnError } from './negotiation.js';
import type { GameAction } from '@jonny-boi/core';
import { OnlineConnection, type ConnectionOptions } from './connection.js';
import {
  INITIAL_ONLINE_STATE,
  onlineReducer,
  type OnlineState,
} from './online-state.js';

/** The senders + state the online UI consumes. */
export interface OnlineGameApi {
  readonly state: OnlineState;
  /** Create a new room under `name`, optionally pre-sending a deck. */
  createRoom(name: string, deck?: DeckList): void;
  /** Join an existing room by `code` under `name`. */
  joinRoom(code: string, name: string, deck?: DeckList): void;
  /** Choose/replace this seat's deck in the lobby. */
  chooseDeck(deck: DeckList): void;
  /** Toggle the local ready flag. */
  setReady(ready: boolean): void;
  /** Answer a mulligan prompt: keep (true) or ship (false). */
  mulligan(keep: boolean): void;
  /** Submit a chosen game action when it's your turn. */
  submitAction(action: GameAction): void;
  /** Concede the current game. */
  concede(): void;
  /** Request a rematch after game over. */
  rematch(): void;
  /** Tear down the room view and return to the menu (keeps the socket for reuse). */
  leave(): void;
  /** Clear the current transient error banner. */
  dismissError(): void;
  /**
   * True once we've had to negotiate down to an older server (see
   * {@link MIN_COMPATIBLE_PROTOCOL_VERSION}). The game is playable, but cards that
   * ask a player to choose won't work until the server is updated — so the UI
   * should say so rather than let a player discover it mid-game.
   */
  readonly legacyServer: boolean;
}

/**
 * The hook. `options` lets tests inject a mock socket factory / timers; production
 * passes nothing and the connection uses the configured `SERVER_URL`.
 */
export function useOnlineGame(options?: ConnectionOptions): OnlineGameApi {
  const [state, dispatch] = useReducer(onlineReducer, INITIAL_ONLINE_STATE);
  const connRef = useRef<OnlineConnection | null>(null);

  // --- protocol negotiation -----------------------------------------------------
  // The version we're currently speaking, the handshake we last sent (so it can be
  // replayed at a lower version), and whether we've already stepped down. Refs, not
  // state: the message handler is installed once and must read the live values.
  const versionRef = useRef<number>(PROTOCOL_VERSION);
  const lastHandshakeRef = useRef<ClientMessage | null>(null);
  const [legacyServer, setLegacyServer] = useState(false);

  /** Send a versioned handshake, remembering it in case we must retry it lower. */
  const sendHandshake = useCallback((build: (version: number) => ClientMessage) => {
    const msg = build(versionRef.current);
    lastHandshakeRef.current = msg;
    connRef.current?.send(msg);
  }, []);

  /**
   * A `protocolMismatch` on a handshake is recoverable when we're still above the
   * compatible floor: step down and replay the SAME request once. Returns true if
   * we handled it, in which case the error is swallowed rather than shown — the
   * user sees a working lobby plus a "server is older" notice, not a dead end.
   */
  const tryDowngrade = useCallback((code: ErrorCode): boolean => {
    const pending = lastHandshakeRef.current;
    const outcome = negotiateOnError(code, versionRef.current, pending !== null);
    if (outcome.action !== 'retry' || !pending) return false;
    versionRef.current = outcome.version;
    setLegacyServer(isLegacyVersion(outcome.version));
    connRef.current?.send({ ...pending, protocolVersion: outcome.version } as ClientMessage);
    return true;
  }, []);

  // Create the connection once; subscribe; connect; tear down on unmount.
  useEffect(() => {
    const conn = new OnlineConnection(options);
    connRef.current = conn;
    const offMsg = conn.onMessage((msg) => {
      // Intercept a recoverable version mismatch before it reaches the reducer, so
      // the retry is invisible instead of flashing a scary error the user can't act on.
      if (msg.t === 'error' && tryDowngrade(msg.code)) return;
      dispatch({ kind: 'server', msg });
    });
    const offStatus = conn.onStatus((status) => dispatch({ kind: 'status', status }));
    conn.connect();
    return () => {
      offMsg();
      offStatus();
      conn.dispose();
      connRef.current = null;
    };
    // Connection identity is stable for the component's life; options are read once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const createRoom = useCallback(
    (name: string, deck?: DeckList) => {
      dispatch({ kind: 'requestCreate' });
      sendHandshake((protocolVersion) => ({ t: 'createRoom', protocolVersion, name, deck }));
    },
    [sendHandshake],
  );

  const joinRoom = useCallback(
    (code: string, name: string, deck?: DeckList) => {
      dispatch({ kind: 'requestJoin' });
      sendHandshake((protocolVersion) => ({
        t: 'joinRoom',
        protocolVersion,
        code: code.trim().toUpperCase(),
        name,
        deck,
      }));
    },
    [sendHandshake],
  );

  const chooseDeck = useCallback((deck: DeckList) => {
    dispatch({ kind: 'localDeckChosen' });
    connRef.current?.send({ t: 'chooseDeck', deck });
  }, []);

  const setReady = useCallback((ready: boolean) => {
    dispatch({ kind: 'localReady', ready });
    connRef.current?.send({ t: 'setReady', ready });
  }, []);

  const mulligan = useCallback((keep: boolean) => {
    connRef.current?.send({ t: 'mulligan', keep });
  }, []);

  const submitAction = useCallback((action: GameAction) => {
    connRef.current?.send({ t: 'submitAction', action });
  }, []);

  const concede = useCallback(() => {
    connRef.current?.send({ t: 'concede' });
  }, []);

  const rematch = useCallback(() => {
    connRef.current?.send({ t: 'rematch' });
  }, []);

  const leave = useCallback(() => {
    dispatch({ kind: 'leave' });
  }, []);

  const dismissError = useCallback(() => {
    dispatch({ kind: 'dismissError' });
  }, []);

  return {
    state,
    createRoom,
    joinRoom,
    chooseDeck,
    setReady,
    mulligan,
    submitAction,
    concede,
    rematch,
    leave,
    dismissError,
    legacyServer,
  };
}

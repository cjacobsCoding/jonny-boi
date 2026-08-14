import { useEffect, useMemo, useState, type ReactElement } from 'react';
import { isLand, type PlayerId } from '@jonny-boi/core';
import type { DecksApi } from '../../lib/useDecks.js';
import { useOnlineGame } from '../../lib/online/useOnlineGame.js';
import { deckChoiceToDeckList } from '../../lib/online/deck-list.js';
import { buildDeckMenu } from '../../lib/online/deck-menu.js';
import { friendlyError } from '../../lib/online/online-state.js';
import { ERROR_TOAST_MS, ROOM_CODE_LENGTH, resolveServerUrl } from '../../lib/online/online-config.js';
import { validateChoice } from '../../lib/play/setup.js';
import { HOTSEAT_CONFIG } from '../../lib/play/play-config.js';
import { ConnectionIndicator } from './ConnectionIndicator.js';
import { OnlineBoard } from './OnlineBoard.js';
import { MulliganScreen } from '../play/MulliganScreen.js';
import { EndScreen } from '../play/EndScreen.js';

/**
 * The online play flow: create/join a room, lobby with deck selection + ready, the
 * mulligan prompt, the networked board, and the game-over screen — all driven by the
 * `useOnlineGame` hook (which owns the socket + pure reducer). Each device is ONE
 * seat, so there is no device handoff; when it's not our turn the board shows a
 * "Waiting for opponent…" state.
 */
export function OnlinePlay({ decks }: { decks: DecksApi }): ReactElement {
  const online = useOnlineGame();
  const { state } = online;
  const menu = useMemo(() => buildDeckMenu(decks), [decks]);
  // Named so a failure can say WHICH host didn't answer — the single most useful
  // thing to know when the server is a tunnel URL or a misconfigured build.
  const serverUrl = useMemo(() => resolveServerUrl(), []);

  // Seat display names from the lobby (fallback to the seat letter).
  const names = useMemo<Record<PlayerId, string>>(() => {
    const byId: Partial<Record<PlayerId, string>> = {};
    for (const p of state.lobbyPlayers) byId[p.seat] = p.name;
    return { A: byId.A ?? 'Player A', B: byId.B ?? 'Player B' };
  }, [state.lobbyPlayers]);

  // Auto-dismiss error toasts after a configured interval.
  useEffect(() => {
    if (!state.error) return;
    const h = window.setTimeout(() => online.dismissError(), ERROR_TOAST_MS);
    return () => window.clearTimeout(h);
  }, [state.error, online]);

  return (
    <div className="online">
      <div className="online__bar">
        <ConnectionIndicator status={state.status} />
        {state.code && <span className="online__code-chip">Room {state.code}</span>}
        {!state.opponentConnected && (
          <span className="online__banner online__banner--warn" role="alert">
            Opponent disconnected — waiting for them to reconnect…
          </span>
        )}
      </div>

      {state.error && (
        <div className="play-toast play-toast--error" role="alert">
          {state.error.message || friendlyError(state.error.code)}
        </div>
      )}

      {renderScreen()}
    </div>
  );

  function renderScreen(): ReactElement {
    switch (state.screen) {
      case 'menu':
        return <MenuScreen online={online} menu={menu} />;
      case 'connecting':
        // The socket has definitively failed (nothing listening, or we're offline).
        // Waiting on a spinner forever is the wrong answer: the connection keeps
        // retrying underneath, but the player is told the truth and given a way out
        // instead of a hedge ("if this hangs…") that never resolves.
        if (state.status === 'error') {
          return (
            <div className="online__waiting">
              <p className="online__failed" role="alert">
                Couldn't reach the game server.
              </p>
              <p className="online__hint">
                {serverUrl} didn't answer — it may be offline, or this device may be. We'll keep
                trying in the background.
              </p>
              <button type="button" className="btn btn--ghost" onClick={online.leave}>
                Back
              </button>
            </div>
          );
        }
        return (
          <div className="online__waiting">
            <div className="spinner" aria-hidden="true" />
            <p>Contacting the game server…</p>
            <p className="online__hint">Connecting to {serverUrl}…</p>
            <button type="button" className="btn btn--ghost" onClick={online.leave}>
              Back
            </button>
          </div>
        );
      case 'lobby':
        return <LobbyScreen online={online} menu={menu} />;
      case 'mulligan':
        return state.mulliganHand ? (
          <MulliganScreen
            seat={state.yourSeat ?? 'A'}
            name={names[state.yourSeat ?? 'A']}
            hand={state.mulliganHand.map((c) => ({
              instanceId: c.instanceId,
              cardId: c.def.id,
              name: c.def.name,
              isLand: isLand(c.def),
            }))}
            mulligansTaken={state.mulligansTaken}
            maxMulligans={HOTSEAT_CONFIG.maxMulligans}
            // Online: keep ships the full kept hand (no client-side bottoming — the
            // server resolves London bottoming authoritatively), so Keep sends keep=true.
            onKeep={() => online.mulligan(true)}
            onMulligan={() => online.mulligan(false)}
          />
        ) : (
          <div className="online__waiting">Waiting for your hand…</div>
        );
      case 'playing':
        return state.frame ? (
          <OnlineBoard
            frame={state.frame}
            names={names}
            onAction={online.submitAction}
            onConcede={online.concede}
          />
        ) : (
          <div className="online__waiting">
            <div className="spinner" aria-hidden="true" />
            <p>Game starting…</p>
          </div>
        );
      case 'finished':
        return (
          <EndScreen
            winner={state.result?.winner ?? null}
            names={names}
            reason={state.result?.reason}
            onRematch={online.rematch}
            onNewGame={online.leave}
          />
        );
    }
  }
}

/** Create-or-join landing. */
function MenuScreen({
  online,
  menu,
}: {
  online: ReturnType<typeof useOnlineGame>;
  menu: ReturnType<typeof buildDeckMenu>;
}): ReactElement {
  const [name, setName] = useState('Player');
  const [code, setCode] = useState('');
  const codeOk = code.trim().length === ROOM_CODE_LENGTH;

  return (
    <div className="online-menu">
      <h2 className="play-setup__title">Play Online</h2>
      <p className="play-setup__intro">
        Play a real game against a friend on another device. Create a room and share the code, or
        join a room someone shared with you. You pick your deck in the lobby.
      </p>

      <label className="play-setup__field">
        <span>Your name</span>
        <input
          className="input"
          value={name}
          maxLength={24}
          onChange={(e) => setName(e.target.value)}
          aria-label="Your name"
        />
      </label>

      <div className="online-menu__actions">
        <div className="online-menu__panel">
          <div className="section-label">Create a room</div>
          <p className="online__hint">You'll get a code to share with your opponent.</p>
          <button
            type="button"
            className="btn btn--primary"
            disabled={menu.length === 0}
            onClick={() => online.createRoom(name.trim() || 'Player')}
          >
            Create room
          </button>
        </div>

        <div className="online-menu__panel">
          <div className="section-label">Join a room</div>
          <label className="play-setup__field">
            <span>Room code</span>
            <input
              className="input"
              value={code}
              maxLength={ROOM_CODE_LENGTH}
              placeholder={'ABC123'.slice(0, ROOM_CODE_LENGTH)}
              onChange={(e) => setCode(e.target.value.toUpperCase())}
              aria-label="Room code"
              style={{ textTransform: 'uppercase', letterSpacing: '0.2em' }}
            />
          </label>
          <button
            type="button"
            className="btn btn--primary"
            disabled={!codeOk}
            onClick={() => online.joinRoom(code, name.trim() || 'Player')}
          >
            Join room
          </button>
        </div>
      </div>
    </div>
  );
}

/** Lobby: show both seats, pick a deck, ready up. */
function LobbyScreen({
  online,
  menu,
}: {
  online: ReturnType<typeof useOnlineGame>;
  menu: ReturnType<typeof buildDeckMenu>;
}): ReactElement {
  const { state } = online;
  const [deckKey, setDeckKey] = useState(menu[0]?.key ?? '');
  const choice = menu.find((m) => m.key === deckKey)?.choice;
  const problems = choice ? validateChoice(choice) : ['Pick a deck.'];
  const deckOk = !!choice && problems.length === 0;

  const me = state.yourSeat;
  const both = state.lobbyPlayers;
  const opponentPresent = both.length >= 2;

  const chooseAndMaybeReady = (): void => {
    if (!choice || !deckOk) return;
    online.chooseDeck(deckChoiceToDeckList(choice));
  };

  return (
    <div className="online-lobby">
      <h2 className="play-setup__title">Lobby — Room {state.code}</h2>
      <p className="play-setup__intro">
        Share the room code with your opponent. Pick your deck, then ready up. The game starts when
        both players are ready.
      </p>

      <div className="online-lobby__seats">
        {(['A', 'B'] as const).map((seat) => {
          const p = both.find((x) => x.seat === seat);
          const isMe = seat === me;
          return (
            <div key={seat} className={`online-lobby__seat${isMe ? ' online-lobby__seat--me' : ''}`}>
              <div className="section-label">
                Seat {seat} {isMe && '(you)'}
              </div>
              {p ? (
                <>
                  <div className="online-lobby__name">{p.name}</div>
                  <div className="online-lobby__flags">
                    <span className={p.hasDeck ? 'flag flag--on' : 'flag'}>
                      {p.hasDeck ? 'Deck chosen' : 'No deck'}
                    </span>
                    <span className={p.ready ? 'flag flag--on' : 'flag'}>
                      {p.ready ? 'Ready' : 'Not ready'}
                    </span>
                  </div>
                </>
              ) : (
                <div className="online-lobby__empty">Waiting for a player…</div>
              )}
            </div>
          );
        })}
      </div>

      {me && (
        <div className="online-lobby__controls">
          <label className="play-setup__field">
            <span>Your deck</span>
            <select
              className="select"
              value={deckKey}
              onChange={(e) => setDeckKey(e.target.value)}
              aria-label="Your deck"
            >
              {menu.length === 0 && <option value="">No decks available</option>}
              {menu.map((m) => (
                <option key={m.key} value={m.key}>
                  {m.label}
                </option>
              ))}
            </select>
          </label>
          {problems.length > 0 && (
            <div className="play-setup__problems" role="alert">
              <strong>Not ready:</strong>
              <ul>
                {problems.map((p, i) => (
                  <li key={i}>{p}</li>
                ))}
              </ul>
            </div>
          )}
          <div className="online-lobby__buttons">
            <button type="button" className="btn" disabled={!deckOk} onClick={chooseAndMaybeReady}>
              {state.deckChosen ? 'Change deck' : 'Choose this deck'}
            </button>
            <button
              type="button"
              className="btn btn--primary"
              disabled={!state.deckChosen}
              onClick={() => online.setReady(!state.ready)}
            >
              {state.ready ? 'Cancel ready' : 'Ready up'}
            </button>
            <button type="button" className="btn btn--ghost" onClick={online.leave}>
              Leave room
            </button>
          </div>
          {!opponentPresent && (
            <p className="online__hint">Waiting for an opponent to join with code {state.code}…</p>
          )}
        </div>
      )}

      {!me && (
        <div className="online__waiting">
          <p>You're spectating this room.</p>
          <button type="button" className="btn btn--ghost" onClick={online.leave}>
            Leave
          </button>
        </div>
      )}
    </div>
  );
}

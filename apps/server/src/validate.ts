/**
 * Inbound-message validation. The wire is hostile: a client (or a fuzzer) can send
 * any bytes. We parse JSON defensively and shape-check it into a `ClientMessage`
 * before the room logic ever sees it — a bad message yields `null` (the caller
 * replies with an `error` and the process never crashes). DESIGN §6 robustness.
 *
 * We validate the discriminant (`t`) and the *presence/shape* of fields the room
 * logic reads; the deep validity of a `GameAction` or `DeckList` is enforced later
 * by the engine (`applyAction` rejects cleanly) and the deck loader (`validateDeck`).
 */

import { PLAYER_IDS, type GameAction, type PlayerId } from '@jonny-boi/core';
import {
  STARTING_PLAYER_CHOICES,
  type ClientMessage,
  type DeckList,
  type StartingPlayerChoice,
} from '@jonny-boi/protocol';
import {
  MAX_CARD_ID_LENGTH,
  MAX_DECK_ENTRIES,
  MAX_DECK_ENTRY_COUNT,
  MAX_DECK_NAME_LENGTH,
  MAX_DECK_TOTAL_CARDS,
  MAX_NAME_LENGTH,
  MAX_ROOM_CODE_LENGTH,
  RECONNECT_TOKEN_BYTES,
} from './config.js';

/** A reconnect token is hex, so twice its entropy in bytes; allow no more. */
const MAX_RECONNECT_TOKEN_LENGTH = RECONNECT_TOKEN_BYTES * 2;

function isObject(x: unknown): x is Record<string, unknown> {
  // `typeof null === 'object'`, and an Array is an object too — a message body must be
  // a plain record, so arrays are rejected here rather than surprising a field check.
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

/** Narrow an unknown to a canonical seat id (the core `PlayerId`s — no others). */
function isPlayerId(x: unknown): x is PlayerId {
  return typeof x === 'string' && (PLAYER_IDS as readonly string[]).includes(x);
}

/** A bounded, non-empty string field (display name, room code, card id...). */
function isBoundedString(x: unknown, maxLength: number): x is string {
  return typeof x === 'string' && x.length > 0 && x.length <= maxLength;
}

/**
 * A `DeckList` is `{ name: string, cards: {cardId,count}[] }` — with EVERY dimension
 * bounded. The deck loader expands `count` copies of each entry into a flat library,
 * so an unbounded `count` (or an unbounded number of entries) is a remote
 * out-of-memory kill: it would take down every other room on the server with it.
 * Deep validity (real card ids, format legality) stays the loader's job.
 */
/** Membership in the protocol's closed set of first-turn choices (§3.125). */
function isStartingPlayerChoice(value: unknown): value is StartingPlayerChoice {
  return typeof value === 'string' && (STARTING_PLAYER_CHOICES as readonly string[]).includes(value);
}

function isDeckList(x: unknown): x is DeckList {
  if (!isObject(x)) return false;
  if (!isBoundedString(x.name, MAX_DECK_NAME_LENGTH)) return false;
  if (!Array.isArray(x.cards)) return false;
  if (x.cards.length === 0 || x.cards.length > MAX_DECK_ENTRIES) return false;
  let total = 0;
  for (const c of x.cards) {
    if (!isObject(c)) return false;
    if (!isBoundedString(c.cardId, MAX_CARD_ID_LENGTH)) return false;
    // Integer-only: `Number.isInteger` also rejects NaN, ±Infinity and fractions,
    // any of which would otherwise reach the loader's `for (i < count)` expansion.
    if (!Number.isInteger(c.count)) return false;
    const count = c.count as number;
    if (count < 1 || count > MAX_DECK_ENTRY_COUNT) return false;
    total += count;
    if (total > MAX_DECK_TOTAL_CARDS) return false;
  }
  return true;
}

/**
 * Trim a display name and confirm it is present and bounded. A blank name is refused
 * outright: seat occupancy is keyed on a player having claimed a seat, and a blank
 * name also renders as an empty slot in the opponent's lobby.
 */
function normalizeName(x: unknown): string | null {
  if (typeof x !== 'string') return null;
  const name = x.trim();
  return isBoundedString(name, MAX_NAME_LENGTH) ? name : null;
}

/**
 * Parse a raw socket payload (string or Buffer) into a validated `ClientMessage`,
 * or `null` if it is not well-formed. Never throws.
 */
export function parseClientMessage(raw: string): ClientMessage | null {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isObject(data) || typeof data.t !== 'string') return null;

  switch (data.t) {
    case 'createRoom': {
      if (typeof data.protocolVersion !== 'number') return null;
      const name = normalizeName(data.name);
      if (name === null) return null;
      if (data.deck !== undefined && !isDeckList(data.deck)) return null;
      // §3.125 — optional, and a CLOSED set: a value outside it is refused rather
      // than widened to the nearest thing that happens to exist.
      if (data.startingPlayer !== undefined && !isStartingPlayerChoice(data.startingPlayer)) return null;
      return {
        t: 'createRoom',
        protocolVersion: data.protocolVersion,
        name,
        ...(data.deck !== undefined ? { deck: data.deck } : {}),
        ...(data.startingPlayer !== undefined ? { startingPlayer: data.startingPlayer } : {}),
      };
    }
    case 'joinRoom': {
      if (typeof data.protocolVersion !== 'number') return null;
      if (!isBoundedString(data.code, MAX_ROOM_CODE_LENGTH)) return null;
      const name = normalizeName(data.name);
      if (name === null) return null;
      if (data.deck !== undefined && !isDeckList(data.deck)) return null;
      return {
        t: 'joinRoom',
        protocolVersion: data.protocolVersion,
        code: data.code,
        name,
        ...(data.deck !== undefined ? { deck: data.deck } : {}),
      };
    }
    case 'reconnect': {
      if (typeof data.protocolVersion !== 'number') return null;
      if (!isBoundedString(data.code, MAX_ROOM_CODE_LENGTH)) return null;
      if (!isPlayerId(data.seat)) return null;
      if (!isBoundedString(data.token, MAX_RECONNECT_TOKEN_LENGTH)) return null;
      return {
        t: 'reconnect',
        protocolVersion: data.protocolVersion,
        code: data.code,
        seat: data.seat,
        token: data.token,
      };
    }
    case 'chooseDeck':
      if (!isDeckList(data.deck)) return null;
      return { t: 'chooseDeck', deck: data.deck };
    case 'setReady':
      if (typeof data.ready !== 'boolean') return null;
      return { t: 'setReady', ready: data.ready };
    case 'mulligan':
      if (typeof data.keep !== 'boolean') return null;
      return { t: 'mulligan', keep: data.keep };
    case 'submitAction':
      // The action's deep validity is the engine's job (it rejects cleanly); we
      // only confirm an action object is present and carries a `kind` string.
      if (!isObject(data.action) || typeof data.action.kind !== 'string') return null;
      return { t: 'submitAction', action: data.action as unknown as GameAction };
    case 'concede':
      return { t: 'concede' };
    case 'rematch':
      return { t: 'rematch' };
    case 'ping':
      return { t: 'ping' };
    default:
      return null;
  }
}

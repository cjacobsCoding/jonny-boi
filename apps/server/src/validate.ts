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

import type { GameAction } from '@jonny-boi/core';
import type { ClientMessage, DeckList } from '@jonny-boi/protocol';

function isObject(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null;
}

/** A `DeckList` is `{ name: string, cards: {cardId,count}[] }`. */
function isDeckList(x: unknown): x is DeckList {
  if (!isObject(x)) return false;
  if (typeof x.name !== 'string') return false;
  if (!Array.isArray(x.cards)) return false;
  return x.cards.every(
    (c) => isObject(c) && typeof c.cardId === 'string' && typeof c.count === 'number',
  );
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
    case 'createRoom':
      if (typeof data.protocolVersion !== 'number' || typeof data.name !== 'string') return null;
      if (data.deck !== undefined && !isDeckList(data.deck)) return null;
      return {
        t: 'createRoom',
        protocolVersion: data.protocolVersion,
        name: data.name,
        ...(data.deck !== undefined ? { deck: data.deck } : {}),
      };
    case 'joinRoom':
      if (
        typeof data.protocolVersion !== 'number' ||
        typeof data.code !== 'string' ||
        typeof data.name !== 'string'
      )
        return null;
      if (data.deck !== undefined && !isDeckList(data.deck)) return null;
      return {
        t: 'joinRoom',
        protocolVersion: data.protocolVersion,
        code: data.code,
        name: data.name,
        ...(data.deck !== undefined ? { deck: data.deck } : {}),
      };
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

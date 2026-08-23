import { describe, expect, it } from 'vitest';
import type {
  CardDefinition,
  CardInstance,
  GameState,
  ManaPool,
  PendingChoice,
  PlayerId,
  PlayerState,
} from '@jonny-boi/core';
import {
  collectInstanceIds,
  isRedactedChoice,
  leakedInstanceIds,
  maskStateForSeat,
  maskStateForSpectator,
  assertNever,
  PROTOCOL_VERSION,
  redactPendingChoice,
  type ClientMessage,
  type ServerMessage,
} from './index.js';

// --- minimal fixtures ----------------------------------------------------------

const emptyMana: ManaPool = { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 };
const bear: CardDefinition = { id: 'bear', name: 'Bear', types: ['creature'], power: 2, toughness: 2, cost: { generic: 2 } };

function inst(id: number, owner: PlayerId, zone: CardInstance['zone']): CardInstance {
  return {
    instanceId: id,
    def: bear,
    controller: owner,
    owner,
    zone,
    tapped: false,
    summoningSick: false,
    damageMarked: 0,
    markedByDeathtouch: false,
    counters: {},
  };
}

function player(id: PlayerId, handIds: number[], libIds: number[]): PlayerState {
  return {
    id,
    life: 20,
    manaPool: emptyMana,
    landsPlayedThisTurn: 0,
    hasLost: false,
    library: libIds.map((i) => inst(i, id, 'library')),
    hand: handIds.map((i) => inst(i, id, 'hand')),
    graveyard: [],
    exile: [],
    command: [],
  };
}

function makeState(): GameState {
  return {
    nextInstanceId: 1000,
    turnNumber: 3,
    activePlayer: 'A',
    priorityPlayer: 'A',
    step: 'precombatMain',
    players: {
      // A's secret card ids are 1xx; B's are 9xx so we can scan the serialized view for leaks.
      A: player('A', [101, 102, 103], [110, 111, 112, 113]),
      B: player('B', [901, 902], [910, 911, 912, 913, 914]),
    },
    battlefield: [inst(500, 'A', 'battlefield')],
    stack: [],
    continuous: [],
    combat: null,
    winner: null,
    gameOver: false,
    consecutivePasses: 0,
    seed: 1,
    rngState: 1,
  };
}

describe('maskStateForSeat', () => {
  it("reveals the viewer's own hand and hides the opponent's", () => {
    const view = maskStateForSeat(makeState(), 'A');
    expect(view.viewer).toBe('A');
    expect(view.players.A.hand).not.toBeNull();
    expect(view.players.A.hand).toHaveLength(3);
    expect(view.players.B.hand).toBeNull();
    // counts are always public
    expect(view.players.B.handCount).toBe(2);
    expect(view.players.B.libraryCount).toBe(5);
    expect(view.players.A.libraryCount).toBe(4);
    // public scalars + zones present for both
    expect(view.players.B.life).toBe(20);
    expect(view.battlefield).toHaveLength(1);
  });

  it('NEVER leaks the opponent hidden-card instance ids into the serialized view (anti-cheat)', () => {
    const json = JSON.stringify(maskStateForSeat(makeState(), 'A'));
    // B's hand (901/902) and library (910–914) ids must not appear anywhere in A's view.
    for (const hidden of [901, 902, 910, 911, 912, 913, 914]) {
      expect(json).not.toContain(String(hidden));
    }
    // A's own hand ids DO appear.
    expect(json).toContain('101');
  });

  it('is symmetric for seat B', () => {
    const view = maskStateForSeat(makeState(), 'B');
    expect(view.players.B.hand).toHaveLength(2);
    expect(view.players.A.hand).toBeNull();
    expect(view.players.A.handCount).toBe(3);
  });
});

// --- planeswalkers are PUBLIC (nothing about them may be redacted) -----------------

/**
 * A walker's LOYALTY is public information — it lives in the instance's counters,
 * printed on the battlefield for the whole table to read. The online board draws
 * its loyalty badge, its attackability and its loyalty-ability menu straight out of
 * the masked view, so if masking dropped or blanked any of it the client could not
 * show the mechanic at all. These pin that it survives for BOTH seats, the walker's
 * controller and their opponent alike, and for a spectator.
 */
describe('planeswalker visibility through masking', () => {
  const liliana: CardDefinition = {
    id: 'lili',
    name: 'Liliana of the Veil',
    types: ['planeswalker'],
    cost: { generic: 1, B: 2 },
    loyalty: 3,
    activated: [{ cost: { loyalty: 1 }, timing: 'sorcery', label: '+1: Each player discards a card.', effects: [] }],
  };

  function stateWithWalker(): GameState {
    const state = makeState();
    const walker: CardInstance = {
      ...inst(700, 'B', 'battlefield'),
      def: liliana,
      counters: { loyalty: 3 },
    };
    state.battlefield = [...state.battlefield, walker];
    return state;
  }

  it.each(['A', 'B'] as const)('shows seat %s the walker, its loyalty and its abilities', (seat) => {
    const view = maskStateForSeat(stateWithWalker(), seat);
    const walker = view.battlefield.find((c) => c.instanceId === 700);
    expect(walker, 'the walker is missing from the masked battlefield').toBeDefined();
    expect(walker?.counters.loyalty, 'loyalty is public and must survive masking').toBe(3);
    expect(walker?.def.types).toContain('planeswalker');
    // The loyalty-ability MENU is derived from `def.activated` + the server's legal
    // actions; a masked-away ability list would leave the menu permanently empty.
    expect(walker?.def.activated).toHaveLength(1);
    expect(walker?.controller).toBe('B');
  });

  it('shows a spectator the same public walker', () => {
    const walker = maskStateForSpectator(stateWithWalker()).battlefield.find((c) => c.instanceId === 700);
    expect(walker?.counters.loyalty).toBe(3);
  });
});

// --- pending-choice masking ------------------------------------------------------

/** A's hidden card ids, B's hidden card ids (see `makeState`). */
const A_HIDDEN = [101, 102, 103, 110, 111, 112, 113];
const B_HIDDEN = [901, 902, 910, 911, 912, 913, 914];

/**
 * The Thoughtseize shape: the CASTER (A) is asked to pick a card out of the
 * VICTIM's (B's) hand, so the choice legitimately carries B's hidden cards to
 * exactly one seat.
 */
function thoughtseizeChoice(chooser: PlayerId, candidateIds: readonly number[], owner: PlayerId): PendingChoice {
  return {
    kind: 'selectCards',
    id: 7,
    chooser,
    prompt: 'Choose a nonland card to discard',
    valence: 'loss',
    sourceInstanceId: 500,
    sourceName: 'Thoughtseize',
    min: 1,
    max: 1,
    ordered: false,
    fromZone: 'hand',
    candidates: candidateIds.map((id) => ({
      instanceId: id,
      cardId: 'bear',
      name: 'Bear',
      zone: 'hand' as const,
      controller: owner,
    })),
  };
}

function stateWithChoice(choice: PendingChoice): GameState {
  return { ...makeState(), pendingChoice: choice };
}

describe('collectInstanceIds (structural leak scan)', () => {
  it('finds ids at any depth and ignores equal-looking numbers elsewhere', () => {
    const ids = collectInstanceIds({ life: 20, deep: [{ nested: { instanceId: 42 } }], count: 42 });
    expect([...ids]).toEqual([42]);
    // A digit-prefix must not count as a mention (the trap a regex falls into).
    expect(leakedInstanceIds({ instanceId: 75 }, [7])).toEqual([]);
    expect(leakedInstanceIds({ instanceId: 7 }, [7])).toEqual([7]);
  });

  it('survives a cyclic structure', () => {
    const node: Record<string, unknown> = { instanceId: 3 };
    node.self = node;
    expect([...collectInstanceIds(node)]).toEqual([3]);
  });

  /*
   * ⚠️ THE HOLE THIS SCAN USED TO HAVE, PINNED.
   *
   * It recognised keys named exactly `instanceId`. Everything below names a card
   * under a different key, and every one of them used to be invisible — which is
   * how a `choiceAsked.sourceInstanceId` pointing into a player's HAND travelled
   * to every pilot with a green anti-cheat suite.
   *
   * The vocabulary is not written here or in `index.ts`: it comes from core's
   * `INSTANCE_ID_FIELD_NAMES`, which is derived from a mapped type over every
   * field of every `GameEvent`. These cases are the check that the wiring is
   * real, not the definition of what counts.
   */
  it('finds an id under EVERY name the engine spells it with', () => {
    const cases: ReadonlyArray<readonly [string, unknown]> = [
      ['sourceInstanceId', { sourceInstanceId: 11 }],
      ['targetInstanceId', { targetInstanceId: 11 }],
      ['keptInstanceId', { keptInstanceId: 11 }],
      ['hostInstanceId', { hostInstanceId: 11 }],
      ['copiedInstanceId', { copiedInstanceId: 11 }],
      ['appliesToInstanceId', { appliesToInstanceId: 11 }],
      ['source', { source: 11 }],
      ['target', { target: 11 }],
      ['ref', { ref: 11 }],
      ['attachedTo', { attachedTo: 11 }],
      ['recipientIs', { recipientIs: 11 }],
      ['targets (array)', { targets: [11, 'A'] }],
      ['attackers (array)', { attackers: [11] }],
      ['instanceIds (array)', { instanceIds: [11] }],
      ['blocks (id-keyed map)', { blocks: { 11: 12 } }],
      ['attackTargets (id-keyed map)', { attackTargets: { 11: 'B' } }],
      ['nested in an array of objects', { blocks: [{ blocker: 11, attacker: 12 }] }],
      ['nested at depth', { a: [{ b: { sourceInstanceId: 11 } }] }],
      // The BACKSTOP: names declared OUTSIDE core, where no table forces a
      // classification (`swappedInstanceIds` in the sim, `knownInstanceIds` in a
      // pilot's belief state) — caught by the `…instanceId(s)` suffix rule.
      ['a conventionally-named key core has never heard of', { swappedInstanceIds: [11] }],
      ['…and a scalar one', { victimInstanceId: 11 }],
    ];
    const missed = cases.filter(([, value]) => !collectInstanceIds(value).has(11)).map(([name]) => name);
    expect(missed, 'these ways of naming a card are invisible to the anti-cheat scan').toEqual([]);
  });

  it('reads the KEYS of an id-keyed map, not only its values', () => {
    // `attackTargets` is attacker-id → attacked object. A scan that read only the
    // values would report exactly half of a leak, and read as thorough.
    expect([...collectInstanceIds({ attackTargets: { 41: 'B' } })]).toEqual([41]);
    expect([...collectInstanceIds({ blocks: { 41: 42 } })].sort((a, b) => a - b)).toEqual([41, 42]);
  });

  it('still ignores a number that only LOOKS like an id', () => {
    // The widening must not become "collect every number": instance ids are
    // minted from 1 upward, so they collide constantly with counts and totals.
    const ids = collectInstanceIds({ life: 20, choiceId: 7, optionCount: 42, id: 3, handCount: 5, turnNumber: 9 });
    expect([...ids]).toEqual([]);
  });
});

describe('pendingChoice masking', () => {
  it('is null when no question is parked', () => {
    expect(maskStateForSeat(makeState(), 'A').pendingChoice).toBeNull();
    expect(maskStateForSpectator(makeState()).pendingChoice).toBeNull();
  });

  it('gives the CHOOSER the full question, candidates included', () => {
    const state = stateWithChoice(thoughtseizeChoice('A', [901, 902], 'B'));
    const choice = maskStateForSeat(state, 'A').pendingChoice;
    expect(choice).not.toBeNull();
    expect(isRedactedChoice(choice!)).toBe(false);
    // Thoughtseize really does show the caster the victim's hand — that is the card.
    // 500 is the ASKING CARD itself (`sourceInstanceId`, sitting on the public
    // stack). It shows up here only because the scan was widened past the single
    // key name `instanceId`; under the old scan the Thoughtseize was invisible to
    // it — which is the blind spot two real hidden-information leaks hid in.
    expect(collectInstanceIds(choice)).toEqual(new Set([500, 901, 902]));
    expect(choice).toMatchObject({ prompt: 'Choose a nonland card to discard', chooser: 'A' });
  });

  it('gives the OTHER seat a summary with no payload', () => {
    const state = stateWithChoice(thoughtseizeChoice('A', [901, 902], 'B'));
    const choice = maskStateForSeat(state, 'B').pendingChoice!;
    expect(isRedactedChoice(choice)).toBe(true);
    expect(choice).toEqual({ redacted: true, id: 7, chooser: 'A', sourceName: 'Thoughtseize', kind: 'selectCards' });
    // The summary carries no candidates, no prompt, no source instance.
    expect(collectInstanceIds(choice).size).toBe(0);
    expect('candidates' in choice).toBe(false);
    expect('prompt' in choice).toBe(false);
  });

  it("never carries the opponent's hidden cards to the seat that is NOT choosing", () => {
    // The reverse case: B is asked about B's OWN hand (Brainstorm's put-back), so
    // A must gain nothing — A's whole view is scanned, not just the choice.
    const state = stateWithChoice(thoughtseizeChoice('B', [901, 902], 'B'));
    const aView = maskStateForSeat(state, 'A');
    expect(leakedInstanceIds(aView, B_HIDDEN)).toEqual([]);
    // ...and symmetrically, with A choosing about A's own hand, B learns nothing.
    const bView = maskStateForSeat(stateWithChoice(thoughtseizeChoice('A', [101, 102], 'A')), 'B');
    expect(leakedInstanceIds(bView, A_HIDDEN)).toEqual([]);
  });

  it('never carries ANY hidden card to a spectator', () => {
    const state = stateWithChoice(thoughtseizeChoice('A', [901, 902], 'B'));
    const view = maskStateForSpectator(state);
    expect(view.players.A.hand).toBeNull();
    expect(view.players.B.hand).toBeNull();
    expect(isRedactedChoice(view.pendingChoice!)).toBe(true);
    expect(leakedInstanceIds(view, [...A_HIDDEN, ...B_HIDDEN])).toEqual([]);
  });

  it('redacts every choice kind down to the same four public fields', () => {
    const modal: PendingChoice = {
      kind: 'chooseModes',
      id: 12,
      chooser: 'B',
      prompt: 'Choose two —',
      valence: 'gain',
      sourceInstanceId: 501,
      sourceName: 'Cryptic Command',
      min: 2,
      max: 2,
      modes: [
        { id: 'counter', label: 'Counter target spell' },
        { id: 'draw', label: 'Draw a card' },
      ],
    };
    expect(redactPendingChoice(modal)).toEqual({
      redacted: true,
      id: 12,
      chooser: 'B',
      sourceName: 'Cryptic Command',
      kind: 'chooseModes',
    });
    // The modes (which a modal spell's own controller chooses) do not travel.
    expect(JSON.stringify(redactPendingChoice(modal))).not.toContain('Counter target spell');
  });
});

describe('message contract', () => {
  it('has a protocol version', () => {
    expect(PROTOCOL_VERSION).toBeGreaterThanOrEqual(1);
  });

  // Compile-time exhaustiveness: these switches fail to compile if a variant is
  // added without being handled, so adding a message tag can't silently slip through.
  it('every ClientMessage tag is handled', () => {
    const tagOf = (m: ClientMessage): string => {
      switch (m.t) {
        case 'createRoom':
        case 'joinRoom':
        case 'chooseDeck':
        case 'setReady':
        case 'mulligan':
        case 'submitAction':
        case 'concede':
        case 'rematch':
        case 'ping':
          return m.t;
        default:
          return assertNever(m);
      }
    };
    expect(tagOf({ t: 'ping' })).toBe('ping');
  });

  it('every ServerMessage tag is handled', () => {
    const tagOf = (m: ServerMessage): string => {
      switch (m.t) {
        case 'roomJoined':
        case 'lobby':
        case 'gameStarted':
        case 'mulliganPrompt':
        case 'state':
        case 'gameOver':
        case 'opponentDisconnected':
        case 'opponentReconnected':
        case 'error':
        case 'pong':
          return m.t;
        default:
          return assertNever(m);
      }
    };
    expect(tagOf({ t: 'pong' })).toBe('pong');
  });
});

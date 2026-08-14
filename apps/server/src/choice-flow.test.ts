/**
 * The ONLINE PLAYER-CHOICE loop, driven end to end through real games.
 *
 * A resolving card that asks a question used to be a hard dead end online: the
 * engine parked a `PendingChoice`, the seat's whole legal menu collapsed to opaque
 * `answerChoice` actions, and `MaskedGameView` carried no question to render. These
 * tests drive the transport-free `Room` with fake connections (no sockets) through
 * two real choice cards and assert the whole loop: the chooser is told the question,
 * the other seat and any spectator are told only that a question exists, an answer
 * from the wrong seat or naming the wrong choice is refused, and answering resumes
 * the half-finished resolution for everyone.
 *
 * ## The anti-cheat assertion
 * The leak check is STRUCTURAL, not textual: `collectInstanceIds` walks a whole
 * transcript and collects every `instanceId` at any depth. A regex over serialized
 * JSON gets this wrong in both directions — it false-positives when one seat's id is
 * a digit-prefix of the other's, and it silently misses an id carried under a field
 * name nobody thought to grep for. And the scan runs over a connection's ENTIRE
 * message history, not one message, because a leak that happens once is a leak.
 */

import {
  DEFAULT_RULES,
  isTrivialChoice,
  PLAYER_IDS,
  type ChoiceAnswer,
  type GameAction,
  type PendingChoice,
  type PlayerId,
} from '@jonny-boi/core';
import {
  collectInstanceIds,
  isRedactedChoice,
  leakedInstanceIds,
  type DeckList,
  type ServerMessage,
} from '@jonny-boi/protocol';
import { describe, expect, it } from 'vitest';
import type { Connection } from './room.js';
import { Room } from './room.js';

// --- fixtures ---------------------------------------------------------------------

/** A fake connection: records every message the server sends it. */
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

/** Deck legality, mirrored from the sim's loader so the fixtures below stay legal. */
const MIN_DECK_SIZE = 60;
const MAX_COPIES_NONBASIC = 4;

/**
 * Two single-choice-card decks. Each is a basic land plus the maximum legal count of
 * ONE choice card, which makes the card reliably drawable and every other card in
 * the deck inert — so a test that reaches a question reached it through that card.
 */
function monoDeck(name: string, basic: string, spell: string): DeckList {
  return {
    name,
    cards: [
      { cardId: basic, count: MIN_DECK_SIZE - MAX_COPIES_NONBASIC },
      { cardId: spell, count: MAX_COPIES_NONBASIC },
    ],
  };
}

/** "Draw three, then put two from your hand on top in any order" — the chooser owns the cards. */
const BRAINSTORM_DECK = monoDeck('Brainstorm Blue', 'Island', 'Brainstorm');
/** "Target player reveals their hand. YOU choose a nonland card" — the chooser is the opponent's opponent. */
const THOUGHTSEIZE_DECK = monoDeck('Seize Black', 'Swamp', 'Thoughtseize');

/**
 * How many seeds to try when looking for an opening hand that can cast the card
 * under test. Searching beats hard-coding a magic seed: the test survives a pool or
 * shuffle change, and stays fully deterministic (seeds are tried in order, no RNG).
 */
const MAX_SEED_SEARCH = 500;

/** A room with both seats filled, a spectator watching, and both openers kept. */
interface OnlineGame {
  readonly room: Room;
  readonly conns: Readonly<Record<PlayerId, FakeConnection>>;
  readonly spectator: FakeConnection;
}

/** Seat two players + a spectator into a fresh room on a given seed, pre-mulligan. */
function seatEveryone(seed: number, decks: Readonly<Record<PlayerId, DeckList>>): OnlineGame {
  const room = new Room('TEST', DEFAULT_RULES, seed);
  const conns = { A: new FakeConnection('a'), B: new FakeConnection('b') } as const;
  const spectator = new FakeConnection('spectator');
  room.createSeat(conns.A, 'Alice', decks.A);
  room.join(conns.B, 'Bob', decks.B);
  room.join(spectator, 'Watcher');
  for (const id of PLAYER_IDS) room.setReady(conns[id], true);
  return { room, conns, spectator };
}

/** The opening hand a seat was prompted with, by card name. */
function openingHandNames(conn: FakeConnection): string[] {
  return (conn.last('mulliganPrompt')?.hand ?? []).map((c) => c.def.name);
}

/**
 * The first seeded game whose opening hands satisfy `wanted`, with both players
 * keeping. Throws rather than silently testing nothing if the search is exhausted.
 */
function startedGameWhere(
  decks: Readonly<Record<PlayerId, DeckList>>,
  wanted: (hands: Readonly<Record<PlayerId, string[]>>) => boolean,
): OnlineGame {
  for (let seed = 1; seed <= MAX_SEED_SEARCH; seed++) {
    const game = seatEveryone(seed, decks);
    const hands = { A: openingHandNames(game.conns.A), B: openingHandNames(game.conns.B) };
    if (!wanted(hands)) continue;
    for (const id of PLAYER_IDS) game.room.mulligan(game.conns[id], true);
    return game;
  }
  throw new Error(`no seed within ${MAX_SEED_SEARCH} dealt the opening hands this test needs`);
}

// --- driving the game -------------------------------------------------------------

/** The latest board frame a connection holds (every action broadcasts a fresh one). */
function frameOf(conn: FakeConnection): Extract<ServerMessage, { t: 'state' }> {
  const frame = conn.last('state');
  if (!frame) throw new Error(`${conn.id} has no board yet`);
  return frame;
}

/** A bound on how many priority passes a step walk may take before we call it stuck. */
const MAX_PASSES = 40;

/** Pass priority (whoever holds it) until `player`'s own precombat main phase. */
function passToMainPhaseOf(game: OnlineGame, player: PlayerId): void {
  for (let i = 0; i < MAX_PASSES; i++) {
    const view = frameOf(game.conns[player]).view;
    if (view.step === 'precombatMain' && view.activePlayer === player && view.priorityPlayer === player) return;
    const holder = view.priorityPlayer;
    game.room.submitAction(game.conns[holder], { kind: 'passPriority', player: holder });
  }
  throw new Error(`never reached ${player}'s main phase`);
}

/** Find a card by name in a seat's own (revealed) hand. */
function handCard(game: OnlineGame, seat: PlayerId, name: string): { instanceId: number } {
  const hand = frameOf(game.conns[seat]).view.players[seat].hand ?? [];
  const found = hand.find((c) => c.def.name === name);
  if (!found) throw new Error(`${seat} has no ${name} in hand`);
  return found;
}

/**
 * Play a land, tap it, cast the named spell, then let it resolve — the exact action
 * sequence a real client sends. Returns once a question is parked (or the stack has
 * emptied without one, which the caller asserts against).
 */
function castAndResolve(
  game: OnlineGame,
  caster: PlayerId,
  landName: string,
  spellName: string,
  targets: ReadonlyArray<number | PlayerId> = [],
): void {
  passToMainPhaseOf(game, caster);
  const conn = game.conns[caster];
  const land = handCard(game, caster, landName);
  const spell = handCard(game, caster, spellName);
  game.room.submitAction(conn, { kind: 'playLand', player: caster, instanceId: land.instanceId });
  game.room.submitAction(conn, { kind: 'tapForMana', player: caster, instanceId: land.instanceId });
  game.room.submitAction(conn, { kind: 'castSpell', player: caster, instanceId: spell.instanceId, targets });
  for (let i = 0; i < MAX_PASSES; i++) {
    const view = frameOf(conn).view;
    if (view.pendingChoice || view.stack.length === 0) return;
    const holder = view.priorityPlayer;
    game.room.submitAction(game.conns[holder], { kind: 'passPriority', player: holder });
  }
}

/** The FULL question a seat holds — fails loudly if it only got a summary. */
function fullChoiceOf(conn: FakeConnection): PendingChoice {
  const choice = frameOf(conn).view.pendingChoice;
  if (!choice) throw new Error(`${conn.id} was told about no question`);
  if (isRedactedChoice(choice)) throw new Error(`${conn.id} only got a summary`);
  return choice;
}

/** A legal answer built from the choice's own candidates (order = the order picked). */
function answerFirstCandidates(choice: PendingChoice): ChoiceAnswer {
  if (choice.kind !== 'selectCards') throw new Error(`expected a card selection, got ${choice.kind}`);
  return { kind: 'selectCards', instanceIds: choice.candidates.slice(0, choice.min).map((c) => c.instanceId) };
}

// --- transcript scanning (the anti-cheat instrument) -------------------------------

/** Every id that ever sat in a PUBLIC zone in this transcript — legitimately visible. */
function publicIdsIn(sent: readonly ServerMessage[]): Set<number> {
  const ids = new Set<number>();
  for (const msg of sent) {
    if (msg.t !== 'state') continue;
    const { view } = msg;
    const publicZones = [
      view.battlefield,
      view.stack,
      ...PLAYER_IDS.map((id) => view.players[id].graveyard),
      ...PLAYER_IDS.map((id) => view.players[id].exile),
    ];
    for (const id of collectInstanceIds(publicZones)) ids.add(id);
  }
  return ids;
}

/**
 * The ids a seat holds that NOBODY else is entitled to see: every card that was ever
 * in its own hand, minus anything that has since become public (a land it played, a
 * spell it cast, a card it discarded). Derived from that seat's OWN transcript,
 * which is the only place its hand is ever revealed.
 */
function hiddenIdsOf(conn: FakeConnection, seat: PlayerId): number[] {
  const own = new Set<number>();
  for (const msg of conn.sent) {
    if (msg.t === 'mulliganPrompt') for (const id of collectInstanceIds(msg.hand)) own.add(id);
    if (msg.t === 'state') for (const id of collectInstanceIds(msg.view.players[seat].hand ?? [])) own.add(id);
  }
  const madePublic = publicIdsIn(conn.sent);
  return [...own].filter((id) => !madePublic.has(id));
}

// --- the tests ---------------------------------------------------------------------

describe('online player choice: the full loop', () => {
  /** B casts Brainstorm: the chooser is the CASTER, over cards the caster already owns. */
  function brainstormGame(): OnlineGame {
    const decks = { A: BRAINSTORM_DECK, B: BRAINSTORM_DECK };
    const game = startedGameWhere(
      decks,
      (h) => h.B.includes('Island') && h.B.includes('Brainstorm'),
    );
    castAndResolve(game, 'B', 'Island', 'Brainstorm');
    return game;
  }

  it('tells the chooser the question and the other seat only that one exists', () => {
    const game = brainstormGame();

    const choice = fullChoiceOf(game.conns.B);
    expect(choice.chooser).toBe('B');
    expect(choice.sourceName).toBe('Brainstorm');
    expect(choice.prompt.length).toBeGreaterThan(0);
    // A real question, not one the engine would have auto-answered.
    expect(isTrivialChoice(choice)).toBe(false);

    // The chooser holds priority and has answers to give.
    const bFrame = frameOf(game.conns.B);
    expect(bFrame.yourTurn).toBe(true);
    expect(bFrame.legalActions.every((a) => a.kind === 'answerChoice')).toBe(true);

    // The other seat is told a question is open, by whom and from what — nothing else.
    const aChoice = frameOf(game.conns.A).view.pendingChoice!;
    expect(isRedactedChoice(aChoice)).toBe(true);
    expect(aChoice).toEqual({
      redacted: true,
      id: choice.id,
      chooser: 'B',
      sourceName: 'Brainstorm',
      kind: choice.kind,
    });
    expect(frameOf(game.conns.A).yourTurn).toBe(false);

    // A spectator gets the same summary and no hands at all.
    const specView = frameOf(game.spectator).view;
    expect(isRedactedChoice(specView.pendingChoice!)).toBe(true);
    expect(PLAYER_IDS.every((id) => specView.players[id].hand === null)).toBe(true);
  });

  it('answering resumes the resolution and resyncs every client', () => {
    const game = brainstormGame();
    const choice = fullChoiceOf(game.conns.B);
    const handBefore = frameOf(game.conns.B).view.players.B.handCount;
    const libraryBefore = frameOf(game.conns.B).view.players.B.libraryCount;

    game.room.submitAction(game.conns.B, {
      kind: 'answerChoice',
      player: 'B',
      choiceId: choice.id,
      answer: answerFirstCandidates(choice),
    });

    // The question is gone for everyone, and the spell finished resolving.
    for (const conn of [game.conns.A, game.conns.B, game.spectator]) {
      expect(frameOf(conn).view.pendingChoice).toBeNull();
      expect(frameOf(conn).view.stack).toHaveLength(0);
    }
    // Brainstorm's back half really happened: two cards left the hand for the library.
    const after = frameOf(game.conns.B).view.players.B;
    expect(after.handCount).toBe(handBefore - choice.min);
    expect(after.libraryCount).toBe(libraryBefore + choice.min);
    // And the game is playable again rather than parked.
    expect(frameOf(game.conns.B).legalActions.some((a) => a.kind === 'passPriority')).toBe(true);
  });

  it('refuses an answer from the WRONG seat, leaving the question intact', () => {
    const game = brainstormGame();
    const choice = fullChoiceOf(game.conns.B);
    const answer = answerFirstCandidates(choice);

    // A answering for itself: A does not hold priority.
    game.room.submitAction(game.conns.A, { kind: 'answerChoice', player: 'A', choiceId: choice.id, answer });
    expect(game.conns.A.last('error')!.code).toBe('notYourTurn');

    // A impersonating B: refused before the engine ever sees it.
    game.room.submitAction(game.conns.A, { kind: 'answerChoice', player: 'B', choiceId: choice.id, answer });
    expect(game.conns.A.last('error')!.code).toBe('notYourTurn');

    // A spectator answering: refused as not-in-room.
    game.room.submitAction(game.spectator, { kind: 'answerChoice', player: 'B', choiceId: choice.id, answer });
    expect(game.spectator.last('error')!.code).toBe('notInRoom');

    // The question is still open and still B's to answer.
    expect(fullChoiceOf(game.conns.B).id).toBe(choice.id);
  });

  it('refuses a stale / mismatched choiceId, then accepts the right one', () => {
    const game = brainstormGame();
    const choice = fullChoiceOf(game.conns.B);
    const answer = answerFirstCandidates(choice);

    game.room.submitAction(game.conns.B, {
      kind: 'answerChoice',
      player: 'B',
      choiceId: choice.id + 1,
      answer,
    });
    expect(game.conns.B.last('error')!.code).toBe('illegalAction');
    expect(fullChoiceOf(game.conns.B).id).toBe(choice.id);

    game.room.submitAction(game.conns.B, { kind: 'answerChoice', player: 'B', choiceId: choice.id, answer });
    expect(frameOf(game.conns.B).view.pendingChoice).toBeNull();
  });
});

describe('online player choice: anti-cheat', () => {
  it("never carries the chooser's own hidden cards to the opponent or a spectator", () => {
    // Brainstorm's candidates ARE B's hand: the seat that must not learn them is A.
    const game = startedGameWhere(
      { A: BRAINSTORM_DECK, B: BRAINSTORM_DECK },
      (h) => h.B.includes('Island') && h.B.includes('Brainstorm'),
    );
    castAndResolve(game, 'B', 'Island', 'Brainstorm');
    const choice = fullChoiceOf(game.conns.B);
    expect(choice.kind).toBe('selectCards');

    const bHidden = hiddenIdsOf(game.conns.B, 'B');
    expect(bHidden.length).toBeGreaterThan(0); // the scan has something to find

    // Positive control: B's OWN transcript does mention them, so a leak is detectable.
    expect(leakedInstanceIds(game.conns.B.sent, bHidden).length).toBe(bHidden.length);
    // The verdict: A's and the spectator's ENTIRE transcripts mention none of them.
    expect(leakedInstanceIds(game.conns.A.sent, bHidden)).toEqual([]);
    expect(leakedInstanceIds(game.spectator.sent, bHidden)).toEqual([]);
  });

  it('reveals the victim hand to the CASTER only (Thoughtseize)', () => {
    // Thoughtseize inverts the ownership: the chooser is A, and the candidates are
    // B's hand. A seeing them is the card working; anyone else seeing them is a leak.
    const game = startedGameWhere(
      { A: THOUGHTSEIZE_DECK, B: BRAINSTORM_DECK },
      (h) =>
        h.A.includes('Swamp') &&
        h.A.includes('Thoughtseize') &&
        // Two nonlands, or the pick has a single legal answer and the engine
        // auto-answers it without ever asking.
        h.B.filter((n) => n === 'Brainstorm').length > 1,
    );
    castAndResolve(game, 'A', 'Swamp', 'Thoughtseize', ['B']);

    const choice = fullChoiceOf(game.conns.A);
    expect(choice.chooser).toBe('A');
    expect(choice.sourceName).toBe('Thoughtseize');
    const candidateIds = [...collectInstanceIds(choice)];
    expect(candidateIds.length).toBeGreaterThan(1);

    // The victim is told only that A is choosing, with no hint of which cards.
    const bChoice = frameOf(game.conns.B).view.pendingChoice!;
    expect(isRedactedChoice(bChoice)).toBe(true);
    expect(collectInstanceIds(bChoice).size).toBe(0);

    // The spectator's whole transcript never mentions B's hidden cards — the case
    // the old server-assembled spectator view would have leaked.
    const bHidden = hiddenIdsOf(game.conns.B, 'B');
    expect(bHidden.length).toBeGreaterThan(0);
    expect(leakedInstanceIds(game.spectator.sent, bHidden)).toEqual([]);
    // ...and B never learns A's hand either.
    const aHidden = hiddenIdsOf(game.conns.A, 'A');
    expect(leakedInstanceIds(game.conns.B.sent, aHidden)).toEqual([]);
    expect(leakedInstanceIds(game.spectator.sent, aHidden)).toEqual([]);

    // The caster's pick really is applied: B discards the card A named.
    const taken = (choice as Extract<PendingChoice, { kind: 'selectCards' }>).candidates[0]!;
    const answer: GameAction = {
      kind: 'answerChoice',
      player: 'A',
      choiceId: choice.id,
      answer: { kind: 'selectCards', instanceIds: [taken.instanceId] },
    };
    game.room.submitAction(game.conns.A, answer);
    const bGraveyard = frameOf(game.conns.B).view.players.B.graveyard;
    expect(bGraveyard.some((c) => c.instanceId === taken.instanceId)).toBe(true);
  });
});

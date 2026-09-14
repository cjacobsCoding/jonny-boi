/**
 * ONLINE UI PARITY, proven on a live two-client game.
 *
 * The recorded failure this closes: engine mechanics shipped that the ONLINE board
 * could not reach. Planeswalkers became attackable and gained loyalty abilities;
 * flashback made graveyard casts legal; {X} costs park a cast-time question. All
 * three were in the server's `legalActions` and none had an affordance online, so
 * they were inert for every networked player — the repo's "an inert feature is not
 * done" rule, failed three times.
 *
 * ## Why this file lives here and looks like this
 * It drives the REAL transport-free `Room` with fake connections (the pattern from
 * `land-playability.test.ts`) — two seated clients, a real engine, real per-seat
 * masking — and then asks the ACTUAL CLIENT CODE what the board would show and
 * submit. Every affordance below is computed by the very functions
 * `OnlineBoard.tsx` calls (`zonePanelView`, `graveyardCastChoices`,
 * `graveyardCastableWithTaps`, `abilityChoices`, `maskedViewToBoardView`,
 * `buildDeclareAttackersAction`, `castSequence`, `onlineChoiceView`,
 * `answerChoiceAction`), so a test that passes here cannot pass while the board is
 * dead: the assertions ARE the board's props and the actions ARE the board's
 * submissions. That is the DOM assert, minus a renderer that would add nothing.
 *
 * ## The pool caveat, stated honestly
 * The shipped card pool contains exactly ONE card for these mechanics — Liliana of
 * the Veil — and NO card with flashback, {X} or kicker (the sibling branches that
 * built those systems added no pool data; the importer path supplies them). A
 * `DeckList` can only name cards the server's pool knows, so the flashback and {X}
 * games are dealt from a pool built with `loadCardPool({ extraCards })` — the same
 * seam the web app already uses for imported decks — injected through the `Room`
 * constructor. Everything else is production code on the production path.
 */

import {
  DEFAULT_RULES,
  isLand,
  isPlaneswalker,
  PLAYER_IDS,
  type CardDefinition,
  type GameAction,
  type InstanceId,
  type PlayerId,
} from '@jonny-boi/core';
import { loadCardPool, type CardPool } from '@jonny-boi/cards';
import type { DeckList, MaskedGameView, ServerMessage } from '@jonny-boi/protocol';
import { describe, expect, it } from 'vitest';
import { Room, type Connection } from './room.js';
// The CLIENT's own pure board logic. Importing it is the point: these are the
// functions the online board renders and submits from.
import {
  abilityChoices,
  castChoices,
  declareAttackersAction,
  graveyardCastChoices,
} from '../../web/src/lib/online/legal-actions.js';
import { castSequence, graveyardCastableWithTaps } from '../../web/src/lib/online/auto-tap.js';
import { maskedViewToBoardView } from '../../web/src/lib/online/board-adapter.js';
import { answerChoiceAction, onlineChoiceView } from '../../web/src/lib/online/pending-choice.js';
import { zonePanelView } from '../../web/src/lib/play/zone-panel.js';
import { buildDeclareAttackersAction } from '../../web/src/lib/play/session.js';

// --- fixtures ---------------------------------------------------------------------

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

const DECK_SIZE = 60;
const SPELL_COPIES = 4;
const NAMES: Readonly<Record<PlayerId, string>> = { A: 'Alice', B: 'Bob' };

/** A legal 60-card deck: one basic land plus four copies of one spell. */
function monoDeck(name: string, basic: string, spell: string): DeckList {
  return {
    name,
    cards: [
      { cardId: basic, count: DECK_SIZE - SPELL_COPIES },
      { cardId: spell, count: SPELL_COPIES },
    ],
  };
}

interface Game {
  readonly room: Room;
  readonly conns: Readonly<Record<PlayerId, FakeConnection>>;
}

/** Seat both players with the given decks, ready up, and keep both opening hands. */
function startedGame(decks: Record<PlayerId, DeckList>, seed = 7, pool?: CardPool): Game {
  const room = new Room('TEST', DEFAULT_RULES, seed, pool);
  const conns = { A: new FakeConnection('a'), B: new FakeConnection('b') } as const;
  room.createSeat(conns.A, NAMES.A, decks.A);
  room.join(conns.B, NAMES.B, decks.B);
  for (const id of PLAYER_IDS) room.setReady(conns[id], true);
  for (const id of PLAYER_IDS) room.mulligan(conns[id], true);
  return { room, conns };
}

/** The latest frame the server pushed to a seat — exactly what the board renders. */
function frameOf(game: Game, seat: PlayerId): {
  view: MaskedGameView;
  legalActions: readonly GameAction[];
  yourTurn: boolean;
  log: readonly string[];
} {
  const state = game.conns[seat].last('state');
  if (!state) throw new Error(`seat ${seat} was never sent a state`);
  return { view: state.view, legalActions: state.legalActions, yourTurn: state.yourTurn, log: state.log };
}

/** The seat currently holding priority, from either client's (public) view. */
function priorityHolder(game: Game): PlayerId {
  return frameOf(game, 'A').view.priorityPlayer;
}

function submit(game: Game, seat: PlayerId, action: GameAction): void {
  game.room.submitAction(game.conns[seat], action);
}

/**
 * A minimal "just play the deck" pilot for the driver below: play a land if
 * offered, cast the named spell when the server offers it, tap a LAND toward it
 * otherwise, and pass when there is nothing else. It deliberately never declares
 * attackers — the tests below do that themselves, so the drive never spends the
 * combat step it is driving toward.
 */
function autopilotAction(
  view: MaskedGameView,
  legalActions: readonly GameAction[],
  seat: PlayerId,
  spellName: string,
): GameAction {
  const land = legalActions.find((a) => a.kind === 'playLand');
  if (land) return land;
  const cast = legalActions.find(
    (a) => a.kind === 'castSpell' && nameOfInstance(view, a.instanceId) === spellName,
  );
  if (cast) return cast;
  // Tap ONLY while actually working toward the wanted spell, and only LANDS.
  // Tapping for its own sake is what a greedy driver does, and it silently ruins
  // the very thing several of these tests measure: a board with everything tapped
  // can fund no flashback and no {X} above zero, so the affordance under test
  // would look absent when it is really just unfunded.
  //
  // The WINDOW matters as much as the intent: mana empties at the end of every
  // step, so tapping in upkeep spends the land for nothing and leaves the main
  // phase with an empty pool and a tapped board. A driver that did that never
  // cast a three-mana card in fifty turns while looking like it was trying.
  const wants = (view.players[seat].hand ?? []).some((c) => c.def.name === spellName);
  const sorceryWindow =
    view.activePlayer === seat &&
    (view.step === 'precombatMain' || view.step === 'postcombatMain') &&
    view.stack.length === 0;
  if (wants && sorceryWindow) {
    const tap = legalActions.find(
      (a) =>
        a.kind === 'tapForMana' &&
        view.battlefield.some((c) => c.instanceId === a.instanceId && isLand(c.def)),
    );
    if (tap) return tap;
  }
  return { kind: 'passPriority', player: seat };
}

/** Resolve an instance id to its card name across the zones a seat can see. */
function nameOfInstance(view: MaskedGameView, id: InstanceId): string | undefined {
  const onBoard = view.battlefield.find((c) => c.instanceId === id);
  if (onBoard) return onBoard.def.name;
  for (const seat of PLAYER_IDS) {
    const player = view.players[seat];
    const found = (player.hand ?? []).find((c) => c.instanceId === id) ??
      player.graveyard.find((c) => c.instanceId === id);
    if (found) return found.def.name;
  }
  return undefined;
}

/**
 * Play the game forward with both seats on autopilot until `done` is satisfied.
 * Bounded: a game that never reaches the condition fails loudly with the board
 * state rather than hanging the suite.
 */
function driveUntil(
  game: Game,
  spells: Readonly<Record<PlayerId, string>>,
  done: (game: Game) => boolean,
  maxActions = 1500,
): void {
  for (let i = 0; i < maxActions; i++) {
    if (done(game)) return;
    const holder = priorityHolder(game);
    const { view, legalActions } = frameOf(game, holder);
    if (legalActions.length === 0) throw new Error(`seat ${holder} has no legal action at all`);
    submit(game, holder, autopilotAction(view, legalActions, holder, spells[holder]));
  }
  const a = frameOf(game, 'A').view;
  throw new Error(
    `never reached the target state (turn ${a.turnNumber}, step ${a.step}, board: ` +
      `${a.battlefield.map((c) => `${c.def.name}/${c.controller}`).join(', ')})`,
  );
}

/** Pass priority (both seats, alternately) until `done` — no plays, just advance. */
function passUntil(game: Game, done: (game: Game) => boolean, maxPasses = 60): void {
  for (let i = 0; i < maxPasses; i++) {
    if (done(game)) return;
    const holder = priorityHolder(game);
    submit(game, holder, { kind: 'passPriority', player: holder });
  }
  throw new Error('never reached the target state while passing');
}

// ==================================================================================
// 1. Walker attacks + loyalty abilities, on the real online path.
// ==================================================================================

const ELVES = 'Llanowar Elves';
const LILIANA = 'Liliana of the Veil';

/** A controls green mana dorks; B casts a planeswalker to be attacked. */
const WALKER_DECKS: Record<PlayerId, DeckList> = {
  A: monoDeck('Elves', 'Forest', ELVES),
  B: monoDeck('Liliana', 'Swamp', LILIANA),
};

function walkerOnBoard(game: Game): { id: InstanceId; loyalty: number } | undefined {
  const walker = frameOf(game, 'A').view.battlefield.find((c) => isPlaneswalker(c.def));
  return walker ? { id: walker.instanceId, loyalty: walker.counters.loyalty ?? 0 } : undefined;
}

describe('online: a seated player can attack a planeswalker', () => {
  it('renders the walker with its loyalty and routes an attack at it', () => {
    const game = startedGame(WALKER_DECKS);
    // Play until B has a walker out and A has a creature that can attack it.
    driveUntil(
      game,
      { A: ELVES, B: LILIANA },
      (g) => {
        const view = frameOf(g, 'A').view;
        const walker = view.battlefield.some((c) => c.controller === 'B' && isPlaneswalker(c.def));
        const attacker = view.battlefield.some(
          (c) => c.controller === 'A' && !c.summoningSick && !c.tapped && c.def.types.includes('creature'),
        );
        return walker && attacker;
      },
    );

    // --- what the BOARD shows: the walker tile carries a live loyalty badge -------
    const walker = walkerOnBoard(game);
    expect(walker, 'no walker reached the battlefield').toBeDefined();
    const boardView = maskedViewToBoardView(frameOf(game, 'A').view, NAMES);
    const walkerTile = boardView.opponent.permanents.find((p) => p.instanceId === walker!.id);
    expect(walkerTile?.isPlaneswalker, 'the walker is not drawn as a walker').toBe(true);
    expect(walkerTile?.loyalty, 'the loyalty badge would be blank').toBeGreaterThan(0);
    const loyaltyBefore = walkerTile!.loyalty;

    // --- reach A's declare-attackers step ----------------------------------------
    passUntil(game, (g) => {
      const f = frameOf(g, 'A');
      return f.yourTurn && f.view.step === 'declareAttackers' && !!declareAttackersAction(f.legalActions);
    });

    const attackFrame = frameOf(game, 'A');
    const template = declareAttackersAction(attackFrame.legalActions);
    expect(template, 'the server offered no attack at all').toBeTruthy();
    const attacker = template!.attackers[0]!;
    const lifeBefore = attackFrame.view.players.B.life;

    // --- the exact action the board's "Attack with 1" button builds ---------------
    const action = buildDeclareAttackersAction('A', [attacker], { [attacker]: walker!.id });
    expect(action.attackTargets, 'the walker assignment was dropped').toEqual({ [attacker]: walker!.id });
    submit(game, 'A', action);

    // The server accepted it: combat records the attacker, aimed at the walker.
    expect(frameOf(game, 'A').view.combat?.attackers, 'the attack was rejected').toContain(attacker);

    // --- damage lands on the WALKER, not the player -------------------------------
    passUntil(game, (g) => {
      const w = walkerOnBoard(g);
      return w === undefined || w.loyalty < loyaltyBefore;
    });
    const after = walkerOnBoard(game);
    expect(after === undefined || after.loyalty < loyaltyBefore, 'the walker took no damage').toBe(true);
    expect(frameOf(game, 'A').view.players.B.life, 'damage hit the player instead').toBe(lifeBefore);
  });

  it('offers the walker controller a loyalty-ability menu, and activating one moves loyalty', () => {
    const game = startedGame(WALKER_DECKS);
    driveUntil(
      game,
      { A: ELVES, B: LILIANA },
      (g) => g.conns.B.sent.length > 0 && !!walkerOnBoard(g),
    );

    // Reach a window where B holds priority at sorcery speed on its own turn —
    // exactly when the engine offers a loyalty ability.
    passUntil(game, (g) => {
      const f = frameOf(g, 'B');
      return (
        f.yourTurn &&
        f.view.activePlayer === 'B' &&
        f.view.step === 'precombatMain' &&
        abilityChoices(f.legalActions, defOf(f.view), (t) => String(t)).length > 0
      );
    }, 200);

    const frame = frameOf(game, 'B');
    const walker = walkerOnBoard(game)!;
    // --- what the BOARD shows: the ability menu the walker tile opens -------------
    const menu = abilityChoices(frame.legalActions, defOf(frame.view), (t) => String(t));
    expect(menu.length, 'the loyalty menu is empty online').toBeGreaterThan(0);
    const plusOne = menu.find((opt) => opt.instanceId === walker.id && opt.label.startsWith('+1'));
    expect(plusOne, 'the +1 loyalty line is missing from the menu').toBeDefined();
    expect(plusOne!.sourceName).toBe(LILIANA);

    const loyaltyBefore = walker.loyalty;
    submit(game, 'B', {
      kind: 'activateAbility',
      player: 'B',
      instanceId: plusOne!.instanceId,
      abilityIndex: plusOne!.abilityIndex,
    });
    expect(walkerOnBoard(game)!.loyalty, 'the +1 did not add loyalty').toBe(loyaltyBefore + 1);
  });
});

/** The board's own definition lookup: the PUBLIC battlefield in the masked view. */
function defOf(view: MaskedGameView): (id: InstanceId) => CardDefinition | undefined {
  return (id) => view.battlefield.find((c) => c.instanceId === id)?.def;
}

// ==================================================================================
// 2. Flashback: casting out of the graveyard, online.
// ==================================================================================

/**
 * A Firebolt-shaped sorcery. It is NOT in the shipped pool (no card there has a
 * flashback cost at all), so the game below is dealt from an injected pool — see
 * the header. The mechanic, the engine path and the client affordance are real.
 */
const TEST_FIREBOLT: CardDefinition = {
  id: 'test-online-firebolt',
  name: 'Test Firebolt',
  types: ['sorcery'],
  cost: { R: 1 },
  flashback: { generic: 2, R: 1 },
  effects: [{ primitive: 'dealDamage', params: { amount: 2, targets: 'player' } }],
};

/** A Blaze-shaped {X} burn spell, injected for the same reason. */
const TEST_BLAZE: CardDefinition = {
  id: 'test-online-blaze',
  name: 'Test Blaze',
  types: ['sorcery'],
  cost: { R: 1 },
  xCost: 1,
  effects: [{ primitive: 'dealDamage', params: { amount: { chosenX: true }, targets: 'player' } }],
};

function poolWith(...extraCards: readonly CardDefinition[]): CardPool {
  return loadCardPool({ onWarn: () => {}, extraCards });
}

describe('online: a seated player can flashback a spell out of their graveyard', () => {
  it('shows the graveyard affordance and casts from it end to end', () => {
    const decks: Record<PlayerId, DeckList> = {
      A: monoDeck('Bolts', 'Mountain', TEST_FIREBOLT.name),
      B: monoDeck('Bolts', 'Mountain', TEST_FIREBOLT.name),
    };
    const game = startedGame(decks, 11, poolWith(TEST_FIREBOLT));

    // Play normally until a Firebolt of A's has resolved into A's graveyard AND A
    // has enough lands out to afford the {2}{R} flashback.
    driveUntil(
      game,
      { A: TEST_FIREBOLT.name, B: TEST_FIREBOLT.name },
      (g) => {
        const view = frameOf(g, 'A').view;
        const f = frameOf(g, 'A');
        const inYard = view.players.A.graveyard.some((c) => c.def.flashback !== undefined);
        // UNTAPPED lands: a flashback that cannot be funded is not the affordance
        // under test, and the board is right to withhold it.
        const untapped = view.battlefield.filter(
          (c) => c.controller === 'A' && isLand(c.def) && !c.tapped,
        ).length;
        return (
          inYard &&
          untapped >= 3 &&
          f.yourTurn &&
          view.activePlayer === 'A' &&
          view.step === 'precombatMain' &&
          view.stack.length === 0
        );
      },
    );
    const frame = frameOf(game, 'A');
    const card = frame.view.players.A.graveyard.find((c) => c.def.flashback !== undefined)!;

    // --- what the BOARD shows: the graveyard panel marks the card castable -------
    const castable = new Set<InstanceId>([
      ...graveyardCastChoices(frame.legalActions).keys(),
      ...graveyardCastableWithTaps(frame.view, 'A', frame.view.players.A.graveyard, frame.legalActions, true),
    ]);
    const panel = zonePanelView(
      'graveyard',
      {
        cards: frame.view.players.A.graveyard.map((c) => ({
          instanceId: c.instanceId,
          cardId: c.def.id,
          name: c.def.name,
          castableEver: c.def.flashback !== undefined,
        })),
        hiddenCount: 0,
      },
      castable,
      { yours: true, yourTurn: frame.yourTurn, waitingOn: NAMES[frame.view.priorityPlayer], step: frame.view.step },
    ).cards;
    const chip = panel.find((p) => p.instanceId === card.instanceId);
    expect(chip?.actionable, 'the graveyard card is not clickable — the affordance is inert').toBe(true);
    expect(chip?.badge).toBe('flashback');
    expect(chip?.reason, 'an actionable card must not carry a why-disabled reason').toBeUndefined();
    // A card WITHOUT flashback never pretends it is a timing problem.
    const dud = panel.find(
      (p) =>
        !frame.view.players.A.graveyard.some(
          (c) => c.instanceId === p.instanceId && c.def.flashback !== undefined,
        ),
    );
    if (dud) expect(dud.reason).toMatch(/no flashback/i);

    // --- the exact sequence the board submits when that chip is clicked ----------
    const sequence = castSequence(frame.view, 'A', card, ['B'], frame.legalActions, 'graveyard');
    expect(sequence, 'the board could not build a flashback cast').toBeTruthy();
    const cast = sequence![sequence!.length - 1] as Extract<GameAction, { kind: 'castSpell' }>;
    expect(cast.fromZone, 'the cast did not name the graveyard as its source').toBe('graveyard');

    const lifeBefore = frame.view.players.B.life;
    for (const action of sequence!) submit(game, 'A', action);

    // The server accepted the flashback cast: the card is off the stack's source
    // zone and the spell is really on the stack (or has already resolved).
    passUntil(game, (g) => frameOf(g, 'A').view.players.B.life < lifeBefore);
    const after = frameOf(game, 'A').view;
    expect(after.players.B.life, 'the flashback spell dealt no damage').toBe(lifeBefore - 2);
    expect(
      after.players.A.graveyard.some((c) => c.instanceId === card.instanceId),
      'a flashback spell must not return to the graveyard',
    ).toBe(false);
    expect(
      after.players.A.exile.some((c) => c.instanceId === card.instanceId),
      'a flashback spell resolves to EXILE (CR 702.34a)',
    ).toBe(true);
  });
});

// ==================================================================================
// 3. Cast-time choices ({X}) reaching the right seat online.
// ==================================================================================

describe('online: a cast-time {X} question reaches the caster and nobody else', () => {
  it('prompts the caster, redacts it for the opponent, and pays out the chosen X', () => {
    const decks: Record<PlayerId, DeckList> = {
      A: monoDeck('Blaze', 'Mountain', TEST_BLAZE.name),
      B: monoDeck('Blaze', 'Mountain', TEST_BLAZE.name),
    };
    const game = startedGame(decks, 13, poolWith(TEST_BLAZE));

    // A needs its own main phase, a Blaze in hand, and lands to fund X.
    driveUntil(
      game,
      // Never auto-cast: the test casts Blaze itself so the choice is ours to answer.
      { A: 'never-cast', B: 'never-cast' },
      (g) => {
        const f = frameOf(g, 'A');
        const view = f.view;
        const lands = view.battlefield.filter(
          (c) => c.controller === 'A' && isLand(c.def) && !c.tapped,
        );
        return (
          f.yourTurn &&
          view.activePlayer === 'A' &&
          view.step === 'precombatMain' &&
          view.stack.length === 0 &&
          lands.length >= 3 &&
          (view.players.A.hand ?? []).some((c) => c.def.name === TEST_BLAZE.name)
        );
      },
    );

    // Tap everything, then cast Blaze at B — the board's own cast path.
    const before = frameOf(game, 'A');
    const blaze = (before.view.players.A.hand ?? []).find((c) => c.def.name === TEST_BLAZE.name)!;
    for (const tap of before.legalActions.filter((a) => a.kind === 'tapForMana')) submit(game, 'A', tap);

    const armed = frameOf(game, 'A');
    const offered = castChoices(armed.legalActions).get(blaze.instanceId);
    expect(offered, 'the server never offered the {X} spell as castable').toBeDefined();
    submit(game, 'A', { kind: 'castSpell', player: 'A', instanceId: blaze.instanceId, targets: ['B'] });

    // --- what each BOARD shows: the question, for exactly one seat ---------------
    const casterView = onlineChoiceView(frameOf(game, 'A').view, NAMES);
    expect(casterView.answerable, 'the caster was shown no cast-time question').toBeTruthy();
    expect(casterView.answerable!.kind, 'the {X} question should be a chooseNumber').toBe('chooseNumber');
    expect(casterView.waitingText).toBeNull();

    const opponentView = onlineChoiceView(frameOf(game, 'B').view, NAMES);
    expect(opponentView.answerable, "the opponent must not be handed the caster's question").toBeNull();
    expect(opponentView.waitingText, 'the opponent should still be told someone is choosing').toContain(NAMES.A);

    const choice = casterView.answerable as Extract<typeof casterView.answerable, { kind: 'chooseNumber' }>;
    const x = choice.max;
    expect(x, 'the engine offered no payable X at all').toBeGreaterThan(0);

    // --- the exact action the ChoicePrompt's Confirm button submits --------------
    const lifeBefore = frameOf(game, 'A').view.players.B.life;
    submit(game, 'A', answerChoiceAction('A', choice, { kind: 'chooseNumber', value: x }));
    passUntil(game, (g) => frameOf(g, 'A').view.players.B.life < lifeBefore);
    expect(frameOf(game, 'A').view.players.B.life, 'the paid-for X was not dealt').toBe(lifeBefore - x);
  });
});

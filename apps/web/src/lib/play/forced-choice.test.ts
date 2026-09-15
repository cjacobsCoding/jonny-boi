/**
 * THE REPORTED DEFECT, DRIVEN THROUGH THE REAL CARD.
 *
 * Caleb: *"I just played Banisher priest and it didnt let me choose a creature
 * to banish"* … *"its because there was only one option in this case... Even so,
 * it should show that choice being made so the player understands what has
 * happened."*
 *
 * Every test here uses the REAL pool record and the REAL engine. A test built on
 * a hand-rolled card definition would have passed against a card the app does
 * not ship — the failure `compile/rule-coverage.test.ts` exists to stop.
 *
 * ## The two halves, and why the second one is the important one
 *
 * 1. ONE legal target → the engine settles it AND an announcement names the
 *    exiled creature. That is the bug.
 * 2. TWO legal targets → the engine ASKS and nothing is announced. That is what
 *    stops the fix becoming noise, and it is the assertion that would go red if
 *    somebody "simplified" the announcement into an unconditional banner.
 */
import { describe, expect, it } from 'vitest';
import {
  applyAction,
  createGame,
  CHOICE_KINDS,
  DEFAULT_RULES,
  defaultAnswerFor,
  NOTHING_CHOSEN,
  type CardDefinition,
  type ChoiceAnswer,
  type ChoiceKind,
  type GameAction,
  type GameEvent,
  type GameState,
  type InstanceId,
  type PlayerId,
} from '@jonny-boi/core';
import { buildRegistry, loadCardPool } from '@jonny-boi/cards';
import {
  ANNOUNCED_CHOICE_KINDS,
  FORCED_CHOICE_KINDS,
  FORCED_CHOICE_REFUSALS,
  forcedChoiceDecision,
  forcedChoiceLogLine,
  forcedChoiceOf,
  forcedChoiceSentence,
  modeLabelOf,
  type ForcedChoice,
} from './forced-choice.js';
import { FORCED_CHOICE_CONFIG } from './play-config.js';

const SEED = 60613;
const POOL = loadCardPool();
const registry = buildRegistry();

function byName(name: string): CardDefinition {
  const card = POOL.getByName(name);
  if (!card) throw new Error(`pool missing ${name}`);
  return card;
}

const PLAINS = byName('Plains');
const BANISHER_PRIEST = byName('Banisher Priest');
const GRIZZLY_BEARS = byName('Grizzly Bears');
const SAVANNAH_LIONS = byName('Savannah Lions');

function act(state: GameState, action: GameAction): { state: GameState; events: readonly GameEvent[] } {
  const result = applyAction(state, action, DEFAULT_RULES, registry);
  const rejected = result.events.find((e) => e.type === 'actionRejected');
  if (rejected) throw new Error(`unexpected rejection: ${(rejected as { reason: string }).reason}`);
  return result;
}

function place(state: GameState, def: CardDefinition, controller: PlayerId, zone: 'battlefield' | 'hand'): InstanceId {
  const instanceId = state.nextInstanceId++;
  const card = {
    instanceId,
    def,
    controller,
    owner: controller,
    zone,
    tapped: false,
    summoningSick: false,
    damageMarked: 0,
    markedByDeathtouch: false,
    attachedTo: null,
    counters: {},
  };
  if (zone === 'battlefield') state.battlefield.push(card as never);
  else state.players[controller].hand.push(card as never);
  return instanceId;
}

/** A real game walked to A's first main phase, with mana to spare. */
function openBoard(): GameState {
  const { state } = createGame({
    seed: SEED,
    decks: {
      A: { cards: Array.from({ length: 60 }, () => PLAINS) },
      B: { cards: Array.from({ length: 60 }, () => PLAINS) },
    },
    registry,
  });
  let s = state;
  let guard = 0;
  while (s.step !== 'precombatMain' && !s.gameOver && guard++ < 400) {
    const q = s.pendingChoice;
    s = q
      ? act(s, { kind: 'answerChoice', player: q.chooser, choiceId: q.id, answer: defaultAnswerFor(q) }).state
      : act(s, { kind: 'passPriority', player: s.priorityPlayer }).state;
  }
  s.players.A.manaPool = { W: 9, U: 9, B: 9, R: 9, G: 9, C: 9 };
  s.players.B.manaPool = { W: 9, U: 9, B: 9, R: 9, G: 9, C: 9 };
  return s;
}

interface PriestRun {
  readonly events: readonly GameEvent[];
  readonly parked: GameState['pendingChoice'];
  readonly victimsGone: readonly InstanceId[];
  readonly nameOf: (id: InstanceId) => string;
}

/** Cast the real Banisher Priest into a board holding `opponentCreatures`. */
function playPriest(opponentCreatures: readonly CardDefinition[]): PriestRun {
  let s = openBoard();
  const victims = opponentCreatures.map((def) => place(s, def, 'B', 'battlefield'));
  const priest = place(s, BANISHER_PRIEST, 'A', 'hand');
  const nameOf = (id: InstanceId): string => {
    for (const zone of [s.battlefield, s.players.A.hand, s.players.B.hand, s.players.A.exile, s.players.B.exile]) {
      const found = zone.find((c) => c.instanceId === id);
      if (found) return found.def.name;
    }
    return `#${id}`;
  };
  const events: GameEvent[] = [];
  const cast = act(s, { kind: 'castSpell', player: 'A', instanceId: priest, targets: [] });
  s = cast.state;
  events.push(...cast.events);
  let guard = 0;
  while (guard++ < 12 && !s.pendingChoice) {
    const before = s;
    const stepped = act(s, { kind: 'passPriority', player: s.priorityPlayer });
    s = stepped.state;
    events.push(...stepped.events);
    if (victims.some((id) => !s.battlefield.some((c) => c.instanceId === id))) break;
    if (s === before) break;
  }
  return {
    events,
    parked: s.pendingChoice ?? null,
    victimsGone: victims.filter((id) => !s.battlefield.some((c) => c.instanceId === id)),
    nameOf,
  };
}

/** Every announcement a run produced, as the board would build them. */
function announcementsOf(run: PriestRun): readonly ForcedChoice[] {
  const names = { nameOf: run.nameOf, playerName: (p: PlayerId) => `Player ${p}` };
  return run.events.map((e) => forcedChoiceOf(e, names)).filter((f): f is ForcedChoice => f !== null);
}

// ---------------------------------------------------------------------------
describe('Banisher Priest with exactly ONE legal target', () => {
  it('settles the choice AND announces what it exiled, by name', () => {
    const run = playPriest([GRIZZLY_BEARS]);

    expect(run.parked, 'the engine does not stop to ask — that part is correct').toBeNull();
    expect(run.victimsGone, 'and the only legal creature really was exiled').toHaveLength(1);

    const announcements = announcementsOf(run);
    expect(announcements, 'the settled choice produced an announcement').toHaveLength(1);
    const forced = announcements[0] as ForcedChoice;

    expect(forced.kind).toBe('selectTargets');
    expect(forced.sourceName, 'the ASKING card is named').toBe('Banisher Priest');
    // THE ASSERTION THE REPORT IS ABOUT: the card chosen, by name — not the
    // category, not "a target was chosen for you".
    expect(forced.words, 'the CHOSEN card is named').toEqual(['Grizzly Bears']);
    expect(forced.refs, 'and is carried as a ref, so the banner can draw its face').toEqual(
      run.victimsGone,
    );
    expect(forced.why, "the ENGINE's own reason rides along").toBe('only one legal target');
    expect(forcedChoiceSentence(forced)).toBe(
      'Banisher Priest targets Grizzly Bears — only one legal target.',
    );
  });

  it('reaches the player: the decision announces, and the log line names both cards', () => {
    const forced = announcementsOf(playPriest([GRIZZLY_BEARS]))[0] as ForcedChoice;
    const decision = forcedChoiceDecision(
      forced,
      { viewer: 'A', announced: new Set(), announcedThisTurn: 0, gameOver: false },
      FORCED_CHOICE_CONFIG,
    );
    expect(decision.kind, 'the viewer whose choice it was is interrupted').toBe('announce');
    expect(forcedChoiceLogLine(forced)).toContain('Grizzly Bears');
    expect(forcedChoiceLogLine(forced)).toContain('Banisher Priest');
  });
});

// ---------------------------------------------------------------------------
describe('Banisher Priest with TWO legal targets — the inverse', () => {
  it('ASKS, and announces nothing', () => {
    const run = playPriest([GRIZZLY_BEARS, SAVANNAH_LIONS]);

    expect(run.parked, 'two legal targets IS a decision and the game stops for it').not.toBeNull();
    expect(run.parked?.kind).toBe('selectTargets');
    expect(run.victimsGone, 'nothing was exiled behind the player’s back').toHaveLength(0);
    expect(
      announcementsOf(run),
      'and nothing is announced — an announcement on a question the player was ASKED is noise',
    ).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
describe('the CLASS guard — a new question kind cannot go silent', () => {
  /**
   * The compile-time half is the mapped type (`{ [K in ChoiceKind]: … }`), which
   * this cannot observe. The runtime half is that no row can satisfy that type
   * with empty words: every kind must phrase a real answer of its own kind.
   */
  const ANSWER_BY_KIND: { readonly [K in ChoiceKind]: ChoiceAnswer } = {
    selectTargets: { kind: 'selectTargets', targets: [7] },
    selectCards: { kind: 'selectCards', instanceIds: [7] },
    selectPlayers: { kind: 'selectPlayers', players: ['B'] },
    chooseModes: { kind: 'chooseModes', modeIds: ['mode1'] },
    confirm: { kind: 'confirm', yes: true },
    payMana: { kind: 'payMana', pay: false },
    payLife: { kind: 'payLife', pay: false },
    chooseNumber: { kind: 'chooseNumber', value: 0 },
    chooseValue: { kind: 'chooseValue', value: 'goblin' },
  };

  it('every kind core can ask is in the table', () => {
    expect([...CHOICE_KINDS].sort()).toEqual(Object.keys(FORCED_CHOICE_KINDS).sort());
  });

  it.each([...CHOICE_KINDS])('%s phrases a real answer, and phrases an empty one', (kind) => {
    const row = FORCED_CHOICE_KINDS[kind];
    expect(row.verb.length, `${kind} has a verb`).toBeGreaterThan(0);
    expect(row.nothing.length, `${kind} has words for an empty answer`).toBeGreaterThan(0);
    expect(row.why.length, `${kind} says why it is pitched as it is`).toBeGreaterThan(0);

    const forced = forcedChoiceOf(
      {
        type: 'choiceAutoAnswered',
        choiceId: 1,
        chooser: 'A',
        choiceKind: kind,
        answer: ANSWER_BY_KIND[kind],
        reason: 'only one legal answer',
        sourceInstanceId: 7,
        sourceName: 'Test Card',
      },
      { nameOf: () => 'Grizzly Bears', playerName: (p) => `Player ${p}` },
    );
    expect(forced, `${kind} produces an announcement`).not.toBeNull();
    expect((forced as ForcedChoice).words.join('').length, `${kind} names what it chose`).toBeGreaterThan(0);
    expect(forcedChoiceSentence(forced as ForcedChoice)).toContain('Test Card');
  });

  it('an answer that named NOTHING still says so, rather than trailing off', () => {
    const empties: ReadonlyArray<readonly [ChoiceKind, ChoiceAnswer]> = [
      ['selectTargets', { kind: 'selectTargets', targets: [] }],
      ['selectCards', { kind: 'selectCards', instanceIds: [] }],
      ['selectPlayers', { kind: 'selectPlayers', players: [] }],
      ['chooseModes', { kind: 'chooseModes', modeIds: [] }],
      ['chooseValue', { kind: 'chooseValue', value: NOTHING_CHOSEN }],
    ];
    for (const [kind, answer] of empties) {
      const forced = forcedChoiceOf(
        {
          type: 'choiceAutoAnswered',
          choiceId: 2,
          chooser: 'A',
          choiceKind: kind,
          answer,
          reason: 'nothing legal',
          sourceInstanceId: 7,
          sourceName: 'Test Card',
        },
        { nameOf: () => 'x', playerName: (p) => `Player ${p}` },
      ) as ForcedChoice;
      expect(forced.words, `${kind} says it chose nothing`).toEqual([FORCED_CHOICE_KINDS[kind].nothing]);
    }
  });

  it('only the kinds marked `banner` interrupt the board', () => {
    for (const kind of CHOICE_KINDS) {
      expect(ANNOUNCED_CHOICE_KINDS.includes(kind)).toBe(FORCED_CHOICE_KINDS[kind].volume === 'banner');
    }
  });
});

// ---------------------------------------------------------------------------
describe('hidden information, and the noise budget', () => {
  const forcedOf = (kind: ChoiceKind, answer: ChoiceAnswer, chooser: PlayerId = 'A'): ForcedChoice =>
    forcedChoiceOf(
      {
        type: 'choiceAutoAnswered',
        choiceId: 3,
        chooser,
        choiceKind: kind,
        answer,
        reason: 'only one legal answer',
        sourceInstanceId: 7,
        sourceName: 'Test Card',
      },
      { nameOf: () => 'Secret Card', playerName: (p) => `Player ${p}` },
    ) as ForcedChoice;

  it('the SHARED log does not name a card chosen from a hand or a library', () => {
    const forced = forcedOf('selectCards', { kind: 'selectCards', instanceIds: [7] });
    expect(forced.words, 'the chooser’s own banner still names it').toEqual(['Secret Card']);
    expect(forcedChoiceLogLine(forced), 'the shared log does not').not.toContain('Secret Card');
    expect(forcedChoiceLogLine(forced), 'but still reports that it happened, and why').toContain(
      'only one legal answer',
    );
  });

  it('the opponent’s own forced answer does not interrupt your board', () => {
    const decision = forcedChoiceDecision(
      forcedOf('selectTargets', { kind: 'selectTargets', targets: [7] }, 'B'),
      { viewer: 'A', announced: new Set(), announcedThisTurn: 0, gameOver: false },
      FORCED_CHOICE_CONFIG,
    );
    expect(decision.kind).toBe('refused');
    expect(decision.kind === 'refused' && decision.reason).toBe('notYourChoice');
    expect(decision.kind === 'refused' && decision.detail).toBe(FORCED_CHOICE_REFUSALS.notYourChoice);
  });

  it('a `logOnly` kind never raises a banner, and the turn budget is a real ceiling', () => {
    const ctx = { viewer: 'A' as PlayerId, announced: new Set<string>(), announcedThisTurn: 0, gameOver: false };
    const payment = forcedChoiceDecision(forcedOf('payMana', { kind: 'payMana', pay: false }), ctx, FORCED_CHOICE_CONFIG);
    expect(payment.kind === 'refused' && payment.reason).toBe('logOnlyKind');

    const spent = forcedChoiceDecision(
      forcedOf('selectTargets', { kind: 'selectTargets', targets: [7] }),
      { ...ctx, announcedThisTurn: FORCED_CHOICE_CONFIG.maxPerTurn },
      FORCED_CHOICE_CONFIG,
    );
    expect(spent.kind === 'refused' && spent.reason).toBe('turnBudgetSpent');

    const again = forcedChoiceDecision(
      forcedOf('selectTargets', { kind: 'selectTargets', targets: [7] }),
      { ...ctx, announced: new Set(['engine:3']) },
      FORCED_CHOICE_CONFIG,
    );
    expect(again.kind === 'refused' && again.reason).toBe('alreadyAnnounced');
  });
});

// ---------------------------------------------------------------------------
describe('a mode is named by its PRINTED label, not by its engine id', () => {
  it('reads the label off a real modal pool card', () => {
    const modal = POOL.cards.find((card) => (card.modal?.modes.length ?? 0) > 0);
    expect(modal, 'the pool has a modal card to test with').toBeDefined();
    const mode = (modal as CardDefinition).modal?.modes[0];
    expect(modeLabelOf(modal, (mode as { id: string }).id)).toBe((mode as { label: string }).label);
  });

  it('degrades VISIBLY when the source cannot be found', () => {
    const forced = forcedChoiceOf(
      {
        type: 'choiceAutoAnswered',
        choiceId: 4,
        chooser: 'A',
        choiceKind: 'chooseModes',
        answer: { kind: 'chooseModes', modeIds: ['mode1'] },
        reason: 'only one legal set of modes',
        sourceInstanceId: 7,
        sourceName: 'Gone Card',
      },
      { nameOf: () => 'x', playerName: (p) => `Player ${p}`, defOf: () => undefined },
    ) as ForcedChoice;
    // Rule 6: a fallback REPORTS that it fired. `mode1` alone on screen would
    // read as a card really called "mode1".
    expect(forced.words[0]).toBe('an unnamed mode (mode1)');
  });
});

/**
 * PRIORITY STOPS (§3.119) — the rule behind three reports from one session:
 *   - 20260901_211359: an instant in hand made the game stop in every window
 *     ("continually click on pass/advance");
 *   - 20260901_212245: a Thragtusk's life-gain trigger sat on the stack waiting
 *     for a pass nobody knew to make (life stayed 20);
 *   - 20260901_213414: an Angel of Serenity "swallowed" — on the stack, same.
 *
 * The pure rule is pinned first; then the LITERAL reported boards are driven
 * through the real session with the rule as the auto-advance predicate, so
 * the fix is proven where the bug lived, not on a model of it.
 */
import { describe, expect, it } from 'vitest';
import { buildRegistry, loadCardPool } from '@jonny-boi/cards';
import { createGame, type CardDefinition, type CardInstance, type GameState, type PlayerId } from '@jonny-boi/core';
import { GameSession } from './session.js';
import {
  DEFAULT_PRIORITY_STOPS,
  STEP_STOPS,
  shouldStopForPriority,
  stepStopIsOn,
  stepStopKeyFor,
  withStepStop,
  type PriorityStops,
  type StopContext,
} from './priority-stops.js';
import { decodePriorityStops } from './priority-stops-pref.js';
import { stopContextFor } from './priority-stops-session.js';

const SEAT_NAMES: Readonly<Record<PlayerId, string>> = { A: 'Player 1', B: 'Computer' };
const pool = loadCardPool({ onWarn: () => {} });
const registry = buildRegistry();

function card(name: string): CardDefinition {
  const found = pool.getByName(name);
  if (!found) throw new Error(`no pool card named "${name}"`);
  return found;
}

function instance(state: GameState, def: CardDefinition, controller: PlayerId, zone: CardInstance['zone']): CardInstance {
  return {
    instanceId: state.nextInstanceId++,
    def,
    controller,
    owner: controller,
    zone,
    tapped: false,
    summoningSick: false,
    damageMarked: 0,
    markedByDeathtouch: false,
    counters: {},
  };
}

/** A's precombat main, with the given cards in A's hand, lands on A's board. */
function atMainWith(handCards: readonly string[], seed = 41): GameSession {
  const forest = card('Forest');
  const created = createGame({
    seed,
    decks: {
      A: { cards: Array.from({ length: 40 }, () => forest) },
      B: { cards: Array.from({ length: 40 }, () => forest) },
    },
    registry,
  });
  const state = created.state;
  state.players.A.hand = handCards.map((name) => instance(state, card(name), 'A', 'hand'));
  state.players.B.hand = [];
  for (let i = 0; i < 6; i++) {
    const land = instance(state, i % 2 === 0 ? card('Forest') : card('Plains'), 'A', 'battlefield');
    state.battlefield.push(land);
  }
  let session = GameSession.fromCreated(created, registry, SEAT_NAMES);
  // Walk to A's main phase by passing — the old rule would STOP at upkeep with
  // an instant in hand, which is the very complaint under test.
  let guard = 0;
  while (session.state.step !== 'precombatMain' && guard++ < 20) session = session.passPriority().session;
  expect(session.state.step).toBe('precombatMain');
  expect(session.priorityPlayer).toBe('A');
  return session;
}

const base: StopContext = {
  step: 'upkeep',
  activePlayer: 'A',
  holder: 'A',
  pendingChoice: false,
  offersDeclaration: false,
  hasAnyPlay: true,
  canRespond: true,
  stackTopController: null,
};

describe('shouldStopForPriority — the pure rule', () => {
  it('a parked question always stops, whatever the stops say', () => {
    const off: PriorityStops = { steps: {}, stopOnOpponentStack: false, stopOnOwnStack: false, fullControl: false };
    expect(shouldStopForPriority({ ...base, pendingChoice: true, hasAnyPlay: false }, off)).toBe(true);
  });

  it('an offered attack/block declaration always stops', () => {
    const off: PriorityStops = { steps: {}, stopOnOpponentStack: false, stopOnOwnStack: false, fullControl: false };
    expect(shouldStopForPriority({ ...base, step: 'declareAttackers', offersDeclaration: true }, off)).toBe(true);
  });

  it('a window with nothing to do never stops, even under full control', () => {
    const full: PriorityStops = { ...DEFAULT_PRIORITY_STOPS, fullControl: true };
    expect(shouldStopForPriority({ ...base, hasAnyPlay: false, canRespond: false }, full)).toBe(false);
  });

  it('full control stops in every window where anything could be done', () => {
    const full: PriorityStops = { ...DEFAULT_PRIORITY_STOPS, fullControl: true };
    for (const row of STEP_STOPS) {
      const ctx: StopContext = { ...base, step: row.step, activePlayer: row.side === 'mine' ? 'A' : 'B' };
      expect(shouldStopForPriority(ctx, full), row.key).toBe(true);
    }
  });

  it("an OPPONENT's spell on the stack stops when you can respond (default on)", () => {
    expect(shouldStopForPriority({ ...base, stackTopController: 'B' }, DEFAULT_PRIORITY_STOPS)).toBe(true);
    // ...and not when your only cards are sorcery-speed: nothing to offer but pass.
    expect(
      shouldStopForPriority({ ...base, stackTopController: 'B', canRespond: false }, DEFAULT_PRIORITY_STOPS),
    ).toBe(false);
    const quiet: PriorityStops = { ...DEFAULT_PRIORITY_STOPS, stopOnOpponentStack: false };
    expect(shouldStopForPriority({ ...base, stackTopController: 'B' }, quiet)).toBe(false);
  });

  it('your OWN spell or trigger on the stack resolves without asking (default off)', () => {
    expect(shouldStopForPriority({ ...base, stackTopController: 'A' }, DEFAULT_PRIORITY_STOPS)).toBe(false);
    const hold: PriorityStops = { ...DEFAULT_PRIORITY_STOPS, stopOnOwnStack: true };
    expect(shouldStopForPriority({ ...base, stackTopController: 'A' }, hold)).toBe(true);
  });

  it('the per-step table decides an empty-stack window, per side', () => {
    const on = STEP_STOPS.filter((row) => row.defaultOn).map((row) => row.key);
    expect(on).toEqual([
      'mine:precombatMain',
      'mine:declareAttackers',
      'mine:postcombatMain',
      'theirs:declareBlockers',
      'theirs:end',
    ]);
    for (const row of STEP_STOPS) {
      const ctx: StopContext = { ...base, step: row.step, activePlayer: row.side === 'mine' ? 'A' : 'B' };
      expect(shouldStopForPriority(ctx, DEFAULT_PRIORITY_STOPS), row.key).toBe(row.defaultOn);
    }
  });

  it('a step stop can be flipped either way from its default', () => {
    const theirsUpkeep = { ...base, step: 'upkeep' as const, activePlayer: 'B' as const };
    expect(shouldStopForPriority(theirsUpkeep, DEFAULT_PRIORITY_STOPS)).toBe(false);
    expect(shouldStopForPriority(theirsUpkeep, withStepStop(DEFAULT_PRIORITY_STOPS, 'theirs:upkeep', true))).toBe(true);
    const mineMain = { ...base, step: 'precombatMain' as const };
    expect(shouldStopForPriority(mineMain, withStepStop(DEFAULT_PRIORITY_STOPS, 'mine:precombatMain', false))).toBe(false);
    expect(stepStopIsOn(DEFAULT_PRIORITY_STOPS, 'theirs:end')).toBe(true);
    expect(stepStopKeyFor('end', 'B', 'A')).toBe('theirs:end');
  });

  it('your own main phase stops for a sorcery-speed play; another step needs a response', () => {
    const mainNoInstant = { ...base, step: 'precombatMain' as const, canRespond: false };
    expect(shouldStopForPriority(mainNoInstant, DEFAULT_PRIORITY_STOPS)).toBe(true);
    const theirEndNoInstant = { ...base, step: 'end' as const, activePlayer: 'B' as const, canRespond: false };
    expect(shouldStopForPriority(theirEndNoInstant, DEFAULT_PRIORITY_STOPS)).toBe(false);
  });
});

describe('the persisted preference decodes defensively', () => {
  it('keeps known keys and booleans, drops everything else', () => {
    const decoded = decodePriorityStops({
      steps: { 'theirs:upkeep': true, 'mine:precombatMain': 'yes', 'nope:step': true },
      stopOnOpponentStack: false,
      stopOnOwnStack: 'maybe',
      fullControl: true,
    });
    expect(decoded).toEqual({
      steps: { 'theirs:upkeep': true },
      stopOnOpponentStack: false,
      stopOnOwnStack: false,
      fullControl: true,
    });
  });

  it('garbage is the defaults', () => {
    expect(decodePriorityStops(null)).toBe(DEFAULT_PRIORITY_STOPS);
    expect(decodePriorityStops('x')).toBe(DEFAULT_PRIORITY_STOPS);
  });
});

describe('the reported boards, driven through the real session', () => {
  it('Thragtusk (20260901_212245): the ETB trigger resolves by itself and life goes 20 → 25', () => {
    // Cloudshift in hand is what made every window "meaningful" before: the
    // player held an instant, so the old rule stopped with their own trigger on
    // the stack and the board said "play a land or cast a spell".
    let s = atMainWith(['Thragtusk', 'Cloudshift']);
    const thragtusk = s.state.players.A.hand.find((c) => c.def.name === 'Thragtusk')!;
    const cast = s.castWithAutoTap(thragtusk.instanceId, []);
    expect(cast.rejected).toBeNull();
    s = cast.session;
    const rule = (session: GameSession) => shouldStopForPriority(stopContextFor(session), DEFAULT_PRIORITY_STOPS);
    s = s.autoAdvancePriority(undefined, rule);
    // The spell AND its trigger resolved without a stop; we are back at A's
    // main phase with the trigger gone and the life gained.
    expect(s.state.stack).toHaveLength(0);
    expect(s.state.players.A.life).toBe(25);
    expect(s.state.battlefield.some((p) => p.def.name === 'Thragtusk')).toBe(true);
    expect(s.state.step).toBe('precombatMain');
    expect(s.priorityPlayer).toBe('A');
  });

  it('Thragtusk under FULL CONTROL stops with the spell on the stack — and says so', () => {
    let s = atMainWith(['Thragtusk', 'Cloudshift']);
    const thragtusk = s.state.players.A.hand.find((c) => c.def.name === 'Thragtusk')!;
    s = s.castWithAutoTap(thragtusk.instanceId, []).session;
    const full: PriorityStops = { ...DEFAULT_PRIORITY_STOPS, fullControl: true };
    const rule = (session: GameSession) => shouldStopForPriority(stopContextFor(session), full);
    const stopped = s.autoAdvancePriority(undefined, rule);
    expect(stopped).toBe(s); // not advanced at all: the player holds priority over their own spell
    expect(stopped.state.stack.map((o) => (o.kind === 'spell' ? o.card.def.name : o.label))).toEqual(['Thragtusk']);
  });

  it('Angel of Serenity (20260901_213414): the cast is not "swallowed" — it resolves and enters', () => {
    let s = atMainWith(['Angel of Serenity', 'Cloudshift']);
    s.state.players.A.manaPool = { W: 3, U: 0, B: 0, R: 0, G: 4, C: 0 };
    const angel = s.state.players.A.hand.find((c) => c.def.name === 'Angel of Serenity')!;
    const cast = s.castWithAutoTap(angel.instanceId, []);
    expect(cast.rejected).toBeNull();
    s = cast.session;
    const rule = (session: GameSession) => shouldStopForPriority(stopContextFor(session), DEFAULT_PRIORITY_STOPS);
    s = s.autoAdvancePriority(undefined, rule);
    expect(s.state.battlefield.some((p) => p.def.name === 'Angel of Serenity')).toBe(true);
    expect(s.state.players.A.hand.map((c) => c.def.name)).toEqual(['Cloudshift']);
  });

  it('an instant in hand no longer stops in every window of the opponent turn (20260901_211359)', () => {
    let s = atMainWith(['Cloudshift']);
    // Pass out of A's turn entirely and count how many times the rule stops
    // during B's turn before A's next main phase.
    const rule = (session: GameSession) => shouldStopForPriority(stopContextFor(session), DEFAULT_PRIORITY_STOPS);
    const stops: string[] = [];
    let guard = 0;
    while (guard++ < 60) {
      s = s.passPriority().session.autoAdvancePriority(undefined, rule);
      if (s.state.turnNumber >= 3 && s.state.step === 'precombatMain' && s.priorityPlayer === 'A') break;
      if (s.priorityPlayer === 'A' && s.state.turnNumber === 2) stops.push(`${s.state.turnNumber}:${s.state.step}`);
    }
    // Turn 2 is B's: with nothing on B's board the only window worth a stop is
    // B's end step (the instant-speed window). Not upkeep, draw, main, combat.
    // (Turn 1, A's own, stops at the attack step and main 2 — the table's own
    // defaults for one's own turn, and not what this report was about.)
    expect(stops).toEqual(['2:end']);
  });
});

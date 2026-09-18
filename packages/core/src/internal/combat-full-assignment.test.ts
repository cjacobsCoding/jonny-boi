/**
 * A BLOCKED ATTACKER ASSIGNS ALL OF ITS DAMAGE (CR 510.1c).
 *
 * Reported from a real game: a huge lifelink creature was blocked by a Llanowar
 * Elves, and its controller gained ONE life instead of a hundred.
 *
 * The cause was a rule written from the wrong half of the sentence. CR 510.1c
 * says an attacker divides its combat damage among the creatures blocking it,
 * and may not assign damage to a later blocker until each earlier one has been
 * assigned lethal damage. "At least lethal to each, in order" is a FLOOR on how
 * the damage may be divided — the engine implemented it as a CEILING, assigning
 * `min(power, lethal)` per blocker and then discarding everything left over
 * unless the attacker had trample. Damage that is not trampling does not
 * evaporate: it lands on the blockers, and the last one in the order takes the
 * pile.
 *
 * That silently wrong number is then everything downstream of "damage dealt" —
 * the lifelink gain, a prevention shield's arithmetic, and any "whenever this
 * deals damage" trigger, all computed from a fraction of the real hit. The
 * creature died either way, which is why nothing else noticed.
 */
import { describe, expect, it } from 'vitest';
import {
  applyAction,
  createGame,
  DEFAULT_RULES,
  type CardDefinition,
  type GameAction,
  type GameEvent,
  type GameState,
  type InstanceId,
  type PlayerId,
} from '../index.js';
import { createEffectRegistry } from '../effects.js';
import { creatureDef, deckOf, landDef } from '../test-fixtures.js';

const ISLAND = landDef('Island', 'U');

/** The reported creature: enormous, lifelinked, no trample. */
const BIG_LIFELINKER = creatureDef('BigLifelinker', 100, 100, { keywords: { lifelink: true } });
const BIG_TRAMPLER = creatureDef('BigTrampler', 100, 100, {
  keywords: { lifelink: true, trample: true },
});
/** The reported blocker, and a second blocker with real toughness behind it. */
const ELVES = creatureDef('Llanowar Elves', 1, 1);
const WALL = creatureDef('Thick Wall', 0, 4);

function act(state: GameState, action: GameAction, log: GameEvent[]): GameState {
  const r = applyAction(state, action, DEFAULT_RULES, createEffectRegistry());
  const rejected = r.events.find((e) => e.type === 'actionRejected');
  if (rejected) throw new Error(`unexpected rejection: ${(rejected as { reason: string }).reason}`);
  log.push(...r.events);
  return r.state;
}

function advanceToStep(state: GameState, target: string, log: GameEvent[], max = 300): GameState {
  let s = state;
  let guard = 0;
  while (s.step !== target && !s.gameOver && guard++ < max) {
    s = act(s, { kind: 'passPriority', player: s.priorityPlayer }, log);
  }
  return s;
}

/** Put creatures on the battlefield for both seats and stop in declareAttackers. */
function combatSetup(
  attackers: readonly CardDefinition[],
  blockers: readonly CardDefinition[],
  log: GameEvent[],
): { state: GameState; attackerIds: InstanceId[]; blockerIds: InstanceId[] } {
  const { state } = createGame({
    seed: 1,
    decks: { A: deckOf(ISLAND, 40), B: deckOf(ISLAND, 40) },
    config: DEFAULT_RULES,
  });
  let nextId = state.nextInstanceId;
  const place = (def: CardDefinition, controller: PlayerId): InstanceId => {
    const id = nextId++;
    state.battlefield.push({
      instanceId: id,
      def,
      controller,
      owner: controller,
      zone: 'battlefield',
      tapped: false,
      summoningSick: false,
      damageMarked: 0,
      markedByDeathtouch: false,
      counters: {},
    });
    return id;
  };
  const attackerIds = attackers.map((d) => place(d, 'A'));
  const blockerIds = blockers.map((d) => place(d, 'B'));
  state.nextInstanceId = nextId;
  return { state: advanceToStep(state, 'declareAttackers', log), attackerIds, blockerIds };
}

/**
 * Attack with one creature, block it with all of `blockers` in order, and run
 * both damage steps. Returns the facts these tests are about.
 *
 * Damage MARKED is read from the events rather than the battlefield on purpose:
 * a creature that took lethal damage is gone by the time combat ends, so reading
 * the permanent would report nothing for exactly the case under test.
 */
function fight(
  attacker: CardDefinition,
  blockers: readonly CardDefinition[],
): {
  readonly lifeGained: number;
  readonly toEachBlocker: number[];
  readonly toDefendingPlayer: number;
} {
  const log: GameEvent[] = [];
  const { state, attackerIds, blockerIds } = combatSetup([attacker], blockers, log);
  const atk = attackerIds[0] as InstanceId;
  const lifeBefore = state.players.A.life;

  let s = act(state, { kind: 'declareAttackers', player: 'A', attackers: [atk] }, log);
  s = advanceToStep(s, 'declareBlockers', log);
  s = act(
    s,
    {
      kind: 'declareBlockers',
      player: 'B',
      blocks: blockerIds.map((b) => ({ blocker: b, attacker: atk })),
    },
    log,
  );
  s = advanceToStep(s, 'postcombatMain', log);

  const dealtBy = (target: InstanceId | PlayerId): number =>
    log
      .filter((e): e is Extract<GameEvent, { type: 'damageDealt' }> => e.type === 'damageDealt')
      .filter((e) => e.source === atk && e.target === target)
      .reduce((sum, e) => sum + e.amount, 0);

  return {
    lifeGained: s.players.A.life - lifeBefore,
    toEachBlocker: blockerIds.map(dealtBy),
    toDefendingPlayer: dealtBy('B'),
  };
}

describe('a blocked attacker WITHOUT trample', () => {
  it('assigns all of its power to its blocker, so lifelink gains all of it', () => {
    const r = fight(BIG_LIFELINKER, [ELVES]);
    expect(r.toEachBlocker[0], 'every point lands on the blocker').toBe(100);
    expect(r.lifeGained, 'a 100-power lifelinker blocked by a 1/1 gains 100, not 1').toBe(100);
    expect(r.toDefendingPlayer, 'nothing gets through without trample').toBe(0);
  });

  it('gives each blocker lethal in order, then piles the excess on the last', () => {
    const r = fight(BIG_LIFELINKER, [ELVES, WALL]);
    expect(r.toEachBlocker[0], 'the first blocker takes exactly lethal').toBe(1);
    expect(r.toEachBlocker[1], 'the remaining 99 land on the last blocker').toBe(99);
    expect(r.lifeGained, 'lifelink sees every point').toBe(100);
    expect(r.toDefendingPlayer).toBe(0);
  });
});

describe('a blocked attacker WITH trample', () => {
  it('assigns only lethal to blockers and tramples the rest through', () => {
    // The control: trample is what makes the excess skip the blockers. If this
    // ever matches the non-trample case, the fix above went too far and trample
    // has stopped meaning anything.
    const r = fight(BIG_TRAMPLER, [ELVES]);
    expect(r.toEachBlocker[0], 'lethal to the blocker').toBe(1);
    expect(r.toDefendingPlayer, 'the other 99 trample through to the player').toBe(99);
    expect(r.lifeGained, 'lifelink still sees all 100').toBe(100);
  });
});

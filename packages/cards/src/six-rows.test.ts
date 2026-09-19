/**
 * §3.173 — SIX ROWS FROM THE ONE-CLAUSE RANKING, compiled from printed text and
 * played through the real engine:
 *  A. "Creatures your opponents control / All creatures get -X/-Y until end of
 *     turn" (Turn the Tide, Nausea, Massacre Wurm) — the mass modification on
 *     the other board and on both;
 *  B. "target attacking or blocking creature" (Sandblast, Elite Archers);
 *  C. "During your turn, ~ has first strike" (Fresh-Faced Recruit);
 *  D. "Target creature can't block this turn" (Goblin Shortcutter, Stun);
 *  E. "{U}: Return ~ to its owner's hand" (Darting Merfolk, Skywing Aven);
 *  F. "~ enters tapped unless a player has 13 or less life" / "… unless you
 *     have two or more opponents" (Abandoned Campground, Spire Garden).
 * Plus the refusals each row keeps: "up to two target creatures can't block",
 * "creatures without flying can't block", "each creature gets -1/-1".
 */

import { describe, expect, it } from 'vitest';
import type { CardDefinition, GameAction, GameState, InstanceId, PlayerId } from '@jonny-boi/core';
import {
  applyAction,
  createGame,
  DEFAULT_RULES,
  defaultAnswerFor,
  effectivePower,
  effectiveToughness,
  generateLegalActions,
  indexContinuous,
} from '@jonny-boi/core';
import { compileCard } from './compile/index.js';
import type { CompilableCard } from './compile/index.js';
import { buildRegistry } from './pool.js';
import { CARD_POOL } from '../data/pool.js';

type Registry = ReturnType<typeof buildRegistry>;
const SEED = 41173;
const NO_MANA = { generic: 0, W: 0, U: 0, B: 0, R: 0, G: 0, C: 0, other: [] } as const;

function printed(
  name: string,
  types: string[],
  manaCost: Partial<typeof NO_MANA>,
  oracleText: string,
  subtypes: string[] = [],
): CompilableCard {
  const creature = types.includes('Creature');
  return {
    id: `test:${name}`,
    name,
    manaCost: { ...NO_MANA, ...manaCost },
    typeLine: { supertypes: [], types, subtypes },
    power: creature ? 2 : null,
    toughness: creature ? 2 : null,
    keywords: [],
    oracleText,
  } as CompilableCard;
}
const complete = (card: CompilableCard): CardDefinition => {
  const result = compileCard(card);
  expect(result.status, `${card.name} missing: ${JSON.stringify(result.missing)}`).toBe('complete');
  return result.definition;
};
const reported = (card: CompilableCard, line: RegExp) => {
  const result = compileCard(card);
  expect(result.status, `${card.name} compiled whole — it should have reported`).not.toBe('complete');
  expect(result.missing.map((m) => m.text).join('\n')).toMatch(line);
};

const SANDBLAST = printed('Sandblast', ['Instant'], { generic: 2, W: 1 }, 'Sandblast deals 5 damage to target attacking or blocking creature.');
const NAUSEA = printed('Nausea', ['Sorcery'], { generic: 1, B: 1 }, 'All creatures get -1/-1 until end of turn.');
const TURN_THE_TIDE = printed('Turn the Tide', ['Instant'], { generic: 1, U: 1 }, 'Creatures your opponents control get -2/-0 until end of turn.\nDraw a card.');
const MASSACRE_WURM = printed('Massacre Wurm', ['Creature'], { generic: 3, B: 3 }, 'When Massacre Wurm enters, creatures your opponents control get -2/-2 until end of turn.\nWhenever a creature an opponent controls dies, that player loses 2 life.', ['Phyrexian', 'Wurm']);
const RECRUIT = printed('Fresh-Faced Recruit', ['Creature'], { generic: 1, R: 0, W: 0, other: [] }, 'During your turn, Fresh-Faced Recruit has first strike.', ['Human', 'Soldier']);
const SHORTCUTTER = printed('Goblin Shortcutter', ['Creature'], { generic: 1, R: 1 }, "When Goblin Shortcutter enters, target creature can't block this turn.", ['Goblin', 'Scout']);
const MERFOLK = printed('Darting Merfolk', ['Creature'], { U: 1 }, "{U}: Return Darting Merfolk to its owner's hand.", ['Merfolk']);
const CAMPGROUND = printed('Abandoned Campground', ['Land'], {}, 'Abandoned Campground enters tapped unless a player has 13 or less life.\n{T}: Add {W} or {U}.');
const GARDEN = printed('Spire Garden', ['Land'], {}, 'Spire Garden enters tapped unless you have two or more opponents.\n{T}: Add {R} or {G}.');

describe('§3.173 — the six rows, compiled', () => {
  it('A. the scoped mass modification: opponents\' board, every board, and inside a trigger', () => {
    expect(complete(TURN_THE_TIDE).effects?.[0]).toEqual({
      primitive: 'grantKeywordToYoursUntilEndOfTurn',
      params: { power: -2, toughness: 0, scope: 'opponent', anyOfTypes: ['creature'] },
    });
    expect(complete(NAUSEA).effects).toEqual([
      { primitive: 'grantKeywordToYoursUntilEndOfTurn', params: { power: -1, toughness: -1, scope: 'all', anyOfTypes: ['creature'] } },
    ]);
    const wurm = complete(MASSACRE_WURM);
    expect(wurm.triggers?.[0]?.effects).toEqual([
      { primitive: 'grantKeywordToYoursUntilEndOfTurn', params: { power: -2, toughness: -2, scope: 'opponent', anyOfTypes: ['creature'] } },
    ]);
    reported(printed('Each One', ['Sorcery'], { B: 1 }, 'Each creature gets -1/-1 until end of turn.'), /each creature gets/i);
  });

  it('B. the attacking-or-blocking target, on a spell and on an archer', () => {
    expect(complete(SANDBLAST).effects).toEqual([
      { primitive: 'dealDamage', params: { amount: 5, targets: 'attackingOrBlockingCreature' } },
    ]);
    const archers = complete(
      printed('Elite Archers', ['Creature'], { generic: 4, W: 2 }, '{T}: Elite Archers deals 3 damage to target attacking or blocking creature.', ['Human', 'Archer']),
    );
    expect(archers.activated?.[0]?.effects).toEqual([
      { primitive: 'dealDamage', params: { amount: 3, targets: 'attackingOrBlockingCreature' } },
    ]);
  });

  it('C. "during your turn" in both printed orders, and "as long as it\'s your turn"', () => {
    for (const card of [
      RECRUIT,
      printed('Razorkin Needlehead', ['Creature'], { generic: 1, R: 1 }, 'Razorkin Needlehead has first strike during your turn.'),
      printed('Faithful Pikemaster', ['Creature'], { generic: 1, W: 1 }, "As long as it's your turn, Faithful Pikemaster has first strike."),
    ]) {
      const def = complete(card);
      expect(def.statics?.[0]).toEqual(
        expect.objectContaining({ keywords: { firstStrike: true }, activeWhile: { kind: 'yourTurn' } }),
      );
    }
    const reaver = complete(printed('Skophos Reaver', ['Creature'], { generic: 2, R: 1 }, 'During your turn, Skophos Reaver gets +2/+0.'));
    expect(reaver.statics?.[0]).toEqual(expect.objectContaining({ power: 2, toughness: 0, activeWhile: { kind: 'yourTurn' } }));
  });

  it("D. \"target creature can't block this turn\" — one target; counted and filtered forms still report", () => {
    expect(complete(SHORTCUTTER).triggers?.[0]?.effects).toEqual([
      { primitive: 'grantKeywordUntilEndOfTurn', params: { keywords: { cantBlock: true }, targets: 'creature' } },
    ]);
    reported(
      printed('Abandon the Post', ['Sorcery'], { R: 1 }, "Up to two target creatures can't block this turn."),
      /up to two target creatures can't block/i,
    );
    reported(printed('Falter', ['Instant'], { generic: 1, R: 1 }, "Creatures without flying can't block this turn."), /without flying can't block/i);
  });

  it('E. "return ~ to its owner\'s hand" as an activated body, with a mana cost and with a discard', () => {
    expect(complete(MERFOLK).activated?.[0]).toEqual(
      expect.objectContaining({ cost: { mana: { U: 1 } }, effects: [{ primitive: 'bounceSelf' }] }),
    );
    const aven = complete(printed('Skywing Aven', ['Creature'], { generic: 1, U: 1 }, "Flying\nDiscard a card: Return Skywing Aven to its owner's hand.", ['Bird', 'Soldier']));
    expect(aven.activated?.[0]).toEqual(expect.objectContaining({ cost: { discard: { count: 1 } }, effects: [{ primitive: 'bounceSelf' }] }));
  });

  it('F. the two enters-tapped conditions', () => {
    expect(complete(CAMPGROUND).entersTappedUnless).toEqual({ anyPlayerLifeAtMost: 13 });
    expect(complete(GARDEN).entersTappedUnless).toEqual({ minOpponents: 2 });
  });
});

// --- played ------------------------------------------------------------------

function fromPool(name: string): CardDefinition {
  const found = CARD_POOL.find((entry) => entry.name === name);
  if (!found) throw new Error(`pool missing ${name}`);
  return found;
}
const BEAR: CardDefinition = { id: 'bear', name: 'Test Bear', types: ['creature'], power: 2, toughness: 2 };
const ELF: CardDefinition = { id: 'elf', name: 'Test Elf', types: ['creature'], power: 1, toughness: 1 };

function act(state: GameState, action: GameAction, reg: Registry): GameState {
  const result = applyAction(state, action, DEFAULT_RULES, reg);
  const rejected = result.events.find((e) => e.type === 'actionRejected') as { reason?: string } | undefined;
  if (rejected) throw new Error(`unexpected rejection: ${rejected.reason ?? '?'}`);
  return result.state;
}
function rejection(state: GameState, action: GameAction, reg: Registry): string | undefined {
  const result = applyAction(state, action, DEFAULT_RULES, reg);
  return (result.events.find((e) => e.type === 'actionRejected') as { reason?: string } | undefined)?.reason;
}
type Question = NonNullable<GameState['pendingChoice']>;
function settle(state: GameState, reg: Registry): GameState {
  let s = state;
  let guard = 0;
  while ((s.stack.length > 0 || s.pendingChoice != null) && guard++ < 80) {
    const question: Question | null | undefined = s.pendingChoice;
    s = question
      ? act(s, { kind: 'answerChoice', player: question.chooser, choiceId: question.id, answer: defaultAnswerFor(question) } as GameAction, reg)
      : act(s, { kind: 'passPriority', player: s.priorityPlayer }, reg);
  }
  return s;
}
function toStep(state: GameState, reg: Registry, step: string, active: PlayerId = 'A'): GameState {
  let s = state;
  let guard = 0;
  while ((s.step !== step || s.activePlayer !== active || s.stack.length > 0 || s.pendingChoice) && guard++ < 600) {
    s = settle(s, reg);
    if (s.stack.length === 0 && s.pendingChoice == null) s = act(s, { kind: 'passPriority', player: s.priorityPlayer }, reg);
  }
  return s;
}
function game(reg: Registry): GameState {
  const forest = fromPool('Forest');
  const { state } = createGame({
    seed: SEED,
    decks: { A: { cards: Array.from({ length: 60 }, () => forest) }, B: { cards: Array.from({ length: 60 }, () => forest) } },
    registry: reg,
  });
  return state;
}
function put(state: GameState, def: CardDefinition, controller: PlayerId, zone: 'battlefield' | 'hand'): InstanceId {
  const id = state.nextInstanceId++;
  const instance = {
    instanceId: id,
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
  } as never;
  if (zone === 'hand') (state.players[controller].hand as unknown[]).push(instance);
  else (state.battlefield as unknown[]).push(instance);
  return id;
}
const onBoard = (state: GameState, id: InstanceId) => state.battlefield.find((c) => c.instanceId === id);
const FULL_POOL = { W: 9, U: 9, B: 9, R: 9, G: 9, C: 9 };

describe('§3.173 — played', () => {
  it('B. Sandblast mid-combat is offered the attacker and the blocker only, and kills the blocker', () => {
    const reg = buildRegistry();
    const sandblast = complete(SANDBLAST);
    let s = toStep(game(reg), reg, 'precombatMain');
    const attacker = put(s, BEAR, 'A', 'battlefield');
    const bystander = put(s, BEAR, 'A', 'battlefield');
    const blocker = put(s, BEAR, 'B', 'battlefield');
    const spell = put(s, sandblast, 'A', 'hand');
    // Nothing to aim at before combat.
    expect(generateLegalActions({ ...s, players: { ...s.players, A: { ...s.players.A, manaPool: FULL_POOL } } })
      .some((a) => a.kind === 'castSpell' && a.instanceId === spell)).toBe(false);
    s = toStep(s, reg, 'declareAttackers');
    s = act(s, { kind: 'declareAttackers', player: 'A', attackers: [attacker] }, reg);
    s = toStep(s, reg, 'declareBlockers');
    s = act(s, { kind: 'declareBlockers', player: 'B', blocks: [{ blocker, attacker }] }, reg);
    s = settle(s, reg);
    // A holds priority in the declare-blockers step once B has declared.
    let guard = 0;
    while (s.priorityPlayer !== 'A' && guard++ < 4) s = act(s, { kind: 'passPriority', player: s.priorityPlayer }, reg);
    s.players.A.manaPool = { ...FULL_POOL };
    const casts = generateLegalActions(s).filter(
      (a): a is Extract<GameAction, { kind: 'castSpell' }> => a.kind === 'castSpell' && a.instanceId === spell,
    );
    expect(casts.map((a) => a.targets?.[0]).sort()).toEqual([attacker, blocker].sort());
    expect(casts.some((a) => a.targets?.[0] === bystander)).toBe(false);
    s = act(s, casts.find((a) => a.targets?.[0] === blocker)!, reg);
    s = settle(s, reg);
    expect(onBoard(s, blocker), 'five damage to a 2/2 blocker').toBeUndefined();
    expect(onBoard(s, attacker)).toBeDefined();
  });

  it('A. Nausea shrinks BOTH boards; Turn the Tide only the opponent\'s', () => {
    const reg = buildRegistry();
    let s = toStep(game(reg), reg, 'precombatMain');
    const mine = put(s, ELF, 'A', 'battlefield');
    const theirs = put(s, ELF, 'B', 'battlefield');
    const theirBear = put(s, BEAR, 'B', 'battlefield');
    const nausea = put(s, complete(NAUSEA), 'A', 'hand');
    s.players.A.manaPool = { ...FULL_POOL };
    s = act(s, { kind: 'castSpell', player: 'A', instanceId: nausea, targets: [] }, reg);
    s = settle(s, reg);
    expect(onBoard(s, mine), 'my 1/1 died too').toBeUndefined();
    expect(onBoard(s, theirs)).toBeUndefined();
    const index = indexContinuous(s);
    expect(effectiveToughness(onBoard(s, theirBear)!, index.get(theirBear) ?? undefined)).toBe(1);

    const tide = put(s, complete(TURN_THE_TIDE), 'A', 'hand');
    const myBear = put(s, BEAR, 'A', 'battlefield');
    s.players.A.manaPool = { ...FULL_POOL };
    s = act(s, { kind: 'castSpell', player: 'A', instanceId: tide, targets: [] }, reg);
    s = settle(s, reg);
    const after = indexContinuous(s);
    // Nausea's -1/-1 is still on their Bear this turn, so the Tide takes it from 1 to -1.
    expect(effectivePower(onBoard(s, theirBear)!, after.get(theirBear) ?? undefined)).toBe(-1);
    expect(effectivePower(onBoard(s, myBear)!, after.get(myBear) ?? undefined), 'mine untouched').toBe(2);
  });

  it("D. Goblin Shortcutter's target cannot be declared as a blocker this turn", () => {
    const reg = buildRegistry();
    let s = toStep(game(reg), reg, 'precombatMain');
    const attacker = put(s, BEAR, 'A', 'battlefield');
    const wall = put(s, BEAR, 'B', 'battlefield');
    const other = put(s, BEAR, 'B', 'battlefield');
    const goblin = put(s, complete(SHORTCUTTER), 'A', 'hand');
    s.players.A.manaPool = { ...FULL_POOL };
    s = act(s, { kind: 'castSpell', player: 'A', instanceId: goblin, targets: [] }, reg);
    // The creature resolves; its enters trigger asks for a target — aim it at the wall.
    let guard = 0;
    while ((s.stack.length > 0 || s.pendingChoice != null) && guard++ < 80) {
      const question: Question | null | undefined = s.pendingChoice;
      s = question
        ? act(
            s,
            {
              kind: 'answerChoice',
              player: question.chooser,
              choiceId: question.id,
              answer: question.kind === 'selectTargets' ? { kind: 'selectTargets', targets: [wall] } : defaultAnswerFor(question),
            } as GameAction,
            reg,
          )
        : act(s, { kind: 'passPriority', player: s.priorityPlayer }, reg);
    }
    const stunned = wall;
    const free = other;
    s = toStep(s, reg, 'declareAttackers');
    s = act(s, { kind: 'declareAttackers', player: 'A', attackers: [attacker] }, reg);
    s = toStep(s, reg, 'declareBlockers');
    expect(rejection(s, { kind: 'declareBlockers', player: 'B', blocks: [{ blocker: stunned, attacker }] }, reg)).toMatch(
      /can't block|cannot block/i,
    );
    expect(rejection(s, { kind: 'declareBlockers', player: 'B', blocks: [{ blocker: free, attacker }] }, reg)).toBeUndefined();
  });

  it('E. Darting Merfolk returns itself to its owner\'s hand for {U}', () => {
    const reg = buildRegistry();
    let s = toStep(game(reg), reg, 'precombatMain');
    const merfolk = put(s, complete(MERFOLK), 'A', 'battlefield');
    s.players.A.manaPool = { W: 0, U: 1, B: 0, R: 0, G: 0, C: 0 };
    s = act(s, { kind: 'activateAbility', player: 'A', instanceId: merfolk, abilityIndex: 0 }, reg);
    s = settle(s, reg);
    expect(onBoard(s, merfolk)).toBeUndefined();
    expect(s.players.A.hand.some((c) => c.instanceId === merfolk)).toBe(true);
  });

  it('F. Abandoned Campground enters untapped only once a player is at 13 or less; Spire Garden enters tapped at a two-player table', () => {
    const reg = buildRegistry();
    const playLand = (def: CardDefinition, lifeB: number) => {
      let s = toStep(game(reg), reg, 'precombatMain');
      s.players.B.life = lifeB;
      const land = put(s, def, 'A', 'hand');
      s = act(s, { kind: 'playLand', player: 'A', instanceId: land }, reg);
      return onBoard(s, land)!.tapped;
    };
    expect(playLand(complete(CAMPGROUND), 20)).toBe(true);
    expect(playLand(complete(CAMPGROUND), 13)).toBe(false);
    expect(playLand(complete(GARDEN), 20)).toBe(true);
  });
});

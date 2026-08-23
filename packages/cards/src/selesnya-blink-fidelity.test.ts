/**
 * SELESNYA BLINK — a card-by-card RULES-FIDELITY audit, played rather than read.
 *
 * `fidelity.test.ts` already proves every pool entry is reproduced by the Oracle
 * compiler from its real printed text, so the DEFINITIONS are known good. What a
 * definition cannot tell you is whether the engine then plays it as printed, and
 * the deck this file audits is built entirely out of the one interaction most
 * likely to expose that gap: a permanent leaving and immediately re-entering.
 *
 * Two halves:
 *
 *  1. **The cards.** Thragtusk's two halves and a blink that collects both, the
 *     Closet triggering on YOUR end step only, Wood Elves fetching an UNTAPPED
 *     Forest (the printed card does not say tapped), Eternal Witness rebuying a
 *     card of ANY type, Attended Knight's Soldier, and Restoration Angel's flash.
 *
 *  2. **CR 400.7**, which is where the audit found real bugs. The returned card
 *     keeps its INSTANCE ID — a blink is not a new card, and every id-keyed
 *     reference in the state has to stay sound — and THREE rules in this engine
 *     were enforced purely by an id ceasing to be on the battlefield:
 *       - removal from combat (CR 506.4): a blinked attacker still connected for
 *         full damage and came back untapped, which is strictly better than the
 *         printed card;
 *       - the attachment state-based action (CR 704.5m/n): an Aura stayed on a
 *         creature it had never enchanted;
 *       - floating continuous effects: a Giant Growth survived the blink, and so
 *         did a "gain control until end of turn" — so blinking a stolen creature
 *         handed it BACK at end of turn, the exact opposite of what DESIGN §3.35
 *         says the `controller` seam exists for.
 *     `blinkOne` now says all three explicitly. Each assertion below fails if the
 *     corresponding line is removed.
 */

import { describe, expect, it } from 'vitest';
import type {
  CardDefinition,
  GameAction,
  GameEvent,
  GameState,
  InstanceId,
  PlayerId,
} from '@jonny-boi/core';
import {
  applyAction,
  createGame,
  DEFAULT_RULES,
  defaultAnswerFor,
  generateLegalActions,
} from '@jonny-boi/core';
import { buildRegistry } from './pool.js';
import { CARD_POOL } from '../data/pool.js';

type Registry = ReturnType<typeof buildRegistry>;

/**
 * One seed per scenario, so a change to one test cannot re-deal another. The
 * board every test uses is hand-built on top of the opening — nothing here
 * depends on what was drawn — but the shuffle still consumes the RNG.
 */
const SEEDS = {
  thragtusk: 4301,
  closetYours: 4302,
  closetTheirs: 4303,
  woodElves: 4304,
  witness: 4305,
  knight: 4306,
  angelFlash: 4307,
  angelBlink: 4308,
  attacker: 4309,
  blocker: 4310,
  equipment: 4311,
  aura: 4312,
  pump: 4313,
  theft: 4314,
} as const;

function getByName(name: string): CardDefinition {
  const card = CARD_POOL.find((entry) => entry.name === name);
  if (!card) throw new Error(`pool missing ${name}`);
  return card;
}

const FOREST = getByName('Forest');

/** Every event the current scenario has emitted, for counting draws and tokens. */
let seen: GameEvent[] = [];

function act(state: GameState, action: GameAction, reg: Registry): GameState {
  const result = applyAction(state, action, DEFAULT_RULES, reg);
  seen.push(...result.events);
  const rejected = result.events.find((e) => e.type === 'actionRejected');
  if (rejected) throw new Error(`unexpected rejection: ${(rejected as { reason: string }).reason}`);
  return result.state;
}

function pass(state: GameState, reg: Registry): GameState {
  const question = state.pendingChoice;
  if (question) {
    return act(
      state,
      { kind: 'answerChoice', player: question.chooser, choiceId: question.id, answer: defaultAnswerFor(question) },
      reg,
    );
  }
  return act(state, { kind: 'passPriority', player: state.priorityPlayer }, reg);
}

/**
 * Settle the stack, TAKING every offer: "yes" to each `confirm` and the first
 * candidate of each `selectCards`. `defaultAnswerFor` declines both, and a
 * declined blink (or a search that failed to find) is a test of nothing.
 */
function settle(state: GameState, reg: Registry): GameState {
  let s = state;
  let guard = 0;
  while ((s.stack.length > 0 || s.pendingChoice != null) && !s.gameOver && guard++ < 60) {
    const question = s.pendingChoice;
    if (question && question.kind === 'confirm') {
      s = act(
        s,
        { kind: 'answerChoice', player: question.chooser, choiceId: question.id, answer: { kind: 'confirm', yes: true } },
        reg,
      );
      continue;
    }
    if (question && question.kind === 'selectCards') {
      const picked = question.candidates.slice(0, Math.max(question.min, 1)).map((c) => c.instanceId);
      s = act(
        s,
        { kind: 'answerChoice', player: question.chooser, choiceId: question.id, answer: { kind: 'selectCards', instanceIds: picked } },
        reg,
      );
      continue;
    }
    s = pass(s, reg);
  }
  return s;
}

/** Pass priority until `player` holds it (never far — a step never turns over here). */
function priorityTo(state: GameState, player: PlayerId, reg: Registry): GameState {
  let s = state;
  let guard = 0;
  while (s.priorityPlayer !== player && !s.gameOver && guard++ < 8) s = pass(s, reg);
  return s;
}

/** Walk to `step` on the given player's turn, taking every offered "you may". */
function walkTo(state: GameState, reg: Registry, step: GameState['step'], activePlayer?: PlayerId): GameState {
  let s = state;
  let guard = 0;
  while (!(s.step === step && (activePlayer === undefined || s.activePlayer === activePlayer)) && !s.gameOver) {
    if (guard++ > 500) throw new Error(`never reached ${step}`);
    const question = s.pendingChoice;
    if (question && question.kind === 'confirm') {
      s = act(
        s,
        { kind: 'answerChoice', player: question.chooser, choiceId: question.id, answer: { kind: 'confirm', yes: true } },
        reg,
      );
      continue;
    }
    s = pass(s, reg);
  }
  return s;
}

function giveHand(state: GameState, player: PlayerId, def: CardDefinition): InstanceId {
  const id = state.nextInstanceId++;
  state.players[player].hand.push({
    instanceId: id,
    def,
    controller: player,
    owner: player,
    zone: 'hand',
    tapped: false,
    summoningSick: false,
    damageMarked: 0,
    markedByDeathtouch: false,
    counters: {},
  });
  return id;
}

function giveGraveyard(state: GameState, player: PlayerId, def: CardDefinition): InstanceId {
  const id = state.nextInstanceId++;
  state.players[player].graveyard.push({
    instanceId: id,
    def,
    controller: player,
    owner: player,
    zone: 'graveyard',
    tapped: false,
    summoningSick: false,
    damageMarked: 0,
    markedByDeathtouch: false,
    counters: {},
  });
  return id;
}

/**
 * Put a permanent straight onto the battlefield, already able to attack. Placing
 * rather than casting is what makes the assertions attributable: a creature that
 * never ENTERED cannot have fired its enters trigger, so every trigger counted
 * afterwards belongs to the blink.
 */
function place(state: GameState, def: CardDefinition, controller: PlayerId): InstanceId {
  const id = state.nextInstanceId++;
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
    attachedTo: null,
    counters: {},
  });
  return id;
}

/** An empty board in A's first main phase, with both players' mana unlimited. */
function openBoard(seed: number, reg: Registry): GameState {
  seen = [];
  const { state } = createGame({
    seed,
    decks: {
      A: { cards: Array.from({ length: 60 }, () => FOREST) },
      B: { cards: Array.from({ length: 60 }, () => FOREST) },
    },
    registry: reg,
  });
  const s = walkTo(state, reg, 'precombatMain');
  refillMana(s);
  return s;
}

/** Mana is not what any of these tests is about. */
function refillMana(state: GameState): void {
  state.players.A.manaPool = { W: 9, U: 9, B: 9, R: 9, G: 9, C: 9 };
  state.players.B.manaPool = { W: 9, U: 9, B: 9, R: 9, G: 9, C: 9 };
}

/** How many cards `player` has drawn so far, from the event log. */
function drawsBy(player: PlayerId): number {
  return seen.filter((e) => e.type === 'drawCard' && (e as { player: PlayerId }).player === player).length;
}

/** Blink `target` with Cloudshift ("Exile target creature you control, then return…"). */
function cloudshift(state: GameState, target: InstanceId, reg: Registry): GameState {
  const spell = giveHand(state, 'A', getByName('Cloudshift'));
  refillMana(state);
  return settle(act(state, { kind: 'castSpell', player: 'A', instanceId: spell, targets: [target] }, reg), reg);
}

// --- the deck's cards, played --------------------------------------------------------

describe('Thragtusk — "enters: gain 5 life" AND "leaves: create a 3/3 green Beast"', () => {
  it('one blink collects BOTH halves', () => {
    const reg = buildRegistry();
    let s = openBoard(SEEDS.thragtusk, reg);
    // Placed, not cast: the 5 life counted below can only be the blink's.
    const tusk = place(s, getByName('Thragtusk'), 'A');
    const lifeBefore = s.players.A.life;

    s = cloudshift(s, tusk, reg);

    expect(s.players.A.life - lifeBefore, 'the return re-fires "you gain 5 life"').toBe(5);
    const beasts = s.battlefield.filter((c) => c.def.name === 'Beast');
    expect(beasts, 'the exile fires "when this leaves, create a 3/3 green Beast"').toHaveLength(1);
    const beast = beasts[0];
    expect([beast?.def.power, beast?.def.toughness]).toEqual([3, 3]);
    expect(beast?.def.colors, 'a GREEN Beast').toEqual(['G']);
    expect(s.battlefield.some((c) => c.instanceId === tusk), 'and the Thragtusk itself came back').toBe(true);
  });
});

describe("Conjurer's Closet — \"at the beginning of YOUR end step\"", () => {
  it('blinks at its controller’s end step', () => {
    const reg = buildRegistry();
    let s = openBoard(SEEDS.closetYours, reg);
    place(s, getByName("Conjurer's Closet"), 'A');
    place(s, getByName('Wall of Omens'), 'A');
    const before = drawsBy('A');

    s = settle(walkTo(s, reg, 'end', 'A'), reg);

    expect(drawsBy('A') - before, 'the blinked Wall of Omens draws again').toBe(1);
  });

  it('does NOT blink at the OPPONENT’s end step — the word is "your"', () => {
    const reg = buildRegistry();
    let s = openBoard(SEEDS.closetTheirs, reg);
    // B owns the Closet and the Wall; A is the active player, so the end step we
    // walk to is A's. A trigger on "each player's end step" would fire here.
    place(s, getByName("Conjurer's Closet"), 'B');
    place(s, getByName('Wall of Omens'), 'B');
    const before = drawsBy('B');

    s = settle(walkTo(s, reg, 'end', 'A'), reg);

    expect(drawsBy('B') - before, 'B’s Closet must sit still on A’s end step').toBe(0);
  });
});

describe('Wood Elves — "search your library for a Forest card, put that card onto the battlefield"', () => {
  it('the Forest arrives UNTAPPED — the printed card does not say tapped', () => {
    const reg = buildRegistry();
    let s = openBoard(SEEDS.woodElves, reg);
    const elves = giveHand(s, 'A', getByName('Wood Elves'));

    s = settle(act(s, { kind: 'castSpell', player: 'A', instanceId: elves }, reg), reg);

    const fetched = s.battlefield.filter((c) => c.controller === 'A' && c.def.name === 'Forest');
    expect(fetched, 'exactly one Forest was fetched').toHaveLength(1);
    expect(fetched[0]?.tapped, 'a fetched Forest that arrived tapped would be a strictly worse card').toBe(false);
  });
});

describe('Eternal Witness — "return target CARD from your graveyard"', () => {
  it('offers every card type, not only creatures', () => {
    const reg = buildRegistry();
    let s = openBoard(SEEDS.witness, reg);
    const instant = giveGraveyard(s, 'A', getByName('Cloudshift'));
    const land = giveGraveyard(s, 'A', FOREST);
    const witness = giveHand(s, 'A', getByName('Eternal Witness'));

    s = act(s, { kind: 'castSpell', player: 'A', instanceId: witness }, reg);
    let guard = 0;
    while (s.pendingChoice == null && s.stack.length > 0 && guard++ < 30) s = pass(s, reg);

    const question = s.pendingChoice;
    expect(question?.kind, 'the trigger asks which card to rebuy').toBe('selectCards');
    const offered = (question as { candidates: readonly { instanceId: InstanceId }[] }).candidates.map(
      (c) => c.instanceId,
    );
    expect(offered, 'an INSTANT is a card in your graveyard').toContain(instant);
    expect(offered, 'so is a LAND').toContain(land);
  });
});

describe('Attended Knight — first strike, and a 1/1 white Soldier on entry', () => {
  it('brings the Soldier with it', () => {
    const reg = buildRegistry();
    let s = openBoard(SEEDS.knight, reg);
    const knight = giveHand(s, 'A', getByName('Attended Knight'));

    s = settle(act(s, { kind: 'castSpell', player: 'A', instanceId: knight }, reg), reg);

    const body = s.battlefield.find((c) => c.instanceId === knight);
    expect(body?.def.keywords?.firstStrike, 'first strike is half the card').toBe(true);
    const token = s.battlefield.find((c) => c.controller === 'A' && c.def.name === 'Soldier');
    expect(token, 'the Soldier token').toBeDefined();
    expect([token?.def.power, token?.def.toughness]).toEqual([1, 1]);
    expect(token?.def.colors, 'a WHITE Soldier').toEqual(['W']);
    expect(token?.def.types, 'a creature token').toContain('creature');
  });
});

describe('Restoration Angel — flash, and the blink it brings', () => {
  it('can be cast on the OPPONENT’s turn, where a creature without flash cannot', () => {
    const reg = buildRegistry();
    let s = openBoard(SEEDS.angelFlash, reg);
    const angel = giveHand(s, 'A', getByName('Restoration Angel'));
    const noFlash = giveHand(s, 'A', getByName('Attended Knight'));
    place(s, getByName('Wall of Omens'), 'A');

    s = walkTo(s, reg, 'upkeep', 'B');
    refillMana(s);
    let guard = 0;
    while (s.priorityPlayer !== 'A' && !s.gameOver && guard++ < 30) s = pass(s, reg);

    const castable = new Set(
      generateLegalActions(s, DEFAULT_RULES, reg)
        .filter((a) => a.kind === 'castSpell')
        .map((a) => (a as { instanceId: InstanceId }).instanceId),
    );
    expect(castable.has(angel), 'flash is what makes it an ambush blocker').toBe(true);
    expect(castable.has(noFlash), 'the control: a creature without flash waits for its own main phase').toBe(false);
  });

  it('its enters trigger really blinks the chosen creature', () => {
    const reg = buildRegistry();
    let s = openBoard(SEEDS.angelBlink, reg);
    const wall = place(s, getByName('Wall of Omens'), 'A');
    const angel = giveHand(s, 'A', getByName('Restoration Angel'));
    const before = drawsBy('A');

    s = settle(act(s, { kind: 'castSpell', player: 'A', instanceId: angel, targets: [wall] }, reg), reg);

    expect(drawsBy('A') - before, 'the wall entered again and drew again').toBe(1);
  });
});

// --- CR 400.7: what comes back is a NEW OBJECT ---------------------------------------

describe('CR 400.7 — a blinked permanent comes back as a new object', () => {
  it('an ATTACKER is removed from combat and connects for nothing (CR 506.4)', () => {
    const reg = buildRegistry();
    let s = openBoard(SEEDS.attacker, reg);
    const missionary = place(s, getByName('Lone Missionary'), 'A'); // 2/1
    const lifeBefore = s.players.B.life;

    s = walkTo(s, reg, 'declareAttackers');
    s = act(s, { kind: 'declareAttackers', player: 'A', attackers: [missionary] }, reg);
    s = cloudshift(s, missionary, reg);
    s = walkTo(s, reg, 'postcombatMain');

    expect(s.players.B.life, 'a creature that left the battlefield is not attacking any more').toBe(lifeBefore);
    const back = s.battlefield.find((c) => c.instanceId === missionary);
    expect(back?.tapped, 'and what came back is untapped — which is the other half of the same rule').toBe(false);
  });

  it('a BLOCKER is removed from combat, but its attacker stays blocked (CR 509.1h)', () => {
    const reg = buildRegistry();
    let s = openBoard(SEEDS.blocker, reg);
    // B attacks with a 2/1 into A's 1/1. Untouched, they trade.
    const attacker = place(s, getByName('Lone Missionary'), 'B');
    const blocker = place(s, getByName('Elvish Visionary'), 'A');
    const lifeBefore = s.players.A.life;

    s = walkTo(s, reg, 'declareAttackers', 'B');
    s = act(s, { kind: 'declareAttackers', player: 'B', attackers: [attacker] }, reg);
    s = walkTo(s, reg, 'declareBlockers', 'B');
    s = act(s, { kind: 'declareBlockers', player: 'A', blocks: [{ blocker, attacker }] }, reg);
    s = cloudshift(priorityTo(s, 'A', reg), blocker, reg);
    s = walkTo(s, reg, 'postcombatMain', 'B');

    expect(s.battlefield.some((c) => c.instanceId === blocker), 'the blinked blocker survives').toBe(true);
    expect(
      s.battlefield.some((c) => c.instanceId === attacker),
      'and deals nothing back, so the attacker survives too',
    ).toBe(true);
    expect(s.players.A.life, 'the attacker is still BLOCKED — removing its blocker does not unblock it').toBe(
      lifeBefore,
    );
  });

  it('EQUIPMENT falls off (CR 704.5n)', () => {
    const reg = buildRegistry();
    let s = openBoard(SEEDS.equipment, reg);
    const wall = place(s, getByName('Wall of Omens'), 'A');
    const equipment = place(s, getByName('Cobbled Wings'), 'A');
    (s.battlefield.find((c) => c.instanceId === equipment) as { attachedTo: InstanceId }).attachedTo = wall;

    s = cloudshift(s, wall, reg);

    const after = s.battlefield.find((c) => c.instanceId === equipment);
    expect(after, 'an Equipment stays on the battlefield when its host leaves').toBeDefined();
    expect(after?.attachedTo ?? null, 'but it is no longer attached to a creature that no longer exists').toBe(null);
  });

  it('an AURA is put into its owner’s graveyard (CR 704.5m)', () => {
    const reg = buildRegistry();
    let s = openBoard(SEEDS.aura, reg);
    const wall = place(s, getByName('Wall of Omens'), 'A');
    const aura = place(s, getByName('Angelic Gift'), 'A');
    (s.battlefield.find((c) => c.instanceId === aura) as { attachedTo: InstanceId }).attachedTo = wall;

    s = cloudshift(s, wall, reg);

    expect(s.battlefield.some((c) => c.instanceId === aura), 'the Aura has nothing to enchant').toBe(false);
    expect(s.players.A.graveyard.some((c) => c.instanceId === aura), 'so it goes to the graveyard').toBe(true);
  });

  it('an "until end of turn" pump does not survive it', () => {
    const reg = buildRegistry();
    let s = openBoard(SEEDS.pump, reg);
    const tusk = place(s, getByName('Thragtusk'), 'A');
    const growth = giveHand(s, 'A', getByName('Giant Growth'));

    s = settle(act(s, { kind: 'castSpell', player: 'A', instanceId: growth, targets: [tusk] }, reg), reg);
    expect(s.continuous, 'the pump is live before the blink — otherwise this proves nothing').toHaveLength(1);

    s = cloudshift(s, tusk, reg);

    expect(s.continuous.some((e) => e.targetInstanceId === tusk), 'the +3/+3 applied to the object that left').toBe(
      false,
    );
  });

  it('blinking a STOLEN creature keeps it — the control effect ended with the old object', () => {
    const reg = buildRegistry();
    let s = openBoard(SEEDS.theft, reg);
    const theirs = place(s, getByName('Wall of Omens'), 'B');
    const treason = giveHand(s, 'A', getByName('Act of Treason'));

    s = settle(act(s, { kind: 'castSpell', player: 'A', instanceId: treason, targets: [theirs] }, reg), reg);
    expect(s.battlefield.find((c) => c.instanceId === theirs)?.controller, 'stolen for the turn').toBe('A');

    s = cloudshift(s, theirs, reg);
    // Past the cleanup step, where an "until end of turn" control change would
    // hand the creature back.
    s = walkTo(s, reg, 'precombatMain', 'B');

    expect(
      s.battlefield.find((c) => c.instanceId === theirs)?.controller,
      'the theft outlives the turn, which is what the blink’s `controller` seam is for',
    ).toBe('A');
  });
});

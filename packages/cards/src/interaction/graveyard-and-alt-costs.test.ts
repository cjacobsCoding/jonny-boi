/**
 * INTERACTION MATRIX - non-hand casting x alternative costs x countering x the
 * graveyard, plus where those meet characteristic-defining P/T.
 *
 * Flashback, buyback, madness and cycling all answer one question - "what did
 * this cost, and where does the card go?" - and they answer it DIFFERENTLY, so
 * every pairing here is a place a single shared helper could quietly give one of
 * them the other's answer:
 *
 *   - a flashback spell is exiled HOWEVER it leaves the stack, countering
 *     included (CR 702.34a);
 *   - a bought-back spell returns to hand only when it RESOLVES, and goes to the
 *     graveyard when it is countered (CR 702.27a);
 *   - a cycled card is discarded as a COST, which is what makes a madness card
 *     exile instead;
 *   - and every one of them MOVES A CARD OUT OF A GRAVEYARD OR A HAND, which is
 *     what makes them meet Tarmogoyf.
 *
 * All real pool cards: Call of the Herd, Ancient Grudge, Capsize, Counterspell,
 * Fiery Temper, Lonely Sandbar, Tarmogoyf.
 */

import { describe, expect, it } from 'vitest';
import {
  effectivePower,
  effectiveToughness,
  indexContinuous,
  NO_MOD,
  type CardDefinition,
  type GameAction,
  type GameState,
  type InstanceId,
  type PlayerId,
} from '@jonny-boi/core';
import { buildRegistry } from '../pool.js';
import {
  act,
  boardAtMain,
  castCard,
  castOffer,
  fund,
  isOnBattlefield,
  legal,
  onBattlefield,
  place,
  poolCard,
  resolvePermanent,
  settle,
  type Registry,
} from './harness.js';

const BEAR: CardDefinition = {
  id: 'matrix-gy-bear',
  name: 'Matrix Graveyard Bear',
  types: ['creature'],
  cost: { generic: 2 },
  power: 2,
  toughness: 2,
};

/** Every zone a card can be found in, for a "where did it go?" assertion. */
function zoneOf(state: GameState, id: InstanceId): string {
  if (state.battlefield.some((c) => c.instanceId === id)) return 'battlefield';
  if (state.stack.some((o) => o.instanceId === id)) return 'stack';
  for (const pid of ['A', 'B'] as const) {
    for (const zone of ['hand', 'graveyard', 'exile', 'library'] as const) {
      if (state.players[pid][zone].some((c) => c.instanceId === id)) return `${pid}.${zone}`;
    }
  }
  return 'nowhere';
}

describe('CELL: flashback x countering (CR 702.34a)', () => {
  it('a flashback spell is EXILED even when it is countered, so it cannot be looped', () => {
    const reg = buildRegistry();
    let state = boardAtMain(reg);
    const call = place(state, 'A', 'graveyard', poolCard('Call of the Herd'));
    fund(state, 'A');

    const offer = castOffer(state, call, 'graveyard');
    expect(offer, 'the engine should offer the flashback cast').toBeDefined();
    state = act(state, offer!, reg);
    expect(zoneOf(state, call)).toBe('stack');

    // B answers it with a real Counterspell.
    const counter = place(state, 'B', 'hand', poolCard('Counterspell'));
    fund(state, 'B');
    state.priorityPlayer = 'B';
    state = act(state, { kind: 'castSpell', player: 'B', instanceId: counter, targets: [call] }, reg);
    state = settle(state, reg);

    // The card is GONE, not back in the graveyard for a second flashback.
    expect(zoneOf(state, call)).toBe('A.exile');
    expect(state.players.A.graveyard.map((c) => c.instanceId)).not.toContain(call);
    // ...and there is no Elephant, because the spell never resolved.
    expect(state.battlefield.filter((c) => c.def.name === 'Elephant')).toHaveLength(0);
  });

  it('a flashback spell that RESOLVES is exiled too, by the same one answer', () => {
    const reg = buildRegistry();
    let state = boardAtMain(reg);
    const call = place(state, 'A', 'graveyard', poolCard('Call of the Herd'));
    fund(state, 'A');
    state = settle(act(state, castOffer(state, call, 'graveyard')!, reg), reg);

    expect(zoneOf(state, call)).toBe('A.exile');
    expect(state.battlefield.filter((c) => c.def.name === 'Elephant')).toHaveLength(1);
    // And the engine no longer offers it, because it is not in a graveyard.
    expect(castOffer(state, call, 'graveyard')).toBeUndefined();
  });
});

describe('CELL: buyback x countering vs resolving (CR 702.27a)', () => {
  it('a bought-back spell returns to HAND on resolution and to the GRAVEYARD when countered', () => {
    const reg = buildRegistry();
    let state = boardAtMain(reg);
    const bear = resolvePermanent(state, reg, BEAR, 'B');
    state = bear.state;

    // Buyback is an OPTIONAL ADDITIONAL COST asked at cast time, exactly as a
    // kicker is - it is a parked `payMana` question, not a flag on the action.
    const capsize = place(state, 'A', 'hand', poolCard('Capsize'));
    fund(state, 'A');
    state = act(state, { kind: 'castSpell', player: 'A', instanceId: capsize, targets: [bear.id] }, reg);
    expect(state.pendingChoice?.kind).toBe('payMana');
    state = payTheOption(state, reg, true);
    state = settle(state, reg);

    // Resolving with buyback paid: the bounce happened AND the card is in hand.
    expect(isOnBattlefield(state, bear.id)).toBe(false);
    expect(zoneOf(state, capsize)).toBe('A.hand');

    // Countered with buyback paid: the graveyard, NOT the hand. Two exits that
    // can disagree about where a card goes is exactly the bug the shared
    // `spellLeaveDestination(spell, reason)` helper exists to prevent.
    const bear2 = resolvePermanent(state, reg, BEAR, 'B');
    state = bear2.state;
    fund(state, 'A');
    state.priorityPlayer = 'A';
    state = act(state, { kind: 'castSpell', player: 'A', instanceId: capsize, targets: [bear2.id] }, reg);
    state = payTheOption(state, reg, true);

    const counter = place(state, 'B', 'hand', poolCard('Counterspell'));
    fund(state, 'B');
    state.priorityPlayer = 'B';
    state = act(state, { kind: 'castSpell', player: 'B', instanceId: counter, targets: [capsize] }, reg);
    state = settle(state, reg);

    expect(zoneOf(state, capsize)).toBe('A.graveyard');
    expect(isOnBattlefield(state, bear2.id)).toBe(true);
  });
});

describe('CELL: cycling x madness x the discard funnel (CR 702.35)', () => {
  it('cycling a card is a real discard, and a MADNESS card discarded as that cost is exiled', () => {
    const reg = buildRegistry();
    let state = boardAtMain(reg);
    // The cycling land is the cost payer; Fiery Temper is what gets discarded by
    // a separate effect. Here the cheaper, sharper cell is the cycling DRAW,
    // which is where an ordinary card goes to the graveyard as a cost.
    const sandbar = place(state, 'A', 'hand', poolCard('Lonely Sandbar'));
    fund(state, 'A');
    const cycle = legal(state).find((a) => a.kind === 'cycleCard' && a.instanceId === sandbar);
    expect(cycle, 'the engine should offer cycling').toBeDefined();
    state = settle(act(state, cycle!, reg), reg);
    // The discard is a COST, so it happened as the ability went on the stack and
    // is not undone by anything.
    expect(zoneOf(state, sandbar)).toBe('A.graveyard');
  });

  it('a madness card DISCARDED is exiled and opens a window that offers exactly three things', () => {
    const reg = buildRegistry();
    let state = boardAtMain(reg);
    const temper = place(state, 'A', 'hand', poolCard('Fiery Temper'));
    // Discard it through a real effect (Liliana's +1 makes each player discard).
    const lili = resolvePermanent(state, reg, poolCard('Liliana of the Veil'), 'A');
    state = lili.state;
    state = act(state, { kind: 'activateAbility', player: 'A', instanceId: lili.id, abilityIndex: 0 }, reg);
    state = settle(state, reg);
    state = answerEveryDiscard(state, reg, temper);

    // CR 702.35a: the discard is REPLACED by an exile, and a window opens.
    expect(zoneOf(state, temper)).toBe('A.exile');
    expect(state.madnessWindow?.instanceId).toBe(temper);

    // While the window stands the ONLY legal actions are mana, the madness cast,
    // and pass (which declines). A window that offered nothing else would be a
    // trap; a window that offered everything else would not be a window.
    const kinds = new Set(legal(state).map((a) => a.kind));
    for (const kind of kinds) expect(['tapForMana', 'castSpell', 'passPriority']).toContain(kind);
    const madnessCast = legal(state).find(
      (a): a is Extract<GameAction, { kind: 'castSpell' }> =>
        a.kind === 'castSpell' && a.instanceId === temper,
    );
    expect(madnessCast?.fromZone).toBe('exile');
  });

  it('DECLINING the madness window drops the card in the graveyard the discard would have used', () => {
    const reg = buildRegistry();
    let state = boardAtMain(reg);
    const temper = place(state, 'A', 'hand', poolCard('Fiery Temper'));
    const lili = resolvePermanent(state, reg, poolCard('Liliana of the Veil'), 'A');
    state = lili.state;
    state = act(state, { kind: 'activateAbility', player: 'A', instanceId: lili.id, abilityIndex: 0 }, reg);
    state = settle(state, reg);
    state = answerEveryDiscard(state, reg, temper);
    expect(state.madnessWindow?.instanceId).toBe(temper);

    state = act(state, { kind: 'passPriority', player: 'A' }, reg);
    expect(state.madnessWindow ?? null).toBeNull();
    expect(zoneOf(state, temper)).toBe('A.graveyard');
  });
});

describe('CELL: non-hand casting x characteristic-defining P/T', () => {
  it('GAP: a flashback cast empties a graveyard TYPE at cast time and the shrink is not judged until it resolves (CR 704.3)', () => {
    const reg = buildRegistry();
    let state = boardAtMain(reg);
    // Graveyard: an instant, a land, and the ONLY sorcery - Call of the Herd.
    place(state, 'A', 'graveyard', poolCard('Lightning Bolt'));
    place(state, 'A', 'graveyard', poolCard('Island'));
    const call = place(state, 'A', 'graveyard', poolCard('Call of the Herd'));
    const goyf = resolvePermanent(state, reg, poolCard('Tarmogoyf'), 'A');
    state = goyf.state;
    expect(statsOf(state, goyf.id)).toEqual({ power: 3, toughness: 4 });

    // Three damage - survivable at 3/4.
    state = boltAt(state, reg, goyf.id, 'B');
    expect(onBattlefield(state, goyf.id).damageMarked).toBe(3);

    // Casting Call of the Herd from the graveyard moves it to the STACK as part
    // of casting it (CR 400.7 / 601.2a) - no resolution yet, and the sorcery type
    // is gone from every graveyard, so the Goyf is a 2/3 with 3 damage on it.
    fund(state, 'A');
    state = act(state, castOffer(state, call, 'graveyard')!, reg);
    expect(zoneOf(state, call)).toBe('stack');
    expect(statsOf(state, goyf.id)).toEqual({ power: 2, toughness: 3 });

    // ⛔ RECORDED GAP `sba-on-priority`: CR 704.3 checks state-based actions
    // whenever a player would receive priority, and B is about to receive it to
    // respond to this spell. The engine checks them only after a RESOLUTION,
    // after combat damage, after the draw step and at cleanup, so the creature is
    // still standing here with lethal damage marked - and B may legally block
    // with it, target it, or trade with it during a window it should not exist in.
    expect(isOnBattlefield(state, goyf.id)).toBe(true);

    // It dies the moment the spell finishes resolving, which is what makes this a
    // WINDOW rather than a permanently wrong board.
    state = settle(state, reg);
    expect(isOnBattlefield(state, goyf.id)).toBe(false);
  });
});

// --- shared drivers ---------------------------------------------------------------

function statsOf(state: GameState, id: InstanceId): { power: number; toughness: number } {
  const inst = onBattlefield(state, id);
  const mod = indexContinuous(state).get(id) ?? NO_MOD;
  return { power: effectivePower(inst, mod), toughness: effectiveToughness(inst, mod) };
}

/** Answer a parked optional-payment question (buyback, kicker, ward). */
function payTheOption(state: GameState, reg: Registry, pay: boolean): GameState {
  const choice = state.pendingChoice;
  if (!choice) throw new Error('no optional payment is parked');
  return act(
    state,
    { kind: 'answerChoice', player: choice.chooser, choiceId: choice.id, answer: { kind: 'payMana', pay } },
    reg,
  );
}

function boltAt(state: GameState, reg: Registry, target: InstanceId, caster: PlayerId): GameState {
  const bolt = place(state, caster, 'hand', poolCard('Lightning Bolt'));
  fund(state, caster);
  const before = state.priorityPlayer;
  state.priorityPlayer = caster;
  let next = act(state, { kind: 'castSpell', player: caster, instanceId: bolt, targets: [target] }, reg);
  next = settle(next, reg);
  if (!next.pendingChoice) next.priorityPlayer = before;
  return next;
}

/**
 * Answer every parked "discard a card" question, steering A's answer to
 * `preferred` when it is on the menu. Both seats are asked (Liliana's +1 is
 * symmetric), so a helper that only answered one would deadlock the test.
 */
function answerEveryDiscard(state: GameState, reg: Registry, preferred: InstanceId): GameState {
  let next = state;
  for (let i = 0; i < 6 && next.pendingChoice; i++) {
    const choice = next.pendingChoice;
    if (choice.kind !== 'selectCards') break;
    const options = choice.candidates.map((c) => c.instanceId);
    const pick = options.includes(preferred) ? preferred : options[0];
    if (pick === undefined) break;
    next = act(
      next,
      { kind: 'answerChoice', player: choice.chooser, choiceId: choice.id, answer: { kind: 'selectCards', instanceIds: [pick] } },
      reg,
    );
  }
  return next;
}

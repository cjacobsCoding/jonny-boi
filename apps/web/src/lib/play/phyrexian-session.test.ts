/**
 * THE HUMAN AFFORDANCE FOR A PHYREXIAN COST (§3.143, CR 107.4f).
 *
 * `{B/P}` is "{B}, or 2 life", so Dismember is not one offer but three —
 * "{1}{B}{B}", "{1}{B} and 2 life", "{1} and 4 life" — priced differently,
 * funded differently, and the choice between them is the player's. The board
 * keyed a cast on instance + face, which was enough while a split card was the
 * only way one instance offered two casts; the failure mode here is the worst
 * kind, the same one split cards had: ONE button, labelled with a cost, that
 * charges a different one.
 *
 * So `castOptions()` now returns one option per fundable life amount, each
 * carrying the `phyrexianLife` its action must name, each afforded on its own
 * terms — and `castWithAutoTap` taps for the reading it is casting, not for the
 * printed cost. This pins that end to end, through the real engine.
 */
import { describe, expect, it } from 'vitest';
import { createEffectRegistry, createGame, type CardDefinition, type CardInstance, type PlayerId } from '@jonny-boi/core';
import { GameSession, type CastOption } from './session.js';
import { castPriceText, castWayLabel } from './option-labels.js';
import { manaStillNeeded, stillNeededText } from './mana-picker.js';
import { openProposal, stepProposal, type Proposal, type ProposalStep } from './proposal.js';

const SEAT_NAMES: Readonly<Record<PlayerId, string>> = { A: 'Alice', B: 'Bob' };

const SWAMP: CardDefinition = {
  id: 'swamp',
  name: 'Swamp',
  types: ['land'],
  basic: true,
  subtypes: ['swamp'],
  produces: ['B'],
};

const MOUNTAIN: CardDefinition = {
  id: 'mountain',
  name: 'Mountain',
  types: ['land'],
  basic: true,
  subtypes: ['mountain'],
  produces: ['R'],
};

/** Dismember's shape: `{1}{B/P}{B/P}` — the card this whole system exists for. */
const DISMEMBER: CardDefinition = {
  id: 'dismember',
  name: 'Dismember',
  types: ['instant'],
  timing: 'instant',
  cost: { generic: 1, hybrid: [['B', { life: 2 }], ['B', { life: 2 }]] },
  effects: [{ primitive: 'dealDamage', params: { amount: 5, targets: 'any' } }],
};

/** The control: same colours, same mana value, NO Phyrexian symbol. */
const DOOM_BLADE: CardDefinition = {
  id: 'doom-blade',
  name: 'Doom Blade',
  types: ['instant'],
  timing: 'instant',
  cost: { generic: 1, B: 1 },
  effects: [{ primitive: 'dealDamage', params: { amount: 5, targets: 'any' } }],
};

type State = ReturnType<typeof createGame>['state'];

/** A's precombat main with `lands` copies of `land` untapped and an empty hand. */
function buildState(land: CardDefinition, lands: number): State {
  const registry = createEffectRegistry();
  const deck = { cards: Array.from({ length: 30 }, () => land) };
  const { state } = createGame({ seed: 11, decks: { A: deck, B: deck }, registry });
  state.step = 'precombatMain';
  state.activePlayer = 'A';
  state.priorityPlayer = 'A';
  state.stack = [];
  state.players.A.hand = [];
  state.players.B.hand = [];
  for (let i = 0; i < lands; i++) {
    state.battlefield.push({
      instanceId: state.nextInstanceId++,
      def: land,
      controller: 'A',
      owner: 'A',
      zone: 'battlefield',
      tapped: false,
      summoningSick: false,
      damageMarked: 0,
      markedByDeathtouch: false,
      counters: {},
    });
  }
  return state;
}

/** Put a definition in A's hand and return its instance id. */
function toHand(state: State, def: CardDefinition): number {
  const inst: CardInstance = {
    instanceId: state.nextInstanceId++,
    def,
    controller: 'A',
    owner: 'A',
    zone: 'hand',
    tapped: false,
    summoningSick: false,
    damageMarked: 0,
    markedByDeathtouch: false,
    counters: {},
  };
  state.players.A.hand.push(inst);
  return inst.instanceId;
}

function sessionOver(state: State): GameSession {
  return GameSession.fromCreated({ state, events: [] }, createEffectRegistry(), SEAT_NAMES);
}

describe('a Phyrexian cost in hand', () => {
  it('offers EVERY fundable reading when the board can pay them all', () => {
    const state = buildState(SWAMP, 3);
    const id = toHand(state, DISMEMBER);
    const options = sessionOver(state).castOptions().filter((o) => o.instanceId === id);

    // {1}{B}{B} off three Swamps, {1}{B} + 2 life off two, {1} + 4 life off one.
    expect(options.map((o) => o.phyrexianLife ?? 0)).toEqual([0, 2, 4]);
    // The all-mana reading is the object it has always been: no field at all,
    // not a zero — the board keys on it and the engine action omits it too.
    expect('phyrexianLife' in (options[0] as object)).toBe(false);
    // Every reading is payable right now from the pool the Swamps can make…
    expect(options.every((o) => o.affordableWithTap)).toBe(true);
    // …and all three name the SAME printed cost, which is exactly why the cost
    // alone cannot tell them apart and the option has to carry the life.
    expect(options.every((o) => o.cost === DISMEMBER.cost)).toBe(true);
  });

  it('offers ONLY the life reading when the board has no black mana', () => {
    const state = buildState(MOUNTAIN, 2);
    const id = toHand(state, DISMEMBER);
    const options = sessionOver(state).castOptions().filter((o) => o.instanceId === id);

    // {1}{B}{B} and {1}{B} are both unfundable off Mountains; {1} and 4 life is
    // not. Dropping the two that cannot be paid is the same rule every other
    // unaffordable cast follows.
    expect(options).toHaveLength(1);
    expect(options[0]!.phyrexianLife).toBe(4);
    expect(options[0]!.affordableWithTap).toBe(true);
  });

  it('casts the life reading: pays the life, and taps only what that reading needs', () => {
    const state = buildState(MOUNTAIN, 2);
    const id = toHand(state, DISMEMBER);
    const session = sessionOver(state);
    const option = session.castOptions().find((o) => o.instanceId === id);
    expect(option?.phyrexianLife).toBe(4);

    const before = session.state.players.A.life;
    const result = session.castWithAutoTap(id, ['B'], 'hand', option!.face, option!.phyrexianLife);
    expect(result.rejected).toBeNull();

    const after = result.session.state;
    // The life is really gone — the whole claim of the reading.
    expect(after.players.A.life).toBe(before - 4);
    // And exactly ONE Mountain paid for it. An auto-tap planning the printed
    // cost would have grabbed both and still not covered {B}{B}.
    expect(after.battlefield.filter((c) => c.tapped)).toHaveLength(1);
    expect(after.stack).toHaveLength(1);
  });

  it('casts the all-mana reading with no life lost at all', () => {
    const state = buildState(SWAMP, 3);
    const id = toHand(state, DISMEMBER);
    const session = sessionOver(state);
    const before = session.state.players.A.life;

    const result = session.castWithAutoTap(id, ['B'], 'hand', undefined, 0);
    expect(result.rejected).toBeNull();
    expect(result.session.state.players.A.life).toBe(before);
    expect(result.session.state.battlefield.filter((c) => c.tapped)).toHaveLength(3);
  });

  it('leaves a cost with NO Phyrexian symbol exactly as it was', () => {
    const state = buildState(SWAMP, 3);
    const id = toHand(state, DOOM_BLADE);
    const options = sessionOver(state).castOptions().filter((o) => o.instanceId === id);

    expect(options).toHaveLength(1);
    // Byte-identical, field for field: the life system must be invisible to
    // every card in the game that does not print the symbol.
    expect(Object.keys(options[0] as object).sort()).toEqual(
      ['affordableNow', 'affordableWithTap', 'cardId', 'cost', 'instanceId', 'name', 'needsTarget', 'requirement'],
    );
  });
});

describe('what a reading says it costs', () => {
  const printed = { name: 'Dismember', cost: DISMEMBER.cost } as const;

  it('prices each reading in the words a player reads', () => {
    expect(castPriceText(printed)).toBe('{1}{B/P}{B/P}');
    expect(castPriceText({ ...printed, phyrexianLife: 2 })).toBe('{1}{B/P} + 2 life');
    expect(castPriceText({ ...printed, phyrexianLife: 4 })).toBe('{1} + 4 life');
  });

  it('says just the life when life buys the whole cost', () => {
    // Gitaxian Probe's shape: `{U/P}` and nothing else. "{0} + 2 life" would read
    // as a price with a mana part; there isn't one.
    const probe = { name: 'Gitaxian Probe', cost: { hybrid: [['U', { life: 2 }]] } } as const;
    expect(castPriceText({ ...probe, phyrexianLife: 2 })).toBe('2 life');
  });

  it('labels the menu button with the name AND the price when there is a choice', () => {
    expect(castWayLabel(printed, 1)).toBe('Cast it');
    expect(castWayLabel(printed, 3)).toBe('Cast Dismember — {1}{B/P}{B/P}');
    expect(castWayLabel({ ...printed, phyrexianLife: 4 }, 3)).toBe('Cast Dismember — {1} + 4 life');
  });
});

describe('the mana picker readout, on a reading that pays life', () => {
  const pool = { W: 0, U: 0, B: 0, R: 1, G: 0, C: 0 };

  it('stops demanding the symbols the life already bought', () => {
    const cost = DISMEMBER.cost!;
    // One red mana floating, paying the {1}: with 4 life committed there is
    // nothing left to find, and the readout has to say so or the picker sits at
    // "Still needed" with the Confirm button lit.
    expect(manaStillNeeded(pool, cost, 4)).toEqual({});
    expect(stillNeededText(manaStillNeeded(pool, cost, 4))).toBe('Fully paid — confirm to cast.');
    // …and with none committed it still owes both black symbols.
    expect(manaStillNeeded(pool, cost, 0).hybrid).toHaveLength(2);
  });
});

// --- the path the human seat actually takes ----------------------------------------
/**
 * THE CAST TRANSACTION carries the reading too (§3.143 × the §3.143 proposal).
 *
 * The tests above call `castWithAutoTap` directly — which is not how the board
 * casts anything any more. Every human cast now opens a PROPOSAL and confirms
 * it, and `dispatchOpening` is the single place that turns the chosen
 * `CastOption` back into an engine action. That makes it the one seam where the
 * reading can be silently lost: drop `phyrexianLife` there and every test above
 * stays green, the compiler stays quiet, and Phyrexian casting is simply gone
 * from the only seat a person plays on — "built, tested, unreachable".
 *
 * So these drive the proposal, not the session. They are the guard on that
 * argument, and each one reddens if it is dropped.
 */
describe('a Phyrexian reading cast through the proposal', () => {
  /** Open a proposal on `option`, aim it at Bob, and confirm — as the board does. */
  function castThroughProposal(session: GameSession, option: CastOption): ProposalStep {
    const opened = openProposal(session, { kind: 'cast', option }, 'A', 1);
    if (opened.kind !== 'open') throw new Error(`could not open a proposal: "${opened.kind}"`);
    const aimed = stepProposal(opened.proposal, { kind: 'setTargets', targets: ['B'] });
    if (aimed.kind !== 'open') throw new Error(`could not aim the proposal: "${aimed.kind}"`);
    return stepProposal(aimed.proposal as Proposal, { kind: 'confirm' });
  }

  it('casts the life reading off a board with NO black mana at all', () => {
    // Two Mountains and Dismember: "{1}{B}{B}" and "{1}{B} and 2 life" are both
    // unfundable here, so the 4-life reading is the ONLY way this card is
    // castable. A dispatch that forgets the life asks the engine for a black
    // cost this board cannot pay, and the confirm comes back REFUSED — the
    // player clicks Cast and is told they are short of mana they never needed.
    const state = buildState(MOUNTAIN, 2);
    const id = toHand(state, DISMEMBER);
    const session = sessionOver(state);
    const option = session.castOptions().find((o) => o.instanceId === id);
    expect(option?.phyrexianLife).toBe(4);
    const before = session.state.players.A.life;

    const step = castThroughProposal(session, option as CastOption);

    expect(step.kind).toBe('committed');
    if (step.kind !== 'committed') return;
    const after = step.session.state;
    expect(after.players.A.life).toBe(before - 4);
    expect(after.stack).toHaveLength(1);
    // One Mountain paid the {1}; the life paid the rest.
    expect(after.battlefield.filter((c) => c.tapped)).toHaveLength(1);
  });

  it('casts the reading the player CHOSE when the board could pay either way', () => {
    // Three Swamps fund all three readings, so a dropped `phyrexianLife` does not
    // fail loudly here — it succeeds at the WRONG price, taking three lands
    // instead of one land and four life. That is the worse half of the bug: the
    // spell resolves, so nothing looks broken, and the player paid something
    // they did not agree to. Both halves of the price are asserted.
    const state = buildState(SWAMP, 3);
    const id = toHand(state, DISMEMBER);
    const session = sessionOver(state);
    const option = session.castOptions().find((o) => (o.phyrexianLife ?? 0) === 4 && o.instanceId === id);
    expect(option, 'the 4-life reading should be on the menu off three Swamps').toBeDefined();
    const before = session.state.players.A.life;

    const step = castThroughProposal(session, option as CastOption);

    expect(step.kind).toBe('committed');
    if (step.kind !== 'committed') return;
    const after = step.session.state;
    expect(after.players.A.life).toBe(before - 4);
    // ONE Swamp, not three: the other two are still untapped, which is the whole
    // reason a player picks this reading.
    expect(after.battlefield.filter((c) => c.tapped)).toHaveLength(1);
  });

  it('still casts the all-mana reading for no life, through the same seam', () => {
    // The control. `phyrexianLife` is absent on this option (not zero), so this
    // is also the check that threading it does not hand the engine `undefined`
    // where it expects a number — every cast in the game but a handful comes
    // through here with no field at all.
    const state = buildState(SWAMP, 3);
    const id = toHand(state, DISMEMBER);
    const session = sessionOver(state);
    const option = session.castOptions().find((o) => o.instanceId === id && o.phyrexianLife === undefined);
    expect(option, 'the all-mana reading should be on the menu off three Swamps').toBeDefined();
    const before = session.state.players.A.life;

    const step = castThroughProposal(session, option as CastOption);

    expect(step.kind).toBe('committed');
    if (step.kind !== 'committed') return;
    const after = step.session.state;
    expect(after.players.A.life).toBe(before);
    expect(after.battlefield.filter((c) => c.tapped)).toHaveLength(3);
  });
});

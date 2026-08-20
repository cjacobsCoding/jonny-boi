/**
 * A COPY OF A SPELL ON THE STACK (CR 707.10) — the object that is not a card.
 *
 * THE ONE CLAIM EVERY TEST HERE DEFENDS: **a copy of a spell reaches no zone.**
 * `spellLeaveDestination` had four answers, all of them a zone, and taking any
 * of them would leave a phantom CARD that delirium counts, that Tarmogoyf reads,
 * that flashback could recast and that "return target creature card from your
 * graveyard" could target — a whole card, from nowhere, every time a Reverberate
 * resolves. So the tests do not merely check that a copy resolved; they count
 * the cards in every zone before and after and require the totals to be equal.
 *
 * The rest is CR 707.10's second half — the copy carries every decision made for
 * the original (its targets, its X, its kicks, its announced modes) — and the
 * aiming moment the engine never had ("you may choose new targets for the
 * copy"), which is a question asked from INSIDE a resolution.
 */

import { describe, expect, it } from 'vitest';
import type { CardDefinition, GameEvent, GameState, InstanceId, PlayerId } from './index.js';
import { applyAction, createEffectRegistry, createGame, spellLeaveDestination } from './index.js';
import {
  makeSpellCopy,
  spellCopyAimAt,
  spellCopyAimRestriction,
  spellCopyAimSlots,
  withSpellCopyAim,
  MODELESS_AIM_SLOT,
} from './spell-copy.js';
import { cloneState } from './internal/clone.js';
import type { CardInstance, SpellStackObject } from './state.js';
import { deckOf, landDef } from './test-fixtures.js';

const SEED = 20260820;

/** "Deals 3 damage to any target" — the spell every copy test copies. */
const BOLT: CardDefinition = {
  id: 'bolt-test',
  name: 'Test Bolt',
  types: ['instant'],
  cost: { R: 1 },
  effects: [{ primitive: 'testBolt', params: { amount: 3, targets: 'any' } }],
};

/**
 * A registry carrying the ONE primitive these tests need.
 *
 * Written here rather than imported: core cannot depend on `@jonny-boi/cards`
 * (the dependency runs the other way), and a copy of a spell must be proved to
 * resolve for real — dealing its damage a second time — rather than merely
 * leaving the stack. An unregistered primitive would no-op, and the test would
 * pass while proving nothing.
 */
function boltRegistry(): ReturnType<typeof createEffectRegistry> {
  const registry = createEffectRegistry();
  registry.register('testBolt', (ctx) => {
    const target = ctx.targets[0];
    if (target === undefined || target === 'A' || target === 'B') return;
    const victim = ctx.state.battlefield.find((c) => c.instanceId === target);
    if (!victim) return; // already gone — the copy fizzles, exactly as printed
    const amount = Number(ctx.params.amount ?? 0);
    victim.damageMarked += amount;
    ctx.emit({
      type: 'damageDealt',
      source: ctx.source.instanceId,
      target: victim.instanceId,
      amount,
      combat: false,
    });
  });
  return registry;
}

/** A vanilla 2/2 to be a legal re-aim target. */
const BEAR: CardDefinition = {
  id: 'bear-test',
  name: 'Test Bear',
  types: ['creature'],
  cost: { generic: 1, G: 1 },
  power: 2,
  toughness: 2,
};

function mainPhase(): GameState {
  const land = landDef('Mountain', 'R');
  const { state } = createGame({
    seed: SEED,
    decks: { A: deckOf(land, 30), B: deckOf(land, 30) },
    registry: createEffectRegistry(),
  });
  state.step = 'precombatMain';
  state.activePlayer = 'A';
  state.priorityPlayer = 'A';
  state.stack = [];
  state.players.A.hand = [];
  state.players.B.hand = [];
  state.players.A.manaPool = { W: 9, U: 9, B: 9, R: 9, G: 9, C: 9 };
  return state;
}

function place(state: GameState, def: CardDefinition, controller: PlayerId): CardInstance {
  const inst: CardInstance = {
    instanceId: state.nextInstanceId++,
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
  };
  state.battlefield.push(inst);
  return inst;
}

/** Put a spell on the stack by hand, with whatever cast-time decisions it made. */
function onStack(
  state: GameState,
  def: CardDefinition,
  controller: PlayerId,
  extra: Partial<SpellStackObject> = {},
): SpellStackObject {
  const instanceId = state.nextInstanceId++;
  const spell: SpellStackObject = {
    kind: 'spell',
    instanceId,
    card: {
      instanceId,
      def,
      controller,
      owner: controller,
      zone: 'stack',
      tapped: false,
      summoningSick: false,
      damageMarked: 0,
      markedByDeathtouch: false,
      counters: {},
    },
    controller,
    resolvesTo: def.types.includes('creature') ? 'battlefield' : 'graveyard',
    targets: [],
    ...extra,
  };
  state.stack.push(spell);
  return spell;
}

/**
 * Every card the game can see, anywhere — the census the phantom tests compare.
 *
 * Deliberately counts the STACK too. A phantom that stayed on the stack forever
 * would be just as wrong as one in a graveyard, and a census that skipped the
 * stack would call it clean.
 */
function cardCensus(state: GameState): Record<string, number> {
  const out: Record<string, number> = { battlefield: state.battlefield.length, stack: state.stack.length };
  for (const pid of ['A', 'B'] as const) {
    const player = state.players[pid];
    for (const zone of ['hand', 'library', 'graveyard', 'exile', 'command'] as const) {
      out[`${pid}.${zone}`] = player[zone].length;
    }
  }
  return out;
}

describe('a copy is not a card: it reaches NO zone (CR 704.5e)', () => {
  it('spellLeaveDestination answers ceaseToExist for a copy, at BOTH exits', () => {
    const state = mainPhase();
    const original = onStack(state, BOLT, 'A');
    const copy = makeSpellCopy(state, original, 'A');
    expect(spellLeaveDestination(copy, 'resolve')).toBe('ceaseToExist');
    expect(spellLeaveDestination(copy, 'counter')).toBe('ceaseToExist');
  });

  it('and it OUTRANKS flashback exile and buyback — a copy has no card to move', () => {
    const state = mainPhase();
    // A flashback cast (exiled as it leaves the stack) that was also bought back
    // (returned to hand as it resolves): both rules would place a CARD somewhere.
    const original = onStack(state, BOLT, 'A', { castFrom: 'graveyard', boughtBack: true });
    expect(spellLeaveDestination(original, 'resolve')).toBe('exile');
    const copy = makeSpellCopy(state, original, 'A');
    expect(spellLeaveDestination(copy, 'resolve')).toBe('ceaseToExist');
    expect(spellLeaveDestination(copy, 'counter')).toBe('ceaseToExist');
  });

  it('the copy is a NEW object, never the original re-labelled', () => {
    const state = mainPhase();
    const original = onStack(state, BOLT, 'A');
    const copy = makeSpellCopy(state, original, 'A');
    expect(copy.instanceId).not.toBe(original.instanceId);
    expect(copy.card.instanceId).not.toBe(original.card.instanceId);
    expect(copy.card.instanceId).toBe(copy.instanceId);
    // The id is minted from the state's own counter, so no decklist row can be
    // indexed by it — `paired-arms.ts` reasons through exactly that.
    expect(copy.instanceId).toBeGreaterThanOrEqual(state.nextInstanceId - 1);
  });

  it('the copy carries no bookkeeping of a CAST, because it was not cast', () => {
    const state = mainPhase();
    const original = onStack(state, BOLT, 'A', {
      castFrom: 'graveyard',
      boughtBack: true,
      additionalCostPaid: true,
      awaitingCastChoice: 'x',
    });
    const copy = makeSpellCopy(state, original, 'A');
    expect(copy.castFrom).toBeUndefined();
    expect(copy.boughtBack).toBeUndefined();
    expect(copy.additionalCostPaid).toBeUndefined();
    expect(copy.awaitingCastChoice).toBeUndefined();
  });
});

describe('every decision made for the original comes with the copy (CR 707.10)', () => {
  it('X, the kicks and the targets ride across', () => {
    const state = mainPhase();
    const victim = place(state, BEAR, 'B');
    const original = onStack(state, BOLT, 'A', {
      targets: [victim.instanceId],
      xValue: 5,
      kicked: true,
      kickCount: 3,
    });
    const copy = makeSpellCopy(state, original, 'A');
    expect(copy.xValue).toBe(5);
    expect(copy.kicked).toBe(true);
    expect(copy.kickCount).toBe(3);
    expect(copy.targets).toEqual([victim.instanceId]);
  });

  it('the announced MODES ride across, each with its own aim — and are not aliased', () => {
    const state = mainPhase();
    const bear = place(state, BEAR, 'B');
    const original = onStack(state, BOLT, 'A', {
      modePicks: [
        { modeId: 'burn', targets: [bear.instanceId] },
        { modeId: 'draw', targets: [] },
      ],
    });
    const copy = makeSpellCopy(state, original, 'A');
    expect(copy.modePicks?.map((p) => p.modeId)).toEqual(['burn', 'draw']);
    expect(copy.modePicks?.[0]?.targets).toEqual([bear.instanceId]);
    // Re-aiming the COPY must not re-aim the ORIGINAL — a spell its controller
    // may not even control.
    const reaimed = withSpellCopyAim(copy, 0, ['B']);
    expect(reaimed.modePicks?.[0]?.targets).toEqual(['B']);
    expect(original.modePicks?.[0]?.targets).toEqual([bear.instanceId]);
  });

  it('the copy is of the COPIABLE values — a copy of a copy is the same card', () => {
    const state = mainPhase();
    const original = onStack(state, BOLT, 'A');
    const first = makeSpellCopy(state, original, 'A');
    const second = makeSpellCopy(state, first, 'B');
    expect(second.card.def.name).toBe('Test Bolt');
    expect(second.controller).toBe('B');
    expect(second.instanceId).not.toBe(first.instanceId);
  });

  it('a copy of a PERMANENT spell is a TOKEN, so its far exit leaves no card either', () => {
    const state = mainPhase();
    const original = onStack(state, BEAR, 'A');
    expect(original.resolvesTo).toBe('battlefield');
    const copy = makeSpellCopy(state, original, 'A');
    expect(copy.resolvesTo).toBe('battlefield');
    expect(copy.card.def.isToken).toBe(true);
    // The ORIGINAL is untouched — it is a card and stays one.
    expect(original.card.def.isToken).toBeUndefined();
  });
});

describe('the aim slots — "you may choose new targets for the copy"', () => {
  it('a non-modal copy has exactly one slot, and it is the frame-wide list', () => {
    const state = mainPhase();
    const bear = place(state, BEAR, 'B');
    const copy = makeSpellCopy(state, onStack(state, BOLT, 'A', { targets: [bear.instanceId] }), 'A');
    expect(spellCopyAimSlots(copy)).toEqual([MODELESS_AIM_SLOT]);
    expect(spellCopyAimAt(copy, MODELESS_AIM_SLOT)).toEqual([bear.instanceId]);
    expect(spellCopyAimRestriction(copy, MODELESS_AIM_SLOT)).toBe('any');
  });

  it('a TARGET-FREE spell offers no slot at all — there is no aim to change', () => {
    const state = mainPhase();
    const copy = makeSpellCopy(state, onStack(state, BOLT, 'A'), 'A');
    expect(spellCopyAimSlots(copy)).toEqual([]);
  });

  it('a modal copy offers one slot per AIMED mode, and skips the target-free ones', () => {
    const modal: CardDefinition = {
      ...BOLT,
      id: 'charm-test',
      name: 'Test Charm',
      modal: {
        min: 2,
        max: 2,
        modes: [
          { id: 'burn', label: 'burn', effects: [], targets: 'creature' },
          { id: 'draw', label: 'draw', effects: [] },
        ],
      },
    };
    const state = mainPhase();
    const bear = place(state, BEAR, 'B');
    const copy = makeSpellCopy(
      state,
      onStack(state, modal, 'A', {
        modePicks: [
          { modeId: 'burn', targets: [bear.instanceId] },
          { modeId: 'draw', targets: [] },
        ],
      }),
      'A',
    );
    expect(spellCopyAimSlots(copy)).toEqual([0]);
    expect(spellCopyAimRestriction(copy, 0)).toBe('creature');
  });

  it('re-aiming a slot leaves every other slot exactly where it was', () => {
    const state = mainPhase();
    const bear = place(state, BEAR, 'B');
    const other = place(state, BEAR, 'A');
    const copy = makeSpellCopy(
      state,
      onStack(state, BOLT, 'A', {
        modePicks: [
          { modeId: 'one', targets: [bear.instanceId] },
          { modeId: 'two', targets: [other.instanceId] },
        ],
      }),
      'A',
    );
    const reaimed = withSpellCopyAim(copy, 1, [bear.instanceId]);
    expect(reaimed.modePicks?.[0]?.targets).toEqual([bear.instanceId]);
    expect(reaimed.modePicks?.[1]?.targets).toEqual([bear.instanceId]);
    expect(spellCopyAimAt(reaimed, 1)).toEqual([bear.instanceId]);
  });
});

describe('the copy survives the action-boundary clone', () => {
  it('`isSpellCopy` is copied — without it the copy litters a graveyard one action later', () => {
    const state = mainPhase();
    const copy = makeSpellCopy(state, onStack(state, BOLT, 'A'), 'A');
    state.stack.push(copy);

    const cloned = cloneState(state);
    const clonedCopy = cloned.stack.find((o) => o.instanceId === copy.instanceId) as SpellStackObject;
    expect(clonedCopy.isSpellCopy).toBe(true);
    expect(spellLeaveDestination(clonedCopy, 'resolve')).toBe('ceaseToExist');
    // And the ORIGINAL beside it still answers for a card, so the clone is not
    // simply stamping everything.
    const clonedOriginal = cloned.stack[0] as SpellStackObject;
    expect(clonedOriginal.isSpellCopy).toBeUndefined();
    expect(spellLeaveDestination(clonedOriginal, 'resolve')).toBe('graveyard');
  });
});

describe('driven through the real pipeline: the copy resolves and leaves NOTHING', () => {
  /**
   * Resolve the whole stack by passing priority, answering any question with its
   * first legal option, and return the finished state plus every event.
   */
  function resolveEverything(state: GameState): { state: GameState; events: GameEvent[] } {
    const registry = boltRegistry();
    let next = state;
    const events: GameEvent[] = [];
    for (let guard = 0; guard < 40 && next.stack.length > 0; guard++) {
      const choice = next.pendingChoice;
      if (choice) {
        const answer =
          choice.kind === 'selectTargets'
            ? { kind: 'selectTargets' as const, targets: [choice.candidates[0]!.ref] }
            : { kind: 'confirm' as const, yes: false };
        // ⚠️ `applyAction` takes (state, action, CONFIG, REGISTRY) POSITIONALLY.
        // Passing `{ registry, config }` — which reads like an options object and
        // which other suites in this package do — hands the object to `config`
        // and leaves the registry UNDEFINED, so every primitive silently
        // degrades to `effectUnsupported` and the test proves nothing while
        // staying green. That is exactly what happened while writing this file.
        const done = applyAction(next, { kind: 'answerChoice', player: choice.chooser, choiceId: choice.id, answer }, undefined, registry);
        next = done.state;
        events.push(...done.events);
        continue;
      }
      const pass = applyAction(next, { kind: 'passPriority', player: next.priorityPlayer }, undefined, registry);
      next = pass.state;
      events.push(...pass.events);
    }
    return { state: next, events };
  }

  it('a resolved copy adds no card to any zone, and says so', () => {
    const state = mainPhase();
    const victim = place(state, BEAR, 'B');
    const original = onStack(state, BOLT, 'A', { targets: [victim.instanceId] });
    const copy = makeSpellCopy(state, original, 'A');
    state.stack.push(copy);

    // Census taken with BOTH objects still on the stack; the copy is one of the
    // two things the stack is holding, and the original is the other.
    const before = cardCensus(state);
    expect(before.stack).toBe(2);

    const { state: after, events } = resolveEverything(state);

    expect(after.stack).toHaveLength(0);
    // The ORIGINAL's card went to a graveyard, as an instant does. The COPY did
    // not — so exactly ONE card moved, and every other zone is untouched.
    expect(after.players.A.graveyard).toHaveLength(1);
    expect(after.players.A.graveyard[0]?.instanceId).toBe(original.card.instanceId);
    const afterCensus = cardCensus(after);
    for (const zone of [
      'battlefield',
      'B.graveyard',
      'A.hand',
      'A.library',
      'A.exile',
      'A.command',
      'B.hand',
      'B.library',
      'B.exile',
      'B.command',
    ] as const) {
      // The 2/2 the bolts killed moved from the battlefield to its owner's
      // graveyard — one card, accounted for. NOTHING ELSE moved, and in
      // particular no zone GAINED an object out of nowhere.
      const expected =
        zone === 'battlefield'
          ? (before[zone] as number) - 1
          : zone === 'B.graveyard'
            ? (before[zone] as number) + 1
            : before[zone];
      expect(afterCensus[zone], `zone ${zone} gained or lost a card`).toBe(expected);
    }
    // Nothing anywhere carries the copy's id — the sharpest form of "no phantom".
    const everywhere = [
      ...after.battlefield,
      ...after.players.A.graveyard,
      ...after.players.A.hand,
      ...after.players.A.exile,
      ...after.players.A.library,
      ...after.players.B.graveyard,
      ...after.players.B.hand,
      ...after.players.B.exile,
      ...after.players.B.library,
    ];
    expect(everywhere.some((c) => c.instanceId === copy.card.instanceId)).toBe(false);
    // …and it was SAID, so a log or a replay folding zone changes knows why.
    expect(events.some((e) => e.type === 'spellCopyCeasedToExist' && e.instanceId === copy.card.instanceId)).toBe(true);
    expect(
      events.some((e) => e.type === 'zoneChange' && (e as { instanceId: InstanceId }).instanceId === copy.card.instanceId),
    ).toBe(false);
    // The copy really RESOLVED rather than being quietly dropped: the bolt was
    // dealt twice, so the 2/2 is dead.
    expect(after.battlefield.some((c) => c.instanceId === victim.instanceId)).toBe(false);
  });
});

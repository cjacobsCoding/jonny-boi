/**
 * §3.150 — THE DOES-NOT-UNTAP FAMILY, both lifetimes.
 *
 * ## The defects these tests exist to catch, each named
 *
 *  1. **A CONTINUOUS freeze compiled as a ONE-SHOT.** Basalt Monolith would
 *     untap on its second untap step, having "spent" its freeze, and nothing in
 *     the event log would say so. Pinned by walking TWO of the controller's
 *     untap steps, not one — a single-step test passes under the wrong model.
 *  2. **A ONE-SHOT freeze compiled as CONTINUOUS.** Frost Trickster's victim
 *     would never untap again for the rest of the game. Pinned by the mirror
 *     assertion: the second untap step must untap it.
 *  3. **The skip spent by the UNTAP being refused rather than by the STEP
 *     happening.** An already-UNTAPPED frozen permanent would keep its freeze
 *     forever and miss a later untap step it should not have missed — the exact
 *     shape of a counter decremented inside the wrong branch.
 *  4. **The freeze surviving a zone change.** CR 400.7 makes a permanent that
 *     left a new object; a bounced-and-replayed creature that is still frozen is
 *     remembering something about a thing that no longer exists.
 *  5. **The aura's grant outliving the aura.** Destroy Waterknot and the
 *     creature must untap on its very next untap step, with no cleanup step
 *     anywhere — that is the property that made a keyword flag the right home.
 *
 * Every one of these was watched RED before it was watched green (see the lane
 * report): the assertions are written so that deleting the branch they guard
 * changes the number, not just the comment.
 */

import { describe, expect, it } from 'vitest';
import {
  addUntapSkips,
  createGame,
  spendUntapSkip,
  untapsDuringUntapStep,
  type CardDefinition,
  type GameState,
} from './index.js';
import { deckOf, landDef } from './test-fixtures.js';
import type { CardInstance, InstanceId, PlayerId } from './state.js';
import { resetInstanceForNewZone } from './internal/zones.js';
import { indexContinuous } from './internal/continuous.js';

const ISLAND = landDef('Island', 'U');

/** A vanilla creature. */
function creature(name: string, power = 2, toughness = 2): CardDefinition {
  return { id: name, name, types: ['creature'], power, toughness };
}

/** Basalt Monolith's printing, as the compiler produces it: a flag on the card. */
const SELF_FROZEN: CardDefinition = {
  id: 'self-frozen',
  name: 'Basalt Monolith (fixture)',
  types: ['artifact'],
  keywords: { doesNotUntap: true },
};

/** Waterknot's printing: an Aura granting the flag to the permanent it is on. */
const FREEZING_AURA: CardDefinition = {
  id: 'freezing-aura',
  name: 'Waterknot (fixture)',
  types: ['enchantment'],
  // An Aura reaches its host through `attachment.modifies` (layer 3), which is
  // exactly where `attachment-modification` puts a compiled "Enchanted creature
  // …" line — so this fixture is the shape the compiler really emits.
  attachment: {
    attachesTo: { anyOfTypes: ['creature'] },
    whenIllegal: 'toGraveyard',
    modifies: { keywords: { doesNotUntap: true } },
  },
};

function put(state: GameState, def: CardDefinition, controller: PlayerId, tapped = true): InstanceId {
  const inst: CardInstance = {
    instanceId: state.nextInstanceId++,
    def,
    controller,
    owner: controller,
    zone: 'battlefield',
    tapped,
    summoningSick: false,
    damageMarked: 0,
    markedByDeathtouch: false,
    attachedTo: null,
    counters: {},
  };
  state.battlefield.push(inst);
  return inst.instanceId;
}

function find(state: GameState, id: InstanceId): CardInstance {
  const inst = state.battlefield.find((c) => c.instanceId === id);
  if (!inst) throw new Error(`instance ${id} is not on the battlefield`);
  return inst;
}

/**
 * Run the untap step exactly as `beginTurn` does — the same calls in the same
 * order — and, on every permanent, ALSO assert that the INDEXED answer and the
 * one-off answer agree.
 *
 * ⚠️ That second assertion is the whole reason this helper is not three inline
 * lines. §3.146 shipped a defect of exactly this shape: `aggregateFor` (the
 * one-off) and `indexContinuous` (the bulk) are twins, one of them silently
 * stopped reading a field the other read, and it made Tetsuko's creatures
 * unblockable through only one of the two paths. The untap step takes the
 * INDEXED path and every other caller takes the one-off, so a divergence here
 * would mean a permanent that untaps in a real game and reports frozen to the
 * inspector — or the reverse. Free to check, and it can only ever be checked
 * here.
 *
 * ⚠️ A deliberate duplication of the loop, and it is the smaller evil: the
 * alternative is driving whole turns through `applyAction`, which needs a legal
 * pass-priority chain from both seats and would make a freeze test fail for
 * fifty reasons that are not about freezing. `engine.ts` has exactly one call
 * site of `untapsDuringUntapStep`, which a grep keeps honest.
 */
function runUntapStep(state: GameState, active: PlayerId): void {
  const index = indexContinuous(state);
  for (const inst of state.battlefield) {
    if (inst.controller !== active) continue;
    const untaps = untapsDuringUntapStep(state, inst, index);
    expect(untaps, `indexed and one-off disagree for ${inst.def.name}`).toBe(
      untapsDuringUntapStep(state, inst),
    );
    spendUntapSkip(inst);
    if (!untaps || !inst.tapped) continue;
    inst.tapped = false;
  }
}

function game(seed: number): GameState {
  return createGame({ seed, decks: { A: deckOf(ISLAND, 40), B: deckOf(ISLAND, 40) } }).state;
}

describe('the CONTINUOUS half — a flag that lasts as long as its source', () => {
  it('a self-printed doesNotUntap keeps the permanent tapped through EVERY untap step', () => {
    const state = game(1);
    const monolith = put(state, SELF_FROZEN, 'A');

    runUntapStep(state, 'A');
    expect(find(state, monolith).tapped).toBe(true);
    // DEFECT 1 — a continuous freeze mistaken for a one-shot passes the line
    // above and fails this one.
    runUntapStep(state, 'A');
    expect(find(state, monolith).tapped).toBe(true);
    // It never grows a skip count: the continuous half stores nothing.
    expect(find(state, monolith).untapSkips).toBeUndefined();
  });

  it('an AURA grants it to its host, and the host untaps the moment the aura leaves', () => {
    const state = game(2);
    const victim = put(state, creature('Victim'), 'A');
    const aura = put(state, FREEZING_AURA, 'B', false);
    find(state, aura).attachedTo = victim;

    runUntapStep(state, 'A');
    expect(find(state, victim).tapped).toBe(true);

    // DEFECT 5 — no cleanup anywhere: destroying the aura is the whole of it.
    state.battlefield.splice(
      state.battlefield.findIndex((c) => c.instanceId === aura),
      1,
    );
    runUntapStep(state, 'A');
    expect(find(state, victim).tapped).toBe(false);
  });

  it('the flag is read off the EFFECTIVE keywords, so an unenchanted creature is untouched', () => {
    const state = game(3);
    const free = put(state, creature('Free'), 'A');
    expect(untapsDuringUntapStep(state, find(state, free))).toBe(true);
    runUntapStep(state, 'A');
    expect(find(state, free).tapped).toBe(false);
  });
});

describe('the ONE-SHOT half — a count that expires by being spent', () => {
  it('misses exactly ONE untap step, then untaps', () => {
    const state = game(4);
    const victim = put(state, creature('Victim'), 'A');
    addUntapSkips(find(state, victim), 1);

    runUntapStep(state, 'A');
    expect(find(state, victim).tapped).toBe(true);
    // DEFECT 2 — a one-shot mistaken for continuous fails here and only here.
    runUntapStep(state, 'A');
    expect(find(state, victim).tapped).toBe(false);
  });

  it('"next TWO untap steps" misses two, then untaps on the third', () => {
    const state = game(5);
    const victim = put(state, creature('Victim'), 'A');
    addUntapSkips(find(state, victim), 2);

    runUntapStep(state, 'A');
    runUntapStep(state, 'A');
    expect(find(state, victim).tapped).toBe(true);
    runUntapStep(state, 'A');
    expect(find(state, victim).tapped).toBe(false);
  });

  it('skips ACCUMULATE — two freezes cost two untap steps, not one', () => {
    const state = game(6);
    const victim = put(state, creature('Victim'), 'A');
    addUntapSkips(find(state, victim), 1);
    addUntapSkips(find(state, victim), 1);
    expect(find(state, victim).untapSkips).toBe(2);
  });

  it('is spent by the STEP HAPPENING, even when the permanent was already untapped', () => {
    // DEFECT 3. A freeze aimed at an untapped permanent is still a freeze that
    // was used up. If the decrement hid inside the `tapped` branch, this
    // permanent would still be carrying it — and would miss a LATER untap step
    // it had no business missing.
    const state = game(7);
    const victim = put(state, creature('Victim'), 'A', /* tapped */ false);
    addUntapSkips(find(state, victim), 1);

    runUntapStep(state, 'A');
    expect(find(state, victim).untapSkips).toBeUndefined();

    find(state, victim).tapped = true;
    runUntapStep(state, 'A');
    expect(find(state, victim).tapped).toBe(false);
  });

  it('only the ACTIVE player untaps, so an opponent\'s freeze is not spent on your turn', () => {
    const state = game(8);
    const theirs = put(state, creature('Theirs'), 'B');
    addUntapSkips(find(state, theirs), 1);

    runUntapStep(state, 'A');
    expect(find(state, theirs).untapSkips).toBe(1);
    runUntapStep(state, 'B');
    expect(find(state, theirs).tapped).toBe(true);
    runUntapStep(state, 'B');
    expect(find(state, theirs).tapped).toBe(false);
  });

  it('a non-positive count is a no-op, never a stored zero', () => {
    const state = game(9);
    const victim = put(state, creature('Victim'), 'A');
    addUntapSkips(find(state, victim), 0);
    addUntapSkips(find(state, victim), -3);
    addUntapSkips(find(state, victim), Number.NaN);
    expect(find(state, victim).untapSkips).toBeUndefined();
  });
});

describe('the freeze is a fact about THIS object (CR 400.7)', () => {
  it('a bounced permanent comes back unfrozen', () => {
    // DEFECT 4. The skip is cleared at the one zone-change chokepoint, beside
    // `loyaltyActivatedTurn` and `timesKicked`, for the identical reason.
    const state = game(10);
    const victim = put(state, creature('Victim'), 'A');
    addUntapSkips(find(state, victim), 2);
    const inst = find(state, victim);

    inst.zone = 'hand';
    resetInstanceForNewZone(inst);
    expect(inst.untapSkips).toBeUndefined();
  });
});

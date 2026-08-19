/**
 * The pilot actually PLAYS Snapcaster Mage — casts it, aims the ETB at the best
 * card in its graveyard, and then takes the recast the ability just bought.
 *
 * This is the wiring that keeps the mechanic from being inert, and it has two
 * halves that fail independently:
 *
 *  1. **Aiming.** The trigger's target is a real decision whenever the graveyard
 *     holds more than one instant or sorcery, so the pilot answers a
 *     `selectTargets` choice. It scores each candidate through
 *     `valueOfEffects`'s `grantFlashback` entry, which prices the grant off the
 *     card it names — so the ability lands on the BEST spell, not the first one
 *     offered. An unaimed (or first-offered) implementation looks identical
 *     until the graveyard has two cards in it, which is why the fixture has two.
 *  2. **Taking the recast.** `scoredSpellGoals` reads flashback through core's
 *     `flashbackCostOf`, so a GRANTED cost is considered exactly as a printed
 *     one is. A pilot reading only `CardDefinition.flashback` would cast
 *     Snapcaster and then never use it — the ability would be a blank 2/1 in
 *     every A/B verdict that included it.
 */

import { describe, expect, it } from 'vitest';
import {
  addCardGrant,
  applyAction,
  createGame,
  createRng,
  generateLegalActions,
  type CardDefinition,
  type CardInstance,
  type DeckList,
  type GameAction,
  type GameState,
  isLegalTarget,
} from '@jonny-boi/core';
import { createHeuristicPilot } from './heuristic.js';
import { createTestRegistry, giveHand, landDef } from './test-support.js';

/**
 * Snapcaster-shaped: flash, plus the ETB that aims at a graveyard spell and
 * grants it flashback for its own mana cost.
 */
const SNAPCASTER: CardDefinition = {
  id: 'snap-wizard',
  name: 'Snap Wizard',
  types: ['creature'],
  cost: { generic: 1, R: 1 },
  power: 2,
  toughness: 1,
  keywords: { flash: true },
  triggers: [
    {
      condition: { on: 'etb' },
      targets: 'instantOrSorceryInYourGraveyard',
      effects: [
        {
          primitive: 'grantFlashback',
          params: { targets: 'instantOrSorceryInYourGraveyard', cost: 'itsManaCost' },
        },
      ],
      label: 'Enters: grant flashback',
    },
  ],
};

/**
 * The shared test registry plus the real `grantFlashback` behaviour, written
 * against the same public core API `packages/cards` uses (this package may not
 * import `cards` — that is the dependency direction). `packages/cards` owns the
 * pinned test of the SHIPPED primitive.
 */
function registryWithGrant(): ReturnType<typeof createTestRegistry> {
  const registry = createTestRegistry();
  registry.register('grantFlashback', (ctx) => {
    const target = ctx.targets[0];
    if (typeof target !== 'number') return;
    if (!isLegalTarget(ctx.state, 'instantOrSorceryInYourGraveyard', target, ctx.controller, ctx.source.def)) return;
    const card = ctx.state.players[ctx.controller].graveyard.find((c) => c.instanceId === target);
    if (!card?.def.cost) return;
    addCardGrant(
      ctx.state,
      {
        targetInstanceId: card.instanceId,
        sourceInstanceId: ctx.source.instanceId,
        zone: card.zone,
        duration: 'endOfTurn',
        flashback: card.def.cost,
      },
      ctx.emit,
    );
  });
  return registry;
}

/** The expensive, powerful spell — the one a sane pilot flashes back. */
const BIG_BOLT: CardDefinition = {
  id: 'big-bolt',
  name: 'Big Bolt',
  types: ['instant'],
  cost: { generic: 2, R: 1 },
  effects: [{ primitive: 'dealDamage', params: { amount: 5, targets: 'any' } }],
};

/** The cheap one it should NOT prefer. */
const SMALL_BOLT: CardDefinition = {
  id: 'small-bolt',
  name: 'Small Bolt',
  types: ['instant'],
  cost: { R: 1 },
  effects: [{ primitive: 'dealDamage', params: { amount: 1, targets: 'any' } }],
};

function stubDeck(): DeckList {
  return { cards: Array.from({ length: 30 }, (_, i) => landDef(`L${i}`, 'R')) };
}

/**
 * A's precombat main with `lands` untapped Mountains, empty hands, and the two
 * bolts in A's graveyard. The opponent is at a life total the flashed-back Big
 * Bolt is LETHAL against, so no scoring threshold can talk the pilot out of the
 * recast — the test is about wiring, not about tuning.
 */
function position(lands: number): { state: GameState; big: CardInstance; small: CardInstance } {
  const { state } = createGame({ seed: 7, decks: { A: stubDeck(), B: stubDeck() } });
  state.step = 'precombatMain';
  state.activePlayer = 'A';
  state.priorityPlayer = 'A';
  state.stack = [];
  state.players.A.hand = [];
  state.players.B.hand = [];
  state.players.A.landsPlayedThisTurn = 1;
  state.players.B.life = 5;

  const mountains = giveHand(state, 'A', Array.from({ length: lands }, (_, i) => landDef(`M${i}`, 'R')));
  state.players.A.hand = [];
  for (const land of mountains) {
    land.zone = 'battlefield';
    land.summoningSick = false;
    state.battlefield.push(land);
  }

  const [big, small] = giveHand(state, 'A', [BIG_BOLT, SMALL_BOLT]);
  state.players.A.hand = [];
  for (const card of [big!, small!]) {
    card.zone = 'graveyard';
    state.players.A.graveyard.push(card);
  }
  return { state, big: big!, small: small! };
}

describe('heuristic pilot vs a granted flashback', () => {
  it('takes the recast a grant enables, and would not without it', () => {
    const reg = createTestRegistry();
    const pilot = createHeuristicPilot();
    const { state: base, big } = position(3);

    // WITHOUT the grant the pilot must never construct a graveyard cast — the
    // control that makes the next assertion mean something.
    const withoutGrant = pilot.chooseAction({
      view: base,
      legalActions: generateLegalActions(base),
      rng: createRng(5),
    });
    expect(withoutGrant.kind === 'castSpell' && withoutGrant.fromZone === 'graveyard').toBe(false);

    // With it, the same board yields the recast.
    const granted = base;
    addCardGrant(
      granted,
      {
        targetInstanceId: big.instanceId,
        sourceInstanceId: 999,
        zone: 'graveyard',
        duration: 'endOfTurn',
        flashback: BIG_BOLT.cost,
      },
      () => {},
    );

    let state = granted;
    let cast: Extract<GameAction, { kind: 'castSpell' }> | undefined;
    for (let ply = 0; ply < 12 && !cast; ply++) {
      const action = pilot.chooseAction({
        view: state,
        legalActions: generateLegalActions(state),
        rng: createRng(5),
      });
      if (action.kind === 'castSpell') {
        cast = action;
        break;
      }
      expect(action.kind, 'the pilot should tap toward the granted recast').toBe('tapForMana');
      state = applyAction(state, action, undefined, reg).state;
    }

    expect(cast, 'the pilot never attempted the granted flashback cast').toBeDefined();
    expect(cast!.fromZone).toBe('graveyard');
    expect(cast!.instanceId).toBe(big.instanceId);

    // And the engine accepts the pilot's own action end to end.
    const result = applyAction(state, cast!, undefined, reg);
    expect(result.events.some((e) => e.type === 'actionRejected')).toBe(false);
    expect(result.events.some((e) => e.type === 'spellCast' && e.fromZone === 'graveyard')).toBe(true);
  });

  it('casts the creature, aims its ETB, and then recasts — the whole loop', () => {
    const reg = registryWithGrant();
    const pilot = createHeuristicPilot();
    const { state: start, big } = position(6);
    // Only the BIG bolt is in the yard, so the aim is forced and the test is
    // about the LOOP rather than about which target scores highest.
    start.players.A.graveyard = start.players.A.graveyard.filter((c) => c.instanceId === big.instanceId);
    giveHand(start, 'A', [SNAPCASTER]);

    let state = start;
    let castTheWizard = false;
    let recast: Extract<GameAction, { kind: 'castSpell' }> | undefined;

    // Drive the pilot's own decisions. Every action it picks is applied for
    // real, so nothing here is hand-fed: the grant only exists because the
    // pilot chose to cast the creature and the engine resolved its trigger.
    for (let ply = 0; ply < 40 && !recast; ply++) {
      const legal = generateLegalActions(state);
      const action = pilot.chooseAction({ view: state, legalActions: legal, rng: createRng(5) });
      if (action.kind === 'castSpell' && action.fromZone === 'graveyard') {
        recast = action;
        break;
      }
      if (action.kind === 'castSpell') castTheWizard = true;
      const result = applyAction(state, action, undefined, reg);
      expect(
        result.events.some((e) => e.type === 'actionRejected'),
        `the pilot proposed an action the engine rejected: ${JSON.stringify(action)}`,
      ).toBe(false);
      state = result.state;
    }

    expect(castTheWizard, 'the pilot never cast the creature').toBe(true);
    expect(recast, 'the pilot never took the recast its own ETB bought').toBeDefined();
    expect(recast!.instanceId).toBe(big.instanceId);
    expect(applyAction(state, recast!, undefined, reg).events.some((e) => e.type === 'actionRejected')).toBe(false);
  });

  it('aims the ETB at the BEST spell in its graveyard, not the first offered', () => {
    const reg = createTestRegistry();
    const pilot = createHeuristicPilot();
    const { state, big, small } = position(2);

    // Two legal targets ⇒ a real decision, parked as a `selectTargets` choice.
    // (SMALL_BOLT is first in the graveyard, so "first offered" and "best" differ.)
    expect(state.players.A.graveyard[0]!.instanceId).toBe(big.instanceId);
    const snapTrigger = {
      kind: 'trigger' as const,
      instanceId: 900,
      sourceInstanceId: 901,
      controller: 'A' as const,
      effects: [
        {
          primitive: 'grantFlashback',
          params: { targets: 'instantOrSorceryInYourGraveyard', cost: 'itsManaCost' },
        },
      ],
      targets: [],
      label: 'Enters: grant flashback',
      awaitingTargets: 'instantOrSorceryInYourGraveyard' as const,
    };
    // Reorder so the CHEAP card is offered first — a pilot that takes the head
    // of the candidate list picks wrong and this test catches it.
    state.players.A.graveyard = [small, big];
    state.stack.push(snapTrigger);
    state.pendingChoice = {
      id: 42,
      kind: 'selectTargets',
      chooser: 'A',
      prompt: 'Choose an instant or sorcery card in your graveyard',
      valence: 'neutral',
      sourceInstanceId: 901,
      sourceName: 'Snapcaster Mage',
      min: 1,
      max: 1,
      restriction: 'instantOrSorceryInYourGraveyard',
      candidates: [
        { ref: small.instanceId, name: small.def.name, controller: 'A' },
        { ref: big.instanceId, name: big.def.name, controller: 'A' },
      ],
    };

    const action = pilot.chooseAction({
      view: state,
      legalActions: generateLegalActions(state),
      rng: createRng(5),
    });

    expect(action.kind).toBe('answerChoice');
    const answer = (action as Extract<GameAction, { kind: 'answerChoice' }>).answer;
    expect(answer.kind).toBe('selectTargets');
    expect((answer as { targets: readonly number[] }).targets).toEqual([big.instanceId]);

    // And the engine accepts it, aiming the real trigger.
    const result = applyAction(state, action, undefined, reg);
    expect(result.events.some((e) => e.type === 'actionRejected')).toBe(false);
  });
});

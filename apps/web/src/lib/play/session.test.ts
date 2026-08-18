/**
 * Pure-logic tests for the hotseat play layer: the `GameSession` controller, deck
 * setup, and the hidden-information view-model. These do NOT re-test the engine
 * (the core package owns that); they test the client seam we built on top of it:
 *
 *   - a legal action advances the session to a new state;
 *   - an illegal action is rejected without corrupting the prior session;
 *   - game-over is detected and surfaces a winner;
 *   - the view-model masks the opponent's hand (never leaks hidden info);
 *   - deck setup builds a legal game from the bundled sample decks;
 *   - a FULL game plays through to a winner driving only the public session API,
 *     exercising lands, creature casts (auto-tap), burn-with-target, and combat.
 */
import { describe, expect, it } from 'vitest';
import {
  generateLegalActions,
  LOYALTY_COUNTER,
  loyaltyOf,
  type CardDefinition,
  type CardInstance,
  type GameAction,
  type GameState,
  type InstanceId,
  type PlayerId,
} from '@jonny-boi/core';
import { SAMPLE_DECKS } from '@jonny-boi/sim';
import { buildDeclareAttackersAction, GameSession } from './session.js';
import { hotseatPool, startHotseatGame, type DeckChoice, type HotseatSetup } from './setup.js';
import { buildBoardView } from './view-model.js';
import { optionToTarget } from './targeting.js';

const SEAT_NAMES: Readonly<Record<PlayerId, string>> = { A: 'Alice', B: 'Bob' };

function sampleChoice(nameFragment: string): DeckChoice {
  const deck = SAMPLE_DECKS.find((d) => d.name.toLowerCase().includes(nameFragment));
  if (!deck) throw new Error(`no sample deck matching "${nameFragment}"`);
  return { source: 'sample', deck };
}

/** Start a fresh hotseat game (throws if the bundled decks are somehow illegal). */
function startGame(setup: Partial<HotseatSetup> = {}): GameSession {
  const full: HotseatSetup = {
    choiceA: setup.choiceA ?? sampleChoice('red'),
    choiceB: setup.choiceB ?? sampleChoice('red'),
    seed: setup.seed ?? 12345,
    startingPlayer: setup.startingPlayer ?? 'A',
  };
  const result = startHotseatGame(full);
  if (!result.ok) throw new Error(`setup failed: ${JSON.stringify(result.problems)}`);
  return GameSession.fromCreated(result.game.created, result.game.registry, SEAT_NAMES);
}

describe('hotseat deck setup', () => {
  it('builds a legal game from two bundled sample decks', () => {
    const result = startHotseatGame({
      choiceA: sampleChoice('red'),
      choiceB: sampleChoice('control'),
      seed: 7,
      startingPlayer: 'A',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const state = result.game.created.state;
    // Both players drew an opening hand and have a non-empty library left.
    expect(state.players.A.hand.length).toBeGreaterThan(0);
    expect(state.players.B.hand.length).toBeGreaterThan(0);
    expect(state.players.A.library.length).toBeGreaterThan(0);
    expect(state.players.B.library.length).toBeGreaterThan(0);
    expect(state.gameOver).toBe(false);
  });

  it('returns structured problems for a malformed deck instead of throwing', () => {
    const broken: DeckChoice = {
      source: 'sample',
      deck: { name: 'broken', archetype: 'test', cards: [{ cardId: 'Mountain', count: 3 }] },
    };
    const result = startHotseatGame({
      choiceA: broken,
      choiceB: sampleChoice('red'),
      seed: 1,
      startingPlayer: 'A',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problems.a.length).toBeGreaterThan(0);
    expect(result.problems.b.length).toBe(0);
  });
});

describe('GameSession action handling', () => {
  it('advances to a new session on a legal action and leaves the old one untouched', () => {
    const session = startGame();
    const before = session.state;
    // Turn 1 opens in upkeep with only passPriority available.
    const legal = session.legalActions();
    expect(legal.length).toBeGreaterThan(0);
    const result = session.passPriority();
    expect(result.rejected).toBeNull();
    expect(result.session).not.toBe(session);
    // The original session object is immutable: its state reference is unchanged.
    expect(session.state).toBe(before);
    // The new session advanced the game (priority and/or step moved).
    expect(result.events.length).toBeGreaterThan(0);
  });

  it('rejects an illegal action without corrupting the session', () => {
    const session = startGame();
    // Casting a creature in the upkeep step (sorcery timing, wrong window, no mana)
    // is illegal; submit it raw and confirm the engine rejects it cleanly.
    const illegal: GameAction = {
      kind: 'castSpell',
      player: session.priorityPlayer,
      instanceId: session.state.players[session.priorityPlayer].hand[0]!.instanceId,
      targets: [],
    };
    const result = session.submit(illegal);
    expect(result.rejected).toBeTruthy();
    // State is preserved: the returned session is the SAME object, unchanged.
    expect(result.session).toBe(session);
    expect(result.session.state).toBe(session.state);
  });

  it('detects game over and surfaces a winner via concede', () => {
    const session = startGame();
    expect(session.gameOver).toBe(false);
    const ended = session.concede('B', 'A');
    expect(ended.gameOver).toBe(true);
    expect(ended.winner).toBe('A');
    // Idempotent: conceding an already-over game returns the same session.
    expect(ended.concede('A', 'B')).toBe(ended);
  });
});

describe('hidden-information masking', () => {
  it("reveals the viewer's own hand but masks the opponent's", () => {
    const session = startGame();
    const viewA = buildBoardView(session.state, 'A', SEAT_NAMES);
    // A sees A's own hand contents; B's hand is masked to a count only.
    expect(viewA.self.hand).not.toBeNull();
    expect(viewA.self.hand!.length).toBe(session.state.players.A.hand.length);
    expect(viewA.opponent.hand).toBeNull();
    expect(viewA.opponent.handCount).toBe(session.state.players.B.hand.length);

    // From B's seat the mask flips — B never sees A's cards.
    const viewB = buildBoardView(session.state, 'B', SEAT_NAMES);
    expect(viewB.self.hand).not.toBeNull();
    expect(viewB.opponent.hand).toBeNull();
    // The masked hand carries no card ids/names that could leak.
    const serialized = JSON.stringify(viewB.opponent);
    for (const card of session.state.players.A.hand) {
      // The opponent's specific card ids must not appear in the masked view.
      expect(serialized).not.toContain(`"instanceId":${card.instanceId}`);
    }
  });
});

// --- planeswalkers on the hotseat board ------------------------------------------

/** A synthetic battlefield instance (mirrors the cards package's play-test helper). */
let syntheticId = 95_000;
function placed(def: CardDefinition, controller: PlayerId): CardInstance {
  const inst: CardInstance = {
    instanceId: syntheticId++,
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
  if (def.loyalty !== undefined && def.types.includes('planeswalker')) {
    inst.counters = { [LOYALTY_COUNTER]: def.loyalty };
  }
  return inst;
}

function poolCard(name: string): CardDefinition {
  const def = hotseatPool().getByName(name);
  if (!def) throw new Error(`curated pool missing ${name}`);
  return def;
}

/** Pass priority until `step` (bounded); throws on a rejection so failures are loud. */
function advanceTo(session: GameSession, step: string, max = 200): GameSession {
  let s = session;
  let guard = 0;
  while (s.state.step !== step && !s.gameOver && !s.pendingChoice && guard++ < max) {
    const r = s.passPriority();
    if (r.rejected) throw new Error(`unexpected rejection: ${r.rejected}`);
    s = r.session;
  }
  if (s.state.step !== step) throw new Error(`never reached ${step} (at ${s.state.step})`);
  return s;
}

/** A fresh game with `defs` placed straight onto the battlefield (A's turn 1 upkeep). */
function gameWith(defs: readonly { def: CardDefinition; controller: PlayerId }[]): {
  session: GameSession;
  ids: InstanceId[];
} {
  const base = startGame();
  const state = structuredClone(base.state) as GameState;
  const ids: InstanceId[] = [];
  for (const { def, controller } of defs) {
    const inst = placed(def, controller);
    state.battlefield.push(inst);
    ids.push(inst.instanceId);
  }
  const session = GameSession.fromCreated({ state, events: [] }, base.registry, SEAT_NAMES);
  return { session, ids };
}

describe('buildDeclareAttackersAction (the walker-attack seam)', () => {
  it('carries no attackTargets key at all when nothing attacks a walker', () => {
    expect('attackTargets' in buildDeclareAttackersAction('A', [1, 2])).toBe(false);
    expect('attackTargets' in buildDeclareAttackersAction('A', [1, 2], {})).toBe(false);
    // An assignment for a creature NOT attacking is dropped — and with it the key.
    expect('attackTargets' in buildDeclareAttackersAction('A', [1], { 2: 9 })).toBe(false);
  });

  it('keeps assignments for declared attackers only', () => {
    const action = buildDeclareAttackersAction('A', [1, 2], { 1: 9, 3: 9 });
    expect(action.attackTargets).toEqual({ 1: 9 });
    expect(action.attackers).toEqual([1, 2]);
  });
});

describe('attacking a planeswalker through the session', () => {
  it('declareAttackers with attackTargets round-trips into combat state and the event log', () => {
    const { session, ids } = gameWith([
      { def: poolCard('Raging Goblin'), controller: 'A' },
      { def: poolCard('Liliana of the Veil'), controller: 'B' },
    ]);
    const [goblin, walker] = ids as [InstanceId, InstanceId];
    const atCombat = advanceTo(session, 'declareAttackers');
    const result = atCombat.declareAttackers([goblin], { [goblin]: walker });
    expect(result.rejected).toBeNull();
    expect(result.session.state.combat?.attackers).toEqual([goblin]);
    expect(result.session.state.combat?.attackTargets).toEqual({ [goblin]: walker });
    const declared = result.events.find((e) => e.type === 'attackersDeclared');
    expect(declared && 'attackTargets' in declared ? declared.attackTargets : undefined).toEqual({
      [goblin]: walker,
    });
  });

  it('the default path (no walker assignments) submits the pre-walker action unchanged', () => {
    const { session, ids } = gameWith([
      { def: poolCard('Raging Goblin'), controller: 'A' },
      { def: poolCard('Liliana of the Veil'), controller: 'B' },
    ]);
    const [goblin] = ids as [InstanceId, InstanceId];
    const atCombat = advanceTo(session, 'declareAttackers');
    const result = atCombat.declareAttackers([goblin], {});
    expect(result.rejected).toBeNull();
    expect(result.session.state.combat?.attackTargets).toBeUndefined();
  });
});

describe('loyalty abilities surface as engine-driven ability options', () => {
  it('offers the payable lines with printed labels and per-target menus, omitting the unpayable minus', () => {
    const { session, ids } = gameWith([{ def: poolCard('Liliana of the Veil'), controller: 'A' }]);
    const [walker] = ids as [InstanceId];
    const atMain = advanceTo(session, 'precombatMain');
    const options = atMain.abilityOptions().filter((o) => o.instanceId === walker);
    // +1 (no target) and −2 (targets a player) are offered; −6 is unpayable at 3 loyalty.
    expect(options.map((o) => o.abilityIndex).sort()).toEqual([0, 1]);
    const plus = options.find((o) => o.abilityIndex === 0)!;
    expect(plus.label).toContain('+1');
    expect(plus.targets).toBeNull();
    const minus = options.find((o) => o.abilityIndex === 1)!;
    expect(minus.label).toContain('−2');
    expect(minus.targets?.map((t) => t.target).sort()).toEqual(['A', 'B']);

    // Activating the −2 at a target pays loyalty up front (engine-validated).
    const activated = atMain.activateAbility(walker, 1, ['B']);
    expect(activated.rejected).toBeNull();
    const onField = activated.session.state.battlefield.find((c) => c.instanceId === walker);
    expect(onField && loyaltyOf(onField)).toBe(1);
    // And the engine now offers NO further loyalty ability this turn.
    expect(activated.session.abilityOptions().some((o) => o.instanceId === walker)).toBe(false);
  });
});

/**
 * A generic auto-pilot that drives a single seat's priority window through the REAL
 * public `GameSession` API — the same calls the UI buttons make. It greedily plays a
 * land, casts what it can afford (targeting the opponent with burn / any creature
 * with removal), attacks with everything able, blocks the biggest attacker, then
 * passes. It only ever submits actions the engine lists as legal (or a session
 * convenience that decomposes into legal actions), so reaching a winner proves the
 * loop has no dead-ends.
 */
function autoPilotPriority(session: GameSession): GameSession {
  const me = session.priorityPlayer;
  const state = session.state;

  // 1. Play a land if we still can this turn.
  const lands = session.playableLands();
  if (lands.length > 0) {
    const r = session.playLand(lands[0]!);
    if (!r.rejected) return r.session;
  }

  // 2. During our main phase with an empty stack, develop the board THEN burn. We
  // cast non-targeted spells (creatures) first so the game exercises combat, and
  // only fire targeted burn at the opponent's face once there's nothing to develop
  // (which still finishes the game off, exercising burn-with-target).
  const opponent: PlayerId = me === 'A' ? 'B' : 'A';
  if (state.activePlayer === me && state.stack.length === 0) {
    const casts = session.castOptions().filter((o) => o.affordableNow || o.affordableWithTap);
    const develop = casts.filter((o) => !o.needsTarget);
    const burn = casts.filter((o) => o.needsTarget);
    for (const opt of [...develop, ...burn]) {
      let targets: (number | PlayerId)[] = [];
      if (opt.needsTarget) {
        const options = session.targetsFor(opt.requirement);
        if (options.length === 0) continue; // can't legally target — skip
        // Burn / "any": aim at the opponent player to close the game out.
        const faceShot = options.find((o) => o.kind === 'player' && o.player === opponent);
        const chosen = faceShot ?? options[0]!;
        targets = [optionToTarget(chosen)];
      }
      const r = session.castWithAutoTap(opt.instanceId, targets);
      if (!r.rejected) return r.session;
    }
  }

  // 3. Combat: if the engine offers a declare-attackers action, swing with every
  // eligible creature. The engine only lists this once combat has begun (state.combat
  // exists with no attackers yet), so we drive off the legal-action menu directly.
  if (state.activePlayer === me && state.step === 'declareAttackers') {
    const attackers = generateLegalActions(state)
      .filter((a): a is Extract<GameAction, { kind: 'declareAttackers' }> => a.kind === 'declareAttackers')
      .flatMap((a) => a.attackers);
    const all = [...new Set(attackers)];
    if (all.length > 0) {
      const r = session.declareAttackers(all);
      if (!r.rejected) return r.session;
    }
  }

  // 4. Defense: if we're the defending player at the declare-blockers step, throw a
  // chump block at the first attacker with our first untapped creature. The engine
  // only offers the empty (no-block) baseline in its menu; the player constructs the
  // specific assignment, so we build a single legal block here (UI does the same).
  if (state.step === 'declareBlockers' && state.combat && state.combat.attackers.length > 0) {
    const attacker = state.combat.attackers[0]!;
    const blocker = state.battlefield.find(
      (c) => c.controller === me && c.def.types?.includes('creature') && !c.tapped,
    );
    if (blocker) {
      const r = session.declareBlockers([{ blocker: blocker.instanceId, attacker }]);
      if (!r.rejected) return r.session;
    }
  }

  // 5. Nothing better to do — pass priority.
  const passed = session.passPriority();
  return passed.session;
}

describe('a full hotseat game plays to a winner', () => {
  it('drives both seats through the public API to game over with no dead-end', () => {
    let session = startGame({ seed: 99 });
    const maxSteps = 8000; // generous bound; the loop must terminate well before this
    let steps = 0;

    while (!session.gameOver && steps < maxSteps) {
      session = autoPilotPriority(session);
      // Sanity: the game never silently corrupts — a hidden-info view always builds.
      expect(() => buildBoardView(session.state, 'A', SEAT_NAMES)).not.toThrow();
      steps += 1;
    }

    // The game terminated with a decided winner — no infinite loop, no dead-end.
    expect(session.gameOver).toBe(true);
    expect(steps).toBeLessThan(maxSteps);
    expect(session.winner === 'A' || session.winner === 'B').toBe(true);

    // The full event log proves the loop exercised the core MTG interactions, all
    // driven through the public session API with no dead-end on the way to a winner:
    // lands played, a spell cast, mana tapped, combat declared + blocked, damage dealt.
    const kinds = new Set(session.events.map((e) => e.type));
    const seen = `event kinds seen: ${[...kinds].join(',')}`;
    expect(kinds.has('landPlayed'), seen).toBe(true);
    expect(kinds.has('spellCast'), seen).toBe(true);
    expect(kinds.has('tapped'), seen).toBe(true);
    expect(kinds.has('attackersDeclared'), seen).toBe(true);
    expect(kinds.has('blockersDeclared'), seen).toBe(true);
    expect(kinds.has('damageDealt'), seen).toBe(true);
    expect(kinds.has('playerLost'), seen).toBe(true);
  });
});

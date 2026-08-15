import { describe, expect, it } from 'vitest';
import {
  applyAction,
  createGame,
  createRng,
  generateLegalActions,
  type DeckList,
  type GameState,
} from '@jonny-boi/core';
import {
  createDefaultAiRegistry,
  createAiRegistry,
  DEFAULT_PILOT_ID,
  getPilot,
  HEURISTIC_PILOT_ID,
  MCTS_PILOT_ID,
  PACKAGE_NAME,
  RANDOM_PILOT_ID,
  registerBuiltInPilots,
  SELECTABLE_PILOT_IDS,
  createHeuristicPilot,
} from './index.js';
import { burnDef, creatureDef, landDef } from './test-support.js';

describe('@jonny-boi/ai package', () => {
  it('exposes its package name placeholder', () => {
    expect(PACKAGE_NAME).toBe('ai');
  });
});

/**
 * A guard, not a preference. `DEFAULT_PILOT_ID` decides what every consumer runs
 * — the CLI sim, the in-browser Lab, the match viewer — and it has already been
 * silently flipped to `mcts` by a merge once, which made the Lab's default 600-game
 * gauntlet take hours (~29 s/game in Node, ~66 s/game in the browser worker) while
 * measurably playing WORSE (1.76 mana tapped-and-unspent per turn vs 0.01). The
 * reasoning lives on the constant itself; this pins it so the next merge cannot
 * undo it quietly. Changing it should mean changing this test, with a fresh
 * head-to-head measurement in the commit message.
 */
describe('the default pilot', () => {
  it('is the heuristic — the throughput path users actually get', () => {
    expect(DEFAULT_PILOT_ID).toBe(HEURISTIC_PILOT_ID);
  });

  it('still offers MCTS as a selectable choice', () => {
    expect(SELECTABLE_PILOT_IDS).toContain(MCTS_PILOT_ID);
    expect(getPilot(MCTS_PILOT_ID)?.id).toBe(MCTS_PILOT_ID);
  });

  it('offers every selectable id from the default registry', () => {
    const registry = createDefaultAiRegistry();
    for (const id of SELECTABLE_PILOT_IDS) expect(registry.getPilot(id)?.id).toBe(id);
  });

  /**
   * The `hybrid` search pilot beat the heuristic 60.0% over 120 seeded games
   * (95% CI [51.1%, 68.3%], DESIGN §3.4a) — a real, significant strength win, and
   * still NOT grounds to re-default. It costs ~7 ms per decision against the
   * heuristic's ~0.004 ms, so the Lab's stock gauntlet would go from seconds to
   * hours; re-defaulting needs a throughput case, not only a head-to-head. The
   * previous flip to `mcts` shipped on exactly that reasoning gap.
   */
  it('offers the hybrid search pilot as a selectable choice, but not as the default', () => {
    expect(SELECTABLE_PILOT_IDS).toContain('hybrid');
    expect(getPilot('hybrid')?.id).toBe('hybrid');
    expect(DEFAULT_PILOT_ID).not.toBe('hybrid');
  });
});

describe('AI registry seam', () => {
  it('resolves the two built-in pilots by id', () => {
    const registry = createDefaultAiRegistry();
    expect(registry.getPilot(RANDOM_PILOT_ID)?.id).toBe('random');
    expect(registry.getPilot(HEURISTIC_PILOT_ID)?.id).toBe('heuristic');
  });

  it('lists the registered pilot ids', () => {
    const registry = createDefaultAiRegistry();
    expect(registry.pilotIds()).toContain('random');
    expect(registry.pilotIds()).toContain('heuristic');
  });

  it('returns undefined for an unknown id (no throw)', () => {
    const registry = createDefaultAiRegistry();
    expect(registry.getPilot('does-not-exist')).toBeUndefined();
  });

  it('lets a new pilot self-register (composition, not a class tree)', () => {
    const registry = createAiRegistry();
    registry.registerPilot('always-pass', () => ({
      id: 'always-pass',
      description: 'test pilot',
      chooseAction: (ctx) => ({ kind: 'passPriority', player: ctx.view.priorityPlayer }),
    }));
    expect(registry.getPilot('always-pass')?.id).toBe('always-pass');
  });

  it('getPilot convenience resolves from a fresh default registry', () => {
    expect(getPilot('heuristic')?.id).toBe('heuristic');
    expect(getPilot('nope')).toBeUndefined();
  });

  it('registerBuiltInPilots installs into an arbitrary registry', () => {
    const registry = createAiRegistry();
    registerBuiltInPilots(registry);
    expect(registry.getPilot('random')).toBeDefined();
    expect(registry.getPilot('heuristic')).toBeDefined();
  });
});

// --- the scripted mini-game ----------------------------------------------------

/**
 * A small but real burn-aggro deck: lands + two-drop beaters + a few burn spells.
 * Enough mana, threats, and reach that two heuristic pilots develop boards, attack,
 * remove blockers / burn the face, and close out games (not just deck out) — so the
 * full-game loop exercises the heuristic's spell, combat, and lethal-burn paths.
 */
function aggroDeck(): DeckList {
  const cards = [];
  for (let i = 0; i < 11; i++) cards.push(landDef(`Mountain${i % 3}`, 'R'));
  for (let i = 0; i < 7; i++) cards.push(creatureDef(`Beater${i}`, 3, 2, { cost: { generic: 1, R: 1 } }));
  for (let i = 0; i < 6; i++) cards.push(burnDef(`Bolt${i}`, 3, { R: 1 }));
  return { cards };
}

/**
 * Drive a full game: generateLegalActions → pilot.chooseAction → applyAction, with
 * a heuristic pilot in each seat. Returns the terminal state and the turn count.
 * Bounded so a bug can't hang the suite. Deterministic (seeded).
 */
function playOut(seed: number, maxActions = 20000): { state: GameState; actions: number } {
  const a = createHeuristicPilot();
  const b = createHeuristicPilot();
  // Distinct decision RNGs per seat, derived from the game seed → fully reproducible.
  const rngA = createRng(seed ^ 0x1111_1111);
  const rngB = createRng(seed ^ 0x2222_2222);

  let { state } = createGame({ seed, decks: { A: aggroDeck(), B: aggroDeck() } });
  let actions = 0;
  while (!state.gameOver && actions < maxActions) {
    const legal = generateLegalActions(state);
    const seat = state.priorityPlayer;
    const pilot = seat === 'A' ? a : b;
    const rng = seat === 'A' ? rngA : rngB;
    const action = pilot.chooseAction({ view: state, legalActions: legal, rng });
    state = applyAction(state, action).state;
    actions += 1;
  }
  return { state, actions };
}

describe('scripted mini-game (two heuristic pilots)', () => {
  it('finishes with a winner in bounded turns', () => {
    const { state, actions } = playOut(20240620);
    expect(state.gameOver).toBe(true);
    expect(state.winner === 'A' || state.winner === 'B').toBe(true);
    expect(actions).toBeLessThan(20000);
    // Sanity: a real game took multiple turns, not an instant decking artifact.
    expect(state.turnNumber).toBeGreaterThan(2);
  });

  it('is deterministic: same seed → same outcome and length', () => {
    const first = playOut(7);
    const second = playOut(7);
    expect(second.state.winner).toBe(first.state.winner);
    expect(second.state.turnNumber).toBe(first.state.turnNumber);
    expect(second.actions).toBe(first.actions);
  });

  it('terminates across several seeds (no hangs / illegal-action stalls)', () => {
    for (const seed of [1, 2, 3, 101, 999]) {
      const { state, actions } = playOut(seed);
      expect(state.gameOver).toBe(true);
      expect(actions).toBeLessThan(20000);
    }
  });
});

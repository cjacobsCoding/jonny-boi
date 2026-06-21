import { describe, expect, it } from 'vitest';
import {
  createGame,
  createEngine,
  applyAction,
  generateLegalActions,
  DEFAULT_RULES,
  serializeState,
  dumpState,
} from './index.js';
import { deckOf, landDef } from './test-fixtures.js';

/**
 * Smoke test of the public barrel: the headline exports exist and a minimal game
 * runs end-to-end through the public API only.
 */
describe('@jonny-boi/core public API', () => {
  it('exports the engine lifecycle functions', () => {
    expect(typeof createGame).toBe('function');
    expect(typeof createEngine).toBe('function');
    expect(typeof applyAction).toBe('function');
    expect(typeof generateLegalActions).toBe('function');
    expect(DEFAULT_RULES.startingLife).toBe(20);
  });

  it('plays a few priority passes via the public API without crashing', () => {
    const land = landDef('Island', 'U');
    const g = createGame({ seed: 1, decks: { A: deckOf(land, 40), B: deckOf(land, 40) } });
    let s = g.state;
    for (let i = 0; i < 10 && !s.gameOver; i++) {
      const actions = generateLegalActions(s);
      expect(actions.length).toBeGreaterThan(0);
      s = applyAction(s, { kind: 'passPriority', player: s.priorityPlayer }).state;
    }
    expect(serializeState(s)).toBeDefined();
    expect(typeof dumpState(s)).toBe('string');
  });
});

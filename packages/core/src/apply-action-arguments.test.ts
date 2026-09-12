/**
 * THE THIRD ARGUMENT IS THE CONFIG, AND NINE CALL SITES SAID OTHERWISE (§3.143).
 *
 * `applyAction(state, action, config, registry)` was being called as
 * `applyAction(state, action, { registry })` in nine places across two packages.
 * The registry lands in the config slot, the real registry parameter stays
 * `undefined`, and core does exactly what it is supposed to do with no registry:
 * every effect degrades to `effectUnsupported` and nothing happens. The test that
 * spelled it stayed green, having checked a game in which no spell did anything.
 *
 * It is a plain type error — `{ registry }` is not a `RulesConfig` — and the reason
 * nothing caught it is worth writing down: **no tsconfig in this repo compiles a
 * `*.test.ts`.** Every package excludes them, so a mistake made in a test is only
 * ever checked when it runs. That makes a runtime refusal the only guard that can
 * actually reach the place the mistake gets made.
 *
 * These tests pin the refusal. If they ever go green-by-permissiveness, the nine
 * sites can come back and nothing will say so.
 */

import { describe, expect, it } from 'vitest';
import { applyAction, applyActionInPlace, createEffectRegistry, createGame, DEFAULT_RULES } from './index.js';
import type { DeckList, GameState, RulesConfig } from './index.js';

function deck(): DeckList {
  return { cards: Array.from({ length: 30 }, (_, i) => ({ id: `L${i}`, name: `L${i}`, types: ['land'] as const, produces: ['R'] as const })) };
}

function position(): GameState {
  return createGame({ seed: 11, decks: { A: deck(), B: deck() } }).state;
}

const PASS = { kind: 'passPriority', player: 'A' } as const;

describe('applyAction refuses a third argument that is not the rules config', () => {
  /** ⚠️ The load-bearing one: this is the exact shape the nine sites had. */
  it('throws on the `{ registry }` mis-call rather than dropping the registry', () => {
    const registry = createEffectRegistry();
    expect(() => applyAction(position(), PASS, { registry } as unknown as RulesConfig)).toThrow(TypeError);
  });

  /** And on the variant the core copy tests used, which also carried a `config` key. */
  it('throws on `{ registry, config: undefined }` too', () => {
    const registry = createEffectRegistry();
    expect(() =>
      applyAction(position(), PASS, { registry, config: undefined } as unknown as RulesConfig),
    ).toThrow(TypeError);
  });

  /**
   * The message has to name the fix, not just the fault. The whole cost of this
   * defect was an author with no signal at all; a refusal that does not say what to
   * write instead only moves the confusion.
   */
  it('names the correct call in the failure', () => {
    let message = '';
    try {
      applyAction(position(), PASS, { registry: createEffectRegistry() } as unknown as RulesConfig);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain('applyAction(state, action, undefined, registry)');
    expect(message).toContain('effectUnsupported');
  });

  // --- and it must not refuse anything legitimate ---------------------------------

  it('accepts the default config, an omitted config, and an explicit undefined', () => {
    expect(() => applyAction(position(), PASS)).not.toThrow();
    expect(() => applyAction(position(), PASS, undefined)).not.toThrow();
    expect(() => applyAction(position(), PASS, DEFAULT_RULES)).not.toThrow();
    expect(() => applyAction(position(), PASS, undefined, createEffectRegistry())).not.toThrow();
  });

  it('accepts a CUSTOM config — a format variant is the whole reason the knob exists', () => {
    const variant: RulesConfig = { ...DEFAULT_RULES, startingLife: 40, maxLandsPerTurn: 2 };
    expect(() => applyAction(position(), PASS, variant)).not.toThrow();
    // And it is still honoured, not merely tolerated.
    expect(createGame({ seed: 1, decks: { A: deck(), B: deck() }, config: variant }).state.players.A.life).toBe(40);
  });

  /**
   * The refusal is deliberately NOT on `applyActionInPlace`: that is the MCTS
   * rollout path (~20,000 calls per decision, no clone to hide a check behind) and
   * its only callers are inside the search. Stated as a test so the asymmetry is a
   * decision on the record rather than something that looks like an oversight.
   */
  it('leaves applyActionInPlace unguarded on purpose — the search hot path', () => {
    const state = position();
    expect(() => applyActionInPlace(state, PASS, DEFAULT_RULES)).not.toThrow();
  });
});

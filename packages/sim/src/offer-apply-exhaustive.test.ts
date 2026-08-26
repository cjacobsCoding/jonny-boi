/**
 * OFFER/APPLY AGREEMENT, EXHAUSTIVELY — the §3.49 sweep for the §3.36 class.
 *
 * What already exists (and is NOT duplicated here): the soak's
 * `checkActionLegality` proves the action a pilot CHOSE was on the offered
 * menu, and its `noRejectedActions` invariant proves that chosen action was
 * then accepted. Both quantify over one action per decision — the one the
 * pilot happened to take.
 *
 * This file completes the quantifier. At EVERY decision point of a seeded
 * random-walk game, EVERY action `generateLegalActions` offers is applied
 * against that state, and any `actionRejected` fails the run. "The menu is a
 * promise" (DESIGN §3.36: offer and apply must agree) becomes a checked
 * property of the whole menu, not of the branch a pilot explored — which is
 * how a menu entry whose apply-side validation disagrees (an aim the reject
 * path refuses, a mode the resolver cannot pay) gets caught the day it is
 * authored, not the day a pilot happens to pick it.
 *
 * The walk is a RANDOM pilot on purpose: it visits states a competent pilot
 * never would (attacking into a wall, casting the wrong half), and those are
 * exactly the menus nobody else audits. Decks: the blink deck (the pool's
 * same-id return funnel, §3.44's home) against the control deck (counters,
 * wraths, instants on other people's turns), picked by archetype with an
 * index fallback so a rename cannot silence the sweep.
 */
import { describe, expect, it } from 'vitest';
import type { GameAction, GameState } from '@jonny-boi/core';
import { applyAction, createGame, DEFAULT_RULES, generateLegalActions } from '@jonny-boi/core';
import { buildRegistry, loadCardPool } from '@jonny-boi/cards';
import { loadDeck } from './deck.js';
import { SAMPLE_DECKS } from '../data/decks/index.js';

/** Deterministic LCG so the walk replays identically per seed. */
function makeRng(seed: number): (bound: number) => number {
  let s = seed >>> 0;
  return (bound: number) => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s % bound;
  };
}

/** Enough of an action to name it in a failure without dumping a state. */
function describeAction(action: GameAction): string {
  return JSON.stringify(action);
}

const ACTION_CAP_PER_GAME = 700;
/** Two games, different seeds and play/draw — measured at low single-digit seconds. */
const WALK_SEEDS: readonly number[] = [493101, 493102];

describe('every offered action is accepted (§3.36 class, whole menu)', () => {
  it('random-walk games: apply the ENTIRE menu at every decision point', () => {
    const registry = buildRegistry();
    const pool = loadCardPool({ onWarn: () => {} });
    const blink = SAMPLE_DECKS.find((d) => /blink/i.test(d.name)) ?? SAMPLE_DECKS[0]!;
    const control = SAMPLE_DECKS.find((d) => /control/i.test(d.name)) ?? SAMPLE_DECKS[1]!;
    const libraries = {
      A: { cards: [...loadDeck(blink, pool).library] },
      B: { cards: [...loadDeck(control, pool).library] },
    };

    const violations: string[] = [];
    let decisions = 0;
    let applied = 0;

    for (const seed of WALK_SEEDS) {
      const rng = makeRng(seed);
      let state: GameState = createGame({ seed, decks: libraries, registry }).state;
      let actions = 0;
      while (!state.gameOver && actions < ACTION_CAP_PER_GAME) {
        const legal = generateLegalActions(state, DEFAULT_RULES);
        if (legal.length === 0) break;
        decisions += 1;
        for (const offer of legal) {
          const probe = applyAction(state, offer, DEFAULT_RULES, registry);
          applied += 1;
          const rejected = probe.events.find((e) => e.type === 'actionRejected');
          if (rejected && violations.length < 20) {
            violations.push(
              `seed ${seed}, turn ${state.turnNumber}, step ${state.step}: offered ${describeAction(offer)} ` +
                `was rejected — ${(rejected as { reason: string }).reason}`,
            );
          }
        }
        // Advance along ONE offered branch, chosen uniformly.
        const step = legal[rng(legal.length)]!;
        state = applyAction(state, step, DEFAULT_RULES, registry).state;
        actions += 1;
      }
    }

    expect(violations, violations.join('\n')).toEqual([]);
    // The sweep must have really swept: a menu bug that empties the menus, or
    // a game that ends on turn one, would otherwise pass in silence.
    expect(decisions, 'too few decision points — the walk did not really play').toBeGreaterThan(400);
    expect(applied, 'too few menu entries applied — the sweep was vacuous').toBeGreaterThan(2_000);
  });
});

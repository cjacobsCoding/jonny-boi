/**
 * PLAYING UNTIL THE INTERVAL IS TIGHT ENOUGH (DESIGN §3.94).
 *
 * The gauntlet asks "what IS this deck's win rate?", which is an ESTIMATE, not a
 * test — so it takes a fixed-width two-stage rule, not the group-sequential
 * boundary `swap` uses. These tests pin the three things that make it honest:
 * the budget is never exceeded, a lopsided win rate really does need fewer games,
 * and a freak pilot cannot talk the run into stopping at nothing.
 */

import { describe, expect, it } from 'vitest';
import { decidePrecision, planPrecision } from './precision.js';
import { wilsonInterval } from './stats.js';

describe('the pilot stage decides how many games the interval needs', () => {
  it('asks for far fewer games when the deck is lopsided than when it is a coin flip', () => {
    const plan = planPrecision(1000, 0.05);
    // A 50% deck is the worst case for variance; a 90% deck is much cheaper.
    const coinFlip = decidePrecision(plan, 50, 100, 1);
    const lopsided = decidePrecision(plan, 90, 100, 1);
    expect(lopsided.totalGames).toBeLessThan(coinFlip.totalGames);
  });

  it('never exceeds the budget, and says when the budget was the limit', () => {
    // A tight target against a small budget: the run cannot reach it.
    const plan = planPrecision(40, 0.01);
    const decision = decidePrecision(plan, 20, 40, 1);
    expect(decision.totalGames).toBeLessThanOrEqual(40);
    expect(decision.budgetLimited).toBe(true);
  });

  it('reports budgetLimited=false when the target is reachable inside the budget', () => {
    const plan = planPrecision(5000, 0.05);
    const decision = decidePrecision(plan, 90, 100, 1);
    expect(decision.budgetLimited).toBe(false);
    expect(decision.totalGames).toBeLessThan(5000);
  });

  it('⚠️ does NOT let a freak 100% pilot conclude that a handful of games is enough', () => {
    // p(1-p) is zero at the extremes, so an unfloored estimate would ask for ~0
    // games — the variance floor is what stops a lucky pilot ending the run.
    const plan = planPrecision(1000, 0.05);
    const perfect = decidePrecision(plan, 20, 20, 1);
    expect(perfect.totalGames).toBeGreaterThan(50);
  });

  it('spends more games for a tighter interval', () => {
    const loose = decidePrecision(planPrecision(10_000, 0.10), 50, 100, 1);
    const tight = decidePrecision(planPrecision(10_000, 0.02), 50, 100, 1);
    expect(tight.totalGames).toBeGreaterThan(loose.totalGames);
  });

  it('divides the work across opponents — the interval is over the WHOLE run', () => {
    const plan = planPrecision(10_000, 0.05);
    const one = decidePrecision(plan, 50, 100, 1);
    const eight = decidePrecision(plan, 50, 100, 8);
    // Same total games needed, so eight opponents need ~an eighth each.
    expect(eight.totalGames).toBeLessThan(one.totalGames);
    expect(eight.totalGames * 8).toBeGreaterThanOrEqual(one.totalGames - 8);
  });

  it('the games it asks for really do reach the requested width', () => {
    // The point of the whole exercise: play what it says, and the interval the
    // sim reports is at least as tight as the target.
    const target = 0.05;
    const plan = planPrecision(100_000, target);
    const decision = decidePrecision(plan, 70, 100, 1);
    const wins = Math.round(0.7 * decision.totalGames);
    const ci = wilsonInterval(wins, decision.totalGames, 1.959963984540054);
    expect((ci.high - ci.low) / 2).toBeLessThanOrEqual(target + 1e-9);
  });
});

describe('the plan refuses inputs it cannot serve', () => {
  it('rejects a half-width that is not a proportion', () => {
    expect(() => planPrecision(100, 0)).toThrow(/half-width/);
    expect(() => planPrecision(100, 0.5)).toThrow(/half-width/);
    expect(() => planPrecision(100, -0.1)).toThrow(/half-width/);
  });

  it('rejects an empty budget rather than planning a run of nothing', () => {
    expect(() => planPrecision(0, 0.05)).toThrow(/positive game budget/);
  });

  it('never plans a pilot larger than the budget', () => {
    expect(planPrecision(4, 0.05).pilotGames).toBeLessThanOrEqual(4);
  });
});

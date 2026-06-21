/**
 * The Lab's named config must stay coherent: defaults inside their slider bounds,
 * and the verdict alpha + caveat mirroring the sim's own constants (one source of
 * truth — DESIGN §1: no divergent magic numbers across surfaces).
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SUGGEST_CONFIG,
  DEFAULT_STATS_CONFIG,
  DEFAULT_SIM_CONFIG,
} from '@jonny-boi/sim';
import {
  DEFAULT_LAB_SEED,
  GAUNTLET_GAMES,
  SWAP_GAMES,
  SUGGEST_GAMES,
  SUGGEST_MAX_CANDIDATES,
  VERDICT_ALPHA,
  FIDELITY_CAVEAT,
} from './lab-config.js';

const within = (cfg: { default: number; min: number; max: number }) =>
  cfg.default >= cfg.min && cfg.default <= cfg.max;

describe('lab-config coherence', () => {
  it('every slider default sits within its own bounds', () => {
    expect(within(GAUNTLET_GAMES)).toBe(true);
    expect(within(SWAP_GAMES)).toBe(true);
    expect(within(SUGGEST_GAMES)).toBe(true);
    expect(within(SUGGEST_MAX_CANDIDATES)).toBe(true);
  });

  it('defaults derive from the sim config (cross-surface parity)', () => {
    expect(GAUNTLET_GAMES.default).toBe(DEFAULT_SIM_CONFIG.defaultGames);
    expect(SUGGEST_GAMES.default).toBe(DEFAULT_SUGGEST_CONFIG.defaultGamesPerCandidate);
    expect(SUGGEST_MAX_CANDIDATES.default).toBe(DEFAULT_SUGGEST_CONFIG.maxCandidates);
    expect(VERDICT_ALPHA).toBe(DEFAULT_STATS_CONFIG.alpha);
  });

  it('the seed is a finite integer and the caveat states accurate fidelity', () => {
    expect(Number.isInteger(DEFAULT_LAB_SEED)).toBe(true);
    // Engine v2 models triggers + until-EOT effects; the caveat must say so and
    // flag the remaining simplified mechanics — not call verdicts provisional.
    expect(FIDELITY_CAVEAT).toMatch(/simplified subset/);
    expect(FIDELITY_CAVEAT).not.toMatch(/PROVISIONAL/i);
  });
});

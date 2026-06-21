/**
 * Shared prop shapes for the Lab's three run panels (gauntlet / swap / suggest).
 * Each panel receives the picked hero, the chosen opponents, the seed, and the
 * one sim-worker handle — so they all drive the SAME worker wrapper (DRY).
 */
import type { Deck } from '../../lib/deck.js';
import type { SimDeckPayload } from '../../lib/sim-protocol.js';
import type { SimWorkerApi } from '../../lib/useSimWorker.js';

/** A games-per-run slider config (named bounds from `lab-config`). */
export interface GamesConfig {
  readonly default: number;
  readonly min: number;
  readonly max: number;
  readonly step: number;
}

/** A card-pick option: the sim cardId we send + the human name we show. */
export interface CardOption {
  readonly cardId: string;
  readonly name: string;
}

/** Props every run panel shares. */
export interface PanelProps {
  readonly hero: Deck | null;
  readonly heroPayload: SimDeckPayload | null;
  readonly heroLegal: boolean;
  readonly chosenOpponents: readonly string[];
  readonly seed: number;
  readonly sim: SimWorkerApi;
}

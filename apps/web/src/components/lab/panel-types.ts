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
  /** How many copies the hero runs, when the option came from a deck (§3.136). */
  readonly count?: number;
}

/** Props every run panel shares. */
export interface PanelProps {
  readonly hero: Deck | null;
  readonly heroPayload: SimDeckPayload | null;
  readonly heroLegal: boolean;
  readonly chosenOpponents: readonly string[];
  readonly seed: number;
  /**
   * The AI pilot both seats play with. Every panel sends it with its request and
   * shows it with its result: a win rate or a verdict is a measurement of a deck
   * AS PLAYED BY this pilot, not a property of the deck on its own.
   */
  readonly pilotId: string;
  readonly sim: SimWorkerApi;
  /**
   * Apply a tested swap to the hero deck, or `undefined` when the hero cannot be
   * edited (a bundled gauntlet deck is build data, not yours). Acting on a verdict
   * is the whole point of getting one, so a panel that shows a result offers it.
   */
  readonly onApplySwap?: (outCardId: string, inCardId: string, copies: number) => void;
}

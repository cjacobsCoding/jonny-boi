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
  /**
   * Why this card cannot be swapped IN, when it cannot: an imported card whose
   * printed text the engine does not implement yet has a display record (so it
   * shows up in lists) but no engine definition, and a run containing one dies
   * before the first game.
   *
   * Present means "offer it, but disabled, with the reason" — hiding it silently
   * would leave the user hunting for a card they can see everywhere else.
   */
  readonly unavailable?: string;
}

/** Props every run panel shares. */
export interface PanelProps {
  readonly hero: Deck | null;
  readonly heroPayload: SimDeckPayload | null;
  readonly heroLegal: boolean;
  readonly chosenOpponents: readonly string[];
  readonly seed: number;
  readonly sim: SimWorkerApi;
  /**
   * Apply a tested swap to the hero deck, or `undefined` when the hero cannot be
   * edited (a bundled gauntlet deck is build data, not yours). Acting on a verdict
   * is the whole point of getting one, so a panel that shows a result offers it.
   */
  readonly onApplySwap?: (outCardId: string, inCardId: string, copies: number) => void;
}

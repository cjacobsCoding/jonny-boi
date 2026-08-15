/**
 * The Lab's SELECTION state, held above the view so it survives navigation.
 *
 * Hoisting the sim worker alone was not enough. The worker keeps the run and its
 * result alive, but if the hero, seed, opponents and active tab reset on unmount
 * you come back to a finished result rendered next to a hero picker that has
 * silently snapped to a different deck — a result that no longer describes what
 * the controls say. The run and the question that produced it have to persist
 * together or neither should.
 *
 * Deliberately plain state with no persistence: this is "don't lose my work while
 * I glance at a card", not a saved document.
 */

import { useState } from 'react';
import { DEFAULT_LAB_SEED } from './lab-config.js';

/** The Lab's sub-tabs — the three things you can run against the gauntlet. */
export type LabTabId = 'gauntlet' | 'swap' | 'suggest';

/** Everything the Lab needs to remember between visits. */
export interface LabSelection {
  readonly tab: LabTabId;
  readonly setTab: (tab: LabTabId) => void;
  readonly heroId: string | null;
  readonly setHeroId: (id: string) => void;
  readonly seed: number;
  readonly setSeed: (seed: number) => void;
  readonly opponentNames: readonly string[];
  readonly setOpponentNames: (update: (current: readonly string[]) => string[]) => void;
  /** Confirmation shown after applying a verdict; cleared on the next apply. */
  readonly applyNote: string | null;
  readonly setApplyNote: (note: string | null) => void;
}

/**
 * Create the Lab's selection state. Called ONCE, in `App`, so it outlives the
 * view. `initialOpponents` seeds the opponent picker with the full gauntlet.
 */
export function useLabSelection(initialOpponents: readonly string[]): LabSelection {
  const [tab, setTab] = useState<LabTabId>('gauntlet');
  const [heroId, setHeroId] = useState<string | null>(null);
  const [seed, setSeed] = useState(DEFAULT_LAB_SEED);
  const [opponentNames, setNames] = useState<readonly string[]>(initialOpponents);
  const [applyNote, setApplyNote] = useState<string | null>(null);

  return {
    tab,
    setTab,
    heroId,
    setHeroId,
    seed,
    setSeed,
    opponentNames,
    setOpponentNames: (update) => setNames((current) => update(current)),
    applyNote,
    setApplyNote,
  };
}

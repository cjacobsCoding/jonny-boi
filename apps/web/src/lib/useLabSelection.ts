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
import { VERDICT_BARS, type VerdictBar } from '@jonny-boi/sim';
import { DEFAULT_LAB_SEED, DEFAULT_VERDICT_BAR, VERDICT_MIN_GAMES } from './lab-config.js';
import { DEFAULT_PILOT_ID } from './sim/pilots.js';

/**
 * THE LAB'S SUB-TABS — one registry, and the id union is DERIVED from it
 * (DESIGN §3.180).
 *
 * ⚠️ There used to be two lists: this union, hand-written, and a `LAB_TABS`
 * array private to `LabView.tsx` carrying the same six ids and the same
 * doc-comment, with NOTHING pinning them together. Two places answering "what
 * are the Lab's tabs?" eventually answer it differently, and the bug gets blamed
 * on neither (project rule 12). It lives here rather than in the view because a
 * view importing from a lib is the direction the rest of the app already runs.
 *
 * It is exported so a TEST CAN ENUMERATE IT: the guard that every tab gets the
 * pinned progress dock iterates these rows, so a seventh tab cannot ship without
 * one. Adding a tab is a row here.
 */
export const LAB_TABS = [
  { id: 'gauntlet', label: 'Gauntlet' },
  { id: 'swap', label: 'A/B Swap Test' },
  { id: 'suggest', label: 'Suggestions' },
  { id: 'trim', label: 'Trim' },
  { id: 'manabase', label: 'Manabase' },
  { id: 'joint', label: 'Joint search' },
] as const;

export type LabTabId = (typeof LAB_TABS)[number]['id'];

/** Everything the Lab needs to remember between visits. */
export interface LabSelection {
  readonly tab: LabTabId;
  readonly setTab: (tab: LabTabId) => void;
  readonly heroId: string | null;
  readonly setHeroId: (id: string) => void;
  readonly seed: number;
  readonly setSeed: (seed: number) => void;
  /**
   * The AI pilot both seats are played by. Sits beside the hero and the seed
   * because it is the same kind of thing: part of the QUESTION being asked, not a
   * rendering preference. Changing it makes every displayed result describe a run
   * that is no longer the one configured — so the Lab clears the result when it
   * changes, exactly as it does for the hero.
   */
  readonly pilotId: string;
  readonly setPilotId: (id: string) => void;
  /**
   * How strict a verdict has to be before the Lab will call a swap better or
   * worse (§3.179). Same kind of thing as the pilot: changing it changes what
   * the numbers MEAN, so it lives with the question rather than in a panel.
   */
  readonly verdictBar: VerdictBar;
  readonly setVerdictBar: (alpha: number) => void;
  /** Minimum paired games before a verdict may be anything but inconclusive. */
  readonly verdictMinGames: number;
  readonly setVerdictMinGames: (games: number) => void;
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
  const [pilotId, setPilotId] = useState<string>(DEFAULT_PILOT_ID);
  const [verdictBar, setBar] = useState<VerdictBar>(DEFAULT_VERDICT_BAR);
  // ⚠️ Set by ALPHA, never by handing in a whole bar: the caller cannot then
  // assemble an alpha and a z that disagree. The table is the only source of
  // pairs, and an alpha with no row throws rather than being approximated.
  const setVerdictBar = (alpha: number): void => {
    const row = VERDICT_BARS.find((bar) => bar.alpha === alpha);
    if (!row) throw new Error(`no verdict bar for alpha ${alpha}`);
    setBar(row);
  };
  const [verdictMinGames, setVerdictMinGames] = useState(VERDICT_MIN_GAMES.default);
  const [opponentNames, setNames] = useState<readonly string[]>(initialOpponents);
  const [applyNote, setApplyNote] = useState<string | null>(null);

  return {
    tab,
    setTab,
    heroId,
    setHeroId,
    seed,
    setSeed,
    pilotId,
    setPilotId,
    verdictBar,
    setVerdictBar,
    verdictMinGames,
    setVerdictMinGames,
    opponentNames,
    setOpponentNames: (update) => setNames((current) => update(current)),
    applyNote,
    setApplyNote,
  };
}

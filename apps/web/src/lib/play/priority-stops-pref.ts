/**
 * The persisted PRIORITY STOPS preference (§3.119) — same shape of module as
 * `mana-choice-pref.ts`: a player setting that outlives a game, stored
 * best-effort in localStorage, decoded defensively so a stale or hand-edited
 * blob degrades to the defaults rather than to a white screen.
 */
import { PRIORITY_STOPS_STORAGE_KEY } from '../config.js';
import {
  DEFAULT_PRIORITY_STOPS,
  STEP_STOPS,
  type PriorityStops,
  type StepStopKey,
} from './priority-stops.js';

const KNOWN_KEYS: ReadonlySet<string> = new Set(STEP_STOPS.map((row) => row.key));

/**
 * Decode a stored blob into stops, keeping ONLY what is well-formed: known step
 * keys with boolean values, and the three boolean switches. Anything else is
 * dropped silently — a key from a step that no longer exists must not survive
 * to confuse the menu, and a non-boolean must not become truthy by accident.
 */
export function decodePriorityStops(raw: unknown): PriorityStops {
  if (typeof raw !== 'object' || raw === null) return DEFAULT_PRIORITY_STOPS;
  const record = raw as Record<string, unknown>;
  const steps: Partial<Record<StepStopKey, boolean>> = {};
  const storedSteps = record['steps'];
  if (typeof storedSteps === 'object' && storedSteps !== null) {
    for (const [key, value] of Object.entries(storedSteps as Record<string, unknown>)) {
      if (KNOWN_KEYS.has(key) && typeof value === 'boolean') steps[key as StepStopKey] = value;
    }
  }
  const flag = (name: keyof PriorityStops, fallback: boolean): boolean =>
    typeof record[name] === 'boolean' ? (record[name] as boolean) : fallback;
  return {
    steps,
    stopOnOpponentStack: flag('stopOnOpponentStack', DEFAULT_PRIORITY_STOPS.stopOnOpponentStack),
    stopOnOwnStack: flag('stopOnOwnStack', DEFAULT_PRIORITY_STOPS.stopOnOwnStack),
    fullControl: flag('fullControl', DEFAULT_PRIORITY_STOPS.fullControl),
  };
}

/** Read the stored stops; the defaults when there are none or they are unreadable. */
export function loadPriorityStops(): PriorityStops {
  try {
    const raw = localStorage.getItem(PRIORITY_STOPS_STORAGE_KEY);
    if (raw === null) return DEFAULT_PRIORITY_STOPS;
    return decodePriorityStops(JSON.parse(raw));
  } catch {
    return DEFAULT_PRIORITY_STOPS;
  }
}

/** Persist the stops. Never throws; a full/blocked store just warns. */
export function savePriorityStops(stops: PriorityStops): void {
  try {
    localStorage.setItem(PRIORITY_STOPS_STORAGE_KEY, JSON.stringify(stops));
  } catch (error) {
    console.warn('Could not persist the priority stops.', error);
  }
}

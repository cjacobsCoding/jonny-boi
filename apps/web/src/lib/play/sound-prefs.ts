/**
 * The persisted GAME-AUDIO preference (§3.130) — same shape of module as
 * `priority-stops-pref.ts`: a player setting that outlives a game, stored
 * best-effort in localStorage and decoded defensively so a stale or hand-edited
 * blob degrades to the defaults rather than to a crash.
 */
import { SOUND_STORAGE_KEY } from '../config.js';
import { SOUND_CONFIG } from './play-config.js';
import { writeStorage } from '../persistence/write.js';

/** The player's audio settings, as persisted and as the board reads them. */
export interface SoundPrefs {
  /** Is audio on? */
  readonly enabled: boolean;
  /** Master volume, 0..1. */
  readonly volume: number;
}

/** The out-of-the-box audio settings (from {@link SOUND_CONFIG}). */
export const DEFAULT_SOUND_PREFS: SoundPrefs = Object.freeze({
  enabled: SOUND_CONFIG.defaultEnabled,
  volume: SOUND_CONFIG.defaultVolume,
});

/** Decode a stored blob, keeping only a real boolean and an in-range volume. */
export function decodeSoundPrefs(raw: unknown): SoundPrefs {
  if (typeof raw !== 'object' || raw === null) return DEFAULT_SOUND_PREFS;
  const record = raw as Record<string, unknown>;
  const enabled = typeof record['enabled'] === 'boolean' ? (record['enabled'] as boolean) : DEFAULT_SOUND_PREFS.enabled;
  const rawVol = record['volume'];
  const volume =
    typeof rawVol === 'number' && Number.isFinite(rawVol) ? Math.min(1, Math.max(0, rawVol)) : DEFAULT_SOUND_PREFS.volume;
  return { enabled, volume };
}

/** Read the stored prefs; the defaults when there are none or they are unreadable. */
export function loadSoundPrefs(): SoundPrefs {
  try {
    const raw = localStorage.getItem(SOUND_STORAGE_KEY);
    if (raw === null) return DEFAULT_SOUND_PREFS;
    return decodeSoundPrefs(JSON.parse(raw));
  } catch {
    return DEFAULT_SOUND_PREFS;
  }
}

/** Persist the prefs. `quiet`: losing a setting costs the user one click. */
export function saveSoundPrefs(prefs: SoundPrefs): void {
  writeStorage('pref-sound', SOUND_STORAGE_KEY, JSON.stringify(prefs), { quiet: true });
}

/**
 * THE ORIGIN STORAGE BUDGET — one place that knows how much room there is and
 * how it divides.
 *
 * ## The defect this module exists to prevent
 *
 * Caleb imported two decks and they were gone on the next load. The mechanism:
 * `localStorage` is budgeted PER ORIGIN, and four features had each sized
 * themselves against the whole of it. The game library alone was allowed
 * 4,000,000 characters — more than the entire quota on the most conservative
 * real browser — while the saved decks, the in-progress game, the printing
 * caches and the bug-report clips shared the same pot. When the origin filled,
 * the NEWEST write was the one that failed, and that write was the deck import.
 *
 * Four consumers each sized against "5 MB" will always overcommit. So the
 * budget is owned HERE, once, as a TABLE of shares, and every consumer asks
 * this module how much room it has instead of carrying its own literal
 * (CLAUDE.md rule 2: adding a consumer is a ROW, and rule 12: one answer to one
 * question).
 *
 * ## Why the budget number is deliberately pessimistic
 *
 * Browsers do not agree, and none of them tell you. Chrome and Firefox allow
 * roughly 5,000,000 UTF-16 characters per origin; Safari and several mobile
 * WebViews enforce 5 MB as ~2,500,000 characters. We assume the FLOOR, because
 * the two ways of being wrong are not symmetric: assuming too little costs the
 * user storage they were never going to notice, and assuming too much costs the
 * user their decks.
 *
 * ## Read ceilings are NOT budgets — and lowering a cap must not eat data
 *
 * `PLAY_HISTORY_MAX_CHARS` / `PLAY_PERSIST_MAX_CHARS` in `config.ts` stay what
 * they were: parse-sanity ceilings that refuse to DECODE an absurd blob. They
 * are intentionally larger than the write budgets here. If the read ceiling
 * were lowered to the new, much smaller write budget, then the first load after
 * this change would refuse the game library already on disk and report it as
 * empty — silently destroying the very thing this module was written to stop
 * destroying. Writes shed down to the budget; reads accept what is already
 * there.
 */
import {
  ACTIVE_DECK_STORAGE_KEY,
  COPILOT_STORAGE_KEY,
  DECKS_STORAGE_KEY,
  IMPORTED_CARDS_STORAGE_KEY,
  MANA_CHOICE_STORAGE_KEY,
  PLAY_HISTORY_STORAGE_KEY,
  PLAY_RESUME_STORAGE_KEY,
  PRIORITY_STOPS_STORAGE_KEY,
  SERVER_URL_STORAGE_KEY,
  SOUND_STORAGE_KEY,
  SUGGESTION_HISTORY_KEY_PREFIX,
  UNSUPPORTED_MECHANICS_STORAGE_KEY,
  UPDATE_RESUME_FLAG_KEY,
} from '../config.js';
import {
  PROXY_CACHE_STORAGE_KEY,
  PROXY_OVERRIDES_STORAGE_KEY,
  PROXY_PRINTS_CACHE_STORAGE_KEY,
} from '../proxy/config.js';
import { CATALOG_STORAGE_KEY } from '../scan/config.js';

/**
 * The characters we assume one origin gets. See the module doc for why this is
 * the pessimistic floor rather than Chrome's real number.
 */
export const ORIGIN_STORAGE_BUDGET_CHARS = 2_500_000;

/**
 * The share of the origin deliberately left unallocated.
 *
 * A budget whose rows sum to 100% is not a budget: the last consumer to write
 * still fails, which is exactly the failure being fixed. This slack also
 * absorbs what no row can size — key names themselves, per-entry overhead, and
 * anything a browser extension or a future feature drops on the origin before
 * it has a row here.
 */
export const STORAGE_BUDGET_HEADROOM_SHARE = 0.15;

/** Which Web Storage a row lives in. Session storage has its own, separate quota. */
export type StorageScope = 'local' | 'session';

/**
 * What a row IS, which is what decides how the readout presents it and whether
 * clearing it is safe. Closed on purpose (rule 2): a new row picks one of these
 * or the union grows deliberately, rather than a string being invented at a
 * call site.
 */
export type StorageKind =
  /** Content the user authored. Losing it loses work — never auto-clearable. */
  | 'user-data'
  /** A game you could still return to. Losing it loses a session, not a deck. */
  | 'in-progress'
  /** Reviewable records of finished work. Nice to have; sheds under pressure. */
  | 'library'
  /** Re-fetchable or re-derivable. The first thing to clear when room is short. */
  | 'cache'
  /** A setting. Tiny, and losing it costs one checkbox. */
  | 'preference';

/** How a stored key is recognised as belonging to an area. */
export type StorageKeyMatch =
  | { readonly kind: 'exact'; readonly key: string }
  | { readonly kind: 'prefix'; readonly prefix: string };

/** One budgeted region of the origin's storage. */
export interface StorageArea {
  /**
   * Typed as `string`, not `StorageAreaId`: the id UNION is derived from this
   * table, so naming it here would make the table's type reference itself.
   * `STORAGE_AREAS` is declared `satisfies readonly StorageArea[]`, which keeps
   * every row structurally checked while leaving the literal ids inferrable.
   */
  readonly id: string;
  /** What the storage readout calls it, in the user's words. */
  readonly label: string;
  readonly match: StorageKeyMatch;
  readonly scope: StorageScope;
  readonly kind: StorageKind;
  /**
   * Fraction of {@link ORIGIN_STORAGE_BUDGET_CHARS} this area may occupy.
   * Local-scope shares plus {@link STORAGE_BUDGET_HEADROOM_SHARE} must not
   * exceed 1 — `budget.test.ts` fails the suite if a new row breaks that.
   */
  readonly share: number;
  /** Whether the storage readout offers the user a button to wipe this area. */
  readonly clearable: boolean;
  /** One line the readout shows, explaining what is in here and what clearing costs. */
  readonly why: string;
}

/**
 * THE TABLE. Every key this app writes to Web Storage has a row, and the write
 * funnel refuses a key with no row — a closed table that reports an unknown
 * value honestly rather than widening to the nearest thing that exists.
 */
export const STORAGE_AREAS = [
  {
    id: 'decks',
    label: 'Saved decks',
    match: { kind: 'exact', key: DECKS_STORAGE_KEY },
    scope: 'local',
    kind: 'user-data',
    share: 0.2,
    clearable: false,
    why: 'Every deck you have built or imported. This is the one thing here that cannot be rebuilt.',
  },
  {
    id: 'active-deck',
    label: 'Selected deck',
    match: { kind: 'exact', key: ACTIVE_DECK_STORAGE_KEY },
    scope: 'local',
    kind: 'preference',
    share: 0.002,
    clearable: false,
    why: 'Which deck the builder opens on.',
  },
  {
    id: 'play-in-progress',
    label: 'Game in progress',
    match: { kind: 'exact', key: PLAY_RESUME_STORAGE_KEY },
    scope: 'local',
    kind: 'in-progress',
    share: 0.1,
    clearable: true,
    why: 'The one game you can resume. Clearing it abandons that game; your decks are untouched.',
  },
  {
    id: 'play-history',
    label: 'Game library',
    match: { kind: 'exact', key: PLAY_HISTORY_STORAGE_KEY },
    scope: 'local',
    kind: 'library',
    share: 0.16,
    clearable: true,
    why: 'Games you have finished, kept for review and forking. Old finished games are dropped automatically when this fills.',
  },
  {
    id: 'imported-cards',
    label: 'Imported cards',
    match: { kind: 'exact', key: IMPORTED_CARDS_STORAGE_KEY },
    scope: 'local',
    kind: 'user-data',
    share: 0.1,
    clearable: true,
    why: 'Cards you pulled in from Scryfall that are not in the bundled pool. Clearing means re-importing them.',
  },
  {
    id: 'proxy-cache',
    label: 'Proxy sheet cache',
    match: { kind: 'exact', key: PROXY_CACHE_STORAGE_KEY },
    scope: 'local',
    kind: 'cache',
    share: 0.05,
    clearable: true,
    why: 'Print-quality images already fetched. Safe to clear — they come back from Scryfall.',
  },
  {
    id: 'proxy-prints',
    label: 'Printing lookups',
    match: { kind: 'exact', key: PROXY_PRINTS_CACHE_STORAGE_KEY },
    scope: 'local',
    kind: 'cache',
    share: 0.05,
    clearable: true,
    why: 'The alternate-art lists behind the printing picker. Safe to clear — refetched on demand.',
  },
  {
    id: 'proxy-overrides',
    label: 'Proxy art choices',
    match: { kind: 'exact', key: PROXY_OVERRIDES_STORAGE_KEY },
    scope: 'local',
    kind: 'user-data',
    share: 0.02,
    clearable: true,
    why: 'Art you picked by hand for a proxy sheet. Clearing goes back to the default printings.',
  },
  {
    id: 'card-name-catalog',
    label: 'Card-name catalog',
    match: { kind: 'exact', key: CATALOG_STORAGE_KEY },
    scope: 'local',
    kind: 'cache',
    share: 0.06,
    clearable: true,
    why: 'The name list the decklist scanner matches against. Safe to clear — rebuilt on the next scan.',
  },
  {
    id: 'suggestion-history',
    label: 'Lab tuning memory',
    match: { kind: 'prefix', prefix: SUGGESTION_HISTORY_KEY_PREFIX },
    scope: 'local',
    kind: 'library',
    share: 0.06,
    clearable: true,
    why: 'What the Lab has already learned about each deck. Clearing makes the next run start its search over.',
  },
  {
    id: 'unsupported-mechanics',
    label: 'Unsupported-mechanic queue',
    match: { kind: 'exact', key: UNSUPPORTED_MECHANICS_STORAGE_KEY },
    scope: 'local',
    kind: 'library',
    share: 0.02,
    clearable: true,
    why: 'The engine gaps you have run into, listed on the About page. Safe to clear.',
  },
  {
    id: 'pref-mana-choice',
    label: 'Mana-payment preference',
    match: { kind: 'exact', key: MANA_CHOICE_STORAGE_KEY },
    scope: 'local',
    kind: 'preference',
    share: 0.001,
    clearable: false,
    why: 'Whether you are asked which lands pay a cost.',
  },
  {
    id: 'pref-copilot',
    label: 'Co-pilot preference',
    match: { kind: 'exact', key: COPILOT_STORAGE_KEY },
    scope: 'local',
    kind: 'preference',
    share: 0.001,
    clearable: false,
    why: 'Whether the AI suggests your plays.',
  },
  {
    id: 'pref-priority-stops',
    label: 'Priority stops',
    match: { kind: 'exact', key: PRIORITY_STOPS_STORAGE_KEY },
    scope: 'local',
    kind: 'preference',
    share: 0.001,
    clearable: false,
    why: 'Which steps the game pauses in for you.',
  },
  {
    id: 'pref-sound',
    label: 'Sound settings',
    match: { kind: 'exact', key: SOUND_STORAGE_KEY },
    scope: 'local',
    kind: 'preference',
    share: 0.001,
    clearable: false,
    why: 'Audio on/off and volume.',
  },
  {
    id: 'online-server-url',
    label: 'Online server address',
    match: { kind: 'exact', key: SERVER_URL_STORAGE_KEY },
    scope: 'local',
    kind: 'preference',
    share: 0.001,
    clearable: false,
    why: 'Where online play connects.',
  },
  {
    id: 'update-resume',
    label: 'Update-resume flag',
    match: { kind: 'exact', key: UPDATE_RESUME_FLAG_KEY },
    // sessionStorage, NOT localStorage: per-tab, its own quota, and therefore
    // deliberately outside the origin budget this module divides up.
    scope: 'session',
    kind: 'preference',
    share: 0.001,
    clearable: false,
    why: 'Remembers where you were across an app update. Per-tab, and cleared on the next launch.',
  },
] as const satisfies readonly StorageArea[];

/** The id of one row in {@link STORAGE_AREAS}. */
export type StorageAreaId = (typeof STORAGE_AREAS)[number]['id'];

const AREAS_BY_ID = new Map<string, StorageArea>(STORAGE_AREAS.map((area) => [area.id, area]));

/** The row with this id, or null. Null is an honest answer, not a default. */
export function storageArea(id: string): StorageArea | null {
  return AREAS_BY_ID.get(id) ?? null;
}

/**
 * How many characters this area may write. The ONLY source of a size cap in the
 * app — a consumer with its own literal is the defect this module replaces.
 */
export function writeBudgetChars(id: StorageAreaId): number {
  const area = storageArea(id);
  if (area === null) return 0;
  return Math.floor(ORIGIN_STORAGE_BUDGET_CHARS * area.share);
}

/**
 * The row a stored key belongs to, or null when nothing claims it.
 *
 * Exact matches win over prefix matches, so a future exact row inside a
 * prefixed family is not shadowed by the family. Longest prefix wins among
 * prefixes for the same reason.
 */
export function areaForKey(key: string): StorageArea | null {
  let best: StorageArea | null = null;
  for (const area of STORAGE_AREAS) {
    if (area.match.kind === 'exact') {
      if (area.match.key === key) return area;
    } else if (key.startsWith(area.match.prefix)) {
      if (best === null || best.match.kind === 'exact') best = area;
      else if (area.match.prefix.length > best.match.prefix.length) best = area;
    }
  }
  return best;
}

/** Total share claimed by localStorage rows — the number the budget test pins. */
export function allocatedLocalShare(): number {
  return STORAGE_AREAS.filter((a) => a.scope === 'local').reduce((sum, a) => sum + a.share, 0);
}

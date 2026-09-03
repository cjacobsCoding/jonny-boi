/**
 * `state_dump.txt` — the machine-readable half of a bug report.
 *
 * A REGISTRY, not a hardcoded list (CLAUDE.md rule 3, and the "integrate through
 * seams" discipline). Any surface that has state worth seeing registers a named
 * section and the reporter picks it up; nothing here has to learn about the Lab,
 * the deck builder or the online room, and adding a feature's state to every
 * future bug report is one `registerStateSection` call rather than an edit here.
 * That is exactly how the two C++ games do it — their dump is every section
 * registered with the debug menu — which is also why their dumps never go stale.
 *
 * The built-in sections (environment, storage, build) are the ones no feature
 * owns but every report needs.
 */
import { buildInfo } from './build-info.js';

/** Returns this section's body. Must not throw; see `collectStateDump`. */
export type StateSection = () => string;

const sections = new Map<string, StateSection>();

/**
 * Register a named section. Returns an unregister function, so a React effect can
 * clean up and a remounted view cannot register twice.
 */
export function registerStateSection(name: string, section: StateSection): () => void {
  sections.set(name, section);
  return () => {
    // Only remove it if it is still OURS: a remount that registered a new closure
    // under the same name must not have its section deleted by the old effect's
    // cleanup, which runs afterwards.
    if (sections.get(name) === section) sections.delete(name);
  };
}

/** How many characters of one localStorage value the dump will carry. */
const MAX_STORAGE_VALUE_CHARS = 400;

/**
 * How many characters of one localStorage KEY the dump will carry (§3.119).
 *
 * Measured on the reporter's own machine while chasing bug report
 * 20260902_231525: localStorage held 64 keys totalling 1,579 KB, of which 57
 * were `jonny-boi.suggest-history.v1…` keys totalling 1,451 KB — and each of
 * those keys embeds the ENTIRE decklist, the longest running to 662
 * characters. Printing them whole made 38 KB of the dump keys alone, and the
 * dump is the part of a report a human is supposed to read. The prefix
 * identifies the key; the tail is a deck fingerprint nobody reads by eye.
 *
 * ⚠️ The keys themselves are the real defect and are NOT fixed here — see the
 * COORDINATION note and §3.119: `suggestionHistoryKey` should hash the deck
 * into a short digest and the store should cap how many it keeps. This only
 * stops one unbounded thing from swallowing the report about it.
 */
const MAX_STORAGE_KEY_CHARS = 80;

function environmentSection(): string {
  const lines: string[] = [];
  lines.push(`user_agent ${navigator.userAgent}`);
  lines.push(`language ${navigator.language}`);
  lines.push(`online ${navigator.onLine}`);
  lines.push(`viewport ${window.innerWidth}x${window.innerHeight}`);
  lines.push(`screen ${window.screen.width}x${window.screen.height}`);
  lines.push(`device_pixel_ratio ${window.devicePixelRatio}`);
  // Whether this is the installed PWA or a browser tab changes which bugs are
  // even possible (service-worker staleness, no address bar, different viewport).
  const standalone = window.matchMedia('(display-mode: standalone)').matches;
  lines.push(`display_mode ${standalone ? 'standalone (installed PWA)' : 'browser'}`);
  lines.push(`url ${window.location.href}`);
  lines.push(`service_worker ${'serviceWorker' in navigator ? 'supported' : 'unsupported'}`);
  return lines.join('\n');
}

/** One key, elided in the middle so both its prefix and its version survive. */
export function shortenStorageKey(key: string, max: number = MAX_STORAGE_KEY_CHARS): string {
  if (key.length <= max) return key;
  // Keep the head (which names the feature) and a little of the tail, so two
  // long keys of the same feature are still distinguishable in the dump.
  const tail = 8;
  const head = max - tail - 1;
  return `${key.slice(0, head)}…${key.slice(-tail)}`;
}

function storageSection(): string {
  const lines: string[] = [];
  try {
    let totalChars = 0;
    for (let i = 0; i < window.localStorage.length; i += 1) {
      const key = window.localStorage.key(i);
      if (key === null) continue;
      const value = window.localStorage.getItem(key) ?? '';
      totalChars += key.length + value.length;
      // Size ALWAYS, value only when it is small enough to read. A saved deck
      // list or the imported-card cache would otherwise bury the dump — and so
      // would a long KEY, which is why the key is elided too (§3.119).
      lines.push(`${shortenStorageKey(key)} (${value.length} chars)`);
      if (value.length <= MAX_STORAGE_VALUE_CHARS) {
        lines.push(`  = ${value}`);
      }
    }
    // The TOTAL, said out loud: 1.5 MB across 64 keys is a defect in its own
    // right, and a dump that lists keys without ever adding them up is how it
    // went unnoticed for as long as it did.
    lines.push(`total ${window.localStorage.length} key(s), ${totalChars} chars`);
  } catch (error) {
    // Private-browsing modes can throw on localStorage access. Say so; do not
    // fail the report over it.
    lines.push(`localStorage unavailable: ${String(error)}`);
  }
  return lines.length > 0 ? lines.join('\n') : '(empty)';
}

function buildSection(): string {
  const info = buildInfo();
  return [`commit ${info.commit}`, `built_at ${info.builtAt}`, `mode ${info.mode}`].join('\n');
}

/**
 * Render the whole dump: the built-in sections, then every registered one, in
 * registration order.
 *
 * A section that THROWS is reported as a broken section and the rest of the dump
 * is still produced. The alternative — one bad getter losing the entire dump — is
 * the failure mode that makes a person stop trusting the tool.
 */
export function collectStateDump(): string {
  const parts: string[] = [];
  const builtIn: ReadonlyArray<readonly [string, StateSection]> = [
    ['build', buildSection],
    ['environment', environmentSection],
    ['storage', storageSection],
  ];

  for (const [name, section] of [...builtIn, ...sections]) {
    parts.push(`# --- ${name} ---`);
    try {
      parts.push(section());
    } catch (error) {
      parts.push(`(section threw: ${String(error)})`);
    }
  }
  parts.push(`# --- ${builtIn.length + sections.size} section(s) ---`);
  return `${parts.join('\n')}\n`;
}

/** For tests and the reporter's own panel: how many sections would be written. */
export function registeredSectionNames(): string[] {
  return [...sections.keys()];
}

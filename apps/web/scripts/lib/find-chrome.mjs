/**
 * ONE answer to "where is a Chrome I can drive?" for every browser harness under
 * `apps/web/scripts/verify-*.mjs` (§3.127).
 *
 * Each harness used to carry its own copy of a Windows-only candidate list. That
 * was a DRY debt with a concrete cost: none of them could start on a Linux CI
 * runner, which is exactly why the layout harness was never run automatically
 * and its guarantees drifted for three days (§3.126). The lookup is now a TABLE
 * keyed by platform plus two env overrides, read by every harness — adding a
 * browser or a platform is a row here, understood by all of them at once.
 *
 * Order of preference, most explicit first:
 *  1. `CHROME_PATH` / `PUPPETEER_EXECUTABLE_PATH` — whoever set it knows best.
 *  2. Well-known install locations for the current platform.
 *  3. A bare executable name on PATH (GitHub's Ubuntu runners expose
 *     `google-chrome` this way).
 *
 * Pure with respect to the file system except for existence checks; never
 * throws. A miss returns `null` and {@link describeChromeSearch} says exactly
 * what was tried, so a harness can fail with a useful message instead of a
 * stack trace from puppeteer.
 */
import { existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';

/** Env vars that name the executable outright. */
const ENV_OVERRIDES = Object.freeze(['CHROME_PATH', 'PUPPETEER_EXECUTABLE_PATH']);

/** Bare names looked up on PATH, in order. */
const PATH_NAMES = Object.freeze({
  win32: ['chrome.exe', 'msedge.exe'],
  darwin: ['google-chrome', 'chromium'],
  linux: ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge'],
});

/** Well-known install locations per platform. Functions so env is read lazily. */
const KNOWN_LOCATIONS = Object.freeze({
  win32: () => [
    `${process.env.ProgramFiles}\\Google\\Chrome\\Application\\chrome.exe`,
    `${process.env['ProgramFiles(x86)']}\\Google\\Chrome\\Application\\chrome.exe`,
    `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`,
    `${process.env.ProgramFiles}\\Microsoft\\Edge\\Application\\msedge.exe`,
    `${process.env['ProgramFiles(x86)']}\\Microsoft\\Edge\\Application\\msedge.exe`,
  ],
  darwin: () => [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  ],
  linux: () => [
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/microsoft-edge',
    '/snap/bin/chromium',
  ],
});

/** Every path considered, in the order it is considered. */
function candidates(platform = process.platform) {
  const fromEnv = ENV_OVERRIDES.map((name) => process.env[name]).filter((p) => typeof p === 'string' && p !== '');
  const known = (KNOWN_LOCATIONS[platform] ?? KNOWN_LOCATIONS.linux)();
  const names = PATH_NAMES[platform] ?? PATH_NAMES.linux;
  const dirs = (process.env.PATH ?? '').split(delimiter).filter(Boolean);
  const onPath = [];
  for (const name of names) for (const dir of dirs) onPath.push(join(dir, name));
  return [...fromEnv, ...known, ...onPath];
}

/** The first Chrome/Edge/Chromium executable that exists, or `null`. */
export function findChrome(platform = process.platform) {
  return candidates(platform).find((p) => p && safeExists(p)) ?? null;
}

/** A human-readable account of the search, for the failure message. */
export function describeChromeSearch(platform = process.platform) {
  const list = candidates(platform);
  // PATH expansions are many and repetitive; show the explicit ones and summarise the rest.
  const explicit = list.filter((p) => !/[\\/](chrome|msedge|google-chrome|google-chrome-stable|chromium|chromium-browser|microsoft-edge)(\.exe)?$/.test(p) || /Program Files|Applications|^\/usr|^\/snap/.test(p));
  return [
    `No Chrome, Edge or Chromium found for ${platform}.`,
    `Set ${ENV_OVERRIDES.join(' or ')} to the executable, or install one of:`,
    ...explicit.map((p) => `  ${p}`),
    `  (or any of ${(PATH_NAMES[platform] ?? PATH_NAMES.linux).join(', ')} on PATH)`,
  ].join('\n');
}

function safeExists(p) {
  try {
    return existsSync(p);
  } catch {
    return false;
  }
}

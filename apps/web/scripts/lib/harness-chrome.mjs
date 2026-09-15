/**
 * ONE Chrome launch for every browser harness — quiet, unfocused, and muted.
 *
 * ## Why this file exists
 * Caleb, 2026-09-14: *"when running game tests, they dont show up and take focus
 * and are muted audio-wise? So they dont conflict with real things that Im
 * working on"*. The harnesses drive a REAL browser running the REAL game, and
 * the game plays sounds — so a verification run was audible over whatever the
 * machine was actually doing.
 *
 * Before this, five harnesses hand-rolled five different argument lists:
 *
 *   board-fits        --no-sandbox --window-size=…
 *   bug-reporter      --no-sandbox --disable-dev-shm-usage
 *   combat-visibility --no-sandbox --window-size=…
 *   game-resume       --no-first-run --disable-features=Translate
 *   mana-choice       --no-first-run --disable-features=Translate
 *
 * Five answers to one question, and **not one of them muted the audio** (rule
 * 12). Adding `--mute-audio` in five places would have been the same mistake a
 * sixth time, so the launch itself is the single funnel and
 * `harness-chrome-launch.test.ts` fails if a harness stops using it.
 *
 * ## What this does NOT touch, deliberately
 * Nothing here reaches the app, the dev server, the build, or the game's own
 * sound code. `npm run dev`, `npm run build` and a hand-played game are byte-for
 * -byte unaffected — the flags below are passed to the browser the HARNESS
 * spawns and to nothing else. Muting a harness must never mute the game.
 */

/**
 * Flags every harness browser gets, each with the reason it is here.
 *
 * A CLOSED list: a harness that needs something else passes it through `extra`
 * at its call site, where the reason is local and visible, rather than widening
 * this list for everyone.
 */
export const HARNESS_CHROME_ARGS = Object.freeze([
  // THE ONE CALEB ASKED FOR. The harnesses play real games, and a real game
  // makes noise (`useGameSounds` feeds an unlocked AudioContext). Muting is
  // done at the BROWSER, not by reaching into the app's sound settings, so the
  // game's own audio behaviour is exercised exactly as a player gets it — the
  // harness simply does not let the machine hear it.
  '--mute-audio',
  // No sandbox / no shm growth: the long-standing needs of this box, previously
  // set by only some of the five.
  '--no-sandbox',
  '--disable-dev-shm-usage',
  // Nothing that opens UI of its own: a first-run tab, a default-browser prompt
  // or a translate bar are all windows that can steal focus even from an
  // otherwise headless run.
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-features=Translate',
  // Windows headless is measurably steadier without the GPU path, and no
  // harness asserts anything that needs it.
  '--disable-gpu',
]);

/**
 * Build the `puppeteer.launch` options for a harness.
 *
 * `headful` is an explicit, per-harness opt-in (today only
 * `verify-bug-reporter.mjs --headful`, which exists so a human can watch the
 * reporter work). It stays supported and stays MUTED: wanting to see a window
 * is not the same as wanting to hear it.
 *
 * @param {object} opts
 * @param {string} opts.chromePath        resolved by `find-chrome.mjs`
 * @param {boolean} [opts.headful]        show a real window (opt-in only)
 * @param {{width:number,height:number}} [opts.windowSize] sets `--window-size`
 * @param {{width:number,height:number}} [opts.viewport]   puppeteer defaultViewport
 * @param {readonly string[]} [opts.extra] harness-specific flags, reasoned locally
 * @param {number} [opts.protocolTimeoutMs] ceiling for ONE DevTools call
 *
 * ## `protocolTimeoutMs` — opt-in, and why it exists
 *
 * Puppeteer gives every DevTools protocol call an UNNAMED 180 s default, and
 * `verify-card-browser-perf.mjs` hit it: rasterising the pre-virtualisation
 * card browser at 375px — 5,651 tiles with 5,651 images — made a single
 * `Page.captureScreenshot` exceed it, and the harness reported "could not run"
 * against an app that was merely very slow. That is the same shape
 * `harness-wait-budgets.test.ts` was written for: a number nobody chose,
 * deciding whether a measurement succeeds.
 *
 * It is OPT-IN rather than a new default because raising a ceiling turns a fast
 * failure into a slow one, and the other harnesses drive a play surface of
 * about twenty cards where 180 s already means "hung". A harness that measures
 * something deliberately enormous passes its own budget, with its own reason.
 */
export function harnessLaunchOptions({
  chromePath,
  headful = false,
  windowSize,
  viewport,
  extra = [],
  protocolTimeoutMs,
}) {
  const args = [...HARNESS_CHROME_ARGS];
  if (windowSize) args.push(`--window-size=${windowSize.width},${windowSize.height}`);
  args.push(...extra);
  return {
    executablePath: chromePath,
    // `'new'` rather than `true`: the old headless is deprecated and drifts from
    // the real browser, which is the one thing a harness must not do.
    headless: headful ? false : 'new',
    ...(viewport ? { defaultViewport: viewport } : {}),
    ...(protocolTimeoutMs === undefined ? {} : { protocolTimeout: protocolTimeoutMs }),
    args,
  };
}

#!/usr/bin/env node
/**
 * Drive the BUILT app in a real Chrome and prove that a BUILT-IN gauntlet deck
 * can no longer be mistaken for one of the user's own.
 *
 * ## Why a browser harness and not only unit tests
 *
 * The defect was a LOOK. A user copied the built-in "Selesnya Blink", renamed his
 * copy to "Acidic Angels", saw the untouched built-in still sitting in the same
 * column in an identical box, and reported that the app had duplicated a deck. No
 * test in the repo could see that, because the markup was perfectly correct — the
 * two kinds of deck simply rendered the same. `builtin-deck-identity.test.ts`
 * pins what the markup SAYS; only a real engine can say what it PAINTS, so the
 * checks below are computed-style measurements, not inferences from the CSS.
 *
 * ## It reproduces the user's actions, it does not fake them
 *
 * The copy is made by clicking "Copy to my decks" and renamed through the real
 * name field — no seeded localStorage, so the provenance under test is the one
 * the app actually writes.
 *
 * ## What it checks
 *
 *   1. BOTH KINDS ARE ON SCREEN AT ONCE — a user deck and the built-ins, in one
 *      view, which is the situation the report was filed about.
 *   2. THEY DO NOT LOOK THE SAME — the built-in row's border style and background
 *      differ from a saved deck row's, measured from `getComputedStyle`.
 *   3. THE BUILT-IN IS BADGED — a visible, non-zero-sized "Built-in" badge.
 *   4. THE COPY IS REPORTED — the built-in the user copied says so and names the
 *      RENAMED copy, and no longer dangles "Copy to my decks".
 *   5. THE PLAY SETUP AGREES — its deck picker groups the two kinds under named
 *      <optgroup>s, and the built-in options are still SELECTABLE (playing one
 *      directly is a deliberate feature; this is about identity, not access).
 *   6. A PHONE FITS TOO — 375x812, with no horizontal page scroll.
 *
 * Screenshots land in verify-out/deck-identity/ inside the worktree.
 * Exit 0 = every check passed; 1 = a check failed; 2 = could not run.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import { findChrome } from './lib/find-chrome.mjs';
import { harnessLaunchOptions } from './lib/harness-chrome.mjs';
import { watchPageErrors } from './lib/harness-page.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = resolve(HERE, '..');
const OUT_DIR = resolve(WEB_ROOT, 'verify-out', 'deck-identity');

/**
 * The app's update-resume flag key, mirrored from `apps/web/src/lib/config.ts`.
 * A harness is a plain .mjs and cannot import the TS module; a stale copy would
 * silently stop opening the builder directly, so the boot time logged below is
 * the tell — it jumps back to a double mount.
 */
const UPDATE_RESUME_FLAG_KEY = 'jonny-boi.update.resume.v1';

/** The built-in deck named in the report, and what the user renamed his copy to. */
const BUILTIN_DECK = 'Selesnya Blink';
const RENAMED_COPY = 'Acidic Angels';

/**
 * The widths that matter. `desktop` is where the builder's two-column layout is
 * authored; `phone` is the PWA's actual home and the width DECKBUILDER-AND-ART.md
 * flags as the builder's weakest, so a change here has to be checked there.
 */
const VIEWPORTS = Object.freeze({
  desktop: { width: 1440, height: 1100 },
  phone: { width: 375, height: 812 },
});

/**
 * Budgets. 90 s for the app shell matches every other harness in this directory:
 * the landing view fetches hundreds of cross-origin card images, and time-to-shell
 * is bimodal (~8 s warm, ~39 s cold), so a tighter budget reports the APP as
 * broken when the NETWORK is slow. 20 s for in-app transitions, which touch no
 * network.
 */
const APP_SHELL_WAIT_MS = 90_000;
const UI_TRANSITION_WAIT_MS = 20_000;
/** Long enough for card art to settle so a capture is not a half-painted frame. */
const PAINT_SETTLE_MS = 1_200;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const failures = [];
/** Record one check. Named so a failure reads as a sentence in the log. */
function check(ok, label, detail) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(label);
  return ok;
}

async function freePort() {
  const net = await import('node:net');
  return new Promise((res, rej) => {
    const s = net.createServer();
    s.on('error', rej);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => res(port));
    });
  });
}

async function isUp(url) {
  try {
    return (await fetch(url, { signal: AbortSignal.timeout(2000) })).status > 0;
  } catch {
    return false;
  }
}

/** Serve the BUILT app — this harness must never test a dev-only code path. */
async function startPreview() {
  const port = await freePort();
  const url = `http://localhost:${port}/`;
  const vite = [
    resolve(WEB_ROOT, '..', '..', 'node_modules', 'vite', 'bin', 'vite.js'),
    resolve(WEB_ROOT, 'node_modules', 'vite', 'bin', 'vite.js'),
  ].find((c) => existsSync(c));
  if (!vite) throw new Error('vite not found — run npm install');
  if (!existsSync(resolve(WEB_ROOT, 'dist', 'index.html'))) {
    throw new Error('apps/web/dist is missing — run npm run build first');
  }
  const child = spawn(
    process.execPath,
    [vite, 'preview', '--port', String(port), '--strictPort'],
    { cwd: WEB_ROOT, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (await isUp(url)) return { child, url };
    await sleep(300);
  }
  child.kill();
  throw new Error('vite preview did not answer');
}

async function shot(page, name) {
  mkdirSync(OUT_DIR, { recursive: true });
  const path = resolve(OUT_DIR, name);
  await page.screenshot({ path, fullPage: false });
  console.log(`  shot ${name}`);
  return path;
}

/**
 * Click an element by its text, WITHOUT calling `.click()` inside `evaluate`.
 *
 * ⚠️ The distinction is load-bearing here. `page.evaluate(() => btn.click())`
 * does not return until the page's main thread is free again — and opening the
 * Deck Builder mounts a grid of every card in the pool (6,000+ tiles), which
 * blocks that thread long enough to blow puppeteer's CDP `protocolTimeout` and
 * kill the run with `Runtime.callFunctionOn timed out`. Tagging the element and
 * using `page.click` dispatches a real input event and returns immediately, so
 * the render happens while the harness WAITS rather than while it is blocked.
 *
 * @param {string} selector CSS scope to search within (e.g. 'button.nav-link')
 */
let tagSeq = 0;
async function clickByText(page, text, selector = 'button') {
  const id = `harness-target-${++tagSeq}`;
  const tagged = await page.evaluate(
    (t, sel, tagId) => {
      const el = [...document.querySelectorAll(sel)].find(
        (b) => (b.textContent ?? '').trim() === t,
      );
      if (!el) return false;
      el.id = tagId;
      return true;
    },
    text,
    selector,
    id,
  );
  if (!tagged) return false;
  await page.click(`#${id}`);
  return true;
}

/** Open a top-level view by its nav label. */
async function openView(page, label) {
  if (!(await clickByText(page, label, 'button.nav-link'))) {
    throw new Error(`nav tab "${label}" not found`);
  }
}

/**
 * Type into a React CONTROLLED input. Setting `.value` directly is swallowed —
 * React's own value tracker sees no change and never fires onChange — so the
 * native setter has to be called before dispatching the event.
 */
async function setControlledInput(page, selector, value) {
  return page.evaluate(
    (sel, val) => {
      const el = document.querySelector(sel);
      if (!el) return false;
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        'value',
      )?.set;
      setter?.call(el, val);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    },
    selector,
    value,
  );
}

/**
 * Scroll the deck panel so a region sits at the TOP of its scrollport, and
 * report which of the two kinds of deck row are then actually IN THE VIEWPORT.
 *
 * ⚠️ "Both kinds are on screen together" is the whole claim of this fix, and the
 * first version of this harness checked it by asking the DOM whether both
 * existed. They always do — the deck panel scrolls, so one can sit 600px below
 * the fold while the check reports a pass and the screenshot shows one kind.
 * Presence is not visibility, and only visibility is the thing a user compares.
 */
async function frameAndMeasureVisibility(page, anchorSelector) {
  return page.evaluate((sel) => {
    const anchor = document.querySelector(sel);
    anchor?.scrollIntoView({ block: 'start' });
    // `scrollIntoView({block:'start'})` aligns to the scrollport's top, which on
    // a phone is UNDERNEATH the sticky header — so the region's own heading ends
    // up hidden by it. Nudge back by the header's height, on whichever element
    // actually scrolls (the deck panel on desktop, the page on a phone).
    const stickyHeader = document.querySelector('.app__header');
    const headerBottom = stickyHeader ? stickyHeader.getBoundingClientRect().bottom : 0;
    if (anchor) {
      const scroller = (() => {
        for (let el = anchor.parentElement; el; el = el.parentElement) {
          const overflowY = getComputedStyle(el).overflowY;
          if (
            (overflowY === 'auto' || overflowY === 'scroll') &&
            el.scrollHeight > el.clientHeight
          ) {
            return el;
          }
        }
        return null;
      })();
      const gap = anchor.getBoundingClientRect().top - headerBottom - 8;
      if (gap < 0) {
        if (scroller) scroller.scrollTop += gap;
        else window.scrollBy(0, gap);
      }
    }
    // ⚠️ `top >= 0` is NOT visible. The app header is sticky, so anything in the
    // top ~55px is behind it — geometrically on screen and impossible to read.
    // Measured from the header itself rather than hardcoded, so a header that
    // changes height cannot quietly re-open the hole.
    const occluded = headerBottom;
    const visible = (el) => {
      if (!el) return false;
      const r = el.getBoundingClientRect();
      return (
        r.top >= occluded &&
        r.left >= 0 &&
        r.bottom <= window.innerHeight &&
        r.right <= window.innerWidth &&
        r.width > 0 &&
        r.height > 0
      );
    };
    return {
      savedVisible: [...document.querySelectorAll('.saved-deck')].filter(visible).length,
      builtinVisible: [...document.querySelectorAll('.builtin-deck')].filter(visible).length,
      yourDecksHeadingVisible: [...document.querySelectorAll('.section-label')]
        .filter((el) => (el.textContent ?? '').trim() === 'Your decks')
        .some(visible),
      builtinHeadingVisible: [...document.querySelectorAll('.section-label')]
        .filter((el) => (el.textContent ?? '').trim() === 'Built-in gauntlet decks')
        .some(visible),
    };
  }, anchorSelector);
}

/** Scroll one built-in deck's row into view by name, and say if it is visible. */
async function frameBuiltinRow(page, name) {
  return page.evaluate((deckName) => {
    const row = [...document.querySelectorAll('.builtin-deck')].find((el) =>
      (el.textContent ?? '').includes(deckName),
    );
    row?.scrollIntoView({ block: 'center' });
    if (!row) return { visible: false };
    const r = row.getBoundingClientRect();
    return {
      visible: r.top >= 0 && r.bottom <= window.innerHeight && r.height > 0,
      text: (row.textContent ?? '').trim(),
    };
  }, name);
}

/** Measure whether the two kinds of deck row actually PAINT differently. */
async function measureRows(page) {
  return page.evaluate((builtinName) => {
    const builtin = [...document.querySelectorAll('.builtin-deck')].find((el) =>
      (el.textContent ?? '').includes(builtinName),
    );
    const saved = document.querySelector('.saved-deck');
    const badge = builtin?.querySelector('.deck-origin-badge');
    const style = (el) => {
      if (!el) return null;
      const cs = getComputedStyle(el);
      return {
        borderStyle: cs.borderTopStyle,
        borderColor: cs.borderTopColor,
        background: cs.backgroundColor,
      };
    };
    const rect = (el) => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { w: Math.round(r.width), h: Math.round(r.height) };
    };
    return {
      builtinFound: !!builtin,
      savedFound: !!saved,
      builtinOrigin: builtin?.getAttribute('data-deck-origin') ?? null,
      savedOrigin: saved?.getAttribute('data-deck-origin') ?? null,
      builtinStyle: style(builtin),
      savedStyle: style(saved),
      badgeText: (badge?.textContent ?? '').trim(),
      badgeRect: rect(badge),
      builtinText: (builtin?.textContent ?? '').trim(),
      savedDeckNames: [...document.querySelectorAll('.saved-deck__name')].map((el) =>
        (el.textContent ?? '').trim(),
      ),
      copyButtonsStillOffered: [...document.querySelectorAll('.builtin-deck button')].filter(
        (b) => (b.textContent ?? '').trim() === 'Copy to my decks',
      ).length,
      builtinRowCount: document.querySelectorAll('.builtin-deck').length,
      pageScrollsX: document.documentElement.scrollWidth > window.innerWidth + 1,
    };
  }, BUILTIN_DECK);
}

/** Read the shape of the Play setup's deck picker. */
async function measurePicker(page) {
  return page.evaluate(() => {
    const select = document.querySelector('select[aria-label="Seat A deck"]');
    if (!select) return { found: false };
    const groups = [...select.querySelectorAll('optgroup')].map((g) => ({
      label: g.label,
      options: [...g.querySelectorAll('option')].map((o) => ({
        text: (o.textContent ?? '').trim(),
        origin: o.getAttribute('data-deck-origin'),
        disabled: o.disabled,
      })),
    }));
    const note = document.querySelector('.deck-origin-note');
    return {
      found: true,
      groups,
      ungroupedOptions: [...select.children].filter((c) => c.tagName === 'OPTION').length,
      noteText: note ? (note.textContent ?? '').trim() : null,
      pageScrollsX: document.documentElement.scrollWidth > window.innerWidth + 1,
    };
  });
}

let preview;
let browser;
try {
  preview = await startPreview();
  const launchOptions = harnessLaunchOptions({
    chromePath: findChrome(),
    windowSize: VIEWPORTS.desktop,
  });
  // Every CDP round trip waits behind the page's main thread, and this app's
  // heaviest mount (the full card grid) can hold it for the better part of a
  // minute on a cold cache. Set on the object the shared builder returns rather
  // than on an inline launch object — `harness-chrome-launch.test.ts` forbids
  // the latter, because that is how five harnesses came to launch five ways.
  launchOptions.protocolTimeout = 240_000;
  browser = await puppeteer.launch(launchOptions);
} catch (error) {
  console.error('could not start the harness:', error.message);
  process.exit(2);
}

try {
  for (const [label, viewport] of Object.entries(VIEWPORTS)) {
    console.log(`\n== ${label} ${viewport.width}x${viewport.height} ==`);
    const page = await browser.newPage();
    const watcher = watchPageErrors(page, { label });
    await page.setViewport(viewport);
    // ⚠️ Each viewport must start from a FRESH app, not from what the previous
    // pass left behind. Pages of one browser share an origin's localStorage, so
    // the first run's saved decks were still there for the second — which made
    // the phone pass silently skip the copy flow (Selesnya Blink already read
    // "Already copied") while every later assertion still passed off the leaked
    // state. A pass that cannot perform the action it claims to test is not a
    // pass. Runs before any app script, so the hook sees empty storage on boot.
    await page.evaluateOnNewDocument(
      (resumeKey) => {
        try {
          localStorage.clear();
          // BOOT STRAIGHT INTO THE DECK BUILDER, via the app's own update-resume
          // flag (`lib/update/updater.ts`) — a shipped path, not a test hook.
          //
          // ⚠️ Why this is not merely a speed-up. Landing on the card browser and
          // then clicking through mounts the full card pool TWICE — 6,000+ tiles
          // for the browser, then again for the builder's own pool grid — and the
          // second mount is queued behind the first on one main thread. Measured
          // on this box that overran a 90 s budget in 3 of 4 runs while passing
          // in the fourth: a harness that reports the FIX as missing when the
          // MACHINE is busy is worse than no harness, because its red means
          // nothing. One heavy mount is the whole difference.
          sessionStorage.setItem(
            resumeKey,
            JSON.stringify({ view: 'deck', scrollY: 0, gameLive: false }),
          );
        } catch {
          /* private mode — nothing stored, nothing to clear */
        }
      },
      UPDATE_RESUME_FLAG_KEY,
    );
    const bootStart = Date.now();
    await page.goto(preview.url, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('button.nav-link', { timeout: APP_SHELL_WAIT_MS });

    // --- The deck builder, walked exactly as the user walked it -------------
    await page.waitForSelector('.builtin-deck', { timeout: APP_SHELL_WAIT_MS });
    console.log(`  builder reachable in ${((Date.now() - bootStart) / 1000).toFixed(1)}s`);

    // Before: what a user sees having copied nothing.
    await page.evaluate(() => {
      document.querySelector('.builtin-decks')?.scrollIntoView({ block: 'center' });
    });
    await sleep(PAINT_SETTLE_MS);
    await shot(page, `${label}-1-builder-before-copy.png`);

    // Copy the built-in deck from the report, then rename the copy — the two
    // actions that produced "the app duplicated my deck".
    const copyTagged = await page.evaluate((name) => {
      const row = [...document.querySelectorAll('.builtin-deck')].find((el) =>
        (el.textContent ?? '').includes(name),
      );
      const btn = [...(row?.querySelectorAll('button') ?? [])].find(
        (b) => (b.textContent ?? '').trim() === 'Copy to my decks',
      );
      if (!btn) return false;
      btn.id = 'harness-copy-btn';
      return true;
    }, BUILTIN_DECK);
    let copied = false;
    if (copyTagged) {
      await page.click('#harness-copy-btn');
      copied = true;
    }
    check(copied, `${label}: "Copy to my decks" is reachable on ${BUILTIN_DECK}`);
    await sleep(600);

    const renamed = await setControlledInput(page, 'input.deck-name-input', RENAMED_COPY);
    check(renamed, `${label}: the copy could be renamed to "${RENAMED_COPY}"`);
    await sleep(600);

    // Frame the boundary between the two regions: the user's decks at the top of
    // the panel, the built-in region directly beneath. This is the comparison the
    // report was about, so it is the one the capture has to contain.
    const seen = await frameAndMeasureVisibility(page, '.saved-decks-region');
    await sleep(PAINT_SETTLE_MS);
    await shot(page, `${label}-2-builder-both-kinds.png`);
    console.log('  visible:', JSON.stringify(seen));

    const rows = await measureRows(page);
    console.log('  rows:', JSON.stringify(rows));

    // 1. Both kinds VISIBLE at once — the situation of the report, and a claim
    //    about what is on screen rather than about what is in the DOM.
    check(
      seen.savedVisible > 0 && seen.builtinVisible > 0,
      `${label}: a built-in deck and one of the user's are VISIBLE together`,
      `${seen.savedVisible} of yours, ${seen.builtinVisible} built-in in the viewport`,
    );
    check(
      seen.yourDecksHeadingVisible && seen.builtinHeadingVisible,
      `${label}: both region headings are visible in the same frame`,
      `Your decks ${seen.yourDecksHeadingVisible}, Built-in ${seen.builtinHeadingVisible}`,
    );
    // 2. They are not painted the same. Border STYLE is the load-bearing one:
    //    a colour tweak could be undone by a theme change, `dashed` cannot be
    //    mistaken for `solid` at any size.
    check(
      rows.builtinStyle?.borderStyle !== rows.savedStyle?.borderStyle,
      `${label}: built-in and saved rows have different border styles`,
      `${rows.builtinStyle?.borderStyle} vs ${rows.savedStyle?.borderStyle}`,
    );
    check(
      rows.builtinStyle?.background !== rows.savedStyle?.background,
      `${label}: built-in and saved rows have different backgrounds`,
      `${rows.builtinStyle?.background} vs ${rows.savedStyle?.background}`,
    );
    check(
      rows.builtinOrigin === 'builtin' && rows.savedOrigin === 'mine',
      `${label}: each row declares its origin`,
      `${rows.builtinOrigin} / ${rows.savedOrigin}`,
    );
    // 3. The badge is actually PAINTED, not merely present in the DOM.
    check(
      /Built-in/i.test(rows.badgeText) && (rows.badgeRect?.w ?? 0) > 0 && (rows.badgeRect?.h ?? 0) > 0,
      `${label}: the built-in row carries a visible "Built-in" badge`,
      `"${rows.badgeText}" ${rows.badgeRect?.w}x${rows.badgeRect?.h}px`,
    );
    // 4. The copy is reported, by the name it now has.
    check(
      rows.builtinText.includes('Already copied') && rows.builtinText.includes(RENAMED_COPY),
      `${label}: ${BUILTIN_DECK} reports the renamed copy`,
      rows.builtinText.replace(/\s+/g, ' ').slice(0, 120),
    );
    check(
      rows.copyButtonsStillOffered === rows.builtinRowCount - 1,
      `${label}: the copied deck no longer dangles "Copy to my decks"`,
      `${rows.copyButtonsStillOffered} of ${rows.builtinRowCount} still offer it`,
    );
    check(!rows.pageScrollsX, `${label}: the builder does not scroll horizontally`);

    // The copied deck's own row, framed — on a phone it is nine rows below the
    // boundary above, so it cannot share a frame with it and gets its own.
    const copiedRow = await frameBuiltinRow(page, BUILTIN_DECK);
    await sleep(PAINT_SETTLE_MS);
    await shot(page, `${label}-3-builtin-already-copied.png`);
    check(
      copiedRow.visible,
      `${label}: the already-copied ${BUILTIN_DECK} row is fully in the viewport`,
    );

    // --- The Play setup -----------------------------------------------------
    await openView(page, 'Play');
    await sleep(400);
    // The mode cards carry icon + title + description inside one button, so an
    // exact-text match would miss; tag by a CONTAINS match and click for real.
    await page.waitForSelector('.play-mode__card', { timeout: UI_TRANSITION_WAIT_MS });
    const soloTagged = await page.evaluate(() => {
      const btn = [...document.querySelectorAll('button.play-mode__card')].find((b) =>
        /Solo \(vs the computer\)/.test(b.textContent ?? ''),
      );
      if (!btn) return false;
      btn.id = 'harness-solo-btn';
      return true;
    });
    if (soloTagged) await page.click('#harness-solo-btn');
    await page.waitForSelector('select[aria-label="Seat A deck"]', {
      timeout: UI_TRANSITION_WAIT_MS,
    });
    await sleep(PAINT_SETTLE_MS);
    await shot(page, `${label}-4-play-setup.png`);

    // Show the picker's own grouping, since a collapsed <select> hides it.
    // SEAT A, not seat B. Seat B already defaults to a built-in deck (the menu's
    // second entry), so switching it changed nothing and the two captures came
    // out byte-identical — a screenshot that proves nothing is worse than none.
    // Seat A starts on the user's own deck, so flipping it is a visible before/after.
    await page.evaluate(() => {
      const select = document.querySelector('select[aria-label="Seat A deck"]');
      const builtin = [...(select?.querySelectorAll('option') ?? [])].find(
        (o) => o.getAttribute('data-deck-origin') === 'builtin',
      );
      if (select && builtin) {
        const setter = Object.getOwnPropertyDescriptor(
          window.HTMLSelectElement.prototype,
          'value',
        )?.set;
        setter?.call(select, builtin.value);
        select.dispatchEvent(new Event('change', { bubbles: true }));
      }
    });
    await sleep(600);
    await shot(page, `${label}-5-play-setup-seat-a-builtin.png`);

    const picker = await measurePicker(page);
    console.log('  picker:', JSON.stringify(picker));
    check(picker.found, `${label}: the Play setup has a deck picker`);
    const groupLabels = (picker.groups ?? []).map((g) => g.label);
    check(
      groupLabels.includes('Your decks') && groupLabels.includes('Built-in gauntlet decks'),
      `${label}: the picker groups decks by where they came from`,
      groupLabels.join(' | '),
    );
    check(
      picker.ungroupedOptions === 0,
      `${label}: no deck option sits outside a group`,
      `${picker.ungroupedOptions} ungrouped`,
    );
    const builtinOptions = (picker.groups ?? [])
      .flatMap((g) => g.options)
      .filter((o) => o.origin === 'builtin');
    // Identity, NOT access: a built-in deck must still be playable directly.
    check(
      builtinOptions.length > 0 && builtinOptions.every((o) => !o.disabled),
      `${label}: every built-in deck is still selectable (playing one is a feature)`,
      `${builtinOptions.length} built-in options, none disabled`,
    );
    check(
      typeof picker.noteText === 'string' && /Built-in/i.test(picker.noteText),
      `${label}: picking a built-in deck says so beneath the control`,
      picker.noteText ?? 'no note',
    );
    check(!picker.pageScrollsX, `${label}: the Play setup does not scroll horizontally`);
    // ⚠️ AND THE APP ITSELF. Without this a crash reads as "the control is
    // missing" — which is how a React #185 crash in the card grid was once
    // filed as "8 cards are missing". See lib/harness-page.mjs.
    check(watcher.errors.length === 0, `${label}: the app threw nothing`, watcher.errors.slice(0, 2).join(' | '));

    await page.close();
  }
} catch (error) {
  console.error('\nharness error:', error.stack ?? error.message);
  failures.push(`harness error: ${error.message}`);
} finally {
  await browser.close();
  preview.child.kill();
}

console.log(`\n${failures.length === 0 ? 'ALL CHECKS PASSED' : `${failures.length} CHECK(S) FAILED`}`);
for (const f of failures) console.log(`  - ${f}`);
console.log(`screenshots: ${OUT_DIR}`);
process.exit(failures.length === 0 ? 0 : 1);

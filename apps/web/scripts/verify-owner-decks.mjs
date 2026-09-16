#!/usr/bin/env node
/**
 * Drive the BUILT app in a real Chrome and prove that the owner's three REAL
 * decks are IN THE APP — visible from a cold start, and playable.
 *
 * ## Why a browser harness and not only unit tests
 *
 * He opened the app, went looking for his decks, and they were not there. They
 * had only ever existed as `.txt` files in `docs/decks/` that a person would
 * have had to open and paste into Import by hand. That is the ninth time work in
 * this repo has been written, committed, tested and left unreachable — and not
 * one of those nine was caught by a test, because a test can only ask whether
 * the data exists, never whether a person can get to it.
 *
 * So this starts from an EMPTY browser profile and asks the only question that
 * matters: open the app, look — are his decks there, and can he play one?
 *
 * ## What it checks
 *
 *   1. COLD START, NOTHING IMPORTED — localStorage is cleared before any app
 *      script runs, so nothing below can be satisfied by state a previous run
 *      left behind.
 *   2. ALL THREE ARE ON SCREEN, BY NAME — not merely in the DOM: each row is
 *      measured against the viewport, because the deck panel scrolls and a row
 *      600px below the fold is not a deck he can find.
 *   3. THEY ARE MARKED AS HIS PAPER DECKS — a painted "Paper" badge and a
 *      `data-deck-origin` of `owner`, painted differently from both the built-in
 *      rows and his own saved decks. Three kinds of deck now share one column
 *      and the last time two of them looked alike he filed a duplication bug.
 *   4. A SHORT DECK SAYS SO AND NAMES THE CARDS — read out of the RENDERED text,
 *      so "it is in the markup" is not accepted for "he can read it".
 *   5. THE PLAY PICKER OFFERS THEM — grouped under "Your paper decks", none
 *      disabled, on the screen he actually starts a game from.
 *   6. HE CAN PLAY ONE — Acidic Angels into both seats, Start, keep the hand,
 *      and the board is live. The opening hand is then read back card by card
 *      and every name must be a card in Acidic Angels, which is what makes this
 *      "it is the deck he built" rather than "a game started".
 *
 * ## The discriminator
 *
 * Run against a build of `origin/main` this fails at check 2: there is no
 * `.owner-deck` in that app at all, because his decks are not in it. That is the
 * whole claim, so that is the shape the red has to have.
 *
 * Screenshots land in verify-out/owner-decks/ inside the worktree.
 * Exit 0 = every check passed; 1 = a check failed; 2 = could not run.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import { findChrome } from './lib/find-chrome.mjs';
import { harnessLaunchOptions } from './lib/harness-chrome.mjs';
import { watchPageErrors, assertPageAlive } from './lib/harness-page.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = resolve(HERE, '..');
const OUT_DIR = resolve(WEB_ROOT, 'verify-out', 'owner-decks');

/**
 * The app's update-resume flag key, mirrored from `apps/web/src/lib/config.ts`.
 * A harness is a plain .mjs and cannot import the TS module; a stale copy would
 * silently stop opening the builder directly, and the logged boot time is the
 * tell — it jumps back to a double mount.
 */
const UPDATE_RESUME_FLAG_KEY = 'jonny-boi.update.resume.v1';

/**
 * HIS THREE DECKS, BY THE NAMES HE GAVE THEM.
 *
 * ⚠️ These names have been wrong twice and each time it cost real time, so they
 * are asserted as exact strings rather than matched loosely. `tell` is a card
 * that is in that deck and in no other, from `docs/decks/README.md` — a deck
 * rendered under the wrong name fails on content, not only on its label.
 */
const DECKS = Object.freeze([
  Object.freeze({ name: 'Acidic Angels', tell: 'Acidic Slime', mustBeComplete: true }),
  Object.freeze({ name: "Thune's Life", tell: 'Archangel of Thune', mustBeComplete: false }),
  Object.freeze({
    name: 'Tamiyo + Jace Surge',
    tell: 'Tamiyo, the Moon Sage',
    mustBeComplete: false,
  }),
]);

/** The deck he is going to sit down and play. Complete on `main`; 59 cards. */
const PLAYABLE_DECK = 'Acidic Angels';
/** Its size, so "the game dealt HIS deck" is a number and not an impression. */
const PLAYABLE_DECK_SIZE = 59;
/** How many cards an opening hand holds — the sample we read names back from. */
const OPENING_HAND = 7;

/**
 * The card names in Acidic Angels, READ FROM THE TRANSCRIPTION rather than
 * retyped here.
 *
 * `docs/decks/acidic-angels.txt` is the source of truth for that deck, a test in
 * `packages/sim` already fails if the shipped registry drifts from it, and a
 * third copy of the list in a harness would be a third thing to keep in step —
 * which is how a list gets quietly out of date and starts passing a check it
 * should fail (CLAUDE.md rule 12).
 *
 * ⚠️ The line split tolerates a carriage return: this repo's committed text is
 * CRLF on disk with no `.gitattributes`, and a reader that assumes LF leaves a
 * stray CR on the end of every name, so nothing it produces ever matches.
 */
function transcribedNames(relativePath) {
  const text = readFileSync(resolve(WEB_ROOT, '..', '..', relativePath), 'utf8');
  return text
    .split(/\r?\n/)
    .map((line) => line.replace(/\/\/.*$/, '').trim())
    .map((line) => /^\d+\s+(\S.*)$/.exec(line))
    .filter((m) => m !== null)
    .map((m) => m[1].trim());
}

const ACIDIC_ANGELS_NAMES = transcribedNames('docs/decks/acidic-angels.txt');

/**
 * The widths that matter. `desktop` is where the builder's two-column layout is
 * authored; `phone` is the PWA's actual home, and the deck panel is at its most
 * cramped there, which is exactly where a third region could push his decks off
 * the bottom of the list.
 */
const VIEWPORTS = Object.freeze({
  desktop: { width: 1440, height: 1100 },
  phone: { width: 375, height: 812 },
});

/**
 * Budgets, named rather than inline. 90 s for the app shell matches every other
 * harness here: the landing view fetches hundreds of cross-origin card images
 * and time-to-shell is bimodal (~8 s warm, ~39 s cold), so a tighter budget
 * reports the APP as broken when the NETWORK is slow. 20 s for in-app
 * transitions, which touch no network; 60 s for a game to start, which shuffles
 * and deals through the real engine.
 */
const APP_SHELL_WAIT_MS = 90_000;
const UI_TRANSITION_WAIT_MS = 20_000;
const GAME_START_WAIT_MS = 60_000;
/** How long the vite preview server gets to answer before we give up. */
const PREVIEW_WAIT_MS = 90_000;
/** Long enough for card art to settle so a capture is not a half-painted frame. */
const PAINT_SETTLE_MS = 1_200;
/** One React commit — enough for a select's onChange to re-render its note. */
const REACT_BEAT_MS = 600;

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
  const deadline = Date.now() + PREVIEW_WAIT_MS;
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
 * ⚠️ `page.evaluate(() => btn.click())` does not return until the page's main
 * thread is free again — and opening the Deck Builder mounts a grid of every
 * card in the pool, which blocks that thread long enough to blow puppeteer's
 * CDP `protocolTimeout` and kill the run. Tagging the element and using
 * `page.click` dispatches a real input event and returns immediately.
 */
let tagSeq = 0;
async function clickByText(page, pattern, selector = 'button') {
  const id = `harness-target-${++tagSeq}`;
  const tagged = await page.evaluate(
    (source, flags, sel, tagId) => {
      const re = new RegExp(source, flags);
      const el = [...document.querySelectorAll(sel)].find((b) => re.test((b.textContent ?? '').trim()));
      if (!el) return false;
      el.id = tagId;
      return true;
    },
    pattern.source,
    pattern.flags,
    selector,
    id,
  );
  if (!tagged) return false;
  await page.click(`#${id}`);
  return true;
}

/** Open a top-level view by its nav label. */
async function openView(page, label) {
  if (!(await clickByText(page, new RegExp(`^${label}$`), 'button.nav-link'))) {
    throw new Error(`nav tab "${label}" not found`);
  }
}

/**
 * Scroll the paper-deck region to the top of its scrollport and report what is
 * ACTUALLY IN THE VIEWPORT.
 *
 * ⚠️ Presence is not visibility, and only visibility is the thing he can find.
 * The deck panel scrolls, so a row can be in the DOM and 600px below the fold
 * while a DOM-only check reports a clean pass.
 */
async function frameAndMeasure(page) {
  return page.evaluate(() => {
    const region = document.querySelector('.owner-decks');
    region?.scrollIntoView({ block: 'start' });
    // `block:'start'` aligns to the scrollport top, which sits UNDER the sticky
    // header — nudge back by the header's own height, measured rather than
    // hardcoded so a header that changes size cannot re-open the hole.
    const header = document.querySelector('.app__header');
    const headerBottom = header ? header.getBoundingClientRect().bottom : 0;
    if (region) {
      const scroller = (() => {
        for (let el = region.parentElement; el; el = el.parentElement) {
          const overflowY = getComputedStyle(el).overflowY;
          if ((overflowY === 'auto' || overflowY === 'scroll') && el.scrollHeight > el.clientHeight) {
            return el;
          }
        }
        return null;
      })();
      const gap = region.getBoundingClientRect().top - headerBottom - 8;
      if (gap < 0) {
        if (scroller) scroller.scrollTop += gap;
        else window.scrollBy(0, gap);
      }
    }
    const visible = (el) => {
      if (!el) return false;
      const r = el.getBoundingClientRect();
      return (
        r.top >= headerBottom &&
        r.left >= 0 &&
        r.bottom <= window.innerHeight &&
        r.right <= window.innerWidth &&
        r.width > 0 &&
        r.height > 0
      );
    };
    const rows = [...document.querySelectorAll('.owner-deck')].map((row) => {
      const badge = row.querySelector('.deck-origin-badge');
      const status = row.querySelector('.owner-deck__status');
      const badgeRect = badge?.getBoundingClientRect();
      const cs = getComputedStyle(row);
      return {
        name: (row.querySelector('.owner-deck__name')?.textContent ?? '').trim(),
        origin: row.getAttribute('data-deck-origin'),
        badgeText: (badge?.textContent ?? '').trim(),
        badgePainted: !!badgeRect && badgeRect.width > 0 && badgeRect.height > 0,
        statusText: (status?.textContent ?? '').trim(),
        short: !!status?.classList.contains('owner-deck__status--short'),
        visible: visible(row),
        borderStyle: cs.borderTopStyle,
        borderLeft: cs.borderLeftColor,
        background: cs.backgroundColor,
        text: (row.textContent ?? '').trim(),
      };
    });
    const other = (selector) => {
      const el = document.querySelector(selector);
      if (!el) return null;
      const cs = getComputedStyle(el);
      return { borderStyle: cs.borderTopStyle, background: cs.backgroundColor };
    };
    return {
      rows,
      headingVisible: [...document.querySelectorAll('.section-label')]
        .filter((el) => (el.textContent ?? '').trim() === 'Your paper decks')
        .some(visible),
      builtinRow: other('.builtin-deck'),
      savedRow: other('.saved-deck'),
      pageScrollsX: document.documentElement.scrollWidth > window.innerWidth + 1,
    };
  });
}

/**
 * Scroll ONE paper-deck row into view and report whether it is then really
 * visible — fully inside the viewport and clear of the sticky header.
 *
 * ⚠️ Why per-row and not only the whole-region frame above. The deck panel
 * SCROLLS. On a 375px phone the three rows plus their completeness sentences are
 * taller than the screen, so "all three in one frame" is a claim about the phone
 * rather than about the feature, and a harness that failed on it would be
 * reporting a true fact about geometry as a missing deck. What he needs is that
 * every row can be brought onto the screen and is whole when it gets there —
 * which is still a VISIBILITY claim, and still one the DOM alone cannot answer.
 */
async function frameRow(page, name) {
  return page.evaluate((deckName) => {
    const row = [...document.querySelectorAll('.owner-deck')].find(
      (el) => (el.querySelector('.owner-deck__name')?.textContent ?? '').trim() === deckName,
    );
    if (!row) return { found: false, visible: false };
    row.scrollIntoView({ block: 'center' });
    const header = document.querySelector('.app__header');
    const headerBottom = header ? header.getBoundingClientRect().bottom : 0;
    const r = row.getBoundingClientRect();
    return {
      found: true,
      visible:
        r.top >= headerBottom &&
        r.bottom <= window.innerHeight &&
        r.left >= 0 &&
        r.right <= window.innerWidth &&
        r.width > 0 &&
        r.height > 0,
      rect: { top: Math.round(r.top), bottom: Math.round(r.bottom), h: Math.round(r.height) },
    };
  }, name);
}

/** Read the shape of a Play-setup deck picker, by seat. */
async function measurePicker(page, seat) {
  return page.evaluate((whichSeat) => {
    const select = document.querySelector(`select[aria-label="Seat ${whichSeat} deck"]`);
    if (!select) return { found: false };
    return {
      found: true,
      groups: [...select.querySelectorAll('optgroup')].map((g) => ({
        label: g.label,
        options: [...g.querySelectorAll('option')].map((o) => ({
          text: (o.textContent ?? '').trim(),
          value: o.value,
          origin: o.getAttribute('data-deck-origin'),
          disabled: o.disabled,
        })),
      })),
      ungroupedOptions: [...select.children].filter((c) => c.tagName === 'OPTION').length,
    };
  }, seat);
}

/** Choose a deck in one seat by its `<option>` value, the way a click would. */
async function chooseDeck(page, seat, value) {
  return page.evaluate(
    (whichSeat, optionValue) => {
      const select = document.querySelector(`select[aria-label="Seat ${whichSeat} deck"]`);
      if (!select) return false;
      const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value')?.set;
      setter?.call(select, optionValue);
      select.dispatchEvent(new Event('change', { bubbles: true }));
      return select.value === optionValue;
    },
    seat,
    value,
  );
}

/** What the setup screen says about the current picks. */
async function readSetupState(page) {
  return page.evaluate(() => ({
    problems: [...document.querySelectorAll('.play-setup__problems')].map((el) =>
      (el.textContent ?? '').trim(),
    ),
    notes: [...document.querySelectorAll('.deck-origin-note')].map((el) => ({
      text: (el.textContent ?? '').trim(),
      origin: el.getAttribute('data-deck-origin'),
    })),
    startDisabled: document.querySelector('.play-setup__start')?.disabled ?? null,
  }));
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
  // minute on a cold cache. Set on the object the shared builder returns —
  // `harness-chrome-launch.test.ts` forbids an inline launch object.
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
    // ⚠️ A COLD START, every pass. Pages of one browser share an origin's
    // localStorage, so without this the phone pass would inherit whatever the
    // desktop pass left behind — and "his decks are there without importing
    // anything" is a claim about an EMPTY profile or it is no claim at all.
    await page.evaluateOnNewDocument(
      (resumeKey) => {
        try {
          localStorage.clear();
          // Boot straight into the Deck Builder through the app's own
          // update-resume flag — a shipped path, not a test hook. Landing on the
          // card browser first mounts the full pool TWICE on one main thread,
          // which overran a 90 s budget in 3 of 4 runs of a sibling harness.
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

    // --- 1. His decks, on a screen he did not have to prepare ---------------
    let regionArrived = true;
    try {
      await page.waitForSelector('.owner-deck', { timeout: APP_SHELL_WAIT_MS });
    } catch {
      regionArrived = false;
    }
    // ⚠️ Ask the app whether it is ALIVE before reporting an absence as data. A
    // React tree that threw and came down looks exactly like a feature that was
    // never built, and this repo has already filed one as the other.
    await assertPageAlive(page, watcher, 'opening the deck builder');
    check(
      regionArrived,
      `${label}: the owner's paper-deck region exists in the builder`,
      regionArrived ? undefined : 'no .owner-deck row appeared — his decks are not in this build',
    );
    if (!regionArrived) {
      await shot(page, `${label}-0-no-owner-decks.png`);
      await page.close();
      continue;
    }
    console.log(`  builder reachable in ${((Date.now() - bootStart) / 1000).toFixed(1)}s`);

    const seen = await frameAndMeasure(page);
    await sleep(PAINT_SETTLE_MS);
    await shot(page, `${label}-1-paper-decks.png`);
    console.log(`  rows: ${JSON.stringify(seen.rows.map((r) => ({ n: r.name, v: r.visible, s: r.short })))}`);

    check(
      seen.headingVisible,
      `${label}: the "Your paper decks" heading is on screen`,
    );
    for (const deck of DECKS) {
      const row = seen.rows.find((r) => r.name === deck.name);
      check(!!row, `${label}: "${deck.name}" is listed, by his name for it`);
      if (!row) continue;
      // 2. VISIBLE, not merely present — brought onto the screen the way a
      //    person scrolls to it, then measured. See frameRow.
      const framed = await frameRow(page, deck.name);
      check(
        framed.visible,
        `${label}: "${deck.name}" can be brought fully onto the screen`,
        JSON.stringify(framed.rect ?? {}),
      );
      // 3. Marked as his paper deck, with a badge that is really painted.
      check(
        row.origin === 'owner' && /Paper/i.test(row.badgeText) && row.badgePainted,
        `${label}: "${deck.name}" is badged as a paper deck`,
        `origin ${row.origin}, badge "${row.badgeText}", painted ${row.badgePainted}`,
      );
      // 4. It says what it is, out of the RENDERED text.
      if (deck.mustBeComplete) {
        check(
          !row.short && /All \d+ cards are in the pool/.test(row.statusText),
          `${label}: "${deck.name}" says it is complete`,
          row.statusText.slice(0, 90),
        );
      } else {
        check(
          row.short && /Incomplete/.test(row.statusText),
          `${label}: "${deck.name}" says it is INCOMPLETE`,
          row.statusText.slice(0, 90),
        );
        check(
          /does not carry \d+ of its \d+ card names? yet/.test(row.statusText) &&
            /\d+ of \d+ cards/.test(row.statusText),
          `${label}: "${deck.name}" names the size of the hole`,
          row.statusText.slice(0, 120),
        );
        check(
          row.statusText.includes(deck.tell) || row.statusText.split(',').length >= 2,
          `${label}: "${deck.name}" names the missing cards`,
          row.statusText.slice(0, 160),
        );
      }
    }
    // A paper row must not be mistakable for a built-in one or a saved one.
    const paperRow = seen.rows[0];
    check(
      !!paperRow && !!seen.builtinRow && paperRow.borderStyle !== seen.builtinRow.borderStyle,
      `${label}: a paper row is painted differently from a built-in row`,
      `${paperRow?.borderStyle} vs ${seen.builtinRow?.borderStyle}`,
    );
    check(!seen.pageScrollsX, `${label}: the builder does not scroll horizontally`);
    // A DESKTOP-only extra: at the width the builder is authored for, all three
    // of his decks should sit in one frame, which is what "I opened the app and
    // there they are" actually looks like. Not asserted on the phone — see
    // frameRow for why that would be a claim about the screen, not the feature.
    if (label === 'desktop') {
      check(
        seen.rows.length === DECKS.length && seen.rows.every((r) => r.visible),
        `${label}: all ${DECKS.length} of his decks are on screen together`,
        seen.rows.map((r) => `${r.name}:${r.visible}`).join(' '),
      );
    }

    // --- 5. The picker he actually starts a game from -----------------------
    await openView(page, 'Play');
    await page.waitForSelector('.play-mode__card', { timeout: UI_TRANSITION_WAIT_MS });
    await clickByText(page, /Solo \(vs the computer\)/, 'button.play-mode__card');
    await page.waitForSelector('select[aria-label="Seat A deck"]', {
      timeout: UI_TRANSITION_WAIT_MS,
    });

    const picker = await measurePicker(page, 'A');
    check(picker.found, `${label}: the Play setup has a deck picker`);
    const groupLabels = (picker.groups ?? []).map((g) => g.label);
    check(
      groupLabels.includes('Your paper decks'),
      `${label}: the picker groups his paper decks under their own heading`,
      groupLabels.join(' | '),
    );
    const paperOptions = (picker.groups ?? [])
      .flatMap((g) => g.options)
      .filter((o) => o.origin === 'owner');
    check(
      paperOptions.length === DECKS.length && paperOptions.every((o) => !o.disabled),
      `${label}: all ${DECKS.length} paper decks are selectable`,
      `${paperOptions.length} offered, ${paperOptions.filter((o) => o.disabled).length} disabled`,
    );
    for (const deck of DECKS) {
      check(
        paperOptions.some((o) => o.text.startsWith(deck.name)),
        `${label}: "${deck.name}" can be chosen for a game`,
      );
    }

    // --- 6. Play one --------------------------------------------------------
    const playable = paperOptions.find((o) => o.text.startsWith(PLAYABLE_DECK));
    check(!!playable, `${label}: "${PLAYABLE_DECK}" is in the picker`);
    if (playable) {
      const pickedA = await chooseDeck(page, 'A', playable.value);
      const pickedB = await chooseDeck(page, 'B', playable.value);
      await sleep(REACT_BEAT_MS);
      check(pickedA && pickedB, `${label}: "${PLAYABLE_DECK}" picked for both seats`);
      const state = await readSetupState(page);
      console.log(`  setup: ${JSON.stringify(state)}`);
      await shot(page, `${label}-2-play-setup.png`);
      check(
        state.problems.length === 0,
        `${label}: "${PLAYABLE_DECK}" is READY — nothing to fix first`,
        state.problems.join(' | ').slice(0, 200),
      );
      check(
        state.notes.some((n) => n.origin === 'owner' && /Paper/i.test(n.text)),
        `${label}: the picked deck is named as one of his paper decks`,
        JSON.stringify(state.notes).slice(0, 160),
      );
      check(state.startDisabled === false, `${label}: Start game is enabled`);
    }

    // Only the desktop pass plays the game out: the claim "he can play one" is
    // about the app, not about a width, and a second full game doubles the run
    // for no new information on a box that is already RAM-starved.
    if (label === 'desktop' && playable) {
      const started = await clickByText(page, /^Start game$/);
      check(started, `${label}: Start game clicked`);
      await page.waitForSelector('.mulligan__hand', { timeout: GAME_START_WAIT_MS });
      const opening = await page.evaluate(() =>
        [...document.querySelectorAll('.hand-card-slot__zoom')].map((b) =>
          (b.getAttribute('aria-label') ?? '').replace(/^Inspect /, ''),
        ),
      );
      await sleep(PAINT_SETTLE_MS);
      await shot(page, `${label}-3-opening-hand.png`);
      console.log(`  opening hand: ${opening.join(', ')}`);
      check(
        opening.length === OPENING_HAND,
        `${label}: a real opening hand was dealt`,
        `${opening.length} cards`,
      );
      // ⚠️ THE CLAIM IS "IT IS THE DECK HE BUILT", so the hand is checked
      // against his list card by card. A game that started off some other deck
      // would pass every check above and fail this one.
      const inDeck = new Set(ACIDIC_ANGELS_NAMES);
      const strangers = opening.filter((n) => !inDeck.has(n));
      check(
        strangers.length === 0,
        `${label}: every card dealt is a card in ${PLAYABLE_DECK}`,
        strangers.length > 0 ? `not in the deck: ${strangers.join(', ')}` : `${opening.length}/${opening.length} his`,
      );

      await clickByText(page, /^Keep \(/);
      // A zero-mulligan keep can still offer a confirm step; take it if shown.
      await clickByText(page, /^Confirm bottom/);
      // ⚠️ `.play-board`, NOT `.play-view`. The surface renders several sibling
      // `.play-view` divs and the first is the "← Play menu" bar, so reading
      // that one reported an 11-character board and failed a live game.
      await page.waitForSelector('.play-board', { timeout: GAME_START_WAIT_MS });
      await sleep(PAINT_SETTLE_MS);
      await shot(page, `${label}-4-board-live.png`);
      const board = await page.evaluate(() => {
        const text = document.querySelector('.play-board')?.innerText ?? '';
        return {
          chars: text.length,
          hasTurn: /Turn\s+\d+/i.test(text),
          // Case-insensitive: the zone labels are uppercased by CSS, and
          // `innerText` returns what is PAINTED.
          libraryCounts: [...text.matchAll(/library\s*(\d+)/gi)].map((m) => Number(m[1])),
        };
      });
      console.log(`  board: ${JSON.stringify(board)}`);
      check(board.hasTurn && board.chars > 0, `${label}: the board is live`, `${board.chars} chars`);
      // 59 cards minus a 7-card opening hand: the library's own count is the
      // app's arithmetic on HIS deck, and it is 52 for a 59-card deck and 53
      // for a 60-card one — so this number cannot be produced by any other deck.
      const expectedLibrary = PLAYABLE_DECK_SIZE - OPENING_HAND;
      check(
        board.libraryCounts.some((n) => n === expectedLibrary),
        `${label}: the library holds his ${PLAYABLE_DECK_SIZE}-card deck minus the opening hand`,
        `expected ${expectedLibrary}, saw ${board.libraryCounts.join('/') || 'none'}`,
      );
      await assertPageAlive(page, watcher, 'playing his deck');
    }

    check(
      watcher.errors.length === 0,
      `${label}: the app threw nothing`,
      watcher.errors.slice(0, 2).join(' | '),
    );
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

#!/usr/bin/env node
/**
 * Drive the BUILT app in a real Chrome and prove there is ONE collection of his
 * decks, that every deck in it is editable, and — above all — that seeding
 * cannot touch a deck he already has.
 *
 * ## Why a browser harness and not only unit tests
 *
 * > "yo why is there a 'your paper decks' and 'your decks' - this is dumb. I
 * > just want one collection of decks and I must be able to edit all of them,
 * > regardless of whether scanned in. And you can ditch the Acidic Angels deck
 * > with 59 cards, not sure why its missing one"
 *
 * The second region was built, committed, tested and green. Nine pieces of work
 * in this repo have shipped that way and every one was caught by a harness or a
 * screenshot — not one by a test, because a test can ask whether the data exists
 * and never what the panel looks like or what survives a reload.
 *
 * ## ⚠️ THE MOST IMPORTANT CHECK IN THIS FILE IS #3
 *
 * He owns a correct 60-card *Acidic Angels*, in his browser, made long before
 * any of this — the copy of the built-in *Selesnya Blink* he renamed. Told that
 * "Acidic Angels is gone", his reply was *"dont scare me like that - because the
 * correct 60 card version of it was already in my decks."* So pass 2 below
 * plants exactly that deck in a profile and asserts that after load, and after a
 * second load, it is STILL THERE, still 60 cards, still carrying his own id, and
 * not duplicated. Deck storage has already cost him decks once
 * (`docs/PLAY-HISTORY-AND-STORAGE.md` §1); this is the check that would catch it
 * happening again.
 *
 * The CONTENT of the planted deck is deliberately arbitrary — real card ids read
 * out of the shipped index, in no meaningful order. The claim is not about what
 * his deck holds. It is that whatever it holds is not the app's business.
 *
 * ## What it checks
 *
 *   1. COLD START — localStorage cleared before any app script runs.
 *      a. EXACTLY ONE collection of his decks. One "Your decks" region, and no
 *         paper region, paper badge or the word "paper" anywhere on the panel.
 *      b. His transcribed decks are IN it, by name, visible, marked `mine`.
 *      c. No deck called "Acidic Angels" is seeded.
 *      d. A deck that is short or incomplete SAYS SO in its row, by name.
 *   2. EDITABLE — open a seeded deck, rename it, remove a card, reload, and both
 *      changes are still there. Under the old design this was impossible by
 *      construction: a paper deck was not one of his decks and had no controls.
 *   3. HIS DECK IS SAFE — the check above.
 *   4. IDEMPOTENT — a second and third load add nothing and duplicate nothing.
 *   5. The gauntlet is still its own region, not mixed into his collection.
 *
 * ## The discriminator
 *
 * Run against a build of `origin/main` this FAILS, and fails in the shape of the
 * claim: `main` renders a `.owner-decks` region ("Your paper decks") that this
 * asserts is absent, and his transcribed decks are NOT in "Your decks", so they
 * cannot be renamed or edited there either. Run it both ways before believing
 * the green.
 *
 * Screenshots land in verify-out/one-deck-collection/ inside the worktree.
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
const REPO_ROOT = resolve(WEB_ROOT, '..', '..');
const OUT_DIR = resolve(WEB_ROOT, 'verify-out', 'one-deck-collection');

/**
 * App storage keys, mirrored from `apps/web/src/lib/config.ts`.
 *
 * A harness is a plain `.mjs` and cannot import the TS module. A stale copy here
 * is visible rather than silent: the update-resume key stops opening the builder
 * directly (the logged boot time jumps), and a stale DECKS key would make pass 2
 * plant his deck somewhere the app never reads — which would show up as the app
 * reporting no decks at all, not as a quiet pass.
 */
const UPDATE_RESUME_FLAG_KEY = 'jonny-boi.update.resume.v1';
const DECKS_STORAGE_KEY = 'jonny-boi.decks.v1';
const SEEDED_DECKS_STORAGE_KEY = 'jonny-boi.decks.seeded.v1';
/** Per-page sentinel so a RELOAD does not re-plant the fixture. See bootPage. */
const FIXTURE_SENTINEL_KEY = 'jonny-boi.harness.fixture-planted';

/**
 * HIS DECKS, BY THE NAMES HE GAVE THEM — read from the registry, not retyped.
 *
 * ⚠️ These names have been wrong twice and each time it cost real time. The
 * registry in `packages/sim/data/owner-decks/index.ts` is the source of truth
 * for WHICH decks exist, so this reads the file rather than keeping a third copy
 * that could quietly fall out of step (CLAUDE.md rule 12). A registry that lost
 * a deck fails the "found the decks" assertion below rather than shrinking the
 * sweep silently.
 */
function seededDeckNames() {
  const index = readFileSync(
    resolve(REPO_ROOT, 'packages', 'sim', 'data', 'owner-decks', 'index.ts'),
    'utf8',
  );
  // The registry rows name a module each; the deck NAME lives in that module.
  const modules = [...index.matchAll(/^import \{ (\w+) \} from '\.\/([\w-]+)\.js';$/gm)];
  const names = [];
  for (const [, , file] of modules) {
    const source = readFileSync(
      resolve(REPO_ROOT, 'packages', 'sim', 'data', 'owner-decks', `${file}.ts`),
      'utf8',
    );
    const match = /name:\s*(['"])(.+?)\1,/.exec(source);
    if (match) names.push(match[2]);
  }
  return names;
}

const SEEDED_DECKS = seededDeckNames();

/** The name that must never be seeded, and must never be disturbed. */
const HIS_DECK_NAME = 'Acidic Angels';
const HIS_DECK_ID = 'his-own-acidic-angels-from-2026';
const HIS_DECK_SIZE = 60;

/**
 * His 60-card deck, built from real card ids so the app renders it like any
 * other deck of his.
 *
 * Scanned out of the shipped index with a regex rather than `JSON.parse`d: the
 * file is ~10 MB and nothing here needs the other 6,900 cards. WHICH cards these
 * are is irrelevant to the claim — see the header.
 */
function hisDeck() {
  const text = readFileSync(
    resolve(WEB_ROOT, 'src', 'data', 'card-index.json'),
    'utf8',
  );
  const ids = [];
  const re = /"id":\s*"([0-9a-f-]{36})"/g;
  let match;
  while ((match = re.exec(text)) !== null && ids.length < HIS_DECK_SIZE / 4) {
    if (!ids.includes(match[1])) ids.push(match[1]);
  }
  if (ids.length < HIS_DECK_SIZE / 4) {
    throw new Error(`card-index.json yielded only ${ids.length} ids — cannot build his deck`);
  }
  return {
    id: HIS_DECK_ID,
    name: HIS_DECK_NAME,
    cards: ids.map((id) => ({ cardId: id, count: 4 })),
    updatedAt: '2026-08-01T00:00:00.000Z',
  };
}

/** Widths that matter: where the builder is authored, and where the PWA lives. */
const VIEWPORTS = Object.freeze({
  desktop: { width: 1440, height: 1100 },
  phone: { width: 375, height: 812 },
});

/**
 * Budgets, named rather than inline. 90 s for the app shell matches every other
 * harness here: the landing view fetches hundreds of cross-origin card images
 * and time-to-shell is bimodal (~8 s warm, ~39 s cold), so a tighter budget
 * reports the APP as broken when the NETWORK is slow.
 */
const APP_SHELL_WAIT_MS = 90_000;
const PREVIEW_WAIT_MS = 90_000;
/** Long enough for card art to settle so a capture is not a half-painted frame. */
const PAINT_SETTLE_MS = 1_200;
/** One React commit, plus the persist effect that follows it. */
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
    resolve(REPO_ROOT, 'node_modules', 'vite', 'bin', 'vite.js'),
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
 * Open a page on a profile we control.
 *
 * ⚠️ The fixture is planted exactly ONCE, guarded by a sessionStorage sentinel,
 * because `evaluateOnNewDocument` runs again on every reload — and a reload that
 * re-planted the fixture would overwrite whatever the app had just done, which
 * is precisely what checks 2 and 4 are trying to observe. The resume flag is set
 * every time on purpose: the app consumes it, and it is what boots straight into
 * the builder instead of mounting the whole card grid twice.
 */
async function bootPage(browser, viewport, label, fixtureDecks) {
  const page = await browser.newPage();
  const watcher = watchPageErrors(page, { label });
  await page.setViewport(viewport);
  await page.evaluateOnNewDocument(
    (resumeKey, sentinelKey, decksKey, seedKey, fixtureJson) => {
      try {
        sessionStorage.setItem(
          resumeKey,
          JSON.stringify({ view: 'deck', scrollY: 0, gameLive: false }),
        );
        if (sessionStorage.getItem(sentinelKey)) return;
        sessionStorage.setItem(sentinelKey, '1');
        localStorage.clear();
        if (fixtureJson) {
          // His decks, and NO ledger — the profile of somebody who has been
          // using the app since before any of this existed.
          localStorage.setItem(decksKey, fixtureJson);
          localStorage.removeItem(seedKey);
        }
      } catch {
        /* private mode — nothing stored, nothing to clear */
      }
    },
    UPDATE_RESUME_FLAG_KEY,
    FIXTURE_SENTINEL_KEY,
    DECKS_STORAGE_KEY,
    SEEDED_DECKS_STORAGE_KEY,
    fixtureDecks ? JSON.stringify(fixtureDecks) : '',
  );
  return { page, watcher };
}

/** Wait for the builder's own deck collection to be on screen. */
async function waitForCollection(page) {
  await page.waitForSelector('.saved-decks-region', { timeout: APP_SHELL_WAIT_MS });
  await page.waitForSelector('.saved-deck', { timeout: APP_SHELL_WAIT_MS });
}

/**
 * Read the deck panel as a person sees it.
 *
 * ⚠️ Presence is not visibility, and only visibility is the thing he can find —
 * the deck panel scrolls, so a row can be in the DOM and 600 px below the fold
 * while a DOM-only check reports a clean pass. Every row therefore reports
 * whether it is really inside the viewport, clear of the sticky header.
 */
async function readPanel(page) {
  return page.evaluate(() => {
    const header = document.querySelector('.app__header');
    const headerBottom = header ? header.getBoundingClientRect().bottom : 0;
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
    const labels = [...document.querySelectorAll('.section-label')].map((el) =>
      (el.textContent ?? '').trim(),
    );
    const rows = [...document.querySelectorAll('.saved-deck')].map((row) => {
      const nameButton = row.querySelector('.saved-deck__name');
      const label = (nameButton?.textContent ?? '').trim();
      // "Thune's Life · 65" — the name and the size the app itself computed.
      const split = label.lastIndexOf(' · ');
      return {
        label,
        name: split === -1 ? label : label.slice(0, split).trim(),
        size: split === -1 ? null : Number(label.slice(split + 3).trim()),
        origin: row.getAttribute('data-deck-origin'),
        problems: (row.querySelector('.saved-deck__problems')?.textContent ?? '').trim(),
        active: row.classList.contains('saved-deck--active'),
        visible: visible(row),
      };
    });
    const panelText = (document.querySelector('.deck-panel')?.innerText ?? '').toLowerCase();
    return {
      rows,
      labels,
      // The regions, counted. The defect was that there were TWO of his.
      myCollections: document.querySelectorAll('.saved-decks-region').length,
      paperRegions: document.querySelectorAll('.owner-decks, .owner-deck').length,
      builtinRegions: document.querySelectorAll('.builtin-decks').length,
      builtinRows: document.querySelectorAll('.builtin-deck').length,
      paperBadges: document.querySelectorAll('.deck-origin-badge--owner').length,
      ownerMarked: document.querySelectorAll('[data-deck-origin="owner"]').length,
      saysPaper: panelText.includes('paper'),
      pageScrollsX: document.documentElement.scrollWidth > window.innerWidth + 1,
      // Duck-typed rather than `instanceof HTMLInputElement`: this body is
      // serialised into the PAGE, but it is linted as Node source, where that
      // global does not exist.
      deckNameInput: (() => {
        const el = document.querySelector('.deck-name-input');
        return el && typeof el.value === 'string' ? el.value : null;
      })(),
      // The open deck's own card list, so an edit can be measured.
      openDeckTotal: (() => {
        const el = [...document.querySelectorAll('.deck-stat-row')].find((row) =>
          /total cards/i.test(row.textContent ?? ''),
        );
        const m = /(\d+)/.exec(el?.textContent ?? '');
        return m ? Number(m[1]) : null;
      })(),
      removeSteppers: document.querySelectorAll('.deck-step--remove').length,
    };
  });
}

/**
 * Scroll HIS COLLECTION to the top of its scrollport, so a capture shows the
 * thing he actually complained about.
 *
 * ⚠️ The first version of this harness screenshotted the top of the builder and
 * called it evidence. The top of the builder is the card pool; the collection is
 * several hundred pixels down inside a scrolling panel. A screenshot that does
 * not contain the region under test proves nothing, and "I took a screenshot" is
 * not the same claim as "I looked at the thing".
 *
 * `block:'start'` aligns to the scrollport top, which sits UNDER the sticky
 * header — nudged back by the header's own measured height so it is not clipped.
 */
async function frameCollection(page) {
  return page.evaluate(() => {
    const region = document.querySelector('.saved-decks-region');
    if (!region) return false;
    region.scrollIntoView({ block: 'start' });
    const header = document.querySelector('.app__header');
    const headerBottom = header ? header.getBoundingClientRect().bottom : 0;
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
    return true;
  });
}

/** Scroll one deck row into view and report whether it is then really visible. */
async function frameRow(page, name) {
  return page.evaluate((deckName) => {
    const row = [...document.querySelectorAll('.saved-deck')].find((el) =>
      (el.querySelector('.saved-deck__name')?.textContent ?? '').trim().startsWith(deckName),
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

/**
 * Click a deck row by name, WITHOUT calling `.click()` inside `evaluate`.
 *
 * ⚠️ `page.evaluate(() => el.click())` does not return until the page's main
 * thread is free, and this app's heaviest mount can hold it long enough to blow
 * puppeteer's CDP timeout. Tagging the element and using `page.click` dispatches
 * a real input event and returns immediately.
 */
let tagSeq = 0;
async function clickDeck(page, name) {
  const id = `harness-target-${++tagSeq}`;
  const tagged = await page.evaluate(
    (deckName, tagId) => {
      const el = [...document.querySelectorAll('.saved-deck__name')].find((b) =>
        (b.textContent ?? '').trim().startsWith(deckName),
      );
      if (!el) return false;
      el.id = tagId;
      return true;
    },
    name,
    id,
  );
  if (!tagged) return false;
  await page.click(`#${id}`);
  return true;
}

/** Click the first "remove one copy" stepper in the open deck. */
async function removeOneCard(page) {
  const id = `harness-target-${++tagSeq}`;
  const tagged = await page.evaluate((tagId) => {
    const el = document.querySelector('.deck-step--remove');
    if (!el) return false;
    el.id = tagId;
    return true;
  }, id);
  if (!tagged) return false;
  await page.click(`#${id}`);
  return true;
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
  console.log(`seeded decks the registry declares: ${SEEDED_DECKS.join(', ') || '(none)'}`);
  check(
    SEEDED_DECKS.length > 0,
    'the registry declares at least one deck to seed — the sweep cannot go vacuous',
    `${SEEDED_DECKS.length} found`,
  );
  check(
    !SEEDED_DECKS.includes(HIS_DECK_NAME),
    `no seed is called "${HIS_DECK_NAME}" — he already owns one`,
    SEEDED_DECKS.join(', '),
  );

  // ═══════════════ PASS 1 — COLD PROFILE, at two widths ═══════════════
  for (const [label, viewport] of Object.entries(VIEWPORTS)) {
    console.log(`\n== cold profile · ${label} ${viewport.width}x${viewport.height} ==`);
    const { page, watcher } = await bootPage(browser, viewport, label, null);
    const bootStart = Date.now();
    await page.goto(preview.url, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('button.nav-link', { timeout: APP_SHELL_WAIT_MS });

    let arrived = true;
    try {
      await waitForCollection(page);
    } catch {
      arrived = false;
    }
    // ⚠️ Ask the app whether it is ALIVE before reporting an absence as data. A
    // React tree that threw and came down looks exactly like a feature that was
    // never built, and this repo has already filed one as the other.
    await assertPageAlive(page, watcher, 'opening the deck builder');
    check(arrived, `${label}: his deck collection is on screen`);
    if (!arrived) {
      await shot(page, `${label}-0-no-collection.png`);
      await page.close();
      continue;
    }
    console.log(`  builder reachable in ${((Date.now() - bootStart) / 1000).toFixed(1)}s`);

    check(await frameCollection(page), `${label}: his collection can be scrolled to`);
    await sleep(PAINT_SETTLE_MS);
    await shot(page, `${label}-1-one-collection.png`);
    const panel = await readPanel(page);
    console.log(`  labels: ${panel.labels.join(' | ')}`);
    console.log(`  rows: ${JSON.stringify(panel.rows.map((r) => ({ n: r.name, s: r.size, v: r.visible })))}`);

    // 1a. ONE collection of his. This is the whole complaint.
    check(
      panel.myCollections === 1,
      `${label}: exactly ONE collection of his decks`,
      `${panel.myCollections} found`,
    );
    check(
      panel.paperRegions === 0 && panel.paperBadges === 0 && panel.ownerMarked === 0,
      `${label}: no paper region, no paper badge, no 'owner' origin anywhere`,
      `regions ${panel.paperRegions}, badges ${panel.paperBadges}, marked ${panel.ownerMarked}`,
    );
    check(
      !panel.saysPaper,
      `${label}: the deck panel does not say "paper" at all`,
      panel.saysPaper ? 'the word is still on screen' : undefined,
    );
    check(
      panel.labels.filter((l) => /^your decks$/i.test(l)).length === 1,
      `${label}: one "Your decks" heading`,
      panel.labels.join(' | '),
    );

    // 1b. His transcribed decks are IN that collection, visible, and marked his.
    for (const name of SEEDED_DECKS) {
      const row = panel.rows.find((r) => r.name === name);
      check(!!row, `${label}: "${name}" is in his collection`);
      if (!row) continue;
      check(
        row.origin === 'mine',
        `${label}: "${name}" is marked as one of HIS decks`,
        `origin ${row.origin}`,
      );
      const framed = await frameRow(page, name);
      check(
        framed.visible,
        `${label}: "${name}" can be brought fully onto the screen`,
        JSON.stringify(framed.rect ?? {}),
      );
    }

    // 1c. Acidic Angels is not seeded. He has his own.
    check(
      !panel.rows.some((r) => r.name === HIS_DECK_NAME),
      `${label}: no "${HIS_DECK_NAME}" was seeded into a cold profile`,
      panel.rows.map((r) => r.name).join(' | '),
    );

    // 1d. A deck that is short or incomplete SAYS SO, and names the cards.
    //     ⚠️ Asserted as a SHAPE, not "which deck is short": the card pool grows
    //     between waves, and a harness that goes red because the pool got BETTER
    //     is worse than no harness — its red means nothing, so nobody reads it.
    for (const row of panel.rows) {
      if (row.problems === '') continue;
      const namesCards = /\d+ of \d+ cards/.test(row.problems);
      const namesShort = /needs \d+/.test(row.problems);
      check(
        namesCards || namesShort,
        `${label}: "${row.name}" says WHAT is wrong, not just that something is`,
        row.problems.slice(0, 150),
      );
      if (namesCards) {
        // "a deck that resolves to a handful of lands is not a deck" — a row
        // that admits cards are missing must name them, with counts.
        const named = row.problems.split(':').slice(1).join(':').trim();
        check(
          named.length > 0 && /\d+ \w/.test(named),
          `${label}: "${row.name}" names the cards the pool cannot supply`,
          named.slice(0, 160) || '(named nothing)',
        );
      }
    }

    // 5. The gauntlet is still its OWN region — the line that must not blur.
    check(
      panel.builtinRegions === 1 && panel.builtinRows > 0,
      `${label}: the built-in gauntlet is still a separate region`,
      `${panel.builtinRegions} region(s), ${panel.builtinRows} rows`,
    );
    check(!panel.pageScrollsX, `${label}: the builder does not scroll horizontally`);

    check(
      watcher.errors.length === 0,
      `${label}: the app threw nothing`,
      watcher.errors.slice(0, 2).join(' | '),
    );
    await page.close();
  }

  // ═══════════════ PASS 2 — EDITABLE, and it survives a reload ═══════════════
  console.log('\n== editable · desktop ==');
  {
    const { page, watcher } = await bootPage(browser, VIEWPORTS.desktop, 'edit', null);
    await page.goto(preview.url, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('button.nav-link', { timeout: APP_SHELL_WAIT_MS });
    await waitForCollection(page);
    await assertPageAlive(page, watcher, 'opening the builder to edit');

    const target = SEEDED_DECKS[0];
    check(await clickDeck(page, target), `opened "${target}" from his collection`);
    await sleep(REACT_BEAT_MS);
    const before = await readPanel(page);
    check(
      before.deckNameInput === target,
      `"${target}" is OPEN in the editor — it has a name field at all`,
      `field reads "${before.deckNameInput}"`,
    );
    const sizeBefore = before.openDeckTotal;
    check(
      before.removeSteppers > 0,
      `"${target}" has card controls — it is not read-only`,
      `${before.removeSteppers} steppers`,
    );

    // Rename it. Under the old design this was impossible: a paper deck was not
    // one of his decks and had no name field to type into.
    const RENAMED = `${target} (tuned by the harness)`;
    await page.click('.deck-name-input', { clickCount: 3 });
    await page.keyboard.press('Backspace');
    await page.type('.deck-name-input', RENAMED);
    // …and change its CARDS, so the claim is not only about a string.
    check(await removeOneCard(page), 'removed one card from the deck');
    await sleep(REACT_BEAT_MS);

    const afterEdit = await readPanel(page);
    console.log(`  after edit: name "${afterEdit.deckNameInput}", total ${afterEdit.openDeckTotal} (was ${sizeBefore})`);
    await shot(page, 'edit-1-after-edit.png');
    check(
      afterEdit.openDeckTotal === sizeBefore - 1,
      'the deck lost exactly one card',
      `${sizeBefore} → ${afterEdit.openDeckTotal}`,
    );

    // THE RELOAD. An edit that does not survive it was never saved.
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('button.nav-link', { timeout: APP_SHELL_WAIT_MS });
    await waitForCollection(page);
    await assertPageAlive(page, watcher, 'reloading after the edit');
    const reloaded = await readPanel(page);
    await frameCollection(page);
    await sleep(PAINT_SETTLE_MS);
    await shot(page, 'edit-2-after-reload.png');
    console.log(`  reloaded rows: ${JSON.stringify(reloaded.rows.map((r) => ({ n: r.name, s: r.size })))}`);

    const renamedRow = reloaded.rows.find((r) => r.name === RENAMED);
    check(!!renamedRow, 'THE RENAME SURVIVED THE RELOAD', reloaded.rows.map((r) => r.name).join(' | '));
    check(
      renamedRow ? renamedRow.size === sizeBefore - 1 : false,
      'THE CARD CHANGE SURVIVED THE RELOAD',
      `row reads ${renamedRow?.size}, expected ${sizeBefore - 1}`,
    );
    // …and the rename did not cause a second copy to be seeded beside it.
    check(
      !reloaded.rows.some((r) => r.name === target),
      'renaming it did not bring a fresh copy back',
      reloaded.rows.map((r) => r.name).join(' | '),
    );
    check(
      reloaded.rows.length === reloaded.rows.length && reloaded.myCollections === 1,
      'still exactly one collection after the reload',
    );
    check(watcher.errors.length === 0, 'edit pass: the app threw nothing', watcher.errors.slice(0, 2).join(' | '));
    await page.close();
  }

  // ═══════════════ PASS 3 — ⚠️ HIS OWN ACIDIC ANGELS IS NOT TOUCHED ═══════════
  console.log('\n== his own Acidic Angels · desktop ==');
  {
    const his = hisDeck();
    console.log(`  planting "${his.name}" — ${his.cards.length} entries, ${HIS_DECK_SIZE} cards, id ${his.id}`);
    const { page, watcher } = await bootPage(browser, VIEWPORTS.desktop, 'his', [his]);
    await page.goto(preview.url, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('button.nav-link', { timeout: APP_SHELL_WAIT_MS });
    await waitForCollection(page);
    await assertPageAlive(page, watcher, 'loading a profile that already has his deck');

    /** Everything this pass asserts, so it can be asserted again after a reload. */
    const assertHisDeckIsSafe = async (when) => {
      const panel = await readPanel(page);
      const mine = panel.rows.filter((r) => r.name === HIS_DECK_NAME);
      console.log(`  ${when}: ${JSON.stringify(panel.rows.map((r) => ({ n: r.name, s: r.size })))}`);
      check(mine.length === 1, `${when}: his "${HIS_DECK_NAME}" is there, exactly once`, `${mine.length} found`);
      check(
        mine[0]?.size === HIS_DECK_SIZE,
        `${when}: it is still ${HIS_DECK_SIZE} cards`,
        `reads ${mine[0]?.size}`,
      );
      check(mine[0]?.origin === 'mine', `${when}: it is still marked as his`, `origin ${mine[0]?.origin}`);
      // Read from STORAGE too, not only from the render: the row could be right
      // while the blob underneath had been rewritten, and the blob is the thing
      // that survives to tomorrow.
      const stored = await page.evaluate((key, name) => {
        try {
          const parsed = JSON.parse(localStorage.getItem(key) ?? '[]');
          const found = parsed.filter((d) => d && d.name === name);
          return {
            total: parsed.length,
            matches: found.length,
            id: found[0]?.id ?? null,
            size: (found[0]?.cards ?? []).reduce((sum, e) => sum + (e.count ?? 0), 0),
            names: parsed.map((d) => d && d.name),
          };
        } catch (error) {
          return { error: String(error) };
        }
      }, DECKS_STORAGE_KEY, HIS_DECK_NAME);
      console.log(`  ${when} storage: ${JSON.stringify(stored)}`);
      check(stored.matches === 1, `${when}: stored exactly once`, `${stored.matches} in localStorage`);
      check(
        stored.id === HIS_DECK_ID,
        `${when}: it is HIS deck — same id it was saved under`,
        `id ${stored.id}`,
      );
      check(stored.size === HIS_DECK_SIZE, `${when}: stored at ${HIS_DECK_SIZE} cards`, `${stored.size} stored`);
      // The seeds still arrive alongside it — his deck being safe must not be
      // achieved by seeding nothing at all.
      for (const name of SEEDED_DECKS) {
        check(
          panel.rows.some((r) => r.name === name),
          `${when}: "${name}" was still seeded alongside his deck`,
        );
      }
      check(panel.myCollections === 1, `${when}: still one collection`);
      check(panel.paperRegions === 0, `${when}: still no paper region`);
      return panel;
    };

    await assertHisDeckIsSafe('on first load');
    await frameCollection(page);
    await sleep(PAINT_SETTLE_MS);
    await shot(page, 'his-1-first-load.png');

    // PASS 4 — a second load, and a third. Idempotent or it is not fixed.
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('button.nav-link', { timeout: APP_SHELL_WAIT_MS });
    await waitForCollection(page);
    await assertPageAlive(page, watcher, 'reloading with his deck present');
    const second = await assertHisDeckIsSafe('after a reload');
    await frameCollection(page);
    await sleep(PAINT_SETTLE_MS);
    await shot(page, 'his-2-after-reload.png');

    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('button.nav-link', { timeout: APP_SHELL_WAIT_MS });
    await waitForCollection(page);
    const third = await assertHisDeckIsSafe('after a third load');
    check(
      third.rows.length === second.rows.length,
      'the collection stopped growing — seeding is idempotent',
      `${second.rows.length} then ${third.rows.length}`,
    );
    check(watcher.errors.length === 0, 'his-deck pass: the app threw nothing', watcher.errors.slice(0, 2).join(' | '));
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

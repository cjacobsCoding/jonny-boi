#!/usr/bin/env node
/**
 * Drive the BUILT app in a real Chrome and prove the two §3.60 promises on a
 * REAL board of real cards — the half no unit test reaches, because it lives in
 * the React state machine, the rendered affordances, and a live `GameSession`:
 *
 *   1. THE AUTO-TAP SPARES THE USEFUL SOURCE — with an Elvish Mystic and a
 *      Forest both untapped and both able to make {G}, casting a {G} spell taps
 *      the FOREST and leaves the Mystic able to block. This is the user's report
 *      verbatim, played out in the app.
 *   2. THE PICKER ASKS ONLY WHEN THERE IS A CHOICE, AND CANCELS CLEANLY — the
 *      per-cast "⛁" chip appears on the {G} spell (Forest OR Mystic) and NOT on
 *      the {1}{G} spell (which needs both, so there is nothing to pick); opening
 *      it shows a live "Still needed" readout that counts down as sources are
 *      clicked; Cancel leaves every land untapped and the card in hand.
 *
 * The board is arranged by PLAYING, not by poking state: a Mono-Green Ramp solo
 * game on a fixed seed, lands played and a Mystic cast through the real UI.
 *
 * Screenshots land in verify-out/mana-choice/ inside the worktree.
 * Exit 0 = every check passed; 1 = a check failed; 2 = could not run.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import { describeChromeSearch, findChrome } from './lib/find-chrome.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = resolve(HERE, '..');
const OUT_DIR = resolve(WEB_ROOT, 'verify-out', 'mana-choice');
const VIEWPORT = { width: 1180, height: 1500 }; // tall on purpose: the whole board + hand in one shot
const AI_BEAT_MS = 700; // > HOTSEAT_CONFIG.aiThinkMs (450), so the pilot's move lands between steps
const TURN_BUDGET = 40; // hard ceiling on the drive loop
/** The deck's mana creatures — the alternative to a Forest that makes a choice real. */
const MANA_CREATURES = /Elvish Mystic|Llanowar Elves|Birds of Paradise/;

/**
 * How long to wait for the app SHELL to exist after a navigation.
 *
 * ⚠️ NOT a magic number, and NOT a check: puppeteer's unnamed default is 30 s, and
 * the landing view is the 5,651-tile card browser, which pulls hundreds of
 * cross-origin Scryfall images. §3.146's gate MEASURED time-to-`.app__nav` as
 * BIMODAL — ~7.8 s when those fetches are cached, ~38.9 s when they are not — so
 * against the 30 s default this harness was a coin flip that reported the APP as
 * broken when the NETWORK was slow. It failed exactly that way on a fresh
 * worktree, which is how this was found.
 *
 * That gate named the budget in `verify-game-resume.mjs` and stopped there, so
 * the fix repaired one instance and left its sibling — the class-not-instance
 * failure rule 10 exists for. 90 s is the same budget `verify-bug-reporter.mjs`
 * gives `LAUNCHER_WAIT_MS`. All 19 checks are unchanged; only the wait is named.
 */
const APP_SHELL_WAIT_MS = 90_000;

/**
 * Waits for an IN-APP transition once the shell is already up. Deliberately
 * separate from {@link APP_SHELL_WAIT_MS}: these do not touch the network, so a
 * 90 s budget here would only turn a real hang into a slow one.
 */
const UI_TRANSITION_WAIT_MS = 20_000;

const checks = [];
function check(name, passed, detail = '') {
  checks.push({ name, passed });
  console.log(`  ${passed ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function freePort() {
  const net = await import('node:net');
  return new Promise((resolvePort, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolvePort(port));
    });
  });
}

async function isUp(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(2000) });
    return response.status > 0;
  } catch {
    return false;
  }
}

function viteBin() {
  const candidates = [
    resolve(WEB_ROOT, 'node_modules', 'vite', 'bin', 'vite.js'),
    resolve(WEB_ROOT, '..', '..', 'node_modules', 'vite', 'bin', 'vite.js'),
  ];
  const found = candidates.find((c) => existsSync(c));
  if (!found) throw new Error('vite is not installed');
  return found;
}

async function startPreview() {
  if (!existsSync(resolve(WEB_ROOT, 'dist', 'index.html'))) {
    throw new Error('apps/web/dist missing — run `npm run build` first');
  }
  const port = await freePort();
  const url = `http://localhost:${port}/`;
  const child = spawn(process.execPath, [viteBin(), 'preview', '--port', String(port), '--strictPort'], {
    cwd: WEB_ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (await isUp(url)) return { child, url };
    await sleep(300);
  }
  child.kill();
  throw new Error('vite preview did not answer in time');
}

/** Click the first enabled button whose trimmed text matches. */
async function clickButton(page, pattern, { timeoutMs = 15_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const clicked = await page.evaluate(
      (src, flg) => {
        const re = new RegExp(src, flg);
        const hit = [...document.querySelectorAll('button')].find(
          (b) => re.test(b.textContent?.trim() ?? '') && !b.disabled,
        );
        if (!hit) return false;
        hit.click();
        return true;
      },
      pattern.source,
      pattern.flags,
    );
    if (clicked) return true;
    await sleep(200);
  }
  return false;
}

async function textPresent(page, pattern, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = await page.evaluate((src) => new RegExp(src).test(document.body.innerText), pattern.source);
    if (found) return true;
    await sleep(200);
  }
  return false;
}

/**
 * Install the page-side helpers every step below reads the board through. Kept
 * in ONE place so a selector change breaks one function, not nine assertions.
 */
async function installProbes(page) {
  await page.evaluate(() => {
    const seatOf = (name) =>
      [...document.querySelectorAll('.seat')].find((s) => (s.innerText ?? '').startsWith(name));
    window.__mc = {
      /** Every card in the viewer's hand: name, and whether it shows the ⛁ chip. */
      hand: () =>
        [...(document.querySelector('.play-hand:not(.play-hand--hidden)') ?? document).querySelectorAll('.hand-card-slot')].map(
          (slot) => ({
            name: slot.querySelector('button[aria-label^="Inspect"]')?.getAttribute('aria-label')?.replace('Inspect ', ''),
            chip: slot.querySelector('.hand-card-slot__choose-mana') !== null,
          }),
        ),
      /** Click a hand card by name (the ordinary cast/play route). */
      play: (name) => {
        const slot = [...document.querySelectorAll('.hand-card-slot')].find(
          (s) => s.querySelector('button[aria-label^="Inspect"]')?.getAttribute('aria-label') === `Inspect ${name}`,
        );
        if (!slot) return false;
        slot.querySelector('.play-card')?.click();
        return true;
      },
      /** Click a hand card's ⛁ chip (the per-cast way into the picker). */
      chooseMana: (name) => {
        const slot = [...document.querySelectorAll('.hand-card-slot')].find(
          (s) => s.querySelector('button[aria-label^="Inspect"]')?.getAttribute('aria-label') === `Inspect ${name}`,
        );
        const chip = slot?.querySelector('.hand-card-slot__choose-mana');
        if (!chip) return false;
        chip.click();
        return true;
      },
      /** The viewer's permanents, with their tapped marker (⤵). */
      mine: () => {
        const seat = [...document.querySelectorAll('.seat')].pop();
        return [...(seat?.querySelectorAll('[data-perm-id]') ?? [])].map((tile) => ({
          text: (tile.innerText ?? '').replace(/\n+/g, ' '),
          tapped: (tile.innerText ?? '').includes('⤵') || tile.className.includes('tapped'),
        }));
      },
      /** The picker dialog's live readout, or null when it is not open. */
      picker: () => {
        const owed = document.querySelector('.mana-picker__owed');
        if (!owed) return null;
        return {
          owed: owed.textContent,
          rows: [...document.querySelectorAll('.mana-picker__sources button')].map((b) => ({
            label: b.textContent,
            spent: b.disabled,
          })),
          confirmEnabled: [...document.querySelectorAll('.mana-picker button')].some(
            (b) => /Confirm/.test(b.textContent ?? '') && !b.disabled,
          ),
        };
      },
      /** The action bar's persisted "choose mana" toggle. */
      toggle: () =>
        [...document.querySelectorAll('.action-bar button')].find((b) => /mana/i.test(b.textContent ?? '')) ?? null,
      seatText: (name) => seatOf(name)?.innerText ?? '',
      phase: () =>
        [...document.querySelectorAll('*')].filter((e) => e.children.length === 0 && /Turn \d+ ·/.test(e.textContent))[0]
          ?.textContent ?? '',
    };
  });
}

async function shot(page, name) {
  const path = resolve(OUT_DIR, name);
  await page.screenshot({ path, fullPage: false });
  console.log(`  shot  ${path}`);
  return path;
}

/** Pass until it is the viewer's main phase again (the pilot plays its side). */
async function toMyMain(page) {
  for (let i = 0; i < TURN_BUDGET; i++) {
    await installProbes(page);
    const phase = await page.evaluate(() => window.__mc.phase());
    if (/Main Phase 1/.test(phase) && /Player 1's turn/.test(phase)) return phase;
    if (/wins the game/.test(await page.evaluate(() => document.body.innerText))) return null;
    await clickButton(page, /Pass \/ advance|Pass priority/, { timeoutMs: 4000 });
    await sleep(AI_BEAT_MS);
  }
  return null;
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const chrome = findChrome();
  if (!chrome) throw new Error(describeChromeSearch());
  const preview = await startPreview();
  const browser = await puppeteer.launch({
    executablePath: chrome,
    headless: true,
    args: ['--no-first-run', '--disable-features=Translate'],
  });
  try {
    const page = await browser.newPage();
    await page.setViewport(VIEWPORT);
    page.on('pageerror', (err) => console.log('  pageerror:', String(err).slice(0, 200)));

    // `domcontentloaded`, never `networkidle2`: the landing view pulls hundreds
    // of Scryfall images, so "the network went quiet" depends on an external host.
    await page.goto(preview.url, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.app__nav', { timeout: APP_SHELL_WAIT_MS });

    // ---- a Mono-Green Ramp solo game (the deck with the mana creatures) --------
    await clickButton(page, /^Play$/);
    await clickButton(page, /Solo \(vs the computer\)/);
    check('solo setup reached', await textPresent(page, /Start game/));
    await page.evaluate(() => {
      const select = [...document.querySelectorAll('select')].find((s) =>
        [...s.options].some((o) => /Mono-Green Ramp/.test(o.textContent ?? '')),
      );
      const option = [...select.options].find((o) => /Mono-Green Ramp/.test(o.textContent ?? ''));
      const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
      setter.call(select, option.value);
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await clickButton(page, /^Start game$/);
    check('mulligan screen shown', await textPresent(page, /Keep \(/));
    await clickButton(page, /^Keep \(/);
    await clickButton(page, /^Confirm bottom/, { timeoutMs: 1500 });
    await page.waitForSelector('.action-bar', { timeout: UI_TRANSITION_WAIT_MS });
    await installProbes(page);

    // ---- the persisted setting is reachable from the action bar -----------------
    const toggleText = await page.evaluate(() => window.__mc.toggle()?.textContent ?? null);
    check('the "choose mana" toggle is in the action bar', toggleText !== null, toggleText ?? 'missing');

    // ---- arrange the reported board: a Forest AND a mana creature, both untapped
    // Played, never poked: lands from hand, then the Mystic cast off the first one.
    let arranged = false;
    for (let turn = 0; turn < TURN_BUDGET && !arranged; turn++) {
      const phase = await toMyMain(page);
      if (phase === null) break;
      await installProbes(page);
      // One land per turn (the engine refuses a second), then the mana creature.
      await page.evaluate(() => window.__mc.play('Forest'));
      await sleep(300);
      await installProbes(page);
      const mine = await page.evaluate(() => window.__mc.mine().map((p) => p.text).join(' ~ '));
      if (!/Elvish Mystic|Llanowar Elves/.test(mine)) {
        await page.evaluate(() => window.__mc.play('Elvish Mystic') || window.__mc.play('Llanowar Elves'));
        await sleep(600);
      }
      await installProbes(page);
      // Ready when a mana creature and at least one Forest are BOTH untapped and
      // the hand still holds a {G} spell to spend one of them on.
      const state = await page.evaluate(() => ({
        mine: window.__mc.mine(),
        hand: window.__mc.hand(),
      }));
      const untappedCreature = state.mine.some((p) => /Elvish Mystic|Llanowar Elves/.test(p.text) && !p.tapped);
      const untappedForest = state.mine.some((p) => /Forest/.test(p.text) && !p.tapped);
      const chipCard = state.hand.find((c) => c.chip);
      arranged = untappedCreature && untappedForest && chipCard !== undefined;
      if (!arranged) {
        await clickButton(page, /Pass \/ advance|Pass priority/, { timeoutMs: 4000 });
        await sleep(AI_BEAT_MS);
      }
    }
    check('a board with an untapped mana creature AND an untapped Forest was reached', arranged);
    if (!arranged) throw new Error('could not arrange the reported board');

    await installProbes(page);
    const before = await page.evaluate(() => ({ mine: window.__mc.mine(), hand: window.__mc.hand() }));
    await shot(page, '01-board-with-chip.png');

    // ---- ONLY WHEN THE CHOICE IS REAL ------------------------------------------
    // The {G} spell can be paid by the Forest OR the Mystic → chip. A {1}{G}
    // spell on a two-source board needs BOTH → no choice → no chip.
    const chipped = before.hand.filter((c) => c.chip).map((c) => c.name);
    const unchipped = before.hand.filter((c) => !c.chip).map((c) => c.name);
    check('the ⛁ chip is offered on a cast with a genuine choice', chipped.length > 0, chipped.join(', '));
    check(
      'the ⛁ chip is NOT offered on every card (no nag)',
      unchipped.length > 0,
      `${unchipped.length} cards without it`,
    );

    // ---- THE HEADLINE FIX: auto-tap spends the Forest, not the mana creature ----
    const target = chipped[0];
    check('auto-tap: cast clicked', await page.evaluate((n) => window.__mc.play(n), target));
    await sleep(700);
    await installProbes(page);
    const afterAuto = await page.evaluate(() => window.__mc.mine());
    const creatureTapped = afterAuto.some((p) => /Elvish Mystic|Llanowar Elves/.test(p.text) && p.tapped);
    const forestTapped = afterAuto.some((p) => /Forest/.test(p.text) && p.tapped);
    check('auto-tap spent a Forest', forestTapped);
    check('auto-tap did NOT spend the mana creature — it can still block', !creatureTapped);
    await shot(page, '02-after-auto-tap.png');

    // ---- THE PICKER: open, read, cancel cleanly ---------------------------------
    // Get back to a board with the choice available (a fresh turn untaps).
    let reopened = false;
    for (let turn = 0; turn < TURN_BUDGET && !reopened; turn++) {
      const phase = await toMyMain(page);
      if (phase === null) break;
      await installProbes(page);
      await page.evaluate(() => window.__mc.play('Forest'));
      await sleep(300);
      await installProbes(page);
      // The choice needs a mana CREATURE on the board beside the Forests. The
      // scripted game used to keep its Mystic alive; a stronger opponent now
      // kills it, and from then on every source is a Forest and there is —
      // correctly — nothing to choose. So keep the board arranged by PLAYING:
      // if no mana creature is out and one is in hand, cast it now, and the
      // chip shows on the next {G} spell once everything untaps.
      const board = await page.evaluate(() => window.__mc.mine());
      if (!board.some((perm) => MANA_CREATURES.test(perm.text))) {
        const inHand = (await page.evaluate(() => window.__mc.hand())).find((c) => MANA_CREATURES.test(c.name ?? ''));
        if (inHand) {
          await page.evaluate((n) => window.__mc.play(n), inHand.name);
          await sleep(400);
          await installProbes(page);
        }
      }
      const hand = await page.evaluate(() => window.__mc.hand());
      const chipCard = hand.find((c) => c.chip);
      if (chipCard) {
        reopened = await page.evaluate((n) => window.__mc.chooseMana(n), chipCard.name);
        await sleep(400);
      } else {
        // A miss must be DIAGNOSABLE from the log alone — in CI there is no one
        // to open the screenshot. Say what was in hand and on the board.
        const mine = await page.evaluate(() => window.__mc.mine());
        console.log(
          `  no ⛁ chip at "${phase}" — hand: ${hand.map((c) => c.name).join(', ') || '(empty)'}; ` +
            `mine: ${mine.map((p) => `${p.text}${p.tapped ? ' (tapped)' : ''}`).join(', ') || '(none)'}`,
        );
      }
      if (!reopened) {
        await clickButton(page, /Pass \/ advance|Pass priority/, { timeoutMs: 4000 });
        await sleep(AI_BEAT_MS);
      }
    }
    check('the ⛁ chip opens the mana picker', reopened);
    if (reopened) {
      await installProbes(page);
      const opened = await page.evaluate(() => window.__mc.picker());
      check('the picker shows a live "still needed" readout', /Still needed/.test(opened?.owed ?? ''), opened?.owed ?? '');
      check('the picker lists the sources to choose from', (opened?.rows.length ?? 0) > 1, `${opened?.rows.length} rows`);
      check('Confirm is disabled while the cost is unpaid', opened?.confirmEnabled === false);
      await shot(page, '03-picker-open.png');

      // Click one source: the readout must count DOWN by what that source made.
      const owedBefore = opened?.owed ?? '';
      await page.evaluate(() => {
        document.querySelector('.mana-picker__sources button:not(:disabled)')?.click();
      });
      await sleep(400);
      await installProbes(page);
      const partway = await page.evaluate(() => window.__mc.picker());
      check(
        'clicking a source counts the cost down',
        partway !== null && partway.owed !== owedBefore,
        `${owedBefore} → ${partway?.owed ?? 'closed'}`,
      );
      check('a spent source stays in the list, disabled', (partway?.rows ?? []).some((r) => r.spent));

      // Keep paying until the pool covers it. The spell may cost four mana; one
      // click is one source, so "Confirm arms" is a statement about the FULL
      // payment, not about the first tap.
      for (let i = 0; i < 8; i++) {
        await installProbes(page);
        const now = await page.evaluate(() => window.__mc.picker());
        if (now === null || now.confirmEnabled) break;
        const clicked = await page.evaluate(() => {
          const row = document.querySelector('.mana-picker__sources button:not(:disabled)');
          if (!row) return false;
          row.click();
          return true;
        });
        if (!clicked) break;
        await sleep(350);
      }
      await installProbes(page);
      const funded = await page.evaluate(() => window.__mc.picker());
      check(
        'Confirm arms once the pool covers the cost',
        funded?.confirmEnabled === true,
        funded?.owed ?? 'closed',
      );
      await shot(page, '04-picker-funded.png');

      // CANCEL must roll back completely: no land tapped, the card still in hand.
      const handBefore = await page.evaluate(() => window.__mc.hand().map((c) => c.name).join('|'));
      await clickButton(page, /^Cancel$/, { timeoutMs: 4000 });
      await sleep(400);
      await installProbes(page);
      const afterCancel = await page.evaluate(() => ({
        picker: window.__mc.picker(),
        mine: window.__mc.mine(),
        hand: window.__mc.hand().map((c) => c.name).join('|'),
      }));
      check('Cancel closes the picker', afterCancel.picker === null);
      check(
        'Cancel leaves every source UNTAPPED — the taps were never committed',
        afterCancel.mine.every((p) => !p.tapped),
        afterCancel.mine.filter((p) => p.tapped).map((p) => p.text).join(', ') || 'all untapped',
      );
      check('Cancel leaves the hand unchanged', afterCancel.hand === handBefore);
      await shot(page, '05-after-cancel.png');
    }
  } finally {
    await browser.close().catch(() => {});
    preview.child.kill();
  }

  const failed = checks.filter((c) => !c.passed);
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
  return failed.length === 0 ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error('could not run:', err instanceof Error ? err.message : String(err));
    process.exit(2);
  },
);

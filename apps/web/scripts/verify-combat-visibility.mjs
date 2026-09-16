#!/usr/bin/env node
/**
 * Drive the BUILT app in a real Chrome and prove the §10 promise: COMBAT IS ON
 * SCREEN LONG ENOUGH TO SEE IT.
 *
 * ## The measurement this harness is the guard for
 *
 * UX-13 (the blocker advances to meet its attacker) and UX-15 (damage travels
 * from source to recipient) were built, unit-tested and green, and NOBODY HAD
 * EVER SEEN EITHER. A rig drove a real game to a real blocked combat and, 260 ms
 * after clicking "Confirm 1 block" — deliberately without passing priority —
 * sampled:
 *
 *     BLOCKS CONFIRMED | blocking=0 staged=0 arcs=0 | Turn 7 · Main Phase 1
 *
 * Blocks, combat damage and end-of-combat had all resolved and the turn had
 * advanced, with no input at all. A 24-frame watch at 45 ms intervals never once
 * saw a blocker staged. The game log confirmed the combat itself was correct:
 * the code was right and the state it draws from lasted a few milliseconds.
 *
 * ## Why this is a rig and not a unit test
 *
 * No unit test can see "this state existed for 200 ms". `combat-hold.test.ts`
 * pins WHICH combat moments hold and why; only a real browser driving a real
 * game can answer "was it still there when a human looked?". That is the only
 * guard shape that would have caught the failure above — this file measures the
 * exact three things that measured ZERO.
 *
 * ## What it asserts, after Confirm and WITHOUT passing priority
 *
 *   1. A BLOCKER IS STAGED — `.combat-stage__tile--blocker` exists, i.e. the
 *      card walked out to meet its attacker and was still out when sampled.
 *   2. THE BLOCK GOT ITS ARC — the count of DECLARED arcs (the halo layer, which
 *      only committed pairs get) grew by at least the number of blocks confirmed.
 *   3. THE DAMAGE LANDS ON THE COMBAT BOARD — `.dmg-layer` mounts with at least
 *      one impact IN A FRAME THAT IS STILL IN COMBAT. The layer alone proves
 *      nothing and this harness measured that directly: before the fix it mounted
 *      happily at `Turn 7 · Main Phase 1`, two steps past the combat it was
 *      describing, with every attacker home and every arc gone. A hit has to
 *      travel from a source tile that still exists.
 *
 * Plus the mechanism itself: the board says it is holding (`.combat-hold`), for
 * both beats.
 *
 * ## The rig ARRANGES the state it needs — five earlier iterations did not
 *
 * Every one of these was a rig bug that looked exactly like a broken app:
 *   - It must DEPLOY CREATURES, not only lands. Clicking the first playable card
 *     plays a land almost every time, so the defender reached Declare Blockers
 *     with an empty battlefield and the board correctly said "You have no
 *     creatures to block with".
 *   - It must NOT ATTACK. A creature that attacked on our turn is still tapped
 *     when the opponent swings back, so attacking is precisely how the rig kept
 *     arriving at Declare Blockers with nothing able to block.
 *   - It drives blocking off THE ACTION BAR'S OWN WORDS, never off inferred DOM
 *     state: "no creatures to block with" is a fact about the game and the same
 *     sentence a player reads.
 *   - It CONFIRMS. `.perm--blocking` comes from the engine's combat state, which
 *     is only written once blocks are DECLARED; an earlier run assigned two
 *     blockers, sat on "Confirm 2 blocks" and hit its iteration cap.
 *
 * Screenshots land in verify-out/combat-visibility/ inside the worktree.
 * Exit 0 = every check passed; 1 = a check failed; 2 = could not run.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import { describeChromeSearch, findChrome } from './lib/find-chrome.mjs';
import { harnessLaunchOptions } from './lib/harness-chrome.mjs';
import { watchPageErrors } from './lib/harness-page.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = resolve(HERE, '..');
const OUT_DIR = resolve(WEB_ROOT, 'verify-out', 'combat-visibility');

/**
 * A window big enough that both seats, the midline and the hand are on screen at
 * once — the combat stage paints at MEASURED viewport coordinates, and a tile in
 * a band scrolled out of view measures as nothing and is deliberately not staged
 * (see `homeRectOf` in CombatStage.tsx). 1440x1100 is the same "tall" window
 * `verify-board-fits.mjs` uses.
 */
const VIEWPORT = Object.freeze({ width: 1440, height: 1100 });

/**
 * How long to wait for the app SHELL after a navigation — and why it is not
 * puppeteer's unnamed 30 s default.
 *
 * §3.146's gate instrumented time-to-shell and found it BIMODAL: ~7.8 s when the
 * landing view's Scryfall art is cached, ~38.9 s when it is not (the landing
 * view is the card browser, which fetches hundreds of cross-origin images).
 * Against the default this harness would be a coin flip that reports the APP as
 * broken when the NETWORK is slow. 90 s matches `APP_SHELL_WAIT_MS` in the other
 * harnesses — one budget for one question, pinned by
 * `src/components/harness-wait-budgets.test.ts`.
 */
const APP_SHELL_WAIT_MS = 90_000;

/**
 * Waits for an IN-APP transition (a menu opening, the board mounting) once the
 * shell is already up. Kept separate from {@link APP_SHELL_WAIT_MS} on purpose:
 * these do not touch the network, so a long budget here would only turn a real
 * hang into a slow one.
 */
const UI_TRANSITION_WAIT_MS = 20_000;

/** Longer than `HOTSEAT_CONFIG.aiThinkMs` (450), so the computer has moved. */
const AI_BEAT_MS = 700;

/** Pause between driving steps. Short: the rig is trying to reach a combat, not watch one. */
const DRIVE_TICK_MS = 70;

/** Hard caps on the hunt for a blocked combat — a rig must never run forever. */
const DRIVE_STEPS = 1_500;
const DRIVE_BUDGET_MS = 240_000;

/**
 * THE WATCH. After Confirm the rig touches NOTHING: the whole question is
 * whether the board holds itself still, so a rig that clicks "Pass / advance"
 * while filming is rushing past the very thing it came to see (an earlier run
 * did exactly that and landed on a card-draw two turns later).
 *
 * The window covers BOTH beats — the blocks-declared hold, then the damage hold
 * behind it — with slack, so a failure is "it was never there" rather than "we
 * stopped looking too early". It is a CEILING, not a sleep: the loop exits as
 * soon as it has seen everything it is looking for.
 */
const WATCH_BUDGET_MS = 6_000;
const WATCH_SAMPLE_MS = 60;

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
  const child = spawn(
    process.execPath,
    [viteBin(), 'preview', '--port', String(port), '--strictPort'],
    { cwd: WEB_ROOT, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  const deadline = Date.now() + APP_SHELL_WAIT_MS;
  while (Date.now() < deadline) {
    if (await isUp(url)) return { child, url };
    await sleep(300);
  }
  child.kill();
  throw new Error('vite preview did not answer in time');
}

async function clickButton(page, pattern, { timeoutMs = UI_TRANSITION_WAIT_MS } = {}) {
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

async function shot(page, name) {
  mkdirSync(OUT_DIR, { recursive: true });
  await page.screenshot({ path: resolve(OUT_DIR, name) });
}

/**
 * THE ONE PLACE THE BOARD IS MEASURED. Every assertion below reads this, so a
 * selector change breaks one function rather than six checks — and every miss
 * can print the whole picture it saw, which is what the earlier rigs could not
 * do (three rig bugs in a row looked exactly like a broken app).
 */
async function sample(page) {
  return page.evaluate(() => {
    const count = (selector) => document.querySelectorAll(selector).length;
    const text = (selector) => (document.querySelector(selector)?.textContent ?? '').trim();
    const confirmButton = [...document.querySelectorAll('button')].find(
      (b) => /^Confirm \d+ block/.test(b.textContent?.trim() ?? '') && !b.disabled,
    );
    return {
      ended: count('.end-screen') > 0,
      status: text('.play-board__status').replace(/\s+/g, ' ').slice(0, 70),
      hint: text('.action-bar').replace(/\s+/g, ' ').slice(0, 120),
      // UX-12/13 — the unclipped layer the advanced cards are painted in.
      staged: count('.combat-stage__tile'),
      stagedBlockers: count('.combat-stage__tile--blocker'),
      // UX-14 — the halo layer is drawn ONLY for a DECLARED pair (CombatLines
      // paints `segment.declared ? <path/> : null`), so it is the one count that
      // can tell a committed block from a half-built draft.
      declaredArcs: count('.combat-arcs__halo path'),
      arcs: count('.combat-arcs__body path'),
      // The engine's own combat classes on the in-flow tiles.
      attacking: count('.perm--attacking'),
      blocking: count('.perm--blocking'),
      // UX-15 — the damage sequence, actually mounted.
      damageLayers: count('.dmg-layer'),
      damageImpacts: count('.dmg-impact'),
      damageBolts: count('.dmg-bolt'),
      // §10 — the beat itself, and which one.
      holds: count('.combat-hold'),
      blocksHolds: count('.combat-hold--blocksDeclared'),
      damageHolds: count('.combat-hold--damage'),
      confirmLabel: confirmButton ? (confirmButton.textContent ?? '').trim() : null,
    };
  });
}

/** One line describing everything the board was showing — printed on every miss. */
function describeSample(s) {
  return (
    `staged=${s.staged} (blockers ${s.stagedBlockers}) declaredArcs=${s.declaredArcs} ` +
    `arcs=${s.arcs} blocking=${s.blocking} attacking=${s.attacking} ` +
    `dmgLayer=${s.damageLayers} impacts=${s.damageImpacts} bolts=${s.damageBolts} ` +
    `holds=${s.holds} | ${s.status}`
  );
}

/** Start a Solo game on a fixed deck and keep the opening hand. */
async function startSoloGame(page, url) {
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('button.nav-link', { timeout: APP_SHELL_WAIT_MS });
  await page.evaluate(() => {
    // A saved game would open the resume banner instead of the setup screen.
    try {
      localStorage.removeItem('jonny-boi.play.inProgress.v1');
    } catch {
      /* private mode — there was nothing to clear anyway */
    }
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('button.nav-link', { timeout: APP_SHELL_WAIT_MS });
  await clickButton(page, /^Play$/);
  await clickButton(page, /Solo \(vs the computer\)/);
  await page.waitForSelector('select', { timeout: UI_TRANSITION_WAIT_MS });
  await page.evaluate(() => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
    const select = document.querySelectorAll('select')[0];
    setter.call(select, 'sample:Selesnya Blink');
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await clickButton(page, /^Start game$/);
  await clickButton(page, /^Keep \(/, { timeoutMs: UI_TRANSITION_WAIT_MS });
  await page.waitForSelector('.play-board', { timeout: UI_TRANSITION_WAIT_MS });
  await sleep(AI_BEAT_MS);
}

/**
 * ONE driving step, run inside the page. Returns what it did, so the outer loop
 * can report how the rig spent its budget instead of only "it never got there".
 *
 * The whole of this function is the "arrange the state" discipline described in
 * the file header — it is deliberately NOT a generic "click the first enabled
 * button" walker, because that is what produced four runs that never reached a
 * block.
 */
async function driveOneStep(page) {
  return page.evaluate(() => {
    const status = document.querySelector('.play-board__status')?.textContent ?? '';
    const bar = document.querySelector('.action-bar')?.textContent ?? '';
    const enabled = (el) => el && !el.disabled;

    if (/Declare Blockers/i.test(status)) {
      // DRIVE OFF THE APP'S OWN WORDS. "no creatures to block with" is a fact
      // about the game, not a bug — take the pass and wait for a later combat.
      if (!/no creatures to block with/i.test(bar)) {
        const confirm = [...document.querySelectorAll('button')].find(
          (b) => /^Confirm \d+ block/.test(b.textContent?.trim() ?? '') && !b.disabled,
        );
        const attackers = [...document.querySelectorAll('button.perm--attacking')].filter(enabled);
        const armed = document.querySelector('button.perm--attacking[aria-pressed="true"]');
        const mine = [...document.querySelectorAll('button.perm')].filter(
          (p) =>
            enabled(p) &&
            !p.className.includes('perm--attacking') &&
            !p.className.includes('perm--tapped'),
        );
        // One block is all this harness needs, and a second one only makes the
        // picture harder to assert about. Confirm as soon as there is one.
        if (confirm) return { did: 'confirm-ready', label: confirm.textContent?.trim() ?? '' };
        if (!armed && attackers.length) {
          attackers[0].click();
          return { did: 'arm-attacker' };
        }
        if (armed && mine.length) {
          const free = mine.find((p) => p.getAttribute('aria-pressed') !== 'true');
          if (free) {
            free.click();
            return { did: 'assign-blocker' };
          }
        }
      }
    }

    // CREATURES FIRST. Playing `playable[0]` plays a land almost every time, and
    // a defender with no creatures is a defender who cannot block.
    const hand = [...document.querySelectorAll('.play-hand')].find(
      (h) => !h.className.includes('hidden'),
    );
    const playable = hand ? [...hand.querySelectorAll('button.play-card--actionable')] : [];
    if (playable.length) {
      const isLand = (b) =>
        /(^|\s)Land(\s|$)/.test(b.querySelector('.play-card__badge')?.textContent ?? '') ||
        /Basic Land/.test(b.textContent ?? '');
      const creature = playable.find((b) => !isLand(b));
      (creature ?? playable[0]).click();
      return { did: creature ? 'play-creature' : 'play-land' };
    }

    // NEVER ATTACK — see the header. `Attack with` is deliberately absent from
    // this pattern, and a creature that attacked is tapped when we need it.
    const next = [...document.querySelectorAll('button')].find(
      (b) =>
        /Pass \/ advance|Pass priority|No blocks|^Confirm|Let it resolve|Resolve|Skip/.test(
          b.textContent ?? '',
        ) && !b.disabled,
    );
    if (next) {
      next.click();
      return { did: 'advance' };
    }
    return { did: 'nothing' };
  });
}

/**
 * Play until the board offers "Confirm N block(s)". Returns the picture the
 * moment before Confirm is pressed — the arc baseline the delta below is
 * measured against — or a report of how the budget was spent.
 */
async function reachAConfirmedBlock(page) {
  const spent = { declareBlockers: 0, noBlockers: 0, creatures: 0, lands: 0, advances: 0 };
  const deadline = Date.now() + DRIVE_BUDGET_MS;
  for (let step = 0; step < DRIVE_STEPS && Date.now() < deadline; step++) {
    const before = await sample(page);
    if (before.ended) return { reached: false, why: 'the game ended first', spent, last: before };
    if (before.confirmLabel) return { reached: true, baseline: before, spent };
    if (/Declare Blockers/i.test(before.status)) spent.declareBlockers += 1;
    if (/no creatures to block with/i.test(before.hint)) spent.noBlockers += 1;

    const acted = await driveOneStep(page);
    if (acted.did === 'play-creature') spent.creatures += 1;
    if (acted.did === 'play-land') spent.lands += 1;
    if (acted.did === 'advance') spent.advances += 1;
    await sleep(DRIVE_TICK_MS);
  }
  return { reached: false, why: 'ran out of steps', spent, last: await sample(page) };
}

/**
 * Press Confirm and then WATCH, touching nothing. Returns the best (maximum)
 * value seen for each signal, plus the first sample, so a miss can report both
 * "never" and "what was there instead".
 */
async function watchAfterConfirm(page) {
  const confirmed = await page.evaluate(() => {
    const b = [...document.querySelectorAll('button')].find(
      (x) => /^Confirm \d+ block/.test(x.textContent?.trim() ?? '') && !x.disabled,
    );
    if (!b) return null;
    const label = b.textContent?.trim() ?? '';
    b.click();
    return Number(label.match(/\d+/)?.[0] ?? '0');
  });

  const best = {
    stagedBlockers: 0,
    declaredArcs: 0,
    damageLayers: 0,
    damageImpacts: 0,
    blocksHolds: 0,
    damageHolds: 0,
  };
  let first = null;
  let atBestStage = null;
  /** The first frame where damage is blooming AND the board is still in combat. */
  let atDamageInCombat = null;
  /** The first frame where damage is blooming at all — the honest "what we got instead". */
  let atAnyDamage = null;
  const deadline = Date.now() + WATCH_BUDGET_MS;
  while (Date.now() < deadline) {
    const now = await sample(page);
    if (first === null) first = now;
    for (const key of Object.keys(best)) {
      if (now[key] > best[key]) best[key] = now[key];
    }
    if (now.stagedBlockers > 0 && atBestStage === null) {
      atBestStage = now;
      await shot(page, '02-blocker-advanced.png');
    }
    if (now.damageImpacts > 0 && atAnyDamage === null) atAnyDamage = now;
    if (now.damageImpacts > 0 && stillInCombat(now) && atDamageInCombat === null) {
      atDamageInCombat = now;
      await shot(page, '03-damage-on-the-combat-board.png');
    }
    if (atBestStage !== null && atDamageInCombat !== null) break;
    await sleep(WATCH_SAMPLE_MS);
  }
  return { blocksConfirmed: confirmed, best, first, atBestStage, atDamageInCombat, atAnyDamage };
}

/**
 * Is this frame still showing the combat the damage belongs to?
 *
 * Either the board says so (the combat-damage step is on the status line) or the
 * arcs are still painted — both are read off `state.combat`, which is exactly the
 * state that was gone by the time anybody looked. Before the fix this was FALSE
 * in every frame: the damage bloomed at `Turn 7 · Main Phase 1`.
 */
function stillInCombat(s) {
  return s.declaredArcs > 0 || /Combat Damage|Declare Blockers/i.test(s.status);
}

async function main() {
  const chrome = findChrome();
  if (!chrome) throw new Error(describeChromeSearch());
  const preview = await startPreview();
  const browser = await puppeteer.launch(
    harnessLaunchOptions({ chromePath: chrome, windowSize: VIEWPORT }),
  );

  try {
    const page = await browser.newPage();
    const watcher = watchPageErrors(page);
    await page.setViewport(VIEWPORT);
    await startSoloGame(page, preview.url);

    const arrival = await reachAConfirmedBlock(page);
    check(
      'the rig reached a blocked combat it can confirm',
      arrival.reached === true,
      arrival.reached
        ? arrival.baseline.confirmLabel
        : `${arrival.why}: declare-blockers windows ${arrival.spent.declareBlockers}, ` +
          `"no creatures to block with" ${arrival.spent.noBlockers}, creatures played ` +
          `${arrival.spent.creatures}, lands ${arrival.spent.lands} | ${describeSample(arrival.last)}`,
    );
    if (!arrival.reached) return 1;

    await shot(page, '01-blocks-drafted.png');
    const baseline = arrival.baseline;
    const watch = await watchAfterConfirm(page);
    const seen = watch.atBestStage ?? watch.atDamageInCombat ?? watch.first;
    const signed = (n) => `${n >= 0 ? '+' : ''}${n}`;

    // 1 — THE HEADLINE. This is the exact number that measured ZERO.
    check(
      'a BLOCKER IS STAGED after Confirm — UX-13 is on screen, not just computed',
      watch.best.stagedBlockers > 0,
      `best stagedBlockers=${watch.best.stagedBlockers} over ${WATCH_BUDGET_MS}ms | first frame: ${describeSample(watch.first)}`,
    );

    // 2 — the declared pair got its arc. A DELTA, because attack arcs are
    // already declared before Confirm and only the block arc is new.
    const arcGrowth = watch.best.declaredArcs - baseline.declaredArcs;
    check(
      'the confirmed block gets a DECLARED arc — UX-14 pairs the two cards',
      arcGrowth >= watch.blocksConfirmed && watch.blocksConfirmed > 0,
      `declared arcs ${baseline.declaredArcs} → ${watch.best.declaredArcs} ` +
        `(${signed(arcGrowth)}) for ${watch.blocksConfirmed} confirmed block(s) | ${describeSample(seen)}`,
    );

    // 3 — the damage sequence plays WHERE THE PLAYER IS LOOKING. `dmgLayer > 0`
    // alone is not the claim and this harness measured why: before the fix the
    // layer mounted at Main Phase 1 of the next turn, with the combat it was
    // describing already dismantled.
    check(
      'the DAMAGE LANDS ON THE COMBAT BOARD — UX-15 plays while combat is still on screen',
      watch.atDamageInCombat !== null,
      watch.atDamageInCombat !== null
        ? describeSample(watch.atDamageInCombat)
        : `damage bloomed ${watch.atAnyDamage ? 'only after combat was gone' : 'not at all'} | ` +
          `${describeSample(watch.atAnyDamage ?? seen)}`,
    );

    // 4 — the mechanism. Both beats must actually be spent; a run where only one
    // fires is the half-done version of this fix.
    check(
      'the board announces the blocks-declared beat',
      watch.best.blocksHolds > 0,
      `blocksHolds=${watch.best.blocksHolds} | ${describeSample(seen)}`,
    );
    check(
      'the board announces the damage beat',
      watch.best.damageHolds > 0,
      `damageHolds=${watch.best.damageHolds} | ${describeSample(watch.atDamageInCombat ?? seen)}`,
    );

    await shot(page, '99-final.png');
    // ⚠️ THE APP ITSELF, before anything above is believed. A harness with no
    // pageerror listener cannot tell "the app crashed" from "the thing I was
    // measuring is not there", and it always reports the second - that is how a
    // React #185 crash in the card grid got filed as "8 cards are missing from
    // the browser". See lib/harness-page.mjs.
    check(
      'the app threw nothing while the harness drove it',
      watcher.errors.length === 0,
      watcher.errors.slice(0, 2).join(' | '),
    );
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

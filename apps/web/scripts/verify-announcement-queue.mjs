#!/usr/bin/env node
/**
 * PHOTOGRAPH THE REPORTED FRAME: two announcements due at once.
 *
 * Caleb: *"we are getting some overriding overlays in app that look bad - like
 * 'heres what goblin guide revealed from your library' and 'heres what the
 * computer casted' - those should reconcile somehow"*.
 *
 * That is the exact pair this rig arranges — a Goblin Guide reveal and an
 * opponent's cast — and the exact pair that used to paint over each other:
 * `.reveal-banner` was `position: fixed; top: 12%; z-index: 70` and
 * `.spell-hold` a centred card capped at `calc(100vh - 2rem)`, so the card
 * covered the banner outright.
 *
 * ## Why a rig and not a test
 *
 * `announcement-queue.test.ts` renders the surface with stub bodies and proves
 * exactly one mounts. It cannot prove the two announcements ever COINCIDE in a
 * real game, and it cannot prove the survivor is legible. Ten items on this
 * branch have been green and unreachable; a passing test is not evidence that
 * two banners no longer overlap.
 *
 * ## The arrangement
 *
 *  - **The computer**: 4 Goblin Guide + 4 Doom Blade + 52 basics. The Guide's
 *    attack trigger reveals the top card of the DEFENDING player's library —
 *    the reported reveal, aimed at the viewer — and the Doom Blade is the
 *    reported cast.
 *  - **You**: 4 Grizzly Bears + 56 Forest, so the removal has something to kill
 *    and the board is never empty.
 *
 * The rig then samples the board every few frames and stops on the first frame
 * where the ONE announcement surface is up AND is reporting a waiter — i.e. two
 * announcements were due and the queue reconciled them. It photographs that
 * frame and asserts there is exactly one announcement body in it.
 *
 * Screenshots land in verify-out/announcement-queue/ inside the worktree.
 * Exit 0 = every check passed; 1 = a check failed; 2 = could not run.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import { describeChromeSearch, findChrome } from './lib/find-chrome.mjs';
import { harnessLaunchOptions } from './lib/harness-chrome.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = resolve(HERE, '..');
const OUT_DIR = resolve(WEB_ROOT, 'verify-out', 'announcement-queue');

/** The same tall window the other two board harnesses use. */
const VIEWPORT = Object.freeze({ width: 1440, height: 1100 });

/** Matches `APP_SHELL_WAIT_MS` in the sibling harnesses — see their note on the bimodal shell. */
const APP_SHELL_WAIT_MS = 90_000;
const UI_TRANSITION_WAIT_MS = 20_000;

/** Longer than `HOTSEAT_CONFIG.aiThinkMs` (450), so the computer has moved. */
const AI_BEAT_MS = 700;
const DRIVE_TICK_MS = 80;
const DRIVE_STEPS = 1_200;
const DRIVE_BUDGET_MS = 240_000;

/**
 * THE WATCH. After the priest is cast the rig touches nothing: the question is
 * whether the board holds the announcement still. Comfortably longer than
 * `FORCED_CHOICE_CONFIG.holdMs` (a board-read beat plus half a spell hold) so a
 * miss reads as "it was never there", not "we stopped looking too early".
 */
const WATCH_BUDGET_MS = 8_000;
const WATCH_SAMPLE_MS = 60;

/**
 * Let an announcement FINISH ARRIVING before measuring or photographing it.
 *
 * MEASURED: the first capture of the spell hold caught it mid-fade — every
 * element translucent, the card art not yet decoded, and a `getBoundingClientRect`
 * still mid-transform. A picture of a thing arriving is not a picture of the
 * thing, and "the rect fits" measured during a transform is not a measurement of
 * anything. Comfortably longer than `SPELL_HOLD_CONFIG.fadeMs` (220) and
 * `FORCED_CHOICE_CONFIG.fadeMs` (which derives from it), and well inside both
 * holds, so it never eats the state it came to see.
 */
const SETTLE_MS = 500;

/** Card ids, from the pool. Named so a pool re-id fails loudly here. */
const PLAINS = 'bc71ebf6-2056-41f7-be35-b2e5c34afa99';
const SWAMP = '56719f6a-1a6c-4c0a-8d21-18f7d7350b68';
const DOOM_BLADE = '59e7f2ae-4535-4191-98be-3e65b6b2befa';
const FOREST = 'b34bb2dc-c1af-4d77-b0b3-a0fb342a5fc6';
const BANISHER_PRIEST = '9f560b83-32d4-4bb4-a956-8f5db18599db';
const GRIZZLY_BEARS = '14c8f55d-d177-4c25-a931-ebeb9e6062a0';
const GOBLIN_GUIDE = '51d9564b-44fc-4de1-9119-09d7b4089378';
const MOUNTAIN = 'a3fb7228-e76b-4e96-a40e-20b5fed75685';

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
  const path = resolve(OUT_DIR, name);
  await page.screenshot({ path });
  // ⚠️ A screenshot that was never written, or written before this run, has been
  // accepted as proof in this repo before. Say the bytes and the age out loud.
  const stat = statSync(path);
  console.log(`  shot ${name} — ${stat.size} bytes, ${Date.now() - stat.mtimeMs} ms old`);
  return path;
}

/**
 * THE ONE PLACE THE BOARD IS MEASURED. Every assertion reads this, so a selector
 * change breaks one function rather than six checks, and a miss can print the
 * whole picture it saw.
 */
async function sample(page) {
  return page.evaluate(() => {
    const count = (s) => document.querySelectorAll(s).length;
    const text = (s) => (document.querySelector(s)?.textContent ?? '').trim();
    const named = (s) =>
      [...document.querySelectorAll(s)].map((e) => (e.textContent ?? '').trim()).filter(Boolean);
    const visibleHand = [...document.querySelectorAll('.play-hand')].find(
      (h) => !h.className.includes('hidden'),
    );
    const playable = visibleHand
      ? [...visibleHand.querySelectorAll('button.play-card--actionable')].map((b) =>
          // `title` FIRST, because that is what `PlayCard` puts the card's name
          // in and what `driveOneStep` matches on. Reading a different attribute
          // here made the run report `priestSeen: 0` in the same run that cast
          // one — a counter that disagrees with the driver is a counter that lies.
          (b.getAttribute('title') ?? b.getAttribute('aria-label') ?? b.textContent ?? '').trim(),
        )
      : [];
    return {
      status: text('.play-board__status'),
      hint: text('.action-bar'),
      playable,
      // The opponent's creatures. Counted by the tile's own printed NAME rather
      // than by a seat class, because the rig's own deck contains no Grizzly
      // Bears at all — so every one on the board is theirs, by construction.
      oppBears: [...document.querySelectorAll('.perm__name')].filter((n) =>
        /Grizzly Bears/i.test(n.textContent ?? ''),
      ).length,
      forced: count('.forced-choice'),
      forcedSource: text('.forced-choice__source'),
      forcedVerb: text('.forced-choice__verb'),
      forcedWords: text('.forced-choice__words'),
      forcedWhy: text('.forced-choice__why'),
      forcedFaces: count('.forced-choice .card-refs--face .play-card'),
      forcedRefNames: named('.forced-choice .stack-target__name'),
      forcedRole: document.querySelector('.forced-choice')?.getAttribute('role') ?? '',
      // The spell hold and its targets (the Doom Blade half of the report).
      hold: count('.spell-hold'),
      holdTargets: named('.spell-hold .stack-target__name'),
      holdFaces: count('.spell-hold .card-refs--face .play-card'),
      // What the STACK PANEL says the same object is aimed at. The hold and the
      // panel read one producer, so a disagreement between these two is a real
      // finding and not a rig quirk — worth printing on every miss.
      panelTargets: named('.stack-panel .stack-target__name'),
      holdHtml: (document.querySelector('.spell-hold')?.innerHTML ?? '').slice(0, 300),
      // ⚠️ ON SCREEN, not merely in the DOM. A fixed, centred panel has no parent
      // to bound it, and a real capture showed the target card clipped by the
      // viewport with both buttons below the fold — a hold nobody can finish
      // reading is the defect it exists to fix, wearing a new hat.
      holdFits: (() => {
        const el = document.querySelector('.spell-hold');
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return {
          top: Math.round(r.top),
          bottom: Math.round(r.bottom),
          viewport: window.innerHeight,
          inside: r.top >= 0 && r.bottom <= window.innerHeight,
        };
      })(),
      logLines: [...document.querySelectorAll('.game-log li, .game-log__line')]
        .map((e) => (e.textContent ?? '').trim())
        .slice(-14),
      ended: count('.play-end') > 0,
    };
  });
}

/** The two arrangements, as DATA — one row per report this rig photographs. */
const ARRANGEMENTS = Object.freeze({
  forcedChoice: Object.freeze({
    you: { id: 'rig-priest', name: 'Rig Priest', cards: [
      { cardId: BANISHER_PRIEST, count: 4 },
      { cardId: PLAINS, count: 56 },
    ] },
    them: { id: 'rig-bears', name: 'Rig Bears', cards: [
      { cardId: GRIZZLY_BEARS, count: 4 },
      { cardId: FOREST, count: 56 },
    ] },
  }),
  // The computer needs removal to cast AT something, and you need the something.
  spellHold: Object.freeze({
    you: { id: 'rig-bodies', name: 'Rig Bodies', cards: [
      { cardId: GRIZZLY_BEARS, count: 4 },
      { cardId: FOREST, count: 56 },
    ] },
    them: { id: 'rig-removal', name: 'Rig Removal', cards: [
      { cardId: DOOM_BLADE, count: 4 },
      { cardId: SWAMP, count: 56 },
    ] },
  }),
});

/** Seed two saved decks through the app's OWN persistence, then start Solo. */
async function startArrangedSoloGame(page, url, arrangement) {
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('button.nav-link', { timeout: APP_SHELL_WAIT_MS });
  await page.evaluate(
    (decks) => {
      try {
        localStorage.removeItem('jonny-boi.play.inProgress.v1');
        localStorage.setItem('jonny-boi.decks.v1', JSON.stringify(decks));
      } catch {
        /* private mode — the run will fail honestly at the deck menu */
      }
    },
    [
      { ...arrangement.you, updatedAt: new Date().toISOString() },
      { ...arrangement.them, updatedAt: new Date().toISOString() },
    ],
  );
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('button.nav-link', { timeout: APP_SHELL_WAIT_MS });
  await clickButton(page, /^Play$/);
  await clickButton(page, /Solo \(vs the computer\)/);
  await page.waitForSelector('select', { timeout: UI_TRANSITION_WAIT_MS });
  const picked = await page.evaluate(
    (yourName, theirName) => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
      const selects = [...document.querySelectorAll('select')];
      const pick = (select, name) => {
        const option = [...select.options].find((o) => (o.textContent ?? '').startsWith(name));
        if (!option) return null;
        setter.call(select, option.value);
        select.dispatchEvent(new Event('change', { bubbles: true }));
        return option.textContent;
      };
      return {
        a: pick(selects[0], yourName),
        b: pick(selects[1], theirName),
        options: [...(selects[0]?.options ?? [])].map((o) => o.textContent),
      };
    },
    arrangement.you.name,
    arrangement.them.name,
  );
  if (!picked.a || !picked.b) {
    throw new Error(`the seeded decks are not in the menu: ${JSON.stringify(picked.options)}`);
  }
  console.log(`  decks: you=${picked.a.trim()} | computer=${picked.b.trim()}`);
  const started = await clickButton(page, /^Start game$/);
  const kept = await clickButton(page, /^Keep \(/, { timeoutMs: UI_TRANSITION_WAIT_MS });
  try {
    await page.waitForSelector('.play-board', { timeout: UI_TRANSITION_WAIT_MS });
  } catch {
    // A rig that dies with "selector not found" is a rig that tells you nothing.
    // Say what the screen ACTUALLY shows — three earlier harnesses in this repo
    // reported the APP as broken when the RIG was lost.
    const seen = await page.evaluate(() => ({
      buttons: [...document.querySelectorAll('button')].map((b) => b.textContent?.trim()).slice(0, 25),
      body: (document.body.innerText ?? '').slice(0, 900),
    }));
    await shot(page, 'never-started.png');
    throw new Error(
      `the board never mounted (started=${started} kept=${kept}). buttons=${JSON.stringify(
        seen.buttons,
      )} body=${JSON.stringify(seen.body)}`,
    );
  }
  await sleep(AI_BEAT_MS);
}

/**
 * ONE driving step. Deliberately NOT a "click the first enabled button" walker:
 * the priest must be cast in a frame where the opponent controls EXACTLY ONE
 * creature, and nothing else about this game matters.
 */
async function driveOneStep(page, oppBears) {
  return page.evaluate((bears) => {
    const hand = [...document.querySelectorAll('.play-hand')].find(
      (h) => !h.className.includes('hidden'),
    );
    const playable = hand ? [...hand.querySelectorAll('button.play-card--actionable')] : [];
    const label = (b) => (b.getAttribute('title') ?? b.getAttribute('aria-label') ?? b.textContent ?? '');
    const priest = playable.find((b) => /Banisher Priest/i.test(label(b)));
    const land = playable.find((b) => /Plains/i.test(label(b)));

    // THE MOMENT. One opponent creature is exactly one legal target, which is
    // the report's situation and the only frame worth casting in.
    if (bears === 1 && priest) {
      priest.click();
      return { did: 'cast-priest' };
    }
    // A finished game is not a failure — the priest is 4 cards in 60 and a seed
    // that never deals one is an ordinary shuffle. Take a new seed and keep
    // playing until the budget says stop. (Reported, so a run that spent itself
    // on rematches says so out loud instead of looking like a broken app.)
    const rematch = [...document.querySelectorAll('button')].find(
      (b) => /^Rematch/.test(b.textContent?.trim() ?? '') && !b.disabled,
    );
    if (rematch) {
      rematch.click();
      return { did: 'rematch' };
    }
    const keep = [...document.querySelectorAll('button')].find(
      (b) => /^Keep \(/.test(b.textContent?.trim() ?? '') && !b.disabled,
    );
    if (keep) {
      keep.click();
      return { did: 'keep' };
    }
    if (land) {
      land.click();
      return { did: 'play-land' };
    }
    const next = [...document.querySelectorAll('button')].find(
      (b) =>
        /Pass \/ advance|Pass priority|No blocks|Let it resolve|Skip|Got it|^Confirm/.test(
          b.textContent ?? '',
        ) && !b.disabled,
    );
    if (next) {
      next.click();
      return { did: 'advance' };
    }
    return { did: 'nothing' };
  }, oppBears);
}

/** Play until the priest has been cast into a one-creature board. */
async function reachTheCast(page) {
  const spent = { lands: 0, advances: 0, rematches: 0, oneBearFrames: 0, twoPlusBearFrames: 0, priestSeen: 0 };
  const deadline = Date.now() + DRIVE_BUDGET_MS;
  for (let step = 0; step < DRIVE_STEPS && Date.now() < deadline; step++) {
    const before = await sample(page);
    if (before.oppBears === 1) spent.oneBearFrames += 1;
    if (before.oppBears > 1) spent.twoPlusBearFrames += 1;
    if (before.playable.some((p) => /Banisher Priest/i.test(p))) spent.priestSeen += 1;
    const acted = await driveOneStep(page, before.oppBears);
    if (acted.did === 'cast-priest') return { reached: true, spent, at: before };
    if (acted.did === 'play-land') spent.lands += 1;
    if (acted.did === 'advance') spent.advances += 1;
    if (acted.did === 'rematch') spent.rematches += 1;
    await sleep(DRIVE_TICK_MS);
  }
  return { reached: false, why: 'ran out of steps', spent, last: await sample(page) };
}

/**
 * After the cast, keep passing ONLY until the spell resolves, then touch
 * nothing: the announcement's whole promise is that it survives without input.
 */
async function watchForTheAnnouncement(page) {
  const best = { forced: 0, faces: 0 };
  let first = null;
  const deadline = Date.now() + WATCH_BUDGET_MS;
  while (Date.now() < deadline) {
    const s = await sample(page);
    if (s.forced > 0) {
      best.forced = Math.max(best.forced, s.forced);
      best.faces = Math.max(best.faces, s.forcedFaces);
      if (!first) first = s;
      // Stay on it: the screenshot must catch it, not a frame after it — but
      // let it finish ARRIVING first (see SETTLE_MS).
      await sleep(SETTLE_MS);
      return { seen: true, first, best, sample: await sample(page) };
    }
    // The priest is a creature spell and needs priority passed to resolve. Only
    // "pass" is pressed here, never "Got it" — dismissing the announcement is
    // exactly what this is measuring the absence of.
    await page.evaluate(() => {
      const next = [...document.querySelectorAll('button')].find(
        (b) => /Pass \/ advance|Pass priority|Let it resolve/.test(b.textContent ?? '') && !b.disabled,
      );
      if (next) next.click();
    });
    await sleep(WATCH_SAMPLE_MS);
  }
  return { seen: false, first, best, sample: await sample(page) };
}

/**
 * PART 2's driving step: deploy a creature and then do nothing but advance, so
 * the computer has something to kill and the time to kill it.
 *
 * It NEVER attacks — an attacking creature is tapped and the AI's removal is
 * less interesting aimed at a tapped body — and it never dismisses the hold.
 */
async function driveForARemovalSpell(page) {
  return page.evaluate(() => {
    const hand = [...document.querySelectorAll('.play-hand')].find(
      (h) => !h.className.includes('hidden'),
    );
    const playable = hand ? [...hand.querySelectorAll('button.play-card--actionable')] : [];
    const label = (b) => (b.getAttribute('title') ?? b.getAttribute('aria-label') ?? b.textContent ?? '');
    const bear = playable.find((b) => /Grizzly Bears/i.test(label(b)));
    const land = playable.find((b) => /Forest/i.test(label(b)));
    if (bear) {
      bear.click();
      return { did: 'play-creature' };
    }
    if (land) {
      land.click();
      return { did: 'play-land' };
    }
    const rematch = [...document.querySelectorAll('button')].find(
      (b) => /^Rematch/.test(b.textContent?.trim() ?? '') && !b.disabled,
    );
    if (rematch) {
      rematch.click();
      return { did: 'rematch' };
    }
    const keep = [...document.querySelectorAll('button')].find(
      (b) => /^Keep \(/.test(b.textContent?.trim() ?? '') && !b.disabled,
    );
    if (keep) {
      keep.click();
      return { did: 'keep' };
    }
    const next = [...document.querySelectorAll('button')].find(
      (b) =>
        /Pass \/ advance|Pass priority|No blocks|^Confirm|Skip/.test(b.textContent ?? '') &&
        !b.disabled,
    );
    if (next) {
      next.click();
      return { did: 'advance' };
    }
    return { did: 'nothing' };
  });
}

/**
 * Play until the opponent's spell is HELD on screen with a target under it.
 *
 * ⚠️ "Let it resolve" and "Keep looking" are deliberately absent from the driver
 * above: the hold is the thing being photographed, so a driver that clicks
 * through it is rushing past what it came to see (the combat rig's own scar).
 */
async function reachAHeldSpell(page) {
  const spent = { creatures: 0, lands: 0, advances: 0, rematches: 0, holdFrames: 0 };
  // The FIRST hold seen, kept even when it carries no target: a miss that can
  // only say "never" is a miss nobody can debug. This is what the three earlier
  // rigs in this repo could not do.
  let firstHold = null;
  const deadline = Date.now() + DRIVE_BUDGET_MS;
  for (let step = 0; step < DRIVE_STEPS && Date.now() < deadline; step++) {
    const before = await sample(page);
    if (before.hold > 0) {
      spent.holdFrames += 1;
      if (!firstHold) firstHold = before;
      if (before.holdTargets.length > 0) {
        await sleep(SETTLE_MS);
        return { reached: true, spent, at: await sample(page) };
      }
      // A held spell with NO target is a real, correct state (a cantrip), and
      // the rig must not mistake it for the answer. Wait for a targeted one.
    }
    const acted = await driveForARemovalSpell(page);
    if (acted.did === 'play-creature') spent.creatures += 1;
    if (acted.did === 'play-land') spent.lands += 1;
    if (acted.did === 'advance') spent.advances += 1;
    if (acted.did === 'rematch') spent.rematches += 1;
    await sleep(DRIVE_TICK_MS);
  }
  return { reached: false, why: 'ran out of steps', spent, firstHold, last: await sample(page) };
}

/** `--only=forcedChoice|spellHold` re-runs one half without paying for the other. */
const ONLY = (process.argv.find((a) => a.startsWith('--only=')) ?? '').split('=')[1] ?? '';

/**
 * THE ARRANGEMENT. Basic lands are exempt from the 4-of limit; everything else
 * obeys it, because the deck builder is right and a rig reaches around nothing.
 */
const QUEUE_ARRANGEMENT = Object.freeze({
  you: {
    id: 'rig-queue-you',
    name: 'Rig Bodies',
    cards: [
      { cardId: GRIZZLY_BEARS, count: 4 },
      { cardId: FOREST, count: 56 },
    ],
  },
  them: {
    id: 'rig-queue-them',
    name: 'Rig Guides',
    cards: [
      { cardId: GOBLIN_GUIDE, count: 4 },
      { cardId: DOOM_BLADE, count: 4 },
      { cardId: MOUNTAIN, count: 26 },
      { cardId: SWAMP, count: 26 },
    ],
  },
});

/** What the ONE surface is showing, and what it says is waiting behind it. */
async function sampleSurface(page) {
  return page.evaluate(() => {
    const count = (s) => document.querySelectorAll(s).length;
    const text = (s) => (document.querySelector(s) ? document.querySelector(s).textContent : '').trim();
    const surface = document.querySelector('.announce');
    return {
      status: text('.play-board__status'),
      surfaces: count('.announce'),
      bodies: count('.announce__body'),
      kind: surface ? surface.getAttribute('data-announce-kind') : '',
      slot: surface ? surface.className : '',
      waiting: text('.announce__waiting'),
      // The four announcement bodies, counted by their OWN root classes — so a
      // second one on screen is counted even if the surface says otherwise.
      reveal: count('.reveal-banner'),
      spellHold: count('.spell-hold'),
      combatHold: count('.combat-hold'),
      forcedChoice: count('.forced-choice'),
      revealText: text('.reveal-banner__text'),
      // ⚠️ GEOMETRY, not just presence. The reported defect is OVERLAP, so the
      // rig measures whether the one surface clears the board's status row —
      // "there is only one banner" is not the same claim as "it covers nothing".
      rects: (() => {
        const r = (sel) => {
          const e = document.querySelector(sel);
          if (!e) return null;
          const b = e.getBoundingClientRect();
          return { top: Math.round(b.top), bottom: Math.round(b.bottom), h: Math.round(b.height) };
        };
        return { surface: r('.announce'), status: r('.play-board__status'), header: r('.app__header') };
      })(),
      holdWho: text('.spell-hold__who'),
      holdName: text('.spell-hold__name'),
    };
  });
}

/**
 * Deploy a body, then advance. It never attacks (a tapped blocker cannot block
 * the Guide) and it never dismisses an announcement — the announcements are
 * what this came to see.
 */
async function driveTowardTwoAtOnce(page) {
  return page.evaluate(() => {
    const hand = [...document.querySelectorAll('.play-hand')].find(
      (h) => !h.className.includes('hidden'),
    );
    const playable = hand ? [...hand.querySelectorAll('button.play-card--actionable')] : [];
    const label = (b) => (b.getAttribute('title') ?? b.getAttribute('aria-label') ?? b.textContent ?? '');
    const bear = playable.find((b) => /Grizzly Bears/i.test(label(b)));
    const land = playable.find((b) => /Forest/i.test(label(b)));
    // ⚠️ THE CREATURE FIRST, AND THAT ORDER IS LOAD-BEARING. Measured: with the
    // land first, a 56-Forest hand always has a land to play, the board stayed
    // at "Battlefield — no creatures" for the whole run, the computer never had
    // a Doom Blade target, and the rig reported the reported pair as unreached
    // for a reason that was entirely the driver's.
    if (bear) {
      bear.click();
      return { did: 'play-creature' };
    }
    if (land) {
      land.click();
      return { did: 'play-land' };
    }
    const rematch = [...document.querySelectorAll('button')].find(
      (b) => /^Rematch/.test((b.textContent ?? '').trim()) && !b.disabled,
    );
    if (rematch) {
      rematch.click();
      return { did: 'rematch' };
    }
    const keep = [...document.querySelectorAll('button')].find(
      (b) => /^Keep \(/.test((b.textContent ?? '').trim()) && !b.disabled,
    );
    if (keep) {
      keep.click();
      return { did: 'keep' };
    }
    // ⚠️ `Skip`, `Got it` and `Let it resolve` are deliberately ABSENT: pressing
    // them is exactly the thing this rig must not do.
    const next = [...document.querySelectorAll('button')].find(
      (b) => /Pass \/ advance|Pass priority|No blocks|^Confirm/.test(b.textContent ?? '') && !b.disabled,
    );
    if (next) {
      next.click();
      return { did: 'advance' };
    }
    return { did: 'nothing' };
  });
}

/** Play until the surface reports a WAITER — that is the two-at-once frame. */
async function reachTwoAtOnce(page) {
  const spent = { lands: 0, creatures: 0, advances: 0, rematches: 0, surfaceFrames: 0, twoAtOnceFrames: 0 };
  let firstSurface = null;
  let bestTwo = null;
  const deadline = Date.now() + DRIVE_BUDGET_MS;
  for (let step = 0; step < QUEUE_STEPS && Date.now() < deadline; step++) {
    const now = await sampleSurface(page);
    if (now.surfaces > 0) {
      spent.surfaceFrames += 1;
      if (!firstSurface) firstSurface = now;
      if (now.waiting !== '') {
        spent.twoAtOnceFrames += 1;
        if (!bestTwo) {
          // ⚠️ PHOTOGRAPHED HERE, NOT AT THE END OF THE RUN. The first version
          // kept this sample and took the picture after the loop, minutes and
          // several turns later — a caption describing one frame over a picture
          // of another, which is the stale-artifact trap this repo has been
          // caught by before. The camera and the assertion now see one frame.
          await sleep(SETTLE_MS);
          bestTwo = await sampleSurface(page);
          await shot(page, 'two-announcements-one-surface.png');
        }
        // ⚠️ KEEP HUNTING FOR THE REPORTED PAIR. Caleb named two announcements
        // specifically — the Goblin Guide reveal and "what the computer casted"
        // — and the computer's cast is the SPELL HOLD. Any two-at-once frame
        // proves the queue works; the spell-hold one proves it on the frame he
        // actually saw, so the rig prefers it and keeps the first as a floor.
        if (now.kind === 'spellHold') {
          await sleep(SETTLE_MS);
          return { reached: true, reported: true, spent, at: await sampleSurface(page) };
        }
      }
    }
    const acted = await driveTowardTwoAtOnce(page);
    if (acted.did === 'play-land') spent.lands += 1;
    if (acted.did === 'play-creature') spent.creatures += 1;
    if (acted.did === 'advance') spent.advances += 1;
    if (acted.did === 'rematch') spent.rematches += 1;
    await sleep(QUEUE_TICK_MS);
  }
  // The budget ran out without the reported pair. A two-at-once frame of ANY
  // kind still proves the queue reconciled them, and is reported as exactly
  // that rather than as the pair it is not.
  if (bestTwo) return { reached: true, reported: false, spent, at: bestTwo };
  return { reached: false, why: 'ran out of steps', spent, firstSurface, last: await sampleSurface(page) };
}

/**
 * Faster than `DRIVE_TICK_MS`: the reveal's beat is `ANNOUNCEMENT_CONFIG.revealMs`
 * and the window in which a cast lands on top of one is a fraction of that. A
 * sampler slower than the state it hunts finds nothing and reports "never".
 */
const QUEUE_TICK_MS = 40;

/**
 * More steps than the sibling rig's `DRIVE_STEPS`, because this one is hunting a
 * COINCIDENCE rather than a state: the computer must be holding a Doom Blade in
 * the same beat a Goblin Guide reveal is still live, which is several turns of
 * deployment away. Bounded by `DRIVE_BUDGET_MS` either way.
 */
const QUEUE_STEPS = 6_000;

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const chrome = findChrome();
  if (!chrome) throw new Error(describeChromeSearch());
  const preview = await startPreview();
  console.log(`preview: ${preview.url}`);
  const browser = await puppeteer.launch(harnessLaunchOptions({ chromePath: chrome }));
  try {
    const page = await browser.newPage();
    await page.setViewport(VIEWPORT);
    page.on('pageerror', (err) => console.log('  pageerror:', String(err).slice(0, 200)));
    await startArrangedSoloGame(page, preview.url, QUEUE_ARRANGEMENT);
    const found = await reachTwoAtOnce(page);
    console.log(`  drive: ${JSON.stringify(found.spent)}`);
    if (!found.reached) {
      check('two announcements came due at once', false, found.why);
      console.log(`  first surface seen: ${JSON.stringify(found.firstSurface)}`);
      console.log(`  last: ${JSON.stringify(found.last)}`);
      await shot(page, 'never-two.png');
    } else {
      const a = found.at;
      check('two announcements came due at once', true, `waiting="${a.waiting}" showing=${a.kind}`);
      // ⚠️ NOT A CHECK WHEN IT IS NOT REACHED, and never folded into the green.
      // The GUARANTEE is "two due at once reconcile to one surface", and that is
      // what the checks above and below assert. Caleb's exact pair — the reveal
      // and the computer's CAST — is a refinement of the same mechanism, and a
      // run that does not reach it says so by name rather than passing quietly.
      if (found.reported) {
        check(
          'and it is THE REPORTED PAIR — the reveal and the computer’s cast',
          true,
          `the cast is showing, the reveal is ${a.waiting}`,
        );
      } else {
        console.log(
          `  NOT CHECKED  the reported pair (reveal + the computer’s CAST) — this run reached ${a.kind} + "${a.waiting}" instead.`,
        );
        console.log(
          '               Same queue, same surface, a different higher-ranked kind. The reveal-vs-spell-hold ordering is covered by announcement-queue.test.ts.',
        );
      }
      // THE REPORTED DEFECT, inverted into an assertion: exactly ONE body.
      check(
        'exactly ONE announcement is on screen',
        a.bodies === 1 && a.reveal + a.spellHold + a.combatHold + a.forcedChoice === 1,
        `bodies=${a.bodies} reveal=${a.reveal} spellHold=${a.spellHold} combatHold=${a.combatHold} forcedChoice=${a.forcedChoice}`,
      );
      check('there is ONE surface, not four', a.surfaces === 1, `.announce x${a.surfaces}`);
      check(
        'the loser is not lost — the surface SAYS it is waiting',
        /\+\d+ waiting/.test(a.waiting),
        JSON.stringify(a.waiting),
      );
      console.log(`  rects: ${JSON.stringify(a.rects)}`);
      /*
       * ⚠️ THE ASSERTION THE PICTURE FORCED. "There is only one banner" is not
       * "it covers nothing": the first capture of this rig showed the reveal
       * standing ON the board's status row, and a capture of the settled-choice
       * banner shows the SHIPPED code doing the same thing at the same slot.
       * An announcement that hides "Turn 2 · Combat Damage · Computer's turn" is
       * the reported defect in a different costume, so the slot is measured.
       */
      const rr = a.rects ?? {};
      // NON-INTERSECTION, either side. The first version of this assertion said
      // `surface.bottom <= status.top` — "the announcement is ABOVE the status
      // row" — which is a claim about the LAYOUT, not about the defect. The fix
      // moved the slot BELOW the row and the assertion reddened on a frame that
      // was correct. What the report is about is OVERLAP, and this is that.
      const clears =
        rr.surface != null &&
        rr.status != null &&
        (rr.surface.bottom <= rr.status.top || rr.surface.top >= rr.status.bottom);
      check(
        'the surface CLEARS the board status row — it announces, it does not cover',
        clears,
        rr.surface && rr.status
          ? `surface ${rr.surface.top}-${rr.surface.bottom} vs status ${rr.status.top}-${rr.status.bottom}`
          : JSON.stringify(rr),
      );
      check(
        'the survivor is the higher-ranked kind, from the table',
        a.kind !== '' && a.kind !== 'reveal',
        `showing=${a.kind}`,
      );
      // The fallback frame was already photographed at capture time; only the
      // reported pair still needs its picture taken, and it is taken on the
      // frame that produced it.
      if (found.reported) await shot(page, 'reported-pair-one-surface.png');
      console.log(`  board: ${a.status}`);
      console.log(`  showing: ${JSON.stringify({ kind: a.kind, holdWho: a.holdWho, holdName: a.holdName, revealText: a.revealText })}`);
      // ⚠️ THE GAME MUST STILL BE MOVING. A queue whose beats never release is a
      // frozen board, and a rig that photographs one held frame would report
      // that as a success. Printing where the game ENDED up, against where the
      // photographed frame was, is the discriminator.
      const endStatus = (await sampleSurface(page)).status;
      console.log(`  captured at: ${a.status}`);
      console.log(`  ended at:    ${endStatus}`);
      check(
        'the game kept MOVING — the beats release, they do not freeze the board',
        endStatus !== a.status,
        `${a.status} -> ${endStatus}`,
      );
    }
  } catch (error) {
    console.error(`could not run: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 2;
    return;
  } finally {
    await browser.close().catch(() => {});
    preview.child.kill();
  }
  const passed = checks.filter((c) => c.passed).length;
  console.log('');
  console.log(`${passed}/${checks.length} checks passed`);
  if (passed !== checks.length) process.exitCode = 1;
}

await main();

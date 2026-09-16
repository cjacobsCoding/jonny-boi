#!/usr/bin/env node
/**
 * Drive the BUILT app in a real Chrome and prove the two 2026-09-14 reports are
 * fixed. BOTH are "the game did something and the player cannot tell what", and
 * both are answered by one mechanism, so one rig photographs both.
 *
 * **Part 1 — the settled choice.** Caleb: *"I just played Banisher priest and it
 * didnt let me choose a creature to banish"* … *"Even so, it should show that
 * choice being made so the player understands what has happened."*
 *
 * **Part 2 — the held spell's target.** Caleb: *"When the computer plays Doom
 * Blade when Im playing them, it does not show me clearly what the target is
 * when it displays on screen - it should show their target(s) for things along
 * with the card they are casting."*
 *
 * ## Why this is a rig and not a unit test
 *
 * `forced-choice.test.ts` proves the model names the right card, and
 * `announcement-reach.test.ts` proves the board mounts it with the right props.
 * Neither can answer the question that actually matters and that this branch has
 * got wrong seven times (§7.3 / §10 of `docs/MTGA-UX-OVERHAUL.md`): **was it
 * still there when somebody looked?** The combat hold's own guard exists because
 * a correct, tested, green animation lasted 260 ms. An announcement about a
 * trigger that resolves in the next priority window has exactly that shape, so
 * it gets exactly that guard.
 *
 * ## The rig ARRANGES the state it needs
 *
 * "Exactly one legal target" cannot be waited for by chance. The rig seeds two
 * SAVED DECKS into localStorage — the app's own persistence, not a test hook —
 * and then plays:
 *
 *   - **You**: 4 Banisher Priest + 56 Plains. FOUR, not twenty: the app enforces
 *     the 4-of limit and refuses to start otherwise — which is the deck builder
 *     being right, and the rig obeys it rather than reaching around it.
 *   - **The computer**: 4 Grizzly Bears + 56 Forest, so its board passes through
 *     "exactly one creature" on its way to two.
 *
 * …and it casts the priest ONLY in a frame where the opponent controls exactly
 * one creature. That is the whole arrangement: it never fakes the choice, it
 * waits for the real board state that produces it.
 *
 * Screenshots land in verify-out/forced-choice/ inside the worktree.
 * Exit 0 = every check passed; 1 = a check failed; 2 = could not run.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import { describeChromeSearch, findChrome } from './lib/find-chrome.mjs';
import { harnessLaunchOptions } from './lib/harness-chrome.mjs';
import { watchPageErrors } from './lib/harness-page.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = resolve(HERE, '..');
const OUT_DIR = resolve(WEB_ROOT, 'verify-out', 'forced-choice');

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

async function main() {
  const chrome = findChrome();
  if (!chrome) {
    console.error('Chrome not found.\n' + describeChromeSearch());
    process.exit(2);
  }
  let preview;
  let browser;
  try {
    preview = await startPreview();
    console.log(`preview: ${preview.url}`);
    browser = await puppeteer.launch(harnessLaunchOptions({ chromePath: chrome, windowSize: VIEWPORT }));
    const page = await browser.newPage();
    const watcher = watchPageErrors(page);
    await page.setViewport(VIEWPORT);

    if (ONLY !== 'spellHold') {
    await startArrangedSoloGame(page, preview.url, ARRANGEMENTS.forcedChoice);
    const run = await reachTheCast(page);
    console.log(`  drive: ${JSON.stringify(run.spent)}`);
    if (!run.reached) {
      check('reached a Banisher Priest cast with ONE legal target', false, run.why);
      console.log(`  last: ${JSON.stringify(run.last)}`);
      await shot(page, 'never-reached.png');
    } else {
      check(
        'reached a Banisher Priest cast with ONE legal target',
        true,
        `opponent creatures = ${run.at.oppBears}`,
      );
      const watch = await watchForTheAnnouncement(page);
      const s = watch.sample;

      check('the board ANNOUNCES the settled choice', watch.seen, `.forced-choice ×${s.forced}`);
      check(
        'it NAMES the asking card',
        /Banisher Priest/i.test(s.forcedSource),
        `source="${s.forcedSource}"`,
      );
      // THE ASSERTION THE REPORT IS ABOUT.
      check(
        'it NAMES the card that was chosen for you',
        /Grizzly Bears/i.test(s.forcedWords),
        `"${s.forcedSource} ${s.forcedVerb} ${s.forcedWords}"`,
      );
      check('it says WHY it did not ask', /only one legal target/i.test(s.forcedWhy), `"${s.forcedWhy}"`);
      check(
        'the chosen card is drawn as a CARD, not a name string',
        s.forcedFaces > 0 && s.forcedRefNames.some((n) => /Grizzly Bears/i.test(n)),
        `faces=${s.forcedFaces} names=${JSON.stringify(s.forcedRefNames)}`,
      );
      check(
        'it announces rather than asking (role=status, not dialog)',
        s.forcedRole === 'status',
        `role="${s.forcedRole}"`,
      );
      check(
        'the GAME LOG carries it too',
        s.logLines.some((l) => /Banisher Priest/i.test(l) && /Grizzly Bears/i.test(l)),
        JSON.stringify(s.logLines.filter((l) => /Banisher Priest/i.test(l))),
      );
      await shot(page, 'forced-choice-announced.png');
      console.log(`  board: ${s.status}`);
    }
    }

    if (ONLY === 'forcedChoice') return;
    // --- PART 2: the opponent's removal spell, held WITH its target ----------
    console.log('');
    console.log('part 2 - the opponent Doom Blade, held with its target');
    await startArrangedSoloGame(page, preview.url, ARRANGEMENTS.spellHold);
    const held = await reachAHeldSpell(page);
    console.log(`  drive: ${JSON.stringify(held.spent)}`);
    if (!held.reached) {
      check('reached an opponent spell held with a target', false, held.why);
      console.log(`  first hold seen: ${JSON.stringify(held.firstHold)}`);
      console.log(`  last: ${JSON.stringify(held.last)}`);
      await shot(page, 'never-held.png');
    } else {
      const h = held.at;
      check('reached an opponent spell held with a target', true, `.spell-hold ×${h.hold}`);
      check(
        'the hold NAMES what the spell is aimed at',
        h.holdTargets.some((n) => /Grizzly Bears/i.test(n)),
        JSON.stringify(h.holdTargets),
      );
      check(
        'and draws it as a CARD, not a name string',
        h.holdFaces > 0,
        `faces=${h.holdFaces}`,
      );
      check(
        'the whole hold is ON SCREEN — target and buttons included',
        h.holdFits?.inside === true,
        JSON.stringify(h.holdFits),
      );
      await shot(page, 'spell-hold-with-target.png');
      console.log(`  board: ${h.status}`);
    }
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
  } catch (error) {
    console.error(`could not run: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 2;
    return;
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (preview) preview.child.kill();
  }
  const passed = checks.filter((c) => c.passed).length;
  console.log(`\n${passed}/${checks.length} checks passed`);
  process.exitCode = passed === checks.length && checks.length > 0 ? 0 : 1;
}

await main();

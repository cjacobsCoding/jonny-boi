/**
 * SEE THE ONLINE BOARD: drive a REAL two-seat ONLINE game to a REAL BLOCKED
 * COMBAT and photograph the damage animating on it.
 *
 * Why this exists: there was no screenshot of the online board anywhere in this
 * project. Every online claim on this branch rested on `renderToStaticMarkup`
 * tests — and this repo has shipped SEVEN items that were green and unreachable
 * (docs/MTGA-UX-OVERHAUL.md §7.3, §10). So "the online board now shares the
 * scene" (§11) gets PHOTOGRAPHED, not asserted, and so does UX-15 (§12): the
 * protocol carrying a public event stream is worth nothing until a hit is seen
 * travelling from an attacker to the creature that blocked it.
 *
 * ## ⚠️ THE FOURTH WAY IT LIED, and it is the reason for this revision
 *
 * Its driver clicked whatever matched `/No blocks/`, so EVERY combat it ever
 * reached was unblocked — and it reported that honestly: *"that combat was
 * unblocked (the defender had an empty battlefield), so no blocker had anything
 * to advance to."* A rig that can only reach unblocked combat cannot photograph
 * the one thing the damage layer exists for. It now performs the board's real
 * three-step block gesture (attacker, blocker, confirm) and only falls back to
 * "No blocks" when the seat genuinely has no creature to block with.
 *
 * Two isolated browser contexts (separate localStorage, so two genuine seats)
 * against a real `apps/server` over a real socket. The client takes the server
 * from the `?server=` query param (`online-config.ts`), so no rebuild is needed
 * beyond `npm run build` — it serves `dist` through `vite preview`.
 *
 * Launches through the shared harness Chrome options: headless and MUTED, so a
 * verification run is neither seen nor heard.
 *
 * ## ⚠️ IT IS NOT A `verify-*` HARNESS, and the difference matters
 *
 * It prints what it SAW; it asserts no contract and exits 0 on a game it merely
 * failed to walk into combat. Read the numbers, look at the PNGs in
 * `verify-out/online/`. Promoting it to a gate means giving it a contract and a
 * falsification pass first.
 *
 * ## Three ways it lied before it worked — all harness bugs that read as product bugs
 *
 *  1. it scraped the room code from `body.textContent`, which ran the neighbouring
 *     Share button onto the end ("99JUTShare") and the server rightly refused the join;
 *  2. it waited for `.play-board` without answering the MULLIGAN screen that sits
 *     between Ready and the board, then reported a 40s timeout;
 *  3. its driver clicked the first non-land in hand — burn spells — so it parked on
 *     a target prompt it never answered and spun out its whole budget.
 *
 * §7.3's third finding, again: a red harness is a claim about the harness before
 * it is a claim about the code.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import puppeteer from 'puppeteer-core';
import { findChrome } from './lib/find-chrome.mjs';
import { harnessLaunchOptions } from './lib/harness-chrome.mjs';

const WEB_ROOT = resolve(import.meta.dirname, '..');
const REPO_ROOT = resolve(WEB_ROOT, '..', '..');
const OUT_DIR = resolve(WEB_ROOT, 'verify-out', 'online');
const APP_SHELL_WAIT_MS = 90_000;
const VIEWPORT = { width: 1440, height: 1100 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function freePort() {
  const net = await import('node:net');
  return new Promise((res, rej) => {
    const s = net.createServer();
    s.on('error', rej);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)); });
  });
}
async function isUp(u) { try { return (await fetch(u, { signal: AbortSignal.timeout(2000) })).status > 0; } catch { return false; } }

async function startServer() {
  const port = await freePort();
  const child = spawn(process.execPath, [resolve(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs'), resolve(REPO_ROOT, 'apps', 'server', 'src', 'main.ts')], {
    cwd: REPO_ROOT,
    env: { ...process.env, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (d) => process.stdout.write('  [server] ' + String(d)));
  child.stderr.on('data', (d) => process.stdout.write('  [server!] ' + String(d)));
  await sleep(3500); // it binds a socket, not an HTTP route we can poll
  return { child, url: `ws://localhost:${port}` };
}

async function startPreview() {
  const port = await freePort();
  const url = `http://localhost:${port}/`;
  const vite = [
    resolve(REPO_ROOT, 'node_modules', 'vite', 'bin', 'vite.js'),
    resolve(WEB_ROOT, 'node_modules', 'vite', 'bin', 'vite.js'),
  ].find((c) => existsSync(c));
  const child = spawn(process.execPath, [vite, 'preview', '--port', String(port), '--strictPort'], { cwd: WEB_ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) { if (await isUp(url)) return { child, url }; await sleep(300); }
  child.kill();
  throw new Error('vite preview did not answer');
}

async function click(page, pattern, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ok = await page.evaluate((src, flg) => {
      const re = new RegExp(src, flg);
      const hit = [...document.querySelectorAll('button')].find((b) => re.test(b.textContent?.trim() ?? '') && !b.disabled);
      if (!hit) return false;
      hit.click();
      return true;
    }, pattern.source, pattern.flags);
    if (ok) return true;
    await sleep(200);
  }
  throw new Error(`no enabled button matching ${pattern}`);
}

async function setField(page, ariaLabel, value) {
  await page.evaluate((label, v) => {
    const el = document.querySelector(`[aria-label="${label}"]`);
    if (!el) throw new Error('no field ' + label);
    const proto = el.tagName === 'SELECT' ? window.HTMLSelectElement.prototype : window.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, v);
    el.dispatchEvent(new Event(el.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }));
  }, ariaLabel, value);
}

async function shot(page, name) {
  mkdirSync(OUT_DIR, { recursive: true });
  await page.screenshot({ path: resolve(OUT_DIR, name) });
  console.log('  shot', name);
}

async function openSeat(browser, appUrl, serverUrl, name) {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  await page.setViewport(VIEWPORT);
  page.on('pageerror', (e) => console.log(`  [${name}] pageerror:`, String(e).slice(0, 160)));
  await page.goto(`${appUrl}?server=${encodeURIComponent(serverUrl)}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('button.nav-link', { timeout: APP_SHELL_WAIT_MS });
  await click(page, /^Play$/);
  await click(page, /Online|Play a friend|Multiplayer/);
  await page.waitForSelector('[aria-label="Your name"]', { timeout: 20_000 });
  await setField(page, 'Your name', name);
  return page;
}

async function readyUp(page) {
  await page.waitForSelector('[aria-label="Your deck"]', { timeout: 20_000 });
  await click(page, /^Choose this deck$/);
  await sleep(300);
  await click(page, /^Ready up$/);
}

/**
 * WHAT THE BOARD IS SHOWING RIGHT NOW — one read, so a sample is one round trip.
 *
 * The combat classes are the engine's own; `.dmg-*` is UX-15's layer, which is
 * the only thing on this board that can say damage is being DRAWN rather than
 * merely having happened.
 */
async function sample(page) {
  return page.evaluate(() => {
    const n = (sel) => document.querySelectorAll(sel).length;
    const t = (sel) => (document.querySelector(sel)?.textContent ?? '').replace(/\s+/g, ' ').trim();
    return {
      ended:
        n('.end-screen') > 0 ||
        [...document.querySelectorAll('button')].some((b) => /^Rematch \(/.test((b.textContent ?? '').trim())),
      status: t('.play-board__status').slice(0, 70),
      attacking: n('.perm--attacking'),
      blocking: n('.perm--blocking'),
      staged: n('.combat-stage__tile'),
      stagedBlockers: n('.combat-stage__tile--blocker'),
      arcs: n('.combat-arcs__body path'),
      declaredArcs: n('.combat-arcs__halo path'),
      dmgLayer: n('.dmg-layer'),
      dmgImpacts: n('.dmg-impact'),
      dmgBolts: n('.dmg-bolt'),
      holds: n('.combat-hold'),
      canBlock: !!document.querySelector('.play-board__self .perm--selectable'),
      confirm: [...document.querySelectorAll('button')]
        .map((b) => (b.textContent ?? '').trim())
        .find((s) => /^(Confirm \d+ block|No blocks)$/.test(s)) ?? null,
      // ⚠️ WHAT IS ACTUALLY ON SCREEN, printed whenever the driver finds nothing
      // to click. A rig that stalls without saying what it was looking at reads
      // exactly like a board that cannot advance — §7.3's third finding.
      buttons: [...document.querySelectorAll('button')]
        .filter((b) => !b.disabled)
        .map((b) => (b.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 40))
        .slice(0, 24),
      prompts: n('.target-prompt, .choice-prompt, .ability-prompt, .mana-menu, .tap-menu'),
      selfPerms: n('.play-board__self .perm'),
      handCards: n('button.play-card'),
      playable: n('button.play-card--actionable'),
    };
  });
}

function describe(s) {
  return (
    `attacking=${s.attacking} blocking=${s.blocking} staged=${s.staged} (blockers ${s.stagedBlockers}) ` +
    `arcs=${s.arcs} declaredArcs=${s.declaredArcs} ` +
    `dmgLayer=${s.dmgLayer} impacts=${s.dmgImpacts} bolts=${s.dmgBolts} holds=${s.holds} | ${s.status}`
  );
}

/**
 * ⚠️ DECLARE A REAL BLOCK — the whole reason this rig was extended.
 *
 * The old driver clicked whatever matched `/No blocks/`, so every combat it ever
 * reached was UNBLOCKED, and an unblocked combat cannot show the thing UX-15 is
 * for: a hit travelling from an attacker to the creature that stopped it. This
 * performs the board's real three-step gesture, in the board's own order —
 * attacker first, then blocker, then confirm — because `onBlockBoardClick`
 * refuses a blocker while no attacker is the active target.
 *
 * Returns the label it confirmed, or null if this seat had nothing to block with.
 */
async function declareBlock(page) {
  const picked = await page.evaluate(() => {
    // 1 — the attacker, on the FAR seat. It is selectable only in the block step.
    const attacker = document.querySelector('.play-board__opponent .perm--selectable');
    if (!attacker) return 'no selectable attacker';
    attacker.click();
    return 'attacker clicked';
  });
  if (picked !== 'attacker clicked') return null;
  await sleep(120);
  const assigned = await page.evaluate(() => {
    // 2 — a blocker of our own. Untapped, and offered by the SERVER's template:
    // `perm--selectable` on our seat during the block step IS that offer.
    const blocker = document.querySelector('.play-board__self .perm--selectable');
    if (!blocker) return false;
    blocker.click();
    return true;
  });
  if (!assigned) return null;
  await sleep(120);
  // 3 — commit. The label counts the blocks, so it is also the assertion that
  // the two clicks above actually assigned one.
  const label = await page.evaluate(() => {
    const btn = [...document.querySelectorAll('button')].find((b) =>
      /^Confirm \d+ block/.test((b.textContent ?? '').trim()),
    );
    if (!btn) return null;
    const text = (btn.textContent ?? '').trim();
    btn.click();
    return text;
  });
  return label;
}

/**
 * One step of the generic driver: play something, attack, or advance.
 *
 * ⚠️ `isMain` IS LOAD-BEARING, and leaving it out cost a whole debugging pass.
 * A creature in hand is `play-card--actionable` in EVERY step — the class means
 * "this client could pay for it", not "the rules allow it now" — so a driver
 * that clicks the first actionable card in UPKEEP gets
 * *"this spell can only be cast at sorcery speed"* as a toast, the card stays
 * actionable, and the rig clicks it again forever. The game never advanced, the
 * driver never reported `idle`, and the stall detector that only watched for
 * `idle` could not see it. Cards are played in a main phase; every other step
 * passes.
 */
async function drive(page, { mayBlock, isMain, mayAttack, isAttackStep }) {
  return page.evaluate((mayBlockNow, isMainNow, mayAttackNow, isAttackStepNow) => {
    // ⚠️ ANSWER ANY PARKED QUESTION FIRST. A prompt left open stops the game
    // dead, and the rig then spins until its budget runs out and reports "no
    // combat" — a harness stall that reads exactly like a board that cannot
    // reach combat.
    //
    // ⚠️ AND ANSWER IT IN THE PROMPT'S OWN ORDER. "Click the first non-Cancel
    // button" is not enough for a MULTI-SELECT question (the cleanup discard is
    // one): the first button is an option, clicking it toggles it, and clicking
    // it again next tick toggles it back — forever. So: Confirm when the prompt
    // says it may be confirmed, otherwise an option that is not already picked.
    const prompt = document.querySelector('.target-prompt, .choice-prompt, .ability-prompt');
    if (prompt) {
      const label = (b) => (b.textContent ?? '').replace(/\s+/g, ' ').trim();
      const usable = [...prompt.querySelectorAll('button')].filter(
        (b) => !b.disabled && !/^(Cancel|Back|🔍)$/.test(label(b)),
      );
      const confirm = usable.find((b) => /^Confirm$/.test(label(b)));
      if (confirm) { confirm.click(); return 'prompt:confirm'; }
      // "Already picked" is spelled two ways in this prompt — `aria-pressed` on
      // the plain option rows, a `--selected` modifier on the card tiles — and a
      // driver that knows only one of them re-toggles the same card forever
      // against a "Choose at least 2 card(s)" hint that never clears.
      const picked = (b) =>
        b.getAttribute('aria-pressed') === 'true' || b.className.includes('--selected');
      const pick = usable.find((b) => !picked(b)) ?? usable[0];
      if (pick) { pick.click(); return 'prompt'; }
    }

    // ⚠️ GLOBAL, not "inside the hand container". Scoping this to a
    // `.play-hand` that is not `--hidden` is what made this driver report
    // `hand=0` on a seat that was visibly holding five cards: the scene renders
    // the FAR seat's fanned backs in a `.play-hand` too, and picking the wrong
    // one silently emptied the driver's whole repertoire. Only a card the
    // viewer may actually play carries `--actionable`, so the global query
    // cannot pick up the opponent's backs (they are not buttons at all).
    const playable = isMainNow ? [...document.querySelectorAll('button.play-card--actionable')] : [];
    if (playable.length) {
      // Lands, then CREATURES, then anything. The old order preferred any
      // non-land, which meant burn spells — a hand emptied into the
      // opponent's face never produces an attacker to photograph.
      const isLand = (b) => /Basic Land/.test(b.textContent ?? '');
      const isCreature = (b) => /Creature\s+—/.test(b.textContent ?? '');
      const land = playable.find(isLand);
      if (land) { land.click(); return 'land'; }
      (playable.find(isCreature) ?? playable[0]).click();
      return 'card';
    }
    // ⚠️ TICK ATTACKERS ONLY IN THE ATTACK STEP, and only for the seat that is
    // allowed to attack. Two separate defects lived in the older, unconditional
    // version of this line:
    //
    //  1. outside combat, a selectable own permanent is a MANA SOURCE, so the
    //     driver spent every turn tapping its lands in the upkeep and arrived in
    //     its main phase unable to pay for anything. Thirty turns went by with
    //     `attacking=0` and almost nothing cast. Casting auto-taps, so the
    //     driver never needs to tap a land by hand;
    //  2. a seat that attacks with everything can never BE blocked and can never
    //     block — both sample decks are aggro red, so ticking every untapped
    //     creature on both sides taps both boards out every turn and the block
    //     window arrives with nothing to block with. That is exactly why this rig
    //     only ever photographed unblocked combat. One seat holds its creatures
    //     back and clicks "Attack with none" instead.
    //
    //  3. ONE attacker per swing. Six 2/2s into an empty board is lethal in two
    //     turns, and a defender that is dead cannot block. Ticking stops as soon
    //     as one creature is selected, so the swing is survivable and the block
    //     window keeps coming back.
    const ticked = document.querySelectorAll('.play-board__self button.perm[aria-pressed="true"]').length;
    const atk =
      isAttackStepNow && mayAttackNow && ticked === 0
        ? [...document.querySelectorAll('.play-board__self button.perm')].find(
            (p) => !p.disabled && !p.className.includes('perm--tapped') && p.getAttribute('aria-pressed') === 'false',
          )
        : undefined;
    const declare = [...document.querySelectorAll('button')].find((b) => /^Attack with|^Declare/.test(b.textContent ?? '') && !b.disabled);
    if (atk) { atk.click(); return 'attacker'; }
    if (declare) { declare.click(); return 'declare'; }
    // ⚠️ `No blocks` is deliberately NOT in this list any more — the caller
    // declares a real block first and only falls through to here when it could
    // not (no untapped creature). Leaving it in is what kept every combat this
    // rig ever reached unblocked.
    const passes = mayBlockNow
      ? /Pass \/ advance|Pass priority|Let it resolve|Resolve/
      : /Pass \/ advance|Pass priority|No blocks|Let it resolve|Resolve/;
    // Whitespace-NORMALISED: a label that wraps in the markup has newlines in
    // its `textContent`, and `/Pass \/ advance/` does not match across one.
    const label = (b) => (b.textContent ?? '').replace(/\s+/g, ' ').trim();
    const next = [...document.querySelectorAll('button')].find((b) => passes.test(label(b)) && !b.disabled);
    if (next) { next.click(); return 'pass'; }
    return `idle(cards=${document.querySelectorAll('button.play-card').length} perms=${document.querySelectorAll('.play-board__self button.perm').length})`;
  }, mayBlock, isMain, mayAttack, isAttackStep);
}

const server = await startServer();
const preview = await startPreview();
const browser = await puppeteer.launch(harnessLaunchOptions({ chromePath: findChrome(), windowSize: VIEWPORT }));

try {
  const host = await openSeat(browser, preview.url, server.url, 'Host');
  await click(host, /^Create room$/);
  // ⚠️ Read the code off the TITLE ELEMENT, not off `body.textContent`. The
  // body run-on swallowed the neighbouring Share button and produced
  // "99JUTShare", which the server rightly refused — a harness bug that looked
  // exactly like a join bug.
  await host.waitForFunction(
    () => /Lobby — Room\s+\S/.test(document.querySelector('.play-setup__title')?.textContent ?? ''),
    { timeout: 20_000 },
  );
  const code = await host.evaluate(
    () =>
      (/Lobby — Room\s+(\S+)/.exec(document.querySelector('.play-setup__title')?.textContent ?? '') ??
        [])[1] ?? '',
  );
  console.log('  room code:', code);
  if (!code) throw new Error('no room code on screen');

  const guest = await openSeat(browser, preview.url, server.url, 'Guest');
  await setField(guest, 'Room code', code);
  await click(guest, /^Join room$|^Join$/);
  await guest.waitForFunction(() => /Lobby — Room/.test(document.body.textContent ?? ''), { timeout: 20_000 });
  console.log('  guest joined');

  await readyUp(host);
  await readyUp(guest);

  // ⚠️ THE MULLIGAN SCREEN SITS BETWEEN READY AND THE BOARD, and both seats must
  // answer it or neither ever reaches `.play-board`. The rig used to wait 40s for
  // a board that could not appear and reported a timeout, which reads exactly
  // like a broken board. `Keep (N cards)` at zero mulligans commits immediately
  // (MulliganScreen's `beginKeep` → `onKeep([])` when nothing must be bottomed).
  for (const [who, page] of [['host', host], ['guest', guest]]) {
    await click(page, /^Keep \(/, 40_000);
    console.log(`  ${who} kept its opening hand`);
  }

  await host.waitForSelector('.play-board', { timeout: 40_000 });
  await guest.waitForSelector('.play-board', { timeout: 40_000 });
  console.log('  GAME STARTED — both seats on a board');

  await shot(host, '01-online-board-host.png');

  // What the scene extraction is supposed to have given this board.
  const scene = await host.evaluate(() => ({
    boardScene: document.querySelectorAll('.board-scene').length,
    table: document.querySelectorAll('.board-scene__table').length,
    midline: document.querySelectorAll('.board-midline').length,
    tiltVar: getComputedStyle(document.querySelector('.play-board') ?? document.body).getPropertyValue('--board-tilt-deg').trim(),
    seats: document.querySelectorAll('.seat').length,
    stack: document.querySelectorAll('.stack-panel').length,
  }));
  console.log('  SCENE ' + JSON.stringify(scene));

  // Play both seats forward to a BLOCKED combat, and photograph the damage.
  //
  // ⚠️ BLOCKED, not merely "a combat". The rig used to take the first frame with
  // an attacker in it, and its own report said so: *"that combat was unblocked
  // (the defender had an empty battlefield), so no blocker had anything to
  // advance to."* An unblocked swing cannot show the one thing UX-15 exists for
  // — a hit travelling from an attacker to the creature that stopped it — so a
  // photograph of one would have proved the channel works while showing nothing
  // the channel is for.
  const seats = [['host', host], ['guest', guest]];
  let done = false;
  let blockedCombat = null;
  let bestDamage = { score: -1, who: '', line: '' };
  const lastMove = { host: 'none', guest: 'none' };
  let stalls = 0;
  let lastStatus = '';
  let dumped = false;

  for (let i = 0; i < 6000 && !done; i++) {
    for (const [who, page] of seats) {
      const st = await sample(page);
      // A heartbeat, because a rig that stalls silently reads exactly like a
      // board that cannot reach combat — §7.3's third finding, three times over.
      if (i % 40 === 0) {
        console.log(`  [${i}] ${who} | ${describe(st)} | self=${st.selfPerms} hand=${st.handCards} confirm=${st.confirm} canBlock=${st.canBlock} did=${lastMove[who]}`);
      }
      // A block window with NO attacker in it is the overwhelmingly common case
      // — the server offers `declareBlockers` whenever the attack step ended,
      // including when the attacker declared none — so only the real ones are
      // worth a line.
      if (st.confirm !== null && st.attacking > 0) {
        console.log(`  BLOCK WINDOW (${who}) attacking=${st.attacking} canBlock=${st.canBlock} selfPerms=${st.selfPerms}`);
      }
      if (st.ended) { console.log('  game ended before a blocked combat'); done = true; break; }

      // The block window, on the seat that has it: the server offered a
      // `declareBlockers` template, which is what puts the Confirm button there.
      if (st.confirm !== null) {
        const label = st.canBlock && st.attacking > 0 ? await declareBlock(page) : null;
        if (label === null) { await drive(page, { mayBlock: false, isMain: false, mayAttack: false, isAttackStep: false }); continue; }

        blockedCombat = { who, label };
        console.log(`  BLOCK DECLARED (${who}): ${label}`);
        await shot(page, `04-online-block-${who}.png`);
        console.log(`  AT CONFIRM (${who}) | ${describe(await sample(page))}`);

        // ⚠️ SAMPLE BOTH SEATS, and keep the BEST frame rather than whatever the
        // next tick happens to show. The damage layer lives for about a second
        // (§10's beat is what makes it that long at all), and the two seats hold
        // it concurrently — so the frame worth keeping is the one with the most
        // of it on screen, not the first one that was non-zero.
        for (let s = 0; s < 140 && !done; s++) {
          for (const [w, p] of seats) {
            const live = await sample(p);
            const score = live.dmgImpacts * 100 + live.dmgBolts * 10 + live.dmgLayer;
            if (live.dmgLayer > 0 && score > bestDamage.score) {
              bestDamage = { score, who: w, line: describe(live) };
              await shot(p, `05-online-damage-${w}.png`);
            }
          }
          await sleep(55);
        }
        done = true;
        break;
      }

      lastMove[who] = await drive(page, {
        mayBlock: true,
        isMain: /Main Phase/.test(st.status),
        // The HOST is the aggressor and the GUEST is the wall. Fixed rather than
        // random so a run that reaches a blocked combat is reproducible.
        mayAttack: who === 'host',
        isAttackStep: /Declare Attackers/.test(st.status),
      });
      // ⚠️ A STALL IS A STATUS LINE THAT STOPS MOVING, not a driver that finds
      // nothing to click. The driver can be busy forever — clicking a card that
      // silently refuses to cast returns 'card' every tick — so a detector that
      // only watches for 'idle' cannot see that at all. Watched on ONE seat, not
      // both: the two seats' status lines differ by "Your move" vs "Waiting
      // for…", so a shared high-water mark is reset by every alternation and
      // never fires.
      if (who === 'host') {
        if (st.status === lastStatus) stalls += 1;
        else { stalls = 0; lastStatus = st.status; }
        if (stalls >= 120 && !dumped) {
          dumped = true;
          for (const [w, p2] of seats) await shot(p2, `90-online-stalled-${w}.png`);
          console.log(`  STALL — the game stopped moving. moves=${JSON.stringify(lastMove)} prompts=${st.prompts}`);
          console.log(`        buttons=${JSON.stringify(st.buttons)}`);
          console.log(`        ${describe(st)}`);
        }
      }
    }
    await sleep(60);
  }

  if (blockedCombat === null) console.log('  NO BLOCKED COMBAT reached — nothing to say about UX-15');
  else if (bestDamage.score < 0) console.log('  BLOCKED COMBAT reached but the DAMAGE LAYER never mounted');
  else console.log(`  ONLINE DAMAGE best (${bestDamage.who}): ${bestDamage.line}`);

  await shot(host, '99-online-final-host.png');
  await shot(guest, '99-online-final-guest.png');
} finally {
  await browser.close();
  preview.child.kill();
  server.child.kill();
}

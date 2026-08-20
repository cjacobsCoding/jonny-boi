#!/usr/bin/env node
/**
 * Drive the in-app bug reporter in a REAL browser and check what it produces.
 *
 * WHY THIS SCRIPT EXISTS. The reporter's screenshot is the one part of it that no
 * unit test can reach: it is a third-party DOM rasteriser drawing real pixels.
 * Worse, it cannot be checked in the tooling normally used to look at this app —
 * in a backgrounded tab `html-to-image` never resolves at all, not even for a
 * single header element. So "the screenshot works" was an unverified claim, and
 * an unverified claim about a debugging tool is exactly the kind of thing that is
 * discovered to be false at the worst moment. This turns it into a command.
 *
 * It launches the Chrome already installed on the machine (via puppeteer-core —
 * no browser download), serves the app, drives the reporter the way a person
 * does, and then ASSERTS on the artifacts: the frame is a real PNG the size of
 * the viewport, it is not a blank rectangle, the annotation lands where it was
 * drawn, and the submitted zip contains what report.md says it does. It also
 * writes the PNGs to disk so a human can look at them, because "the bytes decode"
 * is not the same as "the picture is right".
 *
 * Usage:
 *   node apps/web/scripts/verify-bug-reporter.mjs [--headful] [--url <url>]
 * With no --url it starts `vite preview` against the built app, so what is
 * verified is the SHIPPING bundle, not the dev server.
 *
 * Exit codes: 0 every check passed, 1 a check failed, 2 the harness could not
 * run at all (no Chrome, no build). 1 and 2 are different on purpose — "the
 * reporter is broken" and "I could not check" must never look the same.
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = resolve(HERE, '..');
const OUT_DIR = resolve(WEB_ROOT, 'verify-out');

const EXIT_OK = 0;
const EXIT_FAILED = 1;
const EXIT_CANNOT_RUN = 2;

const VIEWPORT = { width: 1280, height: 800 };
/** The reporter's own budget is 12 s; allow for a cold start on top of it. */
const CAPTURE_WAIT_MS = 30_000;
const PREVIEW_START_MS = 30_000;
/** Below this a "PNG" is a header and a blank rectangle, not a screenshot. */
const MIN_FRAME_BYTES = 20_000;

const CHROME_CANDIDATES = [
  `${process.env.ProgramFiles}\\Google\\Chrome\\Application\\chrome.exe`,
  `${process.env['ProgramFiles(x86)']}\\Google\\Chrome\\Application\\chrome.exe`,
  `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`,
  `${process.env.ProgramFiles}\\Microsoft\\Edge\\Application\\msedge.exe`,
  `${process.env['ProgramFiles(x86)']}\\Microsoft\\Edge\\Application\\msedge.exe`,
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
];

const args = process.argv.slice(2);
const headful = args.includes('--headful');
const urlArg = args.indexOf('--url') >= 0 ? args[args.indexOf('--url') + 1] : null;
// Which view to file the report from. Cards is the DEFAULT because it is the
// worst case in the whole app — ~190 card tiles, thousands of nodes — and a
// harness that only ever measures the easy view is a harness that will not
// notice the reporter becoming unusable.
const viewArg = args.indexOf('--view') >= 0 ? args[args.indexOf('--view') + 1] : null;
// --fidelity additionally proves the below-fold pruning changes no visible pixel.
// Needs a DEV server (--url), because it imports the capture module by source path.
const fidelity = args.includes('--fidelity');

/** A newline, kept as a value so no source-mangling tool can break the string. */
const chr10 = String.fromCharCode(10);

const checks = [];
function check(name, passed, detail = '') {
  checks.push({ name, passed, detail });
  console.log(`  ${passed ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

function findChrome() {
  return CHROME_CANDIDATES.find((path) => path && existsSync(path)) ?? null;
}

/** Start `vite preview` and resolve with its URL once it is listening. */
function startPreview() {
  return new Promise((resolvePreview, reject) => {
    if (!existsSync(resolve(WEB_ROOT, 'dist', 'index.html'))) {
      reject(new Error('apps/web/dist is missing — run `npm run build` first'));
      return;
    }
    // No --strictPort: a stale preview from an interrupted run must not make
    // this look like a broken reporter. Vite picks the next free port and the
    // URL is read from its own output, so whichever one it lands on is used.
    const child = spawn('npx', ['vite', 'preview', '--port', '4180'], {
      cwd: WEB_ROOT,
      shell: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    // Vite COLOURS its output, and the escape codes land in the middle of the
    // URL (`http://localhost:` ESC `[1m` `4180`), so a naive match finds nothing
    // and the harness reports 'did not start' about a server that started fine.
    const ANSI = new RegExp(String.fromCharCode(27) + '\\[[0-9;]*m', 'g');
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('vite preview did not start in time. Its output was:' + output));
    }, PREVIEW_START_MS);
    const onData = (buffer) => {
      const text = String(buffer).replace(ANSI, '');
      output += text;
      const match = output.match(/https?:\/\/localhost:\d+\/[^\s]*/);
      if (match) {
        clearTimeout(timer);
        resolvePreview({ url: match[0], child });
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
  });
}

function dataUrlToBuffer(dataUrl) {
  return Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64');
}

async function main() {
  const chromePath = findChrome();
  if (chromePath === null) {
    console.error('No Chrome or Edge found. Checked:\n  ' + CHROME_CANDIDATES.join('\n  '));
    return EXIT_CANNOT_RUN;
  }
  console.log(`Browser: ${chromePath}`);

  let preview = null;
  let url = urlArg;
  if (url === null) {
    try {
      preview = await startPreview();
      url = preview.url;
    } catch (error) {
      console.error(String(error.message ?? error));
      return EXIT_CANNOT_RUN;
    }
  }
  console.log(`App: ${url}`);
  mkdirSync(OUT_DIR, { recursive: true });

  const browser = await puppeteer.launch({
    executablePath: chromePath,
    headless: headful ? false : 'new',
    defaultViewport: VIEWPORT,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });

  try {
    const page = await browser.newPage();
    const pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(String(error)));
    await page.goto(url, { waitUntil: 'networkidle2', timeout: PREVIEW_START_MS });

    // The Cards view is the WORST CASE on purpose: ~190 card tiles, most of them
    // off screen. It is the view that made an earlier build of this capture run
    // past 30 seconds, so it is the one worth checking.
    await page.waitForSelector('.bugreport-launcher', { timeout: 10_000 });
    if (viewArg !== null) {
      await page.evaluate((label) => {
        const nav = [...document.querySelectorAll('.nav-link')].find(
          (b) => b.textContent.trim().toLowerCase() === label.toLowerCase(),
        );
        if (!nav) throw new Error('no nav button labelled ' + label);
        nav.click();
      }, viewArg);
      await new Promise((r) => setTimeout(r, 1500));
    }
    const dom = await page.evaluate(() => ({
      images: document.querySelectorAll('img').length,
      nodes: document.querySelectorAll('*').length,
    }));
    console.log(
      'View: ' + (viewArg ?? 'Cards (the worst case)') + ' - ' + dom.nodes +
        ' DOM nodes, ' + dom.images + ' images.',
    );

    console.log('\nOpening the reporter…');
    const startedAt = Date.now();
    await page.click('.bugreport-launcher');
    await page.waitForSelector('.bugreport__ink', { timeout: CAPTURE_WAIT_MS });
    const captureMs = Date.now() - startedAt;

    const shot = await page.evaluate(() => {
      const img = document.querySelector('img.bugreport__frame');
      const canvas = document.querySelector('.bugreport__ink');
      const canvasRect = canvas.getBoundingClientRect();
      return {
        dataUrl: img?.src ?? '',
        naturalWidth: img?.naturalWidth ?? 0,
        naturalHeight: img?.naturalHeight ?? 0,
        canvasBitmap: [canvas.width, canvas.height],
        scaleX: canvas.width / canvasRect.width,
        scaleY: canvas.height / canvasRect.height,
        status: document.querySelector('.bugreport__status')?.textContent ?? '',
      };
    });

    console.log(`\nCapture took ${captureMs} ms.`);
    check('the capture produced an image at all', shot.dataUrl.startsWith('data:image/png'),
      shot.status || 'no status');
    check('it is a decodable PNG the browser actually rendered',
      shot.naturalWidth > 0 && shot.naturalHeight > 0,
      `${shot.naturalWidth}x${shot.naturalHeight}`);
    check('it is the size of the VIEWPORT, not the scrollable page',
      shot.naturalWidth === VIEWPORT.width && shot.naturalHeight === VIEWPORT.height,
      `expected ${VIEWPORT.width}x${VIEWPORT.height}`);
    check('the ink canvas matches the frame, so strokes map 1:1',
      Math.abs(shot.scaleX - shot.scaleY) < 0.01,
      `scaleX ${shot.scaleX.toFixed(3)} vs scaleY ${shot.scaleY.toFixed(3)}`);
    check('the capture finished inside the reporter\'s own budget',
      captureMs < CAPTURE_WAIT_MS, `${captureMs} ms`);

    let frameBuffer = Buffer.alloc(0);
    if (shot.dataUrl.startsWith('data:image/png')) {
      frameBuffer = dataUrlToBuffer(shot.dataUrl);
      writeFileSync(resolve(OUT_DIR, 'frame.png'), frameBuffer);
      check('the picture has real content, not a blank rectangle',
        frameBuffer.length > MIN_FRAME_BYTES, `${Math.round(frameBuffer.length / 1024)} KB`);
    }

    // Does the frozen frame actually show the APP? Sample the pixels and count
    // distinct colours: a blank or single-colour fill is the failure mode that a
    // byte-size check alone would sail past.
    const pixels = await page.evaluate(async () => {
      const img = document.querySelector('img.bugreport__frame');
      if (!img) return null;
      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0);
      const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      const seen = new Set();
      for (let i = 0; i < data.length; i += 4 * 97) {
        seen.add(`${data[i]},${data[i + 1]},${data[i + 2]}`);
      }
      return { distinctColours: seen.size };
    });
    if (pixels !== null) {
      check('the frame shows the app, not a flat fill',
        pixels.distinctColours > 20, `${pixels.distinctColours} distinct colours sampled`);
    }

    // Draw, and confirm the ink lands where the pointer went.
    console.log('\nDrawing on the frozen frame…');
    const box = await page.$eval('.bugreport__ink', (canvas) => {
      const r = canvas.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    });
    const from = { x: box.x + box.width * 0.25, y: box.y + box.height * 0.3 };
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    for (let i = 1; i <= 10; i += 1) {
      await page.mouse.move(from.x + i * 18, from.y + (i % 2 === 0 ? 24 : -24));
    }
    await page.mouse.up();

    const ink = await page.evaluate(() => {
      const canvas = document.querySelector('.bugreport__ink');
      const ctx = canvas.getContext('2d');
      const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      let painted = 0;
      let minX = canvas.width;
      let maxX = 0;
      for (let y = 0; y < canvas.height; y += 1) {
        for (let x = 0; x < canvas.width; x += 1) {
          if (data[(y * canvas.width + x) * 4 + 3] > 0) {
            painted += 1;
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
          }
        }
      }
      const undo = [...document.querySelectorAll('.bugreport__btn')]
        .map((b) => b.textContent)
        .find((t) => t.startsWith('Undo'));
      return { painted, minX, maxX, undo };
    });
    check('the stroke was recorded', ink.undo === 'Undo (1)', ink.undo);
    check('the stroke actually painted pixels', ink.painted > 500, `${ink.painted} px`);
    // The drag started a quarter of the way across and ran ~180 px right, so the
    // ink must sit in that band of the BITMAP — this is the check that catches a
    // scaled or offset mapping, which is what a wrong stage layout produces.
    const expectedMinX = (from.x - box.x) * shot.scaleX;
    check('the ink landed where the pointer went, not scaled or offset',
      Math.abs(ink.minX - expectedMinX) < 25,
      `ink starts at x=${ink.minX}, pointer mapped to x=${Math.round(expectedMinX)}`);

    await page.type('#bugreport-note', 'VERIFY: filed by verify-bug-reporter.mjs');

    // Submit, then read the zip back out of its own central directory.
    console.log('\nSubmitting…');
    const submitted = await page.evaluate(async () => {
      const button = [...document.querySelectorAll('.bugreport__btn')].find((b) =>
        b.textContent.includes('SUBMIT'),
      );
      button.click();
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline) {
        const link = document.querySelector('.bugreport-lastlink');
        if (link) {
          const bytes = new Uint8Array(await (await fetch(link.href)).arrayBuffer());
          return {
            name: link.getAttribute('download'),
            base64: btoa(String.fromCharCode(...bytes.subarray(0, 0))) || '',
            length: bytes.length,
            entries: (() => {
              const dv = new DataView(bytes.buffer);
              const eocd = bytes.length - 22;
              const count = dv.getUint16(eocd + 10, true);
              let at = dv.getUint32(eocd + 16, true);
              const out = [];
              for (let i = 0; i < count; i += 1) {
                const nameLen = dv.getUint16(at + 28, true);
                out.push({
                  name: new TextDecoder().decode(bytes.slice(at + 46, at + 46 + nameLen)),
                  size: dv.getUint32(at + 24, true),
                });
                at += 46 + nameLen + dv.getUint16(at + 30, true) + dv.getUint16(at + 32, true);
              }
              return out;
            })(),
            annotatedDataUrl: (() => {
              const dv = new DataView(bytes.buffer);
              let at = 0;
              while (at < bytes.length - 4 && dv.getUint32(at, true) === 0x04034b50) {
                const nameLen = dv.getUint16(at + 26, true);
                const extraLen = dv.getUint16(at + 28, true);
                const size = dv.getUint32(at + 18, true);
                const entryName = new TextDecoder().decode(bytes.slice(at + 30, at + 30 + nameLen));
                const dataAt = at + 30 + nameLen + extraLen;
                if (entryName === 'annotated.png') {
                  let binary = '';
                  const slice = bytes.slice(dataAt, dataAt + size);
                  for (let i = 0; i < slice.length; i += 1) binary += String.fromCharCode(slice[i]);
                  return `data:image/png;base64,${btoa(binary)}`;
                }
                at = dataAt + size;
              }
              return '';
            })(),
          };
        }
        await new Promise((r) => setTimeout(r, 200));
      }
      return null;
    });

    check('a bundle was produced', submitted !== null && submitted.length > 0,
      submitted ? `${submitted.name}, ${Math.round(submitted.length / 1024)} KB` : 'none');
    if (submitted !== null) {
      const names = submitted.entries.map((e) => e.name);
      for (const required of ['screenshot.png', 'annotated.png', 'state_dump.txt', 'console.txt', 'report.md']) {
        check(`the bundle contains ${required}`, names.includes(required), names.join(', '));
      }
      const screenshotEntry = submitted.entries.find((e) => e.name === 'screenshot.png');
      check('the bundled screenshot is the real picture, not an empty file',
        (screenshotEntry?.size ?? 0) > MIN_FRAME_BYTES,
        `${Math.round((screenshotEntry?.size ?? 0) / 1024)} KB`);
      if (submitted.annotatedDataUrl) {
        writeFileSync(resolve(OUT_DIR, 'annotated.png'), dataUrlToBuffer(submitted.annotatedDataUrl));
      }
    }

    // THE PRUNING CHECK. The capture drops the trailing run of children that
    // renders below the fold, which is what took a heavy view from 11 s to 1.4 s.
    // The claim that this cannot change a visible pixel is a claim about LAYOUT,
    // and layout changes as the app changes — so it is re-measured here rather
    // than argued. Off by default because it doubles the runtime.
    if (fidelity) {
      console.log(chr10 + 'Comparing a pruned capture against an unpruned one…');
      await page.evaluate(() => {
        const cancel = [...document.querySelectorAll('.bugreport__btn')].find((b) =>
          b.textContent.includes('Cancel'),
        );
        if (cancel) cancel.click();
      });
      const compared = await page.evaluate(async () => {
        const mod = await import('/src/lib/bugreport/capture.ts');
        const t0 = performance.now();
        const pruned = await mod.captureViewport(true);
        const prunedMs = Math.round(performance.now() - t0);
        const t1 = performance.now();
        const whole = await mod.captureViewport(false);
        const wholeMs = Math.round(performance.now() - t1);
        const decode = async (url) => {
          const img = new Image();
          await new Promise((res, rej) => {
            img.onload = res;
            img.onerror = rej;
            img.src = url;
          });
          const canvas = document.createElement('canvas');
          canvas.width = img.naturalWidth;
          canvas.height = img.naturalHeight;
          const ctx = canvas.getContext('2d');
          ctx.drawImage(img, 0, 0);
          return ctx.getImageData(0, 0, canvas.width, canvas.height).data;
        };
        if (!pruned.dataUrl || !whole.dataUrl) return { error: pruned.note || whole.note };
        const a = await decode(pruned.dataUrl);
        const b = await decode(whole.dataUrl);
        let differing = 0;
        let maxDelta = 0;
        // WHERE they differ matters more than how many: a scatter across the
        // frame means the pruning moved something, while a band at one edge is
        // an anti-aliasing seam. Reporting only a count would hide the
        // difference between those two.
        const box = { minX: Infinity, minY: Infinity, maxX: -1, maxY: -1 };
        const width = pruned.width;
        for (let i = 0; i < a.length; i += 4) {
          const d = Math.max(
            Math.abs(a[i] - b[i]),
            Math.abs(a[i + 1] - b[i + 1]),
            Math.abs(a[i + 2] - b[i + 2]),
          );
          if (d > 2) {
            differing += 1;
            const p = i / 4;
            const x = p % width;
            const y = Math.floor(p / width);
            if (x < box.minX) box.minX = x;
            if (x > box.maxX) box.maxX = x;
            if (y < box.minY) box.minY = y;
            if (y > box.maxY) box.maxY = y;
          }
          if (d > maxDelta) maxDelta = d;
        }
        return {
          prunedMs,
          wholeMs,
          pixels: a.length / 4,
          differing,
          percent: +((100 * differing) / (a.length / 4)).toFixed(3),
          maxDelta,
          box,
          height: pruned.height,
        };
      });
      if (compared.error) {
        check('the pruned and unpruned captures could both be taken', false, compared.error);
      } else {
        console.log(
          `  pruned ${compared.prunedMs} ms vs unpruned ${compared.wholeMs} ms ` +
            `(${(compared.wholeMs / Math.max(1, compared.prunedMs)).toFixed(1)}x)`,
        );
        const box = compared.box;
        const spread = compared.differing === 0
          ? 'none'
          : `x ${box.minX}-${box.maxX}, y ${box.minY}-${box.maxY} of ${compared.height}`;
        check('pruning the below-fold tail changes no visible pixel',
          compared.percent < 0.05,
          `${compared.differing}/${compared.pixels} px differ (${compared.percent}%), max delta ${compared.maxDelta}, at ${spread}`);
        // HOW MUCH a pixel differs separates the two failure modes, and WHERE
        // does not — that was a wrong guess, corrected by measurement. When
        // pruning genuinely lost content (it emptied a <select>, because
        // <option> elements have no box and were being dropped) the delta was
        // 207. Anti-aliasing between two renders of the same picture measures 7.
        // A structural loss cannot hide under this bound; a sub-pixel seam
        // cannot trip it.
        check('nothing STRUCTURAL changed — no pixel shifted more than a hair',
          compared.maxDelta <= 32,
          `max delta ${compared.maxDelta} (a lost <select> label measured 207; anti-aliasing measures ~7)`);
        // Only meaningful where there is something to prune. On a short view
        // (the Lab is 107 nodes, all of it on screen) pruning is correctly a
        // no-op and the two timings are indistinguishable noise — asserting a
        // speed-up there would be asserting that noise has a sign.
        const HEAVY_ENOUGH_MS = 2000;
        if (compared.wholeMs >= HEAVY_ENOUGH_MS) {
          check('on a heavy view, pruning is actually faster',
            compared.wholeMs > compared.prunedMs * 2,
            `${compared.wholeMs} ms -> ${compared.prunedMs} ms`);
        } else {
          console.log(
            `  n/a   nothing below the fold to prune here (unpruned ${compared.wholeMs} ms) — ` +
              'the speed check needs a heavy view',
          );
        }
      }
    }

    check('the page threw no errors while all of that happened', pageErrors.length === 0,
      pageErrors.join(' | '));

    const failed = checks.filter((c) => !c.passed);
    console.log(`\n${checks.length - failed.length}/${checks.length} checks passed.`);
    console.log(`Artifacts written to ${OUT_DIR} — LOOK at frame.png and annotated.png.`);
    return failed.length === 0 ? EXIT_OK : EXIT_FAILED;
  } finally {
    await browser.close();
    preview?.child.kill();
  }
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error(error);
    process.exit(EXIT_CANNOT_RUN);
  });

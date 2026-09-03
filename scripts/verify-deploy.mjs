/**
 * VERIFY THE DEPLOY — is the live PWA actually running the commit you pushed?
 *
 * "I pushed and the Action went green" is not evidence the app changed. GitHub
 * Pages serves through a CDN, the app is a service-worker PWA, and the bundle
 * names are content-hashed — so the only honest check is to fetch the live
 * `index.html`, read the hashed chunk names out of it, and grep those chunks for
 * a string that ONLY the new code contains. This script is that check, made
 * repeatable because it has been done by hand once too often.
 *
 * ⚠️ THE TRAP IT EXISTS FOR. A plain fetch of `index.html` can come back from
 * cache minutes after a successful deploy — it did today, and reported the
 * PREVIOUS pool chunk with a confident hash, which reads exactly like "the
 * deploy did not take". Every request here is cache-busted with a query string
 * AND `Cache-Control: no-cache`. If you check by hand instead, do both.
 *
 * Usage:
 *   node scripts/verify-deploy.mjs                       # sizes + chunk names
 *   node scripts/verify-deploy.mjs "Soulshift 4" Hystrodon
 *       Each argument is a string that must appear SOMEWHERE in the deployed
 *       JavaScript. Exit code 1 if any is missing, so it works in a chain.
 *
 * Prefixing an argument with `!` requires the string to be ABSENT — the other
 * half of an honest check, for a card the compiler is supposed to still refuse.
 */

const SITE = process.env.JONNY_BOI_SITE ?? 'https://cjacobscoding.github.io/jonny-boi-app';

/** Fetch text with the cache defeated both ways. */
async function fetchText(url) {
  const bust = `${url.includes('?') ? '&' : '?'}cb=${Date.now()}`;
  const response = await fetch(`${url}${bust}`, { headers: { 'Cache-Control': 'no-cache', Pragma: 'no-cache' } });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText} for ${url}`);
  return response.text();
}

const required = [];
const forbidden = [];
for (const arg of process.argv.slice(2)) {
  if (arg.startsWith('!')) forbidden.push(arg.slice(1));
  else required.push(arg);
}

const html = await fetchText(`${SITE}/index.html`);
// Both module scripts and preloaded chunks, deduplicated in document order.
const chunks = [...new Set(html.match(/assets\/[A-Za-z0-9._-]+\.js/g) ?? [])];
if (chunks.length === 0) {
  console.error('no JS chunks found in the deployed index.html — is the site up?');
  process.exit(2);
}

console.log(`${SITE}`);
let total = 0;
const bodies = new Map();
for (const chunk of chunks) {
  const body = await fetchText(`${SITE}/${chunk}`);
  bodies.set(chunk, body);
  total += body.length;
  console.log(`${String(Math.round(body.length / 1024)).padStart(6)} KB  ${chunk}`);
}
console.log(`${String(Math.round(total / 1024)).padStart(6)} KB  TOTAL across ${chunks.length} chunks`);

/** Which chunk holds `needle`, or undefined. */
const chunkHolding = (needle) => {
  for (const [chunk, body] of bodies) if (body.includes(needle)) return chunk;
  return undefined;
};

let failed = false;
for (const needle of required) {
  const where = chunkHolding(needle);
  if (where) {
    console.log(`  PRESENT  ${JSON.stringify(needle)}  (${where})`);
  } else {
    console.log(`  MISSING  ${JSON.stringify(needle)}  — the deploy does not contain this`);
    failed = true;
  }
}
for (const needle of forbidden) {
  const where = chunkHolding(needle);
  if (where) {
    console.log(`  PRESENT  ${JSON.stringify(needle)}  (${where}) — expected ABSENT`);
    failed = true;
  } else {
    console.log(`  ABSENT   ${JSON.stringify(needle)}  (as required)`);
  }
}

if (failed) {
  console.error('\nthe live build does not match what was asked for.');
  process.exit(1);
}
if (required.length + forbidden.length > 0) console.log('\nthe live build contains exactly what was asked for.');

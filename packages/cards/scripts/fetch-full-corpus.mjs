/**
 * FETCH THE FULL PLAYABLE CARD POOL — every unique Oracle card Scryfall knows,
 * minus the joke sets, saved as a local corpus the offline tools read.
 *
 * The coverage audit paginates the SEARCH api, which is right for a "top N most
 * played" sample but wrong for "every card": that is 170+ pages of polite
 * rate-limited requests. Scryfall publishes the same data as ONE bulk file
 * (`oracle-cards` — one entry per Oracle name, which is exactly the granularity
 * a rules compiler cares about), so this takes one request.
 *
 * WHAT IS EXCLUDED, and why each is a deliberate line rather than a filter that
 * happened to be convenient:
 *  - `set_type: 'funny'` — Unglued/Unhinged/Unfinity. Their cards are not legal
 *    in any real format and several are not implementable in a rules engine at
 *    all (they ask players to balance dice on the card).
 *  - non-PAPER cards (`games` without 'paper') — Alchemy/Arena rebalances and
 *    digital-only mechanics (perpetually, seek, conjure) that do not exist in
 *    paper Magic, so "unsupported" would be a permanent, meaningless column.
 *  - tokens and other non-castable layouts — an emblem/token/art card is not a
 *    card a deck can contain.
 *
 * NETWORK. Run by hand; never from a test or CI. The OUTPUT is what the offline
 * tools (`coverage-audit --input`, `near-miss-report`, `dead-rule-sweep`) read.
 *
 * Usage: node packages/cards/scripts/fetch-full-corpus.mjs --out <path.json>
 */
import { writeFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { USER_AGENT } from '@jonny-boi/data-tools';

const BULK_INDEX = 'https://api.scryfall.com/bulk-data/oracle-cards';

/** Layouts that are not a castable card (tokens, emblems, art) — never in a deck. */
const NON_CARD_LAYOUTS = new Set([
  'token',
  'double_faced_token',
  'emblem',
  'art_series',
  'vanguard',
  'scheme',
  'planar',
  // A Jumpstart-style THEME card: type line literally "Card", no rules text,
  // never in a deck. 291 of them, and every one would sit in the backlog for
  // ever under "a card type the engine can represent" — a permanent,
  // meaningless column measuring nothing.
  'front_card',
]);

function parseArgs(argv) {
  const args = { out: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--out') args.out = argv[++i];
  }
  return args;
}

const { out } = parseArgs(process.argv.slice(2));
if (!out) {
  console.error('usage: node packages/cards/scripts/fetch-full-corpus.mjs --out <path.json>');
  process.exit(2);
}

const headers = { 'User-Agent': USER_AGENT, Accept: 'application/json' };
process.stdout.write('resolving the bulk-data index… ');
const index = await (await fetch(BULK_INDEX, { headers })).json();
// JSON LINES, not one array: Scryfall publishes both, and the line-delimited
// form is what lets this stream. The whole-array file is ~150 MB, which node
// can parse only by holding the parsed graph AND the source string at once.
const downloadUri = index.jsonl_download_uri ?? index.download_uri;
console.log(`${downloadUri} (${((index.compressed_size ?? index.size ?? 0) / 1e6).toFixed(0)} MB)`);

process.stdout.write('downloading… ');
// The bulk file is GZIPPED on disk at Scryfall (`.jsonl.gz`), and it arrives as
// bytes rather than as a Content-Encoding fetch decodes for us — so it is
// gunzipped here explicitly. Reading it as text without this yields ten
// garbage "lines" and a corpus of zero, which is exactly what happened first.
const raw = Buffer.from(await (await fetch(downloadUri, { headers })).arrayBuffer());
const body = (downloadUri.endsWith('.gz') ? gunzipSync(raw) : raw).toString('utf8');
const all = [];
for (const line of body.split(String.fromCharCode(10))) {
  const trimmed = line.trim();
  if (trimmed.length === 0) continue;
  try {
    all.push(JSON.parse(trimmed));
  } catch {
    // A truncated final line is the only shape this hits; skipping it is
    // honest — the count printed below is what was actually read.
  }
}
console.log(`${all.length} oracle cards`);

const kept = all.filter((card) => {
  if (card.set_type === 'funny') return false;
  if (!Array.isArray(card.games) || !card.games.includes('paper')) return false;
  if (NON_CARD_LAYOUTS.has(card.layout)) return false;
  return true;
});

// Only the fields the compiler and the audits read — a 140 MB file becomes a
// few MB, so every offline tool loads it in a second instead of a minute.
const slim = kept.map((card) => ({
  id: card.id,
  name: card.name,
  mana_cost: card.mana_cost,
  cmc: card.cmc,
  type_line: card.type_line,
  oracle_text: card.oracle_text,
  power: card.power,
  toughness: card.toughness,
  loyalty: card.loyalty,
  defense: card.defense,
  colors: card.colors,
  color_identity: card.color_identity,
  keywords: card.keywords,
  layout: card.layout,
  ...(card.card_faces ? { card_faces: card.card_faces } : {}),
}));

writeFileSync(out, JSON.stringify(slim));
console.log(`kept ${slim.length} paper, non-joke cards -> ${out}`);
console.log(`excluded ${all.length - kept.length} (funny sets, digital-only, non-card layouts)`);

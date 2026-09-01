/**
 * Pool-expansion generator (DESIGN §3.2 + §3.11).
 *
 * Turns a list of candidate card NAMES into pool cards by putting each one
 * through the real Oracle-text compiler, and accepting ONLY the ones that
 * compile to a faithful definition. Everything else is written out with the
 * engine system it needs. Nothing here judges a card by hand — the compiler's
 * `'complete'` verdict is the single gate, so the pool can never drift away from
 * what the engine actually plays.
 *
 * Two phases, both re-runnable:
 *
 *   npx tsx packages/cards/scripts/build-expansion.ts --fetch
 *       Resolve every candidate name against Scryfall into a scratch index
 *       under the gitignored data cache. Network; slow; run it when the
 *       candidate list changes.
 *
 *   npx tsx packages/cards/scripts/build-expansion.ts
 *       Offline. Compile the scratch index and write:
 *         - packages/cards/data/expanded-pool.ts        (the accepted cards)
 *         - packages/cards/data/expansion-report.json   (the rejected ones)
 *         - packages/data-tools/data/starter-cards.json (names to fetch art for)
 *       Then run `npm run fetch -w @jonny-boi/data-tools` to refresh the
 *       committed card index so the UI has names + art for the new cards.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { CardDefinition } from '@jonny-boi/core';
import { createFetchHttpClient, ScryfallClient } from '../../data-tools/src/client.js';
import { normalizeCard } from '../../data-tools/src/normalize.js';
import type { NormalizedCard } from '../../data-tools/src/types.js';
import { frontFaceName } from '../../data-tools/src/verify.js';
// Only the HAND-AUTHORED half is read here, never `CARD_POOL`. The full pool
// already contains this script's own previous output, so de-duplicating against
// it would make the generator skip every card it produced last time and emit an
// empty module — a re-run has to be idempotent.
import { CURATED_CARD_POOL } from '../data/pool.js';
import { compileCard } from '../src/compile/index.js';
import type { CompilableCard, UnsupportedClause } from '../src/compile/index.js';

/** Repo-relative paths, resolved from this file so the cwd never matters. */
const path = (relative: string): string =>
  fileURLToPath(new URL(`../../../${relative}`, import.meta.url));

const CANDIDATES_PATH = path('packages/cards/data/expansion-candidates.json');
/** Scratch index of EVERY candidate, rejects included — gitignored cache. */
const SCRATCH_INDEX_PATH = path('packages/data-tools/data-cache/expansion-index.json');
const EXPANDED_POOL_PATH = path('packages/cards/data/expanded-pool.ts');
const REPORT_PATH = path('packages/cards/data/expansion-report.json');
const STARTER_LIST_PATH = path('packages/data-tools/data/starter-cards.json');

/** The candidate list file: named groups of card names. */
interface CandidateFile {
  readonly description: string;
  readonly groups: ReadonlyArray<{ readonly role: string; readonly names: readonly string[] }>;
}

/** One rejected candidate, with every clause that has no implementation. */
interface RejectedCard {
  readonly name: string;
  readonly missing: readonly UnsupportedClause[];
}

async function readJson<T>(file: string): Promise<T> {
  return JSON.parse(await readFile(file, 'utf8')) as T;
}

async function writeJson(file: string, value: unknown): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

/** Every candidate name, flattened and de-duplicated in list order. */
async function candidateNames(): Promise<string[]> {
  const file = await readJson<CandidateFile>(CANDIDATES_PATH);
  return [...new Set(file.groups.flatMap((group) => group.names))];
}

// --- phase 1: fetch -------------------------------------------------------------

async function fetchCandidates(): Promise<void> {
  const names = await candidateNames();
  console.info(`[expansion] resolving ${names.length} candidate names via Scryfall…`);
  const client = new ScryfallClient(createFetchHttpClient());
  // A candidate is listed under the card's REAL name ("Fire // Ice"), which the
  // collection endpoint reports as not_found — it resolves a two-faced card only
  // by a FACE name. Asking for the front half returns the whole combined record,
  // which is the object the compiler wants.
  const { cards, unresolved } = await client.fetchCardsByNames(names.map(frontFaceName));
  const normalized = cards.map(normalizeCard).sort((a, b) => a.name.localeCompare(b.name));
  await writeJson(SCRATCH_INDEX_PATH, { cards: normalized, unresolved });
  console.info(
    `[expansion] resolved ${normalized.length}; unresolved ${unresolved.length}` +
      (unresolved.length > 0 ? `: ${unresolved.join(', ')}` : ''),
  );
  console.info(`[expansion] wrote ${SCRATCH_INDEX_PATH}`);
}

// --- phase 2: compile + emit ----------------------------------------------------

/**
 * How many card definitions go in ONE emitted array literal.
 *
 * Small enough that TypeScript never builds an unrepresentable union out of the
 * element types (TS2590 — see the note in the generated header), large enough
 * that the module stays readable. The 573-card pool this generator started with
 * fit in a single literal, which is why nothing forced the question until the
 * whole printed card pool arrived.
 */
const CHUNK_SIZE = 500;

/** Longest line the emitted data module aims for (matches `.prettierrc.json`). */
const MAX_EMITTED_LINE_WIDTH = 100;

/** A key that can be written bare in a TS object literal. */
const BARE_KEY = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/**
 * Serialize a value as a TypeScript literal, kept on one line while it fits
 * within {@link MAX_EMITTED_LINE_WIDTH} and expanded when it does not. Generated
 * data still has to be READ by a human checking it against the printed card, so
 * "one card, a few lines" beats a hundred lines of one-key-per-line JSON.
 */
function serializeValue(value: unknown, indent: string): string {
  const inline = inlineValue(value);
  if (indent.length + inline.length <= MAX_EMITTED_LINE_WIDTH) return inline;
  // A PRIMITIVE has no inner structure to break across lines, so an over-long
  // one stays on its line. Without this it fell through to the object branch and
  // `Object.entries` walked a long STRING character by character, emitting a
  // label as `{ '0': 'S', '1': 'a', ... }` — data that no longer type-checks.
  // Nothing printed a label over 100 characters until the fetchlands compiled.
  if (value === null || typeof value !== 'object') return inline;

  const inner = `${indent}  `;
  if (Array.isArray(value)) {
    const items = value.map((item) => `${inner}${serializeValue(item, inner)},`);
    return `[\n${items.join('\n')}\n${indent}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>).map(
    ([key, item]) => `${inner}${quoteKey(key)}: ${serializeValue(item, inner)},`,
  );
  return `{\n${entries.join('\n')}\n${indent}}`;
}

/** The whole value on a single line (the candidate form). */
function inlineValue(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(inlineValue).join(', ')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).map(
      ([key, item]) => `${quoteKey(key)}: ${inlineValue(item)}`,
    );
    // An empty record is `{}`, not `{  }` — the padding is a separator between
    // braces and content, and with no content it is just stray whitespace. The
    // first cards to print one were the attachments (a modification that grants
    // no keywords), so nothing before them exposed it.
    return entries.length === 0 ? '{}' : `{ ${entries.join(', ')} }`;
  }
  // Single-quoted strings to match the repo's Prettier style, so the generated
  // module reads like the hand-authored one next to it.
  return typeof value === 'string' ? `'${value.replace(/'/g, "\\'")}'` : JSON.stringify(value);
}

function quoteKey(key: string): string {
  return BARE_KEY.test(key) ? key : `'${key}'`;
}

/**
 * Serialize a definition as a TypeScript object literal, with the card's printed
 * Oracle text above it. Written out as TS rather than JSON so the pool stays a
 * typed data module the type checker validates, and so a reviewer can compare
 * the printed text to the engine data line by line.
 */
function serializeDefinition(definition: CardDefinition, oracleText: string): string {
  const comment = oracleText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => `  // ${line}`)
    .join('\n');
  return `${comment ? `${comment}\n` : ''}  ${serializeValue(definition, '  ')},`;
}

/** Render the generated pool module. */
function renderModule(entries: ReadonlyArray<{ card: NormalizedCard; definition: CardDefinition }>): string {
  const header = `/**
 * GENERATED — do not edit by hand. Regenerate with:
 *   npx tsx packages/cards/scripts/build-expansion.ts
 *
 * The compiled half of the card pool (DESIGN §3.2, §3.11). Every definition here
 * was produced by the Oracle-text compiler from the card's real Scryfall text and
 * accepted ONLY because the compiler reported it \`'complete'\` — i.e. every
 * printed ability is genuinely implemented by a registered effect primitive. The
 * printed text sits above each entry so the data can be checked by eye against
 * what the engine will do.
 *
 * Candidates that could NOT be compiled faithfully are not here; they are listed
 * with the engine system they need in \`./expansion-report.json\`. Nothing is
 * approximated into the pool — an almost-right card would silently bias every
 * A/B verdict the lab produces.
 *
 * ${entries.length} cards.
 */

import type { CardDefinition } from '@jonny-boi/core';

/**
 * ⚠️ THE POOL IS EMITTED IN CHUNKS, and that is not cosmetic. One array literal
 * holding every card makes TypeScript infer an element type that is the union of
 * all of them, and past a few thousand entries it gives up outright:
 * "TS2590: Expression produces a union type that is too complex to represent."
 * A type ANNOTATION alone does not save it — the union is formed while checking
 * the literal, before the annotation is applied. Splitting into arrays of
 * ${CHUNK_SIZE} keeps every union small, checks each card against
 * \`CardDefinition\` exactly as before, and costs one concatenation at load.
 */
`;
  const chunks: string[] = [];
  const names: string[] = [];
  for (let start = 0; start < entries.length; start += CHUNK_SIZE) {
    const slice = entries.slice(start, start + CHUNK_SIZE);
    const name = `POOL_${chunks.length}`;
    names.push(name);
    const body = slice
      .map((entry) => serializeDefinition(entry.definition, entry.card.oracleText))
      .join('\n');
    chunks.push(`const ${name}: readonly CardDefinition[] = [\n${body}\n];\n`);
  }
  // An empty pool still has to produce a valid module, and `[].concat()` of
  // nothing is the honest way to say so.
  const joined = names.length === 0 ? '[]' : `[${names.map((name) => `...${name}`).join(', ')}]`;
  return (
    `${header}${chunks.join('\n')}\n` +
    `export const EXPANDED_CARD_POOL: readonly CardDefinition[] = Object.freeze(${joined});\n`
  );
}

/**
 * Scryfall ids the committed card index already holds, by card name.
 *
 * A missing index is an EMPTY map rather than an error — the first run of a
 * fresh checkout has nothing to preserve, and it should still build a pool.
 */
async function committedIndexIds(): Promise<Map<string, string>> {
  try {
    const index = await readJson<{ cards: { id: string; name: string }[] }>(
      path('packages/data-tools/data/card-index.json'),
    );
    return new Map(index.cards.map((card) => [card.name, card.id]));
  } catch {
    return new Map();
  }
}

async function buildExpansion(): Promise<void> {
  const scratch = await readJson<{ cards: NormalizedCard[] }>(SCRATCH_INDEX_PATH);
  const curatedIds = new Set(CURATED_CARD_POOL.map((card) => card.id));
  // ⚠️ MATCHED ON THE FRONT-FACE NAME. A double-faced card is stored under its
  // combined name in one place and its front half in the other, so a plain name
  // comparison let Delver of Secrets in TWICE — once hand-authored, once
  // compiled — and the pool then had two definitions claiming the same card.
  const curatedNames = new Set(CURATED_CARD_POOL.map((card) => frontFaceName(card.name)));

  const indexIdsByName = await committedIndexIds();

  const accepted: Array<{ card: NormalizedCard; definition: CardDefinition }> = [];
  const rejected: RejectedCard[] = [];

  for (const card of scratch.cards) {
    // A hand-authored card keeps its reviewed definition — never two entries.
    if (curatedIds.has(card.id) || curatedNames.has(frontFaceName(card.name))) continue;
    const result = compileCard(card as CompilableCard);
    if (result.status === 'complete') {
      // ⚠️ THE COMMITTED INDEX OWNS THE ID. `pool.ts` says it plainly — every id
      // is the Scryfall id from `card-index.json`, and the two join on it. A
      // corpus carries ONE printing per Oracle name and Scryfall chooses which,
      // so regenerating from a corpus would hand this card a different printing's
      // id while the index kept the old one, and the join would break for every
      // card the pool already had. Known name ⇒ known id; a genuinely new card
      // brings its own, which the index build then adopts.
      const knownId = indexIdsByName.get(card.name);
      accepted.push({
        card,
        definition: knownId === undefined ? result.definition : { ...result.definition, id: knownId },
      });
    } else rejected.push({ name: card.name, missing: result.missing });
  }

  accepted.sort((a, b) => a.card.name.localeCompare(b.card.name));
  rejected.sort((a, b) => a.name.localeCompare(b.name));

  await mkdir(dirname(EXPANDED_POOL_PATH), { recursive: true });
  await writeFile(EXPANDED_POOL_PATH, renderModule(accepted), 'utf8');

  // Group the rejections by the missing system: this is the actionable output —
  // "implement X and Y more real cards become playable".
  const bySystem = new Map<string, string[]>();
  for (const entry of rejected) {
    for (const gap of entry.missing) {
      const names = bySystem.get(gap.missingEngineSystem) ?? [];
      if (!names.includes(entry.name)) names.push(entry.name);
      bySystem.set(gap.missingEngineSystem, names);
    }
  }
  const blockedBySystem = [...bySystem.entries()]
    .map(([missingEngineSystem, cards]) => ({ missingEngineSystem, cards: cards.sort() }))
    .sort((a, b) => b.cards.length - a.cards.length);

  await writeJson(REPORT_PATH, {
    description:
      'GENERATED by scripts/build-expansion.ts. Candidate cards the Oracle compiler REFUSED to call playable, with the exact printed clause and the engine system it would need. This is the honest record behind the pool, and the priority list for engine work: the systems at the top of `blockedBySystem` unlock the most real cards.',
    candidates: scratch.cards.length,
    accepted: accepted.length,
    rejected: rejected.length,
    blockedBySystem,
    cards: rejected,
  });

  // The committed Scryfall index should carry exactly the cards that are in the
  // pool — no more (the browser would offer unplayable cards) and no fewer (the
  // UI would have no art for a card you can deck).
  // The list is a list of things to ASK SCRYFALL FOR, so it carries front-face
  // names: the pipeline feeds it straight back to the collection endpoint, which
  // does not resolve a combined "A // B" name. `invariants.test.ts` matches a
  // starter name against either half, so the index still stores the real name.
  const starter = await readJson<{ description: string; names: string[] }>(STARTER_LIST_PATH);
  const poolNames = [
    ...CURATED_CARD_POOL.map((card) => frontFaceName(card.name)),
    ...accepted.map((entry) => frontFaceName(entry.card.name)),
  ];
  await writeJson(STARTER_LIST_PATH, {
    ...starter,
    names: [...new Set(poolNames)].sort((a, b) => a.localeCompare(b)),
  });

  console.info(`[expansion] accepted ${accepted.length}, rejected ${rejected.length}`);
  for (const group of blockedBySystem) {
    console.info(`  ${String(group.cards.length).padStart(3)}  ${group.missingEngineSystem}`);
  }
  console.info(`[expansion] wrote ${EXPANDED_POOL_PATH}`);
  console.info(`[expansion] wrote ${REPORT_PATH}`);
  console.info(`[expansion] updated ${STARTER_LIST_PATH} (${poolNames.length} pool names)`);
}

// --- phase 1b: the WHOLE printed card pool, offline ------------------------------

/**
 * Fill the scratch index from a full Scryfall corpus file instead of from a
 * curated list of names.
 *
 *   node packages/cards/scripts/fetch-full-corpus.mjs <out.json>     (network, once)
 *   npx tsx packages/cards/scripts/build-expansion.ts --corpus <out.json>
 *   npx tsx packages/cards/scripts/build-expansion.ts
 *
 * WHY IT IS A SEPARATE PHASE and not a flag on the build: the corpus is ~14 MB
 * of raw Scryfall records and is deliberately NOT committed, so the step that
 * reads it must be one somebody runs on purpose. Everything downstream still
 * works from the same scratch index the name-based phase writes, which is what
 * keeps ONE compile-and-emit path — a second one would be free to accept a card
 * the first would have rejected.
 *
 * The candidate LIST is not obsoleted by this: it is still the smallest input
 * that reproduces the curated pool, and it is what runs when no corpus is at
 * hand.
 */
async function ingestCorpus(): Promise<void> {
  const at = process.argv.indexOf('--corpus');
  const corpusPath = process.argv[at + 1];
  if (corpusPath === undefined) {
    console.error('[expansion] --corpus needs a path to a corpus JSON file');
    process.exitCode = 2;
    return;
  }
  const raw = await readJson<unknown[]>(corpusPath);
  console.info(`[expansion] normalizing ${raw.length} corpus cards…`);
  const normalized: NormalizedCard[] = [];
  const skipped: string[] = [];
  for (const card of raw) {
    try {
      normalized.push(normalizeCard(card as Parameters<typeof normalizeCard>[0]));
    } catch (error) {
      // A record the NORMALIZER refuses is not a compiler gap and must not be
      // counted as one — it is a shape this pipeline has never seen. Named in
      // the log so it can be looked at, and left out rather than guessed at.
      skipped.push(`${(card as { name?: string }).name ?? '?'}: ${(error as Error).message}`);
    }
  }
  normalized.sort((a, b) => a.name.localeCompare(b.name));
  await writeJson(SCRATCH_INDEX_PATH, { cards: normalized, unresolved: [] });
  console.info(
    `[expansion] normalized ${normalized.length}; skipped ${skipped.length}` +
      (skipped.length > 0 ? `\n  ${skipped.slice(0, 10).join('\n  ')}` : ''),
  );
  console.info(`[expansion] wrote ${SCRATCH_INDEX_PATH}`);
}

const main = process.argv.includes('--fetch')
  ? fetchCandidates
  : process.argv.includes('--corpus')
    ? ingestCorpus
    : buildExpansion;
main().catch((error: unknown) => {
  console.error('[expansion] failed:', error);
  process.exitCode = 1;
});

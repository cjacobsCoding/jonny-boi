/**
 * GENERATOR for `apps/web/public/data/browse-index.json` — every card Scryfall
 * knows that the engine does NOT yet play, packed for the browser.
 *
 *   npx tsx apps/web/scripts/build-browse-index.ts            # regenerate
 *   npx tsx apps/web/scripts/build-browse-index.ts --check    # fail if stale
 *
 * WHY IT EXISTS. The deck builder and the card browser used to offer only the
 * cards the engine can play (~7k). The instruction was the other way round: offer
 * every card, and make the ones the engine cannot play yet unmistakable and
 * unplayable (§3.158 is the gate; this is the catalogue). So the app now has TWO
 * indexes with one shape between them: the bundled `card-index.json` (the
 * playable pool, statically imported, precached) and this file — THE REST —
 * fetched on first use and cached by the service worker thereafter.
 *
 * WHY "THE REST" AND NOT EVERYTHING. A single 32k index would carry the 7k
 * playable cards twice (once bundled, once fetched) — twice the download and
 * twice the memory for nothing. The two files partition the corpus, and
 * `browse-index.test.ts` asserts they do not overlap. Regenerating the pool
 * (`build-expansion.ts` + the two index generators) therefore ends with THIS
 * generator, or the browse file will still list cards the pool has since
 * learned; the app dedupes by NAME (bundled wins) so a stale file degrades to a
 * bigger download, never to a duplicate row.
 *
 * WHY IT IS PACKED. 32,341 full records are 48 MB; packed they are ~5× smaller
 * (`browse-record.ts` has the measurements and the legend).
 *
 * WHAT IS LEFT OUT, and it is a TABLE. Scryfall's bulk data carries a handful of
 * non-game promotional sets — challenge-deck faces, celebration one-offs,
 * playtest cards — that are cards in the sense of having a face and nothing
 * else. Un-sets never reach the corpus (`fetch-full-corpus.mjs` drops them by
 * layout); these slip through because their layout is `normal`. Excluding one
 * is a ROW with a reason, and the report prints what each row removed, so a row
 * that removes nothing (or a thousand) is visible.
 *
 * INPUT: the scratch corpus `packages/data-tools/data-cache/expansion-index.json`
 * — the same 32,341 normalized cards `build-expansion.ts` compiles, gitignored,
 * refreshed with `build-expansion.ts --fetch`. Offline otherwise.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import type { CardIndex, NormalizedCard } from '../../../packages/data-tools/src/types.js';
import { packBrowseRecord, type BrowseRecord } from '../../../packages/data-tools/src/browse-record.js';

const here = (rel: string): string => fileURLToPath(new URL(rel, import.meta.url));

/** The scratch corpus — every card, normalized. Gitignored; see the header. */
const CORPUS_PATH = here('../../../packages/data-tools/data-cache/expansion-index.json');
/** The playable pool's index — what the browse file must NOT repeat. */
const BUNDLED_INDEX_PATH = here('../src/data/card-index.json');
/** The output: a static asset, fetched at runtime, never imported. */
const OUTPUT_PATH = here('../public/data/browse-index.json');

/**
 * SETS THAT ARE NOT GAMES — a closed table. Adding one is a row; each row says
 * why, and the run reports how many cards each row removed.
 */
export const EXCLUDED_SETS: ReadonlyArray<{ readonly code: string; readonly why: string }> = [
  { code: 'past', why: 'Astral — Shandalar video-game-only cards' },
  { code: 'pcel', why: 'Celebration one-offs (1996 World Champion, Shichifukujin Dragon, …)' },
  { code: 'tfth', why: 'Theros "Face the Hydra" challenge-deck faces' },
  { code: 'tbth', why: 'Theros "Battle the Horde" challenge-deck faces' },
  { code: 'tdag', why: 'Theros "Defeat a God" challenge-deck faces' },
  { code: 'thp1', why: "Theros Hero's Path promos (Hero cards, not Magic cards)" },
  { code: 'thp2', why: "Theros Hero's Path promos" },
  { code: 'thp3', why: "Theros Hero's Path promos" },
];

/** What the file carries besides the records — provenance the app can show. */
export interface BrowseIndexFile {
  readonly attribution: string;
  readonly generated: {
    readonly corpusCards: number;
    readonly excludedCards: number;
    readonly bundledCards: number;
    readonly browseCards: number;
  };
  readonly cards: readonly BrowseRecord[];
}

/** Build the file's contents from the corpus and the bundled index. Pure; the I/O is in `main`. */
export function buildBrowseIndex(
  corpus: readonly NormalizedCard[],
  bundled: CardIndex,
): { readonly file: BrowseIndexFile; readonly excludedBySet: ReadonlyMap<string, number> } {
  const excluded = new Map(EXCLUDED_SETS.map((row) => [row.code, 0]));
  // ⚠️ Partitioned by NAME, not id. A Scryfall id names a PRINTING, and the
  // scratch corpus carries a different printing than the bundled index for 612
  // of the 7,042 playable cards (measured 2026-09-19) — by id those 612 would be
  // listed here as if the engine could not play them, and the deck builder would
  // show Lightning Bolt twice. The engine resolves a deck entry by name too, so
  // name is the identity that matters on both sides.
  const bundledNames = new Set(bundled.cards.map((c) => c.name));
  const seen = new Set<string>();
  const records: BrowseRecord[] = [];
  for (const card of corpus) {
    if (excluded.has(card.set)) {
      excluded.set(card.set, (excluded.get(card.set) ?? 0) + 1);
      continue;
    }
    if (bundledNames.has(card.name)) continue;
    if (seen.has(card.name)) continue; // a second printing of a card already listed
    seen.add(card.name);
    records.push(packBrowseRecord(card));
  }
  // Sorted by name so the file diff is stable between regenerations and a
  // reader can find a card in it; the app builds its own maps.
  records.sort((a, b) => a.n.localeCompare(b.n) || a.i.localeCompare(b.i));
  let excludedCards = 0;
  for (const n of excluded.values()) excludedCards += n;
  return {
    file: {
      attribution: bundled.attribution,
      generated: {
        corpusCards: corpus.length,
        excludedCards,
        bundledCards: bundled.cards.length,
        browseCards: records.length,
      },
      cards: records,
    },
    excludedBySet: excluded,
  };
}

async function main(): Promise<void> {
  const check = process.argv.includes('--check');
  const corpusFile = JSON.parse(await readFile(CORPUS_PATH, 'utf8')) as { cards?: NormalizedCard[] } | NormalizedCard[];
  const corpus = Array.isArray(corpusFile) ? corpusFile : (corpusFile.cards ?? []);
  if (corpus.length === 0) throw new Error(`corpus at ${CORPUS_PATH} is empty or unreadable`);
  const bundled = JSON.parse(await readFile(BUNDLED_INDEX_PATH, 'utf8')) as CardIndex;

  const { file, excludedBySet } = buildBrowseIndex(corpus, bundled);
  // Compact JSON: this file is fetched, not read by people; the indent would be a third of it.
  const text = JSON.stringify(file);

  console.log(`[browse-index] corpus ${corpus.length.toLocaleString()} · bundled ${bundled.cards.length.toLocaleString()} · browse ${file.cards.length.toLocaleString()}`);
  for (const row of EXCLUDED_SETS) console.log(`[browse-index]   excluded ${String(excludedBySet.get(row.code) ?? 0).padStart(4)}  ${row.code}  ${row.why}`);
  console.log(`[browse-index] ${(Buffer.byteLength(text, 'utf8') / 1024 / 1024).toFixed(1)} MB raw, ${(Buffer.byteLength(text, 'utf8') / Math.max(1, file.cards.length)).toFixed(0)} B/card`);

  if (check) {
    let committed: string;
    try {
      committed = await readFile(OUTPUT_PATH, 'utf8');
    } catch {
      console.error('[browse-index] STALE: the committed browse index is missing — regenerate.');
      process.exit(1);
    }
    if (committed.replace(/\r\n/g, '\n') !== text) {
      console.error('[browse-index] STALE: the committed browse index differs from a fresh derivation — regenerate.');
      process.exit(1);
    }
    console.log('[browse-index] up to date.');
    return;
  }
  await mkdir(dirname(OUTPUT_PATH), { recursive: true });
  await writeFile(OUTPUT_PATH, text);
  console.log(`[browse-index] wrote ${OUTPUT_PATH}`);
}

// Only run as a script; importing this module (the test does) must not touch the disk.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
}

/**
 * GENERATOR for `apps/web/src/data/card-index.json` — the display index the PWA
 * bundles.
 *
 *   npm run cards:index -w @jonny-boi/web            # regenerate
 *   npm run cards:index -w @jonny-boi/web -- --check  # fail if it is stale
 *
 * WHY THIS EXISTS. The web copy used to be a hand-made duplicate of
 * `packages/data-tools/data/card-index.json`. A duplicate nobody generates and
 * nobody checks is a duplicate that silently goes stale: the app would keep
 * rendering yesterday's card list — bare ids and blank art for anything added to
 * the pool since — and nothing in the suite would notice. So the file is now
 * DERIVED, and `card-index.test.ts` re-derives it and fails when the committed
 * bytes disagree. Regenerating is the only supported way to change it.
 *
 * WHY IT IS STILL COMMITTED rather than imported straight from `data-tools`:
 * the PWA bundles it (no runtime fetch, so the shell works offline with no
 * fetch race), and committing the derived file keeps `npm run build` free of a
 * pre-build codegen step. The test is what makes the copy safe.
 *
 * WHY IT IS A PROJECTION, not a byte copy. Scryfall ships ELEVEN image variants
 * per card; `cardImage()` in `apps/web/src/lib/cards.ts` can only ever return
 * four of them, and the remaining seven are dead weight in every download of the
 * app. Projecting to the fields the app actually reads is measurably leaner (see
 * the numbers in `card-index.test.ts`) and costs nothing, because the canonical
 * index keeps the full record.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** Canonical, full-fidelity index produced by `@jonny-boi/data-tools`. */
export const SOURCE_INDEX_URL = new URL(
  '../../../packages/data-tools/data/card-index.json',
  import.meta.url,
);

/** The derived index the web app imports. */
export const WEB_INDEX_URL = new URL('../src/data/card-index.json', import.meta.url);

/**
 * The image variants the web app can actually display.
 *
 * This list is the contract with `cardImage()`: it must contain every size that
 * function can return, or a card would resolve to `undefined` and drop to the
 * text-card fallback despite Scryfall having art for it. `card-index.test.ts`
 * asserts the two stay in step, so widening `cardImage` fails loudly here
 * instead of quietly losing art.
 */
export const DISPLAYED_IMAGE_VARIANTS = ['small', 'normal', 'large', 'art_crop'];

/** Indentation of the emitted JSON — matches the canonical index's formatting. */
const JSON_INDENT = 2;

/** Keep only the image variants the app can render, preserving their order. */
function projectImageUris(imageUris) {
  const kept = {};
  for (const variant of DISPLAYED_IMAGE_VARIANTS) {
    const url = imageUris?.[variant];
    if (typeof url === 'string' && url.length > 0) kept[variant] = url;
  }
  return kept;
}

/**
 * Derive the web display index from the canonical one.
 *
 * Pure: same input, same output, no I/O — so the test can re-derive and compare
 * without touching the disk copy it is judging.
 */
export function projectCardIndex(source) {
  return {
    ...source,
    cards: source.cards.map((card) => ({
      ...card,
      imageUris: projectImageUris(card.imageUris),
      // Faces carry their own art; a DFC's back face is displayed by the same
      // `cardImage` path, so it gets the same projection rather than the full set.
      faces: (card.faces ?? []).map((face) => ({
        ...face,
        imageUris: projectImageUris(face.imageUris),
      })),
    })),
  };
}

/**
 * Serialize exactly as the file is committed, so a text compare is meaningful.
 * Always LF: `core.autocrlf` rewrites the working copy on checkout, so LF is the
 * one form both a Windows and a Linux checkout agree on once normalized.
 */
export function serializeCardIndex(index) {
  return `${JSON.stringify(index, null, JSON_INDENT)}\n`;
}

/**
 * Line-ending-insensitive view of a file's text. Without this the check reports
 * a false "stale" on any Windows checkout, where `core.autocrlf` has already
 * turned the committed LF into CRLF on disk.
 */
function normalizeNewlines(text) {
  return text.replace(/\r\n/g, '\n');
}

/** Read the canonical index and return the text the web copy should contain. */
export async function expectedWebIndexText() {
  const source = JSON.parse(normalizeNewlines(await readFile(SOURCE_INDEX_URL, 'utf8')));
  return serializeCardIndex(projectCardIndex(source));
}

/** Read the committed web copy as it would be committed (LF), or `undefined`. */
export async function committedWebIndexText() {
  const text = await readFile(WEB_INDEX_URL, 'utf8').catch(() => undefined);
  return text === undefined ? undefined : normalizeNewlines(text);
}

/**
 * Everything that must still be true of the app AFTER the index changes.
 *
 * ⚠️ This runs here, in the generator, on purpose. A pool refresh is the only
 * event that can add a keyword nothing explains, and the guard that noticed it
 * used to live only in the `apps/web` Vitest suite — so the person who
 * regenerated got a clean run and a stranger three branches later got the red.
 * One refresh landed 1,293 cards and cost 44 keywords their tooltip that way.
 * Fire the check where the change is made, by the person who made it.
 *
 * Imported lazily: `card-index.test.ts` imports this module for
 * `projectCardIndex`, and must not pay for `esbuild` to do it.
 */
async function checkDownstreamOfTheIndex() {
  const { checkGlossaryCoverage, reportGlossaryCoverage } = await import(
    './check-glossary-coverage.mjs'
  );
  return reportGlossaryCoverage(await checkGlossaryCoverage());
}

async function main() {
  const checkOnly = process.argv.includes('--check');
  const expected = await expectedWebIndexText();
  const actual = await committedWebIndexText();

  if (actual === expected) {
    console.info('[card-index] up to date.');
    if (!(await checkDownstreamOfTheIndex())) process.exitCode = 1;
    return;
  }
  if (checkOnly) {
    console.error(
      '[card-index] STALE — apps/web/src/data/card-index.json does not match the canonical\n' +
        '[card-index] packages/data-tools/data/card-index.json. Regenerate it with:\n' +
        '[card-index]   npm run cards:index -w @jonny-boi/web',
    );
    process.exitCode = 1;
    return;
  }
  await writeFile(WEB_INDEX_URL, expected, 'utf8');
  console.info(`[card-index] wrote ${fileURLToPath(WEB_INDEX_URL)}`);
  // Deliberately AFTER the write: the new index is what the app will ship, so it
  // is the one the coverage question has to be asked about.
  if (!(await checkDownstreamOfTheIndex())) process.exitCode = 1;
}

// Only run the CLI when invoked directly; importing this module (the test does)
// must have no side effects. `pathToFileURL` — not string concatenation — because
// a Windows argv path (`D:\…`) is not a valid URL body.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}

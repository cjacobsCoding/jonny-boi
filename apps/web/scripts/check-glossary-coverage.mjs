/**
 * THE GATE THAT FIRES WHEN THE POOL GROWS — every keyword the card index prints
 * must resolve to a glossary row, or be a DECLARED gap with a reason.
 *
 *   node apps/web/scripts/check-glossary-coverage.mjs       # or: npm run cards:glossary -w @jonny-boi/web
 *
 * WHY THIS EXISTS, AND WHY IT IS NOT JUST A TEST. `keyword-glossary.test.ts`
 * has asserted this since the glossary landed. It still did not stop the gap:
 * the pool was regenerated, 1,293 cards arrived, **44 printed keywords lost
 * their tooltip**, and nothing said so until somebody on a later branch happened
 * to run the `apps/web` suite. The failure was not a missing assertion, it was
 * an assertion that fires in the wrong PLACE — days away from the edit that
 * caused it, in a suite the person regenerating the pool has no reason to run.
 *
 * So the same question is now asked at the moment the answer can change:
 * `build-card-index.mjs` calls this after writing the index, and again under
 * `--check` (which `npm run verify` runs). Regenerate the pool and you are told
 * in the same command, by name, which keywords now render unexplained.
 *
 * ONE ANSWER TO ONE QUESTION (rule 12). This does NOT re-implement the lookup.
 * It loads the real `keyword-glossary.ts` and calls its exported
 * `unexplainedPoolTerms`, exactly as the test does — so the gate and the test
 * cannot drift apart. The TypeScript is stripped with `esbuild`, which is
 * already a devDependency of this repo (`bundle:server` uses it); the glossary
 * module's only import is `import type`, so stripping types leaves a module with
 * no runtime dependencies to resolve.
 */

import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { transform } from 'esbuild';

/** The shipped glossary module — the one the app itself renders from. */
export const GLOSSARY_TS_URL = new URL('../src/lib/play/keyword-glossary.ts', import.meta.url);

/** The display index the PWA bundles, and the source of the printed keywords. */
export const CARD_INDEX_URL = new URL('../src/data/card-index.json', import.meta.url);

/**
 * Load the real glossary module from TypeScript source.
 *
 * A data: URL rather than a temp file so nothing is written to disk and repeated
 * runs cannot pick up a stale artifact.
 */
export async function loadGlossaryModule() {
  const source = await readFile(GLOSSARY_TS_URL, 'utf8');
  const { code } = await transform(source, { loader: 'ts', format: 'esm' });
  const base64 = Buffer.from(code, 'utf8').toString('base64');
  return import(`data:text/javascript;base64,${base64}`);
}

/**
 * Every distinct keyword the card index prints, as Scryfall reports it, with the
 * cards that print it — the card names are what makes the failure actionable.
 */
export async function printedKeywords() {
  const index = JSON.parse(await readFile(CARD_INDEX_URL, 'utf8'));
  const cardsByTerm = new Map();
  for (const card of index.cards) {
    for (const term of card.keywords ?? []) {
      const names = cardsByTerm.get(term) ?? [];
      names.push(card.name);
      cardsByTerm.set(term, names);
    }
  }
  return cardsByTerm;
}

/**
 * The check itself. Returns the offending terms (sorted, empty when clean) and
 * the counts the caller reports, so this is usable as a library call from
 * `build-card-index.mjs` as well as from the CLI below.
 */
export async function checkGlossaryCoverage() {
  const [{ unexplainedPoolTerms }, cardsByTerm] = await Promise.all([
    loadGlossaryModule(),
    printedKeywords(),
  ]);
  const unexplained = unexplainedPoolTerms(cardsByTerm.keys());
  return {
    printedTermCount: cardsByTerm.size,
    unexplained,
    cardsFor: (term) => cardsByTerm.get(term) ?? [],
  };
}

/** How many example card names to name per unexplained term. */
const EXAMPLES_PER_TERM = 3;

/**
 * Print the verdict. Returns `true` when clean.
 *
 * The failure message names cards, not just terms: "Amass has no row" is a fact,
 * "Amass has no row and 23 cards print it, starting with Angrath" is something
 * somebody can act on without re-running a query.
 */
export function reportGlossaryCoverage({ printedTermCount, unexplained, cardsFor }) {
  if (unexplained.length === 0) {
    console.info(`[glossary] all ${printedTermCount} printed keywords resolve.`);
    return true;
  }
  console.error(
    `[glossary] ${unexplained.length} of ${printedTermCount} printed keywords have NO glossary row\n` +
      '[glossary] and are not declared gaps. Each one renders as an unexplained word on the play\n' +
      '[glossary] surface. Add a row to apps/web/src/lib/play/keyword-glossary.ts, or — only if the\n' +
      '[glossary] term is not a printed ability at all — add it to POOL_TERMS_WITHOUT_GLOSSARY with\n' +
      '[glossary] the reason:',
  );
  for (const term of unexplained) {
    const cards = cardsFor(term);
    const examples = cards.slice(0, EXAMPLES_PER_TERM).join(', ');
    console.error(`[glossary]   ${term} — ${cards.length} card(s): ${examples}`);
  }
  return false;
}

async function main() {
  const result = await checkGlossaryCoverage();
  if (!reportGlossaryCoverage(result)) process.exitCode = 1;
}

// Only run the CLI when invoked directly; `build-card-index.mjs` imports this
// module and must not trigger a second run. `pathToFileURL` — not string
// concatenation — because a Windows argv path (`D:\…`) is not a valid URL body.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}

// Referenced so a future reader can find the file this resolves to on disk.
export const GLOSSARY_TS_PATH = fileURLToPath(GLOSSARY_TS_URL);

/**
 * OPT-IN live accuracy check: re-fetch every card in the committed index from
 * Scryfall and report any field that disagrees.
 *
 *   npm run verify -w @jonny-boi/data-tools
 *
 * Run it by hand when the index is touched, or on a schedule — NOT in `npm
 * test` and not in CI, because it hits the network and its result depends on
 * Scryfall being up and on today's Oracle wording. The offline structural guard
 * (`invariants.test.ts`) is the one that runs in the suite.
 *
 * Exits non-zero when an ORACLE-level field differs (a cost, text, P/T or type
 * the engine plays), and zero when only the printing drifted — a different
 * default printing for a name is normal and is fixed by re-running the fetch.
 *
 * Fetching goes through the same {@link ScryfallClient} as the pipeline, so the
 * same etiquette applies: descriptive User-Agent, ≥100ms between requests,
 * ≤75 identifiers per `POST /cards/collection`.
 */

import { readFile } from 'node:fs/promises';

import { createFetchHttpClient, ScryfallClient } from './client.js';
import { normalizeCard } from './normalize.js';
import { cardIndexPath } from './paths.js';
import type { CardIndex } from './types.js';
import { formatVerifyReport, scryfallLookupName, verifyCards } from './verify.js';

async function main(): Promise<void> {
  const index = JSON.parse(await readFile(cardIndexPath(), 'utf8')) as CardIndex;
  console.info(`[verify] re-fetching ${index.cards.length} cards from Scryfall…`);

  const client = new ScryfallClient(createFetchHttpClient());
  const { cards: raw, unresolved } = await client.fetchCardsByNames(
    index.cards.map(scryfallLookupName),
  );
  if (unresolved.length > 0) {
    console.warn(`[verify] Scryfall could not resolve: ${unresolved.join(', ')}`);
  }

  const report = verifyCards(index.cards, raw.map(normalizeCard));
  console.info(`\n${formatVerifyReport(report)}`);

  const oracleDiffs = report.diffs.filter((diff) => diff.kind === 'oracle');
  if (oracleDiffs.length > 0 || report.missing.length > 0) {
    console.error(
      `\n[verify] FAILED — ${oracleDiffs.length} oracle-level difference(s), ${report.missing.length} card(s) not found.` +
        '\n[verify] Regenerate with `npm run fetch -w @jonny-boi/data-tools`, then re-check the pool definitions in packages/cards that were compiled from the old data.',
    );
    process.exitCode = 1;
    return;
  }
  console.info('\n[verify] OK — every card matches live Scryfall.');
}

main().catch((error: unknown) => {
  console.error('[verify] failed:', error);
  process.exitCode = 1;
});

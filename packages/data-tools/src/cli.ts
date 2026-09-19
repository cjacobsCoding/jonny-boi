/**
 * CLI entry for the data-tools pipeline. Run via `npm run fetch` in this
 * package, or `node dist/cli.js`. Fetches the curated starter list (or names
 * passed as args), normalizes, downloads art, and writes the card index.
 *
 * Usage:
 *   npm run fetch                      # uses the committed starter list
 *   npm run fetch -- "Lightning Bolt" "Counterspell"   # ad-hoc names
 *   npm run fetch -- --no-art          # skip art download (data only)
 *   npm run fetch -- --corpus <file> --no-art   # OFFLINE, from a bulk corpus
 *
 * The `--corpus` form is how an index for the whole printed pool gets built
 * (§3.71): one bulk download (`packages/cards/scripts/fetch-full-corpus.mjs`)
 * replaces sixty-five paged requests, and the same pipeline does the rest. It
 * pairs with `--no-art` in practice — thousands of images is a separate, slow,
 * deliberate step, and the index carries Scryfall's own image URLs regardless.
 */

import { readFile } from 'node:fs/promises';
import { runPipeline } from './pipeline.js';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const skipArt = args.includes('--no-art');
  const corpusAt = args.indexOf('--corpus');
  const corpusPath = corpusAt >= 0 ? args[corpusAt + 1] : undefined;
  const names = args.filter((arg, i) => !arg.startsWith('--') && i !== corpusAt + 1);

  const rawCards =
    corpusPath === undefined
      ? undefined
      : (JSON.parse(await readFile(corpusPath, 'utf8')) as unknown[]);

  const result = await runPipeline({
    names: names.length > 0 ? names : undefined,
    skipArt,
    ...(rawCards === undefined ? {} : { rawCards }),
  });

  console.info('\n=== data-tools pipeline complete ===');
  console.info(`resolved:   ${result.resolved}/${result.index.requested}`);
  if (result.unresolved.length > 0) {
    console.info(`unresolved: ${result.unresolved.join(', ')}`);
  }
  if (result.art) {
    console.info(
      `art:        ${result.art.downloaded} downloaded, ${result.art.skipped} cached, ${result.art.failed} failed`,
    );
  }
  console.info(`index:      ${result.outputPath}`);
  if (result.corpus) {
    console.info(
      `corpus:     ${result.corpus.index.cards.length} cards the pool does not hold → ${result.corpus.outputPath}`,
    );
  }
}

main().catch((error: unknown) => {
  console.error('[data-tools] pipeline failed:', error);
  process.exitCode = 1;
});

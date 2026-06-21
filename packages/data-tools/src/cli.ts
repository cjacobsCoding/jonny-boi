/**
 * CLI entry for the data-tools pipeline. Run via `npm run fetch` in this
 * package, or `node dist/cli.js`. Fetches the curated starter list (or names
 * passed as args), normalizes, downloads art, and writes the card index.
 *
 * Usage:
 *   npm run fetch                      # uses the committed starter list
 *   npm run fetch -- "Lightning Bolt" "Counterspell"   # ad-hoc names
 *   npm run fetch -- --no-art          # skip art download (data only)
 */

import { runPipeline } from './pipeline.js';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const skipArt = args.includes('--no-art');
  const names = args.filter((arg) => !arg.startsWith('--'));

  const result = await runPipeline({
    names: names.length > 0 ? names : undefined,
    skipArt,
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
}

main().catch((error: unknown) => {
  console.error('[data-tools] pipeline failed:', error);
  process.exitCode = 1;
});

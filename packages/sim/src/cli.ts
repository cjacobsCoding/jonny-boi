#!/usr/bin/env node
import { CORE_DEPENDENCY, PACKAGE_NAME } from './index.js';

/**
 * The `npm run sim` entrypoint. For the scaffold this only prints a usage
 * placeholder — the real headless gauntlet/A-B runner lands in §3.5. It must
 * exit cleanly on no args and on unknown args (never crash), so the documented
 * command is always safe to run.
 */
const USAGE = [
  'jonny-boi sim — headless MTG gauntlet / A-B card-swap lab (scaffold placeholder)',
  '',
  'Usage:',
  '  npm run sim -- --help        Show this message',
  '',
  'The real simulation harness (runMatch / runGauntlet, win-rate confidence',
  'intervals, single-card A/B significance) arrives with roadmap item §3.5.',
].join('\n');

function main(argv: readonly string[]): number {
  const args = argv.slice(2);
  // Every current invocation — no args, --help, or anything unknown — is a
  // safe no-op that prints usage and exits 0 until the harness exists.
  console.log(USAGE);
  if (args.length > 0) {
    const recognized = new Set(['--help', '-h']);
    const unknown = args.filter((arg) => !recognized.has(arg));
    if (unknown.length > 0) {
      console.log(`\n(Ignoring unrecognized argument(s): ${unknown.join(', ')})`);
    }
  }
  console.log(`\n[${PACKAGE_NAME}] ready; core dependency resolved as "${CORE_DEPENDENCY}".`);
  return 0;
}

process.exit(main(process.argv));

/**
 * COVERAGE AUDIT — turn "which mechanics are missing?" into measured data.
 *
 * The work queue in UNSUPPORTED-MECHANICS.md is fed by whatever cards a user
 * happened to try to add, which means it is empty until someone goes looking and
 * biased by who looked. Picking the next engine system off that is guessing.
 *
 * This asks the question directly: take a large corpus of cards people ACTUALLY
 * PLAY, run every one through the real compiler, and tally which missing engine
 * system blocks the most cards. The output is a ranked backlog where the top item
 * is, by construction, the one that unblocks the most real decks.
 *
 * Corpus: Scryfall search, ordered by EDHREC rank (a popularity proxy), so a
 * mechanic that blocks fringe cards cannot outrank one that blocks staples.
 * Requests go through the same rate-limited client the fetch pipeline uses.
 *
 * Usage:
 *   node packages/cards/scripts/coverage-audit.mjs [--pages N] [--query "..."]
 *   node packages/cards/scripts/coverage-audit.mjs --input <cards.json>
 *
 * NETWORK. Never run from a test or from CI — it is a triage tool, run by hand,
 * whose OUTPUT is committed.
 */

import { writeFileSync } from 'node:fs';
import { USER_AGENT, normalizeCard } from '@jonny-boi/data-tools';
import { compileCard } from '@jonny-boi/cards';

/** Cards per Scryfall search page (their page size, not ours to choose). */
const CARDS_PER_PAGE = 175;
/** Default corpus size — enough that a 1% mechanic is still several cards. */
const DEFAULT_PAGES = 12;
/**
 * Cards people actually play, most-played first. Excludes un-sets and joke cards
 * (`is:funny`), which would pad the "unimplementable" column with cards nobody
 * wants. Paper-legal formats only — digital-only cards use mechanics that do not
 * exist in paper Magic.
 */
const DEFAULT_QUERY = 'legal:modern -is:funny';
/**
 * How many gaps the report lists. The tail is thousands of one-off templates;
 * listing them all buries the systems that matter. The count that is cut is
 * always stated — a truncated report that looks complete is worse than none.
 */
const TOP_N = 25;

function parseArgs(argv) {
  const args = { pages: DEFAULT_PAGES, query: DEFAULT_QUERY, input: null, out: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--pages') args.pages = Number(argv[++i]);
    else if (argv[i] === '--query') args.query = argv[++i];
    else if (argv[i] === '--input') args.input = argv[++i];
    else if (argv[i] === '--out') args.out = argv[++i];
  }
  return args;
}

/** Scryfall asks for 50–100ms between requests; exceed it to be a good citizen. */
const REQUEST_INTERVAL_MS = 150;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Pull `pages` pages of search results, rate-limited. */
async function fetchCorpus(query, pages) {
  const cards = [];
  for (let page = 1; page <= pages; page++) {
    const url =
      `https://api.scryfall.com/cards/search?q=${encodeURIComponent(query)}` +
      `&order=edhrec&unique=cards&page=${page}`;
    let body;
    try {
      const response = await fetch(url, {
        headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
      });
      if (!response.ok) {
        console.error(`  page ${page} → HTTP ${response.status}; stopping early`);
        break;
      }
      body = await response.json();
    } catch (err) {
      console.error(`  page ${page} failed (${err?.message ?? err}); stopping early`);
      break;
    }
    if (!body?.data?.length) break;
    cards.push(...body.data);
    process.stderr.write(`  page ${page}/${pages} → ${cards.length} cards\r`);
    if (!body.has_more) break;
    await sleep(REQUEST_INTERVAL_MS);
  }
  process.stderr.write('\n');
  return cards;
}

/**
 * A system name that tells you nothing — the compiler's catch-all for text no
 * rule matched. Left whole it dominates the ranking while naming no actual work.
 */
const CATCH_ALL = /does not recognize yet/i;

/**
 * Group a clause into something someone could pick up.
 *
 * Named systems are already the unit of work. The catch-all bucket is not, so we
 * sub-group it by the clause's opening words — the shape of the rules template —
 * which turns one meaningless 34-card pile into clusters like "When ~ enters,"
 * or "Whenever you cast" that map to real compiler rules.
 */
function bucketFor(clause) {
  if (!CATCH_ALL.test(clause.missingEngineSystem)) return clause.missingEngineSystem;
  const shape = clause.text
    .replace(/\{[^}]*\}/g, '{}') // mana symbols vary, the template does not
    .replace(/\b\d+\b/g, 'N') // "draw 2" and "draw 3" are one template
    .split(/\s+/)
    .slice(0, 5)
    .join(' ')
    .replace(/[.,:;]$/, '');
  return `${clause.missingEngineSystem} — starting "${shape}…"`;
}

/**
 * Compile every card and tally the missing systems.
 *
 * Counted PER CARD, not per clause: a card naming the same gap three times is one
 * blocked card, and blocked cards are what the backlog is ranked by. Occurrences
 * are kept separately as a texture signal.
 */
function audit(rawCards) {
  const systems = new Map();
  let complete = 0;
  let failed = 0;

  for (const raw of rawCards) {
    let result;
    try {
      result = compileCard(normalizeCard(raw));
    } catch {
      // The audit's whole point is counting what fails to compile, so a throw
      // here is data, not an error to surface — the tally is the report.
      failed++;
      continue;
    }
    if (result.status === 'complete') {
      complete++;
      continue;
    }
    // One entry per distinct system this card is blocked on.
    const distinct = new Map();
    for (const clause of result.missing) {
      const key = bucketFor(clause);
      if (!distinct.has(key)) distinct.set(key, clause.text);
    }
    for (const [system, exampleClause] of distinct) {
      const entry = systems.get(system) ?? {
        system,
        cards: [],
        occurrences: 0,
        exampleClause,
      };
      entry.cards.push(result.definition?.name ?? raw.name);
      entry.occurrences += result.missing.filter((m) => bucketFor(m) === system).length;
      systems.set(system, entry);
    }
  }

  const ranked = [...systems.values()].sort((a, b) => b.cards.length - a.cards.length);
  return { ranked, complete, failed, total: rawCards.length };
}

/** Render the ranked backlog as the Markdown the work queue expects. */
function toMarkdown({ ranked, complete, failed, total }, query, generatedAt) {
  const blocked = total - complete - failed;
  const pct = (n) => `${((n / total) * 100).toFixed(1)}%`;

  const lines = [];
  lines.push(`<!-- generated by packages/cards/scripts/coverage-audit.mjs — do not hand-edit -->`);
  lines.push('');
  lines.push(`**Corpus:** ${total} cards — Scryfall \`${query}\`, ordered by EDHREC rank (most-played first).`);
  lines.push(`**Measured:** ${generatedAt}`);
  lines.push('');
  lines.push(`| | cards | share |`);
  lines.push(`|---|---:|---:|`);
  lines.push(`| Fully playable today | ${complete} | ${pct(complete)} |`);
  lines.push(`| Blocked by a missing system | ${blocked} | ${pct(blocked)} |`);
  if (failed > 0) lines.push(`| Compiler threw (a bug — investigate) | ${failed} | ${pct(failed)} |`);
  lines.push('');
  lines.push(`Ranked by **how many cards each system unblocks**, so the top row is the`);
  lines.push(`highest-value engine work available.`);
  lines.push('');

  const shown = ranked.slice(0, TOP_N);
  if (ranked.length > TOP_N) {
    const tailCards = ranked.slice(TOP_N).reduce((n, e) => n + e.cards.length, 0);
    lines.push(
      `Showing the top ${TOP_N} of **${ranked.length}** distinct gaps. The remaining ` +
        `${ranked.length - TOP_N} account for ${tailCards} card-blocks between them — a long tail of ` +
        `one-off templates, not a second tier of systems. Re-run with a larger \`--top\` to see it.`,
    );
    lines.push('');
  }

  for (const entry of shown) {
    const examples = entry.cards.slice(0, 8).join(', ');
    const more = entry.cards.length > 8 ? `, +${entry.cards.length - 8} more` : '';
    lines.push(`## ${entry.system}`);
    lines.push('');
    lines.push(`- **Blocks ${entry.cards.length} card(s)** (${pct(entry.cards.length)} of corpus)`);
    lines.push(`- **Occurrences:** ${entry.occurrences}`);
    lines.push(`- **Cards:** ${examples}${more}`);
    lines.push(`- **Example clause:** \`${entry.exampleClause}\``);
    lines.push('');
  }
  return lines.join('\n');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  let raw;

  if (args.input) {
    const { readFileSync } = await import('node:fs');
    raw = JSON.parse(readFileSync(args.input, 'utf8'));
    if (!Array.isArray(raw)) raw = raw.cards ?? [];
    console.error(`Loaded ${raw.length} cards from ${args.input}`);
  } else {
    console.error(`Fetching up to ${args.pages * CARDS_PER_PAGE} cards: "${args.query}"`);
    raw = await fetchCorpus(args.query, args.pages);
  }

  if (raw.length === 0) {
    console.error('No cards fetched — nothing to audit.');
    process.exit(1);
  }

  const result = audit(raw);
  const markdown = toMarkdown(result, args.input ?? args.query, new Date().toISOString().slice(0, 10));

  if (args.out) {
    writeFileSync(args.out, markdown, 'utf8');
    console.error(`\nWrote ${args.out}`);
  } else {
    process.stdout.write(markdown);
  }

  console.error(
    `\n${result.complete}/${result.total} playable · ` +
      `${result.ranked.length} distinct missing systems · top: ${result.ranked[0]?.system ?? '—'}`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});



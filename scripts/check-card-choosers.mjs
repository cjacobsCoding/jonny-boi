/**
 * NO RAW CARD CHOOSERS — the executable form of §3.181's rule.
 *
 * ## Why this is a script and not a sentence
 *
 * `CardPicker`'s own doc-comment used to assert the rule in prose:
 *
 *   "Every selector that picks ONE card from a list of any size goes through
 *    this component — the Lab's cut and add pickers today, and whatever comes
 *    next."
 *
 * That sentence was false of the app on the day it was written. `<CardPicker`
 * appeared in exactly ONE component while three other surfaces chose a card
 * from a list their own way — including a grid of ~35 bare checkboxes with no
 * search of any kind, on the Lab control people reach for most.
 *
 * Caleb has now asked for type-to-filter card choosers TWICE, in different
 * words, months apart. Prose did not hold either time. So the rule is this
 * file: a new raw card chooser fails a check instead of quietly shipping.
 *
 * ## ⚠️ What this gate deliberately does NOT do
 *
 * It does **not** check "does the file import CardPicker". That check is
 * satisfied by an unused import — a hole a sibling lane found in one of its own
 * guards the same week. This gate only ever looks for the SHAPES a raw chooser
 * takes, so the only way to pass is to not contain one.
 *
 * There is also **no inline suppression** — no magic comment turns a violation
 * off. The sole escape is {@link ALLOWLIST} below, in this file, where each
 * entry must carry a reason and is itself verified: an entry naming a file that
 * no longer exists, or one that no longer violates, FAILS the gate. An
 * allowlist that cannot go stale is the only kind worth having.
 *
 * Comments and string literals are stripped before scanning, so a mention of
 * `<datalist>` in a doc-comment is not a violation (live code cannot hide in a
 * comment, so stripping them can only remove false alarms, never real hits).
 *
 * ## Out of scope, on purpose: card GRIDS
 *
 * The Cards view and the deck builder's grid render a tile per card with its
 * art. A filtered grid of pictures is not a list you pick one option out of,
 * and it already has the card browser's own search above it. The rule targets
 * CHOOSERS, so a `.map` that renders card ART is not a hit — see
 * {@link RENDERS_CARD_ART}. The DECKLIST panel is out for the same reason: a
 * list of the cards you already own, with buttons that add and remove copies,
 * is content you operate on rather than a list you pick an option from.
 *
 * ## WHAT THIS GATE CANNOT SEE — stated, not implied
 *
 * Every detector keys off a POOL CARD IDENTIFIER (`cardId` / `card.id`). A
 * chooser over card NAMES as plain strings is therefore invisible to it, and
 * two real surfaces are exactly that: the deck builder's Add dialog (Scryfall
 * names, fetched over the network) and the scan fixer (the ~30k Magic name
 * vocabulary). Both are recorded in {@link ALLOWLIST} as `out-of-scope` WITH
 * their reasons, so the app's full list of card-choosing surfaces is reviewable
 * in one place even though the detectors only police the pool-card half.
 *
 * Widening the detectors to a bare `.name` was measured and rejected: it
 * matches decks, pilots and opponents, and a gate that cries wolf is a gate
 * someone deletes. If a future chooser picks a POOL card by name alone, this
 * gate will miss it — a known limit, not an accident.
 *
 * Usage:
 *   node scripts/check-card-choosers.mjs            # exit 1 on any violation
 *   node scripts/check-card-choosers.mjs --list     # print what it scanned
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const SCAN_ROOT = join(REPO_ROOT, 'apps', 'web', 'src');

/**
 * The ONLY escape from the rule. Every entry carries the reason it is here, and
 * every entry is verified — see `checkAllowlist`.
 *
 * A path is repo-relative and uses forward slashes on every platform.
 */
export const ALLOWLIST = [
  {
    path: 'apps/web/src/components/lab/CardPicker.tsx',
    kind: 'exempt',
    reason:
      'IS the picker. It is the component every other card chooser is required to go through, so the chooser markup here is the implementation of the rule rather than a violation of it.',
  },
  {
    path: 'apps/web/src/components/AddCardDialog.tsx',
    kind: 'out-of-scope',
    reason:
      "Picks a card that is NOT IN THE POOL YET. Its vocabulary is the whole of Scryfall, resolved over the network by Scryfall's own fuzzy match, and its list of buttons appears only when a typed name is genuinely ambiguous. CardPicker chooses from a known list of LOCAL pool cards and previews them from local card data, so it cannot serve a card the app has never seen. The list is also always far below the fuzzy threshold (a handful of alternative spellings). It chooses a NAME, not a cardId, which is why the detectors below do not see it.",
  },
  {
    path: 'apps/web/src/components/ScanDeckDialog.tsx',
    kind: 'out-of-scope',
    reason:
      "Corrects an OCR misread by choosing a NAME from the full ~30k Magic card-name vocabulary, not a card from the playable pool — most of those names have no local card record, so the dwell preview would have nothing to show. It already has a typable filter, and since §3.181 it shares the app's one fuzzy matcher (`matchOneQuery`) with the picker, which is the DRY half of the rule. Its default list is the OCR's own scored matches, a ranking CardPicker knows nothing about.",
  },
];

/** A `.map(` region that renders card ART is a grid, not a chooser. */
const RENDERS_CARD_ART = /<img|CardFace|CardTile|CardHover|cardImage|backgroundImage/;

/** Identifiers that mean "this iteration is over cards". */
const CARD_IDENTITY = /\bcardId\b|\bcard\.id\b/;

/**
 * The chooser shapes, as a TABLE. Adding a way to build a card chooser is a ROW.
 *
 * `scope: 'file'`  — the token is a chooser wherever it appears in the file.
 * `scope: 'map'`   — the token only means "chooser" inside a `.map(...)` region
 *                    that is iterating cards; that is what tells a checkbox list
 *                    of card names apart from a checkbox anywhere else.
 */
const CHOOSER_SHAPES = [
  {
    id: 'datalist',
    scope: 'file',
    pattern: /<datalist\b/,
    what: 'a <datalist> — a native autocomplete list',
  },
  {
    id: 'aria-listbox',
    scope: 'file',
    pattern: /role=["']listbox["']/,
    what: 'role="listbox" — a hand-rolled listbox',
  },
  {
    id: 'aria-combobox',
    scope: 'file',
    pattern: /role=["']combobox["']/,
    what: 'role="combobox" — a hand-rolled combobox',
  },
  {
    id: 'select-of-cards',
    scope: 'map',
    pattern: /<option\b/,
    what: 'a <select>/<option> list of cards',
  },
  {
    id: 'checkbox-list-of-cards',
    scope: 'map',
    pattern: /type=["']checkbox["']/,
    what: 'a checkbox per card (the §3.136 focus grid\'s old shape)',
  },
  {
    id: 'button-list-of-cards',
    scope: 'map',
    pattern: /<button\b/,
    // ⚠️ CALIBRATED AGAINST THE REAL TREE, not guessed. Without the receiver
    // test this fired on `group.entries.map(...)` in DeckBuilderView — the
    // DECKLIST, where the buttons add and remove copies. A list of the cards you
    // already own is content you operate on, not a list you pick an option from,
    // and a gate that cried wolf there would have been turned off within a week.
    receiver: /option|candidate|choice|pick|selectable/i,
    what: 'a button per card in a list of candidates, with no card art (an art grid is not a chooser)',
  },
];

/**
 * Remove comments and string/template literals.
 *
 * Deliberately simple and deliberately conservative: it may leave a fragment of
 * an exotic template literal behind, which can only ever produce a REPORTED
 * violation a human then reads — never a silent pass.
 */
export function stripCommentsAndStrings(source) {
  let out = '';
  let i = 0;
  const n = source.length;
  while (i < n) {
    const two = source.slice(i, i + 2);
    if (two === '//') {
      while (i < n && source[i] !== '\n') i += 1;
      continue;
    }
    if (two === '/*') {
      i += 2;
      while (i < n && source.slice(i, i + 2) !== '*/') i += 1;
      i += 2;
      continue;
    }
    const ch = source[i];
    if (ch === '"' || ch === "'" || ch === '`') {
      // Keep the quotes and the content: `role="listbox"` IS the thing we look
      // for, and it lives inside quotes. Only NEWLINES are collapsed, so a
      // multi-line template cannot swallow the rest of the file.
      const quote = ch;
      out += ch;
      i += 1;
      while (i < n) {
        if (source[i] === '\\') {
          out += '  ';
          i += 2;
          continue;
        }
        if (source[i] === quote) break;
        out += source[i] === '\n' ? '\n' : source[i];
        i += 1;
      }
      out += quote;
      i += 1;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

/**
 * Every `.map(` call region in `source`, balanced on parentheses, with the
 * RECEIVER it was called on (`cutOptions` in `cutOptions.map(...)`).
 *
 * The receiver is what tells a chooser apart from a list of cards you are
 * merely looking at: a chooser iterates candidates, a decklist iterates
 * entries. See the `button-list-of-cards` row.
 */
function mapRegions(source) {
  const regions = [];
  const needle = '.map(';
  let from = 0;
  for (;;) {
    const start = source.indexOf(needle, from);
    if (start === -1) break;
    let depth = 0;
    let i = start + needle.length - 1;
    for (; i < source.length; i += 1) {
      if (source[i] === '(') depth += 1;
      else if (source[i] === ')') {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    // Walk backwards over the identifier chain that `.map` was called on.
    let r = start;
    while (r > 0 && /[A-Za-z0-9_$.\]]/.test(source[r - 1])) r -= 1;
    regions.push({
      start,
      receiver: source.slice(r, start),
      text: source.slice(start, Math.min(i + 1, source.length)),
    });
    from = start + needle.length;
  }
  return regions;
}

function lineOf(source, index) {
  let line = 1;
  for (let i = 0; i < index && i < source.length; i += 1) if (source[i] === '\n') line += 1;
  return line;
}

function listTsxFiles(dir) {
  const found = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      found.push(...listTsxFiles(full));
      continue;
    }
    if (entry.endsWith('.tsx') && !entry.endsWith('.test.tsx')) found.push(full);
  }
  return found;
}

/** Repo-relative, forward slashes, on every platform. */
function repoPath(file) {
  return relative(REPO_ROOT, file).split(sep).join('/');
}

/**
 * Every raw card chooser in `apps/web/src`, allowlist NOT applied.
 *
 * ⚠️ CRLF: the repo stores LF in git and CRLF on disk with no `.gitattributes`,
 * so newlines are normalised before anything is matched. A guard that
 * byte-compares without this false-alarms on every Windows checkout.
 */
export function findRawCardChoosers(root = SCAN_ROOT) {
  const violations = [];
  for (const file of listTsxFiles(root)) {
    const raw = readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
    const source = stripCommentsAndStrings(raw);
    const path = repoPath(file);

    for (const shape of CHOOSER_SHAPES) {
      if (shape.scope === 'file') {
        const hit = shape.pattern.exec(source);
        if (hit) violations.push({ path, shape: shape.id, what: shape.what, line: lineOf(source, hit.index) });
        continue;
      }
      for (const region of mapRegions(source)) {
        if (!CARD_IDENTITY.test(region.text)) continue;
        if (!shape.pattern.test(region.text)) continue;
        // A map that paints card art is a GRID, not a chooser.
        if (RENDERS_CARD_ART.test(region.text)) continue;
        if (shape.receiver && !shape.receiver.test(region.receiver)) continue;
        violations.push({ path, shape: shape.id, what: shape.what, line: lineOf(source, region.start) });
        break;
      }
    }
  }
  return violations;
}

/**
 * The allowlist must describe reality: an entry for a file that is gone, or for
 * a file that no longer contains a chooser, is a stale exemption and fails.
 * Otherwise the allowlist becomes the place violations go to be forgotten.
 */
export function checkAllowlist(violations) {
  const problems = [];
  const violatingPaths = new Set(violations.map((v) => v.path));
  for (const entry of ALLOWLIST) {
    if (!entry.reason || entry.reason.trim().length < 40) {
      problems.push(`allowlist entry "${entry.path}" has no real reason written next to it`);
    }
    if (entry.kind !== 'exempt' && entry.kind !== 'out-of-scope') {
      problems.push(`allowlist entry "${entry.path}" has no kind — use 'exempt' or 'out-of-scope'`);
    }
    let exists = true;
    try {
      statSync(join(REPO_ROOT, entry.path));
    } catch {
      exists = false;
    }
    if (!exists) {
      problems.push(`allowlist entry "${entry.path}" names a file that does not exist — delete the entry`);
      continue;
    }
    // An 'exempt' entry excuses a REAL hit, so it must still be one: otherwise
    // the allowlist becomes where violations go to be forgotten. An
    // 'out-of-scope' entry is the opposite — it documents a card-choosing
    // surface the detectors deliberately cannot see, so it must NOT be a hit,
    // or it was really an exemption wearing the wrong label.
    if (entry.kind === 'exempt' && !violatingPaths.has(entry.path)) {
      problems.push(
        `allowlist entry "${entry.path}" (exempt) no longer contains a raw card chooser — delete it, the exemption is stale`,
      );
    }
    if (entry.kind === 'out-of-scope' && violatingPaths.has(entry.path)) {
      problems.push(
        `allowlist entry "${entry.path}" (out-of-scope) now DOES contain a detectable raw card chooser — it is an exemption, not an out-of-scope note; fix it or change its kind`,
      );
    }
  }
  return problems;
}

export function run({ list = false } = {}) {
  const violations = findRawCardChoosers();
  const allowed = new Set(ALLOWLIST.filter((e) => e.kind === 'exempt').map((e) => e.path));
  const offenders = violations.filter((v) => !allowed.has(v.path));
  const staleness = checkAllowlist(violations);

  if (list) {
    console.log(`scanned: ${SCAN_ROOT}`);
    for (const v of violations) {
      console.log(`  ${allowed.has(v.path) ? 'allowed  ' : 'VIOLATION'} ${v.path}:${v.line} — ${v.what}`);
    }
  }

  for (const problem of staleness) console.error(`STALE ALLOWLIST: ${problem}`);
  for (const v of offenders) {
    console.error(
      `RAW CARD CHOOSER: ${v.path}:${v.line} — ${v.what}.\n` +
        `  Every card chooser goes through apps/web/src/components/lab/CardPicker.tsx (DESIGN §3.181).\n` +
        `  If this genuinely cannot, add it to ALLOWLIST in scripts/check-card-choosers.mjs WITH A REASON.`,
    );
  }

  const failed = offenders.length + staleness.length;
  console.log(
    failed === 0
      ? `no-raw-card-dropdown: OK — ${violations.length} chooser site(s), all ${ALLOWLIST.length} accounted for by the allowlist`
      : `no-raw-card-dropdown: FAILED — ${offenders.length} raw chooser(s), ${staleness.length} stale allowlist entr(ies)`,
  );
  return failed;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  process.exit(run({ list: process.argv.includes('--list') }) === 0 ? 0 : 1);
}

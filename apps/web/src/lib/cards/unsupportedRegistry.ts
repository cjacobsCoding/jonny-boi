/**
 * The UNSUPPORTED-MECHANIC REGISTRY — the running list of engine systems real
 * cards have asked for and not got.
 *
 * The compiler already refuses to fake a card it cannot play, and reports the
 * exact clause plus the system it would need. But that verdict was per-import and
 * then gone: the user saw "this card needs player choice during resolution",
 * shrugged, and nobody ever collected it. So the same gaps kept being discovered
 * and forgotten instead of being implemented.
 *
 * This accumulates every such verdict across every card the user ever adds, keyed
 * by the missing SYSTEM (not the card), because the system is the unit of work: a
 * developer implements "player choice during resolution" once and unblocks every
 * card waiting on it. Each entry keeps the cards that wanted it and one verbatim
 * clause, so the work has a concrete test case attached.
 *
 * It is deliberately exportable as text — {@link formatUnsupportedReport} — so it
 * can be pasted straight into an issue or a repo doc for whoever picks it up.
 */

import type { UnsupportedClause } from '@jonny-boi/cards';

/** One engine system that real cards are waiting on. */
export interface UnsupportedMechanic {
  /** The missing system, in the compiler's user-facing words. The work item. */
  readonly system: string;
  /** Names of cards blocked on it, de-duplicated, in first-seen order. */
  readonly cards: readonly string[];
  /** One verbatim printed clause, as a concrete case to implement against. */
  readonly exampleText: string;
  /** How many blocked clauses have been attributed to this system. */
  readonly occurrences: number;
}

/** localStorage key holding the registry. */
const STORAGE_KEY = 'jonny-boi:unsupported-mechanics:v1';

/**
 * Cap on card names kept per system. The list is a work queue, not an archive —
 * a handful of examples is enough to implement against, and an unbounded list
 * would grow without limit in localStorage.
 */
export const MAX_CARDS_PER_MECHANIC = 25;

interface StoredMechanic {
  system: string;
  cards: string[];
  exampleText: string;
  occurrences: number;
}

let registry = new Map<string, StoredMechanic>();
let loaded = false;
const listeners = new Set<() => void>();

function ensureLoaded(): void {
  if (loaded) return;
  loaded = true;
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
    if (!raw) return;
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return;
    for (const entry of parsed as StoredMechanic[]) {
      if (entry?.system) registry.set(entry.system, entry);
    }
  } catch {
    // Corrupt storage must never break card adding — start empty.
    registry = new Map();
  }
}

function persist(): void {
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify([...registry.values()]));
  } catch {
    // Quota/disabled storage: the in-memory registry still serves the session.
  }
}

function emitChange(): void {
  for (const listener of listeners) listener();
}

/**
 * Record that `cardName` could not be played because of `clauses`.
 *
 * Safe to call repeatedly for the same card — occurrences count clauses, but a
 * card is listed once per system, so re-adding a card cannot inflate the queue.
 */
export function recordUnsupported(cardName: string, clauses: readonly UnsupportedClause[]): void {
  ensureLoaded();
  if (clauses.length === 0) return;
  for (const clause of clauses) {
    const system = clause.missingEngineSystem.trim() || 'unclassified';
    const existing = registry.get(system);
    if (!existing) {
      registry.set(system, {
        system,
        cards: [cardName],
        exampleText: clause.text,
        occurrences: 1,
      });
      continue;
    }
    existing.occurrences += 1;
    if (!existing.cards.includes(cardName) && existing.cards.length < MAX_CARDS_PER_MECHANIC) {
      existing.cards.push(cardName);
    }
  }
  persist();
  emitChange();
}

/**
 * Every system cards are waiting on, most-wanted first — the order a developer
 * should work through them, since the top entry unblocks the most cards.
 */
export function unsupportedMechanics(): readonly UnsupportedMechanic[] {
  ensureLoaded();
  return [...registry.values()]
    .map((m) => ({ ...m, cards: [...m.cards] }))
    .sort((a, b) => b.cards.length - a.cards.length || b.occurrences - a.occurrences || a.system.localeCompare(b.system));
}

/** How many distinct systems are outstanding (for a badge / summary line). */
export function unsupportedMechanicCount(): number {
  ensureLoaded();
  return registry.size;
}

/** Drop the whole queue (after the gaps have been filed as real work). */
export function clearUnsupportedMechanics(): void {
  ensureLoaded();
  registry = new Map();
  persist();
  emitChange();
}

/** Subscribe to registry changes; returns an unsubscribe function. */
export function subscribeToUnsupportedMechanics(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Render the queue as Markdown, ready to paste into an issue or a repo doc.
 *
 * This is the hand-off format: each heading is one unit of work, with the cards
 * it unblocks and a verbatim clause to implement against.
 */
export function formatUnsupportedReport(mechanics: readonly UnsupportedMechanic[] = unsupportedMechanics()): string {
  if (mechanics.length === 0) {
    return '# Unsupported mechanics\n\nNone — every card added so far compiles to a fully playable definition.\n';
  }
  const lines: string[] = [
    '# Unsupported mechanics',
    '',
    `${mechanics.length} engine system(s) are blocking real cards, most-wanted first.`,
    '',
  ];
  for (const m of mechanics) {
    lines.push(`## ${m.system}`);
    lines.push('');
    lines.push(`- **Blocks ${m.cards.length} card(s):** ${m.cards.join(', ')}`);
    lines.push(`- **Occurrences:** ${m.occurrences}`);
    lines.push(`- **Example clause:** \`${m.exampleText}\``);
    lines.push('');
  }
  return lines.join('\n');
}

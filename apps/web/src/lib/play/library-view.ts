/**
 * The GAME LIBRARY as the list actually reads on screen (§3.66) — pure, so what
 * each row says is testable without a DOM.
 *
 * The library stores games; this turns them into rows a person can scan: who
 * played whom, how far it got, how it ended, and — the part that needs saying
 * out loud — WHICH PLAYTHROUGH THIS ONE IS A FORK OF. A list of forks with no
 * visible relationship is just a pile of near-identical games.
 */
import type { HistoryEntry, HistoryOutcome } from './history.js';
import { childrenOf, findEntry, isUnfinished, lineageOf, rootOf, sortByRecency } from './history.js';

/** One row of the library list. */
export interface LibraryRow {
  readonly id: string;
  /** "Player 1 vs Computer" */
  readonly title: string;
  /** "Selesnya Blink vs Mono-Red Aggro" */
  readonly decks: string;
  /** "Solo" | "pass-and-play" */
  readonly mode: string;
  readonly turn: number;
  readonly actions: number;
  readonly outcome: HistoryOutcome;
  /** Short human outcome: "in progress", "Player 1 won", "draw". */
  readonly outcomeText: string;
  readonly resumable: boolean;
  readonly updatedAt: number;
  /**
   * How deep in its fork lineage this row sits — 0 for an original playthrough.
   * The list indents by this, which is the whole "which are forks of each
   * other" affordance.
   */
  readonly depth: number;
  /** Set only on a fork: "forked from Player 1 vs Computer at turn 6". */
  readonly forkedFrom?: string;
  /** How many games were forked directly from this one. */
  readonly forkCount: number;
  /** The id every row in this lineage shares — rows with equal roots connect. */
  readonly rootId: string;
}

/** Read an outcome as a sentence fragment. */
export function outcomeText(entry: HistoryEntry): string {
  const { outcome } = entry;
  if (outcome.kind === 'unfinished') return 'in progress';
  if (outcome.kind === 'draw') return `draw — ${outcome.reason}`;
  return `${entry.record.setup.names[outcome.winner]} won — ${outcome.reason}`;
}

/** How deep a fork sits below its original. Bounded by the walk in `rootOf`. */
function depthOf(entries: readonly HistoryEntry[], entry: HistoryEntry): number {
  let depth = 0;
  const seen = new Set<string>([entry.id]);
  let current: HistoryEntry | null = entry;
  while (current?.parentId) {
    const parent: HistoryEntry | null = findEntry(entries, current.parentId);
    if (!parent || seen.has(parent.id)) break;
    seen.add(parent.id);
    depth += 1;
    current = parent;
  }
  return depth;
}

/**
 * Build the rows.
 *
 * ⚠️ Ordering is BY LINEAGE, not purely by recency: every fork sits directly
 * under the game it came from. Sorting the whole list by time instead would
 * scatter a playthrough and its forks among unrelated games, which is exactly
 * the confusion the fork links exist to prevent. Lineages themselves are
 * ordered by their most recent activity, so the game you touched last is still
 * at the top.
 */
export function libraryRows(entries: readonly HistoryEntry[]): readonly LibraryRow[] {
  const roots = new Map<string, number>();
  for (const entry of entries) {
    const root = rootOf(entries, entry.id);
    roots.set(root, Math.max(roots.get(root) ?? 0, entry.updatedAt));
  }
  const orderedRoots = [...roots.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);

  const rows: LibraryRow[] = [];
  const emitted = new Set<string>();

  /** Depth-first so a fork always follows the game it forked from. */
  const emit = (entry: HistoryEntry): void => {
    if (emitted.has(entry.id)) return;
    emitted.add(entry.id);
    rows.push(toRow(entries, entry));
    for (const child of childrenOf(entries, entry.id)) emit(child);
  };

  for (const rootId of orderedRoots) {
    const members = lineageOf(entries, rootId);
    // The root itself first when it still exists; orphans emit in their own right.
    const root = findEntry(entries, rootId);
    if (root) emit(root);
    for (const member of members) emit(member);
  }
  // Anything the lineage walk could not reach (corrupt pointers) still appears —
  // a game the UI cannot categorise must not become a game the UI hides.
  for (const entry of sortByRecency(entries)) emit(entry);
  return rows;
}

function toRow(entries: readonly HistoryEntry[], entry: HistoryEntry): LibraryRow {
  const { setup } = entry.record;
  const parent = entry.parentId ? findEntry(entries, entry.parentId) : null;
  const forkedFrom =
    parent && entry.forkedAt !== undefined
      ? `forked from ${parent.record.setup.names.A} vs ${parent.record.setup.names.B} at action ${entry.forkedAt}`
      : undefined;
  return {
    id: entry.id,
    title: `${setup.names.A} vs ${setup.names.B}`,
    decks: `${setup.deckA.name} vs ${setup.deckB.name}`,
    mode: setup.ai ? 'Solo' : 'pass-and-play',
    turn: entry.record.ui.turn,
    actions: entry.record.actions.length,
    outcome: entry.outcome,
    outcomeText: outcomeText(entry),
    resumable: isUnfinished(entry),
    updatedAt: entry.updatedAt,
    depth: depthOf(entries, entry),
    ...(forkedFrom ? { forkedFrom } : {}),
    forkCount: childrenOf(entries, entry.id).length,
    rootId: rootOf(entries, entry.id),
  };
}

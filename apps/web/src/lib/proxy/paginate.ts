/**
 * Pure pagination: expand a resolved card list (quantities → one entry per copy)
 * and chunk it into fixed-size pages for the printable sheet. Kept pure and
 * dependency-free so it is unit-testable and deterministic.
 */

/** A single printable proxy face: the image + a label for accessibility. */
export interface ProxyCard {
  /** Card display name (front face name for DFCs). */
  name: string;
  /** Best print image URL (Scryfall `png` preferred). */
  imageUrl: string;
  /** Optional face label, e.g. "back", when this is a DFC back face. */
  faceLabel?: string;
}

/** A card with a copy count, before expansion. */
export interface CountedProxyCard extends ProxyCard {
  qty: number;
}

/**
 * Expand counted cards into one {@link ProxyCard} per physical copy, preserving
 * order. `4 Lightning Bolt` becomes four identical proxy cards.
 *
 * `max` caps how many copies are produced. A decklist quantity is free text, so
 * `9999 Mountain` is one keystroke away, and every copy becomes a DOM node with
 * its own `<img>` — expanding without a ceiling locks the main thread. Stopping
 * at the cap keeps the preview responsive; {@link totalCopies} still reports what
 * the list asked for, so the view can say plainly what was left off.
 */
export function expandCopies(
  cards: readonly CountedProxyCard[],
  max: number = Number.POSITIVE_INFINITY,
): ProxyCard[] {
  const limit = Number.isFinite(max) ? Math.max(0, Math.floor(max)) : Number.POSITIVE_INFINITY;
  const out: ProxyCard[] = [];
  for (const card of cards) {
    const copies = Math.max(0, Math.floor(card.qty));
    for (let i = 0; i < copies; i += 1) {
      if (out.length >= limit) return out;
      out.push({ name: card.name, imageUrl: card.imageUrl, faceLabel: card.faceLabel });
    }
  }
  return out;
}

/** Total physical copies a counted list asks for (before any cap is applied). */
export function totalCopies(cards: readonly CountedProxyCard[]): number {
  return cards.reduce((sum, card) => sum + Math.max(0, Math.floor(card.qty)), 0);
}

/** Chunk a flat card list into pages of at most `perPage` cards. */
export function paginate(cards: readonly ProxyCard[], perPage: number): ProxyCard[][] {
  if (perPage <= 0) throw new Error(`perPage must be positive, got ${perPage}`);
  const pages: ProxyCard[][] = [];
  for (let i = 0; i < cards.length; i += perPage) {
    pages.push(cards.slice(i, i + perPage));
  }
  return pages;
}

/**
 * Convenience: expand counted cards and paginate in one pass. `19` total copies
 * at `9` per page yields three pages of `9 / 9 / 1`. `max` bounds how many
 * copies are expanded (see {@link expandCopies}).
 */
export function buildPages(
  cards: readonly CountedProxyCard[],
  perPage: number,
  max: number = Number.POSITIVE_INFINITY,
): ProxyCard[][] {
  return paginate(expandCopies(cards, max), perPage);
}

/**
 * The scan pipeline: a photo of laid-out cards → a reviewed decklist.
 *
 * Orchestration only — every step it calls is either pure (`detect`, `crop`,
 * `match`) or injected (`OcrEngine`, the thumbnail renderer), which keeps this
 * testable end-to-end in Node with a fake recognizer.
 *
 * The output is deliberately a list of REVIEWABLE guesses rather than a
 * decklist. OCR on a phone photo is good, not perfect, and a scanner that
 * silently swaps a card for a similar-looking one would be worse than useless —
 * so every card carries its crop, its best guess and its runners-up, and the
 * user confirms before anything becomes a deck.
 */

import { CONFIDENT_MATCH_SCORE } from './config.js';
import { cropRegion, prepareForOcr, titleBandOf, type MutablePixelImage } from './crop.js';
import type { PixelImage, Rect } from './detect.js';
import { matchCardName, type NameIndex, type NameMatch } from './match.js';
import type { OcrEngine } from './ocr.js';

/** One detected card, as read and matched. */
export interface ScannedCard {
  /** Position in reading order — also the review list's stable key. */
  readonly index: number;
  readonly rect: Rect;
  /** Raw text the OCR engine produced, kept so the user can see what it saw. */
  readonly ocrText: string;
  /** Ranked candidate names, best first. Empty when nothing matched. */
  readonly matches: readonly NameMatch[];
  /** The name currently chosen for this card (the top match, until edited). */
  readonly chosenName: string | null;
  /** Whether the top match was strong enough to accept without a second look. */
  readonly confident: boolean;
  /** A thumbnail of the card, for the review grid. */
  readonly thumbnailUrl?: string;
}

/** Progress while a scan runs, so a 60-card photo shows a moving bar. */
export interface ScanProgress {
  readonly done: number;
  readonly total: number;
}

/** Options for {@link scanCards}. */
export interface ScanOptions {
  readonly onProgress?: (progress: ScanProgress) => void;
  /** Renders a crop to a data URL; omitted in tests (no canvas in Node). */
  readonly makeThumbnail?: (image: MutablePixelImage) => string;
}

/**
 * Read every detected card in an image.
 *
 * Cards are processed one at a time rather than in parallel: the OCR worker is
 * single-threaded, so concurrency would only queue internally while making
 * progress reporting meaningless.
 */
export async function scanCards(
  image: PixelImage,
  cells: readonly Rect[],
  engine: OcrEngine,
  nameIndex: NameIndex,
  options: ScanOptions = {},
): Promise<ScannedCard[]> {
  const results: ScannedCard[] = [];

  for (let index = 0; index < cells.length; index += 1) {
    const rect = cells[index]!;
    const titleCrop = prepareForOcr(cropRegion(image, titleBandOf(rect)));

    let ocrText = '';
    try {
      ocrText = await engine.recognize(titleCrop);
    } catch {
      // One unreadable card must not abandon the other fifty-nine; it comes
      // back as an unmatched entry the user can type in.
      ocrText = '';
    }

    const matches = matchCardName(ocrText, nameIndex);
    const best = matches[0];
    results.push({
      index,
      rect,
      ocrText,
      matches,
      chosenName: best?.name ?? null,
      confident: (best?.score ?? 0) >= CONFIDENT_MATCH_SCORE,
      ...(options.makeThumbnail
        ? { thumbnailUrl: options.makeThumbnail(cropRegion(image, rect)) }
        : {}),
    });

    options.onProgress?.({ done: index + 1, total: cells.length });
  }

  return results;
}

/** A card name and how many copies the scan found. */
export interface ScannedQuantity {
  readonly name: string;
  readonly qty: number;
}

/**
 * Fold scanned cards into decklist quantities. Physical copies of one card are
 * separate cards on the table but one line in a decklist, which is exactly the
 * aggregation a player expects when they photograph four Lightning Bolts.
 *
 * Cards with no chosen name are skipped — they are reported separately so the
 * count of "not recognised" stays honest rather than vanishing into the list.
 */
export function toQuantities(scanned: readonly ScannedCard[]): ScannedQuantity[] {
  const counts = new Map<string, number>();
  for (const card of scanned) {
    if (!card.chosenName) continue;
    counts.set(card.chosenName, (counts.get(card.chosenName) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([name, qty]) => ({ name, qty }))
    .sort((a, b) => b.qty - a.qty || a.name.localeCompare(b.name));
}

/** Render scanned quantities as decklist text the importer already understands. */
export function toDecklistText(scanned: readonly ScannedCard[]): string {
  return toQuantities(scanned)
    .map((entry) => `${entry.qty} ${entry.name}`)
    .join('\n');
}

/** How many scanned cards still have no name chosen. */
export function unrecognizedCount(scanned: readonly ScannedCard[]): number {
  return scanned.filter((card) => !card.chosenName).length;
}

/** Replace one card's chosen name (the review grid's edit action). */
export function chooseName(
  scanned: readonly ScannedCard[],
  index: number,
  name: string | null,
): ScannedCard[] {
  return scanned.map((card) =>
    card.index === index ? { ...card, chosenName: name, confident: true } : card,
  );
}

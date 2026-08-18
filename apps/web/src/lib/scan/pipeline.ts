/**
 * The scan pipeline: a photo of laid-out cards → a reviewed decklist.
 *
 * Orchestration only — every step it calls is either pure (`detect`, `stacks`,
 * `crop`, `match`) or injected (`OcrEngine`, the thumbnail renderer), which keeps
 * this testable end-to-end in Node with a fake recognizer.
 *
 * The unit of work is a PILE, not a card, because that is how a deck gets
 * photographed: four copies fanned so every title bar shows. A pile carries its
 * own quantity, so one photo yields the whole decklist — names and counts.
 * A grid of loose single cards is just a photo of piles of one.
 *
 * The output is deliberately a list of REVIEWABLE guesses rather than a
 * decklist. OCR on a phone photo is good, not perfect, and a scanner that
 * silently swapped a card for a similar-looking one would be worse than useless —
 * so every pile carries its crop, its best guess, its runners-up and its count,
 * and the user confirms before anything becomes a deck.
 */

import { CONFIDENT_MATCH_SCORE, STACK_CONSENSUS_READS } from './config.js';
import { cropRegion, prepareForOcr, type MutablePixelImage } from './crop.js';
import type { PixelImage, Rect } from './detect.js';
import { matchCardName, type NameIndex, type NameMatch } from './match.js';
import type { OcrEngine } from './ocr.js';
import type { CardStack } from './stacks.js';

/** One detected pile, as read and matched. */
export interface ScannedCard {
  /** Position in reading order — also the review list's stable key. */
  readonly index: number;
  readonly rect: Rect;
  /** How many copies of this card the pile holds. */
  readonly qty: number;
  /** Raw text the OCR engine produced, kept so the user can see what it saw. */
  readonly ocrText: string;
  /** Ranked candidate names, best first. Empty when nothing matched. */
  readonly matches: readonly NameMatch[];
  /** The name currently chosen for this card (the top match, until edited). */
  readonly chosenName: string | null;
  /** Whether the top match was strong enough to accept without a second look. */
  readonly confident: boolean;
  /** A thumbnail of the pile, for the review grid. */
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

/** Read one title band, returning '' rather than throwing on an unreadable crop. */
async function readTitle(image: PixelImage, band: Rect, engine: OcrEngine): Promise<string> {
  try {
    return await engine.recognize(prepareForOcr(cropRegion(image, band)));
  } catch {
    // One unreadable card must not abandon the other fifty-nine; it comes back
    // as an unmatched entry the user can type in.
    return '';
  }
}

/**
 * Read every detected pile in an image.
 *
 * Piles are processed one at a time rather than in parallel: the OCR worker is
 * single-threaded, so concurrency would only queue internally while making
 * progress reporting meaningless.
 *
 * The bottom card of a pile is read first because it is the cleanest crop in the
 * photo. When that read is not convincing, the fanned copies above it are read
 * too and the best match across all of them wins — every copy in a pile is the
 * SAME card, so extra looks are free accuracy, and they are only paid for on the
 * piles that actually need them.
 */
export async function scanCards(
  image: PixelImage,
  stacks: readonly CardStack[],
  engine: OcrEngine,
  nameIndex: NameIndex,
  options: ScanOptions = {},
): Promise<ScannedCard[]> {
  const results: ScannedCard[] = [];

  for (let index = 0; index < stacks.length; index += 1) {
    const stack = stacks[index]!;
    const [firstBand, ...otherBands] = stack.titleBands;

    let ocrText = firstBand ? await readTitle(image, firstBand, engine) : '';
    let matches = matchCardName(ocrText, nameIndex);

    for (const band of otherBands.slice(0, STACK_CONSENSUS_READS)) {
      if ((matches[0]?.score ?? 0) >= CONFIDENT_MATCH_SCORE) break;
      const text = await readTitle(image, band, engine);
      const candidate = matchCardName(text, nameIndex);
      if ((candidate[0]?.score ?? 0) > (matches[0]?.score ?? 0)) {
        matches = candidate;
        ocrText = text;
      }
    }

    const best = matches[0];
    results.push({
      index,
      rect: stack.bounds,
      qty: stack.count,
      ocrText,
      matches,
      chosenName: best?.name ?? null,
      confident: (best?.score ?? 0) >= CONFIDENT_MATCH_SCORE,
      ...(options.makeThumbnail
        ? { thumbnailUrl: options.makeThumbnail(cropRegion(image, stack.bounds)) }
        : {}),
    });

    options.onProgress?.({ done: index + 1, total: stacks.length });
  }

  return results;
}

/** A card name and how many copies the scan found. */
export interface ScannedQuantity {
  readonly name: string;
  readonly qty: number;
}

/**
 * Fold scanned piles into decklist quantities. The same card can appear as more
 * than one pile — a split pile, or basics photographed in two rows — so counts
 * are summed by name rather than taken per pile.
 *
 * Cards with no chosen name are skipped; they are reported separately so the
 * count of "not recognised" stays honest rather than vanishing into the list.
 */
export function toQuantities(scanned: readonly ScannedCard[]): ScannedQuantity[] {
  const counts = new Map<string, number>();
  for (const card of scanned) {
    if (!card.chosenName) continue;
    counts.set(card.chosenName, (counts.get(card.chosenName) ?? 0) + card.qty);
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

/** How many scanned piles still have no name chosen. */
export function unrecognizedCount(scanned: readonly ScannedCard[]): number {
  return scanned.filter((card) => !card.chosenName).length;
}

/** Total copies the scan will import — the number the user checks against sixty. */
export function totalCopies(scanned: readonly ScannedCard[]): number {
  return scanned.reduce((sum, card) => sum + (card.chosenName ? card.qty : 0), 0);
}

/** Replace one pile's chosen name (the review grid's edit action). */
export function chooseName(
  scanned: readonly ScannedCard[],
  index: number,
  name: string | null,
): ScannedCard[] {
  return scanned.map((card) =>
    card.index === index ? { ...card, chosenName: name, confident: true } : card,
  );
}

/**
 * Set one pile's quantity. Counting fanned copies is the guessiest step in the
 * scan — a washed-out edge or a tight fan can cost a copy — so the review grid
 * makes the count as editable as the name, and this is that edit.
 */
export function chooseQuantity(
  scanned: readonly ScannedCard[],
  index: number,
  qty: number,
): ScannedCard[] {
  const clamped = Math.max(1, Math.round(qty));
  return scanned.map((card) => (card.index === index ? { ...card, qty: clamped } : card));
}

/**
 * React state for the photo scanner. Orchestration only — the real work lives in
 * the pure modules this calls, so the hook stays boring and the logic stays
 * testable without React.
 */

import { useCallback, useRef, useState } from 'react';
import { loadCardNames } from './catalog.js';
import { detectCards, gridCells, type DetectionResult, type PixelImage } from './detect.js';
import { buildNameIndex, type NameIndex } from './match.js';
import { createOcrEngine, decodeImageFile, toDataUrl } from './ocr.js';
import {
  chooseName as chooseNameIn,
  chooseQuantity as chooseQuantityIn,
  scanCards,
  toDecklistText,
  totalCopies,
  unrecognizedCount,
  type ScanProgress,
  type ScannedCard,
} from './pipeline.js';
import { detectStacks, stacksFromGrid, type CardStack } from './stacks.js';

/** Where the scan flow currently is. */
export type ScanPhase = 'idle' | 'preparing' | 'scanning' | 'review' | 'error';

/** A manual layout the user supplies when auto-detection cannot read a photo. */
export interface ManualGrid {
  readonly rows: number;
  readonly columns: number;
}

export interface CardScanApi {
  readonly phase: ScanPhase;
  readonly progress: ScanProgress | null;
  readonly error: string | null;
  readonly scanned: readonly ScannedCard[];
  /** How many detected piles the scanner could not name. */
  readonly unrecognized: number;
  /** Copies the scan would import — the number to check against sixty. */
  readonly copies: number;
  /** Every known card name, for the review grid's correction dropdown. */
  readonly nameIndex: NameIndex | null;
  /** Scan a photo, optionally forcing a manual rows × columns layout. */
  scan: (file: File, manual?: ManualGrid) => Promise<void>;
  /** Change (or clear) the card chosen for one detected slot. */
  chooseName: (index: number, name: string | null) => void;
  /** Change how many copies a pile holds. */
  chooseQuantity: (index: number, qty: number) => void;
  /** The reviewed scan as decklist text, ready for the deck importer. */
  decklistText: () => string;
  reset: () => void;
}

/**
 * Work out what the photo shows.
 *
 * The grid reader runs first because it is the stricter of the two — it only
 * succeeds when every band is a whole number of cards on BOTH axes, which also
 * lets it split cards laid side by side with no gap. Piles never tile that way
 * (a pile is taller than a card by whatever the fan adds), so a photo that
 * satisfies the grid reader really is a grid, and everything else goes to the
 * pile reader.
 */
function readLayout(image: PixelImage): readonly CardStack[] {
  const grid = detectCards(image);
  if (grid.cells.length > 0) return stacksFromGrid(grid).stacks;
  return detectStacks(image).stacks;
}

/** A user-supplied rows × columns, shaped like a detection so it reads the same way. */
function gridCellsAsDetection(
  width: number,
  height: number,
  rows: number,
  columns: number,
): DetectionResult {
  return { cells: gridCells(width, height, rows, columns), rows, columns };
}

/** Browser `fetch` shaped for the catalog loader. */
const browserGetFetch = (url: string, init: { headers: Record<string, string> }) =>
  fetch(url, { headers: init.headers });

export function useCardScan(): CardScanApi {
  const [phase, setPhase] = useState<ScanPhase>('idle');
  const [progress, setProgress] = useState<ScanProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [scanned, setScanned] = useState<readonly ScannedCard[]>([]);
  const [nameIndex, setNameIndex] = useState<NameIndex | null>(null);

  // Guards a slow scan from overwriting a newer one's results.
  const runId = useRef(0);

  const reset = useCallback(() => {
    runId.current += 1;
    setPhase('idle');
    setProgress(null);
    setError(null);
    setScanned([]);
  }, []);

  const scan = useCallback(
    async (file: File, manual?: ManualGrid): Promise<void> => {
      const run = ++runId.current;
      setError(null);
      setScanned([]);
      setProgress(null);
      setPhase('preparing');

      let engine: Awaited<ReturnType<typeof createOcrEngine>> | null = null;
      try {
        const image: PixelImage = await decodeImageFile(file);

        // Auto-detect unless the user has told us the layout; a manual grid is
        // always one card per slot, so it is piles of one.
        const stacks: readonly CardStack[] = manual
          ? stacksFromGrid(
              gridCellsAsDetection(image.width, image.height, manual.rows, manual.columns),
            ).stacks
          : readLayout(image);

        if (stacks.length === 0) {
          setError(
            'Could not pick out the cards in that photo. Lay the cards (or piles of the same card, fanned so every name shows) in rows on a plain surface — or enter the rows and columns below and scan again.',
          );
          setPhase('error');
          return;
        }

        const names = await loadCardNames(browserGetFetch);
        if (run !== runId.current) return;
        const index = buildNameIndex([...names]);
        setNameIndex(index);

        setPhase('scanning');
        setProgress({ done: 0, total: stacks.length });
        engine = await createOcrEngine();
        if (run !== runId.current) return;

        const results = await scanCards(image, stacks, engine, index, {
          onProgress: (value) => {
            if (run === runId.current) setProgress(value);
          },
          makeThumbnail: toDataUrl,
        });
        if (run !== runId.current) return;

        setScanned(results);
        setPhase('review');
      } catch (cause) {
        if (run !== runId.current) return;
        setError(
          cause instanceof Error
            ? `Scanning failed: ${cause.message}`
            : 'Scanning failed for an unknown reason.',
        );
        setPhase('error');
      } finally {
        // The OCR worker holds a WASM instance — always let it go.
        await engine?.terminate().catch(() => {});
      }
    },
    [],
  );

  const chooseName = useCallback((index: number, name: string | null) => {
    setScanned((current) => chooseNameIn(current, index, name));
  }, []);

  const chooseQuantity = useCallback((index: number, qty: number) => {
    setScanned((current) => chooseQuantityIn(current, index, qty));
  }, []);

  const decklistText = useCallback(() => toDecklistText(scanned), [scanned]);

  return {
    phase,
    progress,
    error,
    scanned,
    unrecognized: unrecognizedCount(scanned),
    copies: totalCopies(scanned),
    nameIndex,
    scan,
    chooseName,
    chooseQuantity,
    decklistText,
    reset,
  };
}

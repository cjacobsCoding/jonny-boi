/**
 * EITHER SEAT'S GRAVEYARD OPENS (bug report 20260907_190210 — "Theres no way to
 * look at other players graveyards - thats bad").
 *
 * Reproduced on the live build of 2026-09-19: the viewer's seat rail rendered
 * "Graveyard" as a button, the opponent's as a number. A graveyard is a public
 * zone (CR 404.2), and the exile chip already opened for either seat (UX-10),
 * so the graveyard now takes the same shape: `BoardScene` hands BOTH seat panels
 * an `onGraveyardClick`, and both boards keep "which seat is open" rather than a
 * boolean. Pinned structurally, the way GAP-20 pinned the exile: a door that
 * reaches one seat and not the other is the drift this file exists to catch.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const read = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

describe("the opponent's graveyard is openable (20260907_190210)", () => {
  it('BoardScene hands onGraveyardClick to BOTH seat panels, keyed by seat', () => {
    const scene = read('./BoardScene.tsx');
    expect(scene).toContain('onGraveyardClick={() => onGraveyardClick(view.opponent.id)}');
    expect(scene).toContain('onGraveyardClick={() => onGraveyardClick(view.self.id)}');
    expect(scene).toMatch(/readonly onGraveyardClick: \(seat: PlayerId\) => void/u);
  });

  it('both boards track WHICH seat is open, and open the opponent\'s as a reading surface', () => {
    for (const rel of ['./PlayBoard.tsx', '../online/OnlineBoard.tsx']) {
      const board = read(rel);
      expect(board, rel).toContain('useState<PlayerId | null>(null)');
      expect(board, rel).toContain('graveyardOpen === view.self.id ? view.self : view.opponent');
      // The panel's owner name is the OPEN seat's, never hard-wired to the viewer.
      expect(board, rel).toContain('ownerName={graveyardSeat.name}');
      // Nothing is castable from the opponent's graveyard.
      expect(board, rel).toMatch(/graveyardSeat\.id === (viewer|masked\.viewer)\s*\n?\s*\? new Set\(/u);
    }
  });
});

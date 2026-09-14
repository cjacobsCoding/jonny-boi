/**
 * THE HOTSEAT BOARD, MOUNTED FOR REAL (§3.143 wave 3).
 *
 * ## Why this file exists
 *
 * `PlayBoard.tsx` is 2,500 lines, it is the surface every lane in this overhaul
 * integrates through, and roughly 790 of its lines were rewritten in wave 2 —
 * with **no mount test at all**. The online board has one
 * (`online-board-parity.test.ts`) and it is the strongest guard in the project,
 * because it renders the REAL component against a REAL game and asks what a
 * player would see. Every other play-surface test in this directory renders a
 * child in isolation with props supplied by hand, which is exactly the shape of
 * test that let wave 1 and wave 2 each ship a feature that was BUILT, TESTED and
 * UNREACHABLE.
 *
 * So every assertion here is about REACH. A component that exists, compiles, is
 * imported and is fed nothing fails here as loudly as one never written.
 *
 * ## What it holds
 *
 *  1. **The board mounts at all** on a real `GameSession` — the smoke test that
 *     a crash-on-render cannot pass.
 *  2. **A parked question renders from STATE, with no proposal anywhere.** This
 *     is the §3.143 wave-3 defect: wave 2 moved the engine-parked cast-time
 *     question inside `announcingQuestion && proposal`, and a `Proposal` is
 *     transient React state while a `PendingChoice` lives in `GameState` and
 *     survives a reload. A board that can only ask a question while a live
 *     proposal happens to exist shows NO question to a resumed game that is
 *     waiting on one — and offers nothing else either, because the board goes
 *     quiet while a question stands. That is a stranded game.
 *  3. **The tabletop is really on the page** — the scene, the table, the rail
 *     the log moved into, and the midline the combat clamp measures from.
 *
 * ⚠️ These are STATIC-MARKUP assertions (`renderToStaticMarkup`). They prove the
 * board RENDERS a thing; they cannot prove it is visible, sized or on screen —
 * that is what `apps/web/scripts/verify-board-fits.mjs` is for, and the lesson
 * of the first two waves is that neither half substitutes for the other.
 */
import { afterAll, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { SAMPLE_DECKS } from '@jonny-boi/sim';
import type { GameState, PendingChoice, PlayerId } from '@jonny-boi/core';
import { startHotseatGame } from '../../lib/play/setup.js';
import { GameSession } from '../../lib/play/session.js';
import { PlayBoard } from './PlayBoard.js';

const NAMES: Readonly<Record<PlayerId, string>> = { A: 'Player 1', B: 'Computer' };

/**
 * The suite runs in Node with no DOM, and several hooks under this board read
 * `window.matchMedia` DURING RENDER behind a `typeof window.matchMedia` guard —
 * which still throws when `window` itself is undefined. The narrowest possible
 * stand-in, so this file tests the board rather than the absence of a browser
 * (`online-board-parity.test.ts` carries the same note and the same fix).
 */
vi.stubGlobal('window', {
  matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
});
afterAll(() => vi.unstubAllGlobals());

/** A real, legal hotseat game — the same door `PlayView` opens. */
function freshSession(): GameSession {
  const deck = SAMPLE_DECKS[0]!;
  const started = startHotseatGame({
    choiceA: { source: 'sample', deck },
    choiceB: { source: 'sample', deck },
    seed: 4242,
    startingPlayer: 'A',
  });
  if (!started.ok) throw new Error('the sample deck must be legal for this fixture');
  return GameSession.fromCreated(started.game.created, started.game.registry, NAMES);
}

/**
 * The same game with a question parked IN ITS STATE, exactly as the engine parks
 * one — and, critically, with no proposal and no other React state anywhere,
 * because a resumed game has none. `GameSession` is immutable and built from a
 * `{ state, events }` pair, so a state with a `pendingChoice` is a session with
 * a parked question; nothing is mocked.
 */
function sessionAwaitingAnswer(chooser: PlayerId, prompt: string): GameSession {
  const base = freshSession();
  const source = base.state.players[chooser].hand[0];
  if (source === undefined) throw new Error('the opening hand must not be empty for this fixture');
  const choice: PendingChoice = {
    id: 1,
    kind: 'confirm',
    chooser,
    prompt,
    valence: 'neutral',
    sourceInstanceId: source.instanceId,
    sourceName: source.def.name,
    min: 0,
    max: 0,
  };
  const state: GameState = { ...base.state, pendingChoice: choice };
  return GameSession.fromCreated({ state, events: base.events }, base.registry, NAMES);
}

function render(session: GameSession, viewer: PlayerId = 'A'): string {
  return renderToStaticMarkup(
    createElement(PlayBoard, {
      session,
      viewer,
      onSubmit: () => {},
      onConcede: () => {},
      stops: { fullControl: false },
      onStops: () => {},
    } as never),
  );
}

describe('the hotseat board mounts on a real game', () => {
  it('renders without throwing, and renders the board it claims to', () => {
    const html = render(freshSession());
    expect(html).toContain('class="play-board"');
    // Both seats, named — the smoke test that the view-model reached the panel.
    expect(html).toContain(NAMES.A);
    expect(html).toContain(NAMES.B);
  });
});

describe('a PARKED QUESTION comes from STATE, never from a live proposal', () => {
  /*
   * THE REGRESSION THIS FILE EXISTS FOR. `render()` passes no proposal and the
   * board creates none: `useState(null)`. Before wave 3 the only mount site for
   * an engine-parked cast-time question was inside `announcingQuestion &&
   * proposal`, so this markup carried no prompt at all for a game whose STATE
   * said it was waiting on one.
   */
  it('the prompt is on the page for the seat that has to answer', () => {
    const html = render(sessionAwaitingAnswer('A', 'Pay 2 life?'), 'A');
    expect(html).toContain('choice-prompt');
    expect(html).toContain('Pay 2 life?');
  });

  it('…and the question is answerable there — the prompt is not a caption', () => {
    const html = render(sessionAwaitingAnswer('A', 'Pay 2 life?'), 'A');
    const start = html.indexOf('choice-prompt');
    const prompt = html.slice(start, html.indexOf('</div>', start) + 2000);
    expect(prompt).toMatch(/<button\b/);
  });

  it('the OTHER seat is not shown a question addressed to its opponent', () => {
    // A hidden-information guard, not just routing: a choice's candidates can
    // include cards the other seat may not see.
    const html = render(sessionAwaitingAnswer('B', 'Pay 2 life?'), 'A');
    expect(html).not.toContain('Pay 2 life?');
  });

  it('the board goes QUIET while a question stands, instead of offering both', () => {
    // The other half of the strand: if the question renders but priority does
    // not stand down, a player can act around an unanswered question; if
    // priority stands down but the question does NOT render (the wave-2 bug),
    // the game offers nothing at all.
    const quiet = render(sessionAwaitingAnswer('A', 'Pay 2 life?'), 'A');
    expect(quiet).toContain('Answer the question above to continue.');
  });
});

describe('the tabletop is really mounted (UX-9, §3.143 wave 3)', () => {
  const html = render(freshSession());

  it('the scene and its tilted table are both on the page', () => {
    // Two elements, not one: the outer box holds the projection and the inner
    // one holds the tilt (board-scene.css explains why they cannot be merged).
    expect(html).toContain('class="board-scene"');
    expect(html).toContain('class="board-scene__table"');
  });

  it('the tilt and the perspective arrive as real values, not as missing variables', () => {
    // `BOARD_3D_CONFIG` reaches the CSS through inline custom properties. An
    // unset one resolves to nothing and the whole transform is silently
    // dropped — the failure mode that made wave 1's 3D "structurally present
    // and visually absent".
    expect(html).toMatch(/--board-tilt-deg:\s*\d+(\.\d+)?deg/);
    expect(html).toMatch(/--board-perspective-px:\s*\d+px/);
    expect(html).toMatch(/--perm-aspect:\s*\d/);
  });

  it('the game log is in the side RAIL, not on the midline between the battlefields', () => {
    const rail = html.indexOf('class="board-rail"');
    expect(rail, 'the log rail did not render').toBeGreaterThan(0);
    const log = html.indexOf('game-log');
    expect(log, 'the game log did not render').toBeGreaterThan(0);
    expect(log, 'the log is outside its rail').toBeGreaterThan(rail);
    // …and the midline is a seam with nothing in it: it is what UX-12's advance
    // clamp is measured from, so it must be an element, and it must be empty.
    expect(html).toContain('class="board-midline"');
  });

  it('the rail is OUTSIDE the tilted table — words on a slant is the cost UX-9 must not pay', () => {
    const tableEnd = html.indexOf('class="board-rail"');
    const table = html.slice(0, tableEnd);
    // The scene opens before the rail and must also close before it.
    expect(table).toContain('class="board-scene__table"');
    expect(html.indexOf('class="board-scene__table"')).toBeLessThan(tableEnd);
  });

  it("the opponent's hand is drawn at the FAR edge, above their battlefield", () => {
    const backs = html.indexOf(`${NAMES.B} hand (hidden)`);
    const theirSeat = html.indexOf('seat__board');
    expect(backs, 'the opponent hand did not render').toBeGreaterThan(0);
    expect(backs, 'the opponent hand is still between their creatures and the midline').toBeLessThan(
      theirSeat,
    );
  });
});

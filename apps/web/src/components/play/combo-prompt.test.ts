/**
 * THE INFINITE-COMBO PROMPT — drawn, and REACHED (DESIGN §3.177).
 *
 * Two halves, for the reason `play-board-mount.test.ts` gives: a component that
 * renders beautifully in isolation and is never mounted is the dominant failure
 * of agent work on this board. So:
 *
 *  1. the prompt alone, from a hand-built view — the cards, the change, the
 *     count, the cap, the three answers (one of them honestly disabled);
 *  2. the REAL `PlayBoard` on a REAL session whose STATE carries a combo window
 *     — the prompt is on the page for the owner, the loop's pieces are lit on
 *     the board, the other seat is told to wait, and the board goes quiet.
 *
 * Static markup only (`renderToStaticMarkup`): proves the board renders the
 * thing, not that it is visible or sized — the integrator's preview is for that.
 */
import { afterAll, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { SAMPLE_DECKS } from '@jonny-boi/sim';
import {
  COMBO_REPEAT_CAP,
  COMBO_REPEAT_DEFAULT,
  type ComboWindow,
  type GameState,
  type PlayerId,
} from '@jonny-boi/core';
import { startHotseatGame } from '../../lib/play/setup.js';
import { GameSession } from '../../lib/play/session.js';
import { playRulesFor } from '../../lib/play/combo-rules.js';
import type { ComboPromptView } from '../../lib/play/combo-view.js';
import { PlayBoard } from './PlayBoard.js';
import { ComboPrompt, COMBO_PROMPT_TITLE, FOREVER_COMING_NEXT } from './ComboPrompt.js';

vi.stubGlobal('window', {
  matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
});
afterAll(() => vi.unstubAllGlobals());

const NAMES: Readonly<Record<PlayerId, string>> = { A: 'Player 1', B: 'Computer' };

describe('ComboPrompt, from a hand-built view', () => {
  const view: ComboPromptView = {
    owner: 'A',
    cards: [
      { instanceId: 11, name: 'Heliod, Sun-Crowned' },
      { instanceId: 12, name: 'Walking Ballista' },
    ],
    cycleLength: 9,
    changes: ['+1 life', '+1 +1/+1 counter on Walking Ballista'],
    summary: '+1 life, +1 +1/+1 counter on Walking Ballista per cycle',
    defaultTimes: COMBO_REPEAT_DEFAULT,
    cap: COMBO_REPEAT_CAP,
  };
  const html = renderToStaticMarkup(
    createElement(ComboPrompt, { view, onRepeat: () => {}, onDismiss: () => {} }),
  );

  it('names the pieces of the loop and what one cycle changes', () => {
    expect(html).toContain(COMBO_PROMPT_TITLE);
    expect(html).toContain('Heliod, Sun-Crowned');
    expect(html).toContain('Walking Ballista');
    expect(html).toContain('+1 life');
    expect(html).toContain('+1 +1/+1 counter on Walking Ballista');
    expect(html).toContain('9 actions each time round');
  });

  it('starts the count at the default and says the cap out loud', () => {
    expect(html).toMatch(new RegExp(`<input[^>]*value="${COMBO_REPEAT_DEFAULT}"`));
    expect(html).toMatch(new RegExp(`max="${COMBO_REPEAT_CAP}"`));
    expect(html).toContain(`up to ${COMBO_REPEAT_CAP.toLocaleString()}`);
  });

  it('offers Repeat N, a disabled "forever" that says it is coming, and Not now', () => {
    expect(html).toContain(`Repeat ${COMBO_REPEAT_DEFAULT.toLocaleString()} times`);
    expect(html).toMatch(/<button[^>]*combo-prompt__forever[^>]*disabled/);
    expect(html).toContain(FOREVER_COMING_NEXT);
    expect(html).toContain('Not now');
  });

  it('a placeholder, never a blank, for a piece with no face to draw', () => {
    // No `faces` were supplied, so every piece is its name in the card's footprint.
    expect(html).toContain('ability-face--nameonly');
    expect(html).not.toContain('<img');
  });
});

// --- reached from the real board ---------------------------------------------------

/** A real, legal hotseat game under the Play rules (both seats human). */
function freshSession(): GameSession {
  const deck = SAMPLE_DECKS[0]!;
  const started = startHotseatGame({
    choiceA: { source: 'sample', deck },
    choiceB: { source: 'sample', deck },
    seed: 4242,
    startingPlayer: 'A',
  });
  if (!started.ok) throw new Error('the sample deck must be legal for this fixture');
  return GameSession.fromCreated(started.game.created, started.game.registry, NAMES, playRulesFor(undefined));
}

/**
 * The same game with a combo window IN ITS STATE, exactly as the engine leaves
 * one: a card of A's moved onto the battlefield so the loop has a piece to
 * light up, and the window naming a cycle through it. No proposal, no other
 * React state — a resumed game has none.
 */
function sessionWithWindow(owner: PlayerId): { session: GameSession; pieceName: string } {
  const base = freshSession();
  const state = structuredClone(base.state) as GameState;
  const player = state.players[owner];
  const piece = player.hand.shift();
  if (!piece) throw new Error('the opening hand must not be empty for this fixture');
  piece.zone = 'battlefield';
  piece.summoningSick = false;
  state.battlefield.push(piece);
  const cycle = [
    { kind: 'activateAbility' as const, player: owner, instanceId: piece.instanceId, abilityIndex: 0 },
    { kind: 'passPriority' as const, player: owner },
    { kind: 'passPriority' as const, player: owner === 'A' ? ('B' as const) : ('A' as const) },
  ];
  const window: ComboWindow = {
    owner,
    loop: {
      player: owner,
      key: 'test-loop',
      cycle,
      deltas: [{ key: `life|${owner}|`, kind: 'life', player: owner, delta: 2, label: '+2 life' }],
    },
    resume: { priorityPlayer: owner, consecutivePasses: 0 },
  };
  state.comboWindow = window;
  state.priorityPlayer = owner;
  return {
    session: GameSession.fromCreated({ state, events: base.events }, base.registry, NAMES, playRulesFor(undefined)),
    pieceName: piece.def.name,
  };
}

function render(session: GameSession, viewer: PlayerId): string {
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

describe('the prompt is REACHED from the real hotseat board, off the state alone', () => {
  it('is on the page for the owner, naming the loop and its change', () => {
    const { session, pieceName } = sessionWithWindow('A');
    const html = render(session, 'A');
    expect(html).toContain('combo-prompt');
    expect(html).toContain(COMBO_PROMPT_TITLE);
    expect(html).toContain('+2 life');
    expect(html).toContain(pieceName);
    expect(html).toContain('Not now');
  });

  it('lights the loop\'s pieces on the board through the selection seam', () => {
    const { session } = sessionWithWindow('A');
    const html = render(session, 'A');
    expect(html).toContain('∞ loop');
    expect(html).toContain('perm--targetable');
  });

  it('the OTHER seat is told to wait and is shown no prompt', () => {
    const { session } = sessionWithWindow('A');
    const html = render(session, 'B');
    expect(html).not.toContain('combo-prompt');
    expect(html).toContain('Player 1 has found a loop');
  });

  it('the owner\'s board goes quiet: the prompt is the only thing on offer', () => {
    const { session } = sessionWithWindow('A');
    expect(session.legalActions().map((a) => a.kind)).toEqual(['dismissCombo', 'repeatCombo']);
    expect(session.hasMeaningfulChoice()).toBe(true);
    const html = render(session, 'A');
    expect(html).toContain('Answer the loop prompt above to continue.');
  });
});

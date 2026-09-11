/**
 * THE ONLINE BOARD GETS WHAT THE HOTSEAT BOARD GETS (§3.143 wave 2, GAP-20).
 *
 * ## Why this file exists at all
 *
 * Wave 1 shipped UX-1 (a stack of real card faces), UX-2 (the stack always
 * visible) and UX-10 (one hover funnel) with a full green suite — and none of
 * them reached the online board, because the online board was nobody's lane.
 * `StackPanel`, `CardHover` and `CardFace` were all *reused* here already; what
 * was missing was the four props that make them show anything, and no test
 * could see that, because every wave-1 test rendered the component in isolation
 * with good props supplied by hand.
 *
 * **So every assertion below is about REACH, not about shape.** It mounts the
 * REAL `OnlineBoard` on a REAL masked view — the same `maskStateForSeat` the
 * server calls — and asks what a player would actually see. A component that
 * exists, compiles and is imported but is fed `nameOf={() => 'card'}` fails
 * here exactly as loudly as one that was never written.
 *
 * ## The anti-cheat line this file also holds
 *
 * The fixtures are built by masking a real `GameState` for seat A, so the board
 * is handed precisely what the wire carries. The last test asserts that no
 * opponent hand card's NAME appears anywhere in the rendered markup: a prettier
 * stack must never be paid for with hidden information, and "the UI needed a
 * face" is the exact excuse under which that leak would arrive.
 */
import { afterAll, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { maskStateForSeat, type MaskedGameView } from '@jonny-boi/protocol';
import { SAMPLE_DECKS } from '@jonny-boi/sim';
import type { CardInstance, PlayerId } from '@jonny-boi/core';
import { startHotseatGame } from '../../lib/play/setup.js';
import { cardImage, getCard } from '../../lib/cards.js';
import type { GameFrame } from '../../lib/online/online-state.js';
import { OnlineBoard } from './OnlineBoard.js';

const NAMES: Readonly<Record<PlayerId, string>> = { A: 'Alice', B: 'Bob' };

/**
 * The suite runs in Node (the root vitest config installs no DOM), and
 * `usePrefersReducedMotion` (`components/play/AnimationLayer.tsx`, consumed by
 * `CombatLines`) reads `window.matchMedia` DURING RENDER behind a
 * `typeof window.matchMedia` guard — which still throws when `window` itself is
 * undefined. The narrowest possible stand-in, so that this file tests the board
 * rather than the absence of a browser. The real fix is one `typeof window !==
 * 'undefined' &&` in that hook, and it is filed as a contract for its owning
 * lane rather than reached across a lane boundary here.
 */
vi.stubGlobal('window', { matchMedia: () => ({ matches: false }) });
afterAll(() => vi.unstubAllGlobals());

/** A real, legal game, masked for seat A exactly as the server would mask it. */
function maskedForA(): MaskedGameView {
  const deck = SAMPLE_DECKS.find((d) => d.name.toLowerCase().includes('red')) ?? SAMPLE_DECKS[0]!;
  const started = startHotseatGame({
    choiceA: { source: 'sample', deck },
    choiceB: { source: 'sample', deck },
    seed: 12345,
    startingPlayer: 'A',
  });
  if (!started.ok) throw new Error('the sample decks must be legal for this fixture');
  return maskStateForSeat(started.game.created.state, 'A');
}

/**
 * Two of the viewer's own cards that the app can actually draw.
 *
 * Derived from the pool rather than named here: a hard-coded card name is a
 * fixture that rots the day the sample deck changes, and this test's claim
 * ("a stack object shows a real face") needs any drawable card, not a
 * particular one.
 */
function twoDrawableCards(masked: MaskedGameView): readonly [CardInstance, CardInstance] {
  const drawable = (masked.players.A.hand ?? []).filter((c) => {
    const record = getCard(c.def.id);
    return record !== undefined && cardImage(record, 'large') !== undefined;
  });
  const [first, second] = drawable;
  if (first === undefined || second === undefined) {
    throw new Error('the opening hand must contain two cards with Scryfall art for this fixture');
  }
  return [first, second];
}

/**
 * A frame whose stack holds one spell aimed at one battlefield permanent.
 *
 * `controller` is a parameter because "whose spell is this?" is the first fact
 * a player needs when something they did not cast appears (UX-16 leans on the
 * same panel), and the board can only mark it if it is told who is looking.
 */
function frameWithStackedSpell(controller: PlayerId): {
  readonly frame: GameFrame;
  readonly spell: CardInstance;
  readonly target: CardInstance;
} {
  const masked = maskedForA();
  const [spell, target] = twoDrawableCards(masked);
  const view: MaskedGameView = {
    ...masked,
    battlefield: [target],
    stack: [
      {
        kind: 'spell',
        instanceId: spell.instanceId,
        card: spell,
        controller,
        resolvesTo: 'graveyard',
        targets: [target.instanceId],
      },
    ],
  };
  return {
    frame: { view, legalActions: [], yourTurn: false, log: [] },
    spell,
    target,
  };
}

function render(frame: GameFrame): string {
  return renderToStaticMarkup(
    createElement(OnlineBoard, { frame, names: NAMES, onAction: () => {}, onConcede: () => {} }),
  );
}

/** Just the stack panel's markup — so "there is an image" cannot be satisfied by the hand. */
function stackMarkup(html: string): string {
  const start = html.indexOf('<aside class="stack-panel');
  expect(start, 'the stack panel did not render at all').toBeGreaterThanOrEqual(0);
  const end = html.indexOf('</aside>', start);
  return html.slice(start, end);
}

describe('UX-1 — the ONLINE stack shows real cards, not the word "card"', () => {
  it('every stack row draws a real Scryfall face', () => {
    const { frame, spell } = frameWithStackedSpell('A');
    const stack = stackMarkup(render(frame));
    // THE regression. Before wave 2 this board passed no `faceOf` and the rows
    // fell through to the named placeholder plate, so this count was 0.
    const images = stack.match(/<img\b[^>]*>/g) ?? [];
    expect(images.length, 'the stack row rendered no card image').toBeGreaterThan(0);
    const record = getCard(spell.def.id)!;
    expect(stack).toContain(cardImage(record, 'large')!);
    expect(stack).toContain(spell.def.name);
  });

  it('a targeted row names the real target — not the "card" placeholder', () => {
    const { frame, target } = frameWithStackedSpell('A');
    const stack = stackMarkup(render(frame));
    expect(stack).toContain(target.def.name);
    // `nameOf={() => 'card'}` rendered this exact text node on every target row.
    expect(stack).not.toMatch(/>\s*card\s*</);
  });

  it("an opponent's spell is MARKED as theirs — the board says who is looking", () => {
    const mine = stackMarkup(render(frameWithStackedSpell('A').frame));
    expect(mine).not.toContain('stack-row--opponents');
    const theirs = stackMarkup(render(frameWithStackedSpell('B').frame));
    // Only possible because the mount site passes `viewer`; without it the panel
    // honestly marks nothing (see `StackRowContext.viewer`).
    expect(theirs).toContain('stack-row--opponents');
  });

  it('UX-2 — the stack floats over the board instead of sharing the log column', () => {
    const stack = stackMarkup(render(frameWithStackedSpell('A').frame));
    expect(stack).toContain('stack-panel--floating');
    expect(stack).not.toContain('stack-panel--column');
  });
});

describe('UX-10 — the online hand goes through the ONE hover funnel', () => {
  it('each hand slot wraps its card in a hover anchor', () => {
    const html = render(frameWithStackedSpell('A').frame);
    // `CardHover` with no className renders a bare <span> around its children;
    // that span between the slot and the card IS the funnel. Matching it
    // positionally is the point — remove the wrapper and this line reddens.
    expect(html).toMatch(/<div class="hand-card-slot[^"]*"[^>]*><span><(?:div|button) class="play-card/);
  });

  it('the hand card itself draws a real face (the shared renderer reached it)', () => {
    const { frame } = frameWithStackedSpell('A');
    const html = render(frame);
    const hand = html.slice(html.indexOf('hand-card-slot'));
    expect(hand).toMatch(/<img\b[^>]*src="https:\/\//);
  });
});

describe('the parity work never widened what a viewer may see', () => {
  it("no opponent hand card's name appears anywhere in the rendered board", () => {
    const masked = maskedForA();
    const started = startHotseatGame({
      choiceA: { source: 'sample', deck: SAMPLE_DECKS[0]! },
      choiceB: { source: 'sample', deck: SAMPLE_DECKS[0]! },
      seed: 12345,
      startingPlayer: 'A',
    });
    if (!started.ok) throw new Error('fixture');
    // The UNMASKED state is the only place seat B's hand exists; the board is
    // handed the MASKED one, and must render nothing that only the unmasked
    // view knows. (Both decks are the same list, so a name shared with the
    // viewer's own visible cards is excluded — this asks about identities the
    // viewer could ONLY have learned from B's hand.)
    const hidden = started.game.created.state.players.B.hand;
    const visible = new Set<string>([
      ...(masked.players.A.hand ?? []).map((c) => c.def.name),
      ...masked.battlefield.map((c) => c.def.name),
      ...masked.players.A.graveyard.map((c) => c.def.name),
      ...masked.players.B.graveyard.map((c) => c.def.name),
    ]);
    const html = render({ view: masked, legalActions: [], yourTurn: false, log: [] });
    for (const card of hidden) {
      if (visible.has(card.def.name)) continue;
      expect(html, `${card.def.name} is in B's hand and must not be on A's screen`).not.toContain(
        card.def.name,
      );
    }
  });
});

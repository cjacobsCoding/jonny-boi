/**
 * THE EXILE VIEWER, AND THE ONE THING IT MUST NEVER SHOW (§3.143 / UX-10).
 *
 * ## What was missing
 * Exile was the last zone on either board that a player could only ever read as
 * a NUMBER. The hover funnel was already one funnel and already adopted
 * everywhere there was something to hover; what was absent was the zone. This
 * file is about the zone reaching a screen, and about the half of it that must
 * not.
 *
 * ## Why the leak assertion is the important one
 * The graveyard is a fully public zone (CR 404.2) and listing it reveals
 * nothing. **Exile is not.** A card with foretell is exiled FACE DOWN and only
 * its owner may look at it (CR 702.143a, `CardInstance.faceDown`) — so an exile
 * viewer built by copy-pasting the graveyard panel would publish the opponent's
 * hidden card the first time one existed.
 *
 * The guarantee is therefore made at the VIEW MODEL, not in the component: a
 * face-down card of the seat the viewer is not never enters `SeatView.exile`,
 * and only its COUNT travels. A component that receives the name and chooses not
 * to render it is a convention; a component that was never handed the name is a
 * guarantee. These tests are written against the real masked view for exactly
 * that reason — the discipline of `online-board-parity.test.ts`, whose last test
 * asks the same question of the opponent's hand.
 */
import { afterAll, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { maskStateForSeat } from '@jonny-boi/protocol';
import { SAMPLE_DECKS } from '@jonny-boi/sim';
import type { CardInstance, GameState, PlayerId } from '@jonny-boi/core';
import { cardImage, getCard } from '../../lib/cards.js';
import { startHotseatGame } from '../../lib/play/setup.js';
import { GameSession } from '../../lib/play/session.js';
import { buildBoardView } from '../../lib/play/view-model.js';
import { maskedViewToBoardView } from '../../lib/online/board-adapter.js';
import { seatAnchor } from '../../lib/play/animations.js';
import {
  UNEXPECTED_HIDDEN_LABEL,
  ZONE_PANELS,
  zonePanelView,
  type ZoneDisabledContext,
} from '../../lib/play/zone-panel.js';
import { ZonePanel } from './ZonePanel.js';
import { PlayBoard } from './PlayBoard.js';
import { OnlineBoard } from '../online/OnlineBoard.js';

const NAMES: Readonly<Record<PlayerId, string>> = { A: 'Alice', B: 'Bob' };

/**
 * Both boards read `window.matchMedia` DURING RENDER behind a
 * `typeof window.matchMedia` guard, which still throws when `window` itself is
 * undefined (the suite runs in Node with no DOM). Same stand-in, same reason, as
 * `play-board-mount.test.ts` and `online-board-parity.test.ts`.
 */
vi.stubGlobal('window', {
  matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  setTimeout: () => 0,
  clearTimeout: () => {},
});
afterAll(() => vi.unstubAllGlobals());

/** The art a card id resolves to, or undefined when the app cannot draw it. */
function artOf(cardId: string): string | undefined {
  const record = getCard(cardId);
  return record === undefined ? undefined : cardImage(record, 'art_crop');
}

/** The two cards this fixture puts in Bob's exile: one face down, one face up. */
interface ExileFixture {
  readonly state: GameState;
  /** Foretold — exiled FACE DOWN. Alice may not learn a thing about it. */
  readonly hidden: CardInstance;
  /** Exiled face up. Alice may read it, and the panel must actually show it. */
  readonly open: CardInstance;
}

/**
 * A real, legal game with two cards moved into seat B's exile — one of them
 * `faceDown`, exactly as `castSpell … method: 'foretell'` leaves it
 * (`engine.ts`, `card.faceDown = true`).
 *
 * The two cards are chosen to have DIFFERENT ids and names, so "the hidden one's
 * name is absent" cannot be satisfied by the visible one's markup.
 */
function exileFixture(): ExileFixture {
  const deck = SAMPLE_DECKS[0]!;
  const started = startHotseatGame({
    choiceA: { source: 'sample', deck },
    choiceB: { source: 'sample', deck },
    seed: 4242,
    startingPlayer: 'A',
  });
  if (!started.ok) throw new Error('the sample deck must be legal for this fixture');
  const base = started.game.created.state;
  // Both cards must be DRAWABLE (real Scryfall art), or "the hidden card's art
  // URL is absent" would be satisfied by a card that has no art to leak. Same
  // discipline as `online-board-parity.test.ts`'s `twoDrawableCards`.
  const library = base.players.B.library.filter((c) => artOf(c.def.id) !== undefined);
  const first = library[0];
  const second = library.find((c) => first !== undefined && c.def.id !== first.def.id);
  if (first === undefined || second === undefined) {
    throw new Error('the library must hold two differently-named cards with art for this fixture');
  }
  const hidden: CardInstance = { ...first, faceDown: true };
  const open: CardInstance = { ...second };
  const state: GameState = {
    ...base,
    players: {
      ...base.players,
      B: {
        ...base.players.B,
        library: library.filter((c) => c !== first && c !== second),
        exile: [...base.players.B.exile, hidden, open],
      },
    },
  };
  return { state, hidden, open };
}

function session(state: GameState): GameSession {
  const deck = SAMPLE_DECKS[0]!;
  const started = startHotseatGame({
    choiceA: { source: 'sample', deck },
    choiceB: { source: 'sample', deck },
    seed: 4242,
    startingPlayer: 'A',
  });
  if (!started.ok) throw new Error('fixture');
  return GameSession.fromCreated({ state, events: started.game.created.events }, started.game.registry, NAMES);
}

/** The viewer looking at their OWN zone, holding priority, in a main phase. */
const CTX: ZoneDisabledContext = { yours: true, yourTurn: true, waitingOn: 'Bob', step: 'precombatMain' };

/** The same moment, looking at the OPPONENT'S zone. */
const FOREIGN: ZoneDisabledContext = { ...CTX, yours: false };

/* -------------------------------------------------------------------------- */
/* 1. THE MASK — at the view model, for both boards                            */
/* -------------------------------------------------------------------------- */

describe("a face-down exiled card never enters the opponent's view model", () => {
  it('the hotseat view model withholds the identity and keeps only the count', () => {
    const { state, hidden, open } = exileFixture();
    const alice = buildBoardView(state, 'A', NAMES).opponent;
    expect(alice.exile.map((c) => c.instanceId)).toEqual([open.instanceId]);
    expect(alice.exile.some((c) => c.name === hidden.def.name)).toBe(false);
    expect(alice.exileHiddenCount).toBe(1);
  });

  it('…but the TOTAL still counts it — its existence is public, only its face is not', () => {
    // The table watched the card be exiled face down. A count that left it out
    // would under-report a public fact, which is a different lie from leaking it.
    const { state } = exileFixture();
    expect(buildBoardView(state, 'A', NAMES).opponent.exileCount).toBe(2);
  });

  it('the OWNER sees their own face-down card — it is hidden from opponents, not from them', () => {
    const { state, hidden } = exileFixture();
    const bob = buildBoardView(state, 'B', NAMES).self;
    expect(bob.exile.map((c) => c.instanceId)).toContain(hidden.instanceId);
    expect(bob.exileHiddenCount).toBe(0);
    expect(bob.exileCount).toBe(2);
  });

  it('the ONLINE chokepoint already masked it — and the adapter now carries BOTH halves', () => {
    // `maskStateForSeat` has filtered face-down exile since §3.112; what it did
    // NOT have was a consumer. `faceDownExileCount` was computed and read by
    // nobody, and `board-adapter` counted `exile.length` alone — so online, a
    // foretold card of the opponent's did not exist even as a number.
    const { state, hidden, open } = exileFixture();
    const masked = maskStateForSeat(state, 'A');
    expect(masked.players.B.exile.map((c) => c.instanceId)).toEqual([open.instanceId]);
    expect(masked.players.B.faceDownExileCount).toBe(1);
    const seat = maskedViewToBoardView(masked, NAMES).opponent;
    expect(seat.exile.some((c) => c.name === hidden.def.name)).toBe(false);
    expect(seat.exileHiddenCount).toBe(1);
    expect(seat.exileCount, 'the count must add the withheld half back').toBe(2);
  });
});

/* -------------------------------------------------------------------------- */
/* 2. THE LEAK — real masked view, real panel, real markup                     */
/* -------------------------------------------------------------------------- */

describe("the rendered exile panel carries nothing of a face-down card's identity", () => {
  const { state, hidden, open } = exileFixture();
  const seat = buildBoardView(state, 'A', NAMES).opponent;
  const html = renderToStaticMarkup(
    createElement(ZonePanel, {
      zone: 'exile' as const,
      ownerName: NAMES.B,
      view: zonePanelView(
        'exile',
        {
          cards: seat.exile.map((c) => ({
            instanceId: c.instanceId,
            cardId: c.cardId,
            name: c.name,
            castableEver: null,
          })),
          hiddenCount: seat.exileHiddenCount,
        },
        new Set(),
        // Bob's zone, seen by Alice — the board passes `yours: false` here.
        FOREIGN,
      ),
      onActivate: () => {},
      onClose: () => {},
    }),
  );

  it('the panel is not vacuous — the face-up exiled card really is drawn, art and all', () => {
    // Without this, every assertion below would pass on an empty panel.
    expect(html).toContain(open.def.name);
    expect(html).toContain('zone-panel');
    expect(html).toContain(artOf(open.def.id) as string);
  });

  it("the face-down card's NAME appears nowhere in the markup", () => {
    expect(html, `${hidden.def.name} is face down in Bob's exile and must not be on Alice's screen`).not.toContain(
      hidden.def.name,
    );
  });

  it("…and neither does its ART — a picture of the card IS the card", () => {
    // A `cardId` resolves to a Scryfall image, and an <img> leaks the card just
    // as completely as a name does, more quietly. The fixture guarantees this
    // card HAS art, so the assertion cannot pass by there being nothing to find.
    const art = artOf(hidden.def.id);
    expect(art, 'the fixture must use a card with art or this proves nothing').toBeDefined();
    expect(html).not.toContain(art as string);
    expect(html).not.toContain(hidden.def.id);
  });

  it('it renders as a card BACK, so the player can still see that something is there', () => {
    // The honest rendering: withhold the face, never the fact.
    expect(html).toContain('play-card--back');
    const label = ZONE_PANELS.exile.hiddenLabel;
    expect(label).not.toBeNull();
    expect(html).toContain(label as string);
  });
});

/* -------------------------------------------------------------------------- */
/* 3. REACH — the zone is openable on BOTH boards, for BOTH seats              */
/* -------------------------------------------------------------------------- */

describe('exile is an openable zone wherever the graveyard is', () => {
  it('the hotseat board makes the exile chip a button, for the opponent too', () => {
    const { state } = exileFixture();
    const html = renderToStaticMarkup(
      createElement(PlayBoard, {
        session: session(state),
        viewer: 'A',
        onSubmit: () => {},
        onConcede: () => {},
        stops: { fullControl: false },
        onStops: () => {},
      } as never),
    );
    // A `<span>` chip is what UX-10 found; a button is the affordance.
    expect(html).toContain(`aria-label="Open ${NAMES.B} exile (2 cards)"`);
    expect(html).toContain(`data-anim-anchor="${seatAnchor('exile', 'B')}"`);
  });

  it('the online board does the same — one panel, both surfaces (GAP-20)', () => {
    const { state } = exileFixture();
    const html = renderToStaticMarkup(
      createElement(OnlineBoard, {
        frame: { view: maskStateForSeat(state, 'A'), legalActions: [], yourTurn: false, log: [] },
        names: NAMES,
        onAction: () => {},
        onConcede: () => {},
      }),
    );
    expect(html).toContain(`aria-label="Open ${NAMES.B} exile (2 cards)"`);
    expect(html).toContain(`data-anim-anchor="${seatAnchor('exile', 'B')}"`);
  });

  /**
   * A MOUNT-DERIVATION guard, the only shape that has ever caught this branch's
   * real defects (§7.3): it reads the sources and fails when a board stops
   * mounting the panel, or when the SCENE stops offering one of the two seats an
   * opener. A panel that reaches one board and not the other is exactly GAP-20,
   * and no test that renders a component in isolation can see it.
   *
   * ⚠️ It used to count `onExileClick=` TWICE PER BOARD, because each board wired
   * its two seats itself. Both boards now mount the one `BoardScene`, which wires
   * both seats from a single `onExileClick(seat)` — so counting to two per board
   * would fail on code that is strictly better, and counting to ONE would pass on
   * a scene that had quietly dropped the opponent's. The question has not changed
   * ("can a player open EITHER seat's exile, on EITHER board?"); the place that
   * answers it has, and so this asks it there.
   */
  it('both boards mount the panel, and the scene offers BOTH seats the opener', () => {
    const read = (file: string): string =>
      readFileSync(fileURLToPath(new URL(file, import.meta.url)), 'utf8')
        .replace(/\r\n/g, '\n')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^[ \t]*\/\/.*$/gm, '');

    for (const file of ['./PlayBoard.tsx', '../online/OnlineBoard.tsx']) {
      const source = read(file);
      expect(source, `${file} mounts no exile ZonePanel`).toContain('zone="exile"');
      // The board hands the scene an opener that takes a SEAT. A board that
      // hard-coded its own seat here would leave the opponent's exile a number.
      expect(source, `${file} hands the scene no seat-taking exile opener`).toMatch(
        /onExileClick=\{\(seat\)\s*=>/,
      );
    }

    // …and the scene really does call it for BOTH seats — the far one named
    // first, because that is the one a board wiring only its own would drop.
    const scene = read('./BoardScene.tsx');
    expect(scene, 'the scene never offers the OPPONENT an exile opener').toContain(
      'onExileClick={() => onExileClick(view.opponent.id)}',
    );
    expect(scene, 'the scene never offers the VIEWER an exile opener').toContain(
      'onExileClick={() => onExileClick(view.self.id)}',
    );
  });
});

/* -------------------------------------------------------------------------- */
/* 4. THE ZONE TABLE — closed, and it REPORTS rather than approximating        */
/* -------------------------------------------------------------------------- */

describe('one panel, a row per zone (rule 12)', () => {
  const card = { instanceId: 1 as const, cardId: 'x', name: 'Card X', castableEver: null };

  it('a castable card wears the ZONE’s badge, and the engine is what says it is castable', () => {
    const offered = zonePanelView('exile', { cards: [card], hiddenCount: 0 }, new Set([1]), CTX);
    expect(offered.cards[0]?.actionable).toBe(true);
    expect(offered.cards[0]?.badge).toBe(ZONE_PANELS.exile.castBadge);
    expect(offered.cards[0]?.reason).toBeUndefined();
    // The SAME card with no offer is inspectable and inert — the panel never
    // re-derives legality, so an empty offer set means an empty affordance.
    const inert = zonePanelView('exile', { cards: [card], hiddenCount: 0 }, new Set(), CTX);
    expect(inert.cards[0]?.actionable).toBe(false);
    expect(inert.cards[0]?.badge).toBeUndefined();
  });

  it('exile refuses to claim a card can NEVER be cast — that fact is not on the card', () => {
    // The permission that lets a card be cast from exile (an adventure's
    // creature half, a defeated Siege's reward) lives in game state. A panel
    // that said "this card can never be cast from exile" would be guessing.
    expect(ZONE_PANELS.exile.noCastEverText).toBeNull();
    const view = zonePanelView(
      'exile',
      { cards: [{ ...card, castableEver: false }], hiddenCount: 0 },
      new Set(),
      CTX,
    );
    expect(view.cards[0]?.reason).toBe(ZONE_PANELS.exile.noCastNowText);
    expect(view.cards[0]?.reason).not.toMatch(/flashback/i);
  });

  it('the graveyard still says the permanent truth it CAN say', () => {
    const view = zonePanelView(
      'graveyard',
      { cards: [{ ...card, castableEver: false }], hiddenCount: 0 },
      new Set(),
      CTX,
    );
    expect(view.cards[0]?.reason).toMatch(/no flashback/i);
  });

  it("someone ELSE'S zone offers no cast and explains nothing — it is not your control", () => {
    // "Nothing lets you cast this from exile right now" is TRUE of an opponent's
    // card and still reads as an invitation to try again later. A foreign zone is
    // a reading surface; the honest tooltip there is the card's own name.
    const view = zonePanelView('exile', { cards: [card], hiddenCount: 0 }, new Set([1]), FOREIGN);
    expect(view.cards[0]?.actionable, 'a foreign zone must never be clickable').toBe(false);
    expect(view.cards[0]?.reason).toBeUndefined();
    expect(view.cards[0]?.badge).toBeUndefined();
  });

  it('a hidden card in a zone that claims to hide none is REPORTED, not dropped', () => {
    // Rule 2's closed table: a value outside the table reports honestly rather
    // than being widened. Swallowing it would make a masking bug invisible,
    // which is the one failure this whole file exists to stop.
    const view = zonePanelView('graveyard', { cards: [], hiddenCount: 1 }, new Set(), CTX);
    expect(view.hidden).toHaveLength(1);
    expect(view.hidden[0]?.label).toBe(UNEXPECTED_HIDDEN_LABEL);
  });

  it('every withheld card gets its own back, so the count can be read by looking', () => {
    const view = zonePanelView('exile', { cards: [], hiddenCount: 3 }, new Set(), CTX);
    expect(view.hidden).toHaveLength(3);
    expect(new Set(view.hidden.map((h) => h.key)).size, 'React keys must be unique').toBe(3);
    for (const h of view.hidden) expect(h.label).toBe(ZONE_PANELS.exile.hiddenLabel);
  });

  it('a withheld entry has NO field an identity could travel in', () => {
    // The structural half of the guarantee: `HiddenCardView` is a key and a
    // label. There is nowhere to put a name even by accident.
    const view = zonePanelView('exile', { cards: [], hiddenCount: 1 }, new Set(), CTX);
    expect(Object.keys(view.hidden[0] ?? {}).sort()).toEqual(['key', 'label']);
  });
});

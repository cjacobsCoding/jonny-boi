/**
 * THE GLOSSARY REACHES THE HAND (§3.143 / UX-17.4, wave 2 GAP-21).
 *
 * Caleb: *"hovering over any ability like 'vigilance' for example, on any card,
 * should show a tooltip explaining clearly what that ability does/how it
 * works."* Wave 1 built the glossary (`lib/play/keyword-glossary.ts`), built the
 * renderer that uses it (`CardFace`) and unit-tested both — and then mounted
 * `CardFace` on the battlefield tile alone. `PlayCard` draws the hand on BOTH
 * boards, the mulligan grid, the stack faces and the choice prompt's cards, and
 * every one of those was a bare `<img>`: a picture of a card has no text node,
 * so there was nothing to hover and nothing a test of the glossary module could
 * notice.
 *
 * So the assertions here are deliberately about the END of the chain — the
 * markup a player's pointer meets:
 *
 *  1. the full face really is drawn by the SHARED `CardFace`, not a second
 *     renderer (spec §2.4);
 *  2. a keyword the card PRINTS carries a tooltip with its explanation on the
 *     FULL face, with no `explanation` prop in sight — the hand has no
 *     continuous-effect index and must still explain "haste". Since bug report
 *     20260917_220137 the hand DRAWS the `compact` face (the printed scan, with
 *     only the aftermarket strip) and the full face is the hover preview
 *     `PlayBoard` wraps around every hand card — so the glossary is read one
 *     hover away, on a face big enough to read it, and never as a 7px overlay
 *     climbing over the art;
 *  3. the tooltip is not CLIPPED. `.play-card` is `overflow: hidden`, and a pop
 *     that exists inside a clipping box is a feature that shipped invisible —
 *     which is this whole wave's failure mode, in one CSS property;
 *  4. the chip face is untouched, so the adoption is scoped rather than a
 *     wholesale redraw of every card in the app.
 *
 * The expected strings are DERIVED from the glossary table, never typed here: a
 * hard-coded explanation is a second copy of the row that would go on passing
 * after the real one changed (rule 12).
 */
import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { CARD_POOL } from '@jonny-boi/cards';
import { getCard } from '../../lib/cards.js';
import { glossaryEntry } from '../../lib/play/keyword-glossary.js';
import { CardFace } from './CardFace.js';
import { PlayCard } from './PlayCard.js';

/**
 * A real pool card that PRINTS a keyword the glossary knows, found by search.
 *
 * Derived rather than named so the test cannot rot into "this one card still
 * works": if the pool stops containing any card that prints an explained
 * keyword, that is itself worth failing over.
 */
const KEYWORD = 'haste';

function cardPrinting(keyword: string): { readonly id: string; readonly name: string } {
  for (const card of CARD_POOL) {
    const record = getCard(card.id);
    if (record === undefined) continue;
    const text = record.oracleText ?? '';
    // The keyword on its own line is how a card prints a keyword ability, which
    // is what `tokenizeRulesLine` can recognise as one.
    if (text.split('\n').some((line) => line.trim().toLowerCase() === keyword)) {
      return { id: card.id, name: card.name };
    }
  }
  throw new Error(`no pool card prints "${keyword}" as a keyword line`);
}

const SUBJECT = cardPrinting(KEYWORD);

function fullFace(): string {
  return renderToStaticMarkup(
    createElement(PlayCard, { cardId: SUBJECT.id, name: SUBJECT.name, face: 'full' }),
  );
}

describe('PlayCard’s full face is the shared, live CardFace', () => {
  it('renders CardFace rather than a bare image', () => {
    const html = fullFace();
    expect(html).toContain('card-face');
    expect(html).toContain('card-face__art');
    // The box the <img> used to fill is handed straight to the face, so every
    // mount site that sizes `.play-card--full` keeps sizing it.
    expect(html).toContain('play-card__face');
  });

  it('the hand face is COMPACT: the printed scan, no second copy of the printed rules (20260917_220137)', () => {
    const html = fullFace();
    expect(html).toContain('card-face--compact');
    expect(html).not.toContain('card-face--full');
    // The scan prints the rules; a compact face never re-renders a printed line.
    expect(html).not.toContain('card-face__line--printed');
  });

  it('a printed keyword carries its glossary tooltip on the FULL face — with no explanation prop', () => {
    const html = renderToStaticMarkup(
      createElement(CardFace, { size: 'full', cardId: SUBJECT.id, name: SUBJECT.name }),
    );
    const entry = glossaryEntry(KEYWORD);
    expect(entry, `the glossary must know "${KEYWORD}"`).toBeDefined();
    expect(html).toContain('role="tooltip"');
    expect(html).toContain(entry!.term);
    // A distinctive word FROM the row, so the assertion tracks the real text
    // instead of a copy of it. Letters only, to sidestep HTML escaping.
    const word = entry!.text.split(/\s+/).find((w) => /^[A-Za-z]{6,}$/.test(w));
    expect(word, 'the glossary row should have a long plain word to match on').toBeDefined();
    expect(html).toContain(word!);
  });

  it('the tooltip is not clipped away by `.play-card { overflow: hidden }`', () => {
    // THE reach assertion. Without this the pop is in the DOM, passes every
    // markup test, and is invisible to the player — "built and tested" without
    // "reachable", which is the exact class of defect this wave exists to fix.
    expect(fullFace()).toContain('overflow:visible');
  });

  it('still degrades to the named plate when there is no card at all', () => {
    const html = renderToStaticMarkup(
      createElement(PlayCard, { cardId: '', name: 'Goblin token', face: 'full' }),
    );
    expect(html).toContain('Goblin token');
    expect(html).not.toContain('<img');
  });
});

describe('the adoption is scoped to the full face', () => {
  it('the chip keeps its art-crop + name + cost layout', () => {
    const html = renderToStaticMarkup(
      createElement(PlayCard, { cardId: SUBJECT.id, name: SUBJECT.name }),
    );
    expect(html).toContain('play-card__art');
    expect(html).toContain('play-card__foot');
    expect(html).not.toContain('card-face__art');
    // A chip has no room for a text box, so it also has no reason to escape the
    // card's own clipping box.
    expect(html).not.toContain('overflow:visible');
  });
});

/**
 * THE UX-11 GUARD: a tapped card is turned 90°, INCLUDING while it is attacking.
 *
 * Caleb called this out by name — *"cards actually angled 90 degrees when
 * tapped (including when attacking!)"* — because the board got it wrong in the
 * one case that matters most. `.perm--tapped { transform: rotate(24deg) }`
 * (styles.css) and `@keyframes perm-attack-lunge` (game-fx.css) were two rules
 * fighting over ONE element's `transform`, and a CSS animation outranks a normal
 * declaration, so an attacker without vigilance — which taps as it is declared,
 * i.e. the commonest tapped creature in the game — stood bolt upright.
 *
 * Node computes no layout and runs no cascade, so this test pins the STRUCTURAL
 * fact that makes the cascade fight impossible: the turn and the lunge are on
 * DIFFERENT elements, and the angle is a value from the config rather than a
 * literal in a stylesheet. A `board-scene.test.ts` sibling pins the CSS half.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { CARD_POOL } from '@jonny-boi/cards';
import { TAP_ROTATION_CONFIG } from '../../lib/play/play-config.js';
import type { BoardPermanent } from '../../lib/play/view-model.js';
import { BoardPermanentTile } from './BoardPermanentTile.js';

/**
 * A REAL pool card, because `CardFace` resolves its printed text through
 * `lib/cards.getCard()` — lane P's note: a `cardId: null` fixture renders a card
 * with no printed text and silently proves much less than it looks like.
 */
const BEAR_ID = (CARD_POOL.find((c) => c.name === 'Grizzly Bears') ?? CARD_POOL[0]!).id;

function permanent(overrides: Partial<BoardPermanent> = {}): BoardPermanent {
  return {
    instanceId: 42,
    cardId: '',
    name: 'Grizzly Bears',
    controller: 'A',
    isCreature: true,
    isLand: false,
    isPlaneswalker: false,
    loyalty: 0,
    isBattle: false,
    defense: 0,
    protector: null,
    tapped: false,
    summoningSick: false,
    power: 2,
    toughness: 2,
    printedPower: 2,
    printedToughness: 2,
    ptDelta: null,
    ptFromEffects: null,
    counters: [],
    damageMarked: 0,
    keywords: {},
    producesIfTapped: [],
    attacking: false,
    blocking: null,
    ...overrides,
  };
}

const render = (perm: BoardPermanent): string =>
  renderToStaticMarkup(createElement(BoardPermanentTile, { perm }));

/** The markup between an element's opening tag and the next one, per class. */
function tagWithClass(html: string, className: string): string | undefined {
  const match = new RegExp(`<[a-z]+[^>]*class="[^"]*\\b${className}\\b[^"]*"[^>]*>`).exec(html);
  return match?.[0];
}

describe('a tapped creature turns, and the turn survives combat', () => {
  it('THE REPORTED CASE: tapped AND attacking carries both the turn and the lunge class', () => {
    const html = render(permanent({ tapped: true, attacking: true }));
    // The lunge lives on `.perm` (game-fx.css animates `.perm--attacking`)…
    expect(html).toContain('perm--attacking');
    // …and the turn lives on a DIFFERENT element, so the animation has nothing
    // of anyone else's to erase.
    const turn = tagWithClass(html, 'perm-turn');
    expect(turn).toBeDefined();
    expect(turn).toContain(`--perm-turn-deg:${TAP_ROTATION_CONFIG.tappedDeg}deg`);
    const perm = tagWithClass(html, 'perm--attacking');
    expect(perm).toBeDefined();
    expect(perm).not.toContain('--perm-turn-deg');
  });

  it('the turn is the TABLE ANGLE, from config — not the 24° workaround it replaces', () => {
    expect(TAP_ROTATION_CONFIG.tappedDeg).toBe(90);
    const html = render(permanent({ tapped: true }));
    expect(tagWithClass(html, 'perm-turn')).toContain(
      `--perm-turn-deg:${TAP_ROTATION_CONFIG.tappedDeg}deg`,
    );
    expect(html).not.toContain('24deg');
  });

  it('an UNTAPPED attacker is upright, so the turn really is driven by `tapped`', () => {
    const html = render(permanent({ tapped: false, attacking: true }));
    expect(tagWithClass(html, 'perm-turn')).toContain('--perm-turn-deg:0deg');
    expect(html).not.toContain('perm-slot--tapped');
  });

  it('a turned card RESERVES its footprint, or it lies across its neighbour', () => {
    const tapped = render(permanent({ tapped: true }));
    expect(tapped).toContain('perm-slot--tapped');
    // The footprint is the card's own height-over-width, not a chosen number.
    expect(tagWithClass(tapped, 'perm-slot')).toContain(
      `--perm-footprint:${TAP_ROTATION_CONFIG.footprintRatio}`,
    );
    const upright = render(permanent({ tapped: false }));
    expect(tagWithClass(upright, 'perm-slot')).toContain('--perm-footprint:1');
  });

  it('a blocking tapped creature keeps its turn too — the same class, not a second rule', () => {
    const html = render(permanent({ tapped: true, blocking: 7 }));
    expect(html).toContain('perm--blocking');
    expect(tagWithClass(html, 'perm-turn')).toContain(
      `--perm-turn-deg:${TAP_ROTATION_CONFIG.tappedDeg}deg`,
    );
  });
});

describe('the staged copy is the measurable one (UX-12/13)', () => {
  it('an ordinary tile is BOTH the anchor and its own home', () => {
    const html = render(permanent());
    expect(html).toContain('data-perm-id="42"');
    expect(html).toContain('data-perm-home="42"');
  });

  it('a HOME tile gives up `data-perm-id` so the arcs aim at the advanced copy', () => {
    const html = renderToStaticMarkup(
      createElement(BoardPermanentTile, { perm: permanent(), staged: 'home' }),
    );
    expect(html).not.toContain('data-perm-id');
    expect(html).toContain('data-perm-home="42"');
    expect(html).toContain('perm-slot--staged');
  });

  it('the COPY carries `data-perm-id`, no home marker, and no layout slot', () => {
    const html = renderToStaticMarkup(
      createElement(BoardPermanentTile, { perm: permanent(), staged: 'copy' }),
    );
    expect(html).toContain('data-perm-id="42"');
    expect(html).not.toContain('data-perm-home');
    expect(html).not.toContain('perm-slot');
  });

  it('EXACTLY ONE element can answer "where is permanent 42?" in either arrangement', () => {
    for (const html of [
      render(permanent()),
      renderToStaticMarkup(createElement(BoardPermanentTile, { perm: permanent(), staged: 'home' })),
      renderToStaticMarkup(createElement(BoardPermanentTile, { perm: permanent(), staged: 'copy' })),
    ]) {
      expect(html.match(/data-perm-id="42"/g)?.length ?? 0).toBeLessThanOrEqual(1);
    }
  });
});

describe('the bare P/T delta badge is RETIRED (UX-17, rule 12)', () => {
  it('a pumped creature no longer wears an unattributed "+1/+1"', () => {
    // The face states 5/6 WITH provenance; a badge beside it that could show the
    // number but never the source is the second answer rule 12 forbids.
    const html = render(permanent({ power: 5, toughness: 6, ptDelta: { power: 1, toughness: 1 } }));
    expect(html).not.toContain('perm__pt-delta');
    expect(html).not.toContain('perm__mark--effect');
  });

  it('EXACTLY ONE P/T: the face states it when core can explain it, the footer when it cannot', () => {
    const explained = renderToStaticMarkup(
      createElement(BoardPermanentTile, {
        perm: permanent({
          cardId: BEAR_ID,
          power: 5,
          toughness: 6,
          explanation: {
            instanceId: 42,
            cardId: BEAR_ID,
            name: 'Grizzly Bears',
            zone: 'battlefield',
            basePower: 4,
            baseToughness: 5,
            power: 5,
            toughness: 6,
            keywords: {},
            printedKeywords: {},
            activated: [],
            printedActivated: [],
            contributions: [],
            fullyAttributed: true,
          },
        }),
      }),
    );
    // Caleb's own example: "base power and toughness are 4/5 … I want to see
    // printed on the card on the battlefield an actual 5/6".
    expect(explained).toContain('card-face__pt');
    expect(explained).toContain('5/6');
    // And the footer does NOT say it again.
    expect(explained).not.toContain('perm__pt"');

    const unexplained = render(permanent({ power: 5, toughness: 6 }));
    expect(unexplained).not.toContain('card-face__pt');
    expect(unexplained).toContain('perm__pt');
    expect(unexplained).toContain('5/6');
  });

  it('COUNTER chips survive, because "3 counters" and "5/6" are different facts', () => {
    const html = render(permanent({ counters: [{ kind: '+1/+1', count: 3 }] }));
    expect(html).toContain('perm__mark');
    expect(html).toContain('+1/+1 ×3');
  });
});

describe('every card on the battlefield is hoverable (UX-10)', () => {
  const source = readFileSync(
    fileURLToPath(new URL('./BoardPermanentTile.tsx', import.meta.url)),
    'utf8',
  ).replace(/\r\n/g, '\n');

  it('the JAILED PEEK is wrapped too — it was the one tile with no preview', () => {
    // Structural, because CardHover portals its panel to document.body and
    // renders only its children until a pointer arrives: there is nothing in the
    // static markup to assert on.
    const peek = source.slice(source.indexOf('function JailedPeek'));
    expect(peek).toContain('<CardHover');
    expect(peek.indexOf('<CardHover')).toBeLessThan(peek.indexOf('perm-stack__jailed'));
  });

  it('there is exactly ONE hover mechanism in this file', () => {
    // A second one left behind is the bug UX-10 names ("one hover funnel").
    expect(source).not.toMatch(/onMouseEnter|onPointerEnter/);
  });
});

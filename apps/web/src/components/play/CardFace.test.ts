/**
 * THE CARD FACE'S OWN TESTS — and they are mostly about REACH (§3.143 wave 2).
 *
 * Wave 1 shipped `CardFace` with 89 passing tests and NO test file of its own,
 * and the completeness audit then found that almost none of it reached a player:
 *
 *   - GAP-6 the provenance tooltip — the single thing Caleb asked for most
 *     specifically ("hovering over that 5/6 should show a full breakdown") — was
 *     `position: absolute` inside three clipping/transforming ancestors and could
 *     not be displayed at all. Nothing failed. Nothing could.
 *   - GAP-7 the hover preview and the zoom overlay, the surfaces a player opens
 *     to READ a card, rendered the bare printed scan: a tile saying 5/6 was
 *     inspected at 4/5.
 *   - GAP-8 the merged keyword line existed only at `size="full"`, which no
 *     reachable surface mounted.
 *   - GAP-9 the glossary was "on any card" only in the three places `CardFace`
 *     happened to be mounted.
 *
 * Every one of those is a MOUNT-SITE failure, so the guards here are mount-site
 * guards. A test that asserts this module exports the right shape is exactly the
 * test that passed all through wave 1.
 *
 * ⚠️ WHAT THIS FILE CANNOT DO. The suite has no DOM (root `vitest.config.ts`
 * collects `*.test.ts` with no `environment`), so nothing here executes a portal,
 * a `getBoundingClientRect` or a cascade. The portal fix is therefore pinned
 * STRUCTURALLY — the same technique `board-scene.test.ts` and
 * `tile-transform.test.ts` use for the same reason — plus a real behavioural test
 * of `popPlacement`, which is the half of the fix that is pure arithmetic. The
 * rendered result remains BROWSER-UNVERIFIED and the integrator should look at it.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { CharacteristicExplanation, ContributionSource } from '@jonny-boi/core';
import { getCardByName } from '../../lib/cards.js';
import { POP_PLACEMENT_CONFIG, popPlacement } from '../../lib/play/provenance-view.js';
import { CardFace, type CardFaceProps } from './CardFace.js';

/** Read a source file, newline-agnostic (CLAUDE.md's CRLF trap). */
function read(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), 'utf8').replace(/\r\n/g, '\n');
}

/** A stylesheet with its comments stripped, so prose can never satisfy a match. */
function stylesheet(relativePath: string): string {
  return read(relativePath).replace(/\/\*[\s\S]*?\*\//gu, '');
}

/**
 * TypeScript with its comments stripped, for the same reason — and here it is
 * load-bearing rather than tidy: every file below now carries a comment saying
 * it used to render a bare `<img>`, and a comment ABOUT the defect must never be
 * able to satisfy (or trip) an assertion about the defect.
 */
function code(relativePath: string): string {
  return read(relativePath)
    .replace(/\/\*[\s\S]*?\*\//gu, '')
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n');
}

interface CssRule {
  readonly selector: string;
  readonly declarations: string;
}

/** The same flat rule split `board-scene.test.ts` uses — good enough for this file's flat CSS. */
function cssRules(source: string): CssRule[] {
  const rules: CssRule[] = [];
  for (const chunk of source.split('}')) {
    const open = chunk.lastIndexOf('{');
    if (open === -1) continue;
    const head = chunk.slice(0, open);
    const previousOpen = head.lastIndexOf('{');
    const selector = (previousOpen === -1 ? head : head.slice(previousOpen + 1)).trim();
    if (selector.length === 0) continue;
    rules.push({ selector, declarations: chunk.slice(open + 1) });
  }
  return rules;
}

function ruleFor(rules: readonly CssRule[], selector: string): CssRule | undefined {
  return rules.find((r) => r.selector.split(',').some((s) => s.trim() === selector));
}

const cardFaceSource = code('./CardFace.tsx');
const cardFaceCss = stylesheet('./card-face.css');
const cardFaceRules = cssRules(cardFaceCss);

function render(props: CardFaceProps): string {
  return renderToStaticMarkup(createElement(CardFace, props));
}

/* -------------------------------------------------------------------------- */
/* 1. GAP-6 — the tooltip has to be able to LEAVE the board                    */
/* -------------------------------------------------------------------------- */

describe('the provenance tooltip escapes the board instead of being clipped by it', () => {
  /**
   * The CAUSE, read from the real stylesheets rather than remembered.
   *
   * A battlefield face sits inside `.perm__art` → `.perm` → `.seat__row`, and
   * inside `.perm-turn`, which carries the tap `transform`. `overflow` clips an
   * absolutely-positioned descendant, and a `transform` makes its element the
   * containing block for `position: fixed` descendants too — so a fixed pop is
   * re-rooted straight back into the same clip. This test fails only if EVERY one
   * of those disappears, which is the day the portal stops being necessary and
   * someone should re-read this comment rather than deleting it silently.
   */
  it('the mount site really does clip or re-root an in-place tooltip', () => {
    const ancestors: readonly (readonly [string, string, RegExp])[] = [
      ['styles.css → .perm clips', '../../styles.css', /\.perm\s*\{[^}]*overflow:\s*hidden/u],
      ['board-fit.css → .seat__row clips', './board-fit.css', /\.seat__row\s*\{[^}]*overflow-x:\s*auto/u],
      ['board-scene.css → .perm-turn transforms', './board-scene.css', /\.perm-turn\s*\{[^}]*transform:/u],
    ];
    const hits = ancestors.filter(([, path, pattern]) => pattern.test(stylesheet(path)));
    expect(
      hits.length,
      'no ancestor clips or transforms any more — the portal below may no longer be needed, but do not remove it without checking in a browser',
    ).toBeGreaterThan(0);
  });

  it('an OPEN pop is portaled to document.body', () => {
    expect(cardFaceSource).toMatch(/import\s*\{\s*createPortal\s*\}\s*from\s*'react-dom'/u);
    // Not merely imported — actually used for the pop.
    expect(cardFaceSource).toMatch(/createPortal\(\s*popElement\s*,\s*document\.body\s*\)/u);
  });

  it('nothing opens a pop from CSS alone — a CSS-only pop can never leave the clip', () => {
    // This is the shape of the original defect: `:hover > .card-face__pop {
    // opacity: 1 }` is invisible inside `overflow: hidden`, and it is the rule a
    // future editor is most likely to "restore".
    for (const rule of cardFaceRules) {
      if (!rule.selector.includes('.card-face__pop')) continue;
      if (!rule.selector.includes(':hover') && !rule.selector.includes(':focus-within')) continue;
      expect(rule.declarations, `${rule.selector} opens a pop from the cascade`).not.toMatch(
        /opacity:\s*1/u,
      );
    }
  });

  it('the floating pop is fixed, clears the inline anchoring, and outranks the surfaces it explains', () => {
    const floating = ruleFor(cardFaceRules, '.card-face__pop--floating');
    expect(floating?.declarations).toContain('position: fixed');
    // Without this the base rule's `bottom` survives and a fixed box with both
    // `top` and `bottom` set is STRETCHED between them.
    expect(floating?.declarations).toContain('inset: auto');
    expect(floating?.declarations).toContain('z-index: var(--card-face-pop-float-z)');
    // The base rule's transform is the inline copy's centring shift plus the
    // scene counter-tilt; neither means anything in viewport coordinates.
    expect(floating?.declarations).toContain('transform: none');
  });

  /**
   * A portaled node inherits custom properties from `<body>`, NOT from its React
   * parent. A pop tunable left on `.card-face` therefore evaluates to nothing on
   * the floating copy — silently, with no error — so both copies read ONE
   * definition at the root (rule 12).
   */
  it('every tunable the pop reads is declared at :root, not on .card-face', () => {
    const root = ruleFor(cardFaceRules, ':root');
    const face = ruleFor(cardFaceRules, '.card-face');
    for (const tunable of ['--card-face-pop-w', '--card-face-pop-ms', '--card-face-pop-float-z']) {
      expect(root?.declarations, `${tunable} must be declared at :root`).toContain(tunable);
      expect(face?.declarations, `${tunable} must NOT be declared on .card-face`).not.toContain(
        `${tunable}:`,
      );
    }
  });

  it('the CLOSED pop still renders inline, so aria-describedby and the tests can see it', () => {
    const html = render(calebsCase());
    expect(html).toContain('role="tooltip"');
    expect(html).not.toContain('card-face__pop--floating');
    // Every trigger's described-by id is really present on a pop in the markup.
    const describedBy = [...html.matchAll(/aria-describedby="([^"]+)"/gu)].map((m) => m[1]!);
    expect(describedBy.length).toBeGreaterThan(0);
    for (const id of describedBy) expect(html, `no pop with id ${id}`).toContain(`id="${id}"`);
  });
});

/* -------------------------------------------------------------------------- */
/* 2. popPlacement — the half of the portal that Node CAN check                */
/* -------------------------------------------------------------------------- */

describe('a tooltip is placed against its word and clamped into the viewport', () => {
  const VIEWPORT = { width: 1000, height: 800 };
  const POP = { left: 0, top: 0, width: 200, height: 100 };
  const { gapPx, viewportMarginPx } = POP_PLACEMENT_CONFIG;

  it('sits ABOVE the word and centred on it when there is room', () => {
    const placement = popPlacement({ left: 400, top: 400, width: 40, height: 16 }, POP, VIEWPORT);
    expect(placement.above).toBe(true);
    expect(placement.top).toBe(400 - gapPx - POP.height);
    expect(placement.left).toBe(400 + 20 - POP.width / 2);
  });

  it('flips BELOW the word when the top of the screen is in the way', () => {
    const placement = popPlacement({ left: 400, top: 4, width: 40, height: 16 }, POP, VIEWPORT);
    expect(placement.above).toBe(false);
    expect(placement.top).toBe(4 + 16 + gapPx);
  });

  it('never crosses either side margin — a tooltip off the screen edge is the clip again', () => {
    const nearRight = popPlacement({ left: 985, top: 400, width: 10, height: 16 }, POP, VIEWPORT);
    expect(nearRight.left).toBe(VIEWPORT.width - viewportMarginPx - POP.width);
    const nearLeft = popPlacement({ left: 2, top: 400, width: 10, height: 16 }, POP, VIEWPORT);
    expect(nearLeft.left).toBe(viewportMarginPx);
  });

  it('when the viewport is smaller than the tooltip, the FIRST words stay on screen', () => {
    const tiny = { width: 120, height: 60 };
    const placement = popPlacement({ left: 40, top: 30, width: 10, height: 16 }, POP, tiny);
    expect(placement.left).toBe(viewportMarginPx);
    expect(placement.top).toBe(viewportMarginPx);
  });
});

/* -------------------------------------------------------------------------- */
/* 3. GAP-7/8/9 — the adoption table: who MOUNTS a card face                   */
/* -------------------------------------------------------------------------- */

/** One surface that puts a card in front of a player. CLOSED — a new one is a ROW. */
interface CardSurface {
  readonly file: string;
  /** What the player is looking at. */
  readonly what: string;
  /** The element it must mount: the face itself, or the shared hover funnel that raises one. */
  readonly mounts: '<CardFace' | '<CardHover';
  /**
   * Why this file may still contain a raw `<img>` of a card, or `null` when it
   * may not. A raw printed scan beside a live face is the defect GAP-7 names:
   * two answers to "what does this card say".
   */
  readonly rawScanAllowed: string | null;
}

const CARD_SURFACES: readonly CardSurface[] = Object.freeze([
  Object.freeze({
    file: '../CardHover.tsx',
    what: 'the hover preview — the app’s single "show me this card" funnel',
    mounts: '<CardFace',
    rawScanAllowed: null,
  }),
  Object.freeze({
    file: './CardZoomOverlay.tsx',
    what: 'the zoom overlay — the one surface with live pointer events over a full card',
    mounts: '<CardFace',
    rawScanAllowed: null,
  }),
  Object.freeze({
    file: './BoardPermanentTile.tsx',
    what: 'the battlefield tile',
    mounts: '<CardFace',
    rawScanAllowed:
      'the JAILED PEEK’s tucked thumbnail — a few pixels of a card held prisoner, itself wrapped in CardHover for the readable face',
  }),
  Object.freeze({
    file: './GraveyardPanel.tsx',
    what: 'the opened graveyard',
    mounts: '<CardHover',
    rawScanAllowed: null,
  }),
  Object.freeze({
    file: './RevealBanner.tsx',
    what: 'a card revealed to both players',
    mounts: '<CardHover',
    rawScanAllowed: 'the 84px banner thumbnail; the readable face is one hover away',
  }),
]);

describe('every surface that shows a card shows the CURRENT card (GAP-7/9)', () => {
  for (const surface of CARD_SURFACES) {
    it(`${surface.what} mounts ${surface.mounts}`, () => {
      const source = code(surface.file);
      expect(source).toContain(surface.mounts);
      if (surface.rawScanAllowed === null) {
        expect(source, `${surface.file} still renders a raw printed scan`).not.toMatch(/<img\b/u);
      }
    });
  }

  it('the hover preview raises a FULL face carrying the surface’s own explanation', () => {
    const hover = code('../CardHover.tsx');
    expect(hover).toContain('size="full"');
    expect(hover).toContain('explanation');
    // The panel is what gets portaled beside the cursor; the face has to be
    // inside it, not merely imported at the top of the file.
    const panel = hover.slice(hover.indexOf('function CardHoverPanel'));
    expect(panel).toContain('<CardFace');
  });

  it('the battlefield tile hands its explanation to the preview it opens', () => {
    // Without this the tile prints 5/6 and the card you raise to read it prints
    // 4/5 — the two-answers defect, on the exact surface a player checks with.
    const tile = code('./BoardPermanentTile.tsx');
    expect(tile).toMatch(/<CardHover[^>]*[\s\S]{0,200}explanation=\{perm\.explanation\}/u);
  });

  it('the zoom overlay accepts an explanation, so a caller can pass one through', () => {
    const zoom = code('./CardZoomOverlay.tsx');
    expect(zoom).toContain('explanation');
    expect(zoom).toContain('size="full"');
  });
});

/* -------------------------------------------------------------------------- */
/* 4. GAP-8 — Caleb's acceptance sentence, on a surface that exists            */
/* -------------------------------------------------------------------------- */

function auraSource(): ContributionSource {
  return {
    kind: 'attachment',
    instanceId: 7,
    cardId: 'aura-id',
    name: 'Griffin Guide',
    zone: 'battlefield',
    label: 'Enchanted creature gets +2/+2 and has flying.',
  };
}

/**
 * A REAL pool card printed with a two-keyword line — "First strike, vigilance" —
 * granted flying by an aura. This is Caleb's sentence as closely as the pool
 * allows: *"if the base creature already had 'vigilance, first strike' in its
 * rules text, it should now say 'vigilance, first strike, flying'"*.
 */
function calebsCase(): CardFaceProps {
  const inquisitor = getCardByName('Elite Inquisitor')!;
  const explanation: CharacteristicExplanation = {
    instanceId: 1,
    cardId: inquisitor.id,
    name: inquisitor.name,
    zone: 'battlefield',
    basePower: 2,
    baseToughness: 2,
    power: 4,
    toughness: 4,
    printedKeywords: { firstStrike: true, vigilance: true },
    keywords: { firstStrike: true, vigilance: true, flying: true },
    activated: [],
    printedActivated: [],
    fullyAttributed: true,
    contributions: [
      { characteristic: 'keyword', layer: 'ability', mode: 'grant', detail: 'flying', source: auraSource() },
      { characteristic: 'power', layer: 'modifyPT', mode: 'add', amount: 2, source: auraSource() },
      { characteristic: 'toughness', layer: 'modifyPT', mode: 'add', amount: 2, source: auraSource() },
    ],
  };
  return { cardId: inquisitor.id, isCreature: true, explanation, size: 'full' };
}

/** The text of the first rules line in a rendered face, markup and all. */
function firstRulesLine(html: string): string {
  const match = /<p class="card-face__line[^"]*">([\s\S]*?)<\/p>/u.exec(html);
  expect(match, 'the face rendered no rules line at all').not.toBeNull();
  return match![1]!;
}

describe('the merged keyword line is on a surface a player reaches (GAP-8)', () => {
  it('a printed "First strike, vigilance" granted flying reads "First strike, vigilance, Flying"', () => {
    const line = firstRulesLine(render(calebsCase()));
    const plain = line.replace(/<[^>]*>/gu, '');
    expect(plain).toContain('First strike');
    expect(plain).toContain('vigilance');
    expect(plain).toContain('Flying');
    // ORDER matters: the granted word joins the END of the printed line, the way
    // a printed keyword line reads. A separate badge strip would pass a
    // "contains Flying" test while failing the request.
    expect(plain.indexOf('First strike')).toBeLessThan(plain.indexOf('vigilance'));
    expect(plain.indexOf('vigilance')).toBeLessThan(plain.indexOf('Flying'));
    // …and the granted word is styled differently from the printed ones, which
    // is the other half of the sentence.
    expect(line).toContain('card-face__tok--granted');
    expect(line).toContain('card-face__tok--printed');
  });

  it('the granted word names the card that granted it', () => {
    const html = render(calebsCase());
    expect(html).toContain('Griffin Guide');
    expect(html).toContain('Enchanted creature gets +2/+2 and has flying.');
  });

  /**
   * The DELIBERATE choice, stated so it cannot be mistaken for an oversight: a
   * ~96px tile carries the CONDENSED form (the words visible nowhere else) and
   * the merged line lives on the full-size face — which the tile's own
   * `CardHover` now raises. Rendering neither is what wave 1 did.
   */
  it('the tile keeps the condensed form, and the full line is one hover away', () => {
    const tileHtml = render({ ...calebsCase(), size: 'tile' });
    expect(tileHtml).toContain('Flying');
    expect(tileHtml).not.toContain('First strike');
    // The reachability half: the tile is wrapped in the funnel that mounts the
    // full face. Assert it, or "one hover away" is just a comment.
    const tile = code('./BoardPermanentTile.tsx');
    expect(tile).toContain('<CardHover');
    expect(code('../CardHover.tsx')).toContain('size="full"');
  });

  it('the P/T box shows the effective numbers, not the printed ones', () => {
    const html = render(calebsCase());
    expect(html).toContain('4/4');
    expect(html).toContain('card-face__pt--altered');
    // And the breakdown that hover now actually shows is really in the markup.
    expect(html).toContain('Printed power');
  });
});

/* -------------------------------------------------------------------------- */
/* 5. GAP-9 — the glossary, on a card nothing has touched                      */
/* -------------------------------------------------------------------------- */

describe('the glossary is on ANY card, and guesses at none', () => {
  it('a plain, unmodified card still explains its printed ability words', () => {
    const inquisitor = getCardByName('Elite Inquisitor')!;
    const html = render({ cardId: inquisitor.id, name: inquisitor.name });
    expect(html).toContain('card-face__tok--printed');
    expect(html).toContain('role="tooltip"');
    expect(html).not.toContain('card-face--altered');
  });

  it('no word is a focusable trigger without a tooltip behind it', () => {
    // The closure property, structurally: lane F's table returns `undefined` for
    // a word it does not know, and a trigger with an empty pop would be a
    // keyboard stop that explains nothing.
    for (const props of [calebsCase(), { ...calebsCase(), size: 'tile' as const }]) {
      const html = render(props);
      const triggers = html.match(/tabindex="0"/gu)?.length ?? 0;
      const pops = html.match(/role="tooltip"/gu)?.length ?? 0;
      expect(triggers).toBe(pops);
    }
  });
});

/* -------------------------------------------------------------------------- */
/* 6. Degrading (rule 6)                                                       */
/* -------------------------------------------------------------------------- */

describe('the face degrades instead of crashing', () => {
  it('an unknown card id becomes a name plate', () => {
    const html = render({ cardId: 'not-a-real-card', name: 'Mystery Card' });
    expect(html).toContain('card-face__fallback');
    expect(html).toContain('Mystery Card');
  });

  it('a surface with no provenance says so rather than showing an empty breakdown', () => {
    const html = render({
      cardId: null,
      name: 'Remote Creature',
      isCreature: true,
      unavailableReason: 'Live provenance is not carried by the multiplayer protocol yet.',
    });
    expect(html).toContain('multiplayer protocol');
  });
});

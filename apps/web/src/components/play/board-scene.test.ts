/**
 * THE UX-9 GUARDS — the class of failure, not the instance.
 *
 * A 3D scene is a cascade-and-containment change, and jsdom computes neither, so
 * these are SOURCE assertions about the two facts that make the scene safe:
 *
 *   1. `.play-board` itself carries no `transform` / `perspective` / `filter` /
 *      `contain: paint`. Twelve `position: fixed` overlays are its descendants,
 *      and any of those four makes it their containing block — silently
 *      re-rooting every one of them and moving every measured coordinate. The
 *      recon predicted this comes back "the first time someone wants a screen
 *      shake"; this is the test that stops it.
 *   2. Every one of those overlays is a SIBLING of `.board-scene`, not a
 *      descendant. That is the guard for "someone nested a modal back inside the
 *      scene", which is the shape the mistake will take.
 *
 * Plus the no-literals rule: board-scene.css must read every angle, distance and
 * duration from a custom property the board sets from `play-config.ts`.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/** Read a source file, newline-agnostic (CLAUDE.md's CRLF trap). */
function read(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), 'utf8').replace(
    /\r\n/g,
    '\n',
  );
}

/** A stylesheet with its comments stripped, so prose can never satisfy a match. */
function stylesheet(relativePath: string): string {
  return read(relativePath).replace(/\/\*[\s\S]*?\*\//g, '');
}

interface CssRule {
  readonly selector: string;
  readonly declarations: string;
}

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

const sceneCss = stylesheet('./board-scene.css');
const sceneRules = cssRules(sceneCss);
const boardFitCss = stylesheet('./board-fit.css');
const clarityCss = stylesheet('./board-clarity.css');
const gameFxCss = stylesheet('./game-fx.css');
const playBoard = read('./PlayBoard.tsx');

function ruleFor(rules: CssRule[], selector: string): CssRule | undefined {
  return rules.find((r) => r.selector.split(',').some((s) => s.trim() === selector));
}

describe('the scene is on `.board-scene`, and NEVER on `.play-board`', () => {
  it('`.board-scene` holds the projection and `.board-scene__table` holds the tilt', () => {
    const scene = ruleFor(sceneRules, '.play-board .board-scene');
    expect(scene?.declarations).toContain('perspective: var(--board-perspective-px)');
    expect(scene?.declarations).toContain('perspective-origin:');
    const table = ruleFor(sceneRules, '.play-board .board-scene__table');
    expect(table?.declarations).toContain('rotateX(var(--board-tilt-deg))');
  });

  it('the tilt rotates about the scene’s BOTTOM edge, so the projection cannot overflow', () => {
    // Rotating about the centre pushes the near half toward the viewer and
    // ENLARGES it — and `.play-board` is `overflow-y: auto`, so that growth
    // becomes scrollable overflow and the board starts scrolling itself, the one
    // outcome board-fit.css rule 5 forbids.
    const table = ruleFor(sceneRules, '.play-board .board-scene__table');
    expect(table?.declarations).toContain('transform-origin: 50% 100%');
  });

  it('NO play-surface stylesheet gives `.play-board` a transform, filter or paint containment', () => {
    const forbidden = /(^|[;{\s])(transform|perspective|filter|backdrop-filter)\s*:/;
    for (const [name, css] of [
      ['board-scene.css', sceneCss],
      ['board-fit.css', boardFitCss],
      ['board-clarity.css', clarityCss],
      ['game-fx.css', gameFxCss],
    ] as const) {
      for (const rule of cssRules(css)) {
        const names = rule.selector.split(',').map((s) => s.trim());
        // The board's OWN box — not a descendant rule that merely starts with it.
        if (!names.some((s) => s === '.play-board' || s === '.app:has(.play-board) .play-board')) {
          continue;
        }
        expect(rule.declarations, `${name} → ${rule.selector}`).not.toMatch(forbidden);
        expect(rule.declarations, `${name} → ${rule.selector}`).not.toContain('contain: paint');
      }
    }
  });

  it('`.board-scene` is the ONLY thing on the play surface that declares a perspective', () => {
    const perspectives = [sceneCss, boardFitCss, clarityCss, gameFxCss].flatMap((css) =>
      cssRules(css)
        .filter((r) => /(^|[;{\s])perspective\s*:/.test(r.declarations))
        .map((r) => r.selector.trim()),
    );
    expect(perspectives).toEqual(['.play-board .board-scene']);
  });
});

describe('every fixed overlay is a SIBLING of the scene, not a descendant', () => {
  // Each of these is `position: fixed` (or absolute, for the arcs) and measures
  // in viewport coordinates. Inside a transformed ancestor, every one of them is
  // re-rooted and mis-placed — silently, with no error anywhere.
  const OVERLAYS = [
    '<CardZoomOverlay',
    '<ChoicePrompt',
    '<AbilityMenuPrompt',
    '<AbilityTargetPrompt',
    'className="target-prompt"',
    'className="play-toast"',
    '<RevealBanner',
    '<StopsMenu',
    '<CombatLines',
    '<AnimationLayer',
    '<VfxLayer',
    '<DamageLayer',
    '<CombatStage',
    '<SpellHoldCard',
    '<OpponentActionFeed',
    '<StackPanel',
  ] as const;

  const sceneEnd = playBoard.indexOf('</StagedPermanentsContext.Provider>');

  it('the scene really is opened and closed in the board', () => {
    expect(playBoard).toContain('<div className="board-scene">');
    expect(sceneEnd).toBeGreaterThan(0);
  });

  for (const overlay of OVERLAYS) {
    it(`${overlay} is outside the scene`, () => {
      const at = playBoard.indexOf(overlay);
      expect(at, `${overlay} is not mounted at all`).toBeGreaterThan(0);
      expect(at).toBeGreaterThan(sceneEnd);
    });
  }

  it('the viewer’s OWN hand is outside the scene too — a tilted hand is unreadable', () => {
    const hand = playBoard.indexOf('aria-label={`${view.self.name} hand`}');
    expect(hand).toBeGreaterThan(sceneEnd);
  });
});

describe('board-scene.css contains no literal that affects behaviour or feel', () => {
  it('every angle, distance and duration is a custom property', () => {
    // Whitelisted: `0`/`0deg`/`0ms` identities, the `50%`/`100%` of a transform
    // origin, and `1px`/`8px`-class chrome inside the announce card, which is
    // ordinary surface styling rather than a tunable of any system.
    const declarationsOfInterest = sceneRules.flatMap((rule) =>
      rule.declarations
        .split(';')
        .map((d) => d.trim())
        .filter((d) => /^(transform|perspective|rotate|transition-duration|animation|opacity|filter)/.test(d)),
    );
    expect(declarationsOfInterest.length).toBeGreaterThan(0);
    for (const declaration of declarationsOfInterest) {
      const suspicious = declaration.match(/(?<![\w-])(\d+(?:\.\d+)?)(deg|ms|s)(?![\w-])/g) ?? [];
      const offenders = suspicious.filter((token) => !/^0(deg|ms|s)$/.test(token));
      expect(offenders, declaration).toEqual([]);
    }
  });

  it('the tap turn, the tapped dimming and the advance all read config properties', () => {
    expect(sceneCss).toContain('var(--perm-turn-deg');
    expect(sceneCss).toContain('var(--perm-tapped-opacity)');
    expect(sceneCss).toContain('var(--perm-tapped-grayscale)');
    expect(sceneCss).toContain('var(--combat-advance-ms)');
  });

  it('the 24° workaround in styles.css is neutralised BY SPECIFICITY, not by source order', () => {
    // board-fit.css:188-202 records that which file lands last here is an
    // accident of module import order, and that it has silently lost once.
    const rule = ruleFor(sceneRules, '.play-board .perm.perm--tapped');
    expect(rule?.declarations).toContain('transform: none');
  });
});

describe('the motion is gated, and the stage is inert', () => {
  it('every transition/animation in the scene sits inside a reduced-motion guard', () => {
    // Split on the media query so the unguarded half can be checked alone.
    const guardStart = sceneCss.indexOf('@media (prefers-reduced-motion: no-preference)');
    expect(guardStart).toBeGreaterThan(0);
    for (const rule of sceneRules) {
      if (/transition:|animation:/.test(rule.declarations)) {
        // Crude but sufficient: a rule declaring motion must appear after at
        // least one guard opener, and every guard in this file is a
        // no-preference one.
        expect(sceneCss.indexOf(rule.declarations)).toBeGreaterThan(guardStart);
      }
    }
  });

  it('the combat stage eats no pointer events — the HOME tile is still the click target', () => {
    const stage = ruleFor(sceneRules, '.combat-stage');
    expect(stage?.declarations).toContain('pointer-events: none');
    expect(stage?.declarations).toContain('position: fixed');
  });
});

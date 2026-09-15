/**
 * THE CLASS GUARD FOR "OVERRIDING OVERLAYS" — a fifth announcer must FAIL here.
 *
 * Caleb: *"we are getting some overriding overlays in app that look bad - like
 * 'heres what goblin guide revealed from your library' and 'heres what the
 * computer casted' - those should reconcile somehow"*.
 *
 * ## The instance, and the shape it had
 *
 * Four announcers, four hand-written `position: fixed` rules, four opinions
 * about where to paint:
 *
 * ```
 * .reveal-banner   top: 12%     z-index: 70
 * .spell-hold      top: 50%     z-index: 52   max-height: calc(100vh - 2rem)
 * .combat-hold     top: 3.9rem  z-index: 52
 * .forced-choice   top: 3.9rem  z-index: 52   ← the identical slot
 * ```
 *
 * `docs/WATCH-A-GAME.md` §WATCH-4 predicted this in writing — *"This must be
 * built as the shared mechanism now, before the fourth announcer lands and makes
 * it five"* — and the fourth landed first. So the guard has to be about the
 * CLASS: not "these four reconcile", but **"an announcement cannot reach the
 * screen except through the one surface"**.
 *
 * ## How each assertion is DERIVED rather than listed
 *
 * §7.3's own conclusion about which guards in this repo actually work: *"the
 * guards that actually work all derive the list of MOUNTS from the source and
 * fail when a new mount appears without the prop"*. So:
 *
 *  - the KINDS come from `ANNOUNCEMENT_KINDS` at runtime, not from a list here;
 *  - the announcement COMPONENTS are read out of the boards' own renderer maps;
 *  - the classes they emit are read out of those components;
 *  - the stylesheets are then checked against what was found.
 *
 * A fifth announcement fails three different ways: the mapped `AnnouncementBody`
 * union stops the build, the mapped renderer map stops the build at both boards,
 * and if somebody bypasses both by hand-rolling a banner, the mount assertion and
 * the z-index census below redden.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  ANNOUNCEMENT_KINDS,
  ANNOUNCEMENT_ORDER,
  announcementQueue,
  type AnnouncementBody,
  type AnnouncementKind,
} from '../../lib/play/announcements.js';
import { AnnouncementSurface, type AnnouncementRenderers } from './AnnouncementSurface.js';

/** Read a source file newline-agnostically (CLAUDE.md's CRLF trap). */
function read(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), 'utf8').replace(
    /\r\n/g,
    '\n',
  );
}

/** A file with every comment stripped — what the code actually DOES. */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

/** The two boards that mount announcements, and nothing else in the app does. */
const BOARDS: readonly (readonly [string, string])[] = [
  ['PlayBoard.tsx', code(read('./PlayBoard.tsx'))],
  ['OnlineBoard.tsx', code(read('../online/OnlineBoard.tsx'))],
];

/**
 * One board's renderer map, as source text — everything between
 * `announcementRenderers` and the `}),` that closes the object literal.
 */
function rendererMap(source: string): string {
  const at = source.indexOf('announcementRenderers: AnnouncementRenderers');
  expect(at, 'this board declares no renderer map').toBeGreaterThan(0);
  const end = source.indexOf('\n    }),', at);
  expect(end, 'the renderer map is not closed the way this test reads it').toBeGreaterThan(at);
  return source.slice(at, end);
}

/**
 * THE ANNOUNCEMENT COMPONENTS, derived from the maps rather than listed: every
 * `<Component` mounted inside a renderer map, on either board.
 */
const ANNOUNCEMENT_COMPONENTS: readonly string[] = [
  ...new Set(
    BOARDS.flatMap(([, source]) =>
      [...rendererMap(source).matchAll(/<([A-Z][A-Za-z]*)\b/g)].map((m) => m[1] as string),
    ),
  ),
].sort();

// ---------------------------------------------------------------------------
describe('every announcement reaches the screen through the ONE surface', () => {
  it('the derivation found real components — this file is not asserting about nothing', () => {
    expect(ANNOUNCEMENT_COMPONENTS.length).toBe(ANNOUNCEMENT_ORDER.length);
  });

  for (const [name, source] of BOARDS) {
    it(`${name} mounts AnnouncementSurface, with its renderer map`, () => {
      expect(source).toMatch(/<AnnouncementSurface[\s\S]{0,200}renderers=\{announcementRenderers\}/);
    });

    it(`${name} supplies a renderer for EVERY kind in the table`, () => {
      const map = rendererMap(source);
      for (const kind of ANNOUNCEMENT_ORDER) {
        expect(map, `${name} has no renderer for ${kind}`).toContain(`${kind}: (body)`);
      }
    });

    it(`${name} mounts exactly ONE announcement surface`, () => {
      expect([...source.matchAll(/<AnnouncementSurface\b/g)]).toHaveLength(1);
    });
  }

  /**
   * ⚠️ THE ASSERTION A FIFTH HAND-ROLLED BANNER TRIPS. Every mount of every
   * announcement component must be inside a renderer map. A new `<MyBanner …/>`
   * dropped beside the surface — which is exactly how all four of these came to
   * exist — leaves the map and is caught here.
   */
  const dir = fileURLToPath(new URL('.', import.meta.url));
  const files: readonly (readonly [string, string])[] = [
    ...readdirSync(dir)
      .filter((f) => f.endsWith('.tsx'))
      .map((f) => [f, code(read(`./${f}`))] as const),
    ...readdirSync(fileURLToPath(new URL('../online', import.meta.url)))
      .filter((f) => f.endsWith('.tsx'))
      .map((f) => [`online/${f}`, code(read(`../online/${f}`))] as const),
  ];

  it.each(files.map(([f]) => f))('%s mounts no announcement outside a renderer map', (file) => {
    const source = (files.find(([f]) => f === file) as readonly [string, string])[1];
    // The components' own definition files are where they are DECLARED, not
    // mounted; `<Component` never appears there for itself.
    const map = /announcementRenderers: AnnouncementRenderers/.test(source)
      ? rendererMap(source)
      : '';
    for (const component of ANNOUNCEMENT_COMPONENTS) {
      const mounts = [...source.matchAll(new RegExp(`<${component}\\b`, 'g'))].length;
      const inMap = [...map.matchAll(new RegExp(`<${component}\\b`, 'g'))].length;
      expect(
        mounts - inMap,
        `${file} mounts <${component}> outside the announcement surface — every announcer goes through one surface`,
      ).toBe(0);
    }
  });
});

// ---------------------------------------------------------------------------
describe('a body owns no slot of its own — the surface owns all four positions', () => {
  const STYLESHEETS = [
    './board-scene.css',
    './board-clarity.css',
    './board-fit.css',
    './game-fx.css',
    './card-references.css',
    './opponent-feed.css',
    './stack-panel.css',
    './action-bar.css',
    './combat-arcs.css',
  ] as const;

  interface CssRule {
    readonly file: string;
    readonly selector: string;
    readonly declarations: string;
  }

  /** Every rule in the play surface's stylesheets, comments stripped. */
  const rules: readonly CssRule[] = STYLESHEETS.flatMap((file) => {
    const css = read(file).replace(/\/\*[\s\S]*?\*\//g, '');
    const out: CssRule[] = [];
    for (const chunk of css.split('}')) {
      const open = chunk.lastIndexOf('{');
      if (open === -1) continue;
      const head = chunk.slice(0, open);
      const previousOpen = head.lastIndexOf('{');
      const selector = (previousOpen === -1 ? head : head.slice(previousOpen + 1)).trim();
      if (selector.length === 0) continue;
      out.push({ file, selector, declarations: chunk.slice(open + 1) });
    }
    return out;
  });

  /** The root class each announcement component emits, read from its source. */
  const rootClassOf = (component: string): string => {
    const source = code(read(`./${component}.tsx`));
    const match = source.match(/className=\{?[`"]([a-z-]+)/);
    expect(match, `${component} has no readable root class`).not.toBeNull();
    return (match as RegExpMatchArray)[1] as string;
  };

  const POSITIONING = /(^|[;\s])(position|z-index|top|bottom|left|right)\s*:/;

  it.each(ANNOUNCEMENT_COMPONENTS)('%s declares no position of its own', (component) => {
    const root = rootClassOf(component);
    for (const rule of rules) {
      // Only the ROOT class's own rules — a descendant may of course position
      // itself inside the announcement.
      if (rule.selector.trim() !== `.${root}`) continue;
      expect(
        POSITIONING.test(rule.declarations),
        `${rule.file}: .${root} positions itself — the surface owns the slot, and four bodies that each chose one is the reported defect`,
      ).toBe(false);
    }
  });

  it('the surface DOES own a position and a z-index', () => {
    const surface = rules.find((r) => r.selector.trim() === '.announce');
    expect(surface, '.announce has no rule at all').toBeDefined();
    expect(surface?.declarations).toContain('position: fixed');
    expect(surface?.declarations).toMatch(/z-index:\s*\d+/);
  });

  /**
   * ⚠️ THE CENSUS THAT WOULD HAVE CAUGHT THE ORIGINAL BUG. `.combat-hold` and
   * `.forced-choice` both declared `z-index: 52` at the same `top`. Nothing on
   * the play surface may now sit at or above the announcement surface's own
   * stacking level — if it did, it could paint over an announcement, which is
   * the whole complaint.
   */
  it('NOTHING on the play surface stacks at or above the announcement', () => {
    const zOf = (declarations: string): number | null => {
      const m = declarations.match(/(^|[;\s])z-index:\s*(\d+)/);
      return m ? Number(m[2]) : null;
    };
    const surfaceZ = zOf(
      (rules.find((r) => r.selector.trim() === '.announce') as CssRule).declarations,
    );
    expect(surfaceZ).not.toBeNull();
    const offenders = rules
      .filter((r) => r.selector.trim() !== '.announce')
      .filter((r) => {
        const z = zOf(r.declarations);
        return z !== null && z >= (surfaceZ as number);
      })
      .map((r) => `${r.file}: ${r.selector} (z-index ${zOf(r.declarations)})`);
    expect(offenders).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
describe('the surface mounts exactly ONE announcement, and SAYS what is waiting', () => {
  const BODIES: { readonly [K in AnnouncementKind]: AnnouncementBody } = {
    combatHold: { kind: 'combatHold', hold: { kind: 'blocksDeclared', label: 'Blockers declared', ms: 1000 } },
    spellHold: {
      kind: 'spellHold',
      hold: { instanceId: 121, controller: 'B', kind: 'spell' },
      pressure: { pointerOver: false, extensions: 0 },
    },
    forcedChoice: {
      kind: 'forcedChoice',
      forced: {
        id: 'engine:7',
        kind: 'selectTargets',
        chooser: 'A',
        sourceInstanceId: 99,
        sourceName: 'Banisher Priest',
        verb: 'targets',
        refs: [121],
        words: ['Grizzly Bears'],
        why: 'only one legal target',
        volume: 'banner',
      },
    },
    reveal: {
      kind: 'reveal',
      reveal: {
        at: 42,
        instanceId: 7,
        cardId: 'x',
        name: 'Mountain',
        player: 'A',
        text: 'Goblin Guide reveals Mountain.',
      },
    },
  };

  /** Stub bodies, so this measures the SURFACE and not the four components. */
  const renderers = Object.fromEntries(
    ANNOUNCEMENT_ORDER.map((kind) => [
      kind,
      () => createElement('p', { className: `stub-${kind}` }, kind),
    ]),
  ) as unknown as AnnouncementRenderers;

  const render = (live: readonly AnnouncementBody[]): string =>
    renderToStaticMarkup(
      createElement(AnnouncementSurface, { queue: announcementQueue(live), renderers }),
    );

  it('all four live: exactly ONE body is in the markup', () => {
    const html = render(ANNOUNCEMENT_ORDER.map((k) => BODIES[k]));
    const drawn = ANNOUNCEMENT_ORDER.filter((k) => html.includes(`stub-${k}`));
    expect(drawn, 'two announcements must never be on screen at once').toEqual(['combatHold']);
  });

  /** The reported pair, through the real surface. */
  it('the reveal and the opponent’s cast: the cast shows, the reveal does not', () => {
    const html = render([BODIES.reveal, BODIES.spellHold]);
    expect(html).toContain('stub-spellHold');
    expect(html, 'the reveal must not be painted at the same time').not.toContain('stub-reveal');
  });

  it('…and the reveal is not LOST: the surface says it is waiting', () => {
    expect(render([BODIES.reveal, BODIES.spellHold])).toContain('+1 waiting');
    expect(render(ANNOUNCEMENT_ORDER.map((k) => BODIES[k]))).toContain('+3 waiting');
  });

  it('one announcement alone claims no waiting badge', () => {
    expect(render([BODIES.reveal])).not.toContain('waiting');
  });

  it('nothing queued renders nothing at all', () => {
    expect(render([])).toBe('');
  });

  it('the slot comes from the KIND ROW, never from the component', () => {
    expect(render([BODIES.spellHold])).toContain(
      `announce--${ANNOUNCEMENT_KINDS.spellHold.slot}`,
    );
    expect(render([BODIES.combatHold])).toContain(
      `announce--${ANNOUNCEMENT_KINDS.combatHold.slot}`,
    );
  });
});

// ---------------------------------------------------------------------------
describe('ONE queue, therefore one answer', () => {
  const playView = code(
    readFileSync(fileURLToPath(new URL('../../views/PlayView.tsx', import.meta.url)), 'utf8').replace(
      /\r\n/g,
      '\n',
    ),
  );

  /**
   * The rule the brief made non-negotiable: "queued for display" and "holding
   * the game" must be ONE answer. Two `announcementQueue(` calls in the view
   * that owns both the gate and the board would be two lists that could order
   * differently.
   */
  it('PlayView assembles the queue exactly once', () => {
    expect([...playView.matchAll(/announcementQueue\(/g)]).toHaveLength(1);
  });

  it('the gate is read off the queue, not re-derived from the announcements', () => {
    expect([...playView.matchAll(/announcements\.holdsGame/g)].length).toBeGreaterThanOrEqual(2);
    expect(playView, 'no board may ask whether a single announcement holds').not.toMatch(
      /announcementHolds\(/,
    );
  });

  /**
   * ⚠️ ONE TIMER, AND IT BELONGS TO THE HEAD. Each announcer used to arm its own
   * on creation, so an announcement that was painted over burned its beat unseen
   * and vanished — a silent drop, which is the same defect class as the silence
   * this branch has been fixing.
   */
  it('no announcer arms a timer of its own any more', () => {
    const timers = [...playView.matchAll(/window\.setTimeout\(/g)].length;
    // The AI seat's think timer, the queue's one beat timer, and nothing else
    // that belongs to an announcement.
    expect(playView).toMatch(/if \(headId === null\) return undefined;[\s\S]{0,400}window\.setTimeout\(/);
    expect(playView, 'the spell hold no longer times itself').not.toMatch(
      /window\.setTimeout\(releaseHold/,
    );
    expect(playView, 'nor does the combat beat').not.toMatch(
      /window\.setTimeout\(releaseCombatHold/,
    );
    expect(timers).toBeLessThanOrEqual(3);
  });
});

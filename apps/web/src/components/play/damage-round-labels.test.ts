/**
 * THE TWO DAMAGE ROUNDS HAVE TO LOOK LIKE TWO (§3.143 wave 3 / GAP-F, UX-15).
 *
 * What wave 2 shipped: core stamps every combat-damage event with the step that
 * dealt it (`damageDealt.round`), the fold carries it through as
 * `DamageBeat.round`, `damage-sequence.test.ts` proves the SPLIT is correct, and
 * `.dmg-layer` spaced the two volleys 220ms apart. What it did not ship: any
 * reader of `beat.round` at all. `beatModifiers` never mentioned it and
 * `game-fx.css` contained no `dmg-beat--`/`first-strike` rule. So a first-strike
 * combat drew two identical volleys and the only signal that there had been two
 * was a pause — which is the "I can't see what's happening" complaint, not the
 * fix for it.
 *
 * ⚠️ WHAT THIS FILE CAN AND CANNOT PROVE. The suite has no DOM (root
 * `vitest.config.ts` collects `*.test.ts` with no `environment`), so nothing here
 * runs a layout effect, a `getBoundingClientRect` or a CSS cascade. That means:
 *
 *   - PROVEN behaviourally: the grouping rule, the labels, the closed table's
 *     refusal to name a round it does not know, the class list a beat earns, and
 *     the banner's rendered markup (`DamageRoundLabel` through
 *     `renderToStaticMarkup`).
 *   - PROVEN structurally only: that every modifier the layer can emit has a
 *     rule in `game-fx.css`, and that the layer mounts the banner at all.
 *   - NOT PROVEN AT ALL: that the banner is legible, on top, and in a sensible
 *     place on a real board. That needs a browser and a human. `DamageBench` in
 *     the effects preview drives the real fold through the real layer and is the
 *     place to look (rule 3).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { CombatDamageRound, DamageBeat } from '../../lib/play/damage-sequence.js';
import {
  DAMAGE_ROUND_PRESENTATION,
  DamageRoundLabel,
  beatModifiers,
  damageRoundBanners,
} from './AnimationLayer.js';

function read(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
}

const layerSource = read('./AnimationLayer.tsx');
const gameFxCss = read('./game-fx.css');

/** A beat with everything a test does not care about already filled in. */
function beat(over: Partial<DamageBeat> & Pick<DamageBeat, 'key'>): DamageBeat {
  return {
    kind: 'hit',
    roundIndex: 0,
    round: 'normal',
    from: { where: 'tile', instanceId: 1 },
    to: { where: 'tile', instanceId: 2 },
    amount: 2,
    outcome: 'dealt',
    combat: true,
    lethal: false,
    startMs: 0,
    travelMs: 340,
    impactMs: 260,
    ...over,
  };
}

/** The two-volley combat this whole gap is about, as the fold would emit it. */
function firstStrikeCombat(): readonly DamageBeat[] {
  return [
    beat({ key: '10', roundIndex: 0, round: 'firstStrike', startMs: 0 }),
    beat({ key: '11', roundIndex: 1, round: 'normal', startMs: 820 }),
  ];
}

/* -------------------------------------------------------------------------- */
/* 1. The behaviour Caleb asked for: the two rounds are NAMED                  */
/* -------------------------------------------------------------------------- */

describe('a first-strike combat announces its two rounds by name', () => {
  it('produces one banner per round, with different words', () => {
    const banners = damageRoundBanners(firstStrikeCombat());
    expect(banners.map((b) => b.label)).toEqual(['First-strike damage', 'Combat damage']);
    // The regression this pins: before GAP-F both volleys read identically.
    expect(banners[0]?.label).not.toEqual(banners[1]?.label);
    expect(banners[0]?.modifier).not.toEqual(banners[1]?.modifier);
  });

  it('each banner starts with its round and lasts exactly as long as its damage', () => {
    const banners = damageRoundBanners(firstStrikeCombat());
    expect(banners[0]?.startMs).toBe(0);
    expect(banners[0]?.durationMs).toBe(340 + 260);
    expect(banners[1]?.startMs).toBe(820);
  });

  it('a round with several staggered hits is covered end to end by ONE banner', () => {
    const banners = damageRoundBanners([
      beat({ key: '1', startMs: 0 }),
      beat({ key: '2', startMs: 110 }),
      beat({ key: '3', startMs: 220 }),
    ]);
    expect(banners).toHaveLength(1);
    expect(banners[0]?.durationMs).toBe(220 + 340 + 260);
    // Every beat is remembered, which is how the layer knows not to announce the
    // same round again once its first beat has retired out of the live array.
    expect(banners[0]?.beatKeys).toEqual(['1', '2', '3']);
  });

  it('the banner keys off the round’s LEAD beat, so it is stable and unique', () => {
    const banners = damageRoundBanners(firstStrikeCombat());
    expect(banners.map((b) => b.key)).toEqual(['10', '11']);
  });
});

/* -------------------------------------------------------------------------- */
/* 2. The CLOSED table: an untabulated round REPORTS, it does not guess        */
/* -------------------------------------------------------------------------- */

describe('the round table is closed and refuses to name what it does not know', () => {
  it('damage that belongs to no combat step gets NO banner when it stands alone', () => {
    // A burn spell, a fight, a ping. Captioning it would put words over every
    // Shock in the game, and there is no second volley to tell it apart from.
    expect(damageRoundBanners([beat({ key: '1', round: undefined, combat: false })])).toEqual([]);
  });

  it('a SECOND unmarked round is numbered rather than named', () => {
    // The pre-marker fallback: the fold split the log into two rounds by
    // inference, so there are two volleys on screen and something must say so —
    // but nothing honest can call either of them "first strike".
    const banners = damageRoundBanners([
      beat({ key: '1', round: undefined, roundIndex: 0, startMs: 0 }),
      beat({ key: '2', round: undefined, roundIndex: 1, startMs: 820 }),
    ]);
    expect(banners.map((b) => b.label)).toEqual(['Damage — round 2']);
    expect(banners[0]?.modifier).toBe('');
  });

  it('a round value the table has never heard of is reported, NOT filed under `normal`', () => {
    // The shape of the next failure: core gains a third combat-damage step (or a
    // saved log is replayed from a newer build). Silently painting it as normal
    // damage is a lie about what the player is watching.
    const alien = 'doubleStrike' as CombatDamageRound;
    const banners = damageRoundBanners([
      beat({ key: '1', round: alien, roundIndex: 0 }),
      beat({ key: '2', round: alien, roundIndex: 1, startMs: 820 }),
    ]);
    expect(banners[0]?.label).toBe('Damage — round 2');
    expect(banners[0]?.modifier).toBe('');
    expect(beatModifiers(beat({ key: '1', round: alien }))).not.toContain('round-');
  });

  it('the table is a MAPPED TYPE over core’s union, so a missing row is a build error', () => {
    // The runtime half of that guard: the rows are distinct and non-empty. The
    // totality half is enforced by `{ [R in CombatDamageRound]: … }` — a new core
    // step fails `tsc` here rather than falling through to a default.
    const rows = Object.values(DAMAGE_ROUND_PRESENTATION);
    expect(rows.length).toBeGreaterThan(0);
    expect(new Set(rows.map((r) => r.modifier)).size).toBe(rows.length);
    expect(new Set(rows.map((r) => r.label)).size).toBe(rows.length);
    for (const row of rows) expect(row.label.trim().length).toBeGreaterThan(0);
  });
});

/* -------------------------------------------------------------------------- */
/* 3. The chips wear their round too — and the styling exists for it           */
/* -------------------------------------------------------------------------- */

describe('a beat’s class list carries its round', () => {
  it('a first-strike hit is modified differently from a normal one', () => {
    const fs = beatModifiers(beat({ key: '1', round: 'firstStrike' }));
    const normal = beatModifiers(beat({ key: '2', round: 'normal' }));
    expect(fs).toContain(DAMAGE_ROUND_PRESENTATION.firstStrike.modifier);
    expect(normal).toContain(DAMAGE_ROUND_PRESENTATION.normal.modifier);
    expect(fs).not.toEqual(normal);
  });

  it('the round modifier COMPOSES with lethal/seat rather than replacing them', () => {
    // Lethality is the louder fact and must survive the round tint; the round is
    // still legible beside it. One class list, both facts.
    const mods = beatModifiers(
      beat({ key: '1', round: 'firstStrike', lethal: true, to: { where: 'seat', seat: 'A' } }),
    );
    expect(mods).toContain('lethal');
    expect(mods).toContain('seat');
    expect(mods).toContain('round-first-strike');
  });

  it('EVERY modifier the table can emit has a rule in game-fx.css', () => {
    // The guard that makes adding a round a ROW and not a silent no-op: a new
    // table entry with no stylesheet rule paints nothing, and nothing else here
    // would notice.
    for (const row of Object.values(DAMAGE_ROUND_PRESENTATION)) {
      expect(gameFxCss, `no .dmg-round--${row.modifier} rule`).toContain(`.dmg-round--${row.modifier}`);
    }
    // The one round that must also repaint the chips is the one the two-volley
    // read depends on.
    const fs = DAMAGE_ROUND_PRESENTATION.firstStrike.modifier;
    expect(gameFxCss).toContain(`.dmg-bolt--${fs}`);
    expect(gameFxCss).toContain(`.dmg-impact--${fs}`);
    expect(gameFxCss).toContain(`.vfx-burst--${fs}`);
    // The untabulated case has its own plain treatment rather than inheriting one.
    expect(gameFxCss).toContain('.dmg-round--round-unnamed');
  });

  it('the round tint is a PALETTE override, so lethal/seat/prevented still win their own rules', () => {
    // `--dmg-hot`/`--dmg-ember`/`--dmg-glow` are what every chip, ring and spark
    // already reads. Repainting the volley by overriding them is one block; a
    // second set of `background:` rules would be the fork rule 12 forbids.
    const block = gameFxCss.slice(gameFxCss.indexOf('.dmg-round--round-first-strike,'));
    expect(block).toContain('--dmg-hot:');
    expect(block).toContain('--dmg-ember:');
    expect(block).toContain('--dmg-glow:');
    // …and the glow is a named property rather than the inline orange it was.
    expect(gameFxCss).toContain('box-shadow: 0 0 12px var(--dmg-glow)');
    expect(gameFxCss).not.toContain('box-shadow: 0 0 12px rgb(255 106 43 / 70%)');
  });
});

/* -------------------------------------------------------------------------- */
/* 4. REACH — the banner renders, and the layer mounts it                      */
/* -------------------------------------------------------------------------- */

describe('the banner is rendered, not merely derived (the lesson of waves 1 and 2)', () => {
  const banners = damageRoundBanners(firstStrikeCombat());

  it('puts its words on screen with its round’s modifier and its own schedule', () => {
    const first = banners[0];
    expect(first).toBeDefined();
    if (first === undefined) return;
    const html = renderToStaticMarkup(
      createElement(DamageRoundLabel, { banner: first, onDone: () => undefined }),
    );
    expect(html).toContain('First-strike damage');
    expect(html).toContain('dmg-round--round-first-strike');
    expect(html).toContain('animation-delay:0ms');
    expect(html).toContain(`animation-duration:${first.durationMs}ms`);
  });

  it('an unnamed round renders under its own modifier, never a named round’s', () => {
    const unnamed = damageRoundBanners([
      beat({ key: '1', round: undefined, roundIndex: 0 }),
      beat({ key: '2', round: undefined, roundIndex: 1, startMs: 820 }),
    ])[0];
    expect(unnamed).toBeDefined();
    if (unnamed === undefined) return;
    const html = renderToStaticMarkup(
      createElement(DamageRoundLabel, { banner: unnamed, onDone: () => undefined }),
    );
    expect(html).toContain('dmg-round--round-unnamed');
    expect(html).not.toContain('first-strike');
  });

  it('`DamageLayer` actually mounts the banner — a component nothing renders is nothing', () => {
    // Structural, and it is the assertion that would have caught GAP-F itself:
    // the round data existed for a whole wave with no reader.
    expect(layerSource).toContain('<DamageRoundLabel');
    expect(layerSource).toContain('useRoundBanners(beats)');
    // And the chips say which step they belong to, for a harness or a human
    // reading the DOM.
    expect(layerSource).toContain('data-dmg-step={step}');
  });

  it('`beatModifiers` reads `beat.round` at all', () => {
    // The literal wave-2 defect, pinned: `beatModifiers` mentioned outcome,
    // lethal, seat and kind — and never the round.
    const fn = layerSource.slice(layerSource.indexOf('export function beatModifiers'));
    expect(fn.slice(0, fn.indexOf('\n}'))).toContain('roundModifierOf(beat)');
  });
});

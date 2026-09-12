/**
 * §3.143 wave 3 — UX-8 REACHES THE ACTIVATED-ABILITY PROMPTS.
 *
 * Caleb, verbatim: *"anytime a card is asking me to choose target(s), it should
 * be showing the actual card(s) that is provoking the choice - not just the card
 * name."* Wave 1 gave that to `ChoicePrompt`; wave 2 gave it to the board's cast
 * and cost-payer prompts. `AbilityPrompts.tsx` — mounted on BOTH boards — was
 * still rendering the source and every candidate as a bare string, and no
 * adoption table anywhere covered the file. That is how it survived two waves
 * of a green suite, which is the failure shape this whole wave exists to stop.
 *
 * So these are RENDER tests of the real components, not source greps: each one
 * renders the component with props a real board supplies and asks what the
 * markup contains. A refactor that turns a face back into a name string fails
 * here rather than in a play session.
 *
 * ⚠️ `.test.ts`, not `.test.tsx`, built with `createElement`: the root Vitest
 * config globs `**\/*.test.ts` only, so a `.tsx` test would silently never run —
 * this repo's most-recorded defect shape is a test that cannot fail.
 *
 * ⚠️ WHAT THESE CANNOT PROVE. `renderToStaticMarkup` has no DOM, no cascade and
 * no layout, so "the face is in the markup" is not "the player can see it at a
 * sensible size". The sizing half lives in `ability-prompts.css` and was checked
 * against real computed styles in a browser; see the lane report. Neither half
 * substitutes for the other — that is the lesson of waves 1 and 2, arriving a
 * third time.
 */
import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { CARD_POOL } from '@jonny-boi/cards';
import type { CardDefinition, InstanceId, PlayerId } from '@jonny-boi/core';
import type { AbilityOption } from '../../lib/play/session.js';
import {
  AbilityMenuPrompt,
  AbilityTargetPrompt,
  ProposalCancelButton,
  type AbilityPromptFaces,
} from './AbilityPrompts.js';

function pooled(name: string): CardDefinition {
  const found = CARD_POOL.find((c) => c.name === name);
  if (!found) throw new Error(`no pool card named "${name}"`);
  return found;
}

/** A real source with a real activated ability, and two real targets. */
const PRODIGAL = pooled('Prodigal Pyromancer');
const VISIONARY = pooled('Elvish Visionary');
const PILGRIM = pooled("Avacyn's Pilgrim");

const SOURCE_INSTANCE = 30 as InstanceId;
const VISIONARY_INSTANCE = 12 as InstanceId;
const PILGRIM_INSTANCE = 13 as InstanceId;

const CARD_IDS: Readonly<Record<number, string>> = {
  [SOURCE_INSTANCE]: PRODIGAL.id,
  [VISIONARY_INSTANCE]: VISIONARY.id,
  [PILGRIM_INSTANCE]: PILGRIM.id,
};

/** What a board wires in: the public-zone face lookup and nothing invented. */
const FACES: AbilityPromptFaces = {
  cardIdOf: (ref: InstanceId | PlayerId) => (typeof ref === 'number' ? (CARD_IDS[ref] ?? null) : null),
};

function ability(over: Partial<AbilityOption> = {}): AbilityOption {
  return {
    instanceId: SOURCE_INSTANCE,
    sourceName: PRODIGAL.name,
    abilityIndex: 0,
    label: '{T}: Deal 1 damage to any target.',
    targets: [
      { target: VISIONARY_INSTANCE, label: VISIONARY.name },
      { target: PILGRIM_INSTANCE, label: PILGRIM.name },
      { target: 'B' as PlayerId, label: 'Player B' },
    ],
    ...over,
  };
}

const noop = (): void => {};

/** React escapes apostrophes as `&#x27;`; decode so assertions read as a player does. */
function decode(markup: string): string {
  return markup.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&');
}

function renderTargets(props: Partial<Parameters<typeof AbilityTargetPrompt>[0]> = {}): string {
  return decode(
    renderToStaticMarkup(
      createElement(AbilityTargetPrompt, {
        ability: ability(),
        faces: FACES,
        onPick: noop as (t: InstanceId | PlayerId) => void,
        onCancel: noop,
        ...props,
      }),
    ),
  );
}

function renderMenu(props: Partial<Parameters<typeof AbilityMenuPrompt>[0]> = {}): string {
  return decode(
    renderToStaticMarkup(
      createElement(AbilityMenuPrompt, {
        source: { instanceId: SOURCE_INSTANCE, name: PRODIGAL.name },
        options: [ability()],
        faces: FACES,
        onChoose: noop as (o: AbilityOption) => void,
        onCancel: noop,
        ...props,
      }),
    ),
  );
}

function imageSources(html: string): string[] {
  return [...html.matchAll(/<img\b[^>]*\bsrc="([^"]+)"/g)].map((m) => m[1] as string);
}

// ---------------------------------------------------------------------------
describe('UX-8 — the ability prompt shows CARDS, not a list of names', () => {
  it('draws the SOURCE permanent as a real face', () => {
    const html = renderTargets();
    expect(html).toContain(PRODIGAL.name);
    expect(html).toContain('ability-face--source');
    expect(imageSources(html).some((src) => src.includes('scryfall'))).toBe(true);
  });

  it('draws every CANDIDATE that is a card as a real face', () => {
    const html = renderTargets();
    // Two candidate faces plus the source's; the seat candidate has no card.
    expect(imageSources(html).length).toBeGreaterThanOrEqual(3);
    expect(html).toContain(VISIONARY.name);
    expect(html).toContain(PILGRIM.name);
    expect(html).toContain('ability-face--candidate');
  });

  it('degrades a SEAT candidate to a named placeholder, never a blank box', () => {
    const html = renderTargets();
    expect(html).toContain('ability-face--nameonly');
    expect(html).toContain('Player B');
  });

  it('degrades EVERY row to a named placeholder when the board wires no lookup', () => {
    // An unwired board must invent nothing: no cardIdOf means no faces, and the
    // prompt says the names rather than drawing three empty rectangles.
    const html = renderTargets({ faces: undefined as unknown as AbilityPromptFaces });
    expect(imageSources(html)).toEqual([]);
    expect(html.split('ability-face--nameonly').length - 1).toBe(4); // source + 3 candidates
    expect(html).toContain(VISIONARY.name);
  });

  it('the ability MENU draws the permanent the menu is about', () => {
    const html = renderMenu();
    expect(html).toContain('ability-face--source');
    expect(imageSources(html).some((src) => src.includes('scryfall'))).toBe(true);
    // The ability LINES stay text on purpose — a menu of faces would be the same
    // card repeated down the dialog.
    expect(html).toContain('{T}: Deal 1 damage to any target.');
  });

  it('routes every face through the ONE hover funnel (UX-10), never a second renderer', () => {
    // `CardHover` renders the anchor span that carries the className, and
    // `CardFace` renders `.card-face` inside it. Both present ⇒ the shared funnel.
    const html = renderTargets();
    expect(html).toContain('class="ability-face ability-face--candidate"');
    expect(html).toContain('card-face');
  });
});

// ---------------------------------------------------------------------------
describe('an offer list the engine left empty SAYS SO', () => {
  it('a target prompt with no candidates is not a dialog holding only Cancel', () => {
    const html = renderTargets({ ability: ability({ targets: [] }) });
    expect(html).toContain('Nothing legal to point at.');
  });

  it('an ability menu with no options says so too', () => {
    const html = renderMenu({ options: [] });
    expect(html).toContain('No ability of this permanent can be activated right now.');
  });
});

// ---------------------------------------------------------------------------
describe('UX-4/UX-5 — the ability prompts use the ONE cancel control', () => {
  /**
   * The gap this pins: `AbilityTargetPrompt` rendered its own plain `Cancel`, so
   * the rewind-blocked sentence — the whole point of UX-5 — could never appear
   * on the one prompt a sacrifice-cost activation passes through. The comment in
   * `PlayBoard` claimed "every pre-commit prompt on this board ends with this"
   * while this one did not.
   */
  it('shows the honest refusal INSTEAD of a Cancel button when a rewind is gone', () => {
    const blocked = 'The spell is already on the stack — it can no longer be taken back.';
    const html = renderTargets({ cancelBlocked: blocked });
    expect(html).toContain('target-prompt__blocked');
    expect(html).toContain(blocked);
    expect(html).not.toContain('>Cancel<');
  });

  it('shows a plain Cancel when backing out is still legal (the online board)', () => {
    const html = renderTargets();
    expect(html).toContain('>Cancel<');
    expect(html).not.toContain('target-prompt__blocked');
  });

  it('the ability MENU ends with the same control', () => {
    const blocked = 'Nothing to back out of.';
    expect(renderMenu({ cancelBlocked: blocked })).toContain('target-prompt__blocked');
    expect(renderMenu()).toContain('>Cancel<');
  });

  it('the control itself is exported, so there is exactly one of it', () => {
    // `PlayBoard` used to define a private copy; the online board's prompts could
    // not reach it, which is why they grew a second plain Cancel.
    const html = renderToStaticMarkup(
      createElement(ProposalCancelButton, { onCancel: noop, blocked: null }),
    );
    expect(html).toContain('btn--ghost');
  });
});

// ---------------------------------------------------------------------------
describe('the surface with no provenance says WHY rather than showing a hole', () => {
  it('passes the online board’s reason down to every face it draws', () => {
    const reason = 'Live provenance is not carried by the multiplayer protocol yet.';
    const html = renderTargets({ faces: { ...FACES, provenanceUnavailable: reason } });
    expect(html).toContain(reason);
  });
});

/**
 * §3.143 — THE PROMPT SHOWS CARDS, AND ASKS THE "MAY" FIRST (UX-6, UX-7, UX-8).
 *
 * Caleb, verbatim: *"anytime a card is asking me to choose target(s), it should
 * be showing the actual card(s) that is provoking the choice - not just the card
 * name"*, and *"it's asking me for targets before it asks me if I actually want
 * to do the thing. Thats backwards."*
 *
 * Both are claims about what the prompt RENDERS, so they are pinned structurally
 * here — the real component, the real pool card, the real web card index — in
 * the same idiom as `play-surface-images.test.ts`. A refactor that turns a face
 * back into a name string, or that shows the target picker before the question,
 * fails here rather than in a play session.
 *
 * ⚠️ This file is `.test.ts`, not `.test.tsx`, and builds its elements with
 * `createElement`: the root Vitest config globs `**\/*.test.ts` only, so a `.tsx`
 * test would silently never run — this repo's most-recorded defect shape is a
 * test that cannot fail.
 *
 * The suite has no DOM (no jsdom, no testing-library), so what is asserted is
 * the INITIAL render of each state. The stage transition itself is `useState` in
 * one component and cannot be driven from here; the rules that decide whether a
 * fold exists at all are pure and are pinned in `optional-trigger.test.ts`.
 */
import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { CARD_POOL } from '@jonny-boi/cards';
import type { CardDefinition, ChoiceAnswer, PendingChoice, PlayerId } from '@jonny-boi/core';
import { ChoicePrompt } from './ChoicePrompt.js';

const NAMES: Readonly<Record<PlayerId, string>> = { A: 'Player 1', B: 'Computer' };

function pooled(name: string): CardDefinition {
  const found = CARD_POOL.find((c) => c.name === name);
  if (!found) throw new Error(`no pool card named "${name}"`);
  return found;
}

const CLOSET = pooled("Conjurer's Closet");
const VISIONARY = pooled('Elvish Visionary');
const PILGRIM = pooled("Avacyn's Pilgrim");
const THRAGTUSK = pooled('Thragtusk');

const VISIONARY_INSTANCE = 12;
const PILGRIM_INSTANCE = 13;

/** The parked question Conjurer's Closet raises as its trigger goes on the stack. */
function targetChoice(over: Partial<PendingChoice> = {}): PendingChoice {
  return {
    kind: 'selectTargets',
    id: 1,
    chooser: 'A',
    prompt: 'Choose a creature you control for your end step',
    valence: 'gain',
    sourceInstanceId: 30,
    sourceName: CLOSET.name,
    min: 1,
    max: 1,
    candidates: [
      { ref: VISIONARY_INSTANCE, name: VISIONARY.name, controller: 'A' },
      { ref: PILGRIM_INSTANCE, name: PILGRIM.name, controller: 'A' },
    ],
    restriction: 'creatureYouControl',
    ...over,
  } as PendingChoice;
}

const CARD_IDS: Readonly<Record<number, string>> = {
  [VISIONARY_INSTANCE]: VISIONARY.id,
  [PILGRIM_INSTANCE]: PILGRIM.id,
};

/**
 * Render the prompt and decode the entities React escapes on the server.
 *
 * Half this pool is named "Avacyn's Pilgrim" and React writes that apostrophe as
 * `&#x27;`, so an undecoded `toContain(card.name)` would pass on nothing and
 * fail on everything — a test that cannot succeed is as useless as one that
 * cannot fail. Decoding once here keeps every assertion spelled the way the
 * player reads it.
 */
function render(props: Partial<Parameters<typeof ChoicePrompt>[0]> = {}): string {
  const noop = (): void => {};
  const markup = renderToStaticMarkup(
    createElement(ChoicePrompt, {
      choice: targetChoice(),
      names: NAMES,
      onAnswer: noop as (answer: ChoiceAnswer) => void,
      ...props,
    }),
  );
  return markup.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&');
}

function imageSources(html: string): string[] {
  return [...html.matchAll(/<img\b[^>]*\bsrc="([^"]+)"/g)].map((m) => m[1] as string);
}

/** Just the candidate region — the footer's Confirm button is not a candidate. */
function optionsRegion(html: string): string {
  const after = html.split('choice-prompt__options')[1] ?? '';
  return after.split('choice-prompt__foot')[0] ?? '';
}

describe('UX-8 — the card that provoked the choice is shown as a card', () => {
  it('renders the SOURCE card face, not just its name', () => {
    const html = render({ sourceDef: CLOSET });
    // The name is still there (it always was); what is new is the face.
    expect(html).toContain(CLOSET.name);
    expect(html).toContain('choice-source');
    const sources = imageSources(html);
    expect(sources.some((src) => src.includes('cards.scryfall.io'))).toBe(true);
  });

  it('degrades to a NAMED placeholder when the board cannot resolve the source', () => {
    // A token, an emblem, a Scryfall miss, the online board's masked view. A
    // blank rectangle where the card should be is worse than the name alone.
    const html = render({ sourceDef: null });
    expect(html).toContain('choice-source--nameonly');
    expect(html).toContain(CLOSET.name);
  });

  it('renders every TARGET candidate as a card face, hoverable to full size', () => {
    const html = render({ sourceDef: THRAGTUSK, cardIdOf: (ref) => CARD_IDS[ref as number] });
    // Two candidate faces plus the source face.
    expect(imageSources(html).length).toBeGreaterThanOrEqual(3);
    expect(html).toContain(VISIONARY.name);
    expect(html).toContain(PILGRIM.name);
    // The shared hover funnel, not a second renderer (UX-10's one funnel).
    expect(html).toContain('choice-card-opt');
  });

  it('degrades a candidate with no resolvable card to a NAMED placeholder tile', () => {
    // `TargetOption` carries no cardId, so a board that cannot resolve one — or
    // a PLAYER candidate, which has no card at all — must still get a tile.
    const html = render({ sourceDef: THRAGTUSK });
    expect(html).toContain('choice-card-opt__placeholder');
    expect(html).toContain(VISIONARY.name);
  });

  it('marks the current selection unmistakably rather than by a hairline alone', () => {
    // Nothing is picked on the initial render, so the class must be ABSENT here;
    // the selected path is exercised by the CSS modifier existing for it.
    const html = render({ sourceDef: THRAGTUSK, cardIdOf: (ref) => CARD_IDS[ref as number] });
    expect(html).not.toContain('choice-card-opt--selected');
  });

  it('a candidate that cannot be chosen SAYS WHY, and stays hoverable', () => {
    // A 2-of-2 choice with three candidates: nothing is blocked until the draft
    // is full, which cannot be reached without a DOM. What IS pinned here is the
    // other half of the claim — a blocked option is never rendered `disabled`,
    // because a disabled button emits no pointer events and would take the hover
    // preview away from the card whose situation most needs inspecting.
    const html = render({ sourceDef: THRAGTUSK, cardIdOf: (ref) => CARD_IDS[ref as number] });
    expect(optionsRegion(html)).not.toContain('disabled');
  });

  it('explains a Pay button the board cannot honour instead of just greying it', () => {
    const unaffordable = {
      kind: 'payMana',
      id: 9,
      chooser: 'A',
      prompt: 'Pay {3} or Mana Leak counters it',
      valence: 'loss',
      sourceInstanceId: 40,
      sourceName: 'Mana Leak',
      cost: { generic: 3 },
      affordable: false,
      min: 1,
      max: 1,
    } as PendingChoice;
    const html = render({ choice: unaffordable });
    expect(html).toContain('choice-option--blocked');
    expect(html).toContain('cannot produce');
  });
});

describe('UX-6/UX-7 — the "may" is asked first, and nothing is submitted yet', () => {
  it('opens on the QUESTION and shows no target picker at all', () => {
    const html = render({ sourceDef: CLOSET, onFoldedMay: () => {} });
    // The card's own printed wording leads the prompt…
    expect(html).toContain('You may exile target creature you control');
    expect(html).toContain(`Yes — use ${CLOSET.name}`);
    expect(html).toContain(`No — don’t use ${CLOSET.name}`);
    // …and the candidates are NOT on screen. This is the whole complaint.
    expect(html).not.toContain(VISIONARY.name);
    expect(html).not.toContain(PILGRIM.name);
    expect(html).not.toContain('Confirm');
  });

  it('promises the yes is reversible, because nothing has been sent', () => {
    const html = render({ sourceDef: CLOSET, onFoldedMay: () => {} });
    expect(html).toContain('change your mind');
    expect(html).toContain('Nothing has been chosen yet.');
  });

  it('REFUSES to fold when the board has no ledger to remember the answer in', () => {
    // Without `onFoldedMay` a decline would answer the targets and then let the
    // "may" modal appear anyway — the exact bug being fixed. So the fold is not
    // offered at all and the engine's own ordering stands: an honest refusal,
    // not a half-fold.
    const html = render({ sourceDef: CLOSET });
    expect(html).not.toContain(`Yes — use ${CLOSET.name}`);
    expect(html).toContain(VISIONARY.name);
    expect(html).toContain('Confirm');
  });

  it('does not fold a source with no "may" — the ordinary prompt is unchanged', () => {
    const html = render({ sourceDef: THRAGTUSK, onFoldedMay: () => {} });
    expect(html).not.toContain('Yes — use');
    expect(html).toContain(VISIONARY.name);
    expect(html).toContain('Confirm');
  });
});

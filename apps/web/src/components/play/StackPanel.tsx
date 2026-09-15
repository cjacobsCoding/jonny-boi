import type { CSSProperties, ReactElement } from 'react';
import type { InstanceId, PlayerId } from '@jonny-boi/core';
import { CardHover } from '../CardHover.js';
import { PlayCard } from './PlayCard.js';
import { getCard } from '../../lib/cards.js';
import { STACK_PANEL_CONFIG } from '../../lib/play/play-config.js';
import {
  DEFAULT_STACK_PLACEMENT,
  STACK_PLACEMENT_TABLE,
  stackFaceGeometry,
  stackRows,
  type StackEntry,
  type StackPlacement,
  type StackRow,
} from '../../lib/play/stack-view.js';
import { CardReferenceList } from './CardReferences.js';
import './stack-panel.css';

/**
 * THE STACK, SHOWING REAL CARDS (UX-1 / UX-2, docs/MTGA-UX-OVERHAUL.md §1).
 *
 * Reported verbatim: *"I cant see whats on the stack at any given moment but I
 * should be able to easily see cards on the stack - and not just card names -
 * just like MTGA."* This panel was four text spans per row; it is now a fan of
 * real card faces, top-first, each saying in words when it resolves.
 *
 * **This component is a THIN RENDERER on purpose.** Ordering, labelling, which
 * face a row shows, and how a target is described are decided in the pure,
 * unit-tested `lib/play/stack-view.ts` and arrive here already settled. The only
 * judgements made in this file are DOM ones.
 *
 * ⚠️ IT RENDERS NO CARD OF ITS OWN. The face is {@link PlayCard} and the
 * magnifier is {@link CardHover} — the app's existing card renderer and its
 * existing hover funnel (spec §2.4: "one component with one props contract,
 * adopted by every site — not a sixth renderer"). That is also how the panel
 * inherits, rather than re-derives, two hard-won behaviours: play-surface images
 * load EAGERLY (see the PlayCard doc comment and `play-surface-images.test.ts`
 * — a lazy face on the play surface stays blank until a hover repaints it), and
 * a card with no pool entry or no art degrades to a NAMED plate rather than a
 * broken image or a blank rectangle.
 */
export function StackPanel({
  stack,
  names,
  nameOf,
  faceOf,
  viewer,
  placement = DEFAULT_STACK_PLACEMENT,
}: {
  /**
   * Top-first (the object that resolves NEXT is index 0) — the order
   * `stackEntries` produces and both board adapters already supply.
   */
  readonly stack: readonly StackEntry[];
  readonly names: Readonly<Record<PlayerId, string>>;
  /** Name a targeted instance. Total: unknown ids degrade to a readable id. */
  readonly nameOf: (id: InstanceId) => string;
  /**
   * Face a targeted instance, so hovering a target shows the card it points at.
   * Optional: without it, target rows carry names only — honest, never a
   * guessed preview.
   */
  readonly faceOf?: (id: InstanceId) => string | null;
  /**
   * Whose screen this is, so an OPPONENT's object is marked as theirs rather
   * than merely captioned with their name — the first fact a player needs when
   * something they did not cast appears (UX-16 leans on this panel). Omitted:
   * no marking, which is honest.
   */
  readonly viewer?: PlayerId;
  /** Where the panel is drawn; see `STACK_PLACEMENT_TABLE`. */
  readonly placement?: StackPlacement;
}): ReactElement | null {
  // An empty stack renders NOTHING, not an empty box: `board-fit.css` keys the
  // centre column's width on `:has(.stack-panel)`, so a placeholder here would
  // permanently steal half that column from the game log.
  if (stack.length === 0) return null;

  const rows = stackRows(stack, {
    playerNames: names,
    nameOf,
    faceOf,
    viewer,
    // `lib/cards.ts` is the app's ONE card-data funnel (the same one `PlayCard`
    // and `CardHover` resolve art through), so a spell's rules text is read from
    // there rather than carried down through every board adapter.
    oracleOf: oracleTextOf,
  });
  const geometry = stackFaceGeometry(rows.length);
  // The config is the single source for the fan's geometry and the CSS reads it
  // from here, so `stack-panel.css` contains no card size, no overlap fraction
  // and no duration of its own to drift from `STACK_PANEL_CONFIG`.
  const geometryStyle = {
    '--stack-card-w': `${geometry.cardWidthPx}px`,
    '--stack-card-h': `${geometry.cardHeightPx}px`,
    '--stack-overlap': String(STACK_PANEL_CONFIG.overlapFraction),
    '--stack-top-lift': `${STACK_PANEL_CONFIG.topLiftPx}px`,
    '--stack-enter-ms': `${STACK_PANEL_CONFIG.enterMs}ms`,
  } as CSSProperties;

  const className = [
    'stack-panel',
    STACK_PLACEMENT_TABLE[placement].className,
    geometry.condensed ? 'stack-panel--condensed' : '',
  ]
    .filter((part) => part !== '')
    .join(' ');

  return (
    <aside className={className} style={geometryStyle} aria-label="The stack">
      <div className="stack-panel__title">
        Stack <span className="stack-panel__count">{rows.length}</span>
      </div>
      <ol className="stack-panel__rows">
        {rows.map((row) => (
          <StackRowView key={row.instanceId} row={row} />
        ))}
      </ol>
    </aside>
  );
}

/**
 * The id handed to {@link PlayCard} for a row with no face.
 *
 * The empty id resolves to no card, which is precisely the branch `PlayCard`
 * documents for a token or a Scryfall miss: it paints its named fallback plate.
 * Routing the no-face case through the SAME renderer is what guarantees the two
 * degrade identically — a second placeholder written here would be a second
 * answer to "what does a faceless card look like".
 */
const NO_FACE_CARD_ID = '';

/**
 * A card's printed rules text, or `null` when the pool has no record of it.
 *
 * A card the app cannot resolve is a real state (a token, a Scryfall miss, a
 * card added by deck import that failed to compile). It prints no text rather
 * than a placeholder sentence — the row still shows the name, the kind and the
 * targets, which is honest about what is known.
 */
function oracleTextOf(cardId: string): string | null {
  return getCard(cardId)?.oracleText ?? null;
}

function StackRowView({ row }: { readonly row: StackRow }): ReactElement {
  return (
    <li
      className={`stack-row${row.isTop ? ' stack-row--top' : ''}${
        row.isOpponents ? ' stack-row--opponents' : ''
      }`}
    >
      <CardHover cardId={row.faceCardId} className="stack-row__face">
        {/*
          tabIndex makes the face a focus target, which is what gives the
          KEYBOARD the same magnified preview the mouse gets: CardHover's
          `onFocus` is on its wrapping span and React's focus events bubble, so
          focusing this div opens the same panel a hover would. CardHover needs
          no change for it.
        */}
        <div className="stack-row__face-inner" tabIndex={0} aria-label={`${row.title}, ${row.resolutionLabel}`}>
          <PlayCard cardId={row.faceCardId ?? NO_FACE_CARD_ID} name={row.title} face="full" />
        </div>
      </CardHover>

      <div className="stack-row__body">
        <div className="stack-row__order">{row.resolutionLabel}</div>
        <div className="stack-row__title">{row.title}</div>
        <div className="stack-row__meta">
          <span className="stack-row__kind">{row.kindLabel}</span>
          <span className="stack-row__ctrl">{row.controllerName}</span>
        </div>
        {/*
          Said in words as well as painted, for the same reason "Resolves next"
          is: a colour is a convention a player has to be taught, and this is the
          fact they most need when something they did not cast appears.
        */}
        {row.isOpponents && <div className="stack-row__whose">Opponent&rsquo;s</div>}
        {row.detail !== null && <div className="stack-row__detail">{row.detail}</div>}
        {/* The empty case is the LIST's decision, not this panel's — see
            `CardReferenceList`, which the hold and the forced-choice banner also
            mount, so all three fall silent identically. */}
        <CardReferenceList targets={row.targets} presentation="inline" className="stack-row__targets" />
      </div>
    </li>
  );
}


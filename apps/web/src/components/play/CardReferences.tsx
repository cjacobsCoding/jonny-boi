/**
 * ONE WAY TO SHOW WHAT A GAME OBJECT IS POINTING AT.
 *
 * Three surfaces ask the same question and must not answer it three ways:
 *
 *  - the STACK PANEL — *"what is this spell aimed at?"* (UX-1, already shipped;
 *    `StackTargetRow` lived inside `StackPanel.tsx` and this is that component,
 *    lifted rather than copied);
 *  - the OPPONENT-SPELL HOLD (UX-16) — Caleb, 2026-09-14: *"When the computer
 *    plays Doom Blade when Im playing them, it does not show me clearly what the
 *    target is when it displays on screen - it should show their target(s) for
 *    things along with the card they are casting."* A removal spell announcing
 *    itself without saying what it kills withholds the one fact that matters;
 *  - the FORCED-CHOICE BANNER (`forced-choice.ts`) — *"it should show that
 *    choice being made so the player understands what has happened."*
 *
 * Rule 3: two places that answer one question will eventually answer it
 * differently, and the bug will be attributed to neither. The DATA is
 * `stack-view.ts`'s {@link StackTargetView} — built by its `targetView`, which
 * is also the only place that decides seat-vs-instance — and the KINDS are its
 * closed {@link STACK_TARGET_KINDS_TABLE}. Nothing here re-derives either.
 *
 * ## Hidden information
 * Nothing in this file reads the game state. A caller hands it views built from
 * whatever it can already see — on the online board that is the MASKED view —
 * and a name it could not resolve arrives as the session's own readable
 * placeholder. There is no lookup here that could reach past a mask.
 */
import type { ReactElement, ReactNode } from 'react';
import {
  STACK_TARGET_KINDS_TABLE,
  TARGET_ARROW,
  type StackTargetView,
} from '../../lib/play/stack-view.js';
import { CardHover } from '../CardHover.js';
import { PlayCard } from './PlayCard.js';
import './card-references.css';

/**
 * HOW MUCH OF THE REFERENCED CARD TO DRAW. CLOSED — a presentation outside this
 * table is not a presentation.
 */
export const CARD_REFERENCE_PRESENTATIONS = ['inline', 'face'] as const;
export type CardReferencePresentation = (typeof CARD_REFERENCE_PRESENTATIONS)[number];

/** What one presentation does differently. */
export interface CardReferencePresentationRow {
  /**
   * Draw the actual card image, not just its name.
   *
   * §0 of `docs/MTGA-UX-OVERHAUL.md` is explicit — *"anytime a card is asking me
   * to choose target(s), it should be showing the actual card(s) that is
   * provoking the choice - not just the card name"* — and an ANNOUNCEMENT is
   * under the same requirement. The stack panel stays `inline` because it is a
   * dense list that already draws the spell's own face beside every row, and a
   * second face per target would push the stack off the board it is describing.
   */
  readonly drawsFace: boolean;
  /** Why this row is what it is. */
  readonly why: string;
}

export const CARD_REFERENCE_PRESENTATIONS_TABLE: Readonly<
  Record<CardReferencePresentation, CardReferencePresentationRow>
> = Object.freeze({
  inline: Object.freeze({
    drawsFace: false,
    why: 'The stack panel is a dense list beside the board; it already draws each object’s own face, and the target is one line under it, hoverable for the picture.',
  }),
  face: Object.freeze({
    drawsFace: true,
    why: 'An announcement has one job and the room to do it: the card being targeted or chosen is shown as a card, because a name string is exactly what the reports say is not enough.',
  }),
});

/**
 * ONE reference, as a relationship.
 *
 * Deliberately one line (or one face) per reference with a direction glyph,
 * never a comma-joined string of names: *"→ Grizzly Bears"* reads as *this is
 * aimed at that creature*. The glyph is decorative and marked `aria-hidden`;
 * {@link STACK_TARGET_KINDS_TABLE}'s `screenReaderLabel` carries the meaning.
 *
 * A PLAYER is not a card and gets no face and no hover — asking the hover funnel
 * to preview seat "A" would open an empty panel. That is the table's
 * `hasFace: false` row, not an `if` written here.
 */
export function CardReference({
  target,
  presentation,
}: {
  readonly target: StackTargetView;
  readonly presentation: CardReferencePresentation;
}): ReactElement {
  const kindRow = STACK_TARGET_KINDS_TABLE[target.kind];
  const drawsFace = CARD_REFERENCE_PRESENTATIONS_TABLE[presentation].drawsFace && kindRow.hasFace;
  const label: ReactNode = (
    <>
      <span className="stack-target__arrow" aria-hidden="true">
        {TARGET_ARROW}
      </span>
      {drawsFace && (
        /* `cardId` may be null for a token or a Scryfall miss: `PlayCard` draws
           its named placeholder, which is the SAME placeholder every other
           faceless card on this surface gets. Never a guessed face. */
        <PlayCard cardId={target.cardId ?? ''} name={target.name} face="full" />
      )}
      <span className="stack-target__name">{target.name}</span>
    </>
  );
  return (
    <li
      className={`stack-target stack-target--${target.kind} stack-target--${presentation}`}
      data-target-ref={String(target.ref)}
    >
      <span className="stack-target__sr">{kindRow.screenReaderLabel}</span>
      {kindRow.hasFace ? (
        <CardHover cardId={target.cardId} className="stack-target__hover">
          {label}
        </CardHover>
      ) : (
        label
      )}
    </li>
  );
}

/**
 * The list of references, or NOTHING AT ALL when there are none.
 *
 * ⚠️ The empty case is a rendered decision, not an oversight: a spell with no
 * targets must say nothing rather than paint an empty row with a dangling arrow.
 * Returning `null` here is what makes every mount safe to write as an
 * unconditional `<CardReferenceList …/>`, so no caller can forget the check and
 * no caller can implement it differently.
 */
export function CardReferenceList({
  targets,
  presentation,
  label,
  className,
}: {
  readonly targets: readonly StackTargetView[];
  readonly presentation: CardReferencePresentation;
  /** The words before the list ("Targeting", "Chose"). */
  readonly label?: string;
  readonly className?: string;
}): ReactElement | null {
  if (targets.length === 0) return null;
  return (
    <div className={`card-refs card-refs--${presentation}${className ? ` ${className}` : ''}`}>
      {label !== undefined && <span className="card-refs__label">{label}</span>}
      <ul className="card-refs__list">
        {targets.map((target, i) => (
          <CardReference
            key={`${target.kind}:${String(target.ref)}:${i}`}
            target={target}
            presentation={presentation}
          />
        ))}
      </ul>
    </div>
  );
}

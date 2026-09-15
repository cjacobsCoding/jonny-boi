/**
 * §3.143 / UX-16 — AN OPPONENT'S SPELL, HELD ON SCREEN.
 *
 * Caleb: *"when an opponent casts a sorcery or instant card, I need to be able
 * to see it and inspect the card before it goes off - even if I have no
 * instant-speed things I could do in response … Right now, they just happen
 * invisibly and I have no idea why things are happening."*
 *
 * The card is drawn by lane P's `CardFace` at full size and wrapped in the ONE
 * hover funnel, so the held card is inspected exactly the way every other card
 * on this surface is. Moving the pointer onto it extends the hold (bounded by
 * `pointerHoldMs`); "Keep looking" adds one `extendMs`; "Let it resolve" ends
 * it now — so it is never a click-through tax on a player who does not want it.
 *
 * ## ITS OWN MODULE — the contract `EffectsPreview.tsx` filed, now paid
 *
 * It was a private function inside `PlayBoard.tsx`, and `EffectsPreview.tsx`
 * wrote the cost down at the time: the spell-hold BENCH could not draw the real
 * announce card because *"importing it would pull the whole play board into the
 * About page's chunk"*, so the bench mounts the pieces and reports the
 * extraction as owed. `CombatHoldBanner` and `ForcedChoiceBanner` both record
 * the same lesson from the other direction (§3.143 GAP-20: a component living
 * inside `PlayBoard.tsx` is a component the online board does not get).
 *
 * The extraction is what makes `AnnouncementSurface` possible at all: the
 * surface's renderer map is a mapped type over every announcement kind, so a
 * board cannot supply three of four renderers, and a spell-hold renderer that
 * only one board could construct would have forced the map open.
 */
import type { ReactElement } from 'react';
import type { CharacteristicExplanation } from '@jonny-boi/core';
import { HOLD_KINDS, type SpellHold } from '../../lib/play/spell-hold.js';
import type { StackTargetView } from '../../lib/play/stack-view.js';
import { CardFace } from './CardFace.js';
import { CardHover } from '../CardHover.js';
import { CardReferenceList } from './CardReferences.js';
/** Its own appearance travels with it — the reason `CombatHoldBanner` records. */
import './board-scene.css';

export function SpellHoldCard({
  hold,
  name,
  cardId,
  explanation,
  targets,
  opponentName,
  onPointer,
  onExtend,
  onRelease,
}: {
  hold: SpellHold;
  name: string;
  cardId: string | null;
  /** Core's characteristic breakdown for the held spell (§3.143 / UX-17). */
  explanation: CharacteristicExplanation | undefined;
  /**
   * WHAT IT IS AIMED AT. Caleb, 2026-09-14: *"When the computer plays Doom Blade
   * when Im playing them, it does not show me clearly what the target is when it
   * displays on screen - it should show their target(s) for things along with
   * the card they are casting."*
   *
   * Resolved by the board from the SAME `stackEntries` facts the stack panel
   * reads, through `stack-view.targetView` — so "what is this pointing at?" has
   * one answer here, in the panel, and in the forced-choice banner. Empty for a
   * spell that targets nothing, which renders nothing at all
   * (`CardReferenceList` owns that decision for all three mounts).
   */
  targets: readonly StackTargetView[];
  opponentName: string;
  onPointer?: (over: boolean) => void;
  onExtend?: () => void;
  onRelease?: () => void;
}): ReactElement {
  return (
    <div
      className="spell-hold"
      /*
       * ⚠️ `status`, NOT `dialog` (§3.143 wave 3). This card ANNOUNCES — it tells
       * you what the opponent just cast and lets you look at it — and it is
       * dismissed by a timer. A `dialog` role promises modality and a focus trap
       * that this has never had, and it told every "is a question on screen?"
       * probe that one was: `verify-game-resume.mjs` matches `[role="dialog"]`
       * to decide whether the game parked a choice, saw THIS, announced "stopped
       * ON A PARKED CHOICE", reloaded, and failed because a 2.4-second
       * announcement is not something a reload can bring back. A live region is
       * what an announcement is, and it is announced once, on appearance.
       */
      role="status"
      aria-live="polite"
      aria-label={`${opponentName} is casting ${name}`}
      onPointerEnter={() => onPointer?.(true)}
      onPointerLeave={() => onPointer?.(false)}
    >
      {/* The verb comes from the KIND table, not from an `if`: "is casting" and
          "is activating" are different facts and a third kind is a row. */}
      <span className="spell-hold__who">
        {opponentName} {HOLD_KINDS[hold.kind].announce}:
      </span>
      {/* A ROW, not a column, and that is a fix rather than a preference: with
          the target stacked underneath, a real capture showed the target card
          clipped by the bottom of the viewport and BOTH buttons off screen. The
          spell and what it is aimed at are one picture and belong side by side —
          which is also how a table reads it. `wrap` returns them to a column on
          a narrow window, where there is height to spare. */}
      <div className="spell-hold__body">
        {/* The spell and its own name stay together. Photographed once with the
            name below the WHOLE body, the panel read "… Grizzly Bears / Doom
            Blade", which invites exactly the misreading the announcement exists
            to prevent. */}
        <div className="spell-hold__subject">
          <CardHover cardId={cardId}>
            <CardFace size="full" cardId={cardId} name={name} explanation={explanation} />
          </CardHover>
          <span className="spell-hold__name">{name}</span>
        </div>
        {/* Shown as CARD FACES, not a name string: §0 is explicit that a target
            must be "the actual card(s)". The list renders nothing when the spell
            targets nothing, and names a PLAYER target in words because a seat is
            not a card (`STACK_TARGET_KINDS_TABLE.player.hasFace`). */}
        <CardReferenceList targets={targets} presentation="face" label="Targeting" />
      </div>
      <span className="spell-hold__hint">
        Hover the card to keep reading it — it resolves on its own when you stop.
      </span>
      <div className="spell-hold__actions">
        <button type="button" className="btn" onClick={onExtend}>
          Keep looking
        </button>
        <button type="button" className="btn btn--ghost" onClick={onRelease}>
          Let it resolve
        </button>
      </div>
    </div>
  );
}

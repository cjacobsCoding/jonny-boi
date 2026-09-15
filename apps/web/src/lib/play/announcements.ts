/**
 * ONE ANNOUNCEMENT SURFACE, WITH A QUEUE — pure, DOM-free.
 *
 * Caleb, verbatim: *"we are getting some overriding overlays in app that look
 * bad - like 'heres what goblin guide revealed from your library' and 'heres
 * what the computer casted' - those should reconcile somehow"*.
 *
 * ## What was actually on the screen (MEASURED off the stylesheets, not guessed)
 *
 * Four independent announcers, each `position: fixed`, none aware of the others:
 *
 * | announcer            | slot                      | z-index |
 * |----------------------|---------------------------|---------|
 * | `.reveal-banner`     | `top: 12%`, centred       | 70      |
 * | `.spell-hold`        | `top: 50%`, centred card  | 52      |
 * | `.combat-hold`       | `top: 3.9rem`             | 52      |
 * | `.forced-choice`     | `top: 3.9rem`             | 52      |
 *
 * `.combat-hold` and `.forced-choice` were painting into the SAME slot at the
 * SAME z-index — their shared stylesheet comment even says so, on the assumption
 * that *"the two never stand at once"*, which nothing enforced. And
 * `.spell-hold` is capped at `calc(100vh - 2rem)` and centred, so a tall held
 * card covers `top: 12%` outright: that is Caleb's reported pair, the reveal and
 * the opponent's cast, one painted over the other.
 *
 * **The fix is a QUEUE, not a fifth z-index** (`docs/WATCH-A-GAME.md` §WATCH-4,
 * written before the fourth announcer landed: *"This must be built as the shared
 * mechanism now, before the fourth announcer lands and makes it five."*).
 *
 * ## ⚠️ THE ORDERING CONSTRAINT, WRITTEN DOWN — "queued" vs "holding the game"
 *
 * Three of the four announcements GATE the game: while one is up, `PlayView`
 * declines to auto-pass priority and the AI seat does not move. A queue that
 * DELAYED such an announcement would be a catastrophe — the game would advance
 * out from under the very frame the beat exists to show (§10 measured exactly
 * that: `blocking=0 staged=0 arcs=0` 260 ms after a confirmed block). A queue
 * that DROPPED one would be worse: the gate would release with nothing having
 * been shown for it.
 *
 * So the relationship is ONE answer, in one function, derived from ONE list:
 *
 * ```
 * holdsGame(queue)  ===  queue.some(a => ANNOUNCEMENT_KINDS[a.kind].holds)
 * showing(queue)    ===  the lowest-ranked entry of queue
 * ```
 *
 * …plus ONE TABLE INVARIANT, which is what makes those two agree rather than
 * merely coexist:
 *
 * > **Every kind that HOLDS the game ranks above every kind that does not.**
 *
 * That invariant is pinned by {@link ANNOUNCEMENT_RANK_INVARIANT} and asserted
 * in `announcements.test.ts`. From it, two properties follow as THEOREMS rather
 * than as further rules somebody has to remember:
 *
 * 1. **A hold is never delayed.** If any holding announcement is queued, the
 *    head of the queue is a holding announcement — so the thing gating the game
 *    is always the thing the player is looking at. There is no frame where the
 *    board is frozen and the screen shows something unrelated.
 * 2. **A hold is never dropped.** A hold waiting behind ANOTHER hold still
 *    freezes the game, so the game cannot advance between two beats and the
 *    second one is still standing in a live window when its turn comes.
 *
 * ⚠️ `some` RATHER THAN `head`, and the honest reason: under property 1 the two
 * are extensionally EQUAL, and swapping them was TRIED — all 79 assertions in
 * `announcements.test.ts` stayed green. `some` is written because it is the form
 * that remains correct if a later row breaks the invariant, and the INVARIANT
 * test is the one that catches such a row (falsified: moving `reveal` to rank 0
 * reddens six assertions). Saying `some` is what catches something today would
 * be a check that cannot fail wearing a comment claiming it can.
 *
 * ## ⚠️ AND THE BEAT IS SPENT BY THE HEAD, NEVER BY A WAITER
 *
 * The corollary that makes "never silently drop" true rather than aspirational:
 * an announcement's timer runs only while it is the one on screen. Before this
 * module, each announcer armed its own `setTimeout` the instant it was created
 * — so an announcement that had been painted over spent its whole beat invisible
 * and then vanished. That is the same defect class as the silence this branch
 * has been fixing, and it is why the timer moved to the head of the queue.
 *
 * ## Why the ranks are the ranks — PERISHABILITY, not taste
 *
 * A rank is *"how much of what this announcement describes is already gone by
 * the time it could be shown again?"* The most perishable goes first, because it
 * is the one that cannot be re-derived later:
 *
 * - a combat beat is a picture of `state.combat`, which is cleared a frame later;
 * - a held spell is a stack object, which survives only until it resolves;
 * - a settled choice is reconstructed from a `GameEvent` and cannot go stale;
 * - a reveal is a fold over the WHOLE event log and is re-derivable at any time.
 *
 * That ordering happens to put all three holding kinds above the one notice,
 * which is {@link ANNOUNCEMENT_RANK_INVARIANT} — but the invariant is asserted
 * rather than assumed, so a future row cannot quietly break it.
 *
 * ## Nothing here knows about the DOM, React, or the engine's rules
 *
 * Same constraint `spell-hold.ts`, `combat-hold.ts` and `forced-choice.ts` keep:
 * the decision is a function of facts the board already holds, and its output is
 * an order and a number of milliseconds. `packages/core` and `packages/sim` do
 * not import it and cannot.
 */
import type {
  AnnouncementConfig,
  ForcedChoiceConfig,
  SpellHoldConfig,
} from './play-config.js';
import type { CombatHold } from './combat-hold.js';
import { holdDurationMs, type HoldPressure, type SpellHold } from './spell-hold.js';
import type { ForcedChoice } from './forced-choice.js';
import type { RevealView } from './reveals.js';

// -----------------------------------------------------------------------------
// What can be announced
// -----------------------------------------------------------------------------

/**
 * EVERY ANNOUNCEMENT THIS APP CAN MAKE, carrying exactly what its renderer needs.
 *
 * A discriminated union rather than four independent states, and {@link AnnouncementKind}
 * is DERIVED from it — so {@link ANNOUNCEMENT_KINDS} being a mapped type over
 * that union is the class guard: a fifth announcement added here STOPS THE BUILD
 * until somebody writes its row (its rank, whether it holds the game, where it
 * paints and how long it stands). That is the same device `FORCED_CHOICE_KINDS`
 * uses against core's `ChoiceKind`, and it is the only thing in this repo that
 * has ever actually stopped a kind going silent by omission.
 */
export type AnnouncementBody =
  | { readonly kind: 'combatHold'; readonly hold: CombatHold }
  | { readonly kind: 'spellHold'; readonly hold: SpellHold; readonly pressure: HoldPressure }
  | { readonly kind: 'forcedChoice'; readonly forced: ForcedChoice }
  | { readonly kind: 'reveal'; readonly reveal: RevealView };

/** The kinds, derived from the bodies so the two can never drift apart. */
export type AnnouncementKind = AnnouncementBody['kind'];

/** The body belonging to one kind. */
export type AnnouncementBodyOf<K extends AnnouncementKind> = Extract<
  AnnouncementBody,
  { readonly kind: K }
>;

// -----------------------------------------------------------------------------
// Where one announcement paints
// -----------------------------------------------------------------------------

/**
 * WHERE ON THE SURFACE an announcement stands. CLOSED, and it is two rows rather
 * than four because the difference is real and the sameness is the fix:
 * `.combat-hold` and `.forced-choice` were two hand-written copies of one slot.
 *
 * ⚠️ The slot is NOT a z-index. Only one announcement is ever mounted, so there
 * is nothing to stack: the surface carries one z-index and the slot chooses
 * where within it the single child sits.
 */
export const ANNOUNCEMENT_SLOTS = Object.freeze({
  top: 'A strip under the board status row. What it describes happened on the battlefield, at the midline between the seats, so the announcement must not cover it.',
  centre:
    'A card in the middle of the screen, big enough to READ and to hover. UX-16 asked for an opponent’s spell to be INSPECTABLE, which a strip cannot be.',
});
export type AnnouncementSlot = keyof typeof ANNOUNCEMENT_SLOTS;

// -----------------------------------------------------------------------------
// The table
// -----------------------------------------------------------------------------

/** The config every duration rule reads. One bundle, so a row takes one argument. */
export interface AnnouncementBeats {
  readonly spellHold: SpellHoldConfig;
  readonly forcedChoice: ForcedChoiceConfig;
  readonly announcement: AnnouncementConfig;
}

/** One announcement kind's rank, gate, slot and beat. */
export interface AnnouncementKindRow<K extends AnnouncementKind = AnnouncementKind> {
  /**
   * Lower goes first. See the header: rank is PERISHABILITY, and the ranks are
   * required to be distinct ({@link ANNOUNCEMENT_RANK_INVARIANT}) so "which of
   * these two shows first?" can never depend on argument order.
   */
  readonly rank: number;
  /**
   * Does this announcement GATE the game — the auto-passer and the AI seat?
   *
   * ⚠️ MEASURED FROM THE SHIPPED CODE, not from a description of it. Before this
   * module `PlayView` gated on `hold || combatHold || forcedChoice` in two
   * places, so THREE kinds held the game, not the two a reading of the docs
   * suggests. A settled choice resolves its trigger in the very next priority
   * window, which is precisely why it was gated.
   */
  readonly holds: boolean;
  readonly slot: AnnouncementSlot;
  /**
   * How long this announcement stands, ms. Always > 0.
   *
   * Every row DERIVES its beat from the module that already owned it — the
   * combat beat was resolved by `combatHoldDecision`, the spell hold's by
   * `holdDurationMs` (which folds in pointer and "Keep looking" pressure), the
   * settled-choice beat and the reveal's by their own config rows. So there is
   * no new hand-tuned number here and no second answer to "how long does this
   * last" (rule 12).
   */
  readonly durationMs: (
    body: AnnouncementBodyOf<K>,
    beats: AnnouncementBeats,
    reducedMotion: boolean,
  ) => number;
  /** Why this row ranks where it does and gates the way it does. */
  readonly why: string;
}

/**
 * Builds one row with its body type NARROWED to its own kind, so a row cannot
 * read a field belonging to a different announcement.
 */
function row<K extends AnnouncementKind>(
  _kind: K,
  definition: AnnouncementKindRow<K>,
): AnnouncementKindRow<K> {
  return Object.freeze(definition);
}

/**
 * EVERY ANNOUNCEMENT KIND, its rank, whether it holds the game, where it paints
 * and how long it stands. A mapped type over {@link AnnouncementKind}, which is
 * itself derived from {@link AnnouncementBody} — so a fifth announcer cannot be
 * added without a row here, and a hand-rolled banner that never becomes a body
 * is caught by `announcement-queue.test.ts`'s class assertion instead.
 */
export const ANNOUNCEMENT_KINDS: { readonly [K in AnnouncementKind]: AnnouncementKindRow<K> } =
  Object.freeze({
    combatHold: row('combatHold', {
      rank: 1,
      holds: true,
      slot: 'top',
      // Already resolved against `COMBAT_HOLD_CONFIG` and reduced motion by
      // `combatHoldDecision`, which is the one place that arithmetic lives. The
      // beat the board ANNOUNCES and the beat it WAITS are the same number.
      durationMs: (body) => body.hold.ms,
      why: 'THE MOST PERISHABLE. §10 measured `state.combat` cleared, damage dealt and the turn advanced inside 260 ms of a confirmed block — the picture this beat exists to show does not exist a frame later, so nothing may stand in front of it.',
    }),
    spellHold: row('spellHold', {
      rank: 2,
      holds: true,
      slot: 'centre',
      // Pointer pressure and each "Keep looking" press are folded in by
      // `holdDurationMs`, so hovering the card lengthens the beat that is
      // actually running rather than needing a second hold.
      durationMs: (body, beats) => holdDurationMs(body.pressure, beats.spellHold),
      why: 'A stack object survives only until it resolves, and the whole point of UX-16 is to read it BEFORE that. Less perishable than a combat frame (the object is still there next render) and more than anything reconstructed from the log.',
    }),
    forcedChoice: row('forcedChoice', {
      rank: 3,
      holds: true,
      slot: 'top',
      durationMs: (_body, beats, reducedMotion) =>
        reducedMotion ? beats.forcedChoice.reducedMotionHoldMs : beats.forcedChoice.holdMs,
      why: 'It HOLDS — the trigger it describes resolves in the very next priority window — but its CONTENT is rebuilt from a `choiceAutoAnswered` event and cannot go stale, so it yields the surface to the two whose subject is disappearing.',
    }),
    reveal: row('reveal', {
      rank: 4,
      holds: false,
      slot: 'top',
      durationMs: (_body, beats, reducedMotion) =>
        reducedMotion ? beats.announcement.reducedMotionRevealMs : beats.announcement.revealMs,
      why: 'THE ONLY NOTICE. `latestReveal` is a fold over the whole event log, so this is re-derivable at any moment and nothing is lost by showing it last — which is what lets it be the one kind that does not freeze the game.',
    }),
  });

/** Every kind, in the order the surface shows them. Derived from the ranks. */
export const ANNOUNCEMENT_ORDER: readonly AnnouncementKind[] = Object.freeze(
  (Object.keys(ANNOUNCEMENT_KINDS) as AnnouncementKind[]).sort(
    (a, b) => ANNOUNCEMENT_KINDS[a].rank - ANNOUNCEMENT_KINDS[b].rank,
  ),
);

/**
 * THE TABLE INVARIANT the whole design rests on, stated as a checkable value so
 * it is a test rather than a paragraph.
 *
 * Returns the offending pair when the table is wrong, `null` when it holds.
 * See the header: without this, "the thing holding the game" and "the thing on
 * screen" would be two independent answers that happen to agree today.
 */
export const ANNOUNCEMENT_RANK_INVARIANT = (): {
  readonly holding: AnnouncementKind;
  readonly notice: AnnouncementKind;
} | null => {
  for (const holding of ANNOUNCEMENT_ORDER) {
    if (!ANNOUNCEMENT_KINDS[holding].holds) continue;
    for (const notice of ANNOUNCEMENT_ORDER) {
      if (ANNOUNCEMENT_KINDS[notice].holds) continue;
      if (ANNOUNCEMENT_KINDS[holding].rank > ANNOUNCEMENT_KINDS[notice].rank) {
        return { holding, notice };
      }
    }
  }
  return null;
};

// -----------------------------------------------------------------------------
// The queue
// -----------------------------------------------------------------------------

/** The announcement surface's whole state: what shows, what waits, what is held. */
export interface AnnouncementQueue {
  /** The one announcement mounted. `null` when nothing is being announced. */
  readonly showing: AnnouncementBody | null;
  /**
   * Announcements that arrived while {@link showing} had the surface, in the
   * order they will get it. NEVER dropped: each is still live, still gating the
   * game if its row says so, and still spends its FULL beat when its turn comes
   * — because the timer belongs to the head, not to the arrival.
   */
  readonly waiting: readonly AnnouncementBody[];
  /**
   * Is the game held? `true` while ANY queued announcement's row holds — not
   * merely the one on screen. This is the single answer both the auto-passer and
   * the AI seat read (rule 12), and it is what makes a hold waiting behind
   * another hold safe: the board cannot advance between the two beats.
   */
  readonly holdsGame: boolean;
}

/** Nothing is being announced. Shared, so a quiet board allocates nothing. */
export const NO_ANNOUNCEMENTS: AnnouncementQueue = Object.freeze({
  showing: null,
  waiting: Object.freeze([]),
  holdsGame: false,
});

/**
 * THE ONE FUNNEL: every live announcement in, one ordered queue out.
 *
 * Callers pass everything that is currently live — in any order — and read both
 * "what do I mount?" and "is the game held?" off the single result. There is
 * deliberately no second entry point for the gate: a caller that could ask about
 * holding without asking about display is a caller that can disagree with the
 * screen, which is the defect this module exists to remove.
 *
 * Stable within a rank by construction (ranks are required distinct), so the
 * order is a property of the TABLE and never of the argument order.
 */
export function announcementQueue(
  live: readonly (AnnouncementBody | null | undefined)[],
): AnnouncementQueue {
  const present = live.filter((entry): entry is AnnouncementBody => entry != null);
  if (present.length === 0) return NO_ANNOUNCEMENTS;
  const ordered = [...present].sort(
    (a, b) => ANNOUNCEMENT_KINDS[a.kind].rank - ANNOUNCEMENT_KINDS[b.kind].rank,
  );
  const [showing, ...waiting] = ordered;
  return Object.freeze({
    showing: showing ?? null,
    waiting: Object.freeze(waiting),
    // `some` over the WHOLE queue, not `showing` — see the header. A hold behind
    // a hold must still freeze the board, or the game advances between beats.
    holdsGame: ordered.some((entry) => ANNOUNCEMENT_KINDS[entry.kind].holds),
  });
}

/**
 * How long the announcement on screen stands, ms.
 *
 * ⚠️ ASKED ABOUT THE HEAD, and only ever the head. A waiter's beat has not
 * started: before the queue, every announcer armed its own timer on creation, so
 * one that had been painted over burned its beat unseen and then vanished —
 * precisely the silent drop this module forbids.
 *
 * The single cast is here, in one place, and is why {@link row} exists: the
 * lookup `ANNOUNCEMENT_KINDS[body.kind]` cannot narrow its own argument for the
 * compiler, but each row was BUILT against its own body type, so the call is
 * sound by construction rather than by inspection.
 */
export function announcementDurationMs(
  body: AnnouncementBody,
  beats: AnnouncementBeats,
  reducedMotion: boolean,
): number {
  const chosen = ANNOUNCEMENT_KINDS[body.kind] as AnnouncementKindRow<typeof body.kind>;
  return chosen.durationMs(body as AnnouncementBodyOf<typeof body.kind>, beats, reducedMotion);
}

/** Does this announcement gate the game? The row's answer, never a re-derivation. */
export function announcementHolds(body: AnnouncementBody): boolean {
  return ANNOUNCEMENT_KINDS[body.kind].holds;
}

/**
 * The identity of one announcement, for React's `key` and for "is this still the
 * same thing on screen?".
 *
 * It must change when the SUBJECT changes and not when a surrounding render
 * happens, or the surface would either replay its entrance animation every frame
 * or fail to replay it for a genuinely new announcement. Each kind's own natural
 * identity is used: the engine's ids where there are any, and the reveal's index
 * into the event log (`RevealView.at`), which is what `PlayBoard` already used
 * to remember a dismissal.
 */
export function announcementId(body: AnnouncementBody): string {
  switch (body.kind) {
    case 'combatHold':
      return `combatHold:${body.hold.kind}`;
    case 'spellHold':
      return `spellHold:${body.hold.instanceId}`;
    case 'forcedChoice':
      return `forcedChoice:${body.forced.id}`;
    case 'reveal':
      return `reveal:${body.reveal.at}`;
  }
}

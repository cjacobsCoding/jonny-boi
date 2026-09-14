/**
 * THE STACK, AS SOMETHING A PLAYER CAN READ (UX-1 / UX-2, docs/MTGA-UX-OVERHAUL.md).
 *
 * Reported verbatim: *"I cant see whats on the stack at any given moment but I
 * should be able to easily see cards on the stack - and not just card names -
 * just like MTGA."*
 *
 * `StackPanel` is a thin renderer; every DECISION it draws is made here, in one
 * pure, DOM-free module, so ordering, labels, the face a row shows and the
 * target relationships are unit-testable without a browser.
 *
 * **TWO ENTRY POINTS, TWO DIFFERENT QUESTIONS** (rule 12 — one answer to one
 * question, not one function doing two jobs):
 *
 *  - {@link stackEntries} answers *"what are the FACTS about these engine stack
 *    objects?"*. It is the one place that knows a spell's face is its own card
 *    while an ability's face belongs to the permanent that produced it, and the
 *    one place that reverses the engine's bottom-first stack into the order a
 *    player reads.
 *  - {@link stackRows} answers *"how do I DRAW those facts?"*. It needs nothing
 *    from the engine — only the facts and the seat names.
 *
 * ⚠️ Both `lib/play/view-model.ts` (hotseat) and `lib/online/board-adapter.ts`
 * (online) currently hand-roll the first question as two near-identical copies
 * of the same `stackView()` — and neither answers the second, which is why the
 * panel could only ever print names. Both should delegate to
 * {@link stackEntries}; see the lane-A report for the two-line change. Until
 * they do, an entry that omits {@link StackEntry.faceCardId} draws a NAMED
 * PLACEHOLDER rather than a guessed face, because a stack that shows the wrong
 * card is worse than one that shows none.
 */
import { isPlayerTarget } from '@jonny-boi/core';
import type { InstanceId, PlayerId, StackObject, TriggeredStackObject } from '@jonny-boi/core';
import {
  CARD_ASPECT_HEIGHT_OVER_WIDTH,
  STACK_PANEL_CONFIG,
  type StackPanelConfig,
} from './play-config.js';

// -----------------------------------------------------------------------------
// What kinds of thing sit on the stack
// -----------------------------------------------------------------------------

/**
 * The kinds of object a stack row can be. CLOSED — {@link STACK_KINDS} is a
 * mapped type over this union, so a kind added here fails `tsc` until it has a
 * row saying how to label it.
 *
 * Three, not the two the panel used to print. The engine models an ACTIVATED
 * ability as a `TriggeredStackObject` carrying `origin: 'activated'`
 * (`packages/core/src/state.ts`, and see the comment there for why the two share
 * one stack-object kind) — so the old panel labelled "{T}: Add {G}" as a
 * *Trigger*, which is a different thing a player is allowed to respond to
 * differently. The distinction exists in core; it now survives into the UI.
 */
export const STACK_ENTRY_KINDS = ['spell', 'trigger', 'activated'] as const;
export type StackEntryKind = (typeof STACK_ENTRY_KINDS)[number];

/** How one kind of stack object presents itself. */
export interface StackKindRow {
  /** The chip printed on the row. */
  readonly label: string;
  /**
   * Does the FACE this row draws belong to a DIFFERENT object than the row
   * itself?
   *
   * True for abilities: their face is the permanent that produced them, and
   * their own `name` is the ability's TEXT, not a card name — which is exactly
   * what Caleb asked for ("the player needs to see WHICH permanent is
   * triggering"). False for a spell, where the object on the stack IS the card.
   */
  readonly facedBySource: boolean;
}

/** The one table every consumer reads for a stack object's presentation. */
export const STACK_KINDS: Readonly<Record<StackEntryKind, StackKindRow>> = Object.freeze({
  spell: Object.freeze({ label: 'Spell', facedBySource: false }),
  trigger: Object.freeze({ label: 'Triggered ability', facedBySource: true }),
  activated: Object.freeze({ label: 'Activated ability', facedBySource: true }),
});

/**
 * What a row falls back to when its `kind` is not in {@link STACK_KINDS}.
 *
 * Unreachable through the type system; reachable through hand-built or
 * deserialized data. The table stays CLOSED and the outsider is REPORTED as
 * unsupported rather than being quietly drawn as a spell — silent approximation
 * is worse than a clear refusal (rule 2), and "it rendered as a spell" is a bug
 * nobody would ever think to look for.
 */
export const UNSUPPORTED_STACK_KIND: StackKindRow = Object.freeze({
  label: 'Unsupported stack object',
  facedBySource: false,
});

// -----------------------------------------------------------------------------
// Targets, as a relationship
// -----------------------------------------------------------------------------

/** What a target can be. CLOSED; {@link STACK_TARGET_KINDS_TABLE} maps over it. */
export const STACK_TARGET_KINDS = ['permanent', 'player'] as const;
export type StackTargetKind = (typeof STACK_TARGET_KINDS)[number];

/** How one kind of target presents itself. */
export interface StackTargetKindRow {
  /** Read before the target's name, so a screen reader says what it is. */
  readonly screenReaderLabel: string;
  /**
   * Can this target carry a card face (and therefore a hover preview)? A player
   * is not a card; asking the hover funnel to preview seat "A" would open an
   * empty panel.
   */
  readonly hasFace: boolean;
}

export const STACK_TARGET_KINDS_TABLE: Readonly<Record<StackTargetKind, StackTargetKindRow>> =
  Object.freeze({
    permanent: Object.freeze({ screenReaderLabel: 'targets', hasFace: true }),
    player: Object.freeze({ screenReaderLabel: 'targets player', hasFace: false }),
  });

/**
 * The glyph that makes a target a RELATIONSHIP rather than an item in a list.
 *
 * Named because the panel's whole point is that "→ Grizzly Bears" on its own
 * line reads as *this spell is aimed at that creature*, where the old
 * comma-joined `" → a, b"` string read as a footnote. It is decorative, so every
 * render marks it `aria-hidden` and lets
 * {@link StackTargetKindRow.screenReaderLabel} carry the meaning instead.
 */
export const TARGET_ARROW = '→';

/** One target of one stack object, resolved for rendering. */
export interface StackTargetView {
  readonly kind: StackTargetKind;
  /** The raw reference, kept so a caller can correlate a row with the board. */
  readonly ref: InstanceId | PlayerId;
  readonly name: string;
  /** Scryfall id of the targeted permanent's face, or `null` when unknown. */
  readonly cardId: string | null;
}

// -----------------------------------------------------------------------------
// Resolution order — say it, do not make the player infer it
// -----------------------------------------------------------------------------

/**
 * What each position on the stack is called, by depth (0 = resolves first).
 *
 * A CLOSED table with an honest fallback (see {@link resolutionLabel}): five
 * rows because {@link StackPanelConfig.maxVisibleEntries} is the depth past
 * which the panel condenses, and a condensed row has no room for "5th to
 * resolve" anyway. The first row is spelled out in words on purpose — "Resolves
 * next" is the single fact a player most needs from this panel, and "1st" makes
 * them do the inference.
 */
export const RESOLUTION_LABELS: readonly string[] = Object.freeze([
  'Resolves next',
  '2nd to resolve',
  '3rd to resolve',
  '4th to resolve',
  '5th to resolve',
]);

/**
 * The order label for a given depth. Past the table this REPORTS the position
 * as a number (`#7 to resolve`) rather than reaching for an ordinal suffix rule
 * — "11th"/"21st" is a second, English-only table nobody asked for, and getting
 * it subtly wrong on a rare deep stack is exactly the silent approximation
 * rule 2 forbids.
 */
export function resolutionLabel(depth: number): string {
  return RESOLUTION_LABELS[depth] ?? `#${depth + 1} to resolve`;
}

// -----------------------------------------------------------------------------
// The facts (producer output / panel input)
// -----------------------------------------------------------------------------

/**
 * What a producer supplies for ONE stack object.
 *
 * ⚠️ The face fields are OPTIONAL, and that is a compatibility statement, not a
 * design preference: `view-model.StackView` predates UX-1 and carries neither.
 * Making them optional means both boards keep compiling and keep rendering
 * while their adapters are switched over to {@link stackEntries}; an entry that
 * omits them draws a named placeholder. Once both adapters delegate, nothing
 * omits them and the optionality is dead weight that can be removed in one
 * edit.
 */
export interface StackEntry {
  /** The STACK OBJECT's id — for a spell this is also its card instance's id. */
  readonly instanceId: InstanceId;
  readonly kind: StackEntryKind;
  /** A spell's card name; an ability's printed text/label. */
  readonly name: string;
  readonly controller: PlayerId;
  readonly targets: readonly (InstanceId | PlayerId)[];
  /** Scryfall id of the face to draw, or `null`/absent when there is none. */
  readonly faceCardId?: string | null;
  /** For an ability: the name of the permanent that produced it. */
  readonly sourceName?: string | null;
}

/** A card face and the name that goes with it. */
export interface StackFace {
  readonly cardId: string;
  readonly name: string;
}

/**
 * The two lookups {@link stackEntries} needs, kept as two functions because they
 * answer two questions:
 *
 *  - `nameOf` — *what is instance N called?* TOTAL: the session's own
 *    `nameOf` degrades an unknown id to a readable `#id`, and an ability whose
 *    source died is still found in a graveyard.
 *  - `faceOf` — *which card face does instance N show?* PARTIAL by nature: a
 *    token has no pool card, and an instance that has genuinely ceased to exist
 *    has nothing at all. `null` means "no face", never "guess one".
 */
export interface StackSources {
  readonly nameOf: (id: InstanceId) => string;
  readonly faceOf: (id: InstanceId) => string | null;
}

/**
 * How core encodes an ACTIVATED ability on the stack: a trigger object stamped
 * `origin: 'activated'` (`packages/core/src/state.ts`). A mapped type over
 * core's own union, so if core ever adds a third origin this stops compiling
 * instead of silently labelling it a trigger.
 */
const STACK_KIND_BY_ABILITY_ORIGIN: Readonly<
  Record<NonNullable<TriggeredStackObject['origin']>, StackEntryKind>
> = Object.freeze({ activated: 'activated' });

/**
 * THE producer: engine stack objects → the facts a panel can draw, TOP-FIRST.
 *
 * ⚠️ THIS IS THE ONE REVERSAL. The engine keeps the stack bottom-first (LIFO,
 * push/pop at the end); a player reads it in the order it RESOLVES.
 * {@link stackRows} must not reverse again — it treats its input as already
 * top-first and assigns depth by index.
 */
export function stackEntries(
  stack: readonly StackObject[],
  sources: StackSources,
): readonly StackEntry[] {
  return [...stack].reverse().map((obj): StackEntry => {
    if (obj.kind === 'spell') {
      return {
        instanceId: obj.instanceId,
        kind: 'spell',
        name: obj.card.def.name,
        controller: obj.controller,
        targets: obj.targets,
        // The spell IS the card instance moving through the stack — the engine
        // builds the stack object with `instanceId: card.instanceId` — so its
        // face is right here. Taken directly rather than through `faceOf`
        // because a lookup can miss the one zone the card is actually in, and
        // the definition on the object is authoritative for the ACTIVE face
        // (a transformed DFC / a copy carries its own `def.id`).
        faceCardId: obj.card.def.id,
        sourceName: null,
      };
    }
    const kind: StackEntryKind =
      obj.origin === undefined ? 'trigger' : STACK_KIND_BY_ABILITY_ORIGIN[obj.origin];
    return {
      instanceId: obj.instanceId,
      kind,
      name: obj.label,
      controller: obj.controller,
      targets: obj.targets,
      // CR 603.4 / 608.2: an ability resolves even once its source has left the
      // battlefield, so a missing face is a legitimate, expected state — a
      // token's ability has no pool card at all. It draws the named
      // placeholder; it is never guessed at.
      faceCardId: sources.faceOf(obj.sourceInstanceId),
      sourceName: sources.nameOf(obj.sourceInstanceId),
    };
  });
}

// -----------------------------------------------------------------------------
// The rendering decisions
// -----------------------------------------------------------------------------

/** Everything {@link stackRows} needs that is not already in an entry. */
export interface StackRowContext {
  readonly playerNames: Readonly<Record<PlayerId, string>>;
  /** Name a targeted instance. Total (degrades to a readable placeholder). */
  readonly nameOf: (id: InstanceId) => string;
  /**
   * Face a targeted instance, so hovering a target shows the card it points at.
   * Optional: a board that cannot answer it simply gets nameless-but-honest
   * target rows instead of a wrong preview.
   */
  readonly faceOf?: (id: InstanceId) => string | null;
  /**
   * The printed rules text of a card, by Scryfall id — what a SPELL on the
   * stack actually DOES.
   *
   * The complaint is "not just card names", and a face drawn at the measured
   * 96px shows art, name and type line but NOT legible rules text. An ability
   * already carries its own text; without this a spell would be the one thing
   * on the stack you still had to hover to understand, which is the panel's
   * whole reason for existing.
   *
   * A seam rather than a direct import so this module stays free of the bundled
   * card index (5,651 records) and testable without it. `null`/absent simply
   * prints no text — never a guess.
   */
  readonly oracleOf?: (cardId: string) => string | null;
  /**
   * WHOSE screen this is, so an opponent's object can be marked as theirs
   * rather than merely captioned with their name.
   *
   * This panel is the surface UX-16 leans on — *"when an opponent casts a
   * sorcery or instant card, I need to be able to see it and inspect the card
   * before it goes off"* — and at that moment the first thing a player needs is
   * not the spell's name but the fact that it is THEIRS, not mine. Optional
   * because a board that does not say who is looking gets no marking at all,
   * which is honest; guessing "the non-active player" would be wrong on every
   * opponent's turn.
   */
  readonly viewer?: PlayerId;
}

/** One fully-decided stack row. Nothing here is left for the renderer to infer. */
export interface StackRow {
  readonly instanceId: InstanceId;
  readonly kind: StackEntryKind;
  /** From {@link STACK_KINDS} — "Spell", "Triggered ability", … */
  readonly kindLabel: string;
  /** The big line: a spell's card name, or the permanent an ability belongs to. */
  readonly title: string;
  /**
   * What this object DOES: an ability's own text, or a spell's printed rules
   * text. One field because it is one question — "what happens when this
   * resolves?" — asked of two kinds of object. `null` when nothing can answer
   * it (a spell with no pool record, a vanilla creature spell with no text).
   */
  readonly detail: string | null;
  /** Scryfall id of the face to draw; `null` draws the named placeholder. */
  readonly faceCardId: string | null;
  readonly controller: PlayerId;
  readonly controllerName: string;
  /**
   * True only when the context said who is looking AND this object is not
   * theirs. `false` when the viewer is unknown — no marking beats a guessed one.
   */
  readonly isOpponents: boolean;
  /** 0 = resolves next. */
  readonly depth: number;
  readonly isTop: boolean;
  /** From {@link resolutionLabel}. */
  readonly resolutionLabel: string;
  readonly targets: readonly StackTargetView[];
}

/**
 * A spell's printed rules text, or `null`.
 *
 * An EMPTY oracle text is a real, common answer — a vanilla creature has none —
 * and it is normalised to `null` here so the renderer has one absence to handle
 * rather than two (`''` would otherwise paint an empty clamped block that still
 * costs a row its gap).
 */
function oracleTextFor(faceCardId: string | null, ctx: StackRowContext): string | null {
  if (faceCardId === null || ctx.oracleOf === undefined) return null;
  const text = ctx.oracleOf(faceCardId);
  return text === null || text.length === 0 ? null : text;
}

function targetView(ref: InstanceId | PlayerId, ctx: StackRowContext): StackTargetView {
  // `isPlayerTarget` is core's own funnel for this question — the UI must not
  // grow a second copy of "is 'A' a seat or an instance id" (rule 12).
  if (isPlayerTarget(ref)) {
    return { kind: 'player', ref, name: ctx.playerNames[ref], cardId: null };
  }
  return { kind: 'permanent', ref, name: ctx.nameOf(ref), cardId: ctx.faceOf?.(ref) ?? null };
}

/**
 * Facts → rows. Pure, order-preserving, and the only place that decides which
 * of an entry's two names is the headline.
 *
 * Input MUST already be top-first (see {@link stackEntries}); `depth` is the
 * index, so a caller that reverses twice gets a stack that resolves backwards.
 */
export function stackRows(
  entries: readonly StackEntry[],
  ctx: StackRowContext,
): readonly StackRow[] {
  return entries.map((entry, depth): StackRow => {
    const kindRow = STACK_KINDS[entry.kind] ?? UNSUPPORTED_STACK_KIND;
    const sourceName = entry.sourceName ?? null;
    const faceCardId = entry.faceCardId ?? null;
    // An ability whose source we can name shows THAT as the headline and its own
    // text underneath. An ability whose source we cannot name falls back to its
    // text as the headline rather than printing the same string twice.
    const facedBySource = kindRow.facedBySource && sourceName !== null;
    return {
      instanceId: entry.instanceId,
      kind: entry.kind,
      kindLabel: kindRow.label,
      title: facedBySource ? sourceName : entry.name,
      detail: facedBySource ? entry.name : oracleTextFor(faceCardId, ctx),
      faceCardId,
      controller: entry.controller,
      controllerName: ctx.playerNames[entry.controller],
      isOpponents: ctx.viewer !== undefined && entry.controller !== ctx.viewer,
      depth,
      isTop: depth === 0,
      resolutionLabel: resolutionLabel(depth),
      targets: entry.targets.map((ref) => targetView(ref, ctx)),
    };
  });
}

// -----------------------------------------------------------------------------
// Geometry — the config is the single source, the CSS reads it
// -----------------------------------------------------------------------------

/** The face size a stack of `count` objects is drawn at. */
export interface StackFaceGeometry {
  readonly cardWidthPx: number;
  readonly cardHeightPx: number;
  /** True once the stack is deep enough to have shrunk its faces. */
  readonly condensed: boolean;
}

/**
 * How big a face to draw for a stack this deep.
 *
 * Nothing is ever HIDDEN — a stack object the panel does not draw is a stack
 * object the player will be surprised by. Past
 * {@link StackPanelConfig.maxVisibleEntries} the faces shrink instead, which
 * costs recognisability and keeps honesty.
 */
export function stackFaceGeometry(
  count: number,
  cfg: StackPanelConfig = STACK_PANEL_CONFIG,
): StackFaceGeometry {
  const condensed = count > cfg.maxVisibleEntries;
  const cardWidthPx = condensed ? cfg.condensedCardWidthPx : cfg.cardWidthPx;
  return {
    cardWidthPx,
    // DERIVED, never typed. The fan's negative margins are a fraction of this
    // height (stack-panel.css), so a height that disagreed with the rendered
    // face would make every overlap wrong by exactly that disagreement — which
    // is why the CSS also pins the face to this height rather than letting
    // `aspect-ratio` compute its own.
    cardHeightPx: Math.round(cardWidthPx * CARD_ASPECT_HEIGHT_OVER_WIDTH),
    condensed,
  };
}

// -----------------------------------------------------------------------------
// Placement — where the panel lives, as a row rather than a rewrite
// -----------------------------------------------------------------------------

/**
 * Where the panel is drawn. CLOSED; {@link STACK_PLACEMENT_TABLE} maps over it,
 * so a new placement is a ROW plus a CSS block, never a branch in the component.
 */
export const STACK_PLACEMENTS = ['column', 'floating'] as const;
export type StackPlacement = (typeof STACK_PLACEMENTS)[number];

export interface StackPlacementRow {
  /** The modifier class `stack-panel.css` styles this placement with. */
  readonly className: string;
  /** Why it exists, and what it does and does not buy. */
  readonly why: string;
}

export const STACK_PLACEMENT_TABLE: Readonly<Record<StackPlacement, StackPlacementRow>> =
  Object.freeze({
    column: Object.freeze({
      className: 'stack-panel--column',
      why:
        'In the flow of `.play-board__center`, beside the game log, where the panel has ' +
        'lived since it was written. Measured room (play-config.ts): minmax(12rem, 22rem) ' +
        'wide by 22dvh tall — 176px at an 800px window — on the column declared ' +
        '`flex: 0 4 auto`, i.e. the designated first-to-yield. One face fits; a fan of ' +
        'several does not. UX-2 ("always visible, no panel hunt") is NOT met here.',
    }),
    floating: Object.freeze({
      className: 'stack-panel--floating',
      why:
        'Pinned over the board, out of the flow — the placement that answers UX-2, ' +
        'because it costs the battlefield no height at all. Growing the centre column ' +
        'instead re-opens §3.119\'s "Battleground is super crunched", a fix already paid ' +
        'for. Positioned `absolute` (not `fixed`) on purpose: UX-9 puts a perspective on ' +
        'the board, and a perspective re-roots every `fixed` descendant.',
    }),
  });

/**
 * The placement used when the mount site does not ask for one.
 *
 * `column` — deliberately the STATUS QUO, not the better answer. Where the panel
 * is mounted and how much room it gets is UX-2, and UX-2 is lane D's
 * (`PlayBoard.tsx` + `board-fit.css`): flipping the default here would move the
 * panel on a surface this lane cannot open a browser to check. The `floating`
 * row is built, styled and tested and needs one prop to switch on.
 */
export const DEFAULT_STACK_PLACEMENT: StackPlacement = 'column';

/**
 * THE AFTERMARKET CARD FACE (§3.143 / UX-17) — the real Scryfall card, wearing
 * the card's CURRENT truth instead of its printed one.
 *
 * Caleb asked for four things and this component is where all four are visible:
 *   1. the EFFECTIVE P/T shown in place of the printed one, visibly altered;
 *   2. a hover breakdown naming the base and every contributing card;
 *   3. granted abilities present in the rules text "just as if it was there
 *      natively", styled as aftermarket, and removed ones struck through;
 *   4. a glossary tooltip on EVERY ability word, printed or granted.
 *
 * ## It is a thin renderer, deliberately
 * Every decision — which rows a breakdown has, how the ability list is assembled
 * and ordered, which treatment each change gets, which glyph carries it, and
 * where a tooltip lands — is in the pure, tested `lib/play/provenance-view.ts`.
 * This file walks that model and emits elements. The split is what lets the hard
 * parts be unit-tested in Node with no DOM, and it is why the tables live there
 * and not here.
 *
 * ## ⚠️ THE TOOLTIPS ARE PORTALED, AND THAT IS NOT A PREFERENCE
 * Wave 1 reasoned about this exact trap in this very header and then mounted
 * straight into it, so the breakdown Caleb asked for most specifically ("hovering
 * over that 5/6 should show a full breakdown") could not be displayed at all.
 * A battlefield face sits inside `.perm__art` → `.perm` (`overflow: hidden`,
 * styles.css) → `.seat__row` (`overflow-x: auto`, board-fit.css), and the tile is
 * also inside `.perm-turn`, which carries the tap `transform` — so an
 * absolutely-positioned pop is CLIPPED, and a `position: fixed` one is re-rooted
 * by that transform into the very same clip. Relaxing any of those three
 * ancestors is not available either: they are load-bearing and owned elsewhere.
 *
 * So an OPEN pop is `createPortal`ed to `document.body` — the pattern `CardHover`
 * and `CombatLines` already use in this repo for the same reason — and placed
 * from the trigger's measured rect by the pure `popPlacement`.
 *
 * The CLOSED pop still renders INLINE, dimmed, and that is deliberate three
 * times over:
 *   - it is the `aria-describedby` target, and a `display: none` target is
 *     dropped from the accessibility tree by most screen readers;
 *   - it renders inside `renderToStaticMarkup`, so a test can still assert that a
 *     granted keyword really does carry its explanation and its source;
 *   - it is the SAME element, moved — never a second copy — so there is exactly
 *     one tooltip with a given id at any moment (rule 12).
 * The trigger is a focusable SPAN, never a `<button>`: a card face is mounted
 * inside `BoardPermanentTile`, which is itself a `<button>` when selectable, and
 * a button inside a button is invalid HTML that browsers repair by breaking the
 * outer one.
 *
 * ## Where this face is MOUNTED is half the feature
 * A renderer nothing mounts is a renderer nobody sees. The surfaces are pinned by
 * the adoption table in `CardFace.test.ts`: the battlefield tile, the hover
 * preview (`CardHover`, which every card-bearing surface in the app already
 * wraps), the zoom overlay, the graveyard and the reveal banner.
 *
 * ## Degrading, in order (rule 6)
 * no explanation → the plain printed card with glossary tooltips still live;
 * no pool entry / no art → the card's name on a plain plate, never a crash;
 * `unavailableReason` → the plain card plus the stated reason, because an empty
 * breakdown reads as "nothing is modifying this", which is a different claim.
 */
import {
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
  type ReactElement,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { getCard, cardImage } from '../../lib/cards.js';
import { CARD_ASPECT_HEIGHT_OVER_WIDTH } from '../../lib/play/play-config.js';
import {
  ATTRIBUTION_PRESENTATION,
  buildCardFaceModel,
  GLOSSARY_KIND_LABELS,
  popPlacement,
  TREATMENT_PRESENTATION,
  type BreakdownRow,
  type CharacteristicChange,
  type PopPlacement,
  type PtView,
  type RulesLine,
  type RulesToken,
} from '../../lib/play/provenance-view.js';
import type { CharacteristicExplanation } from '@jonny-boi/core';
import './card-face.css';

/* -------------------------------------------------------------------------- */
/* Size presets                                                                */
/* -------------------------------------------------------------------------- */

/** The sizes a card face is drawn at. CLOSED — adding one is a ROW below. */
export const CARD_FACE_SIZES = ['tile', 'full'] as const;
export type CardFaceSize = (typeof CARD_FACE_SIZES)[number];

/** How much of the model a size preset can actually show. CLOSED. */
export const RULES_DETAILS = [
  /** The whole text box: printed lines, granted abilities, struck-through removals. */
  'full',
  /** Only what is NOT printed on the card — all a 96px tile has room to add. */
  'aftermarketOnly',
] as const;
export type RulesDetail = (typeof RULES_DETAILS)[number];

interface SizePreset {
  /** Which Scryfall image this size asks `cardImage` for. */
  readonly image: 'art_crop' | 'normal' | 'large';
  readonly rules: RulesDetail;
  /** Whether the non-textual change chips (cost, colours, controller) are drawn. */
  readonly chips: boolean;
  readonly why: string;
}

/**
 * What each size draws. A mapped type, so a new size cannot be added without
 * saying what it shows.
 */
const SIZE_PRESETS: { readonly [S in CardFaceSize]: SizePreset } = Object.freeze({
  tile: Object.freeze({
    image: 'art_crop',
    rules: 'aftermarketOnly',
    chips: false,
    why: 'A battlefield tile is ~96px wide (board-fit.css `--play-tile-w-max`) and its top strip is all the room there is. A full text box there is unreadable at any font size that fits, so the tile carries the CONDENSED form — the words that are visible nowhere else — and the MERGED line Caleb asked for ("vigilance, first strike, flying") is one hover away on the full-size face, which `CardHover` now raises from this very tile. The change chips are off for the same reason and lose nothing: a copy already wears the copied card’s art here, and the altered seal says there is more to read.',
  }),
  full: Object.freeze({
    image: 'large',
    rules: 'full',
    chips: true,
    why: 'The hover/zoom face is where a player reads the card, so it carries the LIVE text box — the printed lines rendered as text (which is what makes every ability word hoverable at all) plus everything aftermarket, merged into one line in printed order.',
  }),
});

/* -------------------------------------------------------------------------- */
/* The component                                                               */
/* -------------------------------------------------------------------------- */

export interface CardFaceProps {
  /**
   * Core's characteristic breakdown for this object
   * (`explainCharacteristics(state, instanceId, index)`).
   *
   * Absent is a legitimate answer — a card in hand, a stack object, the online
   * board — and renders the plain printed card. Pass `unavailableReason` when
   * the absence is a LIMITATION rather than "nothing has been done to this".
   */
  readonly explanation?: CharacteristicExplanation | undefined;
  /** Identity when there is no explanation. Ignored when one is supplied. */
  readonly cardId?: string | null;
  readonly name?: string;
  readonly size?: CardFaceSize;
  /**
   * Whether to draw a P/T box. Supply it — the caller knows the type line and
   * core's explanation does not. Omitted, it is inferred from the numbers.
   */
  readonly isCreature?: boolean;
  /**
   * Why provenance is unavailable on this surface, when it is. The online board
   * has no continuous index at all, and an empty breakdown there would read as
   * "nothing is modifying this" — a different, false claim. See
   * `CardFaceModel.unavailableReason` in `lib/play/provenance-view.ts`.
   */
  readonly unavailableReason?: string;
  readonly className?: string;
  /** Board chrome the owning tile draws over the face (counters, combat bands). */
  readonly children?: ReactNode;
}

/** The card, as it is right now. */
export function CardFace({
  explanation,
  cardId,
  name,
  size = 'full',
  isCreature,
  unavailableReason,
  className,
  children,
}: CardFaceProps): ReactElement {
  const preset = SIZE_PRESETS[size];
  const id = useId();
  const resolvedId = explanation?.cardId ?? cardId ?? null;
  const card = resolvedId === null ? undefined : getCard(resolvedId);
  const model = buildCardFaceModel({
    ...(explanation !== undefined ? { explanation } : {}),
    cardId: resolvedId,
    ...(name !== undefined ? { name } : {}),
    ...(card?.oracleText !== undefined ? { oracleText: card.oracleText } : {}),
    ...(isCreature !== undefined
      ? { isCreature }
      : card !== undefined
        ? { isCreature: card.typeLine.types.includes('Creature') }
        : {}),
    ...(unavailableReason !== undefined ? { unavailableReason } : {}),
  });
  const label = model.name.length > 0 ? model.name : (card?.name ?? '');
  const art = card ? cardImage(card, preset.image) : undefined;

  const classes = [
    'card-face',
    `card-face--${size}`,
    model.altered ? 'card-face--altered' : '',
    model.fullyAttributed ? '' : 'card-face--partial',
    className ?? '',
  ]
    .filter((c) => c.length > 0)
    .join(' ');

  const lines = preset.rules === 'full' ? model.lines : aftermarketOnly(model.lines);

  return (
    <div
      className={classes}
      // The aspect comes from lane F's ONE card-shape constant rather than being
      // typed here as `488 / 680`: two literals that must stay equal is the fork
      // rule 12 forbids, and the tap footprint is derived from the same number.
      style={{ '--card-face-aspect': String(CARD_ASPECT_HEIGHT_OVER_WIDTH) } as CSSProperties}
    >
      {art ? (
        // draggable={false} — §3.54's standing rule: no image on a gesture
        // surface may start a native drag, which eats the pointer stream.
        // loading="eager" — §3.119: nothing on a play surface is off-screen.
        <img className="card-face__art" src={art} alt={label} loading="eager" decoding="async" draggable={false} />
      ) : (
        <span className="card-face__fallback">{label}</span>
      )}

      {model.altered && (
        <span className="card-face__seal" aria-label="This card has been altered from printed">
          {TREATMENT_PRESENTATION.granted.glyph}
        </span>
      )}

      {lines.length > 0 && (
        <div className={`card-face__textbox card-face__textbox--${preset.rules}`}>
          {lines.map((line, lineIndex) => (
            <p key={line.key} className={`card-face__line card-face__line--${line.origin}`}>
              {line.tokens.map((token, tokenIndex) => (
                <Token
                  key={`${line.key}-${tokenIndex}`}
                  token={token}
                  popId={`${id}-t-${lineIndex}-${tokenIndex}`}
                />
              ))}
            </p>
          ))}
        </div>
      )}

      {preset.chips && model.changes.length > 0 && (
        <div className="card-face__chips">
          {model.changes.map((change, i) => (
            <ChangeChip key={`${change.characteristic}-${i}`} change={change} popId={`${id}-c-${i}`} />
          ))}
        </div>
      )}

      {model.pt !== null && <PtBox pt={model.pt} popId={`${id}-pt`} />}

      {(model.unavailableReason !== undefined || !model.fullyAttributed) && (
        <p className="card-face__gap" role="note">
          {model.unavailableReason ??
            'Part of this card’s current values could not be traced to a source. What is shown below is incomplete.'}
        </p>
      )}

      {children}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* The pop — ONE trigger component, so there is one escape hatch to maintain   */
/* -------------------------------------------------------------------------- */

/**
 * A hoverable/focusable run of a card face and the tooltip it raises.
 *
 * ONE component for all three trigger kinds (an ability word, the P/T box, a
 * change chip): the portal, the measurement and the open/close rule are the part
 * that was wrong, and three copies of it is three chances to be wrong again
 * (rule 12).
 *
 * The pop is the same element whether it is inline or floating — see the module
 * header for why it is not two copies, and why the closed one is dimmed rather
 * than unmounted.
 */
function PopTrigger({
  popId,
  className,
  popClassName,
  srLabel,
  children,
  pop,
}: {
  readonly popId: string;
  readonly className: string;
  readonly popClassName?: string;
  /** An `aria-label` for the trigger, when its visible text is not the whole story. */
  readonly srLabel?: string;
  readonly children: ReactNode;
  readonly pop: ReactNode;
}): ReactElement {
  const [open, setOpen] = useState(false);
  const [placement, setPlacement] = useState<PopPlacement | null>(null);
  const triggerRef = useRef<HTMLSpanElement>(null);
  const popRef = useRef<HTMLSpanElement>(null);

  // MEASURE, then place — the one thing that genuinely cannot be derived during
  // render, because it needs the browser's own layout of a node that does not
  // exist until the pop is open.
  //
  // `useEffect` and not `useLayoutEffect` on purpose: the latter warns on every
  // server render (this face is asserted through `renderToStaticMarkup`), and
  // the pop fades in over `--card-face-pop-ms` anyway, so the one frame it
  // spends at `opacity: 0` is never seen. Closing clears the placement in the
  // handler rather than here, so the effect has exactly one job.
  useEffect(() => {
    if (!open) return;
    const anchor = triggerRef.current?.getBoundingClientRect();
    const box = popRef.current?.getBoundingClientRect();
    if (anchor === undefined || box === undefined) return;
    setPlacement(
      popPlacement(anchor, box, { width: window.innerWidth, height: window.innerHeight }),
    );
  }, [open]);

  const show = (): void => setOpen(true);
  const hide = (): void => {
    setOpen(false);
    // Dropped with the pop: a stale placement would flash the NEXT opening in
    // the last one's position before the effect re-measures.
    setPlacement(null);
  };

  const popElement = (
    <span
      ref={popRef}
      className={['card-face__pop', open ? 'card-face__pop--floating' : '', popClassName ?? '']
        .filter((c) => c.length > 0)
        .join(' ')}
      role="tooltip"
      id={popId}
      // Unplaced for one frame: kept in the DOM (and so in the accessibility
      // tree) but invisible, rather than flashing in the viewport's top-left.
      style={open ? floatingStyle(placement) : undefined}
    >
      {pop}
    </span>
  );

  return (
    <span
      ref={triggerRef}
      className={className}
      // tabIndex on a SPAN, not a <button> — see the module header: this face is
      // mounted inside a tile that is itself a button when selectable.
      tabIndex={0}
      aria-describedby={popId}
      {...(srLabel !== undefined ? { 'aria-label': srLabel } : {})}
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocus={show}
      onBlur={hide}
    >
      {children}
      {/* `document` is only ever touched from a pointer/focus handler, so the
          server render never reaches it. */}
      {open ? createPortal(popElement, document.body) : popElement}
    </span>
  );
}

/** The floating pop's inline geometry. Null placement = measured but not yet placed. */
function floatingStyle(placement: PopPlacement | null): CSSProperties {
  if (placement === null) return { opacity: 0 };
  return { left: `${placement.left}px`, top: `${placement.top}px` };
}

/* -------------------------------------------------------------------------- */
/* Pieces                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * One run of rules text.
 *
 * A token with neither a glossary row nor a source is plain prose and gets NO
 * trigger at all — not a focusable span with an empty tooltip. Lane F's table is
 * closed and `undefined` is a real answer: a word it does not know must show
 * nothing, because a plausible wrong explanation of a rules keyword is worse than
 * silence.
 */
function Token({ token, popId }: { readonly token: RulesToken; readonly popId: string }): ReactElement {
  const hasPop = token.glossary !== undefined || token.notes.length > 0 || token.valueNote !== undefined;
  if (!hasPop && token.treatment === 'printed') return <span>{token.text}</span>;

  const treatment = TREATMENT_PRESENTATION[token.treatment];
  const attribution = ATTRIBUTION_PRESENTATION[token.attribution];
  const classes = [
    'card-face__tok',
    `card-face__tok--${treatment.modifier}`,
    token.attribution === 'attributed' ? '' : `card-face__tok--${attribution.modifier}`,
  ]
    .filter((c) => c.length > 0)
    .join(' ');

  const body = (
    <>
      {treatment.glyph.length > 0 && (
        <span className="card-face__glyph" aria-label={treatment.srLabel}>
          {treatment.glyph}
        </span>
      )}
      {token.text}
      {attribution.glyph.length > 0 && (
        <span className="card-face__glyph" aria-label={attribution.srLabel}>
          {attribution.glyph}
        </span>
      )}
    </>
  );

  // An aftermarket word with nothing to say still gets its treatment, but no
  // trigger: a focusable span whose tooltip is empty is a keyboard trap for
  // nothing.
  if (!hasPop) return <span className={classes}>{body}</span>;

  return (
    <PopTrigger
      popId={popId}
      className={classes}
      pop={
        <>
          {token.glossary && (
            <>
              <span className="card-face__pop-head">
                {token.glossary.term}
                <span className="card-face__pop-kind"> · {GLOSSARY_KIND_LABELS[token.glossary.kind]}</span>
              </span>
              <span className="card-face__pop-body">{token.glossary.text}</span>
              {/* Only the engine-FLAG rows carry a rule number, and lane F's
                  test pins each against the repo's enforced KEYWORD_RULES. A row
                  without one prints none rather than a guess — which is most of
                  them: the 42 rows the pool refresh added are printed keywords
                  the engine models as scripts, not as `KeywordFlags`, so the
                  manifest has no citation to give them. (No count here: this
                  comment said "36" while core declared 38.) */}
              {token.glossary.rule !== undefined && (
                <span className="card-face__pop-rule">CR {token.glossary.rule}</span>
              )}
            </>
          )}
          {token.valueNote !== undefined && <span className="card-face__pop-body">{token.valueNote}</span>}
          {token.notes.map((note, i) => (
            <span key={i} className="card-face__pop-source">
              {treatment.srLabel.length > 0 ? `${treatment.srLabel}: ` : ''}
              {note.text}
            </span>
          ))}
        </>
      }
    >
      {body}
    </PopTrigger>
  );
}

/** The P/T box and its full breakdown. */
function PtBox({ pt, popId }: { readonly pt: PtView; readonly popId: string }): ReactElement {
  const treatment = TREATMENT_PRESENTATION[pt.treatment];
  const attribution = ATTRIBUTION_PRESENTATION[pt.attribution];
  const classes = [
    'card-face__pt',
    `card-face__pt--${treatment.modifier}`,
    pt.attribution === 'attributed' ? '' : `card-face__pt--${attribution.modifier}`,
  ]
    .filter((c) => c.length > 0)
    .join(' ');

  return (
    <span className={classes}>
      <PopTrigger
        popId={popId}
        className="card-face__pt-value"
        popClassName="card-face__pop--pt"
        srLabel={pt.summary}
        pop={pt.breakdown.map((part) => (
          <span key={part.characteristic} className="card-face__break">
            {part.rows.map((row, i) => (
              <BreakdownLine key={i} row={row} />
            ))}
            {/* Core reconciles its own breakdown, so a mismatch means THIS view
                lost a row. Say so rather than showing a sum that does not add up. */}
            {!part.reconciles && (
              <span className="card-face__break-row card-face__break-row--gap">
                These rows do not add up to {part.effective} — some of the change could not be shown.
              </span>
            )}
          </span>
        ))}
      >
        {pt.power}/{pt.toughness}
        {treatment.glyph.length > 0 && (
          <span className="card-face__glyph" aria-label={treatment.srLabel}>
            {treatment.glyph}
          </span>
        )}
        {attribution.glyph.length > 0 && (
          <span className="card-face__glyph" aria-label={attribution.srLabel}>
            {attribution.glyph}
          </span>
        )}
      </PopTrigger>
    </span>
  );
}

/** One line of a P/T breakdown. */
function BreakdownLine({ row }: { readonly row: BreakdownRow }): ReactElement {
  const treatment = TREATMENT_PRESENTATION[row.treatment];
  const attribution = ATTRIBUTION_PRESENTATION[row.attribution];
  return (
    <span className={`card-face__break-row card-face__break-row--${row.kind}`}>
      <span className="card-face__break-label">
        {row.label}
        {row.note !== undefined && <span className="card-face__break-src"> — {row.note.text}</span>}
      </span>
      <span className={`card-face__break-value card-face__break-value--${treatment.modifier}`}>
        {row.value}
        {attribution.glyph.length > 0 && (
          <span className="card-face__glyph" aria-label={attribution.srLabel}>
            {attribution.glyph}
          </span>
        )}
      </span>
    </span>
  );
}

/**
 * A characteristic with no printed home in the text box — the name, the type
 * line, the colours, the printed cost, who controls it.
 */
function ChangeChip({
  change,
  popId,
}: {
  readonly change: CharacteristicChange;
  readonly popId: string;
}): ReactElement {
  const treatment = TREATMENT_PRESENTATION[change.treatment];
  const attribution = ATTRIBUTION_PRESENTATION[change.attribution];
  return (
    <PopTrigger
      popId={popId}
      className={`card-face__chip card-face__chip--${change.region} card-face__chip--${treatment.modifier}`}
      pop={
        <>
          <span className="card-face__pop-head">{change.label}</span>
          <span className="card-face__pop-body">
            {change.from !== undefined ? `Was ${change.from}. Now ${change.to}.` : `Now ${change.to}.`}
          </span>
          <span className="card-face__pop-source">{change.note.text}</span>
        </>
      }
    >
      {treatment.glyph.length > 0 && (
        <span className="card-face__glyph" aria-label={treatment.srLabel}>
          {treatment.glyph}
        </span>
      )}
      <span className="card-face__chip-label">{change.label}</span>
      <span className="card-face__chip-value">
        {change.from !== undefined ? `${change.from} → ${change.to}` : change.to}
      </span>
      {attribution.glyph.length > 0 && (
        <span className="card-face__glyph" aria-label={attribution.srLabel}>
          {attribution.glyph}
        </span>
      )}
    </PopTrigger>
  );
}

/**
 * The lines a TILE shows: those the card does not already print.
 *
 * A tile has no room for a text box, and the printed text is one hover away —
 * the granted flying is not, which is the whole complaint UX-17 answers. The
 * MERGED line ("vigilance, first strike, flying") is the full-size face's job;
 * see `SIZE_PRESETS.tile.why` and the `CardHover` that wraps every tile.
 */
function aftermarketOnly(lines: readonly RulesLine[]): readonly RulesLine[] {
  const out: RulesLine[] = [];
  for (const line of lines) {
    const tokens = line.tokens.filter((t) => t.treatment !== 'printed');
    if (tokens.length === 0) continue;
    out.push({ ...line, tokens });
  }
  return out;
}

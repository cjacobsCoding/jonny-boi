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
 * and ordered, which treatment each change gets, which glyph carries it — is in
 * the pure, tested `lib/play/provenance-view.ts`. This file walks that model and
 * emits elements. The split is what lets the hard part be unit-tested in Node
 * with no DOM, and it is why the tables live there and not here.
 *
 * ## The tooltips are CSS, not state
 * A pop opens on `:hover` and on `:focus-within` of its own trigger. No hook, no
 * portal, no measurement:
 *   - it renders inside `renderToStaticMarkup`, so a test can assert that a
 *     granted keyword really does carry its explanation and its source;
 *   - it needs no JS to reach the keyboard, and `aria-describedby` points at a
 *     pop that is dimmed rather than `display: none`, so assistive tech reads it;
 *   - the trigger is a focusable SPAN, never a `<button>`: a card face is mounted
 *     inside `BoardPermanentTile`, which is itself a `<button>` when selectable,
 *     and a button inside a button is invalid HTML that browsers repair by
 *     breaking the outer one.
 *
 * ## Degrading, in order (rule 6)
 * no explanation → the plain printed card with glossary tooltips still live;
 * no pool entry / no art → the card's name on a plain plate, never a crash;
 * `unavailableReason` → the plain card plus the stated reason, because an empty
 * breakdown reads as "nothing is modifying this", which is a different claim.
 */
import { useId, type CSSProperties, type ReactElement, type ReactNode } from 'react';
import { getCard, cardImage } from '../../lib/cards.js';
import { CARD_ASPECT_HEIGHT_OVER_WIDTH } from '../../lib/play/play-config.js';
import {
  ATTRIBUTION_PRESENTATION,
  buildCardFaceModel,
  GLOSSARY_KIND_LABELS,
  TREATMENT_PRESENTATION,
  type BreakdownRow,
  type CharacteristicChange,
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
    why: 'A battlefield tile is ~96px wide (board-fit.css `--play-tile-w-max`). A full text box there is unreadable, and the aftermarket words are exactly the part that is visible nowhere else — the printed text is one hover away, the granted flying is not. The change chips are off for the same reason and lose nothing: a copy already wears the copied card’s art here, and the altered seal tells the player there is more to read one hover away.',
  }),
  full: Object.freeze({
    image: 'large',
    rules: 'full',
    chips: true,
    why: 'The hover/zoom face is where a player reads the card, so it carries the LIVE text box — the printed lines rendered as text (which is what makes every ability word hoverable at all) plus everything aftermarket.',
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

  return (
    <span
      className={classes}
      // tabIndex on a SPAN, not a <button> — see the module header: this face is
      // mounted inside a tile that is itself a button when selectable.
      tabIndex={hasPop ? 0 : undefined}
      {...(hasPop ? { 'aria-describedby': popId } : {})}
    >
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
      {hasPop && (
        <span className="card-face__pop" role="tooltip" id={popId}>
          {token.glossary && (
            <>
              <span className="card-face__pop-head">
                {token.glossary.term}
                <span className="card-face__pop-kind"> · {GLOSSARY_KIND_LABELS[token.glossary.kind]}</span>
              </span>
              <span className="card-face__pop-body">{token.glossary.text}</span>
              {/* Only the 36 engine-flag rows carry a rule number, and lane F's
                  test pins each against the repo's enforced KEYWORD_RULES. A row
                  without one prints none rather than a guess. */}
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
        </span>
      )}
    </span>
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
      <span className="card-face__pt-value" tabIndex={0} aria-describedby={popId} aria-label={pt.summary}>
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
      </span>
      <span className="card-face__pop card-face__pop--pt" role="tooltip" id={popId}>
        {pt.breakdown.map((part) => (
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
      </span>
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
    <span
      className={`card-face__chip card-face__chip--${change.region} card-face__chip--${treatment.modifier}`}
      tabIndex={0}
      aria-describedby={popId}
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
      <span className="card-face__pop" role="tooltip" id={popId}>
        <span className="card-face__pop-head">{change.label}</span>
        <span className="card-face__pop-body">
          {change.from !== undefined ? `Was ${change.from}. Now ${change.to}.` : `Now ${change.to}.`}
        </span>
        <span className="card-face__pop-source">{change.note.text}</span>
      </span>
    </span>
  );
}

/**
 * The lines a TILE shows: those the card does not already print.
 *
 * A tile has no room for a text box, and the printed text is one hover away —
 * the granted flying is not, which is the whole complaint UX-17 answers.
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

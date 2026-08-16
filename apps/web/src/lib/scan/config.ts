/**
 * Tunables for photo → decklist scanning. Every value that affects how the
 * scanner behaves lives here with the reasoning attached, so tuning the feature
 * is a data edit rather than a hunt through the algorithm (DESIGN §1.3: no
 * magic numbers).
 */

/** A Magic card is 63 × 88 mm, so its width:height ratio is fixed. */
export const CARD_ASPECT_RATIO = 63 / 88;

/**
 * How far a detected cell's aspect ratio may drift from a real card's before we
 * reject it. Photos are taken at an angle and cards overlap slightly, so this is
 * generous — its job is to throw out obvious non-cards (a whole table edge, a
 * hand, a shadow), not to enforce precision.
 */
export const ASPECT_RATIO_TOLERANCE = 0.45;

/**
 * The card name sits in the title bar across the top of the frame. OCR is far
 * more accurate on this thin strip than on the whole card, because the art and
 * rules text below it produce a lot of confident nonsense.
 *
 * Measured against the modern frame: the title bar occupies roughly the top 6%
 * to 15% of the card's height. We take a slightly wider band so a tilted photo
 * still contains the full name.
 */
export const TITLE_BAND_TOP = 0.04;
export const TITLE_BAND_BOTTOM = 0.17;

/**
 * Horizontal inset applied to the title band. The mana cost sits at the right
 * end of the title bar and OCRs as junk characters, so we trim it off; a small
 * left inset drops the rounded frame border.
 */
export const TITLE_BAND_LEFT_INSET = 0.05;
export const TITLE_BAND_RIGHT_INSET = 0.26;

/**
 * A column or row of the photo counts as "card" rather than "background" when
 * its pixel variance exceeds this fraction of the image's peak variance. Card
 * faces are busy (art, text, borders); a table or playmat between them is flat.
 */
export const CONTENT_VARIANCE_THRESHOLD = 0.18;

/**
 * Gaps narrower than this fraction OF ONE CARD are noise inside a card (an inner
 * frame line, a flat band of art) rather than a real separation between two
 * cards.
 *
 * THIS IS MEASURED AGAINST A CARD, NOT THE PHOTO, and that distinction is the
 * whole ballgame. An earlier version used a fraction of the image width: in a
 * ten-across layout that made the "narrow gap" threshold twice the real spacing
 * between cards, so every card in a row was bridged into a single band and the
 * scanner reported that it could not find any cards at all.
 */
export const INTERNAL_GAP_FRACTION = 0.03;

/**
 * The smallest run of content we keep, as a fraction of one card. Below this a
 * run is speckle — a shadow line, a sleeve edge — not part of a card.
 */
export const MIN_BAND_OF_CARD = 0.15;

/**
 * The most cards we will read out of a single unbroken band. Bounds the search
 * for the card size, and rejects "solutions" that explain a photo as hundreds of
 * tiny cards. A deck laid out for one photo is at most this many across.
 */
export const MAX_CARDS_PER_BAND = 20;

/**
 * The smallest a card may be, as a fraction of the photo's long edge. A card
 * smaller than this could not be read anyway, so a candidate layout implying one
 * is wrong by construction.
 */
export const MIN_CARD_EXTENT_FRACTION = 0.045;

/**
 * How badly the best card size may fit the observed bands before we give up and
 * ask for the layout. The residual is "how far the bands sit from a whole number
 * of card-widths", averaged per axis, so 0 is a perfect tiling; this bound
 * rejects a shape that is card-like on one axis but not the other (a table edge,
 * a hand, a strip of playmat).
 */
export const MAX_LAYOUT_RESIDUAL = 0.15;

/**
 * A candidate cell must carry at least this fraction of the busiest cell's
 * variance to count as holding a card. Decks rarely tile a photo exactly — the
 * last row is usually short — and without this the empty slots of a ragged final
 * row would be OCR'd as cards.
 */
export const MIN_CELL_OCCUPANCY = 0.15;

/**
 * The smallest fan offset we will believe, as a fraction of a card's height.
 * People fan a pile just far enough to read the name, so the real offset is
 * usually close to the title bar's own height; anything much tighter than this
 * is two edges of one card, not two cards.
 */
export const MIN_FAN_PITCH_OF_CARD = 0.05;

/**
 * How much two stripes' heights may differ and still both be title bars, as a
 * fraction of the taller. Every copy in a fan shows the same sliver of card, so
 * their stripes match closely; a card's art or a line of its rules text does not.
 */
export const STRIPE_HEIGHT_TOLERANCE = 0.4;

/**
 * How tall a stripe must be, as a fraction of a card, to be a WHOLE CARD FACE
 * rather than a title bar.
 *
 * Whether the bottom card of a pile shows up as one stripe or two depends on its
 * frame: if the line between its title bar and its art is crisp the two split,
 * and if it is not they merge into a single stripe as tall as the card. Both
 * happen on real photos, and the pile has to be counted correctly either way, so
 * the counter checks which it is looking at rather than assuming.
 */
export const FACE_CARD_MIN_OF_CARD = 0.5;

/**
 * How much consecutive fan offsets may differ and still be the same fan, as a
 * fraction of the larger. A pile is fanned in one motion, so its offsets are
 * regular — this is slack for a photo taken at an angle, not for a different
 * kind of spacing.
 *
 * Kept tight on purpose. The nearest competing rhythm is the step from a card's
 * last title bar down to the top of its art, which lands within about 30% of a
 * typical fan offset — so a looser bound swallows the art as another copy.
 */
export const FAN_PITCH_TOLERANCE = 0.2;

/**
 * Margin added around a detected title stripe before OCR, as a fraction of the
 * stripe's own height. The stripe is found by busyness, so it hugs the rows that
 * actually contain the letters — and OCR reads a line better with a little
 * quiet space above and below it than cropped flush to the glyphs.
 */
export const TITLE_STRIPE_PADDING = 0.4;

/**
 * How far apart two piles' tops may be, as a fraction of a card's height, and
 * still be read as the same ROW of piles. Only affects the order the review grid
 * lists them in, so it is deliberately loose.
 */
export const SAME_ROW_TOLERANCE_OF_CARD = 0.5;

/**
 * The most copies we will read out of one pile. A basic-land pile is the tall
 * one and it does not reach this; past it we are counting texture, not cards.
 */
export const MAX_COPIES_PER_STACK = 30;

/**
 * How many extra copies in a pile we will OCR to break a weak read of the
 * bottom card. Every copy in a pile is the SAME card, so a second and third
 * opinion is free accuracy — but only worth paying for when the first read was
 * not convincing.
 */
export const STACK_CONSENSUS_READS = 2;

/**
 * Target height, in pixels, for a title crop handed to OCR. Upscaling is chosen
 * to reach this rather than being a fixed factor, so a crop from a high-detail
 * photo is not needlessly blown up (slow, no extra information) and a crop from a
 * small one still gets enough pixels for the engine to find letter shapes.
 */
export const OCR_TARGET_TITLE_HEIGHT = 96;

/** Never upscale a title crop by more than this — past it there is no signal left to find. */
export const OCR_MAX_UPSCALE = 6;

/**
 * Minimum similarity (0–1) for an OCR result to be offered as a card-name
 * match at all. Below this the guess is worse than useless, and the review UI
 * shows "no match" so the user types it instead of un-picking a wrong card.
 */
export const MIN_MATCH_SCORE = 0.55;

/**
 * Similarity at or above which we treat a match as confident enough to preselect
 * without flagging it for attention. Everything between this and
 * {@link MIN_MATCH_SCORE} is preselected but highlighted for review.
 */
export const CONFIDENT_MATCH_SCORE = 0.82;

/** How many alternative names the review UI offers per detected card. */
export const MATCH_CANDIDATES = 4;

/**
 * Longest edge, in pixels, that a photo is decoded to.
 *
 * This is a legibility budget, not a memory one: a 60-card layout puts ten cards
 * across the long edge, so the title bar of each card is only about 1.3% of it.
 * At the 2000px this used to be, that left a title strip barely two dozen pixels
 * tall and OCR read mush. The detector's passes are linear in pixel count, so the
 * extra resolution costs a few tens of milliseconds and buys the accuracy the
 * whole feature depends on.
 */
export const MAX_IMAGE_EDGE = 3200;

/** Scryfall's catalog of every card name, used as the OCR correction vocabulary. */
export const CARD_NAMES_CATALOG_URL = 'https://api.scryfall.com/catalog/card-names';

/** localStorage key for the cached name catalog. */
export const CATALOG_STORAGE_KEY = 'jonny-boi:card-names:v1';

/**
 * How long a cached catalog stays fresh. New Magic sets arrive every few weeks,
 * so a week keeps names current without re-downloading on every scan.
 */
export const CATALOG_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

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
 * The smallest run of consecutive content columns/rows we will treat as a card
 * band, as a fraction of the image's width/height. Filters out speckle and
 * single-pixel noise lines without discarding a genuinely small card in a wide
 * shot.
 */
export const MIN_BAND_FRACTION = 0.04;

/**
 * Gaps narrower than this fraction are treated as noise inside one card rather
 * than a real separation between two cards — a card's own inner frame edges
 * would otherwise split it in half.
 */
export const MIN_GAP_FRACTION = 0.012;

/** Upscale factor applied to a title crop before OCR — small text reads better. */
export const OCR_UPSCALE = 3;

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

/** Scryfall's catalog of every card name, used as the OCR correction vocabulary. */
export const CARD_NAMES_CATALOG_URL = 'https://api.scryfall.com/catalog/card-names';

/** localStorage key for the cached name catalog. */
export const CATALOG_STORAGE_KEY = 'jonny-boi:card-names:v1';

/**
 * How long a cached catalog stays fresh. New Magic sets arrive every few weeks,
 * so a week keeps names current without re-downloading on every scan.
 */
export const CATALOG_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

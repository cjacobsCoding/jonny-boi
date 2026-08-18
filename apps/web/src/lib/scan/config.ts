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
 * People fan a pile far enough to read the name, so the real offset is at least
 * about the title bar's printed height (11.5% of the card). This floor also
 * rejects the HALF-RHYTHM that defeats a looser bound: each fanned sliver shows
 * two dark lines (the copy boundary and the title bar's own bottom frame line),
 * and reading that interleaved sequence as the fan doubles the count.
 */
export const MIN_FAN_PITCH_OF_CARD = 0.08;

/**
 * The largest fan offset we will believe, as a fraction of a card's height.
 * People fan a pile just far enough to read the names, so a step much past the
 * title bar's height is not another copy — it is the next pile, or the bottom
 * card's own insides.
 */
export const MAX_FAN_PITCH_OF_CARD = 0.3;

/**
 * Stripes in one column separated by less than this fraction of a card belong
 * to the SAME pile. The competing gaps differ by an order of magnitude: within
 * a pile the flat separators (a border line, a sleeve lip, the quiet lines of a
 * rules text box) are a few pixels, while the cloth between two rows of piles
 * is a good fraction of a card.
 */
export const PILE_GAP_OF_CARD = 0.15;

/**
 * The shortest run of content that can be a pile, as a fraction of a card's
 * height. A pile is AT LEAST one card tall; anything shorter is clutter that
 * happened to sit in a card-wide column — a deck box edge, a stray token.
 * Deliberately below 1.0 because a dark bottom border on dark cloth shaves the
 * observed height of a real card.
 */
export const MIN_PILE_HEIGHT_OF_CARD = 0.6;

/**
 * How deep a dip in a pile's brightness profile must be to count as the
 * boundary between two copies: the dip's floor must sit below this fraction of
 * the brighter of its neighbouring peaks. The boundary is a dark line (card
 * border plus sleeve edge) between two bright title bars, but glare on a
 * sleeved white-frame card can wash it out badly — measured on a real photo,
 * the faintest true boundary reached 0.77 of its neighbours.
 */
export const VALLEY_PROMINENCE = 0.8;

/**
 * The widest a copy boundary may be, as a fraction of a card's height. A
 * boundary is a LINE — border plus sleeve lip, a few pixels. A dark run wider
 * than this is card art or cloth, not a boundary.
 */
export const VALLEY_MAX_WIDTH_OF_CARD = 0.09;

/**
 * A row belongs to a TITLE PLATE when its mean brightness reaches this fraction
 * of the brightest row in the pile's fanned zone. The plate — the pale strip
 * the card's name is printed on — is the brightest thing in every fanned
 * sliver, whatever the card: measured on the real photo, plates held 80–100% of
 * their pile's peak while art, rules text and cloth fell well below, EXCEPT for
 * pale art (a golden temple, a green-lit beast), which is why plates are not
 * counted on brightness alone — see the pitch and valley rules that accompany
 * this in `stacks.ts`.
 */
export const PLATE_BRIGHTNESS_FRACTION = 0.8;

/**
 * Rows below the plate threshold interrupt a plate without ending it when the
 * run is at most this fraction of a card tall — the name's own dark glyphs and
 * a streak of shadow both carve notches into the plate's brightness.
 */
export const PLATE_GAP_BRIDGE_OF_CARD = 0.014;

/**
 * The shortest run of bright rows that counts as a plate, as a fraction of a
 * card. A nearly-flush copy can show a sliver of plate only a couple of pixels
 * tall, so this stays tiny; below it is a single noisy row, not a plate.
 */
export const MIN_PLATE_ROWS_OF_CARD = 0.008;

/**
 * A valley at least this deep (see `Valley.depth`) is a REAL dark line — a card
 * edge — and not a shading dip. Two rules key off it: a bright band is SPLIT in
 * two where such a valley crosses it (two nearly-flush copies), and a band too
 * close to its predecessor still counts as a copy when such a valley separates
 * them. Measured on the real photo: true edges reached 0.5–0.95, while shading
 * inside one card stayed at 0.2–0.48.
 */
export const SPLIT_VALLEY_DEPTH = 0.5;

/**
 * Plates closer together than this fraction of the photo's fan pitch cannot be
 * two copies — a fan's whole point is offsetting each copy by about a title
 * bar. The plate that fails this is the same copy's pale art showing under its
 * title, and is dropped. Exception: see {@link FLUSH_PLATE_FRACTION}.
 *
 * Spacing is measured between the plates' BRIGHTEST rows, not their first
 * bright rows — glare ramps a plate's leading edge upward and would fake a
 * too-close spacing for a genuine copy (it did, on the real photo's Banisher
 * Priest pile).
 */
export const CLOSE_PLATE_FRACTION = 0.7;

/**
 * Two copies slid almost flush show their plates nearly touching — far closer
 * than any fan offset — with the upper card's edge as a deep valley between
 * them. Below this fraction of the fan pitch, that deep valley outvotes
 * {@link CLOSE_PLATE_FRACTION} and both plates count. The escape stays this
 * tight because at ordinary close-but-not-flush spacings a deep valley proves
 * nothing: a dark-framed card's own title-bottom line can be just as deep as a
 * card edge (the real photo's Elvish Visionary pile), and looser escapes
 * counted its art as a copy.
 */
export const FLUSH_PLATE_FRACTION = 0.35;

/**
 * Sleeve glare above the first copy: an oversized sleeve catches light along
 * its rim, painting a bright line ABOVE the top card that reads as a plate.
 * That rim sits within this fraction of a card of the pile's top, so a band
 * that ends before a deep valley this close to the top is glare, not a copy.
 */
export const GLARE_CAP_OF_CARD = 0.06;

/**
 * Fallback fan pitch, as a fraction of a card, for a photo with too few piles
 * to measure its own pitch: about the printed title bar's height, which is what
 * people fan a pile to reveal.
 */
export const FALLBACK_PITCH_OF_CARD = 0.13;

/**
 * How far past its measured content a pile may claim copy plates, as a
 * fraction of a card. The pile's observed bottom underestimates the true one —
 * a black-bordered card's bottom border sinks into dark cloth entirely, which
 * on the real photo shaved 39px (0.16 of a card) off a Plains pile — so plates
 * may begin a little beyond `observedHeight - cardHeight`; past that they
 * cannot be a copy's title, because the copy would hang off the end of the
 * pile. Kept just above the observed worst case (0.183 of a card, the real
 * photo's Elvish Visionary pile): much looser and the bottom card's own pale
 * ART clears the bar too — it starts about 0.2 of a card below the bottom
 * card's top, and did on the real photo's Temple Garden pile.
 */
export const PILE_BOTTOM_SLACK_OF_CARD = 0.19;

/**
 * Horizontal inset, per side, of the strip used to measure a pile's brightness
 * profile, as a fraction of the column's width. The middle of the card carries
 * the title text and dodges both the rounded frame corners and the neighbour
 * pile's edge bleeding into a slightly-rotated column.
 */
export const PILE_PROFILE_INSET = 0.2;

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
 * not convincing. Counted over CROPS (each band contributes two, see
 * {@link TITLE_CROP_SHIFT_FRACTION}), so this covers the bottom card's second
 * crop plus the two crops of the next two copies.
 */
export const STACK_CONSENSUS_READS = 5;

/**
 * The down-shifted retry crop: the same title band moved down by this fraction
 * of its own height. The band hugs the plate's BRIGHT rows, but the name's dark
 * glyphs sit at (or just past) the plate's lower edge on a tilted photo, and
 * the shifted crop is the one that catches them whole.
 */
export const TITLE_CROP_SHIFT_FRACTION = 0.3;

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
 * Word-run queries shorter than this (in characters, normalized) are not
 * offered to the matcher: a stray two-letter word of OCR junk matches short
 * names at full score and would outvote the real, longer read.
 */
export const MIN_QUERY_LENGTH = 4;

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

/**
 * Types for the Scryfall pipeline: a minimal shape of the raw Scryfall card
 * objects we read, and the clean internal {@link NormalizedCard} the rest of
 * the monorepo consumes. The engine/UI depend only on `NormalizedCard` — never
 * on Scryfall's wire format.
 */

import { DEFAULT_IMAGE_SIZES } from './constants.js';

/** Scryfall image-size keys we know about. */
export type ScryfallImageSize = 'small' | 'normal' | 'large' | 'png' | 'art_crop' | 'border_crop';

/** Map of image-size key → URL, as Scryfall returns under `image_uris`. */
export type ScryfallImageUris = Partial<Record<ScryfallImageSize, string>>;

/**
 * The subset of a raw Scryfall card object we read. Scryfall returns far more
 * fields; we keep this loose (extra fields ignored) and tolerate missing ones.
 */
export interface RawScryfallCard {
  id?: string;
  oracle_id?: string;
  name: string;
  mana_cost?: string;
  cmc?: number;
  type_line?: string;
  oracle_text?: string;
  power?: string;
  toughness?: string;
  /** Planeswalkers: printed starting loyalty ("3", or "X" on a variable one). */
  loyalty?: string;
  /** Battles: printed starting defense ("4"). Scryfall's own field name. */
  defense?: string;
  colors?: string[];
  color_identity?: string[];
  keywords?: string[];
  set?: string;
  collector_number?: string;
  rarity?: string;
  image_uris?: ScryfallImageUris;
  /** Double-faced / multi-faced cards carry per-face data instead of top-level. */
  card_faces?: RawScryfallCardFace[];
  layout?: string;
}

/** A single face of a double-faced / multi-faced Scryfall card. */
export interface RawScryfallCardFace {
  name: string;
  mana_cost?: string;
  type_line?: string;
  oracle_text?: string;
  power?: string;
  toughness?: string;
  /**
   * A transforming planeswalker's / battle's printed number lives on the FACE,
   * not at the card level — Scryfall reports `defense: undefined` for
   * `Invasion of Gobakhan` and `'3'` on its battle face. The normalizer falls
   * back to the front face for exactly that reason.
   */
  loyalty?: string;
  defense?: string;
  colors?: string[];
  image_uris?: ScryfallImageUris;
}

/** The five WUBRG colors plus colorless (`C`) and generic mana. */
export interface ManaCost {
  /** Generic (numeric) mana, e.g. the `2` in `{2}{U}{U}`. */
  generic: number;
  W: number;
  U: number;
  B: number;
  R: number;
  G: number;
  /** Explicit colorless mana symbols (`{C}`), distinct from generic. */
  C: number;
  /**
   * Symbols we could not cleanly attribute to a single pip — hybrid `{W/U}`,
   * Phyrexian `{W/P}`, snow `{S}`, X, etc. Recorded verbatim so callers can
   * degrade gracefully rather than silently dropping cost information.
   */
  other: string[];
}

/** Parsed `type_line`, e.g. "Legendary Creature — Goblin Wizard". */
export interface ParsedTypeLine {
  supertypes: string[];
  types: string[];
  subtypes: string[];
}

/** Local filesystem paths for a downloaded image, keyed by size. */
export type LocalImagePaths = Partial<Record<(typeof DEFAULT_IMAGE_SIZES)[number], string>>;

/** Per-face normalized data for double-faced cards. */
export interface NormalizedCardFace {
  name: string;
  manaCost: ManaCost;
  typeLine: ParsedTypeLine;
  rawTypeLine: string;
  oracleText: string;
  power: number | null;
  toughness: number | null;
  colors: string[];
  imageUris: ScryfallImageUris;
}

/**
 * The clean internal card record. This is the heart of the package and the only
 * card shape the engine/UI consume.
 */
export interface NormalizedCard {
  /** Stable Scryfall oracle id when present, else the printing id, else name. */
  id: string;
  name: string;
  manaCost: ManaCost;
  cmc: number;
  typeLine: ParsedTypeLine;
  /** Original unparsed type line, kept for display/debugging. */
  rawTypeLine: string;
  oracleText: string;
  power: number | null;
  toughness: number | null;
  /**
   * Printed starting loyalty (planeswalkers), `null` otherwise or when variable
   * ("X"). Records written before this field existed simply lack it, which the
   * card compiler reads as "loyalty unknown — not playable until re-fetched".
   */
  loyalty?: number | null;
  /**
   * Printed starting defense (battles), `null` otherwise or when non-numeric.
   * The exact contract {@link NormalizedCard.loyalty} has, and for the same
   * reason: a battle entering with the wrong number of defense counters is a
   * different card, so the compiler reports a missing value rather than guessing.
   */
  defense?: number | null;
  colors: string[];
  colorIdentity: string[];
  keywords: string[];
  set: string;
  collectorNumber: string;
  rarity: string;
  /** Remote Scryfall image URLs by size (the front face for DFCs). */
  imageUris: ScryfallImageUris;
  /** Local cache paths for downloaded images, populated by the art downloader. */
  localImages: LocalImagePaths;
  /**
   * Scryfall's `layout` verbatim — `'normal'`, `'transform'`, `'modal_dfc'`,
   * `'split'`, `'adventure'`, … . It is the ONLY unambiguous statement of what
   * a multi-faced record MEANS: a split card and a modal DFC both print two
   * faces with two costs, and only the layout says whether they are two halves
   * of one object (CR 709) or two faces of one card (CR 712). The compiler
   * refuses to guess it from the name or the type line.
   *
   * Optional because the committed index predates the field; a record without
   * it falls back to the narrower keyword/face-shape detection the compiler
   * already had.
   */
  layout?: string;
  /** True when this card had `card_faces[]` (DFC / split / adventure / etc.). */
  isDoubleFaced: boolean;
  /** Per-face data when double-faced; empty otherwise. */
  faces: NormalizedCardFace[];
}

/** Result of resolving a batch of names against Scryfall. */
export interface FetchResult {
  /** Raw card objects that resolved. */
  cards: RawScryfallCard[];
  /** Names Scryfall could not resolve to a card. */
  unresolved: string[];
}

/**
 * The committed normalized index file format. Text-only — no embedded image
 * bytes. Others read this instead of re-fetching from Scryfall.
 */
export interface CardIndex {
  /** ISO timestamp of when the index was generated. */
  generatedAt: string;
  /** Attribution note (Scryfall etiquette — card data © Wizards, via Scryfall). */
  attribution: string;
  /** Number of names requested. */
  requested: number;
  /** Names that failed to resolve. */
  unresolved: string[];
  /** The normalized cards, sorted by name. */
  cards: NormalizedCard[];
}

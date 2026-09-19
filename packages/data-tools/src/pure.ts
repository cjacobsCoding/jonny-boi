/**
 * The BROWSER-SAFE subset of `@jonny-boi/data-tools`.
 *
 * The package's main entry also exports the fetch/cache pipeline, which imports
 * `node:fs` and friends — fine in the CLI, fatal in a browser bundle. The web
 * app needs only the pure pieces: the card types and the Scryfall → internal
 * normalizer. This module exposes exactly those, so the app can normalize cards
 * it fetched itself (deck import) without duplicating the parsing rules or
 * dragging Node APIs into the PWA bundle.
 *
 * Import it as `@jonny-boi/data-tools/pure`.
 */

export * from './types.js';
export { parseManaCost, parseTypeLine, parseStat } from './parse.js';
export { normalizeCard } from './normalize.js';
// §3.167 — the corpus tier's record shape and the image-URL derivation are
// pure too, and the app reads both.
export {
  buildCorpusIndex,
  serializeCorpusIndex,
  slimCard,
  SLIM_CARD_KEYS,
  SLIM_FACE_KEYS,
  type CorpusIndex,
  type SlimScryfallCard,
  type SlimScryfallCardFace,
} from './corpus-index.js';
export {
  SCRYFALL_IMAGE_ORIGIN,
  imageUrisAreDerivable,
  isScryfallUuid,
  scryfallImageUrl,
  stripImageQuery,
  type ScryfallFace,
  type ScryfallImageSize,
} from './scryfall-image.js';

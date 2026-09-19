/**
 * SCRYFALL IMAGE URLS ARE A FUNCTION OF THE PRINTING ID (§3.167).
 *
 * `https://cards.scryfall.io/<size>/<face>/<id[0]>/<id[1]>/<id>.jpg` — measured
 * true for every one of 5,000 corpus records checked against the URLs Scryfall
 * itself supplied. That is why neither the corpus tier nor (for derivable
 * records) the bundled pool index carries image URLs any more: they were 41% of
 * the pool index's bytes and said nothing the id did not.
 *
 * Only a PRINTING id (a Scryfall uuid) derives. The pool keeps 600-odd records
 * whose id is an ORACLE id from an older network fetch; those still carry their
 * URLs, and this returns `undefined` for them so `cardImage` falls back to what
 * the record says rather than inventing a 404.
 */
import type { ScryfallImageUris } from './types.js';

export const SCRYFALL_IMAGE_ORIGIN = 'https://cards.scryfall.io';

/** The sizes Scryfall serves under this scheme; the app displays four of them. */
export type ScryfallImageSize = 'small' | 'normal' | 'large' | 'art_crop' | 'png' | 'border_crop';

export type ScryfallFace = 'front' | 'back';

/** A Scryfall printing id: 8-4-4-4-12 hex. An oracle id has the same shape, hence the pool caveat above. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isScryfallUuid(id: string): boolean {
  return UUID.test(id);
}

/** The image URL for a printing, or `undefined` when the id is not a Scryfall uuid. */
export function scryfallImageUrl(
  printingId: string,
  size: ScryfallImageSize,
  face: ScryfallFace = 'front',
): string | undefined {
  if (!isScryfallUuid(printingId)) return undefined;
  const id = printingId.toLowerCase();
  const extension = size === 'png' ? 'png' : 'jpg';
  return `${SCRYFALL_IMAGE_ORIGIN}/${size}/${face}/${id[0]}/${id[1]}/${id}.${extension}`;
}

/** The URL a card's record would carry for `size`, with any cache-busting query removed. */
export function stripImageQuery(url: string): string {
  const at = url.indexOf('?');
  return at < 0 ? url : url.slice(0, at);
}

/**
 * True when every URL in `uris` is exactly what {@link scryfallImageUrl} would
 * derive for `printingId` — i.e. the record carries nothing the id does not.
 * The index projection drops such URLs; this is the one place that decides.
 */
export function imageUrisAreDerivable(
  printingId: string,
  uris: ScryfallImageUris,
  face: ScryfallFace = 'front',
): boolean {
  const entries = Object.entries(uris).filter(
    (entry): entry is [string, string] => typeof entry[1] === 'string',
  );
  if (entries.length === 0) return false;
  return entries.every(
    ([size, url]) =>
      stripImageQuery(url) === scryfallImageUrl(printingId, size as ScryfallImageSize, face),
  );
}

/**
 * Custom-art upload handling for the Proxies feature.
 *
 * Splits cleanly into a PURE validator ({@link validateUpload}) — tested with a
 * plain descriptor, no DOM — and a thin browser reader ({@link readImageAsDataUrl})
 * that turns an accepted `File` into a self-contained data URL for the override
 * model. A bad upload never crashes: the validator returns a reason string the
 * UI shows inline.
 */

import { ACCEPTED_UPLOAD_MIME_PREFIX, MAX_UPLOAD_BYTES } from './config.js';

/** The bits of a `File` the validator needs (also lets tests pass a plain object). */
export interface UploadDescriptor {
  type: string;
  size: number;
  name?: string;
}

/** Result of validating an upload: ok, or a human-readable reason it was rejected. */
export type UploadValidation = { ok: true } | { ok: false; reason: string };

/** Format a byte count as a compact MB string for messages. */
function formatMb(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Validate an upload against the accepted MIME prefix and the size cap. Pure and
 * synchronous — no file read — so it's trivially unit-testable and can gate the
 * (async) data-URL read.
 */
export function validateUpload(file: UploadDescriptor): UploadValidation {
  if (!file.type || !file.type.startsWith(ACCEPTED_UPLOAD_MIME_PREFIX)) {
    return {
      ok: false,
      reason: `That file isn’t an image (${file.type || 'unknown type'}). Upload a PNG or JPG.`,
    };
  }
  if (file.size <= 0) {
    return { ok: false, reason: 'That file is empty.' };
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    return {
      ok: false,
      reason: `That image is ${formatMb(file.size)} — the limit is ${formatMb(MAX_UPLOAD_BYTES)}.`,
    };
  }
  return { ok: true };
}

/**
 * Read an accepted image `File` as a data URL (base64). Rejects if the read
 * fails or yields a non-data-URL result. Browser-only side effect — kept out of
 * the pure validator so the model stays testable.
 */
export function readImageAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Could not read that file.'));
    reader.onload = () => {
      const result = reader.result;
      if (typeof result === 'string' && result.startsWith('data:')) resolve(result);
      else reject(new Error('That file could not be read as an image.'));
    };
    reader.readAsDataURL(file);
  });
}

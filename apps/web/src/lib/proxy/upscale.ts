/**
 * Optional print-quality upscaling for proxy art.
 *
 * ── Honesty note (read `ProxiesView` / the UI toggle too) ─────────────────────
 * A static, client-only PWA has no GPU server and no backend at runtime. A true
 * neural super-resolution model (ESRGAN via TensorFlow.js / UpscalerJS) would
 * add a heavy dependency and a multi-megabyte model download, with quality and
 * reliability we can't guarantee across the browsers this app targets. Per the
 * brief we do NOT ship a fake or half-working "AI upscale". Instead this is an
 * honest, dependency-free **high-quality canvas resample**: it redraws each card
 * at {@link UPSCALE_FACTOR}× using the browser's best (bicubic-class)
 * interpolation. It makes edges/text smoother for print — it is NOT AI and
 * invents no new detail. True AI upscaling belongs in the desktop tool or a
 * future backend service.
 *
 * This module is imported *dynamically* (only when the toggle is switched on) so
 * none of it — nor a canvas warm-up — weighs down the initial bundle.
 *
 * The dimension math is a pure, tested helper; the canvas draw is the browser
 * side effect, guarded so any failure falls back to the original image URL and
 * never a broken tile.
 */

import {
  UPSCALE_FACTOR,
  UPSCALE_OUTPUT_MIME,
  UPSCALE_SMOOTHING_QUALITY,
} from './config.js';

/** A width/height pair in device pixels. */
export interface Size {
  width: number;
  height: number;
}

/**
 * Compute the upscaled pixel size for a source image. Pure and defensive:
 * clamps to a positive integer grid and treats a non-finite / non-positive
 * factor or source as a 1× no-op rather than producing a zero/NaN canvas.
 */
export function computeUpscaledSize(source: Size, factor: number): Size {
  const safeFactor = Number.isFinite(factor) && factor > 0 ? factor : 1;
  const w = Number.isFinite(source.width) && source.width > 0 ? source.width : 0;
  const h = Number.isFinite(source.height) && source.height > 0 ? source.height : 0;
  return {
    width: Math.max(1, Math.round(w * safeFactor)),
    height: Math.max(1, Math.round(h * safeFactor)),
  };
}

/** Load an image with CORS enabled so the resulting canvas isn't tainted. */
function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    // Scryfall's image CDN serves `Access-Control-Allow-Origin: *`, so an
    // anonymous cross-origin load keeps the canvas exportable. Data-URL uploads
    // are same-origin and unaffected.
    img.crossOrigin = 'anonymous';
    img.decoding = 'async';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`Could not load image: ${url}`));
    img.src = url;
  });
}

/**
 * Upscale one image URL by {@link UPSCALE_FACTOR}× via a high-quality canvas
 * resample, returning a PNG data URL. On ANY failure (CORS taint, decode error,
 * unsupported canvas) it resolves to the ORIGINAL url — the print sheet always
 * gets a usable image, never a broken tile.
 */
export async function upscaleImageUrl(
  url: string,
  factor: number = UPSCALE_FACTOR,
): Promise<string> {
  try {
    const img = await loadImage(url);
    const source: Size = {
      width: img.naturalWidth || img.width,
      height: img.naturalHeight || img.height,
    };
    const target = computeUpscaledSize(source, factor);

    const canvas = document.createElement('canvas');
    canvas.width = target.width;
    canvas.height = target.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return url;

    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = UPSCALE_SMOOTHING_QUALITY;
    ctx.drawImage(img, 0, 0, target.width, target.height);

    // `toDataURL` throws (SecurityError) on a tainted canvas — caught below.
    const dataUrl = canvas.toDataURL(UPSCALE_OUTPUT_MIME);
    return dataUrl.startsWith('data:') ? dataUrl : url;
  } catch {
    return url; // Honest fallback: original image, never a broken tile.
  }
}

/**
 * Upscale a set of unique image URLs, reporting progress as each completes.
 * Returns a map from original URL → upscaled (or original, on failure) URL. The
 * caller de-dupes so each distinct card image is processed once.
 */
export async function upscaleAll(
  urls: readonly string[],
  onProgress?: (done: number, total: number) => void,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const unique = [...new Set(urls)];
  let done = 0;
  for (const url of unique) {
    out.set(url, await upscaleImageUrl(url));
    done += 1;
    onProgress?.(done, unique.length);
  }
  return out;
}

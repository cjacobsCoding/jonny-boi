/**
 * One safe way to put text on the clipboard.
 *
 * `navigator.clipboard` is absent on insecure origins (a LAN http:// deploy of
 * the PWA) and `writeText` REJECTS whenever the browser withholds permission —
 * most commonly when the document isn't focused. Calling it bare left an
 * unhandled promise rejection in the console and told the user nothing, so every
 * copy button goes through here instead: it resolves to whether the copy
 * actually happened and never rejects.
 */

/** The slice of the Clipboard API this module needs (also lets tests fake it). */
export interface ClipboardLike {
  writeText(text: string): Promise<void>;
}

/**
 * Copy `text` to the clipboard. Resolves `true` on success and `false` when the
 * clipboard is unavailable or the write was refused — never throws, never
 * leaves a dangling rejection.
 */
export async function copyText(
  text: string,
  clipboard: ClipboardLike | undefined = globalThis.navigator?.clipboard,
): Promise<boolean> {
  if (!clipboard || typeof clipboard.writeText !== 'function') return false;
  try {
    await clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

import { describe, expect, it, vi } from 'vitest';
import { copyText } from './clipboard.js';

describe('copyText', () => {
  it('writes the text and reports success', async () => {
    const writeText = vi.fn(async () => {});
    await expect(copyText('hello', { writeText })).resolves.toBe(true);
    expect(writeText).toHaveBeenCalledWith('hello');
  });

  // Regression: `navigator.clipboard.writeText(...)` was called bare, so a
  // refused write (document not focused, permission denied) surfaced as an
  // unhandled promise rejection in the console.
  it('reports failure instead of rejecting when the write is refused', async () => {
    const writeText = vi.fn(async () => {
      throw new Error('NotAllowedError');
    });
    await expect(copyText('hello', { writeText })).resolves.toBe(false);
  });

  it('reports failure when no clipboard is available (insecure origin)', async () => {
    await expect(copyText('hello', undefined)).resolves.toBe(false);
  });
});

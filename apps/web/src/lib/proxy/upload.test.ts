import { describe, expect, it } from 'vitest';
import { validateUpload } from './upload.js';
import { MAX_UPLOAD_BYTES } from './config.js';

describe('validateUpload', () => {
  it('accepts an image within the size cap', () => {
    expect(validateUpload({ type: 'image/png', size: 1024, name: 'a.png' })).toEqual({
      ok: true,
    });
    expect(validateUpload({ type: 'image/jpeg', size: MAX_UPLOAD_BYTES })).toEqual({
      ok: true,
    });
  });

  it('rejects a non-image MIME type', () => {
    const result = validateUpload({ type: 'application/pdf', size: 1024, name: 'a.pdf' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/isn’t an image/);
  });

  it('rejects a missing/unknown type', () => {
    expect(validateUpload({ type: '', size: 1024 }).ok).toBe(false);
  });

  it('rejects an empty file', () => {
    const result = validateUpload({ type: 'image/png', size: 0 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/empty/);
  });

  it('rejects a file over the size cap', () => {
    const result = validateUpload({ type: 'image/png', size: MAX_UPLOAD_BYTES + 1 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/limit is/);
  });
});

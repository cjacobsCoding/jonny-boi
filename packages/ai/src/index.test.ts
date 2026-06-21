import { describe, expect, it } from 'vitest';
import { PACKAGE_NAME } from './index.js';

describe('@jonny-boi/ai scaffold', () => {
  it('exposes its package name placeholder', () => {
    expect(PACKAGE_NAME).toBe('ai');
  });
});

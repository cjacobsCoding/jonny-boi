import { describe, expect, it } from 'vitest';
import { CORE_DEPENDENCY, PACKAGE_NAME } from './index.js';

describe('@jonny-boi/sim scaffold', () => {
  it('exposes its package name placeholder', () => {
    expect(PACKAGE_NAME).toBe('sim');
  });

  it('resolves the @jonny-boi/core workspace import', () => {
    expect(CORE_DEPENDENCY).toBe('core');
  });
});

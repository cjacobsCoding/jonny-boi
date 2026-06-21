import { describe, expect, it } from 'vitest';
import { PACKAGE_NAME as CORE_PACKAGE_NAME } from '@jonny-boi/core';

describe('@jonny-boi/web scaffold', () => {
  it('resolves the @jonny-boi/core workspace import the shell renders', () => {
    expect(CORE_PACKAGE_NAME).toBe('core');
  });
});

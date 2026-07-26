import { describe, expect, it } from 'vitest';
import { CORE_PACKAGE_NAME } from '../src/index.ts';

describe('package scaffold', () => {
  it('exposes the package entry point', () => {
    expect(CORE_PACKAGE_NAME).toBe('@doccloak/core');
  });
});

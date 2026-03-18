import { describe, it, expect } from 'vitest';
import { CARTOGRAPHER_CLIENT_KEY, CARTOGRAPHER_STATE_KEY } from './context.js';

describe('context', () => {
  it('exports unique context keys', () => {
    expect(CARTOGRAPHER_CLIENT_KEY).toBeDefined();
    expect(CARTOGRAPHER_STATE_KEY).toBeDefined();
    expect(CARTOGRAPHER_CLIENT_KEY).not.toBe(CARTOGRAPHER_STATE_KEY);
  });
});

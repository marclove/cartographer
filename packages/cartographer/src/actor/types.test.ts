import { describe, it, expect } from 'vitest';
import { generateMessageId } from './types.js';

describe('generateMessageId', () => {
  it('produces unique IDs', () => {
    const a = generateMessageId();
    const b = generateMessageId();
    expect(a).not.toBe(b);
  });

  it('starts with msg- prefix', () => {
    expect(generateMessageId()).toMatch(/^msg-/);
  });
});

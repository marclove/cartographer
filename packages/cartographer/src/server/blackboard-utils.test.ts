import { describe, it, expect } from 'vitest';
import { blackboardToRecord } from './blackboard-utils.js';

describe('blackboardToRecord', () => {
  it('converts a blackboard with keys/get to a plain record', () => {
    const bb = {
      keys: () => ['a', 'b'],
      get: (key: string) => (key === 'a' ? 1 : 2),
    };
    expect(blackboardToRecord(bb)).toEqual({ a: 1, b: 2 });
  });

  it('uses toRecord() when available', () => {
    const bb = {
      keys: () => ['a'],
      get: () => 'fallback',
      toRecord: () => ({ x: 'preferred' }),
    };
    expect(blackboardToRecord(bb)).toEqual({ x: 'preferred' });
  });
});

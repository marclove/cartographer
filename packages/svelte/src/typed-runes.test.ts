import { describe, it, expect, expectTypeOf } from 'vitest';
import { z } from 'zod/v4';
import { createTypedRunes } from './typed-runes.js';
import type { BlackboardRef, BlackboardSnapshotRef } from './blackboard.svelte.js';

// Inline schema matching what createBlackboardSchema produces
const schema = {
  rootEntries: { task: z.string(), count: z.number() },
  scopeEntries: { analyst: { output: z.object({ summary: z.string() }) } },
  validate: false,
  _input: {
    task: z.string(),
    count: z.number(),
    analyst: { output: z.object({ summary: z.string() }) },
  },
} as const;

describe('createTypedRunes', () => {
  it('returns an object with getBlackboard and getBlackboardSnapshot', () => {
    const runes = createTypedRunes(schema);
    expect(runes).toHaveProperty('getBlackboard');
    expect(runes).toHaveProperty('getBlackboardSnapshot');
    expect(typeof runes.getBlackboard).toBe('function');
    expect(typeof runes.getBlackboardSnapshot).toBe('function');
  });
});

describe('createTypedRunes type-level', () => {
  const { getBlackboard, getBlackboardSnapshot } = createTypedRunes(schema);

  it('getBlackboard infers return type from root key', () => {
    type TaskRef = ReturnType<typeof getBlackboard<'task'>>;
    expectTypeOf<TaskRef>().toMatchTypeOf<BlackboardRef<string>>();

    type CountRef = ReturnType<typeof getBlackboard<'count'>>;
    expectTypeOf<CountRef>().toMatchTypeOf<BlackboardRef<number>>();
  });

  it('getBlackboardSnapshot returns BlackboardSnapshotRef', () => {
    type Snapshot = ReturnType<typeof getBlackboardSnapshot>;
    expectTypeOf<Snapshot>().toMatchTypeOf<BlackboardSnapshotRef>();
  });
});

describe('package exports', () => {
  it('exports createTypedRunes from package index', async () => {
    const mod = await import('./index.js');
    expect(mod.createTypedRunes).toBeDefined();
  });
});

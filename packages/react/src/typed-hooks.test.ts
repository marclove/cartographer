import { describe, it, expect, expectTypeOf } from 'vitest';
import { z } from 'zod/v4';
import { createBlackboardSchema } from '../../cartographer/src/core/blackboard-schema.js';
import { createTypedHooks } from './typed-hooks.js';

const schema = createBlackboardSchema({
  task: z.string(),
  count: z.number(),
  analyst: { output: z.object({ summary: z.string() }) },
});

describe('createTypedHooks', () => {
  it('returns an object with useBlackboard and useBlackboardSnapshot', () => {
    const hooks = createTypedHooks(schema);
    expect(hooks).toHaveProperty('useBlackboard');
    expect(hooks).toHaveProperty('useBlackboardSnapshot');
    expect(typeof hooks.useBlackboard).toBe('function');
    expect(typeof hooks.useBlackboardSnapshot).toBe('function');
  });
});

describe('createTypedHooks type-level', () => {
  const { useBlackboard } = createTypedHooks(schema);

  it('useBlackboard infers return type from root key', () => {
    type TaskReturn = ReturnType<typeof useBlackboard<'task'>>;
    expectTypeOf<TaskReturn>().toEqualTypeOf<[string | undefined, (value: string) => Promise<void>]>();

    type CountReturn = ReturnType<typeof useBlackboard<'count'>>;
    expectTypeOf<CountReturn>().toEqualTypeOf<[number | undefined, (value: number) => Promise<void>]>();
  });
});

describe('package exports', () => {
  it('exports createTypedHooks from package index', async () => {
    const mod = await import('./index.js');
    expect(mod.createTypedHooks).toBeDefined();
  });
});

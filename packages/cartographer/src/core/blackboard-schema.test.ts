import { describe, it, expect, expectTypeOf } from 'vitest';
import { z } from 'zod/v4';
import { createBlackboardSchema } from './blackboard-schema.js';

describe('createBlackboardSchema', () => {
  it('creates a schema from flat Zod definitions', () => {
    const schema = createBlackboardSchema({
      task: z.string(),
      count: z.number(),
    });
    expect(schema).toBeDefined();
    expect(schema.rootEntries).toHaveProperty('task');
    expect(schema.rootEntries).toHaveProperty('count');
  });

  it('separates root keys from scope definitions', () => {
    const schema = createBlackboardSchema({
      task: z.string(),
      analyst: {
        output: z.string(),
        confidence: z.number(),
      },
    });
    expect(Object.keys(schema.rootEntries)).toEqual(['task']);
    expect(Object.keys(schema.scopeEntries)).toEqual(['analyst']);
    expect(schema.scopeEntries.analyst).toHaveProperty('output');
    expect(schema.scopeEntries.analyst).toHaveProperty('confidence');
  });

  it('stores validate option (defaults to false)', () => {
    const schema = createBlackboardSchema({ task: z.string() });
    expect(schema.validate).toBe(false);
  });

  it('stores validate option when true', () => {
    const schema = createBlackboardSchema({ task: z.string() }, { validate: true });
    expect(schema.validate).toBe(true);
  });

  it('handles schema with only scopes and no root keys', () => {
    const schema = createBlackboardSchema({
      analyst: { output: z.string() },
      reviewer: { feedback: z.string() },
    });
    expect(Object.keys(schema.rootEntries)).toEqual([]);
    expect(Object.keys(schema.scopeEntries)).toEqual(['analyst', 'reviewer']);
  });

  it('handles schema with only root keys and no scopes', () => {
    const schema = createBlackboardSchema({
      task: z.string(),
      decision: z.string(),
    });
    expect(Object.keys(schema.rootEntries)).toEqual(['task', 'decision']);
    expect(Object.keys(schema.scopeEntries)).toEqual([]);
  });
});

describe('BlackboardSchema type-level', () => {
  it('infers root key types from Zod definitions', () => {
    const schema = createBlackboardSchema({
      task: z.string(),
      count: z.number(),
      data: z.object({ summary: z.string(), confidence: z.number() }),
    });

    type Root = typeof schema.rootEntries;
    expectTypeOf<Root>().toHaveProperty('task');
    expectTypeOf<Root>().toHaveProperty('count');
    expectTypeOf<Root>().toHaveProperty('data');
  });

  it('infers scope entry types', () => {
    const schema = createBlackboardSchema({
      analyst: {
        output: z.object({ summary: z.string() }),
      },
    });

    type Scopes = typeof schema.scopeEntries;
    expectTypeOf<Scopes>().toHaveProperty('analyst');
  });
});

describe('package exports', () => {
  it('exports createBlackboardSchema from package index', async () => {
    const mod = await import('../index.js');
    expect(mod.createBlackboardSchema).toBeDefined();
  });

  it('exports createTypedBlackboard from package index', async () => {
    const mod = await import('../index.js');
    expect(mod.createTypedBlackboard).toBeDefined();
  });

  it('exports BlackboardValidationError from package index', async () => {
    const mod = await import('../index.js');
    expect(mod.BlackboardValidationError).toBeDefined();
  });
});

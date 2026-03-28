import { describe, it, expect, expectTypeOf } from 'vitest';
import { z } from 'zod/v4';
import { createBlackboardSchema } from './blackboard-schema.js';
import { createTypedBlackboard, BlackboardValidationError } from './typed-blackboard.js';
import { InMemoryBlackboard } from './blackboard.js';
import type { Blackboard } from '../types.js';

const schema = createBlackboardSchema({
  task: z.string(),
  count: z.number(),
  data: z.object({ summary: z.string(), confidence: z.number() }),
  analyst: {
    output: z.string(),
    sources: z.array(z.string()),
  },
  reviewer: {
    feedback: z.string(),
    approved: z.boolean(),
  },
});

const validatedSchema = createBlackboardSchema({
  task: z.string(),
  count: z.number(),
  analyst: {
    output: z.string(),
  },
}, { validate: true });

describe('createTypedBlackboard', () => {
  it('creates a TypedBlackboard with a default InMemoryBlackboard', () => {
    const bb = createTypedBlackboard(schema);
    expect(bb).toBeDefined();
  });

  it('wraps an existing Blackboard instance', () => {
    const inner = new InMemoryBlackboard({ task: 'existing' });
    const bb = createTypedBlackboard(schema, inner);
    expect(bb.get('task')).toBe('existing');
  });
});

describe('TypedBlackboard root operations', () => {
  it('get and set work for root keys', () => {
    const bb = createTypedBlackboard(schema);
    bb.set('task', 'hello');
    expect(bb.get('task')).toBe('hello');
  });

  it('get returns undefined for unset keys', () => {
    const bb = createTypedBlackboard(schema);
    expect(bb.get('task')).toBeUndefined();
  });

  it('has checks key existence', () => {
    const bb = createTypedBlackboard(schema);
    bb.set('task', 'test');
    expect(bb.has('task')).toBe(true);
    expect(bb.has('count')).toBe(false);
  });

  it('delete removes a key', () => {
    const bb = createTypedBlackboard(schema);
    bb.set('task', 'test');
    bb.delete('task');
    expect(bb.has('task')).toBe(false);
  });

  it('keys returns all keys', () => {
    const bb = createTypedBlackboard(schema);
    bb.set('task', 'test');
    bb.set('count', 5);
    expect(bb.keys().sort()).toEqual(['count', 'task']);
  });

  it('getMany returns values for multiple keys', () => {
    const bb = createTypedBlackboard(schema);
    bb.set('task', 'test');
    bb.set('count', 5);
    expect(bb.getMany(['task', 'count'])).toEqual({ task: 'test', count: 5 });
  });

  it('setMany writes multiple keys', () => {
    const bb = createTypedBlackboard(schema);
    bb.setMany({ task: 'test', count: 5 });
    expect(bb.get('task')).toBe('test');
    expect(bb.get('count')).toBe(5);
  });

  it('deleteMany removes multiple keys', () => {
    const bb = createTypedBlackboard(schema);
    bb.set('task', 'test');
    bb.set('count', 5);
    bb.deleteMany(['task', 'count']);
    expect(bb.has('task')).toBe(false);
    expect(bb.has('count')).toBe(false);
  });

  it('handles complex object values', () => {
    const bb = createTypedBlackboard(schema);
    const obj = { summary: 'good', confidence: 0.95 };
    bb.set('data', obj);
    expect(bb.get('data')).toEqual(obj);
  });
});

describe('TypedBlackboard scoped operations', () => {
  it('scoped returns typed view for known scope', () => {
    const bb = createTypedBlackboard(schema);
    const analyst = bb.scoped('analyst');
    analyst.set('output', 'result');
    expect(analyst.get('output')).toBe('result');
  });

  it('scoped view is isolated from root', () => {
    const bb = createTypedBlackboard(schema);
    bb.set('task', 'root-task');
    const analyst = bb.scoped('analyst');
    analyst.set('output', 'scoped-output');
    expect(bb.keys()).toContain('task');
  });

  it('scoped for unknown namespace returns untyped Blackboard', () => {
    const bb = createTypedBlackboard(schema);
    const unknown = bb.scoped('unknown');
    unknown.set('anything', 42);
    expect(unknown.get('anything')).toBe(42);
  });

  it('different scopes have independent typed views', () => {
    const bb = createTypedBlackboard(schema);
    const analyst = bb.scoped('analyst');
    const reviewer = bb.scoped('reviewer');

    analyst.set('output', 'analysis result');
    reviewer.set('feedback', 'looks good');

    expect(analyst.get('output')).toBe('analysis result');
    expect(reviewer.get('feedback')).toBe('looks good');
  });
});

describe('TypedBlackboard implements Blackboard interface', () => {
  it('can be assigned to Blackboard type', () => {
    const bb = createTypedBlackboard(schema);
    const untyped: Blackboard = bb;
    untyped.set('task', 'via-untyped');
    expect(untyped.get('task')).toBe('via-untyped');
  });
});

describe('TypedBlackboard type-level', () => {
  it('get returns the correct inferred type', () => {
    const bb = createTypedBlackboard(schema);
    const task = bb.get('task');
    expectTypeOf(task).toEqualTypeOf<string | undefined>();

    const count = bb.get('count');
    expectTypeOf(count).toEqualTypeOf<number | undefined>();

    const data = bb.get('data');
    expectTypeOf(data).toEqualTypeOf<{ summary: string; confidence: number } | undefined>();
  });

  it('set enforces value type', () => {
    const bb = createTypedBlackboard(schema);
    bb.set('task', 'hello');
    bb.set('count', 42);
    bb.set('data', { summary: 'ok', confidence: 0.9 });
  });

  it('scoped get returns the correct type for scope keys', () => {
    const bb = createTypedBlackboard(schema);
    const analyst = bb.scoped('analyst');
    const output = analyst.get('output');
    expectTypeOf(output).toEqualTypeOf<string | undefined>();

    const sources = analyst.get('sources');
    expectTypeOf(sources).toEqualTypeOf<string[] | undefined>();
  });

  it('scoped set enforces scope value types', () => {
    const bb = createTypedBlackboard(schema);
    const reviewer = bb.scoped('reviewer');
    reviewer.set('feedback', 'good work');
    reviewer.set('approved', true);
  });
});

describe('TypedBlackboard runtime validation', () => {
  it('throws BlackboardValidationError on invalid set when validate is true', () => {
    const bb = createTypedBlackboard(validatedSchema);
    expect(() => bb.set('task', 42 as any)).toThrow(BlackboardValidationError);
  });

  it('BlackboardValidationError contains key, value, and issues', () => {
    const bb = createTypedBlackboard(validatedSchema);
    try {
      bb.set('task', 42 as any);
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(BlackboardValidationError);
      const validationErr = err as BlackboardValidationError;
      expect(validationErr.key).toBe('task');
      expect(validationErr.value).toBe(42);
      expect(validationErr.issues.length).toBeGreaterThan(0);
    }
  });

  it('does not throw for valid values when validate is true', () => {
    const bb = createTypedBlackboard(validatedSchema);
    expect(() => bb.set('task', 'valid string')).not.toThrow();
    expect(() => bb.set('count', 42)).not.toThrow();
  });

  it('validates setMany entries individually', () => {
    const bb = createTypedBlackboard(validatedSchema);
    expect(() => bb.setMany({ task: 123 })).toThrow(BlackboardValidationError);
  });

  it('does not throw when validate is false (default)', () => {
    const bb = createTypedBlackboard(schema);
    expect(() => bb.set('task', 42 as any)).not.toThrow();
  });

  it('passes through unknown keys without validation', () => {
    const bb = createTypedBlackboard(validatedSchema);
    (bb as Blackboard).set('unknown_key', { anything: true });
    expect((bb as Blackboard).get('unknown_key')).toEqual({ anything: true });
  });

  it('validates scoped writes when validate is true', () => {
    const bb = createTypedBlackboard(validatedSchema);
    const analyst = bb.scoped('analyst');
    expect(() => analyst.set('output', 123 as any)).toThrow(BlackboardValidationError);
    expect(() => analyst.set('output', 'valid')).not.toThrow();
  });
});

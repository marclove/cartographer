import type { z } from 'zod/v4';
import type { Blackboard } from '../types.js';
import type { BlackboardSchema, SchemaInput } from './blackboard-schema.js';
import { InMemoryBlackboard } from './blackboard.js';

/** A single Zod validation issue. */
interface ValidationIssue {
  code: string;
  message: string;
  path: (string | number)[];
}

/**
 * Error thrown when a blackboard write fails runtime validation.
 *
 * Only thrown when the schema's `validate` option is `true`.
 */
export class BlackboardValidationError extends Error {
  constructor(
    /** The blackboard key that failed validation. */
    public readonly key: string,
    /** The value that was rejected. */
    public readonly value: unknown,
    /** Zod validation issues describing what went wrong. */
    public readonly issues: readonly ValidationIssue[],
  ) {
    const issueText = issues.map((i) => i.message).join('; ');
    super(`Blackboard validation failed for key "${key}": ${issueText}`);
    this.name = 'BlackboardValidationError';
  }
}

/**
 * A type-safe blackboard wrapper that constrains keys and value types
 * based on a {@link BlackboardSchema}.
 *
 * Delegates all operations to a wrapped {@link Blackboard} instance.
 * When `validate` is enabled on the schema, `set()` and `setMany()`
 * run values through the corresponding Zod schema and throw
 * {@link BlackboardValidationError} on mismatch.
 *
 * Implements the {@link Blackboard} interface so it can be passed
 * anywhere a plain blackboard is expected.
 */
class TypedBlackboard<T extends SchemaInput> implements Blackboard {
  constructor(
    private readonly schema: BlackboardSchema<T>,
    private readonly inner: Blackboard,
  ) {}

  get<V>(key: string): V | undefined {
    return this.inner.get<V>(key);
  }

  set<V>(key: string, value: V): void {
    this._validateKey(key, value);
    this.inner.set(key, value);
  }

  has(key: string): boolean {
    return this.inner.has(key);
  }

  delete(key: string): void {
    this.inner.delete(key);
  }

  keys(): string[] {
    return this.inner.keys();
  }

  getMany(keys: string[]): Record<string, unknown> {
    return this.inner.getMany(keys);
  }

  setMany(entries: Record<string, unknown>): void {
    if (this.schema.validate) {
      for (const [key, value] of Object.entries(entries)) {
        this._validateKey(key, value);
      }
    }
    this.inner.setMany(entries);
  }

  deleteMany(keys: string[]): void {
    this.inner.deleteMany(keys);
  }

  scoped(namespace: string): Blackboard {
    const innerScoped = this.inner.scoped(namespace);
    const scopeDefs = (this.schema.scopeEntries as Record<string, Record<string, z.ZodType>>)[
      namespace
    ];

    if (scopeDefs) {
      const scopeSchema: BlackboardSchema<any> = {
        rootEntries: scopeDefs,
        scopeEntries: {},
        validate: this.schema.validate,
        _input: scopeDefs,
      };
      return new TypedBlackboard(scopeSchema, innerScoped);
    }

    return innerScoped;
  }

  private _validateKey(key: string, value: unknown): void {
    if (!this.schema.validate) return;

    const zodSchema = (this.schema.rootEntries as Record<string, z.ZodType>)[key];
    if (!zodSchema) return;

    const result = zodSchema.safeParse(value);
    if (!result.success) {
      throw new BlackboardValidationError(
        key,
        value,
        result.error.issues as unknown as ValidationIssue[],
      );
    }
  }
}

/**
 * Create a type-safe blackboard wrapper from a schema.
 *
 * @param schema - The blackboard schema created via `createBlackboardSchema`.
 * @param inner - An existing `Blackboard` instance to wrap. Defaults to a new `InMemoryBlackboard`.
 * @returns A typed blackboard that constrains keys and types based on the schema.
 *
 * @example
 * ```ts
 * const bb = createTypedBlackboard(schema);
 * bb.get('task');       // string | undefined
 * bb.set('task', 42);  // compile error
 *
 * const analyst = bb.scoped('analyst');
 * analyst.get('output'); // typed per scope definition
 * ```
 */
export function createTypedBlackboard<T extends SchemaInput>(
  schema: BlackboardSchema<T>,
  inner?: Blackboard,
): Blackboard {
  return new TypedBlackboard(schema, inner ?? new InMemoryBlackboard());
}

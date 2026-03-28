import type { z } from 'zod/v4';

/**
 * The input format for {@link createBlackboardSchema}.
 *
 * - Entries whose value is a `z.ZodType` define **root keys**.
 * - Entries whose value is a plain object of `z.ZodType` values define **scopes**.
 *
 * Discrimination uses `instanceof z.ZodType` at runtime and conditional
 * types at the type level.
 */
export type SchemaInput = Record<string, z.ZodType | Record<string, z.ZodType>>;

/**
 * Extract only the root-key entries (values that are ZodType instances).
 */
type ExtractRootEntries<T extends SchemaInput> = {
  [K in keyof T as T[K] extends z.ZodType ? K : never]: T[K] & z.ZodType;
};

/**
 * Extract only the scope entries (values that are plain objects of ZodType).
 */
type ExtractScopeEntries<T extends SchemaInput> = {
  [K in keyof T as T[K] extends z.ZodType ? never : K]: T[K] & Record<string, z.ZodType>;
};

/**
 * The schema object returned by {@link createBlackboardSchema}.
 *
 * Carries the Zod definitions for root keys and scoped namespaces, plus
 * the `validate` flag for runtime checking.
 */
export interface BlackboardSchema<T extends SchemaInput> {
  /** Zod schemas for root-level blackboard keys. */
  readonly rootEntries: ExtractRootEntries<T>;
  /** Zod schemas grouped by scope name. */
  readonly scopeEntries: ExtractScopeEntries<T>;
  /** When true, TypedBlackboard validates writes at runtime. */
  readonly validate: boolean;
  /** The raw input for introspection (e.g., MCP description generation). */
  readonly _input: T;
}

/** Options for {@link createBlackboardSchema}. */
export interface BlackboardSchemaOptions {
  /** Enable runtime validation on set/setMany. Defaults to false. */
  validate?: boolean;
}

/**
 * Create a typed blackboard schema from a Zod-based key-type map.
 *
 * Entries with `z.ZodType` values become root keys. Entries with plain
 * object values become scoped namespaces. This discrimination happens
 * at both the type level and at runtime via duck-typing (`_zod` property).
 *
 * @example
 * ```ts
 * const schema = createBlackboardSchema({
 *   task: z.string(),
 *   analyst: {
 *     analysis: z.object({ summary: z.string(), confidence: z.number() }),
 *   },
 * }, { validate: true });
 * ```
 */
export function createBlackboardSchema<T extends SchemaInput>(
  input: T,
  options?: BlackboardSchemaOptions,
): BlackboardSchema<T> {
  const rootEntries: Record<string, z.ZodType> = {};
  const scopeEntries: Record<string, Record<string, z.ZodType>> = {};

  for (const [key, value] of Object.entries(input)) {
    if (isZodType(value)) {
      rootEntries[key] = value;
    } else {
      scopeEntries[key] = value as Record<string, z.ZodType>;
    }
  }

  return {
    rootEntries: rootEntries as ExtractRootEntries<T>,
    scopeEntries: scopeEntries as ExtractScopeEntries<T>,
    validate: options?.validate ?? false,
    _input: input,
  };
}

/**
 * Check whether a value is a Zod schema instance.
 *
 * Zod v4 schemas have a `_zod` property. This is more reliable than
 * `instanceof` across module boundaries.
 */
function isZodType(value: unknown): value is z.ZodType {
  return (
    typeof value === 'object' &&
    value !== null &&
    '_zod' in value
  );
}

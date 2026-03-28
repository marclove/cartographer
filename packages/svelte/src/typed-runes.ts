import type { z } from 'zod/v4';
import type { BlackboardSchema, SchemaInput } from 'cartographer';
import {
  getBlackboard as getBlackboardUntyped,
  getBlackboardSnapshot,
} from './blackboard.svelte.js';
import type { BlackboardRef, BlackboardSnapshotRef } from './blackboard.svelte.js';

/**
 * Extract the root key names from a schema input type.
 */
type RootKeys<T extends SchemaInput> = {
  [K in keyof T as T[K] extends z.ZodType ? K : never]: T[K];
};

/**
 * Infer the value type for a root key.
 */
type InferValue<T extends SchemaInput, K extends keyof RootKeys<T>> =
  T[K] extends z.ZodType ? z.infer<T[K]> : never;

/**
 * The typed `getBlackboard` rune returned by {@link createTypedRunes}.
 */
interface TypedGetBlackboard<T extends SchemaInput> {
  <K extends keyof RootKeys<T> & string>(key: K): BlackboardRef<InferValue<T, K>>;
}

/**
 * Create typed versions of the Svelte blackboard runes.
 *
 * The returned runes constrain keys and infer value types from the
 * schema at compile time. At runtime they delegate to the same
 * underlying untyped runes — the schema is used only for its type
 * parameter.
 *
 * @example
 * ```ts
 * // src/runes.ts
 * import { createTypedRunes } from '@cartographer/svelte';
 * import { schema } from './schema.js';
 * export const { getBlackboard, getBlackboardSnapshot } = createTypedRunes(schema);
 *
 * // In a component:
 * const feedback = getBlackboard('feedback');
 * feedback.value; // string | undefined
 * ```
 */
export function createTypedRunes<T extends SchemaInput>(
  _schema: BlackboardSchema<T>,
): {
  getBlackboard: TypedGetBlackboard<T>;
  getBlackboardSnapshot: () => BlackboardSnapshotRef;
} {
  return {
    getBlackboard: ((key: string) => getBlackboardUntyped(key)) as TypedGetBlackboard<T>,
    getBlackboardSnapshot,
  };
}

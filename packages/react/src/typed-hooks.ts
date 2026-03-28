import type { z } from 'zod/v4';
import type { BlackboardSchema, SchemaInput } from 'cartographer';
import { useBlackboard as useBlackboardUntyped, useBlackboardSnapshot } from './hooks.js';

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
 * The typed `useBlackboard` hook returned by {@link createTypedHooks}.
 */
interface TypedUseBlackboard<T extends SchemaInput> {
  <K extends keyof RootKeys<T> & string>(key: K): [
    InferValue<T, K> | undefined,
    (value: InferValue<T, K>) => Promise<void>,
  ];
}

/**
 * Create typed versions of the React blackboard hooks.
 *
 * The returned hooks constrain keys and infer value types from the
 * schema at compile time. At runtime they delegate to the same
 * underlying untyped hooks — the schema is used only for its type
 * parameter.
 *
 * @example
 * ```tsx
 * // src/hooks.ts
 * import { createTypedHooks } from '@cartographer/react';
 * import { schema } from './schema.js';
 * export const { useBlackboard, useBlackboardSnapshot } = createTypedHooks(schema);
 *
 * // src/components/Panel.tsx
 * import { useBlackboard } from '../hooks.js';
 * const [task, setTask] = useBlackboard('task'); // string | undefined
 * ```
 */
export function createTypedHooks<T extends SchemaInput>(
  _schema: BlackboardSchema<T>,
): {
  useBlackboard: TypedUseBlackboard<T>;
  useBlackboardSnapshot: typeof useBlackboardSnapshot;
} {
  return {
    useBlackboard: ((key: string) => useBlackboardUntyped(key)) as TypedUseBlackboard<T>,
    useBlackboardSnapshot,
  };
}

import type { z } from 'zod/v4';
import type {
  TreeContext, NodeStatus, SelectionStrategy, ExecutionStrategy, ParallelStrategy,
} from '../types.js';

type ActionFn = (context: TreeContext) => Promise<NodeStatus> | NodeStatus;
type ConditionFn = (context: TreeContext) => Promise<boolean> | boolean;
type AnyStrategy = SelectionStrategy | ExecutionStrategy | ParallelStrategy;

export class TreeRegistry {
  private actions = new Map<string, ActionFn>();
  private conditions = new Map<string, ConditionFn>();
  private schemas = new Map<string, z.ZodType>();
  private strategies = new Map<string, AnyStrategy>();

  registerAction(name: string, fn: ActionFn): void {
    this.actions.set(name, fn);
  }

  registerCondition(name: string, fn: ConditionFn): void {
    this.conditions.set(name, fn);
  }

  registerSchema(name: string, schema: z.ZodType): void {
    this.schemas.set(name, schema);
  }

  registerStrategy(name: string, strategy: AnyStrategy): void {
    this.strategies.set(name, strategy);
  }

  getAction(name: string): ActionFn {
    const fn = this.actions.get(name);
    if (!fn) throw new Error(`Action "${name}" not found in registry`);
    return fn;
  }

  getCondition(name: string): ConditionFn {
    const fn = this.conditions.get(name);
    if (!fn) throw new Error(`Condition "${name}" not found in registry`);
    return fn;
  }

  getSchema(name: string): z.ZodType {
    const schema = this.schemas.get(name);
    if (!schema) throw new Error(`Schema "${name}" not found in registry`);
    return schema;
  }

  getStrategy(name: string): AnyStrategy {
    const strategy = this.strategies.get(name);
    if (!strategy) throw new Error(`Strategy "${name}" not found in registry`);
    return strategy;
  }
}

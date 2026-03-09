import type { z } from 'zod/v4';
import type {
  TreeContext, NodeStatus, SelectionStrategy, ExecutionStrategy, ParallelStrategy,
} from '../types.js';

type ActionFn = (context: TreeContext) => Promise<NodeStatus> | NodeStatus;
type ConditionFn = (context: TreeContext) => Promise<boolean> | boolean;
type AnyStrategy = SelectionStrategy | ExecutionStrategy | ParallelStrategy;

/**
 * A named registry that maps string identifiers to TypeScript implementations.
 *
 * `TreeRegistry` is the dependency injection mechanism for YAML-based tree
 * configuration. When {@link TreeLoader} parses a YAML tree definition, it
 * resolves node references (e.g. `ref: fetch-user`) and strategy references
 * (e.g. `strategy.ref: my-strategy`) by looking them up in the registry.
 *
 * Register all required implementations before passing the registry to
 * `TreeLoader.fromYAML` or `TreeLoader.fromConfig`. Registrations can be
 * done in any order. All `get*` methods throw a descriptive error if the
 * requested name has not been registered.
 *
 * The four registries and their corresponding YAML fields:
 *
 * | Registry | YAML field | Node types |
 * |---|---|---|
 * | Actions | `ref` | `action` nodes |
 * | Conditions | `ref` | `condition` nodes; `conditionRef` on `guard` nodes |
 * | Schemas | `outputSchema` | `agent` nodes (structured mode) |
 * | Strategies | `strategy.ref` | `selector`, `sequence`, `parallel` nodes |
 *
 * @example
 * ```ts
 * import { z } from 'zod';
 *
 * const registry = new TreeRegistry();
 *
 * // Register actions and conditions
 * registry.registerAction('fetch-user', async (ctx) => {
 *   const user = await getUser(ctx.blackboard.get<string>('userId'));
 *   ctx.blackboard.set('user', user);
 *   return NodeStatus.SUCCESS;
 * });
 *
 * registry.registerCondition('is-authenticated', (ctx) =>
 *   ctx.blackboard.has('authToken'),
 * );
 *
 * // Register a Zod schema for an agent node's outputSchema
 * registry.registerSchema('intent-schema', z.object({
 *   intent: z.string(),
 *   confidence: z.number(),
 * }));
 *
 * // Register a strategy
 * registry.registerStrategy('adaptive-order', new AgentExecutionStrategy({
 *   prompt: 'Order these steps for optimal execution',
 * }));
 *
 * // Build the tree from YAML
 * const tree = TreeLoader.fromYAML(yamlString, registry);
 * ```
 */
export class TreeRegistry {
  private actions = new Map<string, ActionFn>();
  private conditions = new Map<string, ConditionFn>();
  private schemas = new Map<string, z.ZodType>();
  private strategies = new Map<string, AnyStrategy>();

  /**
   * Register an action function under the given name.
   *
   * Referenced in YAML by `ref: <name>` on `action` node definitions.
   * Overwrites any previously registered action with the same name.
   */
  registerAction(name: string, fn: ActionFn): void {
    this.actions.set(name, fn);
  }

  /**
   * Register a condition function under the given name.
   *
   * Referenced in YAML by `ref: <name>` on `condition` nodes, and by
   * `conditionRef: <name>` on `guard` nodes.
   * Overwrites any previously registered condition with the same name.
   */
  registerCondition(name: string, fn: ConditionFn): void {
    this.conditions.set(name, fn);
  }

  /**
   * Register a Zod schema under the given name.
   *
   * Referenced in YAML by `outputSchema: <name>` on `agent` node definitions
   * operating in `structured` mode. The loader uses this schema to validate
   * and parse the agent's structured output.
   * Overwrites any previously registered schema with the same name.
   */
  registerSchema(name: string, schema: z.ZodType): void {
    this.schemas.set(name, schema);
  }

  /**
   * Register a strategy under the given name.
   *
   * Accepts any of {@link SelectionStrategy}, {@link ExecutionStrategy}, or
   * {@link ParallelStrategy}. Referenced in YAML by `strategy.ref: <name>`
   * on `selector`, `sequence`, and `parallel` node definitions respectively.
   * The caller is responsible for registering the correct strategy type for
   * the composite node that will consume it.
   * Overwrites any previously registered strategy with the same name.
   */
  registerStrategy(name: string, strategy: AnyStrategy): void {
    this.strategies.set(name, strategy);
  }

  /**
   * Retrieve a registered action function by name.
   *
   * @throws {Error} If no action has been registered under `name`.
   */
  getAction(name: string): ActionFn {
    const fn = this.actions.get(name);
    if (!fn) throw new Error(`Action "${name}" not found in registry`);
    return fn;
  }

  /**
   * Retrieve a registered condition function by name.
   *
   * @throws {Error} If no condition has been registered under `name`.
   */
  getCondition(name: string): ConditionFn {
    const fn = this.conditions.get(name);
    if (!fn) throw new Error(`Condition "${name}" not found in registry`);
    return fn;
  }

  /**
   * Retrieve a registered Zod schema by name.
   *
   * @throws {Error} If no schema has been registered under `name`.
   */
  getSchema(name: string): z.ZodType {
    const schema = this.schemas.get(name);
    if (!schema) throw new Error(`Schema "${name}" not found in registry`);
    return schema;
  }

  /**
   * Retrieve a registered strategy by name.
   *
   * @throws {Error} If no strategy has been registered under `name`.
   */
  getStrategy(name: string): AnyStrategy {
    const strategy = this.strategies.get(name);
    if (!strategy) throw new Error(`Strategy "${name}" not found in registry`);
    return strategy;
  }
}

import type {
  TreeContext, NodeStatus, SelectionStrategy, ExecutionStrategy, ParallelStrategy,
} from '../types.js';

type ActionFn = (context: TreeContext) => Promise<NodeStatus> | NodeStatus;
type ConditionFn = (context: TreeContext) => Promise<boolean> | boolean;
type AnyStrategy = SelectionStrategy | ExecutionStrategy | ParallelStrategy;

/**
 * A general-purpose named registry for actions, conditions, and strategies.
 *
 * `TreeRegistry` maps string identifiers to their TypeScript implementations,
 * providing a dependency-injection mechanism for behavior tree construction.
 * It will serve as the resolution layer for future configuration and
 * orchestration features.
 *
 * All `get*` methods throw a descriptive error if the requested name has not
 * been registered.
 *
 * @example
 * ```ts
 * const registry = new TreeRegistry();
 *
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
 * registry.registerStrategy('adaptive-order', new AgentExecutionStrategy({
 *   prompt: 'Order these steps for optimal execution',
 * }));
 * ```
 */
export class TreeRegistry {
  private actions = new Map<string, ActionFn>();
  private conditions = new Map<string, ConditionFn>();
  private strategies = new Map<string, AnyStrategy>();

  /**
   * Register an action function under the given name.
   *
   * Overwrites any previously registered action with the same name.
   */
  registerAction(name: string, fn: ActionFn): void {
    this.actions.set(name, fn);
  }

  /**
   * Register a condition function under the given name.
   *
   * Overwrites any previously registered condition with the same name.
   */
  registerCondition(name: string, fn: ConditionFn): void {
    this.conditions.set(name, fn);
  }

  /**
   * Register a strategy under the given name.
   *
   * Accepts any of {@link SelectionStrategy}, {@link ExecutionStrategy}, or
   * {@link ParallelStrategy}. The caller is responsible for registering the
   * correct strategy type for the composite node that will consume it.
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

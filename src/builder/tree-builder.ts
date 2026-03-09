import { BehaviorTree } from '../core/behavior-tree.js';
import { ActionNode } from '../nodes/action.js';
import { ConditionNode } from '../nodes/condition.js';
import { AgentNode } from '../nodes/agent.js';
import { SelectorNode } from '../composites/selector.js';
import { SequenceNode } from '../composites/sequence.js';
import { ParallelNode } from '../composites/parallel.js';
import { InverterNode } from '../decorators/inverter.js';
import { RepeatNode } from '../decorators/repeat.js';
import { RetryNode } from '../decorators/retry.js';
import { AlwaysSucceedNode } from '../decorators/always-succeed.js';
import { AlwaysFailNode } from '../decorators/always-fail.js';
import { TimeoutNode } from '../decorators/timeout.js';
import { GuardNode } from '../decorators/guard.js';
import { NodeStatus } from '../types.js';
import type {
  BTreeNode, TreeContext, SelectionStrategy, ExecutionStrategy, ParallelStrategy,
  AgentNodeConfig,
} from '../types.js';

type ActionFn = (context: TreeContext) => Promise<NodeStatus> | NodeStatus;
type ConditionFn = (context: TreeContext) => Promise<boolean> | boolean;

/**
 * Fluent builder for constructing the children of a composite node.
 *
 * You never instantiate `CompositeBuilder` directly. It is provided as the
 * argument to the callback passed to composite methods on {@link TreeBuilder}
 * and on other `CompositeBuilder` instances, allowing trees to be composed
 * by nesting calls.
 *
 * Every method returns `this` so calls can be chained. Children are added
 * in the order the methods are called.
 *
 * **Leaf nodes** (`action`, `condition`, `agent`) take a name and their
 * configuration inline.
 *
 * **Composite nodes** (`selector`, `sequence`, `parallel`) take a name,
 * an optional options object, and a callback that receives a new
 * `CompositeBuilder` for their children. Two call signatures are accepted:
 * ```ts
 * // Without a strategy (default ordering)
 * b.sequence('my-seq', (b) => { b.action(...); b.action(...); });
 *
 * // With a strategy
 * b.sequence('my-seq', { strategy: myStrategy }, (b) => { ... });
 * ```
 *
 * **Decorator nodes** (`inverter`, `repeat`, `retry`, `timeout`, `guard`,
 * `alwaysSucceed`, `alwaysFail`) take a name, optional options, and a
 * callback that receives a {@link SingleChildBuilder} — decorators wrap
 * exactly one child.
 *
 * @example
 * ```ts
 * new TreeBuilder('order-flow')
 *   .sequence('root', (b) => {
 *     b.condition('has-items', (ctx) => ctx.blackboard.has('cart'));
 *     b.retry('charge-with-retry', { maxAttempts: 3 }, (b) => {
 *       b.action('charge', async () => NodeStatus.SUCCESS);
 *     });
 *     b.agent('confirm', {
 *       mode: 'structured',
 *       prompt: 'Generate an order confirmation message',
 *     });
 *   })
 *   .build();
 * ```
 */
export class CompositeBuilder {
  private children: BTreeNode[] = [];

  /**
   * Add an {@link ActionNode} that executes `fn` when ticked.
   *
   * `fn` receives the {@link TreeContext} and must return `SUCCESS`,
   * `FAILURE`, or `RUNNING`.
   */
  action(name: string, fn: ActionFn): this {
    this.children.push(new ActionNode({ name, action: fn }));
    return this;
  }

  /**
   * Add a {@link ConditionNode} that evaluates `fn` when ticked.
   *
   * `fn` returns a boolean; `true` maps to `SUCCESS`, `false` to `FAILURE`.
   * Conditions never return `RUNNING`.
   */
  condition(name: string, fn: ConditionFn): this {
    this.children.push(new ConditionNode({ name, condition: fn }));
    return this;
  }

  /**
   * Add an {@link AgentNode} that calls the Claude SDK when ticked.
   *
   * `config` accepts all {@link AgentNodeConfig} fields except `name`,
   * which is provided as the first argument.
   */
  agent(name: string, config: Omit<AgentNodeConfig, 'name'>): this {
    this.children.push(new AgentNode({ name, ...config }));
    return this;
  }

  /**
   * Add a {@link SelectorNode} (OR / fallback logic).
   *
   * The selector tries children in order and returns `SUCCESS` on the first
   * child that succeeds. Accepts an optional `strategy` to control
   * evaluation order.
   *
   * ```ts
   * b.selector('get-user', (b) => {
   *   b.action('from-cache', fromCacheFn);
   *   b.action('from-db', fromDbFn);
   * });
   *
   * // With a strategy:
   * b.selector('adaptive', { strategy: myStrategy }, (b) => { ... });
   * ```
   */
  selector(name: string, optionsOrConfigure?: { strategy?: SelectionStrategy } | ((b: CompositeBuilder) => void), configure?: (b: CompositeBuilder) => void): this {
    const { strategy, configureFn } = parseCompositeArgs(optionsOrConfigure, configure);
    const builder = new CompositeBuilder();
    configureFn?.(builder);
    this.children.push(new SelectorNode({ name, children: builder.getChildren(), strategy: strategy as SelectionStrategy | undefined }));
    return this;
  }

  /**
   * Add a {@link SequenceNode} (AND / pipeline logic).
   *
   * The sequence ticks children in order and returns `FAILURE` on the first
   * child that fails; returns `SUCCESS` only when all children succeed.
   * Accepts an optional `strategy` to control execution order.
   *
   * ```ts
   * b.sequence('process', (b) => {
   *   b.condition('is-valid', validFn);
   *   b.action('transform', transformFn);
   *   b.action('store', storeFn);
   * });
   *
   * // With a strategy:
   * b.sequence('adaptive', { strategy: myStrategy }, (b) => { ... });
   * ```
   */
  sequence(name: string, optionsOrConfigure?: { strategy?: ExecutionStrategy } | ((b: CompositeBuilder) => void), configure?: (b: CompositeBuilder) => void): this {
    const { strategy, configureFn } = parseCompositeArgs(optionsOrConfigure, configure);
    const builder = new CompositeBuilder();
    configureFn?.(builder);
    this.children.push(new SequenceNode({ name, children: builder.getChildren(), strategy: strategy as ExecutionStrategy | undefined }));
    return this;
  }

  /**
   * Add a {@link ParallelNode} (concurrent execution).
   *
   * All children are ticked concurrently. The success/failure threshold is
   * determined by the strategy's policy (default: all children must succeed).
   * Accepts an optional `strategy` to control the policy dynamically.
   *
   * ```ts
   * b.parallel('validate-all', (b) => {
   *   b.action('check-schema', schemaFn);
   *   b.action('check-auth', authFn);
   * });
   *
   * // With a strategy:
   * b.parallel('adaptive', { strategy: myStrategy }, (b) => { ... });
   * ```
   */
  parallel(name: string, optionsOrConfigure?: { strategy?: ParallelStrategy } | ((b: CompositeBuilder) => void), configure?: (b: CompositeBuilder) => void): this {
    const { strategy, configureFn } = parseCompositeArgs(optionsOrConfigure, configure);
    const builder = new CompositeBuilder();
    configureFn?.(builder);
    this.children.push(new ParallelNode({ name, children: builder.getChildren(), strategy: strategy as ParallelStrategy | undefined }));
    return this;
  }

  /**
   * Add an {@link InverterNode} that flips `SUCCESS` ↔ `FAILURE` on its child.
   * `RUNNING` is passed through unchanged.
   */
  inverter(name: string, configure: (b: SingleChildBuilder) => void): this {
    const builder = new SingleChildBuilder();
    configure(builder);
    this.children.push(new InverterNode({ name, child: builder.getChild() }));
    return this;
  }

  /**
   * Add a {@link RepeatNode} that ticks its child repeatedly.
   *
   * @param options.count - Maximum number of repetitions.
   * @param options.untilStatus - Stop early when the child returns this status.
   *
   * ```ts
   * b.repeat('retry-loop', { count: 5 }, (b) => {
   *   b.action('attempt', attemptFn);
   * });
   * ```
   */
  repeat(name: string, options: { count?: number; untilStatus?: NodeStatus }, configure: (b: SingleChildBuilder) => void): this {
    const builder = new SingleChildBuilder();
    configure(builder);
    this.children.push(new RepeatNode({ name, child: builder.getChild(), ...options }));
    return this;
  }

  /**
   * Add a {@link RetryNode} that retries its child on `FAILURE`.
   *
   * @param options.maxAttempts - Total attempts (including the first try).
   * @param options.delayMs - Milliseconds to wait between attempts.
   *
   * ```ts
   * b.retry('with-retry', { maxAttempts: 3, delayMs: 500 }, (b) => {
   *   b.action('call-api', apiFn);
   * });
   * ```
   */
  retry(name: string, options: { maxAttempts: number; delayMs?: number }, configure: (b: SingleChildBuilder) => void): this {
    const builder = new SingleChildBuilder();
    configure(builder);
    this.children.push(new RetryNode({ name, child: builder.getChild(), ...options }));
    return this;
  }

  /**
   * Add an {@link AlwaysSucceedNode} that returns `SUCCESS` regardless of
   * what its child returns.
   */
  alwaysSucceed(name: string, configure: (b: SingleChildBuilder) => void): this {
    const builder = new SingleChildBuilder();
    configure(builder);
    this.children.push(new AlwaysSucceedNode({ name, child: builder.getChild() }));
    return this;
  }

  /**
   * Add an {@link AlwaysFailNode} that returns `FAILURE` regardless of
   * what its child returns.
   */
  alwaysFail(name: string, configure: (b: SingleChildBuilder) => void): this {
    const builder = new SingleChildBuilder();
    configure(builder);
    this.children.push(new AlwaysFailNode({ name, child: builder.getChild() }));
    return this;
  }

  /**
   * Add a {@link TimeoutNode} that aborts its child if it exceeds a time limit.
   *
   * Returns `FAILURE` if the child does not complete within `timeoutMs`
   * milliseconds.
   *
   * @param options.timeoutMs - Maximum allowed duration in milliseconds.
   */
  timeout(name: string, options: { timeoutMs: number }, configure: (b: SingleChildBuilder) => void): this {
    const builder = new SingleChildBuilder();
    configure(builder);
    this.children.push(new TimeoutNode({ name, child: builder.getChild(), ...options }));
    return this;
  }

  /**
   * Add a {@link GuardNode} that only ticks its child when a condition passes.
   *
   * Returns `FAILURE` without ticking the child when `condition` returns
   * `false`.
   *
   * @param options.condition - The predicate to evaluate before ticking.
   *
   * ```ts
   * b.guard('require-auth', { condition: (ctx) => ctx.blackboard.has('token') }, (b) => {
   *   b.action('fetch-profile', fetchFn);
   * });
   * ```
   */
  guard(name: string, options: { condition: ConditionFn }, configure: (b: SingleChildBuilder) => void): this {
    const builder = new SingleChildBuilder();
    configure(builder);
    this.children.push(new GuardNode({ name, child: builder.getChild(), condition: options.condition }));
    return this;
  }

  /**
   * Return a shallow copy of the children added so far.
   *
   * Called internally by composite methods to assemble the child list when
   * the builder callback returns. Not typically needed in user code.
   */
  getChildren(): BTreeNode[] {
    return [...this.children];
  }
}

/**
 * A restricted builder that holds exactly one child node.
 *
 * `SingleChildBuilder` is provided as the callback argument to decorator
 * methods (`inverter`, `repeat`, `retry`, `timeout`, `guard`,
 * `alwaysSucceed`, `alwaysFail`). It exposes the same node-building methods
 * as {@link CompositeBuilder}, but silently replaces any previously set child
 * if you call more than one — and {@link getChild} throws if no child has
 * been added at all.
 *
 * In practice, always call exactly one method inside a decorator callback.
 *
 * @example
 * ```ts
 * b.retry('with-retry', { maxAttempts: 3 }, (b) => {
 *   // b is a SingleChildBuilder — add exactly one child
 *   b.action('call-api', apiFn);
 * });
 * ```
 */
export class SingleChildBuilder {
  private child: BTreeNode | null = null;

  /** Add an {@link ActionNode} as the single child. */
  action(name: string, fn: ActionFn): this {
    this.child = new ActionNode({ name, action: fn });
    return this;
  }

  /** Add a {@link ConditionNode} as the single child. */
  condition(name: string, fn: ConditionFn): this {
    this.child = new ConditionNode({ name, condition: fn });
    return this;
  }

  /** Add an {@link AgentNode} as the single child. */
  agent(name: string, config: Omit<AgentNodeConfig, 'name'>): this {
    this.child = new AgentNode({ name, ...config });
    return this;
  }

  /** Add a {@link SelectorNode} as the single child. */
  selector(name: string, optionsOrConfigure?: { strategy?: SelectionStrategy } | ((b: CompositeBuilder) => void), configure?: (b: CompositeBuilder) => void): this {
    const { strategy, configureFn } = parseCompositeArgs(optionsOrConfigure, configure);
    const builder = new CompositeBuilder();
    configureFn?.(builder);
    this.child = new SelectorNode({ name, children: builder.getChildren(), strategy: strategy as SelectionStrategy | undefined });
    return this;
  }

  /** Add a {@link SequenceNode} as the single child. */
  sequence(name: string, optionsOrConfigure?: { strategy?: ExecutionStrategy } | ((b: CompositeBuilder) => void), configure?: (b: CompositeBuilder) => void): this {
    const { strategy, configureFn } = parseCompositeArgs(optionsOrConfigure, configure);
    const builder = new CompositeBuilder();
    configureFn?.(builder);
    this.child = new SequenceNode({ name, children: builder.getChildren(), strategy: strategy as ExecutionStrategy | undefined });
    return this;
  }

  /** Add a {@link ParallelNode} as the single child. */
  parallel(name: string, optionsOrConfigure?: { strategy?: ParallelStrategy } | ((b: CompositeBuilder) => void), configure?: (b: CompositeBuilder) => void): this {
    const { strategy, configureFn } = parseCompositeArgs(optionsOrConfigure, configure);
    const builder = new CompositeBuilder();
    configureFn?.(builder);
    this.child = new ParallelNode({ name, children: builder.getChildren(), strategy: strategy as ParallelStrategy | undefined });
    return this;
  }

  /** Add an {@link InverterNode} as the single child. */
  inverter(name: string, configure: (b: SingleChildBuilder) => void): this {
    const builder = new SingleChildBuilder();
    configure(builder);
    this.child = new InverterNode({ name, child: builder.getChild() });
    return this;
  }

  /** Add a {@link RepeatNode} as the single child. */
  repeat(name: string, options: { count?: number; untilStatus?: NodeStatus }, configure: (b: SingleChildBuilder) => void): this {
    const builder = new SingleChildBuilder();
    configure(builder);
    this.child = new RepeatNode({ name, child: builder.getChild(), ...options });
    return this;
  }

  /** Add a {@link RetryNode} as the single child. */
  retry(name: string, options: { maxAttempts: number; delayMs?: number }, configure: (b: SingleChildBuilder) => void): this {
    const builder = new SingleChildBuilder();
    configure(builder);
    this.child = new RetryNode({ name, child: builder.getChild(), ...options });
    return this;
  }

  /** Add an {@link AlwaysSucceedNode} as the single child. */
  alwaysSucceed(name: string, configure: (b: SingleChildBuilder) => void): this {
    const builder = new SingleChildBuilder();
    configure(builder);
    this.child = new AlwaysSucceedNode({ name, child: builder.getChild() });
    return this;
  }

  /** Add an {@link AlwaysFailNode} as the single child. */
  alwaysFail(name: string, configure: (b: SingleChildBuilder) => void): this {
    const builder = new SingleChildBuilder();
    configure(builder);
    this.child = new AlwaysFailNode({ name, child: builder.getChild() });
    return this;
  }

  /** Add a {@link TimeoutNode} as the single child. */
  timeout(name: string, options: { timeoutMs: number }, configure: (b: SingleChildBuilder) => void): this {
    const builder = new SingleChildBuilder();
    configure(builder);
    this.child = new TimeoutNode({ name, child: builder.getChild(), ...options });
    return this;
  }

  /** Add a {@link GuardNode} as the single child. */
  guard(name: string, options: { condition: ConditionFn }, configure: (b: SingleChildBuilder) => void): this {
    const builder = new SingleChildBuilder();
    configure(builder);
    this.child = new GuardNode({ name, child: builder.getChild(), condition: options.condition });
    return this;
  }

  /**
   * Return the single child that was added.
   *
   * @throws {Error} If no child method was called before this.
   */
  getChild(): BTreeNode {
    if (!this.child) {
      throw new Error('Decorator must have exactly one child node');
    }
    return this.child;
  }
}

/**
 * Normalise the two composite method call signatures into a consistent shape.
 *
 * Composite methods (`selector`, `sequence`, `parallel`) accept either:
 * - `(name, configureFn)` — no strategy
 * - `(name, { strategy }, configureFn)` — with a strategy
 *
 * This helper detects which form was used and returns both the optional
 * strategy and the configuration callback in a uniform object.
 */
function parseCompositeArgs(
  optionsOrConfigure?: Record<string, unknown> | ((b: CompositeBuilder) => void),
  configure?: (b: CompositeBuilder) => void,
): { strategy?: unknown; configureFn?: (b: CompositeBuilder) => void } {
  if (typeof optionsOrConfigure === 'function') {
    return { configureFn: optionsOrConfigure };
  }
  return {
    strategy: optionsOrConfigure?.strategy,
    configureFn: configure,
  };
}

/**
 * The entry point for constructing a {@link BehaviorTree} with the fluent API.
 *
 * `TreeBuilder` extends {@link CompositeBuilder} with a {@link build} method
 * that assembles the configured nodes into a ready-to-run `BehaviorTree`.
 * The tree must have **exactly one** top-level node; call a single composite
 * or leaf method before `build()`.
 *
 * Typically the root is a `sequence` or `selector` that nests the rest of
 * the tree structure.
 *
 * @example Minimal tree
 * ```ts
 * const tree = new TreeBuilder('greet')
 *   .action('say-hello', async () => {
 *     console.log('Hello!');
 *     return NodeStatus.SUCCESS;
 *   })
 *   .build();
 *
 * await tree.tick();
 * ```
 *
 * @example Multi-step pipeline with decorators and an agent
 * ```ts
 * const tree = new TreeBuilder('order-flow')
 *   .sequence('root', (b) => {
 *     b.condition('has-items', (ctx) => ctx.blackboard.has('cart'));
 *
 *     b.retry('charge-with-retry', { maxAttempts: 3, delayMs: 1000 }, (b) => {
 *       b.action('charge', chargeFn);
 *     });
 *
 *     b.agent('confirm', {
 *       mode: 'structured',
 *       prompt: 'Generate a brief order confirmation message',
 *       outputSchema: z.object({ message: z.string() }),
 *     });
 *   })
 *   .build();
 * ```
 *
 * @example Selector with an agent strategy
 * ```ts
 * const tree = new TreeBuilder('adaptive-response')
 *   .selector('pick-strategy', { strategy: new AgentSelectionStrategy({ prompt: '...' }) }, (b) => {
 *     b.action('quick-reply', quickReplyFn);
 *     b.action('deep-research', deepResearchFn);
 *   })
 *   .build();
 * ```
 */
export class TreeBuilder extends CompositeBuilder {
  private treeName: string;

  constructor(name: string) {
    super();
    this.treeName = name;
  }

  /**
   * Assemble the configured nodes into a {@link BehaviorTree}.
   *
   * The single top-level node added to this builder becomes the root of the
   * tree. Calling `build()` with zero nodes or more than one node throws.
   *
   * @throws {Error} If the builder does not contain exactly one root node.
   */
  build(): BehaviorTree {
    const children = this.getChildren();
    if (children.length !== 1) {
      throw new Error(`Tree must have exactly one root node, got ${children.length}`);
    }
    return new BehaviorTree({ name: this.treeName, root: children[0] });
  }
}

import { BehaviorTree } from '../core/behavior-tree.js';
import { ActionNode } from '../nodes/action.js';
import { ConditionNode } from '../nodes/condition.js';
import { AgentNode } from '../nodes/agent.js';
import { SelectorNode } from '../composites/selector.js';
import { SequenceNode } from '../composites/sequence.js';
import { ParallelNode } from '../composites/parallel.js';
import { Inverter } from '../decorators/inverter.js';
import { Repeat } from '../decorators/repeat.js';
import { Retry } from '../decorators/retry.js';
import { AlwaysSucceed } from '../decorators/always-succeed.js';
import { AlwaysFail } from '../decorators/always-fail.js';
import { Timeout } from '../decorators/timeout.js';
import { Guard } from '../decorators/guard.js';
import { NodeStatus } from '../types.js';
import type { OnElicitation } from '../agent/agent.js';
import type {
  BTreeNode, TreeContext, SelectionStrategy, ExecutionStrategy, ParallelStrategy,
  AgentNodeConfig,
} from '../types.js';
import { BaseNode } from '../nodes/base.js';
import type { TreeRegistry } from '../config/registry.js';

type ActionFn = (context: TreeContext) => Promise<NodeStatus> | NodeStatus;
type ConditionFn = (context: TreeContext) => Promise<boolean> | boolean;
type AnyStrategy = SelectionStrategy | ExecutionStrategy | ParallelStrategy;

function resolveAction(registry: TreeRegistry | undefined, ref: string): ActionFn {
  if (!registry) {
    throw new Error(`Cannot resolve registry reference "${ref}": no registry provided to TreeBuilder`);
  }
  return registry.getAction(ref);
}

function resolveCondition(registry: TreeRegistry | undefined, ref: string): ConditionFn {
  if (!registry) {
    throw new Error(`Cannot resolve registry reference "${ref}": no registry provided to TreeBuilder`);
  }
  return registry.getCondition(ref);
}

function resolveStrategy(registry: TreeRegistry | undefined, ref: string): AnyStrategy {
  if (!registry) {
    throw new Error(`Cannot resolve registry reference "${ref}": no registry provided to TreeBuilder`);
  }
  return registry.getStrategy(ref);
}

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
 *       agent: confirmAgent,
 *       prompt: 'Generate an order confirmation message',
 *     });
 *   })
 *   .build();
 * ```
 */
export class CompositeBuilder {
  private children: BTreeNode[] = [];

  constructor(protected registry?: TreeRegistry) {}

  /**
   * Add an {@link ActionNode} that executes `fn` when ticked.
   *
   * Accepts either an inline function or a string registry reference.
   */
  action(name: string, fnOrRef: ActionFn | string): this {
    const fn = typeof fnOrRef === 'string' ? resolveAction(this.registry, fnOrRef) : fnOrRef;
    this.children.push(new ActionNode({ name, action: fn }));
    return this;
  }

  /**
   * Add a {@link ConditionNode} that evaluates a predicate when ticked.
   *
   * Accepts either an inline function or a string registry reference.
   * `true` maps to `SUCCESS`, `false` to `FAILURE`. Conditions never
   * return `RUNNING`.
   */
  condition(name: string, fnOrRef: ConditionFn | string): this {
    const fn = typeof fnOrRef === 'string' ? resolveCondition(this.registry, fnOrRef) : fnOrRef;
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
  selector(name: string, optionsOrConfigure?: { strategy?: SelectionStrategy | string; context?: Partial<TreeContext> } | ((b: CompositeBuilder) => void), configure?: (b: CompositeBuilder) => void): this {
    const { strategy: raw, context, configureFn } = parseCompositeArgs(optionsOrConfigure, configure);
    const strategy = typeof raw === 'string' ? resolveStrategy(this.registry, raw) : raw;
    const builder = new CompositeBuilder(this.registry);
    configureFn?.(builder);
    const node = new SelectorNode({ name, children: builder.getChildren(), strategy: strategy as SelectionStrategy | undefined });
    applyContextOverrides(node, context);
    this.children.push(node);
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
  sequence(name: string, optionsOrConfigure?: { strategy?: ExecutionStrategy | string; context?: Partial<TreeContext> } | ((b: CompositeBuilder) => void), configure?: (b: CompositeBuilder) => void): this {
    const { strategy: raw, context, configureFn } = parseCompositeArgs(optionsOrConfigure, configure);
    const strategy = typeof raw === 'string' ? resolveStrategy(this.registry, raw) : raw;
    const builder = new CompositeBuilder(this.registry);
    configureFn?.(builder);
    const node = new SequenceNode({ name, children: builder.getChildren(), strategy: strategy as ExecutionStrategy | undefined });
    applyContextOverrides(node, context);
    this.children.push(node);
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
  parallel(name: string, optionsOrConfigure?: { strategy?: ParallelStrategy | string; context?: Partial<TreeContext> } | ((b: CompositeBuilder) => void), configure?: (b: CompositeBuilder) => void): this {
    const { strategy: raw, context, configureFn } = parseCompositeArgs(optionsOrConfigure, configure);
    const strategy = typeof raw === 'string' ? resolveStrategy(this.registry, raw) : raw;
    const builder = new CompositeBuilder(this.registry);
    configureFn?.(builder);
    const node = new ParallelNode({ name, children: builder.getChildren(), strategy: strategy as ParallelStrategy | undefined });
    applyContextOverrides(node, context);
    this.children.push(node);
    return this;
  }

  /**
   * Add an {@link Inverter} that flips `SUCCESS` ↔ `FAILURE` on its child.
   * `RUNNING` is passed through unchanged.
   */
  inverter(name: string, configure: (b: SingleChildBuilder) => void): this {
    const builder = new SingleChildBuilder(this.registry);
    configure(builder);
    this.children.push(new Inverter({ name, child: builder.getChild() }));
    return this;
  }

  /**
   * Add a {@link Repeat} that ticks its child repeatedly.
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
  repeat(name: string, options: { count?: number; untilStatus?: NodeStatus; context?: Partial<TreeContext> }, configure: (b: SingleChildBuilder) => void): this {
    const { context, ...nodeOptions } = options;
    const builder = new SingleChildBuilder(this.registry);
    configure(builder);
    const node = new Repeat({ name, child: builder.getChild(), ...nodeOptions });
    applyContextOverrides(node, context);
    this.children.push(node);
    return this;
  }

  /**
   * Add a {@link Retry} that retries its child on `FAILURE`.
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
  retry(name: string, options: { maxAttempts: number; delayMs?: number; context?: Partial<TreeContext> }, configure: (b: SingleChildBuilder) => void): this {
    const { context, ...nodeOptions } = options;
    const builder = new SingleChildBuilder(this.registry);
    configure(builder);
    const node = new Retry({ name, child: builder.getChild(), ...nodeOptions });
    applyContextOverrides(node, context);
    this.children.push(node);
    return this;
  }

  /**
   * Add an {@link AlwaysSucceed} that returns `SUCCESS` regardless of
   * what its child returns.
   */
  alwaysSucceed(name: string, configure: (b: SingleChildBuilder) => void): this {
    const builder = new SingleChildBuilder(this.registry);
    configure(builder);
    this.children.push(new AlwaysSucceed({ name, child: builder.getChild() }));
    return this;
  }

  /**
   * Add an {@link AlwaysFail} that returns `FAILURE` regardless of
   * what its child returns.
   */
  alwaysFail(name: string, configure: (b: SingleChildBuilder) => void): this {
    const builder = new SingleChildBuilder(this.registry);
    configure(builder);
    this.children.push(new AlwaysFail({ name, child: builder.getChild() }));
    return this;
  }

  /**
   * Add a {@link Timeout} that aborts its child if it exceeds a time limit.
   *
   * Returns `FAILURE` if the child does not complete within `timeoutMs`
   * milliseconds.
   *
   * @param options.timeoutMs - Maximum allowed duration in milliseconds.
   */
  timeout(name: string, options: { timeoutMs: number; context?: Partial<TreeContext> }, configure: (b: SingleChildBuilder) => void): this {
    const { context, ...nodeOptions } = options;
    const builder = new SingleChildBuilder(this.registry);
    configure(builder);
    const node = new Timeout({ name, child: builder.getChild(), ...nodeOptions });
    applyContextOverrides(node, context);
    this.children.push(node);
    return this;
  }

  /**
   * Add a {@link Guard} that only ticks its child when a condition passes.
   *
   * Returns `FAILURE` without ticking the child when `condition` returns
   * `false`. Accepts either an inline function or a string registry reference
   * for the condition.
   *
   * ```ts
   * b.guard('require-auth', { condition: (ctx) => ctx.blackboard.has('token') }, (b) => {
   *   b.action('fetch-profile', fetchFn);
   * });
   * // Or with a registry reference:
   * b.guard('require-auth', { condition: 'has-token' }, (b) => { ... });
   * ```
   */
  guard(name: string, options: { condition: ConditionFn | string; context?: Partial<TreeContext> }, configure: (b: SingleChildBuilder) => void): this {
    const { context, condition: condOrRef } = options;
    const condition = typeof condOrRef === 'string' ? resolveCondition(this.registry, condOrRef) : condOrRef;
    const builder = new SingleChildBuilder(this.registry);
    configure(builder);
    const node = new Guard({ name, child: builder.getChild(), condition });
    applyContextOverrides(node, context);
    this.children.push(node);
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

  constructor(private registry?: TreeRegistry) {}

  /** Add an {@link ActionNode} as the single child. Accepts a function or registry ref. */
  action(name: string, fnOrRef: ActionFn | string): this {
    const fn = typeof fnOrRef === 'string' ? resolveAction(this.registry, fnOrRef) : fnOrRef;
    this.child = new ActionNode({ name, action: fn });
    return this;
  }

  /** Add a {@link ConditionNode} as the single child. Accepts a function or registry ref. */
  condition(name: string, fnOrRef: ConditionFn | string): this {
    const fn = typeof fnOrRef === 'string' ? resolveCondition(this.registry, fnOrRef) : fnOrRef;
    this.child = new ConditionNode({ name, condition: fn });
    return this;
  }

  /** Add an {@link AgentNode} as the single child. */
  agent(name: string, config: Omit<AgentNodeConfig, 'name'>): this {
    this.child = new AgentNode({ name, ...config });
    return this;
  }

  /** Add a {@link SelectorNode} as the single child. */
  selector(name: string, optionsOrConfigure?: { strategy?: SelectionStrategy | string; context?: Partial<TreeContext> } | ((b: CompositeBuilder) => void), configure?: (b: CompositeBuilder) => void): this {
    const { strategy: raw, context, configureFn } = parseCompositeArgs(optionsOrConfigure, configure);
    const strategy = typeof raw === 'string' ? resolveStrategy(this.registry, raw) : raw;
    const builder = new CompositeBuilder(this.registry);
    configureFn?.(builder);
    const node = new SelectorNode({ name, children: builder.getChildren(), strategy: strategy as SelectionStrategy | undefined });
    applyContextOverrides(node, context);
    this.child = node;
    return this;
  }

  /** Add a {@link SequenceNode} as the single child. */
  sequence(name: string, optionsOrConfigure?: { strategy?: ExecutionStrategy | string; context?: Partial<TreeContext> } | ((b: CompositeBuilder) => void), configure?: (b: CompositeBuilder) => void): this {
    const { strategy: raw, context, configureFn } = parseCompositeArgs(optionsOrConfigure, configure);
    const strategy = typeof raw === 'string' ? resolveStrategy(this.registry, raw) : raw;
    const builder = new CompositeBuilder(this.registry);
    configureFn?.(builder);
    const node = new SequenceNode({ name, children: builder.getChildren(), strategy: strategy as ExecutionStrategy | undefined });
    applyContextOverrides(node, context);
    this.child = node;
    return this;
  }

  /** Add a {@link ParallelNode} as the single child. */
  parallel(name: string, optionsOrConfigure?: { strategy?: ParallelStrategy | string; context?: Partial<TreeContext> } | ((b: CompositeBuilder) => void), configure?: (b: CompositeBuilder) => void): this {
    const { strategy: raw, context, configureFn } = parseCompositeArgs(optionsOrConfigure, configure);
    const strategy = typeof raw === 'string' ? resolveStrategy(this.registry, raw) : raw;
    const builder = new CompositeBuilder(this.registry);
    configureFn?.(builder);
    const node = new ParallelNode({ name, children: builder.getChildren(), strategy: strategy as ParallelStrategy | undefined });
    applyContextOverrides(node, context);
    this.child = node;
    return this;
  }

  /** Add an {@link Inverter} as the single child. */
  inverter(name: string, configure: (b: SingleChildBuilder) => void): this {
    const builder = new SingleChildBuilder(this.registry);
    configure(builder);
    this.child = new Inverter({ name, child: builder.getChild() });
    return this;
  }

  /** Add a {@link Repeat} as the single child. */
  repeat(name: string, options: { count?: number; untilStatus?: NodeStatus; context?: Partial<TreeContext> }, configure: (b: SingleChildBuilder) => void): this {
    const { context, ...nodeOptions } = options;
    const builder = new SingleChildBuilder(this.registry);
    configure(builder);
    const node = new Repeat({ name, child: builder.getChild(), ...nodeOptions });
    applyContextOverrides(node, context);
    this.child = node;
    return this;
  }

  /** Add a {@link Retry} as the single child. */
  retry(name: string, options: { maxAttempts: number; delayMs?: number; context?: Partial<TreeContext> }, configure: (b: SingleChildBuilder) => void): this {
    const { context, ...nodeOptions } = options;
    const builder = new SingleChildBuilder(this.registry);
    configure(builder);
    const node = new Retry({ name, child: builder.getChild(), ...nodeOptions });
    applyContextOverrides(node, context);
    this.child = node;
    return this;
  }

  /** Add an {@link AlwaysSucceed} as the single child. */
  alwaysSucceed(name: string, configure: (b: SingleChildBuilder) => void): this {
    const builder = new SingleChildBuilder(this.registry);
    configure(builder);
    this.child = new AlwaysSucceed({ name, child: builder.getChild() });
    return this;
  }

  /** Add an {@link AlwaysFail} as the single child. */
  alwaysFail(name: string, configure: (b: SingleChildBuilder) => void): this {
    const builder = new SingleChildBuilder(this.registry);
    configure(builder);
    this.child = new AlwaysFail({ name, child: builder.getChild() });
    return this;
  }

  /** Add a {@link Timeout} as the single child. */
  timeout(name: string, options: { timeoutMs: number; context?: Partial<TreeContext> }, configure: (b: SingleChildBuilder) => void): this {
    const { context, ...nodeOptions } = options;
    const builder = new SingleChildBuilder(this.registry);
    configure(builder);
    const node = new Timeout({ name, child: builder.getChild(), ...nodeOptions });
    applyContextOverrides(node, context);
    this.child = node;
    return this;
  }

  /** Add a {@link Guard} as the single child. Condition accepts a function or registry ref. */
  guard(name: string, options: { condition: ConditionFn | string; context?: Partial<TreeContext> }, configure: (b: SingleChildBuilder) => void): this {
    const { context, condition: condOrRef } = options;
    const condition = typeof condOrRef === 'string' ? resolveCondition(this.registry, condOrRef) : condOrRef;
    const builder = new SingleChildBuilder(this.registry);
    configure(builder);
    const node = new Guard({ name, child: builder.getChild(), condition });
    applyContextOverrides(node, context);
    this.child = node;
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
): { strategy?: unknown; context?: Partial<TreeContext>; configureFn?: (b: CompositeBuilder) => void } {
  if (typeof optionsOrConfigure === 'function') {
    return { configureFn: optionsOrConfigure };
  }
  return {
    strategy: optionsOrConfigure?.strategy,
    context: optionsOrConfigure?.context as Partial<TreeContext> | undefined,
    configureFn: configure,
  };
}

function applyContextOverrides(node: BTreeNode, context?: Partial<TreeContext>): void {
  if (context && node instanceof BaseNode) {
    node.setContextOverrides(context);
  }
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
 *       agent: confirmAgent,
 *       prompt: 'Generate a brief order confirmation message',
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
  private treeOnElicitation?: OnElicitation;

  constructor(name: string, registry?: TreeRegistry) {
    super(registry);
    this.treeName = name;
  }

  /**
   * Set the default elicitation handler for the entire tree.
   * All AgentNodes inherit this handler unless a closer ancestor overrides it.
   */
  onElicitation(handler: OnElicitation): this {
    this.treeOnElicitation = handler;
    return this;
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
    return new BehaviorTree({
      name: this.treeName,
      root: children[0],
      onElicitation: this.treeOnElicitation,
    });
  }
}

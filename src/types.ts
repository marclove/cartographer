import type { z } from 'zod';
import type { Options } from '@anthropic-ai/claude-agent-sdk';

// --- Node Status ---

/**
 * The result of ticking a behavior tree node.
 *
 * Every node returns one of these three values from its `tick()` method.
 * Composites and decorators use these values to drive control flow:
 *
 * - **SUCCESS** — The node completed its work successfully.
 * - **FAILURE** — The node failed or its condition was not met.
 * - **RUNNING** — The node is still in progress and should be ticked again.
 *
 * When a composite (Sequence, Selector) receives `RUNNING`, it remembers
 * which child returned it and resumes from that child on the next tick.
 *
 * @example
 * ```ts
 * const action = new ActionNode({
 *   name: 'greet',
 *   action: async () => {
 *     console.log('Hello!');
 *     return NodeStatus.SUCCESS;
 *   },
 * });
 * ```
 */
export enum NodeStatus {
  SUCCESS = 'success',
  FAILURE = 'failure',
  RUNNING = 'running',
}

// --- Blackboard ---

/**
 * A shared key-value store that allows nodes to communicate during a tree tick.
 *
 * The blackboard is the primary mechanism for passing data between nodes.
 * It is carried through the tree inside {@link TreeContext} and is accessible
 * to every node during execution.
 *
 * Use {@link scoped} to create namespace-isolated views of the same underlying
 * store. This is especially useful for agent nodes that need their own
 * keyspace without colliding with other nodes.
 *
 * @example
 * ```ts
 * // Writing and reading values
 * blackboard.set('userId', 42);
 * const id = blackboard.get<number>('userId'); // 42
 *
 * // Scoped access — keys are prefixed behind the scenes
 * const scoped = blackboard.scoped('agent1');
 * scoped.set('result', 'done');
 * blackboard.get<string>('agent1:result'); // 'done'
 * ```
 */
export interface Blackboard {
  /** Retrieve a value by key. Returns `undefined` if the key does not exist. */
  get<T>(key: string): T | undefined;

  /** Store a value under the given key, overwriting any previous value. */
  set<T>(key: string, value: T): void;

  /** Check whether a key exists in the blackboard. */
  has(key: string): boolean;

  /** Remove a key and its value from the blackboard. */
  delete(key: string): void;

  /** Return all keys currently stored in this blackboard (or scoped view). */
  keys(): string[];

  /**
   * Create a namespaced view of this blackboard.
   *
   * The returned `Blackboard` prefixes all keys with `namespace:` so that
   * reads and writes are isolated from other namespaces. Scoping can be
   * nested — `scoped('a').scoped('b')` produces keys like `a:b:key`.
   *
   * The scoped view shares the same underlying storage, so values written
   * through a scoped blackboard are visible from the root blackboard
   * (with the full prefixed key) and vice versa.
   */
  scoped(namespace: string): Blackboard;
}

// --- Event Emitter ---

/**
 * The set of events emitted during behavior tree execution.
 *
 * Subscribe to these events via `context.events.on(eventName, listener)` or
 * `tree.events.on(eventName, listener)` to observe node execution, agent
 * activity, blackboard mutations, and strategy decisions.
 *
 * **Node lifecycle events:**
 * - `node:enter` — Fired when a node begins its tick.
 * - `node:exit` — Fired when a node completes its tick (with status and timing).
 * - `node:error` — Fired when a node throws an unhandled error (before returning FAILURE).
 *
 * **Agent events:**
 * - `agent:prompt` — Fired when an AgentNode resolves its prompt and is about to call the SDK.
 * - `agent:thinking` — Fired when the SDK produces a thinking block (chain-of-thought reasoning).
 * - `agent:text` — Fired when the SDK produces a text content block in an assistant message.
 * - `agent:tool_use` — Fired for each tool call the agent makes.
 * - `agent:response` — Fired when the SDK returns a final successful result.
 * - `agent:error` — Fired when the SDK returns an error result (max turns, budget, execution error, etc.).
 * - `agent:stream` — Fired for each raw streaming delta event (text, thinking, input_json).
 * - `agent:message` — Fired for every raw SDK message, enabling custom processing without framework filtering.
 * - `agent:tool_progress` — Fired when the SDK reports tool execution progress with elapsed time.
 * - `agent:init` — Fired when the SDK emits a session init message with model, tools, and config.
 * - `agent:status` — Fired when the SDK emits a status change during execution.
 * - `agent:rate_limit` — Fired when the SDK reports a rate limit event.
 *
 * **Tree lifecycle events:**
 * - `tree:init` — Fired when a `BehaviorTree` is constructed, after ID uniqueness validation passes.
 * - `tree:tick` — Fired after each `BehaviorTree.tick()` completes, with the final status and duration.
 * - `tree:reset` — Fired when `BehaviorTree.reset()` is called.
 * - `tree:abort` — Fired when `BehaviorTree.abort()` is called.
 *
 * **Data events:**
 * - `blackboard:write` — Fired when a value is written to the blackboard.
 * - `strategy:decision` — Fired when an agent strategy makes an ordering or policy decision.
 *
 * @example
 * ```ts
 * tree.events.on('node:exit', ({ node, status, durationMs }) => {
 *   console.log(`${node.name} finished with ${status} in ${durationMs}ms`);
 * });
 *
 * tree.events.on('agent:prompt', ({ node, prompt, mode }) => {
 *   console.log(`Agent "${node.name}" sending ${mode} prompt: ${prompt}`);
 * });
 * ```
 */
export interface TreeEvents {
  'node:enter': { node: BTreeNode; context: TreeContext };
  'node:exit': { node: BTreeNode; status: NodeStatus; context: TreeContext; durationMs: number };
  'node:error': { node: BTreeNode; error: Error; context: TreeContext };
  'agent:prompt': { node: BTreeNode; prompt: string };
  'agent:thinking': { node: BTreeNode; thinking: string };
  'agent:text': { node: BTreeNode; text: string };
  'agent:tool_use': { node: BTreeNode; tool: string; input: unknown };
  'agent:response': { node: BTreeNode; result: unknown; cost?: number };
  'agent:error': {
    node: BTreeNode;
    subtype: string;
    errors?: string[];
    permissionDenials?: unknown;
    cost?: number;
  };
  'agent:stream': { node: BTreeNode; event: unknown };
  'agent:message': { node: BTreeNode; message: unknown };
  'agent:tool_progress': {
    node: BTreeNode;
    toolUseId: string;
    toolName: string;
    elapsedSeconds: number;
  };
  'agent:init': { node: BTreeNode; sessionId: string; model?: string; tools?: unknown; mcpServers?: unknown };
  'agent:status': { node: BTreeNode; status: string };
  'agent:rate_limit': { node: BTreeNode; info: unknown };
  'tree:init': { tree: string; root: string };
  'tree:tick': { tree: string; status: NodeStatus; durationMs: number };
  'tree:reset': { tree: string };
  'tree:abort': { tree: string };
  'blackboard:write': { key: string; value: unknown; source: string };
  'strategy:decision': { composite: BTreeNode; strategy: string; decision: unknown };
}

/**
 * A type-safe event emitter constrained to a specific set of event types.
 *
 * Used throughout the framework with {@link TreeEvents} to provide
 * compile-time checked event names and payload types.
 *
 * @typeParam TEvents - A record mapping event names to their payload types.
 *
 * @example
 * ```ts
 * const emitter: TypedEventEmitter<TreeEvents> = new EventEmitter();
 *
 * // Type-safe — payload type is inferred from the event name
 * emitter.on('node:exit', ({ node, status, durationMs }) => {
 *   // node: BTreeNode, status: NodeStatus, durationMs: number
 * });
 * ```
 */
export interface TypedEventEmitter<TEvents extends { [K in keyof TEvents]: unknown }> {
  /** Subscribe to an event. The listener is called each time the event is emitted. */
  on<K extends keyof TEvents & string>(event: K, listener: (data: TEvents[K]) => void): void;

  /** Unsubscribe a previously registered listener. */
  off<K extends keyof TEvents & string>(event: K, listener: (data: TEvents[K]) => void): void;

  /** Emit an event, invoking all registered listeners with the provided data. */
  emit<K extends keyof TEvents & string>(event: K, data: TEvents[K]): void;

  /** Remove all listeners for all events. */
  removeAllListeners(): void;
}

// --- Tree Context ---

/**
 * The execution context passed to every node during a tree tick.
 *
 * A single `TreeContext` is created at the start of each `BehaviorTree.tick()`
 * call and flows unchanged through every node in the tree. It carries shared
 * state (blackboard), the event system, and an optional abort signal.
 *
 * @example
 * ```ts
 * // Creating a context manually (useful in tests)
 * const context: TreeContext = {
 *   blackboard: new MapBlackboard(),
 *   events: new EventEmitter<TreeEvents>(),
 * };
 *
 * const status = await myNode.tick(context);
 * ```
 */
export interface TreeContext {
  /** Shared key-value store for inter-node communication. */
  blackboard: Blackboard;

  /** Event emitter for observing tree execution. */
  events: TypedEventEmitter<TreeEvents>;

  /**
   * Optional signal for cooperative cancellation.
   *
   * Set automatically by `BehaviorTree` when `abort()` is called.
   * Nodes can check `signal?.aborted` to bail out of long-running work.
   */
  signal?: AbortSignal;
}

// --- Node Interface ---

/**
 * The core interface that all behavior tree nodes must implement.
 *
 * Nodes are the building blocks of a behavior tree. Leaf nodes (actions,
 * conditions, agents) perform work, while composite nodes (sequences,
 * selectors, parallels) and decorators control the flow of execution.
 *
 * @example
 * ```ts
 * // Using a node directly
 * const status = await node.tick(context);
 *
 * if (status === NodeStatus.RUNNING) {
 *   // Tick again later to continue
 *   const finalStatus = await node.tick(context);
 * }
 *
 * // Reset clears any internal state (e.g., RUNNING child index)
 * node.reset();
 * ```
 */
export interface BTreeNode {
  /** A unique identifier for this node instance. */
  readonly id: string;

  /** A human-readable name for this node, used in events and debugging. */
  readonly name: string;

  /**
   * The direct child nodes of this node.
   *
   * Leaf nodes return an empty array. Composites return their child list.
   * Decorators return a single-element array containing their wrapped child.
   * Used by `BehaviorTree` to walk the tree for validation (e.g. ID
   * uniqueness checks).
   */
  readonly children: readonly BTreeNode[];

  /**
   * Execute one tick of this node.
   *
   * Returns `SUCCESS` or `FAILURE` when the node has completed its work,
   * or `RUNNING` if it needs to be ticked again to finish.
   */
  tick(context: TreeContext): Promise<NodeStatus>;

  /**
   * Reset the node to its initial state.
   *
   * Clears any internal tracking such as the current child index in
   * composites, attempt counts in retry decorators, or cached results
   * in agent nodes. Called between tree ticks when `resetBetweenTicks`
   * is enabled on the scheduler.
   */
  reset(): void;

  /**
   * Signal the node to abort any in-progress work.
   *
   * Propagates down through composites and decorators to all descendants.
   */
  abort(): void;
}

// --- Strategy Interfaces ---

/**
 * Controls the order in which a `SelectorNode` evaluates its children.
 *
 * The default strategy preserves the original child order (left-to-right).
 * Use `AgentSelectionStrategy` to let Claude dynamically reorder children
 * based on the current blackboard state and a prompt you provide.
 *
 * The selector tries children in the returned order and stops at the first
 * `SUCCESS` or `RUNNING` result.
 *
 * @example
 * ```ts
 * // Agent-driven selection — Claude picks the best child to try first
 * const strategy = new AgentSelectionStrategy({
 *   prompt: 'Choose the best approach for the current user request',
 *   childDescriptions: {
 *     'quick-reply': 'Send a short predefined response',
 *     'deep-research': 'Do thorough research before responding',
 *   },
 * });
 * ```
 */
export interface SelectionStrategy {
  /** Return children in the order they should be evaluated by the selector. */
  order(children: BTreeNode[], context: TreeContext): Promise<BTreeNode[]>;

  /** Reset any internal state (e.g., cached ordering). */
  reset?(): void;
}

/**
 * Controls the order in which a `SequenceNode` executes its children.
 *
 * The default strategy preserves the original child order (left-to-right).
 * Use `AgentExecutionStrategy` to let Claude dynamically reorder the
 * execution steps based on context.
 *
 * The sequence runs children in the returned order and stops at the first
 * `FAILURE` or `RUNNING` result.
 *
 * @example
 * ```ts
 * // Agent-driven execution ordering
 * const strategy = new AgentExecutionStrategy({
 *   prompt: 'Order these steps for optimal data processing',
 *   model: 'haiku',
 * });
 * ```
 */
export interface ExecutionStrategy {
  /** Return children in the order they should be executed by the sequence. */
  order(children: BTreeNode[], context: TreeContext): Promise<BTreeNode[]>;

  /** Reset any internal state (e.g., cached ordering). */
  reset?(): void;
}

/**
 * Defines the success and failure thresholds for a `ParallelNode`.
 *
 * A parallel node ticks all its children concurrently. The policy determines
 * how many children must succeed (or fail) before the parallel node itself
 * returns a final status.
 *
 * If no policy fields are set, the default behavior requires all children
 * to succeed (equivalent to `{ successCount: children.length }`).
 *
 * @example
 * ```ts
 * // Succeed if at least 2 out of 3 children succeed
 * const policy: ParallelPolicy = { successCount: 2 };
 *
 * // Succeed if 75% of children succeed
 * const policy: ParallelPolicy = { successPercentage: 75 };
 *
 * // Fail immediately if any child fails
 * const policy: ParallelPolicy = { failureCount: 1 };
 * ```
 */
export interface ParallelPolicy {
  /** Minimum number of children that must succeed for the parallel to succeed. */
  successCount?: number;

  /** Minimum percentage (0–100) of children that must succeed. */
  successPercentage?: number;

  /** Number of child failures that triggers an immediate parallel failure. */
  failureCount?: number;
}

/**
 * Controls the success/failure policy for a `ParallelNode`.
 *
 * The default strategy requires all children to succeed. Use
 * `AgentParallelStrategy` to let Claude dynamically decide the policy
 * based on the current context.
 *
 * @example
 * ```ts
 * // Agent-driven parallel policy
 * const strategy = new AgentParallelStrategy({
 *   prompt: 'Decide how many validations must pass',
 *   childDescriptions: {
 *     'schema-check': 'Validates the JSON schema',
 *     'auth-check': 'Verifies authentication tokens',
 *     'rate-limit': 'Checks rate limiting status',
 *   },
 * });
 * ```
 */
export interface ParallelStrategy {
  /** Return the policy that determines when the parallel node succeeds or fails. */
  policy(children: BTreeNode[], context: TreeContext): Promise<ParallelPolicy>;

  /** Reset any internal state (e.g., cached policy). */
  reset?(): void;
}

// --- Agent Strategy Config ---

/**
 * Configuration for agent-powered strategies (`AgentSelectionStrategy`,
 * `AgentExecutionStrategy`, `AgentParallelStrategy`).
 *
 * Agent strategies call the Claude SDK to make runtime decisions about
 * child ordering or parallel policies. The prompt receives information
 * about available children and the current blackboard state.
 *
 * @example
 * ```ts
 * const config: AgentStrategyConfig = {
 *   prompt: 'Given the user intent on the blackboard, order these tasks',
 *   childDescriptions: {
 *     'fetch-data': 'Retrieves data from the API',
 *     'use-cache': 'Returns cached results if available',
 *   },
 *   cache: true, // Reuse the first decision until reset()
 *   options: { model: 'claude-haiku-4-5-20251001', effort: 'low' },
 * };
 * ```
 */
export interface AgentStrategyConfig {
  /**
   * The prompt sent to Claude for the ordering/policy decision.
   *
   * Can be a static string or a function that receives the children and
   * context for dynamic prompt construction. The framework appends child
   * names, descriptions, and blackboard state automatically.
   */
  prompt: string | ((children: BTreeNode[], context: TreeContext) => string);

  /**
   * Human-readable descriptions for each child node, keyed by child name.
   * Included in the prompt to help Claude make informed decisions.
   */
  childDescriptions?: Record<string, string>;

  /**
   * When `true`, the strategy caches its decision *across* execution cycles.
   *
   * Composites already guarantee intra-cycle order stability: the strategy
   * is consulted once when a cycle starts and the order is committed until
   * the cycle completes (SUCCESS/FAILURE) or the node is reset.
   *
   * This flag controls whether the cached decision persists after a cycle
   * completes and a new one begins. When `true`, the strategy returns the
   * same result without calling the SDK again until `reset()` is called.
   */
  cache?: boolean;

  /**
   * SDK options passed directly to the Claude Agent SDK `query()` call.
   *
   * Use this to configure model, effort, thinking, tools, MCP servers,
   * and [any other SDK option](https://platform.claude.com/docs/en/agent-sdk/typescript#options).
   * Defaults applied when not set:
   * - `model`: `'sonnet'`
   * - `effort`: `'low'`
   */
  options?: Partial<Options>;
}

// --- Node Configs ---

/**
 * Configuration for an `ActionNode` — a leaf node that runs a function.
 *
 * Actions are the most common leaf node type. They perform work (API calls,
 * computations, blackboard writes) and return a status.
 *
 * @example
 * ```ts
 * const config: ActionNodeConfig = {
 *   name: 'fetch-user',
 *   action: async (context) => {
 *     const userId = context.blackboard.get<string>('userId');
 *     const user = await fetchUser(userId);
 *     context.blackboard.set('user', user);
 *     return NodeStatus.SUCCESS;
 *   },
 * };
 * ```
 */
export interface ActionNodeConfig {
  /**
   * Optional stable identifier for this node instance.
   *
   * When provided, this value is used as the node's `id` instead of an
   * auto-generated UUID. Useful for stable cross-run log correlation,
   * config-driven identity, and targeted node lookup.
   *
   * Must be unique across all nodes in a tree — `BehaviorTree` validates
   * this at construction time and throws on duplicates.
   */
  id?: string;

  /** Human-readable name for this action node. */
  name: string;

  /**
   * The function to execute when this node is ticked.
   * Return `SUCCESS`, `FAILURE`, or `RUNNING`.
   */
  action: (context: TreeContext) => Promise<NodeStatus> | NodeStatus;
}

/**
 * Configuration for a `ConditionNode` — a leaf node that checks a boolean condition.
 *
 * Conditions return `SUCCESS` when the condition is `true` and `FAILURE`
 * when `false`. They never return `RUNNING`. Commonly used as the first
 * child of a sequence to gate subsequent actions.
 *
 * @example
 * ```ts
 * const config: ConditionNodeConfig = {
 *   name: 'is-authenticated',
 *   condition: (context) => {
 *     return context.blackboard.has('authToken');
 *   },
 * };
 * ```
 */
export interface ConditionNodeConfig {
  /** Optional stable identifier. Auto-generated UUID when omitted. */
  id?: string;

  /** Human-readable name for this condition node. */
  name: string;

  /**
   * The predicate to evaluate. Returning `true` maps to `SUCCESS`,
   * `false` maps to `FAILURE`.
   */
  condition: (context: TreeContext) => Promise<boolean> | boolean;
}

/**
 * Configuration for an `AgentNode` — a leaf node that calls the Claude SDK.
 *
 * Every agent call is an agentic SDK invocation. The blackboard is always
 * exposed via a built-in MCP server. Configure additional tools, MCP
 * servers, system prompts, turn limits, budget caps, and any other SDK
 * option via the `options` field, which is passed directly to the SDK's
 * `query()` function.
 *
 * To request **structured output**, set `options.outputFormat` with a
 * JSON schema. The SDK validates the response and the parsed result is
 * stored on the blackboard at `{name}:output`. You can combine structured
 * output with tools, multi-turn interaction, and all other options.
 *
 * Without `outputFormat`, the raw text response is stored on the blackboard.
 *
 * @example
 * ```ts
 * // Structured output — classify user intent
 * const classifier = new AgentNode({
 *   name: 'classify-intent',
 *   prompt: (ctx) => `Classify: ${ctx.blackboard.get('userMessage')}`,
 *   options: {
 *     outputFormat: {
 *       type: 'json_schema',
 *       schema: { type: 'object', properties: { intent: { type: 'string' }, confidence: { type: 'number' } } },
 *     },
 *   },
 *   mapResult: (output) =>
 *     (output as { confidence: number }).confidence > 0.8
 *       ? NodeStatus.SUCCESS
 *       : NodeStatus.FAILURE,
 * });
 *
 * // Multi-turn with tools — research and write a report
 * const researcher = new AgentNode({
 *   name: 'research-agent',
 *   prompt: 'Research the topic and write a summary',
 *   options: {
 *     systemPrompt: 'You are a research assistant.',
 *     allowedTools: ['web-search', 'read-url'],
 *     maxTurns: 10,
 *     maxBudgetUsd: 0.50,
 *   },
 *   blackboardNamespace: 'research',
 * });
 * ```
 */
export interface AgentNodeConfig {
  /** Optional stable identifier. Auto-generated UUID when omitted. */
  id?: string;

  /** Human-readable name for this agent node. */
  name: string;

  /**
   * The prompt sent to Claude. Can be a static string or a function that
   * receives the tree context for dynamic prompt construction.
   */
  prompt: string | ((context: TreeContext) => string);

  /**
   * Maps the output to a `NodeStatus`. If omitted, the node returns
   * `SUCCESS` when the SDK call succeeds.
   */
  mapResult?: (output: unknown, context: TreeContext) => NodeStatus;

  /**
   * When set, the agent accesses a scoped view of the blackboard where
   * all keys are prefixed with this namespace. This isolates the agent's
   * reads and writes from other nodes.
   */
  blackboardNamespace?: string;

  /**
   * When `true`, the agent caches its result after the first successful
   * execution and returns it on subsequent ticks without calling the SDK
   * again. The cache is cleared when `reset()` is called.
   */
  cache?: boolean;

  /**
   * SDK options passed directly to the Claude Agent SDK `query()` call.
   *
   * Use this to configure model, effort, thinking, tools, MCP servers,
   * system prompt, output format, budget limits, and [any other SDK option](https://platform.claude.com/docs/en/agent-sdk/typescript#options).
   * The blackboard MCP server and its tools are always injected automatically.
   */
  options?: Partial<Options>;
}

// --- Composite Configs ---

/**
 * Configuration for a `SelectorNode` (fallback / OR logic).
 *
 * A selector ticks its children in order and returns `SUCCESS` as soon as
 * any child succeeds. If all children fail, the selector returns `FAILURE`.
 * If a child returns `RUNNING`, the selector returns `RUNNING` and resumes
 * from that child on the next tick.
 *
 * An optional {@link SelectionStrategy} controls the child evaluation order.
 */
export interface SelectorConfig {
  /** Optional stable identifier. Auto-generated UUID when omitted. */
  id?: string;

  /** Human-readable name for this selector. */
  name: string;

  /** The child nodes to evaluate. */
  children: BTreeNode[];

  /**
   * Strategy that controls child evaluation order.
   * Defaults to left-to-right (original insertion order).
   */
  strategy?: SelectionStrategy;
}

/**
 * Configuration for a `SequenceNode` (AND logic).
 *
 * A sequence ticks its children in order and returns `FAILURE` as soon as
 * any child fails. If all children succeed, the sequence returns `SUCCESS`.
 * If a child returns `RUNNING`, the sequence returns `RUNNING` and resumes
 * from that child on the next tick.
 *
 * An optional {@link ExecutionStrategy} controls the child execution order.
 */
export interface SequenceConfig {
  /** Optional stable identifier. Auto-generated UUID when omitted. */
  id?: string;

  /** Human-readable name for this sequence. */
  name: string;

  /** The child nodes to execute. */
  children: BTreeNode[];

  /**
   * Strategy that controls child execution order.
   * Defaults to left-to-right (original insertion order).
   */
  strategy?: ExecutionStrategy;
}

/**
 * Configuration for a `ParallelNode` (concurrent execution).
 *
 * A parallel node ticks all its children concurrently and uses a
 * {@link ParallelPolicy} to determine when to return `SUCCESS` or `FAILURE`.
 * While any child is still `RUNNING`, the parallel node returns `RUNNING`.
 *
 * An optional {@link ParallelStrategy} controls the success/failure policy.
 */
export interface ParallelConfig {
  /** Optional stable identifier. Auto-generated UUID when omitted. */
  id?: string;

  /** Human-readable name for this parallel node. */
  name: string;

  /** The child nodes to execute concurrently. */
  children: BTreeNode[];

  /**
   * Strategy that determines the success/failure policy.
   * Defaults to requiring all children to succeed.
   */
  strategy?: ParallelStrategy;
}

// --- Decorator Configs ---

/**
 * Base configuration for all decorator nodes.
 *
 * Decorators wrap a single child node and modify its behavior or result.
 */
export interface DecoratorConfig {
  /** Optional stable identifier. Auto-generated UUID when omitted. */
  id?: string;

  /** Human-readable name for this decorator. */
  name: string;

  /** The child node to wrap. */
  child: BTreeNode;
}

/**
 * Configuration for a `RepeatNode` decorator.
 *
 * Repeats its child a fixed number of times or until a target status
 * is reached.
 *
 * @example
 * ```ts
 * // Repeat 5 times
 * const config: RepeatConfig = { name: 'retry-loop', child: myNode, count: 5 };
 *
 * // Repeat until the child fails
 * const config: RepeatConfig = {
 *   name: 'until-fail',
 *   child: myNode,
 *   untilStatus: NodeStatus.FAILURE,
 * };
 * ```
 */
export interface RepeatConfig extends DecoratorConfig {
  /**
   * Number of times to repeat the child. If omitted and `untilStatus` is
   * set, repeats indefinitely until that status is returned.
   */
  count?: number;

  /** Stop repeating when the child returns this status. */
  untilStatus?: NodeStatus;
}

/**
 * Configuration for a `RetryNode` decorator.
 *
 * Retries its child on `FAILURE` up to a maximum number of attempts.
 * Returns `SUCCESS` if the child succeeds on any attempt, or `FAILURE`
 * if all attempts are exhausted.
 *
 * @example
 * ```ts
 * const config: RetryConfig = {
 *   name: 'retry-api-call',
 *   child: apiCallNode,
 *   maxAttempts: 3,
 *   delayMs: 1000, // Wait 1 second between retries
 * };
 * ```
 */
export interface RetryConfig extends DecoratorConfig {
  /** Maximum number of retry attempts (including the first try). */
  maxAttempts: number;

  /** Milliseconds to wait between retry attempts. */
  delayMs?: number;
}

/**
 * Configuration for a `TimeoutNode` decorator.
 *
 * Wraps a child with a time limit. If the child does not complete within
 * `timeoutMs` milliseconds, the decorator returns `FAILURE` and aborts
 * the child.
 *
 * @example
 * ```ts
 * const config: TimeoutConfig = {
 *   name: 'time-limited',
 *   child: longRunningNode,
 *   timeoutMs: 5000, // 5 second limit
 * };
 * ```
 */
export interface TimeoutConfig extends DecoratorConfig {
  /** Maximum time in milliseconds before the child is aborted. */
  timeoutMs: number;
}

/**
 * Configuration for a `GuardNode` decorator.
 *
 * Evaluates a condition before ticking its child. If the condition returns
 * `false`, the guard returns `FAILURE` without ticking the child.
 *
 * @example
 * ```ts
 * const config: GuardConfig = {
 *   name: 'require-auth',
 *   child: protectedAction,
 *   condition: (ctx) => ctx.blackboard.has('authToken'),
 * };
 * ```
 */
export interface GuardConfig extends DecoratorConfig {
  /**
   * The predicate to evaluate before ticking the child.
   * Returning `false` causes the guard to return `FAILURE`.
   */
  condition: (context: TreeContext) => Promise<boolean> | boolean;
}

// --- Behavior Tree Config ---

/**
 * Configuration for a `BehaviorTree` — the top-level tree runner.
 *
 * The behavior tree manages a root node, a shared blackboard, an event
 * emitter, and an abort controller. Call `tick()` to execute the tree
 * and `reset()` to clear all node state between runs.
 *
 * @example
 * ```ts
 * const config: BehaviorTreeConfig = {
 *   name: 'my-tree',
 *   root: sequenceNode,
 *   blackboard: new MapBlackboard(), // Optional, created automatically if omitted
 * };
 *
 * const tree = new BehaviorTree(config);
 * const status = await tree.tick();
 * ```
 */
export interface BehaviorTreeConfig {
  /** Human-readable name for this behavior tree. */
  name: string;

  /** The root node of the tree. Execution starts here on every tick. */
  root: BTreeNode;

  /**
   * The blackboard instance to use. If omitted, a new `MapBlackboard`
   * is created automatically.
   */
  blackboard?: Blackboard;
}

// --- Scheduler ---

/**
 * Configuration for a `TreeScheduler` — runs a behavior tree on a schedule.
 *
 * The scheduler supports three schedule types:
 * - `'cron'` — Run on a cron expression (e.g., `'0 * * * *'` for hourly).
 * - `'interval'` — Wait `delayMs` milliseconds between ticks.
 * - `'once'` — Run a single time, then stop.
 *
 * The scheduler can automatically stop based on run count, tree result
 * status, or error handling policy. Between ticks, the tree is reset by
 * default to clear any RUNNING state from the previous execution.
 *
 * @example
 * ```ts
 * const config: SchedulerConfig = {
 *   tree: myBehaviorTree,
 *   schedule: { type: 'interval', delayMs: 60_000 },
 *   maxRuns: 10,
 *   stopOnStatus: NodeStatus.SUCCESS,
 *   onError: (error, runCount) => {
 *     console.error(`Run ${runCount} failed:`, error);
 *     return runCount >= 3 ? 'stop' : 'continue';
 *   },
 * };
 * ```
 */
export interface SchedulerConfig {
  /**
   * The behavior tree (or tree-like object) to schedule.
   * Must support `tick()`, `reset()`, and expose an `events` emitter.
   */
  tree: { tick(): Promise<NodeStatus>; reset(): void; readonly events: TypedEventEmitter<TreeEvents> };

  /** When and how often to tick the tree. */
  schedule:
    | { type: 'cron'; expression: string }
    | { type: 'interval'; delayMs: number }
    | { type: 'once' };

  /** Maximum number of ticks before the scheduler stops. */
  maxRuns?: number;

  /** Stop the scheduler when the tree returns this status. */
  stopOnStatus?: NodeStatus;

  /**
   * Whether to call `tree.reset()` before each tick. Defaults to `true`.
   * Set to `false` if the tree should retain RUNNING state between ticks.
   */
  resetBetweenTicks?: boolean;

  /**
   * How to handle errors thrown during a tick.
   * - `'stop'` — Stop the scheduler immediately.
   * - `'continue'` — Log the error and keep going.
   * - A function — Receives the error and run count, returns `'stop'` or `'continue'`.
   */
  onError?: 'stop' | 'continue' | ((error: Error, runCount: number) => 'stop' | 'continue');
}

/**
 * Events emitted by the `TreeScheduler` during its lifecycle.
 *
 * Subscribe via `scheduler.events.on(eventName, listener)` to monitor
 * tick execution, errors, and scheduler stop reasons.
 *
 * @example
 * ```ts
 * scheduler.events.on('tick:complete', ({ runCount, status, durationMs }) => {
 *   console.log(`Tick #${runCount}: ${status} (${durationMs}ms)`);
 * });
 *
 * scheduler.events.on('scheduler:stop', ({ reason }) => {
 *   console.log(`Scheduler stopped: ${reason}`);
 * });
 * ```
 */
export interface SchedulerEvents {
  'tick:start': { runCount: number; timestamp: Date };
  'tick:complete': { runCount: number; status: NodeStatus; durationMs: number };
  'tick:error': { runCount: number; error: Error };
  'scheduler:stop': { reason: 'manual' | 'maxRuns' | 'stopOnStatus' | 'error' };
}

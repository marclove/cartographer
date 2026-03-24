import { BaseNode } from './base.js';
import { NodeStatus } from '../types.js';
import type { AgentNodeConfig, BTreeNode, TreeContext, SessionConfig } from '../types.js';
import type { NodeState } from '../core/serialization.js';
import type { AgentMessage, AgentInfo, AgentSessionOptions } from '../agent/agent.js';
import { wrapElicitation } from '../agent/sdk-helpers.js';
import { computeContentHash } from '../core/content-hash.js';

/**
 * A leaf node that delegates prompt processing to an {@link Agent}.
 *
 * `AgentNode` brings AI reasoning into the behavior tree. It sends a
 * prompt to its configured Agent and iterates the response messages.
 * The Agent handles all provider-specific concerns (SDK configuration,
 * MCP servers, structured output, etc.) while AgentNode focuses on
 * BT integration: prompt resolution, event emission, blackboard I/O,
 * `mapResult`, and caching.
 *
 * ---
 *
 * ## Blackboard namespace
 *
 * When `blackboardNamespace` is set, the agent accesses a scoped view
 * of the blackboard. Reads and writes are prefixed with the namespace,
 * keeping the agent's data isolated from other nodes. The full prefixed
 * keys (e.g. `research:output`) remain accessible from the root blackboard.
 *
 * ## Result caching
 *
 * When `cache: true`, the status returned by the first successful execution
 * is stored internally and returned on all subsequent ticks without calling
 * the agent. The cache is cleared when `reset()` is called.
 *
 * ## Events emitted
 *
 * | Event | When |
 * |---|---|
 * | `agent:prompt` | After the prompt is resolved, before calling the agent |
 * | `agent:thinking` | When the agent produces a thinking (chain-of-thought) block |
 * | `agent:text` | When the agent produces a text content block |
 * | `agent:tool_use` | For each tool call the agent makes |
 * | `agent:response` | When the agent returns a successful final result |
 * | `agent:error` | When the agent returns an error result |
 */
export class AgentNode extends BaseNode {
  private config: AgentNodeConfig;
  private readonly _sessionConfig: SessionConfig | null;

  /**
   * Stores the cached `NodeStatus` when `config.cache` is `true`.
   * `null` means no cached result is available (either caching is disabled
   * or `reset()` has been called since the last execution).
   */
  private cachedStatus: NodeStatus | null = null;
  private _lastTerminalStatus: NodeStatus | null = null;

  /**
   * Create a new AgentNode.
   *
   * @param config - The agent node configuration. At minimum requires `name`,
   *   `agent` (the {@link Agent} instance), and `prompt` (static string or
   *   context-aware function). See {@link AgentNodeConfig} for optional fields
   *   like `cache`, `mapResult`, `blackboardNamespace`, and `session`.
   */
  constructor(config: AgentNodeConfig) {
    super(config.name, config.id);
    this.config = config;
    this._sessionConfig = !config.session ? null
      : typeof config.session === 'string' ? { name: config.session }
      : config.session;
  }

  /** Read-only access to agent metadata for introspection (e.g. dashboard API). */
  get agentOptions(): AgentInfo {
    return this.config.agent.getInfo();
  }

  /**
   * Normalized session configuration, or `null` if no session is configured.
   *
   * The shorthand string form (`session: "triage"`) is normalized to a full
   * {@link SessionConfig} object (`{ name: "triage" }`) once at construction.
   * Used internally by {@link resolveSessionOptions} and by the session
   * concurrency validator at tree construction time.
   */
  get sessionConfig(): SessionConfig | null {
    return this._sessionConfig;
  }

  /**
   * Compute a deterministic content hash for serialization identity.
   *
   * Includes the node name and, for static prompts, the prompt text itself.
   * Dynamic (function) prompts are excluded because their output varies
   * across ticks and cannot produce a stable hash.
   */
  protected override computeHash(): string {
    const prompt = typeof this.config.prompt === 'string' ? this.config.prompt : '';
    return computeContentHash('AgentNode', this.config.name, prompt);
  }

  /**
   * Reset the node to its initial state.
   *
   * Clears both the cached status and any in-flight work, so the next
   * tick starts a fresh agent call. Called by the tree's `reset()` method
   * and when a parent composite resets its children.
   */
  reset(): void {
    this.cachedStatus = null;
    this._inflightState = null;
  }

  /**
   * Abort any in-flight agent call and discard all execution state.
   *
   * Detaches the in-flight promise (suppressing its rejection) so the node
   * can be garbage collected cleanly. Unlike {@link interrupt}, abort does
   * not preserve cached results.
   */
  abort(): void {
    const pending = this._inflightState?.promise;
    this._inflightState = null;
    pending?.catch(() => {});
  }

  /**
   * Cancel the in-flight agent call without clearing cached results.
   *
   * Unlike {@link abort}, `interrupt()` preserves the `cachedStatus` from
   * any previously completed execution.
   */
  override interrupt(): void {
    const pending = this._inflightState?.promise;
    this._inflightState = null;
    pending?.catch(() => {});
    // Deliberately does NOT clear cachedStatus — previously completed
    // cached results survive interrupt.
  }

  /**
   * Serialize this node's execution state for persistence.
   *
   * Only the last terminal status (SUCCESS or FAILURE) is persisted.
   * In-flight state and cached results are transient and not serialized.
   *
   * @returns A {@link NodeState} containing `lastStatus` if a terminal
   *   status has been reached, or an empty object otherwise.
   */
  override serialize(): NodeState {
    return this._lastTerminalStatus !== null
      ? { lastStatus: this._lastTerminalStatus }
      : {};
  }

  /**
   * Restore this node's execution state from a previously serialized snapshot.
   *
   * @param state - The serialized state produced by {@link serialize}.
   * @param _hashToNode - Node lookup map (unused by AgentNode; required by the
   *   base interface for composites that need to re-link child references).
   */
  override restore(state: NodeState, _hashToNode: Map<string, BTreeNode>): void {
    if (state.lastStatus !== undefined) {
      this._lastTerminalStatus = state.lastStatus;
    }
  }

  /**
   * Run the agent's tick logic.
   *
   * Uses a fire-and-poll pattern across ticks:
   *
   * 1. **Cache hit** — if `cache: true` and a previous result exists, return
   *    the cached status immediately without contacting the agent.
   * 2. **Poll** — if an in-flight call exists, check whether it has settled.
   *    Return the result/error if done, or `RUNNING` if still pending.
   * 3. **Start** — no in-flight work exists, so kick off
   *    {@link _executeAgentCall} in the background and return `RUNNING`.
   *    The promise result is captured via `.then()` for polling on the next tick.
   *
   * @param context - The current tick's tree context (blackboard, events, signal, sessions).
   * @returns The node's status for this tick.
   */
  protected async execute(context: TreeContext): Promise<NodeStatus> {
    // Return the cached result from a previous tick.
    if (this.config.cache && this.cachedStatus !== null) {
      return this.cachedStatus;
    }

    // Poll path: check for completed inflight work
    if (this._inflightState) {
      if (this._inflightState.error) {
        const error = this._inflightState.error;
        this._inflightState = null;
        throw error;
      }
      if (this._inflightState.result !== undefined) {
        const result = this._inflightState.result;
        this._inflightState = null;
        if (result !== NodeStatus.RUNNING) {
          this._lastTerminalStatus = result;
        }
        return result;
      }
      // Still in progress
      return NodeStatus.RUNNING;
    }

    // Start path: kick off the agent call in the background
    const sessionOpts = this.resolveSessionOptions(context);
    const state: { promise: Promise<NodeStatus>; result?: NodeStatus; error?: Error } = {
      promise: this._executeAgentCall(context, sessionOpts),
    };
    state.promise.then(
      (status) => { state.result = status; },
      (error) => { state.error = error instanceof Error ? error : new Error(String(error)); },
    );
    this._inflightState = state;
    return NodeStatus.RUNNING;
  }

  /**
   * Execute the full agent call lifecycle: resolve the prompt, send it to the
   * agent, process streaming messages, and return the final status.
   *
   * Runs in the background (started by {@link execute}) so that `execute()`
   * can return `RUNNING` immediately. The method:
   *
   * 1. Resolves the prompt (static string or dynamic function).
   * 2. Emits `agent:prompt` before calling the agent.
   * 3. Iterates the agent's response stream, registering the session on
   *    `session_start` and delegating other messages to {@link emitAgentEvent}.
   * 4. On `result`, calls {@link handleSuccess} or emits `agent:error` and
   *    returns `FAILURE`.
   * 5. Returns `FAILURE` if the stream ends without a `result` message.
   *
   * @param context - The current tick's tree context.
   * @param sessionOpts - Resolved session options from {@link resolveSessionOptions}.
   * @returns The terminal status (`SUCCESS` or `FAILURE`) once the agent completes.
   */
  private async _executeAgentCall(
    context: TreeContext,
    sessionOpts?: AgentSessionOptions,
  ): Promise<NodeStatus> {
    const prompt = typeof this.config.prompt === 'function'
      ? this.config.prompt(context)
      : this.config.prompt;

    context.events.emit('agent:prompt', { node: this, prompt });

    const messages = this.config.agent.send(prompt, {
      blackboard: context.blackboard,
      blackboardNamespace: this.config.blackboardNamespace,
      signal: context.signal,
      onElicitation: wrapElicitation(context.onElicitation, this, context.events),
      onMessage: (msg) => this.emitAgentEvent(msg, context),
      session: sessionOpts,
    });

    for await (const msg of messages) {
      if (msg.type === 'session_start') {
        this.registerSession(context, msg.sessionId);
        continue;
      }

      if (msg.type === 'result') {
        if (msg.subtype === 'success') {
          return this.handleSuccess(msg.output, msg.cost, context);
        }

        context.events.emit('agent:error', {
          node: this,
          subtype: 'error',
          errors: (msg.errors ?? []) as string[],
          cost: msg.cost,
        });
        return NodeStatus.FAILURE;
      }
    }

    return NodeStatus.FAILURE;
  }

  /**
   * Process a successful agent result.
   *
   * 1. Emits `agent:response` with the output and cost.
   * 2. Writes the output to the blackboard under `{name}:output` (or
   *    `{namespace}:{name}:output` when a blackboard namespace is set).
   * 3. If `mapResult` is configured, delegates status determination to it;
   *    otherwise returns `SUCCESS`.
   * 4. Caches the resulting status when `cache: true`.
   *
   * @param output - The agent's parsed output (structured or text).
   * @param cost - The total cost in USD reported by the agent, if available.
   * @param context - The current tick's tree context.
   * @returns The node status to propagate up the tree.
   */
  private handleSuccess(output: unknown, cost: number | undefined, context: TreeContext): NodeStatus {
    context.events.emit('agent:response', {
      node: this,
      result: output,
      cost,
    });

    if (output !== undefined) {
      const ns = this.config.blackboardNamespace;
      const key = ns ? `${ns}:${this.name}:output` : `${this.name}:output`;
      context.blackboard.set(key, output);
    }

    if (this.config.mapResult) {
      const status = this.config.mapResult(output, context);
      if (this.config.cache) {
        this.cachedStatus = status;
      }
      return status;
    }

    if (this.config.cache) {
      this.cachedStatus = NodeStatus.SUCCESS;
    }
    return NodeStatus.SUCCESS;
  }

  /**
   * Resolve the session options to pass to `Agent.send()` based on the node's
   * session configuration and the current session registry.
   *
   * - **No session configured** → returns `undefined` (agent manages its own
   *   private session).
   * - **Fork mode** → looks up the parent session ID in the registry and returns
   *   `{ id, fork: true }`. Throws if the parent session has not been registered
   *   yet (a resume-mode agent must run first).
   * - **Resume mode** → returns `{ id }` if the session exists in the registry,
   *   or `{}` to create a new session on first use.
   *
   * @param context - The current tick's tree context (provides session registry).
   * @returns Session options for `Agent.send()`, or `undefined` if no session is configured.
   * @throws Error if fork mode is used but the parent session does not exist.
   */
  private resolveSessionOptions(context: TreeContext): AgentSessionOptions | undefined {
    const config = this.sessionConfig;
    if (!config) return undefined;

    const registry = context.sessions;

    if (config.fork) {
      const existingId = registry.get(config.name);
      if (!existingId) {
        throw new Error(
          `Cannot fork session "${config.name}": session does not exist. ` +
          `Ensure an agent resumes this session before another agent forks it.`,
        );
      }
      return { id: existingId, fork: true };
    }

    const existingId = registry.get(config.name);
    return existingId ? { id: existingId } : {};
  }

  /**
   * Register the provider session ID in the tree's session registry.
   *
   * Registration behavior depends on the fork mode:
   * - **Named fork** (`fork: "analyst"`) → registers under the fork name.
   * - **Resume mode** (no fork) → registers under the session's own name.
   * - **Anonymous fork** (`fork: true`) → not registered, since the session
   *   is ephemeral and should not be resumed by other agents.
   *
   * @param context - The current tick's tree context (provides session registry).
   * @param sessionId - The provider session ID returned by the agent.
   */
  private registerSession(context: TreeContext, sessionId: string): void {
    const config = this.sessionConfig;
    if (!config) return;

    if (typeof config.fork === 'string') {
      context.sessions.set(config.fork, sessionId);
    } else if (!config.fork) {
      context.sessions.set(config.name, sessionId);
    }
    // Anonymous fork (fork: true) — don't register
  }

  /**
   * Map an {@link AgentMessage} to the corresponding `agent:*` tree event.
   *
   * Called as the `onMessage` callback during the agent's response stream.
   * Most message types map 1:1 to a tree event. `provider_event` messages
   * are mapped via a lookup table from SDK subtypes to tree event names.
   *
   * `session_start` is a no-op here — it is handled directly by
   * {@link _executeAgentCall} via {@link registerSession}. `result` events
   * are also emitted directly in `_executeAgentCall` rather than here.
   *
   * @param msg - The agent message to translate.
   * @param context - The current tick's tree context (provides the event emitter).
   */
  private emitAgentEvent(msg: AgentMessage, context: TreeContext): void {
    switch (msg.type) {
      case 'thinking':
        context.events.emit('agent:thinking', { node: this, thinking: msg.content });
        break;
      case 'text':
        context.events.emit('agent:text', { node: this, text: msg.content });
        break;
      case 'tool_use':
        context.events.emit('agent:tool_use', { node: this, tool: msg.name, input: msg.input });
        break;
      case 'stream':
        context.events.emit('agent:stream', { node: this, event: msg.event });
        break;
      case 'session_start':
        // Handled by _executeAgentCall — not forwarded as a BT event
        break;
      case 'provider_event': {
        const d = msg.data as Record<string, unknown>;
        const eventMap: Record<string, string> = {
          tool_progress: 'agent:tool_progress',
          init: 'agent:init',
          status: 'agent:status',
          rate_limit: 'agent:rate_limit',
        };
        const eventName = eventMap[msg.subtype];
        if (eventName) {
          (context.events.emit as any)(eventName, { node: this, ...d });
        }
        break;
      }
      // result events are emitted directly in _executeAgentCall
    }
  }
}

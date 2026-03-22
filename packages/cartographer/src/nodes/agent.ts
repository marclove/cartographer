import { BaseNode } from './base.js';
import { NodeStatus } from '../types.js';
import type { AgentNodeConfig, BTreeNode, TreeContext } from '../types.js';
import type { NodeState } from '../core/serialization.js';
import type { AgentMessage, AgentInfo } from '../agent/agent.js';
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

  /**
   * Stores the cached `NodeStatus` when `config.cache` is `true`.
   * `null` means no cached result is available (either caching is disabled
   * or `reset()` has been called since the last execution).
   */
  private cachedStatus: NodeStatus | null = null;
  private _lastTerminalStatus: NodeStatus | null = null;

  constructor(config: AgentNodeConfig) {
    super(config.name, config.id);
    this.config = config;
  }

  /** Read-only access to agent metadata for introspection (e.g. dashboard API). */
  get agentOptions(): AgentInfo {
    return this.config.agent.getInfo();
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
   * Clear the cached status so the next tick calls the agent again.
   */
  reset(): void {
    this.cachedStatus = null;
    this._inflightState = null;
  }

  /**
   * Abort the in-flight agent call, if any.
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
   */
  override serialize(): NodeState {
    return this._lastTerminalStatus !== null
      ? { lastStatus: this._lastTerminalStatus }
      : {};
  }

  /**
   * Restore this node's execution state from a previously serialized snapshot.
   */
  override restore(state: NodeState, _hashToNode: Map<string, BTreeNode>): void {
    if (state.lastStatus !== undefined) {
      this._lastTerminalStatus = state.lastStatus;
    }
  }

  /**
   * Run the agent's tick logic.
   *
   * On the first tick, kicks off the agent call in the background and
   * returns `RUNNING`. On subsequent ticks, polls for a completed result.
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
    const state: { promise: Promise<NodeStatus>; result?: NodeStatus; error?: Error } = {
      promise: this._executeAgentCall(context),
    };
    state.promise.then(
      (status) => { state.result = status; },
      (error) => { state.error = error instanceof Error ? error : new Error(String(error)); },
    );
    this._inflightState = state;
    return NodeStatus.RUNNING;
  }

  /**
   * The actual agent call logic, extracted from execute() so it can run
   * in the background while execute() returns RUNNING immediately.
   */
  private async _executeAgentCall(context: TreeContext): Promise<NodeStatus> {
    const prompt = typeof this.config.prompt === 'function'
      ? this.config.prompt(context)
      : this.config.prompt;

    context.events.emit('agent:prompt', { node: this, prompt });

    const messages = this.config.agent.send(prompt, {
      blackboard: context.blackboard,
      blackboardNamespace: this.config.blackboardNamespace,
      signal: context.signal,
      onElicitation: context.onElicitation,
      onMessage: (msg) => this.emitAgentEvent(msg, context),
    });

    for await (const msg of messages) {
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
   * Handle a successful agent result: store on blackboard, apply mapResult.
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
   * Map an AgentMessage to the corresponding BT agent:* event.
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
      case 'provider_event': {
        const d = msg.data as Record<string, unknown>;
        const eventMap: Record<string, string> = {
          stream_event: 'agent:stream',
          tool_progress: 'agent:tool_progress',
          init: 'agent:init',
          status: 'agent:status',
          rate_limit: 'agent:rate_limit',
          elicitation_declined: 'agent:elicitation_declined',
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

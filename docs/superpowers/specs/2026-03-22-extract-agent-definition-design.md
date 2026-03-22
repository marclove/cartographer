# Extract Agent Definition from AgentNode

## Problem

`AgentNode` is a ~470-line monolith that handles agent configuration, SDK invocation, message processing, blackboard I/O, caching, abort lifecycle, and result mapping. Agent definitions are not reusable — each `AgentNode` instance owns its own SDK configuration, so two nodes that should talk to the same agent (e.g., multi-turn conversation) cannot share one.

## Goals

1. Extract a reusable `Agent` abstraction from `AgentNode` so agent definitions are independent of behavior tree nodes.
2. Define an abstract `Agent` class with a concrete `ClaudeSDKAgent` implementation, establishing the pattern for future providers (e.g., ACP-based agents).
3. Refocus `AgentNode` on BT concerns: prompt resolution, event emission, blackboard I/O, `mapResult`, and caching.
4. Migrate agent strategies (`AgentSelectionStrategy`, `AgentExecutionStrategy`, `AgentParallelStrategy`) to use the `Agent` abstraction.

## Non-Goals

- Implementing an ACP-based agent (out of scope, but the abstraction must accommodate it).
- Migrating to the Claude Agent SDK V2 preview (unstable; use V1 stable API).
- Changing the BT execution model or node lifecycle.

---

## Design

### Abstract Agent Class

Lives in `src/agent/agent.ts`. Defines the provider-agnostic interface for all agents.

```ts
interface AgentConfig {
  /** Human-readable name for identification and debugging. */
  name: string;
}

interface AgentSendOptions {
  /** Blackboard for agent access. Provider decides how to expose it. */
  blackboard?: Blackboard;
  /** Namespace for scoped blackboard access. */
  blackboardNamespace?: string;
  /** Abort signal for cancellation. */
  signal?: AbortSignal;
  /** Elicitation handler for interactive input requests. */
  onElicitation?: OnElicitation;
}

abstract class Agent {
  readonly name: string;

  constructor(config: AgentConfig) { ... }

  /** Enqueue a prompt for the agent to process. */
  abstract send(prompt: string, options?: AgentSendOptions): void;

  /** Yields response messages as they arrive across all sent prompts. */
  abstract [Symbol.asyncIterator](): AsyncIterableIterator<AgentMessage>;

  /**
   * One-shot structured query. Default implementation uses send + iterate,
   * collects messages until a result, and returns the typed output.
   * Concrete classes can override for efficiency.
   */
  async query<T>(prompt: string, schema: JSONSchema, options?: AgentSendOptions): Promise<T> {
    // Default: include schema in prompt, send, iterate to result, parse JSON
  }

  /** Clean up resources (e.g., SDK subprocess). */
  abstract close(): void;
}
```

Key decisions:

- `blackboard` in `AgentSendOptions`, not the constructor — namespace may differ between AgentNodes sharing the same Agent, and strategies don't need it.
- `signal` in `AgentSendOptions` — AgentNode bridges the tree's abort signal per-tick.
- `onElicitation` in `AgentSendOptions` — both Claude SDK and ACP support elicitation; AgentNode passes `context.onElicitation` through.
- `query()` has a default implementation — concrete classes must only implement `send` + iterator + `close`. They can override `query()` for provider-native structured output.
- `close()` is required — agents may own long-lived resources (SDK subprocess, ACP session).

### AgentMessage Types

Discriminated union yielded by the async iterator. Provider-agnostic — each concrete Agent maps its provider's responses into these types.

```ts
type AgentMessage =
  // Core messages — all providers must synthesize these
  | { type: 'thinking'; content: string }
  | { type: 'text'; content: string }
  | { type: 'tool_use'; name: string; input?: unknown }
  | { type: 'result'; subtype: 'success'; output: unknown; cost?: number; usage?: AgentUsage }
  | { type: 'result'; subtype: 'error'; errors?: unknown[]; cost?: number; usage?: AgentUsage }
  // Provider-specific observability — forwarded but not required
  | { type: 'provider_event'; subtype: string; data: unknown };

interface AgentUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  thoughtTokens?: number;
}
```

Provider mapping:

| AgentMessage type | Claude SDK source | ACP source |
|---|---|---|
| `thinking` | Thinking content block | `agent_thought_chunk` notification |
| `text` | Text content block | `agent_message_chunk` notification |
| `tool_use` | `tool_use` content block (name + input) | `tool_call` notification (title + rawInput, observational) |
| `result` (success) | `result` message with `subtype: 'success'` | Synthesized from `StopReason: 'end_turn'` + accumulated text |
| `result` (error) | `result` message with error subtype | Synthesized from `StopReason: 'refusal'/'cancelled'` etc. |
| `provider_event` | Stream deltas, init, status, rate_limit | `tool_call_update`, `usage_update`, `plan`, etc. |

ACP does not support structured output natively. The default `query()` implementation handles this via prompt engineering + JSON parsing. `ClaudeSDKAgent` overrides with the SDK's native `queryStructured()`.

### ClaudeSDKAgent

Lives in `src/agent/claude-sdk-agent.ts`. Wraps the Claude Agent SDK using the V1 stable API.

```ts
interface ClaudeSDKAgentConfig extends AgentConfig {
  /** Model identifier (e.g., 'claude-haiku-4-5'). */
  model?: string;
  /** System prompt for the agent. */
  systemPrompt?: string;
  /** SDK options: tools, MCP servers, maxTurns, effort, budget, permissions, etc. */
  options?: Partial<Options>;
}

class ClaudeSDKAgent extends Agent {
  private queryInstance: Query | null = null;
  private messageQueue: AsyncQueue<SDKUserMessage>;

  constructor(config: ClaudeSDKAgentConfig) { ... }

  send(prompt: string, options?: AgentSendOptions): void {
    // 1. If blackboard provided, creates blackboard MCP server (scoped to namespace)
    //    and updates SDK options via queryInstance.setMcpServers()
    // 2. If onElicitation provided, wraps with wrapElicitation()
    // 3. Bridges abort signal to SDK AbortController
    // 4. Builds SDKUserMessage from prompt string
    // 5. Pushes onto messageQueue
  }

  async *[Symbol.asyncIterator](): AsyncIterableIterator<AgentMessage> {
    // Lazily creates SDK query on first iteration:
    //   query({ prompt: this.messageQueue, options: mergedOptions })
    //
    // Maps each SDKMessage to AgentMessage:
    //   - assistant content blocks → thinking / text / tool_use
    //   - result → { type: 'result', ... }
    //   - other → { type: 'provider_event', ... }
    //
    // Iterator stays alive across turns. After one turn's result,
    // waits for next queued message.
  }

  /** Uses SDK's native queryStructured() for schema-validated output. */
  override async query<T>(prompt: string, schema: JSONSchema, options?: AgentSendOptions): Promise<T> { ... }

  close(): void {
    this.queryInstance?.close();
    this.queryInstance = null;
  }
}
```

What moves from AgentNode into ClaudeSDKAgent:

- All SDK imports and `query()` calls
- Blackboard MCP server creation (`createBlackboardMcpServer`)
- `$schema` stripping from `outputFormat`
- The `sdkAbortHandlerInstalled` unhandled rejection workaround
- `AbortController` bridging
- SDK message-to-event mapping (currently `emitMessageEvents`)

Multi-turn conversation is supported via the V1 `AsyncIterable<SDKUserMessage>` prompt pattern. The Agent owns a single long-lived `query()` call, and `send()` pushes messages into the async iterable. Conversation context accumulates naturally across turns within the SDK.

### AgentNode Changes

AgentNode shrinks to BT-only concerns. No longer imports or knows about the Claude SDK.

```ts
interface AgentNodeConfig {
  id?: string;
  name: string;
  agent: Agent;                                        // replaces options: Partial<Options>
  prompt: string | ((context: TreeContext) => string);
  mapResult?: (output: unknown, context: TreeContext) => NodeStatus;
  blackboardNamespace?: string;
  cache?: boolean;
}
```

The core execution method becomes:

```ts
private async _executeAgentCall(context: TreeContext): Promise<NodeStatus> {
  const prompt = typeof this.config.prompt === 'function'
    ? this.config.prompt(context)
    : this.config.prompt;

  context.events.emit('agent:prompt', { node: this, prompt });

  this.config.agent.send(prompt, {
    blackboard: context.blackboard,
    blackboardNamespace: this.config.blackboardNamespace,
    signal: context.signal,
    onElicitation: context.onElicitation,
  });

  for await (const msg of this.config.agent) {
    this.emitAgentEvent(msg, context);

    if (msg.type === 'result') {
      if (msg.subtype === 'success') {
        // Store output on blackboard, invoke mapResult — same logic as today
        return this.handleSuccess(msg.output, context);
      }
      return NodeStatus.FAILURE;
    }
  }

  return NodeStatus.FAILURE;
}
```

What stays in AgentNode:

- Inflight state management (`_inflightState` pattern)
- Cache logic (`cachedStatus`)
- Serialize/restore
- `abort()` / `interrupt()` — delegate to Agent
- BT event emission (maps `AgentMessage` to `agent:*` events)
- Blackboard output storage
- `mapResult` invocation

### Strategy Changes

All three agent strategies replace `options: Partial<Options>` with `agent: Agent`.

```ts
interface AgentStrategyConfig {
  prompt: string | ((children: BTreeNode[], context: TreeContext) => string);
  childDescriptions?: Record<string, string>;
  cache?: boolean;
  agent: Agent;                // replaces options: Partial<Options>
}
```

Strategy methods change from:

```ts
const result = await queryStructured(prompt, OrderingSchema, {
  signal: context.signal,
  ...this.config.options,
});
```

To:

```ts
const result = await this.config.agent.query<Ordering>(prompt, OrderingSchema, {
  signal: context.signal,
});
```

`buildStrategyPrompt()` remains unchanged — it constructs the composite prompt from children descriptions and blackboard state, which is strategy logic.

### Builder API

The builder's `agent()` method changes signature:

```ts
// Before
b.agent('classify', {
  prompt: classifyPrompt,
  options: { model: 'claude-haiku-4-5', effort: 'low' },
});

// After
const classifyAgent = new ClaudeSDKAgent({
  name: 'classify',
  model: 'claude-haiku-4-5',
  options: { effort: 'low' },
});

b.agent('classify', {
  agent: classifyAgent,
  prompt: classifyPrompt,
});
```

Multi-turn reuse (the motivating use case):

```ts
const supportAgent = new ClaudeSDKAgent({
  name: 'support',
  model: 'claude-haiku-4-5',
  systemPrompt: 'You are a customer support agent.',
  options: { maxTurns: 5 },
});

const tree = new TreeBuilder('support-flow')
  .sequence('conversation', (b) => {
    b.agent('handle-ticket', {
      agent: supportAgent,
      prompt: (ctx) => `Handle this ticket: ${ctx.blackboard.get('ticket')}`,
    });

    b.receive('customer-reply', { command: 'customer:message' });

    b.agent('follow-up', {
      agent: supportAgent,
      prompt: (ctx) => `Customer replied: ${ctx.blackboard.get('customer-reply:payload')}`,
    });
  })
  .build();
```

---

## File Changes

### New Files

| File | Contents |
|---|---|
| `src/agent/agent.ts` | Abstract `Agent` class, `AgentMessage`, `AgentConfig`, `AgentSendOptions`, `AgentUsage` |
| `src/agent/claude-sdk-agent.ts` | `ClaudeSDKAgent`, `ClaudeSDKAgentConfig` |

### Modified Files

| File | Change |
|---|---|
| `src/nodes/agent.ts` | Remove SDK logic, delegate to `Agent` |
| `src/types.ts` | `AgentNodeConfig.agent: Agent` replaces `.options`; `AgentStrategyConfig.agent: Agent` replaces `.options` |
| `src/strategies/agent-selection.ts` | Use `agent.query()` |
| `src/strategies/agent-execution.ts` | Use `agent.query()` |
| `src/strategies/agent-parallel.ts` | Use `agent.query()` |
| `src/builder/tree-builder.ts` | Builder `agent()` signature changes |
| `src/agent/sdk-helpers.ts` | `emitMessageEvents` becomes `ClaudeSDKAgent` internal; `wrapElicitation` and `buildStrategyPrompt` remain |
| `src/agent/blackboard-mcp.ts` | Unchanged, consumed by `ClaudeSDKAgent` instead of `AgentNode` |
| `src/index.ts` | Updated exports |
| `apps/content-pipeline/tree.ts` | Updated to use `ClaudeSDKAgent` |
| `apps/scheduled-monitor/tree.ts` | Updated to use `ClaudeSDKAgent` |

### Public API

| Export | Status |
|---|---|
| `Agent` | New |
| `ClaudeSDKAgent` | New |
| `AgentMessage`, `AgentConfig`, `ClaudeSDKAgentConfig`, `AgentSendOptions`, `AgentUsage` | New types |
| `AgentNodeConfig` | Changed (`agent: Agent` replaces `options: Partial<Options>`) |
| `AgentStrategyConfig` | Changed (`agent: Agent` replaces `options: Partial<Options>`) |
| `emitMessageEvents` | Removed from public API (becomes `ClaudeSDKAgent` internal) |
| `wrapElicitation` | Kept (cross-provider utility) |
| `OnElicitation`, `ElicitationRequest` | Kept (re-exported types) |
| `createBlackboardMcpServer` | Kept |
| `buildStrategyPrompt`, `createStrategyMessageHandler` | Kept |

## Breaking Changes

- `AgentNodeConfig` and `AgentStrategyConfig` change shape — `options: Partial<Options>` replaced with `agent: Agent`.
- Builder API requires an `Agent` instance rather than inline SDK options.
- `emitMessageEvents` removed from public exports.
- Both example apps require updates.

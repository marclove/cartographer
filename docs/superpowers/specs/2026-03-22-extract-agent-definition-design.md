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

  /**
   * Send a prompt and return an async iterable of response messages
   * scoped to this turn. Each call starts a new turn; conversation
   * history accumulates across turns within the same Agent instance.
   */
  abstract send(prompt: string, options?: AgentSendOptions): AsyncIterable<AgentMessage>;

  /**
   * One-shot structured query. Default implementation includes the JSON
   * schema in the prompt, calls send(), collects messages until a result,
   * parses the output as JSON, and returns the typed result.
   *
   * Concrete classes can override for provider-native structured output
   * (e.g., ClaudeSDKAgent uses the SDK's outputFormat option).
   *
   * The schema parameter is a JSON Schema object, not a Zod schema.
   * Callers using Zod should convert via z.toJSONSchema() before calling.
   */
  async query<T>(prompt: string, schema: JSONSchema, options?: AgentSendOptions): Promise<T> {
    // Default: include schema in prompt, send, iterate to result, parse JSON
  }

  /**
   * Return provider-agnostic metadata for dashboard introspection.
   * Concrete classes add provider-specific fields (e.g., model, tools).
   */
  abstract getInfo(): AgentInfo;

  /** Clean up resources (e.g., SDK subprocess, ACP session). */
  abstract close(): Promise<void>;
}

interface AgentInfo {
  name: string;
  model?: string;
  tools?: string[];
  /** Provider-specific metadata beyond the common fields. */
  [key: string]: unknown;
}
```

Key decisions:

- **`send()` returns `AsyncIterable<AgentMessage>`** — each call returns a scoped iterable for that turn's responses. This avoids shared-iterator issues when multiple AgentNodes reference the same Agent instance (each turn gets its own iterable, and `for await...of` with `break` only closes the current turn's iterator, not the agent). The internal message queue and multi-turn conversation continuity are managed inside the Agent implementation.
- **`blackboard` in `AgentSendOptions`, not the constructor** — namespace may differ between AgentNodes sharing the same Agent, and strategies don't need it.
- **`signal` in `AgentSendOptions`** — AgentNode bridges the tree's abort signal per-tick.
- **`onElicitation` in `AgentSendOptions`** — both Claude SDK and ACP support elicitation; AgentNode passes `context.onElicitation` through.
- **`query()` takes `JSONSchema`, not Zod** — provider-agnostic (ACP won't know about Zod). Strategies convert with `z.toJSONSchema()` at the call site.
- **`query()` has a default implementation** — concrete classes must only implement `send` + `close` + `getInfo`. They can override `query()` for provider-native structured output.
- **`query()` error contract** — the default implementation throws if the agent's text output cannot be parsed as valid JSON conforming to the schema. The error includes the raw text and the schema for debugging. `ClaudeSDKAgent` avoids this by using the SDK's native `outputFormat` validation.
- **`close()` returns `Promise<void>`** — cleanup may be async (e.g., closing an ACP session involves network calls).
- **`getInfo()` provides dashboard introspection** — returns a provider-agnostic `AgentInfo` with common fields (name, model, tools) and an index signature for provider-specific metadata. AgentNode's `agentOptions` getter delegates to `this.config.agent.getInfo()`.

### AgentMessage Types

Discriminated union yielded by the async iterable returned from `send()`. Provider-agnostic — each concrete Agent maps its provider's responses into these types.

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

ACP does not support structured output natively. The default `query()` implementation handles this via prompt engineering + JSON parsing. `ClaudeSDKAgent` overrides with the SDK's `outputFormat` option for reliable schema-validated output.

### ClaudeSDKAgent

Lives in `src/agent/claude-sdk-agent.ts`. Wraps the Claude Agent SDK using the V1 stable API.

```ts
interface ClaudeSDKAgentConfig extends AgentConfig {
  /** Model identifier (e.g., 'claude-haiku-4-5'). */
  model?: string;
  /**
   * System prompt for the agent. Takes precedence over
   * options.systemPrompt if both are provided.
   */
  systemPrompt?: string;
  /** SDK options: tools, MCP servers, maxTurns, effort, budget, permissions, etc. */
  options?: Partial<Options>;
}

class ClaudeSDKAgent extends Agent {
  private queryInstance: Query | null = null;
  private messageQueue: AsyncQueue<SDKUserMessage>;

  constructor(config: ClaudeSDKAgentConfig) {
    // Validates reserved MCP server name "blackboard" is not used
    // in config.options.mcpServers (moved from AgentNode constructor)
  }

  send(prompt: string, options?: AgentSendOptions): AsyncIterable<AgentMessage> {
    // Returns an AsyncIterable that, when iterated:
    //
    // 1. Lazily creates the SDK query on first send() (not in constructor).
    //    The blackboard MCP server from this first call is included in the
    //    initial query() options — no setMcpServers() needed for the first turn.
    // 2. On subsequent sends, if the blackboard namespace changed, updates
    //    MCP servers via queryInstance.setMcpServers().
    // 3. If onElicitation provided, wraps with wrapElicitation()
    // 4. Bridges abort signal to SDK AbortController
    // 5. Builds SDKUserMessage from prompt string
    // 6. Pushes onto messageQueue (triggers the SDK query to process it)
    // 7. Yields mapped AgentMessages from SDK responses until result
    //
    // The async iterable is scoped to this turn — it completes after
    // yielding the result message. The underlying SDK query stays alive
    // for subsequent send() calls.
    //
    // Internally, a private method iterates the SDK query's async generator,
    // maps SDKMessage → AgentMessage, and demuxes messages into per-turn
    // iterables. The class itself is NOT async-iterable — only the return
    // value of send() is.
  }

  /**
   * Override: uses SDK query() with outputFormat for schema-validated output.
   * Spins up a separate one-shot query() call (not the multi-turn session).
   * Strips $schema from the JSON schema before passing to the SDK (Zod's
   * toJSONSchema() adds it, but the SDK does not accept it).
   */
  override async query<T>(prompt: string, schema: JSONSchema, options?: AgentSendOptions): Promise<T> { ... }

  getInfo(): AgentInfo {
    // Returns { name, model, tools, mcpServers } from config
  }

  async close(): Promise<void> {
    this.queryInstance?.close();
    this.queryInstance = null;
  }
}
```

What moves from AgentNode into ClaudeSDKAgent:

- All SDK imports and `query()` calls
- Blackboard MCP server creation (`createBlackboardMcpServer`)
- Reserved "blackboard" MCP server name validation (constructor)
- `$schema` stripping from `outputFormat` (ClaudeSDKAgent concern only — the abstract `Agent.query()` default implementation does not use `outputFormat`, so stripping is not needed there)
- The `sdkAbortHandlerInstalled` unhandled rejection workaround
- `AbortController` bridging
- Elicitation wrapping (via `wrapElicitation`)
- SDK message-to-AgentMessage mapping (currently `emitMessageEvents`)

Multi-turn conversation is supported via the V1 `AsyncIterable<SDKUserMessage>` prompt pattern. The SDK query is created lazily on the first `send()` call (not in the constructor), so defining an Agent is cheap. The Agent owns a single long-lived `query()` call, and `send()` pushes messages into the async iterable. Conversation context accumulates naturally across turns within the SDK.

#### AsyncQueue Utility

`ClaudeSDKAgent` requires an `AsyncQueue<T>` — a push/pull queue that implements `AsyncIterable<T>`. This is a new internal utility:

```ts
class AsyncQueue<T> implements AsyncIterable<T> {
  push(item: T): void;           // enqueue an item (non-blocking)
  async *[Symbol.asyncIterator](): AsyncIterableIterator<T>;  // yields items as they arrive
  close(): void;                 // signal no more items; iterator completes
}
```

This is a standard concurrency primitive (~30 lines). It will live in `src/agent/async-queue.ts`.

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

  const messages = this.config.agent.send(prompt, {
    blackboard: context.blackboard,
    blackboardNamespace: this.config.blackboardNamespace,
    signal: context.signal,
    onElicitation: context.onElicitation,
  });

  for await (const msg of messages) {
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

The `agentOptions` getter delegates to `this.config.agent.getInfo()`, which returns an `AgentInfo` object with `name`, `model`, `tools`, and provider-specific metadata. The dashboard API (`actor-server.ts`, `api-handlers.ts`) uses this for introspection.

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
const result = await this.config.agent.query<Ordering>(
  prompt,
  z.toJSONSchema(OrderingSchema),
  { signal: context.signal },
);
```

`buildStrategyPrompt()` remains unchanged — it constructs the composite prompt from children descriptions and blackboard state, which is strategy logic.

#### Strategy Event Emission

Currently, strategies emit fine-grained agent events (`agent:thinking`, `agent:text`, etc.) through `createStrategyMessageHandler`. After the migration to `agent.query()`, these per-message events are no longer emitted for strategy queries — `query()` returns the final result directly without exposing intermediate messages.

This is acceptable: strategies are lightweight one-shot queries where intermediate events add little observability value. The important events remain — strategies continue to emit `strategy:decision` events after `query()` returns, which capture the ordering/policy decision and reasoning.

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

### Agent Lifecycle

The Agent's lifecycle is managed by its creator, not by individual nodes or the tree:

- **Creation**: The user constructs Agent instances outside the tree, typically at application startup.
- **Usage**: Multiple AgentNodes and strategies may reference the same Agent instance. Each `send()` call returns a scoped iterable — no shared state conflicts.
- **Abort/Interrupt**: AgentNode's `abort()` and `interrupt()` cancel in-flight work via the `signal` in `AgentSendOptions`. This cancels the current turn without closing the Agent's session.
- **Disposal**: `close()` is called when the Agent is no longer needed (e.g., application shutdown, tree disposal). After `close()`, the Agent cannot be used. Individual node abort/interrupt does NOT call `close()`.

---

## File Changes

### New Files

| File | Contents |
|---|---|
| `src/agent/agent.ts` | Abstract `Agent` class, `AgentMessage`, `AgentConfig`, `AgentSendOptions`, `AgentUsage` |
| `src/agent/claude-sdk-agent.ts` | `ClaudeSDKAgent`, `ClaudeSDKAgentConfig` |
| `src/agent/async-queue.ts` | `AsyncQueue<T>` — push/pull async iterable queue used by `ClaudeSDKAgent` |

### Modified Files

| File | Change |
|---|---|
| `src/nodes/agent.ts` | Remove SDK logic, delegate to `Agent` |
| `src/types.ts` | `AgentNodeConfig.agent: Agent` replaces `.options`; `AgentStrategyConfig.agent: Agent` replaces `.options` |
| `src/strategies/agent-selection.ts` | Use `agent.query()`, convert Zod schema with `z.toJSONSchema()` |
| `src/strategies/agent-execution.ts` | Use `agent.query()`, convert Zod schema with `z.toJSONSchema()` |
| `src/strategies/agent-parallel.ts` | Use `agent.query()`, convert Zod schema with `z.toJSONSchema()` |
| `src/builder/tree-builder.ts` | Builder `agent()` signature changes |
| `src/agent/sdk-helpers.ts` | `emitMessageEvents` becomes `ClaudeSDKAgent` internal; `wrapElicitation` and `buildStrategyPrompt` remain |
| `src/agent/blackboard-mcp.ts` | Unchanged, consumed by `ClaudeSDKAgent` instead of `AgentNode` |
| `src/server/actor-server.ts` | Update `agentOptions` introspection to work with `Agent` abstraction |
| `src/server/api-handlers.ts` | Update agent info serialization for dashboard API |
| `src/index.ts` | Updated exports |
| `apps/content-pipeline/tree.ts` | Updated to use `ClaudeSDKAgent` |
| `apps/scheduled-monitor/tree.ts` | Updated to use `ClaudeSDKAgent` |
| `src/nodes/agent.test.ts` | Update tests for new AgentNode config shape |
| `src/strategies/agent-strategies.test.ts` | Update tests for Agent.query() |
| `src/agent/sdk-helpers.test.ts` | Remove tests for moved functions; keep wrapElicitation/buildStrategyPrompt tests |
| `src/__integration__/*.test.ts` | Update integration tests to construct ClaudeSDKAgent |

### Public API

| Export | Status |
|---|---|
| `Agent` | New |
| `ClaudeSDKAgent` | New |
| `AgentMessage`, `AgentConfig`, `AgentInfo`, `ClaudeSDKAgentConfig`, `AgentSendOptions`, `AgentUsage` | New types |
| `AgentNodeConfig` | Changed (`agent: Agent` replaces `options: Partial<Options>`) |
| `AgentStrategyConfig` | Changed (`agent: Agent` replaces `options: Partial<Options>`) |
| `emitMessageEvents` | Removed from public API (becomes `ClaudeSDKAgent` internal) |
| `queryStructured` | Removed from public API (replaced by `Agent.query()`) |
| `createStrategyMessageHandler` | Removed from public API (strategies use `agent.query()` directly) |
| `wrapElicitation` | Kept (cross-provider utility) |
| `OnElicitation`, `ElicitationRequest` | Kept (re-exported types) |
| `createBlackboardMcpServer` | Kept |
| `buildStrategyPrompt` | Kept |

## Breaking Changes

- `AgentNodeConfig` and `AgentStrategyConfig` change shape — `options: Partial<Options>` replaced with `agent: Agent`.
- Builder API requires an `Agent` instance rather than inline SDK options.
- `emitMessageEvents` removed from public exports.
- `queryStructured` removed from public exports.
- `createStrategyMessageHandler` removed from public exports.
- Strategy queries no longer emit fine-grained `agent:*` events (thinking, text, tool_use); `strategy:decision` events remain.
- Both example apps require updates.

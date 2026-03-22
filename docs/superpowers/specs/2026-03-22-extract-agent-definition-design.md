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
  /**
   * Called for each AgentMessage as it is produced. Invoked for each
   * message before it is yielded by the returned iterable. Provides
   * a unified observability hook — callers use this to emit BT events,
   * log messages, or feed dashboards without needing to handle
   * observability separately from result extraction.
   */
  onMessage?: (msg: AgentMessage) => void;
  /**
   * JSON schema for structured output. When set, the provider uses
   * native schema validation if available (e.g., ClaudeSDKAgent sets
   * the SDK's outputFormat option). Providers without native support
   * include the schema in the prompt and parse the result text as JSON
   * internally. Either way, the result message's output contains parsed
   * JSON conforming to the schema.
   *
   * This is a JSON Schema object, not a Zod schema. Callers using Zod
   * should convert via z.toJSONSchema() before calling.
   */
  outputSchema?: JSONSchema;
}

abstract class Agent {
  readonly name: string;

  constructor(config: AgentConfig) { ... }

  /**
   * Send a prompt and return an async iterable of response messages
   * scoped to this turn. Each call starts a new turn; conversation
   * history accumulates across turns within the same Agent instance.
   *
   * When options.outputSchema is set, the provider uses native structured
   * output validation if available; otherwise it includes the schema in
   * the prompt and parses the result as JSON. The result message's output
   * will contain the parsed object in either case.
   */
  abstract send(prompt: string, options?: AgentSendOptions): AsyncIterable<AgentMessage>;

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
- **`onMessage` in `AgentSendOptions`** — unified observability hook. The Agent invokes it for each message as it's produced, before yielding it. Callers use it to emit BT events, removing the need for separate observability patterns.
- **`outputSchema` in `AgentSendOptions`** — when set, the provider uses native structured output validation if available (ClaudeSDKAgent sets the SDK's `outputFormat`). Providers without native support include the schema in the prompt and parse the result text as JSON internally. The result message's `output` always contains parsed JSON when `outputSchema` is set. Takes `JSONSchema`, not Zod — provider-agnostic (ACP won't know about Zod). Callers convert with `z.toJSONSchema()`.
- **No separate `query()` method** — structured output is handled through `send()` via `outputSchema`. One method, one pattern. Concrete classes only implement `send` + `close` + `getInfo`.
- **`close()` returns `Promise<void>`** — cleanup may be async (e.g., closing an ACP session involves network calls).
- **`getInfo()` provides dashboard introspection** — returns a provider-agnostic `AgentInfo` with common fields (name, model, tools) and an index signature for provider-specific metadata. AgentNode's `agentOptions` getter delegates to `this.config.agent.getInfo()`.

### AgentMessage Types

Discriminated union yielded by the async iterable returned from `send()`. Provider-agnostic — each concrete Agent maps its provider's responses into these types.

```ts
type AgentMessage =
  // Core messages — all providers must synthesize these
  | { type: "thinking"; content: string }
  | { type: "text"; content: string }
  | { type: "tool_use"; name: string; input?: unknown }
  | { type: "result"; subtype: "success"; output: unknown; cost?: number; usage?: AgentUsage }
  | { type: "result"; subtype: "error"; errors?: unknown[]; cost?: number; usage?: AgentUsage }
  // Provider-specific observability — forwarded but not required
  | { type: "provider_event"; subtype: string; data: unknown };

interface AgentUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  thoughtTokens?: number;
}
```

Provider mapping:

| AgentMessage type  | Claude SDK source                          | ACP source                                                   |
| ------------------ | ------------------------------------------ | ------------------------------------------------------------ |
| `thinking`         | Thinking content block                     | `agent_thought_chunk` notification                           |
| `text`             | Text content block                         | `agent_message_chunk` notification                           |
| `tool_use`         | `tool_use` content block (name + input)    | `tool_call` notification (title + rawInput, observational)   |
| `result` (success) | `result` message with `subtype: 'success'` | Synthesized from `StopReason: 'end_turn'` + accumulated text |
| `result` (error)   | `result` message with error subtype        | Synthesized from `StopReason: 'refusal'/'cancelled'` etc.    |
| `provider_event`   | Stream deltas, init, status, rate_limit    | `tool_call_update`, `usage_update`, `plan`, etc.             |

ACP does not support structured output natively. When `outputSchema` is set, an ACP agent implementation would include the schema in the prompt and parse the result text as JSON. `ClaudeSDKAgent` uses the SDK's native `outputFormat` option for reliable schema-validated output.

### ClaudeSDKAgent

Lives in `src/agent/claude-sdk-agent.ts`. Wraps the Claude Agent SDK using the V1 stable API.

```ts
type ClaudeSDKAgentConfig = AgentConfig & Partial<Options>;
```

All SDK options (`model`, `systemPrompt`, `effort`, `maxTurns`, `mcpServers`, `allowedTools`, `maxBudgetUsd`, etc.) are top-level alongside `name` from `AgentConfig`. No nesting.

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
// The blackboard MCP server from this first call is included in the
// initial query() options — no setMcpServers() needed for the first turn.
// 2. On subsequent sends, if the blackboard namespace changed, updates
// MCP servers via queryInstance.setMcpServers().
// 3. If outputSchema provided, sets SDK outputFormat option and strips
// $schema meta-property (Zod's toJSONSchema() adds it, SDK rejects it).
// 4. If onElicitation provided, wraps with wrapElicitation()
// 5. Bridges abort signal to SDK AbortController
// 6. Builds SDKUserMessage from prompt string
// 7. Pushes onto messageQueue (triggers the SDK query to process it)
// 8. For each SDK response message, maps to AgentMessage, invokes
// onMessage callback if provided, then yields the message
// 9. Completes after yielding the result message
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

getInfo(): AgentInfo {
// Returns { name, model, tools, mcpServers } from config
}

async close(): Promise<void> {
this.queryInstance?.close();
this.queryInstance = null;
}
}

````

What moves from AgentNode into ClaudeSDKAgent:

- All SDK imports and `query()` calls
- Blackboard MCP server creation (`createBlackboardMcpServer`)
- Reserved "blackboard" MCP server name validation (constructor)
- `$schema` stripping from `outputFormat` (ClaudeSDKAgent concern — applied in `send()` when `outputSchema` is provided)
- The `sdkAbortHandlerInstalled` unhandled rejection workaround
- `AbortController` bridging
- Elicitation wrapping (via `wrapElicitation`)
- SDK message-to-AgentMessage mapping (currently `emitMessageEvents`)

Multi-turn conversation is supported via the V1 `AsyncIterable<SDKUserMessage>` prompt pattern. The SDK query is created lazily on the first `send()` call (not in the constructor), so defining an Agent is cheap. The Agent owns a single long-lived `query()` call, and `send()` pushes messages into the async iterable. Conversation context accumulates naturally across turns within the SDK.

#### Turn Boundaries and Concurrent Sends

The SDK processes one turn at a time — it pulls a message from the `AsyncQueue`, processes it (potentially multiple API round-trips for tool use), yields response messages, and only then pulls the next message.

The **turn boundary** is the `result` message. All messages between one queue pull and the next `result` belong to that turn's scoped iterable. The demux assigns each SDK response message to the iterable returned by the `send()` call that enqueued the corresponding prompt.

**Concurrent sends** (e.g., two AgentNodes sharing an Agent inside a parallel node) are naturally serialized by the queue:

1. Node A calls `send()` → message A is pushed onto the queue, Node A's iterable is created
2. Node B calls `send()` → message B is pushed onto the queue, Node B's iterable is created
3. The SDK pulls message A, processes it, yields responses → demuxed to Node A's iterable
4. Node A's iterable yields the `result` message and completes
5. The SDK pulls message B, processes it, yields responses → demuxed to Node B's iterable
6. Node B's iterable yields the `result` message and completes

Node B's iterable blocks until A's turn completes. From the BT's perspective, both nodes report `RUNNING` — the parallel node keeps ticking normally. Turns are serialized at the agent level, which is semantically correct: a single agent processes one conversation turn at a time. Conversation history accumulates, so Node B's prompt is processed with full context of Node A's prior exchange.

**Abort/early exit**: when a turn is cancelled (via the `signal` in `AgentSendOptions`), `ClaudeSDKAgent` calls `queryInstance.interrupt()` — the SDK method designed for streaming input mode that stops the current turn without killing the session. The query stays alive, conversation history is preserved (including any partial response from the interrupted turn), and subsequent `send()` calls continue normally.

This is distinct from `queryInstance.close()`, which terminates the SDK subprocess entirely and is only used by `Agent.close()` for final disposal.

If the query becomes unresponsive after interrupt (e.g., the SDK subprocess crashes), `ClaudeSDKAgent` recreates the query on the next `send()` using `resume: sessionId` to restore conversation history from the persisted session.

**Queued-but-not-started turns**: if the signal fires before the SDK has pulled the message from the queue (e.g., Node B is aborted while Node A is still processing), the turn is dropped preemptively — the message is removed from the queue, and Node B's iterable completes without yielding any messages. The SDK never sees the cancelled prompt, so no resources are wasted and the conversation history is not polluted.

**Iterable abandoned via break** (without an abort signal): remaining messages from the in-flight turn are drained and discarded. The queue advances to the next pending send.

#### AsyncQueue Utility

`ClaudeSDKAgent` requires an `AsyncQueue<T>` — a push/pull queue that implements `AsyncIterable<T>`. This is a new internal utility:

```ts
class AsyncQueue<T> implements AsyncIterable<T> {
  push(item: T): void;           // enqueue an item (non-blocking)
  close(err?: Error): void;      // signal completion or error
  async *[Symbol.asyncIterator](): AsyncIterableIterator<T>;
}
```

Semantics:

- **`push(item)`** — enqueues an item. If the iterator is waiting, it resolves immediately. If the queue is closed, the push is silently dropped.
- **`close()`** — signals no more items. The iterator yields any remaining queued items, then completes.
- **`close(err)`** — signals an error. The iterator throws `err` for any consumer currently awaiting `next()`. Pending items are discarded.
- **Backpressure** — not needed. Each `send()` pushes exactly one message, and the SDK pulls sequentially. The queue stays small (at most a few pending sends from concurrent nodes).
- **SDK query termination** — if the SDK query terminates unexpectedly, `ClaudeSDKAgent` calls `close(err)` on the queue. Any pending `send()` iterables that are waiting for their turn receive the error through the demux layer (the turn's iterable throws), rather than stalling indefinitely.
- **Agent.close()** — calls `close()` on the queue (normal completion). Any pending send() iterables complete without yielding further messages.

This will live in `src/agent/async-queue.ts`.

### AgentNode Changes

AgentNode shrinks to BT-only concerns. No longer imports or knows about the Claude SDK.

```ts
interface AgentNodeConfig {
  id?: string;
  name: string;
  agent: Agent; // replaces options: Partial<Options>
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
    onMessage: (msg) => this.emitAgentEvent(msg, context),
  });

  for await (const msg of messages) {
    // Events already emitted via onMessage — just handle result extraction
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
  agent: Agent; // replaces options: Partial<Options>
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
let result: Ordering | null = null;
for await (const msg of this.config.agent.send(prompt, {
  signal: context.signal,
  onMessage: (msg) => emitAgentEvent(msg, this, context),
  outputSchema: z.toJSONSchema(OrderingSchema),
})) {
  if (msg.type === "result" && msg.subtype === "success") {
    result = msg.output as Ordering;
  }
}
```

`buildStrategyPrompt()` remains unchanged — it constructs the composite prompt from children descriptions and blackboard state, which is strategy logic.

#### Strategy Event Emission

Strategies retain full observability. The `onMessage` callback in `AgentSendOptions` is invoked for each message during `send()`, so strategies emit the same fine-grained `agent:*` events (thinking, text, tool_use, etc.) as before. The `createStrategyMessageHandler` helper is no longer needed — `onMessage` replaces it.

### Builder API

The builder's `agent()` method changes signature:

```ts
// Before
b.agent("classify", {
  prompt: classifyPrompt,
  options: { model: "claude-haiku-4-5", effort: "low" },
});

// After
const classifyAgent = new ClaudeSDKAgent({
  name: "classify",
  model: "claude-haiku-4-5",
  effort: "low",
});

b.agent("classify", {
  agent: classifyAgent,
  prompt: classifyPrompt,
});
```

Multi-turn reuse (the motivating use case):

```ts
const supportAgent = new ClaudeSDKAgent({
  name: "support",
  model: "claude-haiku-4-5",
  systemPrompt: "You are a customer support agent.",
  maxTurns: 5,
});

const tree = new TreeBuilder("support-flow")
  .sequence("conversation", (b) => {
    b.agent("handle-ticket", {
      agent: supportAgent,
      prompt: (ctx) => `Handle this ticket: ${ctx.blackboard.get("ticket")}`,
    });

    b.receive("customer-reply", { command: "customer:message" });

    b.agent("follow-up", {
      agent: supportAgent,
      prompt: (ctx) => `Customer replied: ${ctx.blackboard.get("customer-reply:payload")}`,
    });
  })
  .build();
```

### Agent Lifecycle

The Agent's lifecycle is managed by its creator, not by individual nodes or the tree:

- **Creation**: The user constructs Agent instances outside the tree, typically at application startup.
- **Usage**: Multiple AgentNodes and strategies may reference the same Agent instance. Each `send()` call returns a scoped iterable — no shared state conflicts.
- **Abort/Interrupt**: AgentNode's `abort()` and `interrupt()` cancel in-flight work via the `signal` in `AgentSendOptions`. This cancels the current turn without closing the Agent's session.
- **Disposal**: `close()` is called when the Agent is no longer needed (e.g., application shutdown, tree disposal). Individual node abort/interrupt does NOT call `close()`. When `close()` is called:
  - The SDK subprocess is terminated via `queryInstance.close()`.
  - The AsyncQueue is closed with an error (`close(new Error('Agent closed'))`).
  - Any **in-flight turn's** iterable throws the error on its next `await`, surfacing the shutdown to the consuming node.
  - Any **queued-but-not-started turn's** iterable throws the same error immediately — the message is never processed.
  - After `close()`, subsequent `send()` calls throw synchronously.

---

## File Changes

### New Files

| File                            | Contents                                                                                |
| ------------------------------- | --------------------------------------------------------------------------------------- |
| `src/agent/agent.ts`            | Abstract `Agent` class, `AgentMessage`, `AgentConfig`, `AgentSendOptions`, `AgentUsage` |
| `src/agent/claude-sdk-agent.ts` | `ClaudeSDKAgent`, `ClaudeSDKAgentConfig`                                                |
| `src/agent/async-queue.ts`      | `AsyncQueue<T>` — push/pull async iterable queue used by `ClaudeSDKAgent`               |

### Modified Files

| File                                      | Change                                                                                                     |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `src/nodes/agent.ts`                      | Remove SDK logic, delegate to `Agent`                                                                      |
| `src/types.ts`                            | `AgentNodeConfig.agent: Agent` replaces `.options`; `AgentStrategyConfig.agent: Agent` replaces `.options` |
| `src/strategies/agent-selection.ts`       | Use `agent.send()` with `outputSchema`, convert Zod schema with `z.toJSONSchema()`                         |
| `src/strategies/agent-execution.ts`       | Use `agent.send()` with `outputSchema`, convert Zod schema with `z.toJSONSchema()`                         |
| `src/strategies/agent-parallel.ts`        | Use `agent.send()` with `outputSchema`, convert Zod schema with `z.toJSONSchema()`                         |
| `src/builder/tree-builder.ts`             | Builder `agent()` signature changes                                                                        |
| `src/agent/sdk-helpers.ts`                | `emitMessageEvents` becomes `ClaudeSDKAgent` internal; `wrapElicitation` and `buildStrategyPrompt` remain  |
| `src/agent/blackboard-mcp.ts`             | Unchanged, consumed by `ClaudeSDKAgent` instead of `AgentNode`                                             |
| `src/server/actor-server.ts`              | Update `agentOptions` introspection to work with `Agent` abstraction                                       |
| `src/server/api-handlers.ts`              | Update agent info serialization for dashboard API                                                          |
| `src/index.ts`                            | Updated exports                                                                                            |
| `apps/content-pipeline/tree.ts`           | Updated to use `ClaudeSDKAgent`                                                                            |
| `apps/scheduled-monitor/tree.ts`          | Updated to use `ClaudeSDKAgent`                                                                            |
| `src/nodes/agent.test.ts`                 | Update tests for new AgentNode config shape                                                                |
| `src/strategies/agent-strategies.test.ts` | Update tests for `agent.send()` with `outputSchema`                                                        |
| `src/agent/sdk-helpers.test.ts`           | Remove tests for moved functions; keep wrapElicitation/buildStrategyPrompt tests                           |
| `src/__integration__/*.test.ts`           | Update integration tests to construct ClaudeSDKAgent                                                       |

### Public API

| Export                                                                                               | Status                                                                   |
| ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `Agent`                                                                                              | New                                                                      |
| `ClaudeSDKAgent`                                                                                     | New                                                                      |
| `AgentMessage`, `AgentConfig`, `AgentInfo`, `ClaudeSDKAgentConfig`, `AgentSendOptions`, `AgentUsage` | New types                                                                |
| `AgentNodeConfig`                                                                                    | Changed (`agent: Agent` replaces `options: Partial<Options>`)            |
| `AgentStrategyConfig`                                                                                | Changed (`agent: Agent` replaces `options: Partial<Options>`)            |
| `emitMessageEvents`                                                                                  | Removed from public API (becomes `ClaudeSDKAgent` internal)              |
| `queryStructured`                                                                                    | Removed from public API (replaced by `agent.send()` with `outputSchema`) |
| `createStrategyMessageHandler`                                                                       | Removed from public API (replaced by `onMessage` in `AgentSendOptions`)  |
| `wrapElicitation`                                                                                    | Kept (cross-provider utility)                                            |
| `OnElicitation`, `ElicitationRequest`                                                                | Kept (re-exported types)                                                 |
| `createBlackboardMcpServer`                                                                          | Kept                                                                     |
| `buildStrategyPrompt`                                                                                | Kept                                                                     |

## Breaking Changes

- `AgentNodeConfig` and `AgentStrategyConfig` change shape — `options: Partial<Options>` replaced with `agent: Agent`.
- Builder API requires an `Agent` instance rather than inline SDK options.
- `emitMessageEvents` removed from public exports.
- `queryStructured` removed from public exports (replaced by `agent.send()` with `outputSchema`).
- `createStrategyMessageHandler` removed from public exports (replaced by `onMessage` callback in `AgentSendOptions`).
- Both example apps require updates.

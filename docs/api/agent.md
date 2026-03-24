# Agent API Reference

The agent layer provides a provider-agnostic abstraction for AI agents and helpers for integrating them into the behavior tree event system.

---

## Agent (Abstract Class)

```typescript
import { Agent } from "cartographer";
```

Abstract base class for all agent implementations. An Agent represents a configured AI agent that can process prompts and stream responses. Concrete implementations wrap specific providers (e.g., Claude SDK).

Multiple BT nodes and strategies may reference the same Agent instance. Each `send()` call returns a scoped iterable for that turn's responses, while conversation history accumulates across turns within the same instance.

### Properties

| Property    | Type              | Description                                                       |
| ----------- | ----------------- | ----------------------------------------------------------------- |
| `name`      | `string` (readonly) | Human-readable name for identification and debugging.          |
| `sessionId` | `string \| null`  | The active session ID, or `null` if no session has been created yet. |

### Methods

#### `send(prompt, options?): AsyncIterable<AgentMessage>`

Send a prompt and return an async iterable of response messages scoped to this turn. Each call starts a new turn; conversation history accumulates across turns within the same Agent instance.

| Parameter | Type               | Required | Description                         |
| --------- | ------------------ | -------- | ----------------------------------- |
| `prompt`  | `string`           | Yes      | The prompt text to send.            |
| `options` | `AgentSendOptions` | No       | Per-invocation options (see below). |

#### `getInfo(): AgentInfo`

Return provider-agnostic metadata for dashboard introspection.

#### `close(): Promise<void>`

Clean up resources (e.g., SDK subprocess, ACP session). After calling `close()`, the agent cannot accept new prompts.

---

## ClaudeSDKAgent

```typescript
import { ClaudeSDKAgent } from "cartographer";
```

Concrete Agent implementation wrapping the Claude Agent SDK V1 stable API. Each `send()` call creates a fresh SDK `query()` with automatic session management.

### Constructor

```typescript
new ClaudeSDKAgent(config: ClaudeSDKAgentConfig)
```

### ClaudeSDKAgentConfig

A flat intersection of `AgentConfig` and the SDK's `Partial<Options>`. All SDK options sit at the top level alongside `name`:

```typescript
type ClaudeSDKAgentConfig = AgentConfig & Partial<Options>;
```

This means you configure model, effort, tools, MCP servers, output format, and every other SDK option directly on the agent:

```typescript
import { ClaudeSDKAgent } from "cartographer";

const classifier = new ClaudeSDKAgent({
  name: "classify",
  model: "claude-haiku-4-5",
  effort: "low",
  outputFormat: {
    type: "json_schema",
    schema: { type: "object", properties: { label: { type: "string" } } },
  },
});

const researcher = new ClaudeSDKAgent({
  name: "research",
  model: "claude-sonnet-4-6",
  maxTurns: 10,
  maxBudgetUsd: 0.5,
  systemPrompt: "You are a research assistant.",
  allowedTools: ["mcp__web__search"],
  mcpServers: { web: webSearchServer },
});
```

### Behavior

- **Query per send**: Each `send()` call creates a fresh SDK `query()`. When no explicit session options are provided, the agent automatically resumes its private session so conversation history accumulates across turns. When `options.session` is provided, the caller controls which session to resume or fork.
- **Blackboard MCP**: When `send()` receives a `blackboard` in its options, a blackboard MCP server is automatically injected under the reserved name `"blackboard"`. The constructor throws if your `mcpServers` config already uses this name.
- **Structured output**: When `outputFormat` is set on the config, the SDK validates responses against the schema. When `AgentSendOptions.outputSchema` is provided per-send, it takes precedence. In both cases, `$schema` meta-properties (as produced by `z.toJSONSchema()`) are automatically stripped.
- **Elicitation**: The agent always provides an `onElicitation` callback to the SDK so it never hangs. If `AgentSendOptions.onElicitation` is provided, it delegates to that handler. Otherwise, the request is auto-declined and a `provider_event` message with subtype `'elicitation_declined'` is emitted so the BT layer can fire `agent:elicitation_declined`.
- **Abort**: When `AgentSendOptions.signal` fires, the agent calls `queryInstance.interrupt()` to cancel the in-flight SDK request.
- **Error isolation**: `onMessage` callback errors are caught and emitted as `provider_event` messages with subtype `'onMessage_error'` — a failing handler never crashes the agent loop.

### Reserved MCP server name

The name `"blackboard"` is reserved for the auto-injected blackboard MCP server. If your `ClaudeSDKAgentConfig.mcpServers` includes a server named `"blackboard"`, the constructor throws with a descriptive error. Rename your server to avoid the conflict.

---

## Types

### AgentConfig

```typescript
import type { AgentConfig } from "cartographer";

interface AgentConfig {
  name: string;
}
```

Configuration for constructing an Agent. The `name` field is used for identification and debugging.

### AgentSendOptions

```typescript
import type { AgentSendOptions } from "cartographer";

interface AgentSendOptions {
  blackboard?: Blackboard;
  blackboardNamespace?: string;
  signal?: AbortSignal;
  onElicitation?: OnElicitation;
  onMessage?: (msg: AgentMessage) => void;
  outputSchema?: Record<string, unknown>;
  session?: AgentSessionOptions;
}
```

Per-invocation options passed to `Agent.send()`:

| Field                 | Type                          | Description                                                                                                                                      |
| --------------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `blackboard`          | `Blackboard`                  | Blackboard for agent access. The provider decides how to expose it (ClaudeSDKAgent injects a blackboard MCP server).                             |
| `blackboardNamespace` | `string`                      | Namespace for scoped blackboard access.                                                                                                          |
| `signal`              | `AbortSignal`                 | Abort signal for cancellation.                                                                                                                   |
| `onElicitation`       | `OnElicitation`               | Elicitation handler for interactive input requests.                                                                                              |
| `onMessage`           | `(msg: AgentMessage) => void` | Called for each message before it is yielded. Errors are caught and emitted as `provider_event` messages with subtype `'onMessage_error'`.       |
| `outputSchema`        | `Record<string, unknown>`     | JSON schema for structured output. Overrides the agent's configured `outputFormat` for this send. This is a JSON Schema object, not a Zod schema. |
| `session`             | `AgentSessionOptions`         | Session options controlling which conversation to resume, fork, or create. When omitted, the agent manages its own private session.               |

### AgentSessionOptions

```typescript
import type { AgentSessionOptions } from "cartographer";

interface AgentSessionOptions {
  id?: string;
  fork?: boolean;
}
```

Provider-agnostic session options for `Agent.send()`. Controls whether the agent creates a new session, resumes an existing session, or forks from one.

| Field  | Type      | Description                                                                                     |
| ------ | --------- | ----------------------------------------------------------------------------------------------- |
| `id`   | `string`  | Provider session ID to resume. When `undefined`, a new session is created.                      |
| `fork` | `boolean` | Fork from the session instead of appending to it. Requires `id` to be set.                      |

These options are provider-agnostic — each concrete Agent maps them to its provider's session API. For `ClaudeSDKAgent`, `id` maps to the SDK's `resume` option and `fork` maps to `forkSession`.

### AgentMessage

```typescript
import type { AgentMessage } from "cartographer";
```

Discriminated union of messages yielded by `Agent.send()`. Provider-agnostic — each concrete Agent maps its provider's responses into these types:

| Variant                  | Fields                                                 | Description                               |
| ------------------------ | ------------------------------------------------------ | ----------------------------------------- |
| `{ type: 'thinking' }`  | `content: string`                                      | Chain-of-thought reasoning block.         |
| `{ type: 'text' }`      | `content: string`                                      | Text content block.                       |
| `{ type: 'tool_use' }`  | `name: string; input?: unknown`                        | Tool call made by the agent.              |
| `{ type: 'result', subtype: 'success' }` | `output: unknown; cost?: number; usage?: AgentUsage` | Successful final result.    |
| `{ type: 'result', subtype: 'error' }`   | `errors?: unknown[]; cost?: number; usage?: AgentUsage` | Error result.            |
| `{ type: 'provider_event' }` | `subtype: string; data: unknown`                  | Provider-specific event (init, status, rate_limit, tool_progress, etc.). |
| `{ type: 'session_start' }` | `sessionId: string`                               | Emitted when the provider creates or resumes a session. Used by AgentNode to register the session in the tree's registry. |

### AgentInfo

```typescript
import type { AgentInfo } from "cartographer";

interface AgentInfo {
  name: string;
  model?: string;
  tools?: string[];
  [key: string]: unknown;
}
```

Provider-agnostic metadata returned by `Agent.getInfo()`. Used by the dashboard and server introspection APIs.

### AgentUsage

```typescript
import type { AgentUsage } from "cartographer";

interface AgentUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  thoughtTokens?: number;
}
```

Token usage information from a completed turn. Included in `result` messages when the provider reports usage data.

---

## createBlackboardMcpServer

```typescript
import { createBlackboardMcpServer } from "cartographer";
```

Creates an in-process MCP server that gives Claude read/write access to the behavior tree blackboard. `ClaudeSDKAgent` attaches one of these automatically when a blackboard is provided via `AgentSendOptions` — use this function directly only when building custom agent implementations or standalone SDK calls.

### Signature

```typescript
function createBlackboardMcpServer(
  blackboard: Blackboard,
  namespace?: string,
): McpServer & { handlers: BlackboardMcpHandlers };
```

### Parameters

| Parameter    | Type         | Required | Description                                                                                       |
| ------------ | ------------ | -------- | ------------------------------------------------------------------------------------------------- |
| `blackboard` | `Blackboard` | Yes      | The blackboard instance to expose via MCP tools.                                                  |
| `namespace`  | `string`     | No       | When provided, all tool operations are scoped to a `ScopedBlackboard` prefixed with `namespace:`. |

### Return Value

The return value is an MCP server object (from the Claude Agent SDK's `createSdkMcpServer`) extended with a `handlers` property containing the raw tool handler functions:

```typescript
interface BlackboardMcpHandlers {
  blackboard_read: (args: { key: string }) => Promise<McpToolResult>;
  blackboard_write: (args: { key: string; value: unknown }) => Promise<McpToolResult>;
  blackboard_keys: (args: Record<string, never>) => Promise<McpToolResult>;
}
```

### Exposed Tools

The server exposes three tools to the Claude agent:

| Tool               | Input                      | Description                                                |
| ------------------ | -------------------------- | ---------------------------------------------------------- |
| `blackboard_read`  | `{ key: string }`          | Read a value. Returns JSON-serialized value or `undefined`. |
| `blackboard_write` | `{ key: string; value: any }` | Write any JSON-serializable value.                         |
| `blackboard_keys`  | (none)                     | List all keys in scope as a JSON array.                    |

### Example

```typescript
import { createBlackboardMcpServer, InMemoryBlackboard } from "cartographer";

const bb = new InMemoryBlackboard({ greeting: "hello" });
const server = createBlackboardMcpServer(bb);

// Scoped server — agent only sees keys under "classify:"
const scoped = createBlackboardMcpServer(bb, "classify");
```

---

## Utility Functions

### wrapElicitation

```typescript
import { wrapElicitation } from "cartographer";

function wrapElicitation(
  handler: OnElicitation | undefined,
  node: BTreeNode,
  events: TypedEventEmitter<TreeEvents>,
): OnElicitation;
```

Wraps an optional elicitation handler so the SDK always receives a function. If `handler` is defined, delegates to it. Otherwise emits `agent:elicitation_declined` and returns `{ action: 'decline' }`. Used internally by `ClaudeSDKAgent` and all three agent strategies; exported for custom strategy or agent implementations.

### buildStrategyPrompt

```typescript
import { buildStrategyPrompt } from "cartographer";

function buildStrategyPrompt(
  config: AgentStrategyConfig,
  children: BTreeNode[],
  context: TreeContext,
): string;
```

Builds the full prompt string that agent strategies send to the agent. Combines the caller's base prompt with two contextual sections — the list of available child nodes (with optional descriptions from `childDescriptions`) and a snapshot of the current blackboard state. The `config.prompt` value can be a static string or a function `(children, context) => string` for dynamic prompt construction.

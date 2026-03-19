# Agent Integration API Reference

Helpers for connecting the Claude Agent SDK to the behavior tree event system.

---

## createBlackboardMcpServer

```typescript
import { createBlackboardMcpServer } from "cartographer";
```

Creates an in-process MCP server that gives Claude read/write access to the behavior tree blackboard. `AgentNode` attaches one of these automatically — use this function directly only when building custom agent strategies or standalone SDK calls.

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

// Pass to the Agent SDK as an MCP server
const result = await agent.run({
  mcpServers: [server],
  // ...
});

// Scoped server — agent only sees keys under "classify:"
const scoped = createBlackboardMcpServer(bb, "classify");
```

---

## emitMessageEvents

```typescript
import { emitMessageEvents } from "cartographer";
```

Emits granular `agent:*` observability events for a single raw SDK message. Used internally by `AgentNode` and agent strategies; exposed for custom strategy implementations that call the SDK directly.

### Signature

```typescript
function emitMessageEvents(
  msg: unknown,
  node: BTreeNode,
  events: TypedEventEmitter<TreeEvents>,
): void;
```

### Parameters

| Parameter | Type                            | Required | Description                                             |
| --------- | ------------------------------- | -------- | ------------------------------------------------------- |
| `msg`     | `unknown`                       | Yes      | A raw SDK message object from the Claude Agent SDK.     |
| `node`    | `BTreeNode`                     | Yes      | The node associated with the SDK call (included in event payloads). |
| `events`  | `TypedEventEmitter<TreeEvents>` | Yes      | The tree's event emitter.                               |

### Emitted Events

Depending on the message type, the function emits some combination of:

| Event                  | When                                      |
| ---------------------- | ----------------------------------------- |
| `agent:message`        | Every raw message (catch-all)             |
| `agent:thinking`       | Assistant message contains a thinking block |
| `agent:text`           | Assistant message contains a text block   |
| `agent:tool_use`       | Assistant message contains a tool use block |
| `agent:stream`         | Raw streaming delta                       |
| `agent:tool_progress`  | Tool execution progress with elapsed time |
| `agent:init`           | System/init message                       |
| `agent:status`         | Status message                            |
| `agent:rate_limit`     | Rate limit warning                        |

### Why lifecycle events are excluded

This function does **not** emit `agent:response` or `agent:error`. These are *lifecycle* events that represent the final outcome of an entire SDK conversation, not a single message — and different callers need to interpret that outcome differently before emitting them:

- **`AgentNode`** writes the result to the blackboard, optionally runs `mapResult` to derive a `NodeStatus`, and then emits `agent:response` with the interpreted output, `cost`, and `modelUsage`.
- **Agent strategies** (via `createStrategyMessageHandler`) prefer `structured_output` over raw `result`, fall back to JSON parsing, and emit `agent:response` / `agent:error` with `cost` and `modelUsage`.

By keeping lifecycle events out of `emitMessageEvents`, each caller owns the "what does the final result mean?" decision while reusing the same per-message observability logic. If you are writing a custom strategy, use `createStrategyMessageHandler` to get both layers automatically.

---

## createStrategyMessageHandler

```typescript
import { createStrategyMessageHandler } from "cartographer";
```

Creates a message handler for agent strategy SDK calls that emits per-message observability events plus `agent:response` / `agent:error` lifecycle events. Intended as the `onMessage` callback passed to `queryStructured`.

### Signature

```typescript
function createStrategyMessageHandler(
  node: BTreeNode,
  events: TypedEventEmitter<TreeEvents>,
): (msg: unknown) => void;
```

### Parameters

| Parameter | Type                            | Required | Description                                             |
| --------- | ------------------------------- | -------- | ------------------------------------------------------- |
| `node`    | `BTreeNode`                     | Yes      | The node associated with the strategy SDK call.         |
| `events`  | `TypedEventEmitter<TreeEvents>` | Yes      | The tree's event emitter.                               |

### Return Value

A callback function `(msg: unknown) => void` suitable for passing as the `onMessage` parameter to `queryStructured`.

### Behavior

The returned handler:

1. Calls `emitMessageEvents()` for every message to emit per-message observability events.
2. On result messages, additionally emits lifecycle events:
   - `agent:response` on success — includes `result`, `cost`, and `modelUsage`.
   - `agent:error` on failure — includes `subtype`, `errors`, `permissionDenials`, `cost`, and `modelUsage`.

### Example

```typescript
import {
  createStrategyMessageHandler,
  queryStructured,
} from "cartographer";

// Inside a custom strategy implementation
const handler = createStrategyMessageHandler(compositeNode, context.events);

const decision = await queryStructured(
  prompt,
  schema,
  strategyConfig,
  handler, // onMessage callback
  context.signal,
);
```

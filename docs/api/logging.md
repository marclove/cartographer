# Logging API Reference

Structured logging for behavior tree runs.

---

## createTreeLogger

```typescript
import { createTreeLogger } from "cartographer";
```

Attaches to a tree's event emitter and appends structured NDJSON log entries to a file. Each line is a self-contained JSON object with a `ts` (ISO timestamp), the event `type`, and the event payload. See [Structured Logging](../guide-blackboard-and-events.md#structured-logging-with-createtreelogger) for a walkthrough.

### Signature

```typescript
function createTreeLogger(
  events: TypedEventEmitter<TreeEvents>,
  options: TreeLoggerOptions,
): () => void;
```

### Parameters

| Parameter | Type                            | Required | Description                        |
| --------- | ------------------------------- | -------- | ---------------------------------- |
| `events`  | `TypedEventEmitter<TreeEvents>` | Yes      | The tree's event emitter to attach to. Typically `tree.events`. |
| `options` | `TreeLoggerOptions`             | Yes      | Logger configuration.              |

### Return Value

A cleanup function `() => void` that removes all event listeners registered by the logger. Call this when you are done logging to prevent memory leaks.

### Logged Events

The logger subscribes to most tree events. Two high-frequency event types are excluded by default:

| Event            | Logged | Reason                                         |
| ---------------- | ------ | ---------------------------------------------- |
| `agent:stream`   | No     | Raw streaming deltas — too noisy.              |
| `agent:message`  | No     | Redundant with the other `agent:*` events.     |

All other events from the `TreeEvents` map are logged, including node lifecycle (`node:enter`, `node:exit`, `node:error`), agent events (`agent:prompt`, `agent:thinking`, `agent:text`, `agent:tool_use`, `agent:response`, `agent:error`, etc.), and tree lifecycle (`tree:init`, `tree:tick`, `tree:reset`, `tree:abort`).

### Example

```typescript
import { BehaviorTree, createTreeLogger } from "cartographer";

const tree = new BehaviorTree({ name: "my-tree", root: myRoot });

const stopLogging = createTreeLogger(tree.events, {
  filePath: "./logs/run.log",
  logBlackboard: true,
});

await tree.tick();

// When done, remove all listeners
stopLogging();
```

---

## TreeLoggerOptions

```typescript
import type { TreeLoggerOptions } from "cartographer";
```

Configuration for `createTreeLogger`.

| Field           | Type      | Required | Default | Description                                                                                                    |
| --------------- | --------- | -------- | ------- | -------------------------------------------------------------------------------------------------------------- |
| `filePath`      | `string`  | Yes      | —       | Path to the log file. Entries are appended in NDJSON format. The file and parent directories are created if they do not exist. |
| `logBlackboard` | `boolean` | No       | `false` | Include `blackboard:write` events. Disabled by default because blackboard writes can be very frequent.         |
| `logStrategy`   | `boolean` | No       | `true`  | Include `strategy:decision` events.                                                                            |

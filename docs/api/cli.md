# CLI

Types and utilities for the CLI runner. See the [CLI Runner guide](../guide-cli.md) for usage.

```typescript
import type { RunContext, TreeRunConfig } from 'cartographer';
import { createFormatter } from 'cartographer';
```

---

## RunContext

Context provided by the CLI to the user's tree factory function.

```typescript
interface RunContext {
  env: Record<string, string | undefined>;
  args: string[];
}
```

| Field | Type | Description |
|-------|------|-------------|
| `env` | `Record<string, string \| undefined>` | Environment variables — `process.env` merged with `--env-file` values. |
| `args` | `string[]` | Positional arguments after the tree file path. |

---

## TreeRunConfig

Configuration returned by the user's tree factory function.

```typescript
interface TreeRunConfig {
  tree: BehaviorTree;
  schedule?: SchedulerConfig['schedule'];
  maxCycles?: number;
  stopOnStatus?: NodeStatus;
  onError?: SchedulerConfig['onError'];
}
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `tree` | `BehaviorTree` | (required) | The constructed behavior tree to run. |
| `schedule` | `{ type: 'cron'; expression: string } \| { type: 'interval'; delayMs: number } \| { type: 'once' }` | — | Optional schedule. Omit for a single run. |
| `maxCycles` | `number` | — | Maximum number of completed cycles (terminal statuses; only meaningful with a schedule). |
| `stopOnStatus` | `NodeStatus` | — | Stop scheduler when tree returns this status. |
| `onError` | `'stop' \| 'continue' \| ((error: Error, runCount: number) => 'stop' \| 'continue')` | — | Error handling policy for scheduled runs. |

---

## FormatterOptions

Configuration for the CLI output formatter.

```typescript
interface FormatterOptions {
  json?: boolean;
  verbose?: boolean;
  quiet?: boolean;
}
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `json` | `boolean` | `false` | Emit events as JSON lines (NDJSON) instead of formatted text. |
| `verbose` | `boolean` | `false` | Include `agent:thinking` and `agent:tool_use` events. |
| `quiet` | `boolean` | `false` | Suppress all output except errors and the final status line. |

---

## createFormatter

```typescript
function createFormatter(
  events: TypedEventEmitter<TreeEvents>,
  options?: FormatterOptions,
): () => void;
```

Subscribe to tree events and render structured output to stdout. Returns a cleanup function that removes all listeners.

The formatter selects a rendering mode based on `options`:

- **quiet** (non-JSON) — errors to stderr, final status to stdout.
- **json** — all events as NDJSON lines with `ts` timestamps.
- **text** (default) — indented, symbol-annotated output with tree depth.

When `verbose` is enabled in text mode, `agent:thinking`, `agent:prompt`, and `agent:tool_use` events are included. In JSON mode, `verbose` adds `agent:thinking` events.

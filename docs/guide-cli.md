# CLI Runner

The `cartographer` binary runs, inspects, and scaffolds behavior trees from the command line.

```bash
cartographer run my-tree.ts       # execute a tree
cartographer inspect my-tree.ts   # visualize its structure
cartographer init my-tree         # scaffold a new tree file
```

---

## Quick Start

Scaffold a tree and run it:

```bash
cartographer init my-tree
cartographer run my-tree.ts
```

Output (text mode):

```
▶ [sequence] main
  ▶ [action] hello
  ✓ [action] hello (1ms)
  ▶ [action] log-result
Hello from my-tree!
  ✓ [action] log-result (0ms)
✓ [sequence] main (2ms)

Tree: my-tree — SUCCESS (3ms)
```

---

## The Factory Contract

Every tree file must default-export a factory function. The CLI calls this function with a `RunContext` and expects a `TreeRunConfig` back.

```typescript
import type { RunContext, TreeRunConfig } from 'cartographer';

export default function (ctx: RunContext): TreeRunConfig {
  // ...build and return your tree
}
```

### Why a factory?

The factory pattern defers tree construction until the CLI has loaded environment variables and parsed arguments. Your factory receives both through `RunContext`, so it can read secrets, select branches, or configure nodes based on runtime input.

### RunContext

| Field | Type | Description |
|-------|------|-------------|
| `env` | `Record<string, string \| undefined>` | `process.env` merged with any `--env-file` values. |
| `args` | `string[]` | Positional arguments after the tree file path. |

### TreeRunConfig

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `tree` | `BehaviorTree` | (required) | The constructed behavior tree to run. |
| `schedule` | `SchedulerConfig['schedule']` | — | Optional schedule. Omit for a single run. |
| `maxCycles` | `number` | — | Maximum number of completed cycles (terminal statuses). |
| `stopOnStatus` | `NodeStatus` | — | Stop the scheduler when the tree returns this status. |
| `onError` | `SchedulerConfig['onError']` | — | Error handling policy for scheduled runs. |

### Example: reading environment variables

```typescript
import type { RunContext, TreeRunConfig } from 'cartographer';
import { BehaviorTree, SequenceNode, ActionNode, NodeStatus } from 'cartographer';

export default function (ctx: RunContext): TreeRunConfig {
  const apiKey = ctx.env['API_KEY'];
  if (!apiKey) throw new Error('API_KEY is required');

  const tree = new BehaviorTree({
    name: 'api-caller',
    root: new SequenceNode({
      name: 'main',
      children: [
        new ActionNode({
          name: 'call-api',
          action: async (context) => {
            const res = await fetch('https://api.example.com/data', {
              headers: { Authorization: `Bearer ${apiKey}` },
            });
            context.blackboard.set('response', await res.json());
            return res.ok ? NodeStatus.SUCCESS : NodeStatus.FAILURE;
          },
        }),
      ],
    }),
  });

  return { tree };
}
```

```bash
cartographer run api-caller.ts --env-file .env
```

---

## Commands

### run \<file\> [args...]

Execute a behavior tree. The file must default-export a factory function.

**Single-run mode** (no `schedule` in the returned config):

```bash
cartographer run deploy.ts
```

The CLI calls `tree.run()` once, prints output, and exits with a status-based exit code.

**Scheduled mode** (factory returns a `schedule`):

```typescript
import type { RunContext, TreeRunConfig } from 'cartographer';
import { TreeBuilder, NodeStatus } from 'cartographer';

export default function (ctx: RunContext): TreeRunConfig {
  const tree = new TreeBuilder('health-check')
    .sequence('check', (b) => {
      b.action('ping', async () => {
        const res = await fetch(ctx.env['HEALTH_URL']!);
        return res.ok ? NodeStatus.SUCCESS : NodeStatus.FAILURE;
      });
    })
    .build();

  return {
    tree,
    schedule: { type: 'interval', delayMs: 30_000 },
    stopOnStatus: NodeStatus.FAILURE,
    onError: 'continue',
  };
}
```

```bash
cartographer run health-check.ts --env-file .env
```

The CLI wraps execution in a `TreeScheduler` and runs until a stop condition is met or a signal is received.

### inspect \<file\>

Visualize the tree structure as an ASCII tree, then print summary stats.

```bash
cartographer inspect deploy.ts
```

```
[sequence] deploy
├── [action] start-deploy
├── [action] wait-for-healthy
└── [action] notify-slack

Nodes: 4  Max depth: 1  Agent nodes: 0
```

The factory is called with a minimal `RunContext` (current `process.env`, empty args) to construct the tree for inspection. No ticks are executed.

### init \<name\>

Scaffold a new tree file with a working template.

```bash
cartographer init my-tree
# Created my-tree.ts
```

Generates a TypeScript file with the factory contract, a simple sequence, and correct imports. Errors if the file already exists.

---

## Output Modes

| Flag | Mode | Description |
|------|------|-------------|
| (default) | Text | Indented, symbol-annotated output. |
| `--json` | JSON | One JSON object per line (NDJSON). |
| `--verbose` | Verbose | Text mode with additional agent events (`agent:thinking`, `agent:tool_use`). |
| `--quiet` | Quiet | Errors and final status line only. |

### Text Mode

The default output uses indentation to reflect tree depth and symbols to indicate status:

```
▶ [sequence] main
  ▶ [action] step-1
  ✓ [action] step-1 (12ms)
  ▶ [action] step-2
  ✗ [action] step-2 (3ms)
✗ [sequence] main (16ms)

Tree: my-tree — FAILURE (17ms)
```

| Symbol | Meaning |
|--------|---------|
| `▶` | Node entered |
| `✓` | Node succeeded |
| `✗` | Node failed (or error) |
| `…` | Node returned RUNNING |

### JSON Mode

Each event is emitted as a single JSON line with a `ts` timestamp and `event` field:

```bash
cartographer run my-tree.ts --json
```

```jsonl
{"ts":"2026-03-12T10:00:00.000Z","event":"node:enter","node":"main","nodeId":"..."}
{"ts":"2026-03-12T10:00:00.001Z","event":"node:enter","node":"step-1","nodeId":"..."}
{"ts":"2026-03-12T10:00:00.013Z","event":"node:exit","node":"step-1","nodeId":"...","status":"success","durationMs":12}
{"ts":"2026-03-12T10:00:00.014Z","event":"tree:tick","tree":"my-tree","status":"success","durationMs":14}
```

Pipe to `jq` for filtering:

```bash
cartographer run my-tree.ts --json | jq 'select(.event == "node:exit")'
```

### Quiet Mode

Suppresses all output except errors (written to stderr) and the final status line:

```bash
cartographer run my-tree.ts --quiet
# my-tree — SUCCESS (14ms)
```

Useful in CI pipelines where you only care about the exit code and final result.

---

## Environment Files

Load environment variables from a file with `--env-file`:

```bash
cartographer run my-tree.ts --env-file .env
```

The file uses `KEY=VALUE` format:

```bash
# Database connection
DB_HOST=localhost
DB_PORT=5432

# API credentials
API_KEY="sk-abc123"
SECRET='my-secret-value'
```

- Lines starting with `#` are comments.
- Blank lines are skipped.
- Values can be optionally quoted with single or double quotes.
- Variables are merged into `process.env` and available via `ctx.env` in the factory.

---

## Signal Handling and Exit Codes

The CLI handles `SIGINT` (Ctrl-C) and `SIGTERM` gracefully. On the first signal, `tree.abort()` is called, giving nodes a chance to clean up. In scheduled mode, the scheduler is also stopped.

### Exit codes

| Code | Meaning |
|------|---------|
| `0` | Tree returned `SUCCESS`. |
| `1` | Tree returned `FAILURE`, or a runtime error occurred. |
| `2` | Tree returned `RUNNING`, or execution was interrupted by a signal. |

---

## Scheduling via CLI

When the factory returns a `schedule` field, the CLI automatically wraps execution in a `TreeScheduler`. All scheduler options (`maxCycles`, `stopOnStatus`, `onError`) are set through the `TreeRunConfig` — no additional flags needed.

```typescript
export default function (ctx: RunContext): TreeRunConfig {
  return {
    tree,
    schedule: { type: 'cron', expression: '*/5 * * * *' },
    maxCycles: 100,
    onError: 'continue',
  };
}
```

For full details on schedule types and behavior, see the [Scheduler guide](guide-scheduler.md).

---

## Where to go next

- [API Reference: CLI](api/cli.md) -- full type signatures for `RunContext`, `TreeRunConfig`, `FormatterOptions`, and `createFormatter`.
- [Scheduler](guide-scheduler.md) -- interval, cron, and one-shot scheduling in depth.
- [Blackboard and Events](guide-blackboard-and-events.md) -- the event system that the CLI formatter consumes.

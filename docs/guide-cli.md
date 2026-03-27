# CLI Runner

The `cartographer` binary runs, inspects, and scaffolds behavior trees from the command line.

```bash
cartographer run my-tree.ts           # start an actor server for a tree
cartographer inspect my-tree.ts       # visualize its structure
cartographer init my-tree             # scaffold a new tree file
```

---

## Quick Start

Scaffold a tree and run it:

```bash
cartographer init my-tree
cartographer run my-tree.ts
```

The `run` command starts an ActorServer and a dashboard by default:

```
Actor server: http://localhost:3147
Dashboard: http://localhost:3148
```

Send a tick to execute the tree:

```bash
curl -X POST http://localhost:3147/api/messages -H 'Content-Type: application/json' -d '{"type":"tick"}'
```

---

## The Factory Contract

Every tree file must default-export a factory function. The CLI calls this function with a `RunContext` and expects a `TreeRunConfig` back.

```typescript
import type { RunContext, TreeRunConfig } from "cartographer";

export default function (ctx: RunContext): TreeRunConfig {
  // ...build and return your tree
}
```

### Why a factory?

The factory pattern defers tree construction until the CLI has loaded environment variables and parsed arguments. Your factory receives both through `RunContext`, so it can read secrets, select branches, or configure nodes based on runtime input.

### RunContext

| Field  | Type                                  | Description                                        |
| ------ | ------------------------------------- | -------------------------------------------------- |
| `env`  | `Record<string, string \| undefined>` | `process.env` merged with any `--env-file` values. |
| `args` | `string[]`                            | Positional arguments after the tree file path.     |

### TreeRunConfig

| Field       | Type             | Default    | Description                                   |
| ----------- | ---------------- | ---------- | --------------------------------------------- |
| `tree`      | `BehaviorTree`   | (required) | The constructed behavior tree to run.          |
| `sessionId` | `string`         | (required) | Session key for the ActorServer.               |

### Example: reading environment variables

```typescript
import type { RunContext, TreeRunConfig } from "cartographer";
import { BehaviorTree, SequenceNode, ActionNode, NodeStatus } from "cartographer";

export default function (ctx: RunContext): TreeRunConfig {
  const apiKey = ctx.env["API_KEY"];
  if (!apiKey) throw new Error("API_KEY is required");

  const tree = new BehaviorTree({
    name: "api-caller",
    root: new SequenceNode({
      name: "main",
      children: [
        new ActionNode({
          name: "call-api",
          action: async (context) => {
            const res = await fetch("https://api.example.com/data", {
              headers: { Authorization: `Bearer ${apiKey}` },
            });
            context.blackboard.set("response", await res.json());
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

### Example: health check tree

```typescript
import type { RunContext, TreeRunConfig } from "cartographer";
import { TreeBuilder, NodeStatus } from "cartographer";

export default function (ctx: RunContext): TreeRunConfig {
  const tree = new TreeBuilder("health-check")
    .sequence("check", (b) => {
      b.action("ping", async () => {
        const res = await fetch(ctx.env["HEALTH_URL"]!);
        return res.ok ? NodeStatus.SUCCESS : NodeStatus.FAILURE;
      });
    })
    .build();

  return {
    tree,
    sessionId: 'health-check',
  };
}
```

---

## Commands

### run \<file\> [args...]

Start an ActorServer for a behavior tree. The file must default-export a factory function.

```bash
cartographer run deploy.ts
```

The CLI calls the factory, creates an ActorServer, and starts it. The server exposes HTTP endpoints for sending messages, reading state, and streaming events via SSE. A dashboard is also started for real-time observation. The tree runs when messages arrive via the HTTP API.

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

| Flag        | Mode    | Description                                                                  |
| ----------- | ------- | ---------------------------------------------------------------------------- |
| (default)   | Text    | Indented, symbol-annotated output.                                           |
| `--json`    | JSON    | One JSON object per line (NDJSON).                                           |
| `--verbose` | Verbose | Text mode with additional agent events (`agent:thinking`, `agent:tool_use`). |
| `--quiet`   | Quiet   | Errors and final status line only.                                           |

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

| Symbol | Meaning                |
| ------ | ---------------------- |
| `▶`    | Node entered           |
| `✓`    | Node succeeded         |
| `✗`    | Node failed (or error) |
| `…`    | Node returned RUNNING  |

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

## Server Flags

| Flag                        | Description                                     |
| --------------------------- | ----------------------------------------------- |
| `--port <number>`           | Port for the ActorServer (default: 3147).        |
| `--no-dashboard`            | Disable the dashboard server.                    |
| `--dashboard-port <number>` | Port for the dashboard (default: 3148).          |

---

## Signal Handling and Exit Codes

The CLI handles `SIGINT` (Ctrl-C) and `SIGTERM` gracefully. On signal, the dashboard server is closed and the ActorServer is shut down. The process exits with code 0.

---

## Where to go next

- [API Reference: CLI](api/cli.md) -- full type signatures for `RunContext`, `TreeRunConfig`, `FormatterOptions`, and `createFormatter`.
- [Application Server](guide-app-server.md) -- message-driven tree execution, state persistence, and the HTTP API.
- [Blackboard and Events](guide-blackboard-and-events.md) -- the event system that the CLI formatter consumes.

# CLI Runner — Phase 1 Design

## Problem

Cartographer is currently a pure library. Running a behavior tree requires writing a TypeScript entry point that imports the framework, constructs a tree, and calls `run()` or `tick()`. There's no standardized way to execute a tree from the command line, observe its execution with structured output, or scaffold a new tree project.

## Solution

Add a CLI runner (`cartographer run`) that loads a user's tree module, manages the execution lifecycle, and provides structured event output. The CLI includes three commands: `run` (execute a tree), `inspect` (visualize tree structure), and `init` (scaffold a new tree file).

Phase 1 is non-interactive — structured log output only. Phase 2 will add an interactive TUI dashboard.

## User Contract

Users export a **factory function** as the default export from a `.ts` (or `.js`) file. The factory receives a `RunContext` and returns a `TreeRunConfig`:

```ts
import type { RunContext, TreeRunConfig } from 'cartographer';
import { BehaviorTree, SequenceNode, ActionNode, NodeStatus } from 'cartographer';

export default function(ctx: RunContext): TreeRunConfig {
  const tree = new BehaviorTree({
    name: 'my-tree',
    root: new SequenceNode({
      name: 'main',
      children: [
        new ActionNode({
          name: 'greet',
          action: async () => {
            console.log('Hello!');
            return NodeStatus.SUCCESS;
          },
        }),
      ],
    }),
  });

  return { tree };
}
```

### RunContext

Provided by the CLI to the user's factory function:

```ts
interface RunContext {
  /** Environment variables (process.env merged with --env-file values) */
  env: Record<string, string | undefined>;
  /** Positional arguments after the filename */
  args: string[];
}
```

### TreeRunConfig

Returned by the user's factory function:

```ts
interface TreeRunConfig {
  /** The constructed behavior tree to run */
  tree: BehaviorTree;
  /** Optional schedule — omit for a single run */
  schedule?: SchedulerConfig['schedule'];
  /** Maximum number of runs (only meaningful with a schedule) */
  maxRuns?: number;
  /** Stop scheduler when tree returns this status */
  stopOnStatus?: NodeStatus;
  /** Whether to reset the tree between scheduled ticks (default: true) */
  resetBetweenTicks?: boolean;
  /** Error handling policy for scheduled runs */
  onError?: SchedulerConfig['onError'];
}
```

When `schedule` is omitted, the CLI runs the tree once via `tree.run()`. When `schedule` is provided, the CLI wraps execution in a `TreeScheduler`.

## CLI Commands

### `cartographer run <file> [args...]`

Execute a behavior tree.

**Flags:**
- `--json` — Output events as JSON lines (NDJSON) instead of formatted text
- `--verbose` — Include agent:thinking and agent:tool_use events in output
- `--quiet` — Suppress all output except errors
- `--env-file <path>` — Load environment variables from a file (KEY=VALUE format, one per line)

**Exit codes:**
- `0` — Tree returned SUCCESS
- `1` — Tree returned FAILURE or an error occurred
- `2` — Tree was RUNNING when interrupted (SIGINT/SIGTERM)

**Signal handling:**
- SIGINT/SIGTERM → call `tree.abort()`, wait for current tick to complete, then exit with appropriate code

### `cartographer inspect <file>`

Visualize tree structure without executing it.

Loads the module, calls the factory with a minimal `RunContext`, walks the tree via the `children` accessor, and prints an ASCII tree showing node types, names, and decorator parameters.

Also reports summary stats: total node count, max depth, number of agent nodes.

### `cartographer init <name>`

Scaffold a new tree file.

Writes `<name>.ts` in the current directory with the factory export pattern, a basic sequence example, and RunContext typing.

## Event Formatter

The formatter subscribes to `TreeEvents` and renders structured output to stdout.

### Default mode (human-readable)

Tracks tree depth via a `node:enter` / `node:exit` stack. Each event is rendered as an indented line with a symbol prefix:

```
▶ [sequence] main
  ▶ [action] fetch-data
  ✓ [action] fetch-data (120ms)
  ▶ [agent] analyze
    🔧 [tool] web-search
  ✓ [agent] analyze (2340ms)
✓ [sequence] main (2460ms)

Tree: my-tree — SUCCESS (2461ms)
```

In `--verbose` mode, additional events are shown:
- `agent:thinking` — thinking content (truncated to first line)
- `agent:tool_use` — tool name and input summary
- `agent:prompt` — the prompt sent to the agent

### JSON mode (`--json`)

Each event is emitted as a single JSON line (NDJSON), matching the shape used by `createTreeLogger`. This allows piping to `jq` or other JSON processors.

### Quiet mode (`--quiet`)

Only errors and the final status line are printed.

## File Structure

```
src/cli/
├── types.ts          # RunContext, TreeRunConfig
├── index.ts          # Entry point — arg parsing, command dispatch
├── formatter.ts      # Event formatter (default, JSON, verbose, quiet)
└── commands/
    ├── run.ts        # Run command implementation
    ├── inspect.ts    # Inspect command implementation
    └── init.ts       # Init command implementation
```

## Package Changes

- Add `bin` field: `{ "cartographer": "./dist/cli/index.js" }`
- Move `tsx` from devDependencies to dependencies (needed at runtime for loading .ts files)
- Export `RunContext` and `TreeRunConfig` from `src/index.ts`

## Design Decisions

### Factory → Config pattern (not declarative config)

The user's module exports a function, not a static config object. This allows:
- Dynamic tree construction based on environment or args
- Access to closures and runtime state
- Full TypeScript type checking of the tree structure
- No need for a separate config schema or validation layer

### tsx for TypeScript loading

Using `tsx` (via dynamic `import()` after registering the tsx loader) to load user `.ts` files. It's already a devDependency, fast, and handles ESM + TypeScript without requiring the user to pre-compile.

### Minimal arg parser (no heavy dependency)

The CLI uses `process.argv` slicing and a simple flag parser. The command set is small and fixed — a full CLI framework (yargs, commander) would be overkill and add unnecessary dependency weight.

### Same-package distribution

The CLI ships in the same `cartographer` npm package. No separate `@cartographer/cli` package. Users who `npm install cartographer` get both the library and the CLI.

### Non-interactive Phase 1

Phase 1 outputs structured text/JSON only. No interactive TUI, no prompts, no keyboard input. This validates the runner design and event formatting before committing to a TUI framework in Phase 2.

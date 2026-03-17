# Run/Serve Command Consolidation

Consolidate the `run` and `serve` CLI commands into a single `run` command backed by ActorServer. Retire the `serve` command.

## Motivation

The `run` and `serve` commands have converging responsibilities. Both load a tree module, create a tree, and execute it — they differ only in execution lifetime (batch vs daemon) and server backend (TreeServer vs ActorServer). Maintaining two commands with two server implementations adds surface area without proportional value. ActorServer already supports everything TreeServer does, plus message processing, state persistence, and a richer SSE pipeline.

## CLI Surface

Single `run` command. The `--serve` flag is the dividing line between batch and daemon modes.

```
cartographer run my-tree.ts                              # batch: tick tree, exit
cartographer run my-tree.ts --serve --tick-interval 1000 # daemon: tick + accept messages
cartographer run my-tree.ts --serve --no-tick             # daemon: message-driven only
```

### Flags

| Flag | Requires | Description |
|------|----------|-------------|
| `--json` | — | Output events as JSON lines (NDJSON) |
| `--verbose` | — | Include agent:thinking and agent:tool_use events |
| `--quiet` | — | Suppress all output except errors |
| `--env-file <path>` | — | Load environment variables from a file |
| `--serve` | `--tick-interval` or `--no-tick` | Start ActorServer, stay alive |
| `--port <number>` | `--serve` | Port for the actor server |
| `--no-dashboard` | `--serve` | Disable the dashboard server |
| `--dashboard-port <number>` | `--serve` | Port for the dashboard server |
| `--tick-interval <ms>` | `--serve` | Delay between tick cycles |
| `--no-tick` | `--serve` | Disable auto-ticking (message-driven only) |

### Validation Rules

- `--serve` requires exactly one of `--tick-interval <ms>` or `--no-tick` (no hidden default — daemon tick rate must be explicit)
- `--no-tick`, `--tick-interval`, `--port`, `--no-dashboard`, `--dashboard-port` all require `--serve`
- `--no-tick` + `--tick-interval` together is an error
- `--no-serve` (the old flag that disabled TreeServer) is removed

## Execution Modes

### Batch Mode (default, no `--serve`)

1. Load module, call factory, get TreeRunConfig
2. Create tree, attach formatter to its event emitter
3. Execute per TreeRunConfig: single `tree.run()` if no schedule, or TreeScheduler with the user's `schedule`/`maxCycles`/`stopOnStatus`/`onError`
4. Exit with status code (0 = success, 1 = failure, 2 = running/aborted)

No ActorServer, no dashboard, no HTTP server. Pure tree execution with CLI output.

### Daemon Mode (`--serve`)

1. Load module, call factory
2. Start ActorServer with `createTree` wrapped to attach the formatter to every tree it creates (so message-processing trees produce CLI output)
3. Optionally start Dashboard
4. If ticking (`--tick-interval`): create a live tree, attach formatter, bridge its events to ActorServer's SSE pipeline via `bridgeTree()`, tick via TreeScheduler on the specified interval
5. If message-driven (`--no-tick`): no tick-loop tree; events flow through the formatter only when messages arrive and ActorServer creates trees for processing
6. Stay alive until SIGINT/SIGTERM, exit with code 0 on clean shutdown

### Formatter in All Modes

The formatter subscribes to `TypedEventEmitter<TreeEvents>` and requires live `BTreeNode` references for depth tracking and node type detection. Rather than rewriting it to consume serialized events, we ensure it always has access to live trees:

- **Batch mode**: formatter subscribes directly to the tree's event emitter (same as today).
- **Daemon mode with ticking**: formatter subscribes to the tick-loop tree. ActorServer gets serialized events via `bridgeTree()`.
- **Daemon mode (all)**: the `createTree` factory passed to ActorServer is wrapped so every tree created for message processing also gets a formatter subscription. When the tree is GC'd after processing, the formatter handlers are cleaned up with it. Note: ActorServer also calls `createTree` internally for read-only introspection (`readTree` getter) and initial state setup (`initializeDefaultState`). These trees never tick, so the formatter subscriptions attached to them are inert and GC'd with the tree.

```ts
const server = new ActorServer({
  createTree: () => {
    const tree = factory(runContext).tree;
    createFormatter(tree.events, { json, verbose, quiet });
    return tree;
  },
});
```

## What Gets Retired

- **`serve` command**: `src/cli/commands/serve.ts` deleted entirely.
- **TreeServer usage from CLI**: the `run` command no longer starts a TreeServer. Batch mode runs the tree directly with no HTTP server.
- **TreeServer as public API**: kept. It remains exported from `src/index.ts` with its own tests and integration tests unchanged. It's a simpler alternative to ActorServer for programmatic embedding.

## Files Changed

| File | Change |
|------|--------|
| `src/cli/commands/run.ts` | Rewrite: batch mode (direct tree execution) + daemon mode (ActorServer) |
| `src/cli/commands/serve.ts` | Delete |
| `src/cli/commands/shared.ts` | Keep as-is |
| `src/cli/index.ts` | Remove `serve` case, forward new flags (`serve`, `noTick`, `tickInterval`) to `runCommand` |
| `src/cli/parse-args.ts` | Remove `serve` command and `--no-serve` flag, add `--serve`/`--no-tick`/`--tick-interval` flags, add validation |
| `src/cli/index.test.ts` | Remove `serve` command test, add tests for `--serve` flag and validation errors |

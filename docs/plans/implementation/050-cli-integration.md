# Task 50: CLI Integration — Flags and Server Startup

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add `--port` and `--no-serve` flags to the CLI, and start the dashboard server alongside tree execution in the `run` command.

**Depends on:** Task 47

---

### Step 1: Add flags to ParsedArgs

Edit `src/cli/parse-args.ts` — extend the `flags` type in `ParsedArgs`:

```ts
flags: {
  json: boolean;
  verbose: boolean;
  quiet: boolean;
  envFile?: string;
  help: boolean;
  port?: number;      // add
  noServe: boolean;   // add
};
```

Set `noServe: false` in the default flags object.

### Step 2: Parse the new flags

In the flag-parsing loop of `parseArgs()`, add cases:

```ts
case '--port':
  flags.port = parseInt(args[++i], 10);
  break;
case '--no-serve':
  flags.noServe = true;
  break;
```

### Step 3: Update USAGE help text

Edit `src/cli/parse-args.ts` — add the new flags to the `USAGE` constant:

```
  --port <number>    Port for the dashboard server (default: 3147)
  --no-serve         Disable the dashboard server
```

### Step 4: Extend RunOptions

Edit `src/cli/commands/run.ts` — add to `RunOptions`:

```ts
interface RunOptions {
  file: string;
  args: string[];
  json?: boolean;
  verbose?: boolean;
  quiet?: boolean;
  envFile?: string;
  port?: number;       // add
  noServe?: boolean;   // add
}
```

### Step 4: Start server in the run command

In `src/cli/commands/run.ts`, after the formatter is created and before tree execution begins:

```ts
import { DashboardServer } from '../../server/dashboard-server.js';

// After formatter creation, before tree execution:
let dashboardServer: DashboardServer | undefined;
if (!options.noServe) {
  dashboardServer = new DashboardServer(tree, { port: options.port });
  const { port } = await dashboardServer.start();
  if (!options.quiet) {
    console.error(`Dashboard: http://localhost:${port}`);
  }
}
```

Add cleanup before every `process.exit()` call. The `runCommand` function has multiple exit points via `process.exit()` with no `finally` block. Refactor the exit pattern:

1. Extract a helper at the top of the function:

```ts
async function exit(code: number): Promise<never> {
  if (dashboardServer) await dashboardServer.close();
  cleanupFormatter();
  process.exit(code);
}
```

2. Replace all `process.exit(N)` calls in the function with `await exit(N)`.

This ensures the server is always shut down cleanly regardless of which exit path is taken.

### Step 5: Pass flags through from CLI entry point

In `src/cli/index.ts` where `run` is invoked, pass the new flags:

```ts
port: parsed.flags.port,
noServe: parsed.flags.noServe,
```

### Step 6: Add server exports to index.ts

Edit `src/index.ts` — add public exports for the server module:

```ts
export { DashboardServer } from './server/dashboard-server.js';
export type { DashboardServerOptions } from './server/dashboard-server.js';
export type { SerializedNodeRef, SerializedTreeNode } from './server/serializers.js';
```

### Step 7: Typecheck and run tests

Run: `npm run typecheck`
Expected: All pass.

Run: `npm run test`
Expected: Existing tests still pass. The server starts with `port: 0` in tests so there are no port conflicts.

### Step 8: Manual verification

Run a quick sanity check with an example tree:

```bash
npx tsx src/cli/index.ts run examples/simple-sequence.ts
```

Expected: Existing output plus a `Dashboard: http://localhost:3147` message on stderr.

Then verify `--no-serve` suppresses it:

```bash
npx tsx src/cli/index.ts run --no-serve examples/simple-sequence.ts
```

Expected: No dashboard message, identical behavior to before this change.

### Step 9: Commit

```bash
git add src/cli/parse-args.ts src/cli/commands/run.ts src/cli/index.ts src/index.ts
git commit -m "feat(cli): add --port and --no-serve flags, start dashboard server on run"
```

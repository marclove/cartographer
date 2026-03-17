# Run/Serve Consolidation Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Consolidate `run` and `serve` CLI commands into a single `run` command with a `--serve` flag for daemon mode, backed by ActorServer.

**Architecture:** Batch mode (default) runs the tree directly with the formatter and exits. Daemon mode (`--serve`) starts ActorServer + optional Dashboard and stays alive. The formatter attaches to live trees in all modes via a `createTree` wrapper.

**Tech Stack:** TypeScript, vitest, ActorServer, TreeScheduler, EventBridge

**Spec:** `docs/superpowers/specs/2026-03-17-run-serve-consolidation-design.md`

---

### Task 1: Update parse-args — add `--serve` flag, remove `--no-serve`, add validation

**Files:**
- Modify: `src/cli/parse-args.ts`
- Test: `src/cli/index.test.ts`

- [ ] **Step 1: Write failing tests for new flag parsing and validation**

Add these tests to `src/cli/index.test.ts`:

```ts
it('parses --serve flag', () => {
  const result = parse('run', 'tree.ts', '--serve', '--tick-interval', '1000');
  expect(result.flags.serve).toBe(true);
});

it('serve defaults to false', () => {
  const result = parse('run', 'tree.ts');
  expect(result.flags.serve).toBe(false);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/cli/index.test.ts`
Expected: FAIL — `serve` does not exist on flags type

- [ ] **Step 3: Update ParsedArgs and parser — add `--serve`, remove `--no-serve`**

In `src/cli/parse-args.ts`:

Replace the `ParsedArgs` interface `flags` type — remove `noServe: boolean`, add `serve: boolean`. In the parser body, replace the `--no-serve` branch with `--serve`:

```ts
} else if (arg === '--serve') {
  flags.serve = true;
```

Remove the `noServe: false` default and add `serve: false`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/cli/index.test.ts`
Expected: PASS

- [ ] **Step 5: Update existing tests that will break with validation**

The existing `--no-dashboard` and `--dashboard-port` tests don't include `--serve`, so they'll fail once validation lands. Update them now, and update the `serve` command test:

```ts
it('parses --no-dashboard flag', () => {
  const result = parseArgs(['node', 'cli', 'run', 'tree.ts', '--serve', '--no-tick', '--no-dashboard']);
  expect(result.flags.noDashboard).toBe(true);
});

it('noDashboard defaults to false', () => {
  const result = parseArgs(['node', 'cli', 'run', 'tree.ts']);
  expect(result.flags.noDashboard).toBe(false);
});

it('parses --dashboard-port flag', () => {
  const result = parseArgs(['node', 'cli', 'run', 'tree.ts', '--serve', '--no-tick', '--dashboard-port', '4000']);
  expect(result.flags.dashboardPort).toBe(4000);
});

it('does not recognize serve as a special command', () => {
  const result = parseArgs(['node', 'cli', 'serve', 'my-tree.ts']);
  expect(result.command).toBe('serve');
  // serve is still parsed as a command string, but index.ts will reject it as unknown
});
```

- [ ] **Step 6: Run tests to verify existing tests still pass**

Run: `npx vitest run src/cli/index.test.ts`
Expected: PASS

- [ ] **Step 7: Write failing tests for validation rules**

Add to `src/cli/index.test.ts`:

```ts
describe('--serve validation', () => {
  it('errors when --serve used without --tick-interval or --no-tick', () => {
    expect(() => parse('run', 'tree.ts', '--serve')).toThrow(
      '--serve requires either --tick-interval or --no-tick',
    );
  });

  it('errors when --no-tick used without --serve', () => {
    expect(() => parse('run', 'tree.ts', '--no-tick')).toThrow(
      '--no-tick requires --serve',
    );
  });

  it('errors when --tick-interval used without --serve', () => {
    expect(() => parse('run', 'tree.ts', '--tick-interval', '1000')).toThrow(
      '--tick-interval requires --serve',
    );
  });

  it('errors when --no-tick and --tick-interval both set', () => {
    expect(() =>
      parse('run', 'tree.ts', '--serve', '--no-tick', '--tick-interval', '1000'),
    ).toThrow('--no-tick and --tick-interval cannot be used together');
  });

  it('errors when --port used without --serve', () => {
    expect(() => parse('run', 'tree.ts', '--port', '3000')).toThrow(
      '--port requires --serve',
    );
  });

  it('errors when --no-dashboard used without --serve', () => {
    expect(() => parse('run', 'tree.ts', '--no-dashboard')).toThrow(
      '--no-dashboard requires --serve',
    );
  });

  it('errors when --dashboard-port used without --serve', () => {
    expect(() => parse('run', 'tree.ts', '--dashboard-port', '4000')).toThrow(
      '--dashboard-port requires --serve',
    );
  });

  it('accepts --serve with --tick-interval', () => {
    const result = parse('run', 'tree.ts', '--serve', '--tick-interval', '500');
    expect(result.flags.serve).toBe(true);
    expect(result.flags.tickInterval).toBe(500);
  });

  it('accepts --serve with --no-tick', () => {
    const result = parse('run', 'tree.ts', '--serve', '--no-tick');
    expect(result.flags.serve).toBe(true);
    expect(result.flags.noTick).toBe(true);
  });
});
```

- [ ] **Step 8: Run tests to verify validation tests fail**

Run: `npx vitest run src/cli/index.test.ts`
Expected: FAIL — no validation throws yet

- [ ] **Step 9: Add validation logic to parseArgs**

Add a `validateFlags` function at the end of `parseArgs`, called before the return statement. It should throw (not `process.exit`) so tests can catch it:

```ts
function validateFlags(flags: ParsedArgs['flags']): void {
  if (flags.serve) {
    if (!flags.noTick && flags.tickInterval === undefined) {
      throw new Error('--serve requires either --tick-interval or --no-tick');
    }
  }
  if (flags.noTick && !flags.serve) {
    throw new Error('--no-tick requires --serve');
  }
  if (flags.tickInterval !== undefined && !flags.serve) {
    throw new Error('--tick-interval requires --serve');
  }
  if (flags.noTick && flags.tickInterval !== undefined) {
    throw new Error('--no-tick and --tick-interval cannot be used together');
  }
  if (flags.port !== undefined && !flags.serve) {
    throw new Error('--port requires --serve');
  }
  if (flags.noDashboard && !flags.serve) {
    throw new Error('--no-dashboard requires --serve');
  }
  if (flags.dashboardPort !== undefined && !flags.serve) {
    throw new Error('--dashboard-port requires --serve');
  }
}
```

Call `validateFlags(flags)` just before the `return` statement in `parseArgs`.

- [ ] **Step 10: Run tests to verify they pass**

Run: `npx vitest run src/cli/index.test.ts`
Expected: PASS

- [ ] **Step 11: Update USAGE string**

Replace the USAGE constant:

```ts
export const USAGE = `Usage: cartographer <command> [options]

Commands:
  run <file> [args...]     Execute a behavior tree
  inspect <file>           Visualize tree structure
  init <name>              Scaffold a new tree file

Options:
  --json                   Output events as JSON lines (NDJSON)
  --verbose                Include agent:thinking and agent:tool_use events
  --quiet                  Suppress all output except errors
  --env-file <path>        Load environment variables from a file

Serve mode (--serve):
  --serve                  Start actor server, stay alive for messages
  --tick-interval <ms>     Delay between tick cycles (required unless --no-tick)
  --no-tick                Disable auto-ticking (message-driven only)
  --port <number>          Port for the actor server (default: 3147)
  --dashboard-port <num>   Port for the dashboard server (default: 3148)
  --no-dashboard           Disable the dashboard server
`;
```

- [ ] **Step 12: Run all tests**

Run: `npx vitest run src/cli/index.test.ts`
Expected: PASS

- [ ] **Step 13: Commit**

```bash
git add src/cli/parse-args.ts src/cli/index.test.ts
git commit -m "refactor(cli): add --serve flag, remove --no-serve, add flag validation"
```

---

### Task 2: Rewrite run command — batch mode + daemon mode

**Files:**
- Modify: `src/cli/commands/run.ts`

- [ ] **Step 1: Rewrite RunOptions interface**

Replace the `RunOptions` interface in `src/cli/commands/run.ts`:

```ts
export interface RunOptions {
  file: string;
  args: string[];
  json?: boolean;
  verbose?: boolean;
  quiet?: boolean;
  envFile?: string;
  // Daemon mode (--serve)
  serve?: boolean;
  port?: number;
  noDashboard?: boolean;
  dashboardPort?: number;
  noTick?: boolean;
  tickInterval?: number;
}
```

- [ ] **Step 2: Rewrite run command implementation**

Replace the `runCommand` function body. The new implementation has two paths:

**Batch mode** (no `--serve`): same as today minus TreeServer — load module, create tree, attach formatter, execute per TreeRunConfig, exit with status code.

**Daemon mode** (`--serve`): start ActorServer with createTree wrapped to attach formatter, optionally start Dashboard, optionally create tick-loop tree with bridgeTree + formatter + TreeScheduler, wait for SIGINT/SIGTERM.

```ts
import { NodeStatus } from '../../types.js';
import { TreeScheduler } from '../../scheduler/tree-scheduler.js';
import { ActorServer } from '../../server/actor-server.js';
import { createFormatter } from '../formatter.js';
import { loadEnvFile, loadTreeModule, startDashboard } from './shared.js';

export interface RunOptions {
  file: string;
  args: string[];
  json?: boolean;
  verbose?: boolean;
  quiet?: boolean;
  envFile?: string;
  serve?: boolean;
  port?: number;
  noDashboard?: boolean;
  dashboardPort?: number;
  noTick?: boolean;
  tickInterval?: number;
}

export async function runCommand(options: RunOptions): Promise<void> {
  const { file, args, json, verbose, quiet, envFile } = options;

  const env: Record<string, string | undefined> = { ...process.env };
  if (envFile) {
    loadEnvFile(envFile, env);
  }

  const runContext = { env, args };
  const factory = await loadTreeModule(file);

  if (options.serve) {
    return runDaemon(factory, runContext, options);
  }
  return runBatch(factory, runContext, options);
}

async function runBatch(
  factory: Awaited<ReturnType<typeof loadTreeModule>>,
  runContext: { env: Record<string, string | undefined>; args: string[] },
  options: RunOptions,
): Promise<void> {
  const { json, verbose, quiet } = options;

  let config;
  try {
    config = factory(runContext);
  } catch (err) {
    process.stderr.write(`Error in tree factory: ${(err as Error).message}\n`);
    process.exit(1);
  }

  const { tree } = config;
  const stopFormatter = createFormatter(tree.events, { json, verbose, quiet });

  let finalStatus: NodeStatus | undefined;
  let aborted = false;
  const handleSignal = () => {
    if (aborted) return;
    aborted = true;
    tree.abort();
  };
  process.on('SIGINT', handleSignal);
  process.on('SIGTERM', handleSignal);

  try {
    if (config.schedule) {
      const scheduler = new TreeScheduler({
        tree,
        schedule: config.schedule,
        maxCycles: config.maxCycles,
        stopOnStatus: config.stopOnStatus,
        onError: config.onError,
      });

      scheduler.events.on('tick:complete', ({ status }) => {
        finalStatus = status;
      });

      const origHandler = handleSignal;
      const schedulerSignalHandler = () => {
        origHandler();
        scheduler.stop();
      };
      process.removeListener('SIGINT', handleSignal);
      process.removeListener('SIGTERM', handleSignal);
      process.on('SIGINT', schedulerSignalHandler);
      process.on('SIGTERM', schedulerSignalHandler);

      await scheduler.start();
    } else {
      const result = await tree.run();
      finalStatus = result.status;
    }
  } catch (err) {
    process.stderr.write(`Runtime error: ${(err as Error).message}\n`);
    stopFormatter();
    process.exit(1);
  }

  stopFormatter();

  if (aborted && finalStatus === undefined) {
    process.exit(2);
  }
  if (finalStatus === NodeStatus.SUCCESS) {
    process.exit(0);
  }
  if (finalStatus === NodeStatus.RUNNING) {
    process.exit(2);
  }
  process.exit(1);
}

async function runDaemon(
  factory: Awaited<ReturnType<typeof loadTreeModule>>,
  runContext: { env: Record<string, string | undefined>; args: string[] },
  options: RunOptions,
): Promise<void> {
  const { json, verbose, quiet, port, noDashboard, dashboardPort } = options;

  const server = new ActorServer({
    createTree: () => {
      const tree = factory(runContext).tree;
      createFormatter(tree.events, { json, verbose, quiet });
      return tree;
    },
    port: port ?? 3147,
  });

  const { port: serverPort } = await server.start();
  if (!quiet) {
    process.stderr.write(`Actor server: http://localhost:${serverPort}\n`);
  }

  let dashHandle: Awaited<ReturnType<typeof startDashboard>> = null;
  if (!noDashboard) {
    dashHandle = await startDashboard({
      apiPort: serverPort,
      dashboardPort,
      importMetaUrl: import.meta.url,
      quiet,
    });
  }

  let scheduler: TreeScheduler | undefined;

  if (!options.noTick && options.tickInterval) {
    const tickTree = factory(runContext).tree;
    createFormatter(tickTree.events, { json, verbose, quiet });
    server.bridgeTree(tickTree);
    scheduler = new TreeScheduler({
      tree: tickTree,
      schedule: { type: 'interval', delayMs: options.tickInterval },
      onError: 'continue',
    });
    scheduler.start();
  }

  await new Promise<void>((resolve) => {
    const shutdown = async () => {
      if (!quiet) {
        process.stderr.write('\nShutting down...\n');
      }
      if (scheduler) await scheduler.stop();
      if (dashHandle) await dashHandle.close();
      await server.stop();
      resolve();
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  });
}
```

- [ ] **Step 3: Run type check**

Run: `npx tsc --noEmit`
Expected: errors in `src/cli/index.ts` (still references `serveCommand` and old `noServe` flag) — that's expected, we fix it in Task 3.

- [ ] **Step 4: Commit**

```bash
git add src/cli/commands/run.ts
git commit -m "refactor(cli): rewrite run command with batch + daemon modes"
```

---

### Task 3: Update CLI entry point — remove serve command, forward new flags

**Files:**
- Modify: `src/cli/index.ts`

- [ ] **Step 1: Remove serve import and case, forward new flags to runCommand**

Replace the entire file:

```ts
#!/usr/bin/env node

import { runCommand } from './commands/run.js';
import { inspectCommand } from './commands/inspect.js';
import { initCommand } from './commands/init.js';
import { parseArgs, USAGE } from './parse-args.js';

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv);

  if (parsed.flags.help || !parsed.command) {
    process.stdout.write(USAGE);
    process.exit(parsed.flags.help ? 0 : 1);
  }

  switch (parsed.command) {
    case 'run': {
      if (!parsed.file) {
        process.stderr.write('Error: run requires a file argument\n\n');
        process.stdout.write(USAGE);
        process.exit(1);
      }
      await runCommand({
        file: parsed.file,
        args: parsed.positional,
        json: parsed.flags.json,
        verbose: parsed.flags.verbose,
        quiet: parsed.flags.quiet,
        envFile: parsed.flags.envFile,
        serve: parsed.flags.serve,
        port: parsed.flags.port,
        noDashboard: parsed.flags.noDashboard,
        dashboardPort: parsed.flags.dashboardPort,
        noTick: parsed.flags.noTick,
        tickInterval: parsed.flags.tickInterval,
      });
      break;
    }

    case 'inspect': {
      if (!parsed.file) {
        process.stderr.write('Error: inspect requires a file argument\n\n');
        process.stdout.write(USAGE);
        process.exit(1);
      }
      await inspectCommand(parsed.file);
      break;
    }

    case 'init': {
      if (!parsed.file) {
        process.stderr.write('Error: init requires a name argument\n\n');
        process.stdout.write(USAGE);
        process.exit(1);
      }
      initCommand(parsed.file);
      break;
    }

    default:
      process.stderr.write(`Unknown command: ${parsed.command}\n\n`);
      process.stdout.write(USAGE);
      process.exit(1);
  }
}

main().catch((err) => {
  process.stderr.write(`Fatal: ${(err as Error).message}\n`);
  process.exit(1);
});
```

- [ ] **Step 2: Run type check**

Run: `npx tsc --noEmit`
Expected: PASS (no type errors)

- [ ] **Step 3: Run all unit tests**

Run: `npm run test`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/cli/index.ts
git commit -m "refactor(cli): remove serve command from entry point, forward new flags"
```

---

### Task 4: Delete serve command and clean up exports

**Files:**
- Delete: `src/cli/commands/serve.ts`

- [ ] **Step 1: Delete serve.ts**

```bash
rm src/cli/commands/serve.ts
```

- [ ] **Step 2: Run type check and tests**

Run: `npx tsc --noEmit && npm run test`
Expected: PASS — nothing should import serve.ts anymore after Task 3.

- [ ] **Step 3: Commit**

```bash
git add -u src/cli/commands/serve.ts
git commit -m "refactor(cli): delete serve command (consolidated into run --serve)"
```

---

### Task 5: Run full test suite and verify

- [ ] **Step 1: Run all unit tests**

Run: `npm run test`
Expected: All tests pass.

- [ ] **Step 2: Run integration tests**

Run: `npm run test:integration`
Expected: All tests pass. The integration tests for TreeServer (`sse-stream.test.ts`, `rest-api.test.ts`) and ActorServer (`actor-dashboard.test.ts`) should be unaffected since they test the server classes directly, not the CLI.

- [ ] **Step 3: Type check**

Run: `npx tsc --noEmit`
Expected: PASS

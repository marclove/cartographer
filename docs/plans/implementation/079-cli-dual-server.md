# Task 79: CLI Dual Server Integration

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Update the CLI to start both the TreeServer and Dashboard server on separate ports, with `--no-dashboard` and `--dashboard-port` flags.

**Depends on:** Task 77, Task 78

---

### Step 1: Add new flags to parse-args.ts

Edit `src/cli/parse-args.ts`:

Add two new fields to the `flags` object in `ParsedArgs`:

```ts
    noDashboard: boolean;
    dashboardPort?: number;
```

Initialize them in the `flags` const inside `parseArgs`:

```ts
    noDashboard: false,
    dashboardPort: undefined as number | undefined,
```

Add parsing for the new flags in the `while` loop, after the `--no-serve` case:

```ts
    } else if (arg === '--no-dashboard') {
      flags.noDashboard = true;
    } else if (arg === '--dashboard-port') {
      i++;
      const parsed = parseInt(args[i], 10);
      if (isNaN(parsed) || parsed < 1 || parsed > 65535) {
        process.stderr.write(`Error: --dashboard-port requires a valid port number\n\n`);
        process.stdout.write(USAGE);
        process.exit(1);
      }
      flags.dashboardPort = parsed;
```

Update the `USAGE` string:

```ts
export const USAGE = `Usage: cartographer <command> [options]

Commands:
  run <file> [args...]     Execute a behavior tree
  inspect <file>           Visualize tree structure
  init <name>              Scaffold a new tree file

Run options:
  --json                   Output events as JSON lines (NDJSON)
  --verbose                Include agent:thinking and agent:tool_use events
  --quiet                  Suppress all output except errors and final status
  --env-file <path>        Load environment variables from a file
  --port <number>          Port for the tree server (default: 3147)
  --no-serve               Disable the tree server
  --dashboard-port <num>   Port for the dashboard server (default: 3148)
  --no-dashboard           Disable the dashboard server
`;
```

### Step 2: Add tests for new flags

Edit `src/cli/index.test.ts` (or `src/cli/parse-args.test.ts` if it exists) — add tests for the new flags. Find the existing parse-args tests and add:

```ts
  it('parses --no-dashboard flag', () => {
    const result = parseArgs(['node', 'cli', 'run', 'tree.ts', '--no-dashboard']);
    expect(result.flags.noDashboard).toBe(true);
  });

  it('noDashboard defaults to false', () => {
    const result = parseArgs(['node', 'cli', 'run', 'tree.ts']);
    expect(result.flags.noDashboard).toBe(false);
  });

  it('parses --dashboard-port flag', () => {
    const result = parseArgs(['node', 'cli', 'run', 'tree.ts', '--dashboard-port', '4000']);
    expect(result.flags.dashboardPort).toBe(4000);
  });
```

### Step 3: Run CLI tests

Run: `npx vitest run src/cli/`
Expected: New tests fail (flags not recognized yet), existing tests pass.

### Step 4: Update run.ts to start both servers

Edit `src/cli/commands/run.ts`:

Update the `RunOptions` interface to include the new flags:

```ts
export interface RunOptions {
  file: string;
  args: string[];
  json?: boolean;
  verbose?: boolean;
  quiet?: boolean;
  envFile?: string;
  port?: number;
  noServe?: boolean;
  noDashboard?: boolean;
  dashboardPort?: number;
}
```

Update the destructuring at the top of `runCommand`:

```ts
  const { file, args, json, verbose, quiet, envFile, port, noServe, noDashboard, dashboardPort } = options;
```

Replace the server startup section (the `// Start tree server` block) with:

```ts
  // Start tree server
  let treeServer: TreeServer | undefined;
  if (!noServe) {
    treeServer = new TreeServer(tree, { port });
    const { port: serverPort } = await treeServer.start();
    if (!quiet) {
      process.stderr.write(`API: http://localhost:${serverPort}\n`);
    }

    // Start dashboard server (unless disabled or tree server is disabled)
    if (!noDashboard) {
      try {
        const dashboardServerPath = new URL('../../dashboard-server/server.js', import.meta.url);
        const { DashboardServer } = await import(dashboardServerPath.href);
        const staticDir = new URL('../../dashboard/', import.meta.url);
        const dashServer = new DashboardServer({
          port: dashboardPort,
          staticDir: fileURLToPath(staticDir),
          apiUrl: `http://localhost:${serverPort}`,
        });
        const { port: dashPort } = await dashServer.start();
        if (!quiet) {
          process.stderr.write(`Dashboard: http://localhost:${dashPort}\n`);
        }
        // Clean up dashboard server on exit
        const origExit = exit;
        exit = async (code: number) => {
          await dashServer.close();
          await origExit(code);
        };
      } catch {
        // Dashboard not built — skip silently
        if (!quiet) {
          process.stderr.write('Dashboard: not available (run npm run build first)\n');
        }
      }
    }
  }
```

Add the `fileURLToPath` import at the top of the file:

```ts
import { fileURLToPath } from 'node:url';
```

Make the `exit` function reassignable by changing `async function exit` to `let exit = async function`:

```ts
  let exit = async (code: number): Promise<void> => {
    if (treeServer) await treeServer.close();
    stopFormatter();
    process.exit(code);
  };
```

### Step 5: Update the CLI entry point to pass new flags

Edit `src/cli/index.ts` — check how `parsed.flags` is passed to `runCommand` and ensure the new `noDashboard` and `dashboardPort` flags are included:

Find where `runCommand` is called and ensure it passes the new flags:

```ts
      await runCommand({
        file: parsed.file,
        args: parsed.positional,
        json: parsed.flags.json,
        verbose: parsed.flags.verbose,
        quiet: parsed.flags.quiet,
        envFile: parsed.flags.envFile,
        port: parsed.flags.port,
        noServe: parsed.flags.noServe,
        noDashboard: parsed.flags.noDashboard,
        dashboardPort: parsed.flags.dashboardPort,
      });
```

### Step 6: Typecheck

Run: `npm run typecheck`
Expected: All pass.

### Step 7: Run all tests

Run: `npm run test`
Expected: All pass — including the new parse-args tests.

Run: `npm run test:integration`
Expected: All pass.

### Step 8: Commit

```bash
git add src/cli/parse-args.ts src/cli/commands/run.ts src/cli/index.ts
git commit -m "feat(cli): start dashboard and tree servers independently with --no-dashboard and --dashboard-port flags"
```

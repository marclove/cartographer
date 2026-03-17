# Task 107: Create `serve` CLI Command

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a `cartographer serve <file>` command that starts ActorServer + DashboardServer, enabling message-driven tree execution with dashboard observation.

**Depends on:** Task 105 (ActorServer SSE broadcasting)

---

### Context

The `run` command executes trees directly (single-run or scheduled). The `serve` command starts an ActorServer that processes external messages against persisted state, with an optional dashboard for observation.

The serve command:
- Loads the user's tree module (same pattern as `run`)
- Creates ActorServer with `createTree: () => factory(ctx).tree`
- Starts DashboardServer pointing at ActorServer
- Stays alive until SIGINT/SIGTERM

### Files

- Create: `src/cli/commands/serve.ts`
- Modify: `src/cli/index.ts`
- Modify: `src/cli/parse-args.ts`

---

- [ ] **Step 1: Create serve command file**

Create `src/cli/commands/serve.ts`:

```ts
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { ActorServer } from '../../server/actor-server.js';
import type { RunContext, TreeRunConfig } from '../types.js';

export interface ServeOptions {
  file: string;
  args: string[];
  quiet?: boolean;
  envFile?: string;
  port?: number;
  noDashboard?: boolean;
  dashboardPort?: number;
  context?: Record<string, unknown>;
}

export async function serveCommand(options: ServeOptions): Promise<void> {
  const { file, args, quiet, envFile, port, noDashboard, dashboardPort, context } = options;

  // Load env file if provided
  const env: Record<string, string | undefined> = { ...process.env };
  if (envFile) {
    loadEnvFile(envFile, env);
  }

  const runContext: RunContext = { env, args };

  // Import user module
  const modulePath = resolve(file);
  if (modulePath.endsWith('.ts')) {
    try {
      const tsx = await import('tsx/esm/api');
      tsx.register();
    } catch {
      process.stderr.write(
        'Error: tsx is required to load .ts files. Install it with: npm i -D tsx\n',
      );
      process.exit(1);
    }
  }

  let factory: (ctx: RunContext) => TreeRunConfig;
  try {
    const mod = await import(modulePath);
    factory = mod.default;
    if (typeof factory !== 'function') {
      process.stderr.write(`Error: ${file} must export a default function\n`);
      process.exit(1);
    }
  } catch (err) {
    process.stderr.write(`Error loading ${file}: ${(err as Error).message}\n`);
    process.exit(1);
  }

  // Start ActorServer
  const server = new ActorServer({
    createTree: () => factory(runContext).tree,
    port: port ?? 3147,
    context,
  });

  const { port: serverPort } = await server.start();
  if (!quiet) {
    process.stderr.write(`Actor server: http://localhost:${serverPort}\n`);
  }

  // Start DashboardServer (unless disabled)
  let dashServer: any;
  if (!noDashboard) {
    try {
      const dashboardServerPath = new URL('../../dashboard-server/server.js', import.meta.url);
      const { DashboardServer } = await import(dashboardServerPath.href);
      const staticDir = new URL('../../dashboard/', import.meta.url);
      dashServer = new DashboardServer({
        port: dashboardPort,
        staticDir: fileURLToPath(staticDir),
        apiUrl: `http://localhost:${serverPort}`,
      });
      const { port: dashPort } = await dashServer.start();
      if (!quiet) {
        process.stderr.write(`Dashboard: http://localhost:${dashPort}\n`);
      }
    } catch {
      if (!quiet) {
        process.stderr.write('Dashboard: not available (run npm run build first)\n');
      }
    }
  }

  // Wait for shutdown signal
  await new Promise<void>((resolve) => {
    const shutdown = async () => {
      if (!quiet) {
        process.stderr.write('\nShutting down...\n');
      }
      if (dashServer) await dashServer.close();
      await server.stop();
      resolve();
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  });
}

function loadEnvFile(filePath: string, target: Record<string, string | undefined>): void {
  const content = readFileSync(resolve(filePath), 'utf-8');
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIndex = trimmed.indexOf('=');
    if (eqIndex === -1) continue;
    const key = trimmed.slice(0, eqIndex).trim();
    let value = trimmed.slice(eqIndex + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    target[key] = value;
  }
}
```

Note: `loadEnvFile` is duplicated from `run.ts`. Consider extracting to a shared utility if desired, but YAGNI for now.

- [ ] **Step 2: Wire serve command in CLI index**

Edit `src/cli/index.ts`:

1. Add import:
```ts
import { serveCommand } from './commands/serve.js';
```

2. Add case to switch (after the `run` case):
```ts
case 'serve': {
  if (!parsed.file) {
    process.stderr.write('Error: serve requires a file argument\n\n');
    process.stdout.write(USAGE);
    process.exit(1);
  }
  await serveCommand({
    file: parsed.file,
    args: parsed.positional,
    quiet: parsed.flags.quiet,
    envFile: parsed.flags.envFile,
    port: parsed.flags.port,
    noDashboard: parsed.flags.noDashboard,
    dashboardPort: parsed.flags.dashboardPort,
  });
  break;
}
```

- [ ] **Step 3: Update USAGE string and add serve to parseArgs**

Edit `src/cli/parse-args.ts`:

Update USAGE (around line 93):
```ts
export const USAGE = `Usage: cartographer <command> [options]

Commands:
  run <file> [args...]     Execute a behavior tree
  serve <file> [args...]   Start actor server with dashboard
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

Serve options:
  --quiet                  Suppress all output except errors
  --env-file <path>        Load environment variables from a file
  --port <number>          Port for the actor server (default: 3147)
  --dashboard-port <num>   Port for the dashboard server (default: 3148)
  --no-dashboard           Disable the dashboard server
`;
```

- [ ] **Step 4: Test parseArgs recognizes serve command**

Add to `src/cli/index.test.ts` (or create serve-specific test):

```ts
it('parseArgs recognizes serve command', () => {
  const result = parseArgs(['node', 'cli', 'serve', 'my-tree.ts']);
  expect(result.command).toBe('serve');
  expect(result.file).toBe('my-tree.ts');
});
```

- [ ] **Step 5: Run tests**

Run: `npx vitest run src/cli/`
Expected: All CLI tests pass

- [ ] **Step 6: Verify build compiles**

Run: `npm run build`
Expected: Clean compilation

- [ ] **Step 7: Commit**

```bash
git add src/cli/commands/serve.ts src/cli/index.ts src/cli/parse-args.ts src/cli/index.test.ts
git commit -m "feat(cli): add serve command for ActorServer + Dashboard"
```

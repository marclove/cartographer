import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { NodeStatus } from '../../types.js';
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
  noTick?: boolean;
  tickInterval?: number;
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

  // Tick loop — continuously tick the tree unless --no-tick
  let stopping = false;

  if (!options.noTick) {
    const intervalMs = options.tickInterval ?? 1000;
    (async () => {
      while (!stopping) {
        const result = await server.processMessage({ type: 'tick' });
        if (result && !stopping) {
          // Terminal status — reset tree for next cycle
          if (result.treeStatus === NodeStatus.SUCCESS || result.treeStatus === NodeStatus.FAILURE) {
            await server.processMessage({ type: 'signal', signal: 'reset' });
          }
        }
        if (!stopping) {
          await new Promise((r) => setTimeout(r, intervalMs));
        }
      }
    })();
  }

  // Wait for shutdown signal
  await new Promise<void>((resolve) => {
    const shutdown = async () => {
      stopping = true;
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
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    target[key] = value;
  }
}

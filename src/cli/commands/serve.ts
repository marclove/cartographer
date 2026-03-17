import { TreeScheduler } from '../../scheduler/tree-scheduler.js';
import { ActorServer } from '../../server/actor-server.js';
import { loadEnvFile, loadTreeModule, startDashboard } from './shared.js';

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

  const runContext = { env, args };

  const factory = await loadTreeModule(file);

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
  let dashHandle: Awaited<ReturnType<typeof startDashboard>> = null;
  if (!noDashboard) {
    dashHandle = await startDashboard({
      apiPort: serverPort,
      dashboardPort,
      importMetaUrl: import.meta.url,
      quiet,
    });
  }

  // Tick loop — use TreeScheduler to tick the tree naturally (one tick per
  // interval, letting the tree progress across ticks like the `run` command).
  // The ActorServer still accepts external messages alongside the scheduler.
  let scheduler: TreeScheduler | undefined;

  if (!options.noTick) {
    const intervalMs = options.tickInterval ?? 1000;
    const tickTree = factory(runContext).tree;
    // Bridge tree events to ActorServer's SSE pipeline so the dashboard
    // sees ticks, node enter/exit, blackboard writes, etc.
    server.bridgeTree(tickTree);
    scheduler = new TreeScheduler({
      tree: tickTree,
      schedule: { type: 'interval', delayMs: intervalMs },
      onError: 'continue',
    });
    scheduler.start();
  }

  // Wait for shutdown signal
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

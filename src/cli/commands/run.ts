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
  const { file, args, envFile } = options;

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

import { NodeStatus } from '../../types.js';
import { TreeScheduler } from '../../scheduler/tree-scheduler.js';
import { createFormatter } from '../formatter.js';
import { TreeServer } from '../../server/tree-server.js';
import { loadEnvFile, loadTreeModule, startDashboard } from './shared.js';

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

export async function runCommand(options: RunOptions): Promise<void> {
  const { file, args, json, verbose, quiet, envFile, port, noServe, noDashboard, dashboardPort } = options;

  // Load env file if provided
  const env = { ...process.env };
  if (envFile) {
    loadEnvFile(envFile, env);
  }

  // Build RunContext
  const runContext = { env, args };

  const factory = await loadTreeModule(file);

  // Call factory
  let config;
  try {
    config = factory(runContext);
  } catch (err) {
    process.stderr.write(`Error in tree factory: ${(err as Error).message}\n`);
    process.exit(1);
  }

  const { tree } = config;

  // Set up formatter
  const stopFormatter = createFormatter(tree.events, { json, verbose, quiet });

  // Start tree server
  let treeServer: TreeServer | undefined;

  let exit = async (code: number): Promise<void> => {
    if (treeServer) await treeServer.close();
    stopFormatter();
    process.exit(code);
  };

  if (!noServe) {
    treeServer = new TreeServer(tree, { port });
    const { port: serverPort } = await treeServer.start();
    if (!quiet) {
      process.stderr.write(`API: http://localhost:${serverPort}\n`);
    }

    // Start dashboard server (unless disabled or tree server is disabled)
    if (!noDashboard) {
      const dashHandle = await startDashboard({
        apiPort: serverPort,
        dashboardPort,
        importMetaUrl: import.meta.url,
        quiet,
      });
      if (dashHandle) {
        const origExit = exit;
        exit = async (code: number) => {
          await dashHandle.close();
          await origExit(code);
        };
      }
    }
  }

  // Track final status for exit code
  let finalStatus: NodeStatus | undefined;

  // Signal handling
  let aborted = false;
  const handleSignal = () => {
    if (aborted) return; // second signal → force exit
    aborted = true;
    tree.abort();
  };
  process.on('SIGINT', handleSignal);
  process.on('SIGTERM', handleSignal);

  try {
    if (config.schedule) {
      // Scheduled execution
      const scheduler = new TreeScheduler({
        tree,
        schedule: config.schedule,
        maxCycles: config.maxCycles,
        stopOnStatus: config.stopOnStatus,
        onError: config.onError,
      });

      // Track the last status from scheduler events
      scheduler.events.on('tick:complete', ({ status }) => {
        finalStatus = status;
      });

      // Abort also stops the scheduler
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
      // Single run
      const result = await tree.run();
      finalStatus = result.status;
    }
  } catch (err) {
    process.stderr.write(`Runtime error: ${(err as Error).message}\n`);
    await exit(1);
  }

  // Exit code based on final status
  if (aborted && finalStatus === undefined) {
    await exit(2);
  }
  if (finalStatus === NodeStatus.SUCCESS) {
    await exit(0);
  }
  if (finalStatus === NodeStatus.RUNNING) {
    await exit(2);
  }
  await exit(1);
}

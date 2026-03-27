import { ActorServer } from '../../server/actor-server.js';
import { createFormatter } from '../formatter.js';
import { TreeRunConfig } from '../types.js';
import { loadEnvFile, loadTreeModule, startDashboard } from './shared.js';

export interface RunOptions {
  file: string;
  args: string[];
  json?: boolean;
  verbose?: boolean;
  quiet?: boolean;
  envFile?: string;
  port?: number;
  noDashboard?: boolean;
  dashboardPort?: number;
}

export async function runCommand(options: RunOptions): Promise<void> {
  const { file, args, envFile } = options;

  const env: Record<string, string | undefined> = { ...process.env };
  if (envFile) {
    loadEnvFile(envFile, env);
  }

  const runContext = { env, args };
  const factory = await loadTreeModule(file);

  let config: TreeRunConfig;
  try {
    config = factory(runContext);
  } catch (err) {
    process.stderr.write(`Error in tree factory: ${(err as Error).message}\n`);
    process.exit(1);
  }

  const { json, verbose, quiet, port, noDashboard, dashboardPort } = options;

  const server = new ActorServer({
    sessionId: config.sessionId,
    createTree: () => {
      const tree = factory(runContext).tree;
      createFormatter(tree.events, { json, verbose, quiet });
      return tree;
    },
    port: port ?? 3147,
    autoTick: config.autoTick,
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
      quiet,
    });
  }

  await new Promise<void>((resolve) => {
    const shutdown = async () => {
      if (!quiet) {
        process.stderr.write('\nShutting down...\n');
      }
      if (dashHandle) await dashHandle.close();
      await server.stop();
      resolve();
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  });
}

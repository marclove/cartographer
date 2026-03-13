import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { NodeStatus } from '../../types.js';
import { TreeScheduler } from '../../scheduler/tree-scheduler.js';
import { createFormatter } from '../formatter.js';
import { DashboardServer } from '../../server/dashboard-server.js';
import type { RunContext, TreeRunConfig } from '../types.js';

export interface RunOptions {
  file: string;
  args: string[];
  json?: boolean;
  verbose?: boolean;
  quiet?: boolean;
  envFile?: string;
  port?: number;
  noServe?: boolean;
}

export async function runCommand(options: RunOptions): Promise<void> {
  const { file, args, json, verbose, quiet, envFile, port, noServe } = options;

  // Load env file if provided
  const env = { ...process.env };
  if (envFile) {
    loadEnvFile(envFile, env);
  }

  // Build RunContext
  const runContext: RunContext = { env, args };

  // Import user module — register tsx loader for TypeScript files
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

  // Call factory
  let config: TreeRunConfig;
  try {
    config = factory(runContext);
  } catch (err) {
    process.stderr.write(`Error in tree factory: ${(err as Error).message}\n`);
    process.exit(1);
  }

  const { tree } = config;

  // Set up formatter
  const stopFormatter = createFormatter(tree.events, { json, verbose, quiet });

  // Start dashboard server
  let dashboardServer: DashboardServer | undefined;
  if (!noServe) {
    dashboardServer = new DashboardServer(tree, { port });
    const { port: dashPort } = await dashboardServer.start();
    if (!quiet) {
      process.stderr.write(`Dashboard: http://localhost:${dashPort}\n`);
    }
  }

  async function exit(code: number): Promise<void> {
    if (dashboardServer) await dashboardServer.close();
    stopFormatter();
    process.exit(code);
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
        maxRuns: config.maxRuns,
        stopOnStatus: config.stopOnStatus,
        resetBetweenTicks: config.resetBetweenTicks,
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

/**
 * Parse a simple KEY=VALUE env file (lines starting with # are comments,
 * blank lines are skipped, values can be optionally quoted).
 */
function loadEnvFile(filePath: string, target: Record<string, string | undefined>): void {
  const content = readFileSync(resolve(filePath), 'utf-8');
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIndex = trimmed.indexOf('=');
    if (eqIndex === -1) continue;
    const key = trimmed.slice(0, eqIndex).trim();
    let value = trimmed.slice(eqIndex + 1).trim();
    // Strip surrounding quotes
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    target[key] = value;
  }
}

import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import type { RunContext, TreeRunConfig } from '../types.js';

/**
 * Parse a simple KEY=VALUE env file (lines starting with # are comments,
 * blank lines are skipped, values can be optionally quoted).
 */
export function loadEnvFile(filePath: string, target: Record<string, string | undefined>): void {
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

/**
 * Dynamically import a tree factory module, registering the tsx loader for .ts files.
 * Returns the default export which must be a function (ctx: RunContext) => TreeRunConfig.
 */
export async function loadTreeModule(file: string): Promise<(ctx: RunContext) => TreeRunConfig> {
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

  try {
    const mod = await import(modulePath);
    const factory = mod.default;
    if (typeof factory !== 'function') {
      process.stderr.write(`Error: ${file} must export a default function\n`);
      process.exit(1);
    }
    return factory;
  } catch (err) {
    process.stderr.write(`Error loading ${file}: ${(err as Error).message}\n`);
    process.exit(1);
  }
}

export interface DashboardHandle {
  port: number;
  close: () => Promise<void>;
}

/**
 * Start the dashboard server, returning a handle for cleanup.
 * Returns null if the dashboard build is not available.
 */
export async function startDashboard(options: {
  apiPort: number;
  dashboardPort?: number;
  quiet?: boolean;
}): Promise<DashboardHandle | null> {
  try {
    // Variable specifiers prevent TypeScript from resolving these optional
    // imports at compile time. The dashboard is a separate app that may or
    // may not be built; the catch block handles its absence at runtime.
    const serverPkg = '@cartographer/dashboard/server';
    const staticDirPkg = '@cartographer/dashboard/static-dir';
    const { DashboardServer } = await import(serverPkg);
    const { staticDir } = await import(staticDirPkg);
    const server = new DashboardServer({
      port: options.dashboardPort,
      staticDir,
      apiUrl: `http://localhost:${options.apiPort}`,
    });
    const { port } = await server.start();
    if (!options.quiet) {
      process.stderr.write(`Dashboard: http://localhost:${port}\n`);
    }
    return { port, close: () => server.close() };
  } catch {
    if (!options.quiet) {
      process.stderr.write('Dashboard: not available (run pnpm build first)\n');
    }
    return null;
  }
}

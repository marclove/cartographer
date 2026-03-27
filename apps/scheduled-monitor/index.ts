import type { RunContext, TreeRunConfig } from 'cartographer';
import { buildHealthMonitor } from './tree.js';

export default function (ctx: RunContext): TreeRunConfig {
  const baseUrl = ctx.env['HEALTH_URL'];
  if (!baseUrl) {
    throw new Error(
      'HEALTH_URL is required. Start the test server first:\n' +
      '  npx tsx apps/scheduled-monitor/serve.ts\n' +
      'Then pass the URL via env, e.g.:\n' +
      '  cartographer run apps/scheduled-monitor/index.ts --env-file .env',
    );
  }

  const tree = buildHealthMonitor(baseUrl);

  return {
    tree,
    sessionId: 'health-monitor',
  };
}

import type { RunContext, TreeRunConfig } from '../../packages/cartographer/src/index.js';
import { buildHealthMonitor } from './tree.js';

export default function (ctx: RunContext): TreeRunConfig {
  const baseUrl = ctx.env['HEALTH_URL'];
  if (!baseUrl) {
    throw new Error(
      'HEALTH_URL is required. Start the test server first:\n' +
      '  npx tsx examples/scheduled-monitor/serve.ts\n' +
      'Then pass the URL via env, e.g.:\n' +
      '  cartographer run examples/scheduled-monitor/index.ts --env-file .env',
    );
  }

  const tree = buildHealthMonitor(baseUrl);

  return {
    tree,
    schedule: { type: 'interval', delayMs: 1_000 },
    maxCycles: 5,
    onError: 'continue',
  };
}

import { ActorServer } from 'cartographer';
import { buildHealthMonitor } from './tree.js';

const baseUrl = process.env.HEALTH_URL;
if (!baseUrl) {
  console.error(
    'HEALTH_URL is required. Start the test server first:\n' +
      '  npx tsx apps/scheduled-monitor/serve.ts\n' +
      'Then: HEALTH_URL=http://localhost:<port> npx tsx apps/scheduled-monitor/index.ts',
  );
  process.exit(1);
}

const server = new ActorServer({
  createTree: () => buildHealthMonitor(baseUrl),
  sessionId: 'health-monitor',
});

const { port } = await server.start();
console.log(`Scheduled monitor listening on http://localhost:${port}`);

process.on('SIGINT', async () => {
  await server.stop();
  process.exit(0);
});

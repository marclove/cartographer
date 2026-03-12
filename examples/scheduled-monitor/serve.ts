import { createTestServer } from './server.js';

const server = await createTestServer();
console.log(`HEALTH_URL=http://localhost:${server.port}`);
console.log('Press Ctrl-C to stop');

process.on('SIGINT', async () => {
  await server.close();
  process.exit(0);
});

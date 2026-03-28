import { ActorServer } from 'cartographer';
import { buildContentPipeline } from './tree.js';

const server = new ActorServer({
  createTree: () => buildContentPipeline(),
  sessionId: 'content-pipeline',
});

const { port } = await server.start();
console.log(`Content pipeline listening on http://localhost:${port}`);

process.on('SIGINT', async () => {
  await server.stop();
  process.exit(0);
});

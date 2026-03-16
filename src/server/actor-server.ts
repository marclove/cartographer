import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse, Server } from 'node:http';
import type { BehaviorTree } from '../core/behavior-tree.js';
import { serializeTree } from '../core/serialization.js';
import { InMemoryStateStore } from '../state/in-memory-state-store.js';
import type { StateStore } from '../state/state-store.js';
import { jsonResponse, jsonError } from './http-utils.js';

export interface ActorServerOptions {
  createTree: () => BehaviorTree;
  stateStore?: StateStore;
  port?: number;
  context?: Record<string, unknown>;
  topologyPolicy?: 'fail' | 'reset';
}

export class ActorServer {
  private readonly createTree: () => BehaviorTree;
  readonly stateStore: StateStore;
  private readonly configPort: number;
  private readonly context: Record<string, unknown>;
  readonly topologyPolicy: 'fail' | 'reset';
  private server: Server | null = null;
  private startTime = 0;

  constructor(options: ActorServerOptions) {
    this.createTree = options.createTree;
    this.stateStore = options.stateStore ?? new InMemoryStateStore();
    this.configPort = options.port ?? parseInt(process.env.PORT ?? '3148', 10);
    this.context = options.context ?? {};
    this.topologyPolicy = options.topologyPolicy ?? 'fail';
  }

  async start(): Promise<{ port: number }> {
    this.startTime = Date.now();

    const existing = await this.stateStore.getState('default');
    if (!existing) {
      await this.initializeDefaultState();
    }

    this.server = createServer((req, res) => {
      this.handleRequest(req, res).catch((err) => {
        if (!res.headersSent) {
          jsonError(res, 500, err instanceof Error ? err.message : 'Internal error');
        }
      });
    });

    return new Promise((resolve) => {
      this.server!.listen(this.configPort, () => {
        const addr = this.server!.address();
        const actualPort = typeof addr === 'object' && addr ? addr.port : this.configPort;
        resolve({ port: actualPort });
      });
    });
  }

  async stop(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.server) return resolve();
      this.server.close(() => resolve());
    });
  }

  private async initializeDefaultState(): Promise<void> {
    const tree = this.createTree();
    for (const [key, value] of Object.entries(this.context)) {
      tree.blackboard.set(`context:${key}`, value);
    }
    const blackboard = this.serializeBlackboard(tree);
    const treeState = serializeTree(tree.root, tree.rootHash);
    await this.stateStore.saveState('default', {
      blackboard,
      treeState,
      createdAt: Date.now(),
      lastMessageAt: Date.now(),
    });
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
    const method = req.method ?? 'GET';

    // Platform health
    if (method === 'GET' && url.pathname === '/_platform/health') {
      return jsonResponse(res, 200, {
        status: 'ok',
        uptime: Math.floor((Date.now() - this.startTime) / 1000),
      });
    }

    // Read endpoints
    if (method === 'GET' && url.pathname === '/api/blackboard') {
      const state = await this.stateStore.getState('default');
      return jsonResponse(res, 200, state?.blackboard ?? {});
    }

    if (method === 'GET' && url.pathname === '/api/status') {
      const state = await this.stateStore.getState('default');
      return jsonResponse(res, 200, {
        lastMessageAt: state?.lastMessageAt ?? null,
        treeRootHash: state?.treeState.rootHash ?? null,
      });
    }

    if (method === 'GET' && url.pathname === '/api/tree') {
      const tree = this.createTree();
      return jsonResponse(res, 200, { name: tree.name, rootHash: tree.rootHash });
    }

    jsonError(res, 404, 'Not found');
  }

  private serializeBlackboard(tree: BehaviorTree): Record<string, unknown> {
    if ('toRecord' in tree.blackboard && typeof tree.blackboard.toRecord === 'function') {
      return tree.blackboard.toRecord();
    }
    const result: Record<string, unknown> = {};
    for (const key of tree.blackboard.keys()) {
      result[key] = tree.blackboard.get(key);
    }
    return result;
  }
}

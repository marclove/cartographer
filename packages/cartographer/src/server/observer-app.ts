import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { SSEStreamingApi } from 'hono/streaming';
import type { BehaviorTree } from '../core/behavior-tree.js';
import { NodeStatus } from '../types.js';
import type { TreeEvents } from '../types.js';
import { InProcessEventStream } from './event-stream.js';
import { serializeTree, serializeNodeRef, serializeEvent } from './serializers.js';
import { blackboardToRecord } from './blackboard-utils.js';
import { AgentNode } from '../nodes/agent.js';
import type { BTreeNode } from '../types.js';

export interface ObserverAppOptions {
  tree: BehaviorTree;
  eventStreamCapacity?: number;
}

export interface ObserverHandle {
  app: Hono;
  close: () => void;
}

function findNodeById(root: BTreeNode, id: string): BTreeNode | undefined {
  const stack: BTreeNode[] = [root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (node.id === id) return node;
    for (const child of node.children) stack.push(child);
  }
  return undefined;
}

export function createObserverApp(options: ObserverAppOptions): ObserverHandle {
  const tree = options.tree;
  const eventStream = new InProcessEventStream(options.eventStreamCapacity ?? 500);
  const stats = {
    tickCount: 0,
    cycleCount: 0,
    lastStatus: null as string | null,
    lastDurationMs: null as number | null,
    startedAt: Date.now(),
  };
  const sseClients = new Set<SSEStreamingApi>();
  const unsubscribers: Array<() => void> = [];

  // Subscribe to tree events
  const onTick = (data: TreeEvents['tree:tick']) => {
    stats.tickCount++;
    stats.lastStatus = data.status;
    if (data.status !== NodeStatus.RUNNING) {
      stats.cycleCount++;
    }
    stats.lastDurationMs = data.durationMs;
  };
  tree.events.on('tree:tick', onTick);
  unsubscribers.push(() => tree.events.off('tree:tick', onTick));

  const onAnyEvent = (event: string, data: unknown) => {
    const serialized = serializeEvent(event as any, data);
    eventStream.push(event, serialized);
  };
  tree.events.onAny(onAnyEvent);
  unsubscribers.push(() => tree.events.offAny(onAnyEvent));

  const app = new Hono();

  app.onError((err, c) => {
    return c.json({ error: err.message, status: 500 }, 500);
  });

  app.get('/api/tree', (c) => {
    return c.json({ tree: tree.name, root: serializeTree(tree.root) });
  });

  app.get('/api/status', (c) => {
    return c.json({
      tree: tree.name,
      tickCount: stats.tickCount,
      cycleCount: stats.cycleCount,
      lastStatus: stats.lastStatus,
      lastDurationMs: stats.lastDurationMs,
      uptime: Date.now() - stats.startedAt,
    });
  });

  app.get('/api/blackboard', (c) => {
    return c.json(blackboardToRecord(tree.blackboard));
  });

  app.get('/api/nodes/:id', (c) => {
    const nodeId = c.req.param('id');
    const node = findNodeById(tree.root, nodeId);
    if (!node) {
      return c.json({ error: 'Not found', status: 404 }, 404);
    }
    const base = serializeNodeRef(node);
    const detail: Record<string, unknown> = { ...base };
    if (node instanceof AgentNode) {
      const info = node.agentOptions;
      if (info.model) detail.model = info.model;
      detail.tools = info.tools ?? [];
      detail.mcpServers = (info.mcpServers as string[]) ?? [];
    }
    if (node.children.length > 0) {
      detail.children = node.children.map(serializeNodeRef);
    }
    return c.json(detail);
  });

  app.get('/events', async (c) => {
    const snapshot = {
      tree: serializeTree(tree.root),
      blackboard: blackboardToRecord(tree.blackboard),
    };

    return streamSSE(c, async (stream) => {
      await stream.writeSSE({
        event: 'snapshot',
        data: JSON.stringify(snapshot),
        id: eventStream.latestId,
      });

      // Replay only on reconnect (Last-Event-ID present)
      const lastId = c.req.header('Last-Event-ID');
      if (lastId) {
        const missed = eventStream.replaySince(lastId);
        if (missed === null) {
          await stream.writeSSE({
            event: 'snapshot',
            data: JSON.stringify(snapshot),
            id: eventStream.latestId,
          });
        } else {
          for (const entry of missed) {
            await stream.writeSSE({
              event: entry.event,
              data: JSON.stringify(entry.data),
              id: entry.id,
            });
          }
        }
      }

      let writePromise = Promise.resolve();
      const unsubscribe = eventStream.subscribe((entry) => {
        writePromise = writePromise
          .then(() =>
            stream.writeSSE({
              event: entry.event,
              data: JSON.stringify(entry.data),
              id: entry.id,
            }),
          )
          .catch(() => {});
      });

      stream.onAbort(() => {
        unsubscribe();
        sseClients.delete(stream);
      });
      sseClients.add(stream);

      await new Promise(() => {});
    });
  });

  function close(): void {
    for (const unsub of unsubscribers) unsub();
    unsubscribers.length = 0;
    for (const client of sseClients) client.close();
    sseClients.clear();
  }

  return { app, close };
}

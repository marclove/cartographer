import { InMemoryBlackboard } from '../core/blackboard.js';
import { EventEmitter } from '../core/event-emitter.js';
import { NodeStatus } from '../types.js';
import type { TreeContext, TreeEvents } from '../types.js';
import { BaseNode } from '../nodes/base.js';
import { ActorServer } from '../server/actor-server.js';
import type { ActorServerOptions } from '../server/actor-server.js';
import { createCartographerClient } from '@cartographer/client';
import type { CartographerClient } from '@cartographer/client';

export function createContext(initial?: Record<string, unknown>): TreeContext {
  return {
    blackboard: new InMemoryBlackboard(initial),
    events: new EventEmitter<TreeEvents>(),
  };
}

export function sequentialAction(name: string, statuses: NodeStatus[]) {
  let tick = 0;
  return {
    name,
    action: () => {
      const status = statuses[Math.min(tick, statuses.length - 1)];
      tick++;
      return status;
    },
  };
}

export function blackboardWriter(name: string, key: string, value: unknown) {
  return {
    name,
    action: (ctx: TreeContext) => {
      ctx.blackboard.set(key, value);
      return NodeStatus.SUCCESS;
    },
  };
}

export function slowAction(name: string, delayMs: number, status: NodeStatus) {
  return {
    name,
    action: () =>
      new Promise<NodeStatus>((resolve) => setTimeout(() => resolve(status), delayMs)),
  };
}

export function collectEvents<K extends keyof TreeEvents & string>(
  ctx: TreeContext,
  eventName: K,
): TreeEvents[K][] {
  const collected: TreeEvents[K][] = [];
  ctx.events.on(eventName, (data) => collected.push(data));
  return collected;
}

export class AbortTrackingNode extends BaseNode {
  aborted = false;
  private status: NodeStatus;

  constructor(name: string, status: NodeStatus = NodeStatus.RUNNING) {
    super(name);
    this.status = status;
  }

  protected async execute(_context: TreeContext): Promise<NodeStatus> {
    return this.status;
  }

  abort(): void {
    super.abort();
    this.aborted = true;
  }
}

export function countingAction(name: string, statuses: NodeStatus[]) {
  let ticks = 0;
  return {
    config: {
      name,
      action: () => {
        const status = statuses[Math.min(ticks, statuses.length - 1)];
        ticks++;
        return status;
      },
    },
    getTicks: () => ticks,
  };
}

/**
 * Wait for N SSE events of a given type. Register BEFORE triggering
 * the action that emits the events to avoid race conditions.
 */
export function waitForEvent(
  client: CartographerClient,
  eventName: string,
  count = 1,
  timeoutMs = 2000,
): Promise<unknown[]> {
  return new Promise((resolve, reject) => {
    const collected: unknown[] = [];
    const timeout = setTimeout(() => {
      client.off(eventName, handler);
      reject(new Error(`waitForEvent('${eventName}'): timed out after ${timeoutMs}ms (received ${collected.length}/${count})`));
    }, timeoutMs);

    const handler = (data: unknown) => {
      collected.push(data);
      if (collected.length >= count) {
        clearTimeout(timeout);
        client.off(eventName, handler);
        resolve(collected);
      }
    };
    client.on(eventName, handler);
  });
}

/**
 * Poll the blackboard until a key is set. Returns the value.
 * Use this instead of setTimeout when waiting for processing to complete.
 */
export async function waitForBlackboard(
  client: CartographerClient,
  key: string,
  timeoutMs = 5000,
  intervalMs = 100,
): Promise<unknown> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const bb = await client.blackboard();
    if (bb[key] !== undefined) return bb[key];
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`waitForBlackboard('${key}'): timed out after ${timeoutMs}ms`);
}

export interface TestHarness {
  server: ActorServer;
  client: CartographerClient;
  port: number;
  teardown(): Promise<void>;
  [Symbol.asyncDispose](): Promise<void>;
}

export type TestOptions = Omit<ActorServerOptions, 'port'>;

export async function setupTest(options: TestOptions): Promise<TestHarness> {
  const server = new ActorServer({ ...options, port: 0 });
  const { port } = await server.start();

  const client = createCartographerClient(`http://localhost:${port}`);

  if (typeof globalThis.EventSource === 'undefined') {
    throw new Error('setupTest requires EventSource (Node 22+ --experimental-eventsource or a polyfill)');
  }

  // Wait for the SSE snapshot event to confirm the connection is live.
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('setupTest: SSE snapshot not received within 2s')), 2000);
    const onSnapshot = () => {
      clearTimeout(timeout);
      client.off('snapshot', onSnapshot);
      resolve();
    };
    client.on('snapshot', onSnapshot);
    client.connect();
  });

  const teardown = async () => {
    client.disconnect();
    await server.stop();
  };

  return {
    server,
    client,
    port,
    teardown,
    [Symbol.asyncDispose]: teardown,
  };
}

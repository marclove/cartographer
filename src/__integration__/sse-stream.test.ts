import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DashboardServer } from '../server/dashboard-server.js';
import { BehaviorTree } from '../core/behavior-tree.js';
import { InMemoryBlackboard } from '../core/blackboard.js';
import { ActionNode } from '../nodes/action.js';
import { SequenceNode } from '../composites/sequence.js';
import { NodeStatus } from '../types.js';

interface SseEvent {
  id: string | null;
  event: string | null;
  data: unknown;
}

/**
 * Connect to the SSE endpoint and collect the first `count` events.
 * Resolves when enough events arrive or the stream ends.
 */
async function collectSSEEvents(
  url: string,
  count: number,
  headers: Record<string, string> = {},
  timeoutMs = 3000,
): Promise<SseEvent[]> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${count} SSE events`)), timeoutMs);

    const events: SseEvent[] = [];
    let currentId: string | null = null;
    let currentEvent: string | null = null;
    let currentData = '';

    const abortController = new AbortController();

    fetch(url, { headers, signal: abortController.signal })
      .then(async (res) => {
        if (!res.ok || !res.body) {
          clearTimeout(timer);
          reject(new Error(`SSE fetch failed: ${res.status}`));
          return;
        }
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let remainder = '';

        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            remainder += decoder.decode(value, { stream: true });
            const lines = remainder.split('\n');
            remainder = lines.pop()!; // keep incomplete trailing line for next chunk

            for (const line of lines) {
              if (line.startsWith('id:')) {
                currentId = line.slice(3).trim();
              } else if (line.startsWith('event:')) {
                currentEvent = line.slice(6).trim();
              } else if (line.startsWith('data:')) {
                currentData = line.slice(5).trim();
              } else if (line === '') {
                // Blank line — dispatch event if we have data
                if (currentData !== '') {
                  let parsed: unknown = currentData;
                  try {
                    parsed = JSON.parse(currentData);
                  } catch {
                    // leave as string
                  }
                  events.push({ id: currentId, event: currentEvent, data: parsed });
                  if (events.length >= count) {
                    clearTimeout(timer);
                    abortController.abort();
                    resolve(events);
                    return;
                  }
                }
                currentId = null;
                currentEvent = null;
                currentData = '';
              }
            }
          }
        } catch (err: unknown) {
          // AbortError is expected when we abort after collecting enough events
          if (err instanceof Error && err.name === 'AbortError') {
            resolve(events);
          } else {
            reject(err);
          }
        } finally {
          clearTimeout(timer);
          reader.releaseLock();
        }
      })
      .catch((err: unknown) => {
        clearTimeout(timer);
        if (err instanceof Error && err.name === 'AbortError') {
          resolve(events);
        } else {
          reject(err);
        }
      });
  });
}

function createTree() {
  const action = new ActionNode({
    name: 'DoWork',
    id: 'do-work',
    action: async (ctx) => {
      ctx.blackboard.set('counter', (ctx.blackboard.get('counter') as number ?? 0) + 1);
      return NodeStatus.SUCCESS;
    },
  });
  const root = new SequenceNode({ name: 'Root', id: 'root', children: [action] });
  const bb = new InMemoryBlackboard({ counter: 0 });
  return new BehaviorTree({ name: 'SSETree', root, blackboard: bb });
}

let server: DashboardServer;
let port: number;
let tree: BehaviorTree;

beforeEach(async () => {
  tree = createTree();
  server = new DashboardServer(tree, { port: 0 });
  ({ port } = await server.start());
});

afterEach(async () => {
  await server.close();
});

describe('GET /events — snapshot on connect', () => {
  it('sends a snapshot event immediately with tree and blackboard', async () => {
    const events = await collectSSEEvents(`http://localhost:${port}/events`, 1);

    expect(events).toHaveLength(1);
    const snap = events[0];
    expect(snap.event).toBe('snapshot');
    expect(snap.id).toBeDefined();

    const data = snap.data as { tree: { name: string; id: string; type: string }; blackboard: Record<string, unknown> };
    // snapshot.tree is the serialized ROOT node, not the BehaviorTree name
    expect(data.tree.name).toBe('Root');
    expect(data.tree.id).toBe('root');
    expect(data.tree.type).toBe('sequence');
    expect(data.blackboard).toEqual({ counter: 0 });
  });

  it('snapshot always has an id field', async () => {
    const events = await collectSSEEvents(`http://localhost:${port}/events`, 1);
    expect(events[0].id).not.toBeNull();
    expect(events[0].id).toBeDefined();
  });
});

describe('GET /events — live event streaming', () => {
  it('streams tree events to connected clients after a tick', async () => {
    // Start collecting enough events to capture the full tick lifecycle:
    // snapshot + node:enter(root) + node:enter(do-work) +
    // node:exit(do-work) + node:exit(root) + tree:tick = 6 events
    const eventsPromise = collectSSEEvents(`http://localhost:${port}/events`, 6);

    // Give the SSE connection a moment to establish, then tick
    await new Promise((r) => setTimeout(r, 50));
    await tree.tick();

    const events = await eventsPromise;
    // Should have snapshot + live events
    expect(events.length).toBeGreaterThanOrEqual(2);
    expect(events[0].event).toBe('snapshot');

    const eventNames = events.slice(1).map((e) => e.event);
    // After a tick we expect node:enter, node:exit, and tree:tick events
    expect(eventNames).toContain('node:enter');
    expect(eventNames).toContain('node:exit');
    expect(eventNames).toContain('tree:tick');
  });

  it('live events include a node:enter event for each entered node', async () => {
    // Collect enough events: snapshot + enter(root) + enter(do-work) + more = 4 minimum
    const eventsPromise = collectSSEEvents(`http://localhost:${port}/events`, 4);
    await new Promise((r) => setTimeout(r, 50));
    await tree.tick();
    const events = await eventsPromise;

    const enterEvents = events.filter((e) => e.event === 'node:enter');
    expect(enterEvents.length).toBeGreaterThanOrEqual(2); // root + action

    const ids = enterEvents.map((e) => (e.data as { node: { id: string } }).node.id);
    expect(ids).toContain('root');
    expect(ids).toContain('do-work');
  });
});

describe('GET /events — incrementing IDs', () => {
  it('live events have monotonically increasing IDs', async () => {
    const eventsPromise = collectSSEEvents(`http://localhost:${port}/events`, 6);
    await new Promise((r) => setTimeout(r, 50));
    await tree.tick();
    const events = await eventsPromise;

    // All events must have numeric IDs
    const ids = events.map((e) => Number(e.id));
    expect(ids.every((id) => !isNaN(id))).toBe(true);

    // IDs must be strictly increasing
    for (let i = 1; i < ids.length; i++) {
      expect(ids[i]).toBeGreaterThan(ids[i - 1]);
    }
  });
});

describe('GET /events — Last-Event-ID reconnection', () => {
  it('replays missed events when reconnecting with Last-Event-ID', async () => {
    // First: tick the tree so events are buffered
    await tree.tick();

    // Connect fresh (no Last-Event-ID) to get current snapshot id
    const initial = await collectSSEEvents(`http://localhost:${port}/events`, 1);
    const snapshotId = initial[0].id!;

    // Tick again to generate more buffered events
    await tree.tick();

    // Reconnect with Last-Event-ID set to the snapshot's id
    // We should receive the events from the second tick
    const reconnected = await collectSSEEvents(
      `http://localhost:${port}/events`,
      5,
      { 'Last-Event-ID': snapshotId },
    );

    // First event is still a fresh snapshot (always sent on connect)
    expect(reconnected[0].event).toBe('snapshot');

    // Additional replayed events come from what was buffered after snapshotId
    const replayed = reconnected.slice(1);
    expect(replayed.length).toBeGreaterThan(0);

    // Replayed event IDs should all be greater than snapshotId
    const replayedIds = replayed.map((e) => Number(e.id));
    const lastSeenId = Number(snapshotId);
    for (const id of replayedIds) {
      expect(id).toBeGreaterThan(lastSeenId);
    }
  });

  it('sends a fresh snapshot when Last-Event-ID is before the buffer window', async () => {
    // Close the default server and create one with a tiny buffer to force eviction
    await server.close();
    tree = createTree();
    server = new DashboardServer(tree, { port: 0, eventBufferCapacity: 2 });
    ({ port } = await server.start());

    // Tick multiple times to generate events that overflow the 2-event buffer
    await tree.tick();
    tree.reset();
    await tree.tick();
    tree.reset();
    await tree.tick();

    // Connect with Last-Event-ID = 1, which has been evicted from the tiny buffer.
    // getEventsSince(1) returns null → server sends a second snapshot instead of replays.
    const reconnected = await collectSSEEvents(
      `http://localhost:${port}/events`,
      2,
      { 'Last-Event-ID': '1' },
    );

    // First event is the initial snapshot (always sent)
    expect(reconnected[0].event).toBe('snapshot');
    // Second event should also be a snapshot (the buffer-gap re-snapshot),
    // not a replayed event like node:enter
    expect(reconnected[1].event).toBe('snapshot');
  });
});

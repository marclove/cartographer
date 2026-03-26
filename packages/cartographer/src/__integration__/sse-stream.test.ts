import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ActorServer } from '../server/actor-server.js';
import { InMemoryBlackboard } from '../core/blackboard.js';
import { BehaviorTree } from '../core/behavior-tree.js';
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

let server: ActorServer;
let port: number;

beforeEach(async () => {
  server = new ActorServer({
    createTree,
    port: 0,
  });
  ({ port } = await server.start());
});

afterEach(async () => {
  await server.stop();
});

describe('GET /events — snapshot on connect', () => {
  it('sends a snapshot event immediately with tree and blackboard', async () => {
    const events = await collectSSEEvents(`http://localhost:${port}/events`, 1);

    expect(events).toHaveLength(1);
    const snap = events[0];
    expect(snap.event).toBe('snapshot');
    expect(snap.id).toBeDefined();

    const data = snap.data as { tree: { name: string; id: string; type: string }; blackboard: Record<string, unknown> };
    // snapshot.tree is the serialized ROOT node
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
    const eventsPromise = collectSSEEvents(`http://localhost:${port}/events`, 8);

    // Give the SSE connection a moment to establish, then tick
    await new Promise((r) => setTimeout(r, 50));
    await server.processMessage({ type: 'tick' });

    const events = await eventsPromise;
    expect(events.length).toBeGreaterThanOrEqual(2);
    expect(events[0].event).toBe('snapshot');

    const eventNames = events.slice(1).map((e) => e.event);
    expect(eventNames).toContain('node:enter');
    expect(eventNames).toContain('node:exit');
    expect(eventNames).toContain('tree:tick');
  });

  it('live events include a node:enter event for each entered node', async () => {
    const eventsPromise = collectSSEEvents(`http://localhost:${port}/events`, 4);
    await new Promise((r) => setTimeout(r, 50));
    await server.processMessage({ type: 'tick' });
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
    await server.processMessage({ type: 'tick' });
    const events = await eventsPromise;

    const ids = events.map((e) => Number(e.id));
    expect(ids.every((id) => !isNaN(id))).toBe(true);

    for (let i = 1; i < ids.length; i++) {
      expect(ids[i]).toBeGreaterThan(ids[i - 1]);
    }
  });
});

describe('GET /events — Last-Event-ID reconnection', () => {
  it('replays missed events when reconnecting with Last-Event-ID', async () => {
    // Tick the tree so events are buffered
    await server.processMessage({ type: 'tick' });

    // Connect fresh to get current snapshot id
    const initial = await collectSSEEvents(`http://localhost:${port}/events`, 1);
    const snapshotId = initial[0].id!;

    // Tick again to generate more buffered events
    await server.processMessage({ type: 'tick' });

    // Reconnect with Last-Event-ID set to the snapshot's id
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
});

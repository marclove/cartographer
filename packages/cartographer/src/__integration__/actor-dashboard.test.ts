import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { ActorServer } from '../server/actor-server.js';
import { TreeBuilder } from '../builder/tree-builder.js';
import { NodeStatus } from '../types.js';

// ---------------------------------------------------------------------------
// SSE helper (same pattern as sse-stream.test.ts)
// ---------------------------------------------------------------------------

interface SseEvent {
  id: string | null;
  event: string | null;
  data: unknown;
}

async function collectSSEUntil(
  url: string,
  predicate: (events: SseEvent[]) => boolean,
  timeoutMs = 5000,
): Promise<SseEvent[]> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Timed out waiting for SSE condition after ${timeoutMs}ms`)),
      timeoutMs,
    );

    const events: SseEvent[] = [];
    let currentId: string | null = null;
    let currentEvent: string | null = null;
    let currentData = '';

    const abortController = new AbortController();

    fetch(url, {
      headers: { Accept: 'text/event-stream' },
      signal: abortController.signal,
    })
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
            remainder = lines.pop()!;

            for (const line of lines) {
              if (line.startsWith('id:')) {
                currentId = line.slice(3).trim();
              } else if (line.startsWith('event:')) {
                currentEvent = line.slice(6).trim();
              } else if (line.startsWith('data:')) {
                currentData = line.slice(5).trim();
              } else if (line === '') {
                if (currentData !== '') {
                  let parsed: unknown = currentData;
                  try {
                    parsed = JSON.parse(currentData);
                  } catch {
                    // leave as string
                  }
                  events.push({ id: currentId, event: currentEvent, data: parsed });
                  if (predicate(events)) {
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

// ---------------------------------------------------------------------------
// Tree factory
// ---------------------------------------------------------------------------

function makeTree() {
  return new TreeBuilder('integration-test')
    .sequence('main', (b) => {
      b.action('step-1', async (ctx) => {
        ctx.blackboard.set('result', 'done');
        return NodeStatus.SUCCESS;
      });
    })
    .build();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ActorServer dashboard integration', () => {
  let server: ActorServer;
  let port: number;

  beforeAll(async () => {
    server = new ActorServer({
      createTree: makeTree,
      port: 0,
    });
    ({ port } = await server.start());
  });

  afterAll(async () => {
    await server.stop();
  });

  it('GET /api/tree returns dashboard-compatible tree structure', async () => {
    const res = await fetch(`http://localhost:${port}/api/tree`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.tree).toBe('integration-test');
    expect(body.root).toMatchObject({
      id: expect.any(String),
      name: 'main',
      type: 'sequence',
      children: expect.arrayContaining([
        expect.objectContaining({ name: 'step-1', type: 'action' }),
      ]),
    });
  });

  it('GET /api/status returns tick stats shape', async () => {
    const res = await fetch(`http://localhost:${port}/api/status`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.tree).toBe('integration-test');
    expect(body).toHaveProperty('tickCount');
    expect(body).toHaveProperty('cycleCount');
    expect(body).toHaveProperty('uptime');
    expect(typeof body.tickCount).toBe('number');
  });

  it('GET /api/nodes/:id returns node detail', async () => {
    const treeRes = await fetch(`http://localhost:${port}/api/tree`);
    const { root } = await treeRes.json();
    const res = await fetch(`http://localhost:${port}/api/nodes/${root.id}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.id).toBe(root.id);
    expect(body.name).toBe('main');
  });

  it('SSE /events streams real-time events during message processing', async () => {
    // Start collecting SSE events; resolve when message:processed arrives
    const ssePromise = collectSSEUntil(
      `http://localhost:${port}/events`,
      (events) => events.some((e) => e.event === 'message:processed'),
    );

    // Give the SSE connection a moment to establish, then send a tick message
    await new Promise((r) => setTimeout(r, 50));

    await fetch(`http://localhost:${port}/api/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'tick' }),
    });

    const received = await ssePromise;

    // First event should be snapshot
    expect(received[0].event).toBe('snapshot');

    const snap = received[0].data as { tree: { children: unknown[] }; blackboard: Record<string, unknown> };
    expect(snap.tree).toHaveProperty('children');
    expect(snap).toHaveProperty('blackboard');

    // Verify tree lifecycle events arrived
    const types = received.map((e) => e.event);
    expect(types).toContain('node:enter');
    expect(types).toContain('node:exit');
    expect(types).toContain('tree:tick');
    expect(types).toContain('message:processed');
  });

  it('GET /api/blackboard reflects state after processing', async () => {
    const res = await fetch(`http://localhost:${port}/api/blackboard`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.result).toBe('done');
  });

  it('GET /api/status reflects updated tick count after processing', async () => {
    const res = await fetch(`http://localhost:${port}/api/status`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.tickCount).toBeGreaterThan(0);
  });
});

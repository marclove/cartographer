import { ConflictError, type CartographerClient } from './types.js';

export { ConflictError, type CartographerClient } from './types.js';

/**
 * Creates a client connected to an ActorServer at the given URL.
 *
 * The client uses `fetch` for HTTP calls and the browser `EventSource` API for
 * real-time SSE events. In Node.js, EventSource requires a polyfill or the
 * `--experimental-eventsource` flag (Node 22+).
 */
export function createCartographerClient(baseUrl: string): CartographerClient {
  let eventSource: any | null = null;
  const listeners = new Map<string, Set<(data: unknown) => void>>();
  const anyListeners = new Set<(event: string, data: unknown) => void>();

  /**
   * POST JSON to the server. Returns the message ID on success.
   * @throws {ConflictError} if the server is already processing a message (409)
   * @throws {Error} on validation errors (400) or shutdown (503)
   */
  async function post(path: string, body: unknown): Promise<{ id: string }> {
    const res = await fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (res.status === 409) throw new ConflictError();
    if (res.status === 400) {
      const err = await res.json() as { error?: string };
      throw new Error(err.error ?? 'Bad request');
    }
    if (res.status === 503) throw new Error('Server is shutting down');
    return res.json() as Promise<{ id: string }>;
  }

  /** GET JSON from the server. */
  async function get(path: string): Promise<unknown> {
    const res = await fetch(`${baseUrl}${path}`);
    return res.json();
  }

  /**
   * Route an SSE event to registered listeners. For `client:event` types,
   * also dispatches to handlers registered under the event's `name` field,
   * so `on('ui:show_review', handler)` works directly.
   */
  function dispatchEvent(type: string, data: unknown): void {
    const handlers = listeners.get(type);
    if (handlers) {
      for (const handler of handlers) handler(data);
    }
    if (type === 'client:event' && data && typeof data === 'object' && 'name' in data) {
      const ce = data as { name: string; data: unknown };
      const nameHandlers = listeners.get(ce.name);
      if (nameHandlers) {
        for (const handler of nameHandlers) handler(ce.data);
      }
    }
    for (const handler of anyListeners) handler(type, data);
  }

  function requireConnection(): void {
    if (!eventSource) {
      throw new Error(
        'SSE connection required: call connect() before using actionAndWait or interruptAndAction'
      );
    }
  }

  return {
    async action(name, payload) {
      return post('/api/actions/' + encodeURIComponent(name), payload ?? {});
    },

    async write(key, value) {
      return post('/api/blackboard/' + encodeURIComponent(key), { value });
    },

    async send(msg) {
      return post('/api/messages', msg);
    },

    async actionAndWait(name, payload) {
      requireConnection();
      const { id } = await post('/api/actions/' + encodeURIComponent(name), payload ?? {});
      return new Promise((resolve, reject) => {
        const onProcessed = (data: unknown) => {
          const d = data as { messageId: string; treeStatus: string };
          if (d.messageId === id) {
            cleanup();
            resolve(d);
          }
        };
        const onFailed = (data: unknown) => {
          const d = data as { messageId: string; error: string };
          if (d.messageId === id) {
            cleanup();
            reject(new Error(d.error));
          }
        };
        const cleanup = () => {
          listeners.get('message:processed')?.delete(onProcessed);
          listeners.get('message:failed')?.delete(onFailed);
        };
        if (!listeners.has('message:processed')) listeners.set('message:processed', new Set());
        if (!listeners.has('message:failed')) listeners.set('message:failed', new Set());
        listeners.get('message:processed')!.add(onProcessed);
        listeners.get('message:failed')!.add(onFailed);
      });
    },

    async interrupt() {
      const res = await fetch(`${baseUrl}/api/interrupt`, { method: 'POST' });
      return res.json() as Promise<{ interrupted: boolean; messageId?: string }>;
    },

    async resume() {
      const res = await fetch(`${baseUrl}/api/resume`, { method: 'POST' });
      return res.json() as Promise<{ resumed: boolean }>;
    },

    async interruptAndAction(name, payload) {
      const { interrupted, messageId } = await this.interrupt();

      // If nothing was processing, send the action directly
      if (!interrupted) {
        return this.action(name, payload);
      }

      // Wait for the interrupted message's processing to finish (lock release)
      requireConnection();
      await new Promise<void>((resolve) => {
        const onProcessed = (data: unknown) => {
          const d = data as { messageId: string };
          if (d.messageId === messageId) { cleanup(); resolve(); }
        };
        const onFailed = (data: unknown) => {
          const d = data as { messageId: string };
          if (d.messageId === messageId) { cleanup(); resolve(); }
        };
        const cleanup = () => {
          listeners.get('message:processed')?.delete(onProcessed);
          listeners.get('message:failed')?.delete(onFailed);
        };
        if (!listeners.has('message:processed')) listeners.set('message:processed', new Set());
        if (!listeners.has('message:failed')) listeners.set('message:failed', new Set());
        listeners.get('message:processed')!.add(onProcessed);
        listeners.get('message:failed')!.add(onFailed);
      });

      // Lock is released — send the new action
      return this.action(name, payload);
    },

    async blackboard() {
      return get('/api/blackboard') as Promise<Record<string, unknown>>;
    },

    async tree() {
      return get('/api/tree');
    },

    async status() {
      return get('/api/status');
    },

    on(event, handler) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event)!.add(handler);
    },

    onAny(handler) {
      anyListeners.add(handler);
    },

    off(event, handler) {
      listeners.get(event)?.delete(handler);
    },

    connect() {
      if (eventSource) return;
      if (typeof globalThis.EventSource === 'undefined') return;
      eventSource = new EventSource(`${baseUrl}/api/events`);
      eventSource.addEventListener('snapshot', (e: any) => {
        dispatchEvent('snapshot', JSON.parse(e.data));
      });
      for (const type of ['blackboard:write', 'client:event', 'message:processed', 'message:interrupted', 'message:failed', 'node:enter', 'node:exit', 'tree:tick']) {
        eventSource.addEventListener(type, (e: any) => {
          try { dispatchEvent(type, JSON.parse(e.data)); } catch {}
        });
      }
    },

    disconnect() {
      eventSource?.close();
      eventSource = null;
    },
  };
}

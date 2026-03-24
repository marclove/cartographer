import { QueueFullError, type CartographerClient, type SendResponse } from './types.js';

export { QueueFullError, type CartographerClient, type SendResponse } from './types.js';

/**
 * Creates a client connected to an ActorServer at the given URL.
 *
 * The client provides two communication channels with the server:
 *
 * 1. **HTTP (request/response)** — Used by `command`, `write`, `send`, `interrupt`,
 *    `resume`, `blackboard`, `tree`, and `status`. These methods work standalone
 *    and do not require an SSE connection.
 *
 * 2. **SSE (server-sent events)** — A persistent, one-way stream from the server
 *    that pushes real-time events (tree ticks, agent activity, blackboard mutations,
 *    message lifecycle, etc.) to the client. Opened by calling {@link CartographerClient.connect | connect()}.
 *    Required by `commandAndWait` and `interruptAndCommand` (when a message is active),
 *    since these methods need to observe server-side completion events.
 *
 * The client uses the standard `fetch` API for HTTP and the browser-native
 * `EventSource` API for SSE. In Node.js, `EventSource` requires either a polyfill
 * or the `--experimental-eventsource` flag (Node 22+).
 */
export function createCartographerClient(baseUrl: string): CartographerClient {
  // Holds the active SSE connection, or null when disconnected.
  // Typed as `any` to avoid importing the EventSource type, which varies
  // between browser and Node.js environments.
  let eventSource: any | null = null;

  // Event listener registry, keyed by event type (e.g., 'message:processed',
  // 'blackboard:write'). Each key maps to a Set of handler functions.
  // This supports both SSE event types and custom names (like 'ui:show_review')
  // that are extracted from `client:event` payloads.
  const listeners = new Map<string, Set<(data: unknown) => void>>();

  // Wildcard listeners that receive every dispatched event regardless of type.
  // Useful for debugging, logging, or building generic event monitors like a dashboard.
  const anyListeners = new Set<(event: string, data: unknown) => void>();

  /**
   * Sends a POST request with a JSON body to the server and returns the
   * server-assigned message ID.
   *
   * The ActorServer queues messages when the tree is already processing.
   * If the queue is full, the server responds with 429 Too Many Requests,
   * which this method surfaces as a {@link QueueFullError}.
   *
   * This is the shared HTTP transport for `command`, `write`, and `send`.
   *
   * @throws {QueueFullError} 429 — The server's message queue is full.
   *   The caller should wait for the current message to finish, or use
   *   `interruptAndCommand` to preempt it.
   * @throws {Error} 400 — The request payload failed server-side validation.
   *   The error message from the server is included.
   * @throws {Error} 503 — The server is shutting down and no longer accepting messages.
   */
  async function post(path: string, body: unknown): Promise<SendResponse> {
    const res = await fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (res.status === 429) throw new QueueFullError();
    if (res.status === 400) {
      const err = await res.json() as { error?: string };
      throw new Error(err.error ?? 'Bad request');
    }
    if (res.status === 503) throw new Error('Server is shutting down');
    return res.json() as Promise<SendResponse>;
  }

  /**
   * Sends a GET request to the server and returns the parsed JSON response.
   *
   * Used by read-only endpoints (`blackboard`, `tree`, `status`) that inspect
   * server state without modifying it.
   */
  async function get(path: string): Promise<unknown> {
    const res = await fetch(`${baseUrl}${path}`);
    return res.json();
  }

  /**
   * Routes an incoming SSE event to all matching registered listeners.
   *
   * Dispatching follows a three-step process:
   *
   * 1. **Exact type match** — Handlers registered with `on('message:processed', fn)`
   *    receive events whose SSE `type` field is `'message:processed'`.
   *
   * 2. **Client event name extraction** — For events of type `'client:event'`, the
   *    server wraps application-defined events inside a `{ name, data }` envelope.
   *    This step unwraps that envelope and dispatches to handlers registered under
   *    the inner `name` (e.g., `on('ui:show_review', fn)`), passing only the inner
   *    `data`. This allows application code to subscribe to custom events by name
   *    without manually filtering `client:event` payloads.
   *
   * 3. **Wildcard listeners** — All events are forwarded to handlers registered via
   *    `onAny()`, regardless of type. These receive both the event type and data.
   */
  function dispatchEvent(type: string, data: unknown): void {
    // Step 1: Dispatch to handlers listening for this exact event type
    const handlers = listeners.get(type);
    if (handlers) {
      for (const handler of handlers) handler(data);
    }
    // Step 2: For client:event, also dispatch to handlers registered by the inner event name.
    // The server's EmitToClientNode wraps custom events as { name: string, data: unknown },
    // so on('ui:show_review', fn) works without the caller needing to know about the
    // client:event wrapper.
    if (type === 'client:event' && data && typeof data === 'object' && 'name' in data) {
      const ce = data as { name: string; data: unknown };
      const nameHandlers = listeners.get(ce.name);
      if (nameHandlers) {
        for (const handler of nameHandlers) handler(ce.data);
      }
    }
    // Step 3: Notify wildcard listeners with both the type and data
    for (const handler of anyListeners) handler(type, data);
  }

  /**
   * Guard that ensures an SSE connection is active. Methods that wait for
   * server-side events (`commandAndWait`, `interruptAndCommand`) call this
   * before setting up event listeners, since without a connection those
   * listeners would never fire and the returned promise would hang forever.
   */
  function requireConnection(): void {
    if (!eventSource) {
      throw new Error(
        'SSE connection required: call connect() before using commandAndWait or interruptAndCommand'
      );
    }
  }

  return {
    /**
     * Sends a named command to the behavior tree for processing.
     *
     * The command is enqueued as a message in the ActorServer's message queue.
     * On the next tick, the tree's ReceiveNode will match on the command
     * name and make it available to the tree logic.
     *
     * Returns immediately with the server-assigned message ID. Does *not* wait
     * for the tree to process the command — use `commandAndWait` if you need to
     * block until processing completes.
     */
    async command(name, payload) {
      return post('/api/commands/' + encodeURIComponent(name), payload ?? {});
    },

    /**
     * Writes a value to the server's blackboard under the given key.
     *
     * The blackboard is a shared key-value store accessible to all nodes in the
     * behavior tree. This is the primary mechanism for passing data from external
     * clients into the tree. The value is wrapped in `{ value }` to match the
     * server's expected request body format.
     */
    async write(key, value) {
      return post('/api/blackboard/' + encodeURIComponent(key), { value });
    },

    /**
     * Sends a raw message of any type to the server.
     *
     * This is the low-level escape hatch for message types that don't have a
     * dedicated method (e.g., custom message types). The message object must
     * include a `type` field; other fields (`name`, `payload`, `key`, `value`)
     * are type-dependent.
     */
    async send(msg) {
      return post('/api/messages', msg);
    },

    /**
     * Sends a command and waits for the tree to finish processing it.
     *
     * This is a higher-level alternative to `command()` that blocks until the
     * server emits a terminal event for the submitted message:
     *
     * - **`message:processed`** — The tree completed a tick cycle for this message.
     *   The promise resolves with `{ messageId, treeStatus }`.
     * - **`message:failed`** — The message encountered an error during processing.
     *   The promise rejects with the server-provided error message.
     *
     * Requires an active SSE connection (call `connect()` first) so that the
     * client can observe these server-side lifecycle events.
     *
     * The flow is:
     * 1. POST the command to the server, receiving a message ID.
     * 2. Register one-shot SSE listeners for `message:processed` and `message:failed`.
     * 3. When the matching event arrives (identified by message ID), clean up
     *    listeners and resolve/reject the promise.
     */
    async commandAndWait(name, payload) {
      requireConnection();
      // Send the command and capture the server-assigned message ID.
      // This ID is used to correlate the SSE completion event back to this specific command.
      const { id } = await post('/api/commands/' + encodeURIComponent(name), payload ?? {});
      return new Promise((resolve, reject) => {
        // Listen for successful processing — the tree completed its tick cycle
        const onProcessed = (data: unknown) => {
          const d = data as { messageId: string; treeStatus: string };
          if (d.messageId === id) {
            cleanup();
            resolve(d);
          }
        };
        // Listen for processing failure — an error occurred during the tick
        const onFailed = (data: unknown) => {
          const d = data as { messageId: string; error: string };
          if (d.messageId === id) {
            cleanup();
            reject(new Error(d.error));
          }
        };
        // Remove both listeners once either event fires. This prevents memory leaks
        // and ensures each commandAndWait call only resolves once.
        const cleanup = () => {
          listeners.get('message:processed')?.delete(onProcessed);
          listeners.get('message:failed')?.delete(onFailed);
        };
        // Lazily initialize the listener sets. The SSE connection dispatches events
        // through the same `listeners` map, so registering here means dispatchEvent()
        // will invoke our handlers when matching events arrive.
        if (!listeners.has('message:processed')) listeners.set('message:processed', new Set());
        if (!listeners.has('message:failed')) listeners.set('message:failed', new Set());
        listeners.get('message:processed')!.add(onProcessed);
        listeners.get('message:failed')!.add(onFailed);
      });
    },

    /**
     * Asks the server to interrupt the currently processing message.
     *
     * Interruption sets the tree's abort signal, causing the current tick to
     * wind down cooperatively. The server responds with:
     * - `{ interrupted: true, messageId: '...' }` — A message was being processed
     *   and has been flagged for interruption.
     * - `{ interrupted: false }` — Nothing was being processed; no-op.
     *
     * Note: This does not use the shared `post()` helper because `interrupt` bypasses
     * the server's message queue and processing lock — it acts on the currently
     * running tick directly, so 409 Conflict does not apply.
     */
    async interrupt() {
      const res = await fetch(`${baseUrl}/api/interrupt`, { method: 'POST' });
      return res.json() as Promise<{ interrupted: boolean; messageId?: string }>;
    },

    /**
     * Clears the tree's "held" state so that the next tick processes normally.
     *
     * After a tree tick completes, the ActorServer may hold the tree in its
     * terminal state (e.g., SUCCESS or FAILURE) until explicitly resumed. This
     * is useful for trees that need external acknowledgment before restarting.
     *
     * Like `interrupt`, this bypasses the message queue and acts directly on
     * the server's processing state.
     */
    async resume() {
      const res = await fetch(`${baseUrl}/api/resume`, { method: 'POST' });
      return res.json() as Promise<{ resumed: boolean }>;
    },

    /**
     * Interrupts the current message (if any) and sends a new command once the
     * processing lock is released.
     *
     * This is the safe way to preempt a running command with a new one. The
     * ActorServer only processes one message at a time (enforced via a lock),
     * so sending a command while the queue is full would result in a 429.
     * This method handles that coordination:
     *
     * 1. **Interrupt** — Signal the server to abort the current tick.
     * 2. **Wait for lock release** — The interrupted tick still needs to wind
     *    down (cleanup, state persistence, event emission). We listen for the
     *    server's terminal event (`message:processed`, `message:failed`, or
     *    `message:interrupted`) to know the lock is free.
     * 3. **Send** — Once the lock is released, send the new command.
     *
     * If nothing was being processed (interrupt returns `interrupted: false`),
     * the command is sent immediately without waiting — no lock contention exists.
     *
     * Unlike `commandAndWait`, this method does *not* wait for the new command to
     * finish processing. It returns the new message's ID immediately after sending.
     */
    async interruptAndCommand(name, payload) {
      const { interrupted, messageId } = await this.interrupt();

      // Fast path: nothing was processing, so the lock is already free.
      // Send the command immediately without setting up SSE listeners.
      if (!interrupted) {
        return this.command(name, payload);
      }

      // Slow path: a message was processing and has been told to abort.
      // We must wait for the server to fully release the processing lock before
      // sending the new command — otherwise we'd hit a 429 if the queue is full.
      requireConnection();
      await new Promise<void>((resolve) => {
        // The interrupted message can complete in one of three ways:
        // - message:processed — The tick finished normally before the abort took effect
        // - message:failed — The tick encountered an error during wind-down
        // - message:interrupted — The tick was successfully aborted mid-execution
        // We listen for all three since any of them signals that the lock is free.
        // In all cases we resolve (not reject) because we don't care *how* the
        // interrupted message ended — only that the lock is released.
        const onProcessed = (data: unknown) => {
          const d = data as { messageId: string };
          if (d.messageId === messageId) { cleanup(); resolve(); }
        };
        const onFailed = (data: unknown) => {
          const d = data as { messageId: string };
          if (d.messageId === messageId) { cleanup(); resolve(); }
        };
        const onInterrupted = (data: unknown) => {
          const d = data as { messageId: string };
          if (d.messageId === messageId) { cleanup(); resolve(); }
        };
        const cleanup = () => {
          listeners.get('message:processed')?.delete(onProcessed);
          listeners.get('message:failed')?.delete(onFailed);
          listeners.get('message:interrupted')?.delete(onInterrupted);
        };
        if (!listeners.has('message:processed')) listeners.set('message:processed', new Set());
        if (!listeners.has('message:failed')) listeners.set('message:failed', new Set());
        if (!listeners.has('message:interrupted')) listeners.set('message:interrupted', new Set());
        listeners.get('message:processed')!.add(onProcessed);
        listeners.get('message:failed')!.add(onFailed);
        listeners.get('message:interrupted')!.add(onInterrupted);
      });

      // Lock is released — send the new command
      return this.command(name, payload);
    },

    /**
     * Returns the full blackboard state as a key-value record.
     *
     * The blackboard is the shared data store that all nodes in the behavior tree
     * can read from and write to. This provides a snapshot of its current contents.
     */
    async blackboard() {
      return get('/api/blackboard') as Promise<Record<string, unknown>>;
    },

    /**
     * Returns the tree's structural metadata (node hierarchy, types, IDs).
     *
     * Useful for visualization tools like the dashboard that need to render
     * the tree topology without subscribing to real-time events.
     */
    async tree() {
      return get('/api/tree');
    },

    /**
     * Returns the tree's current runtime status (tick count, processing state, etc.).
     */
    async status() {
      return get('/api/status');
    },

    /**
     * Registers a handler for a specific event type.
     *
     * Event types correspond to SSE event names from the server (e.g.,
     * `'message:processed'`, `'node:enter'`, `'agent:text'`). Additionally,
     * for `client:event` types, you can register by the inner event name
     * (e.g., `'ui:show_review'`) — see {@link dispatchEvent} for details.
     *
     * Multiple handlers can be registered for the same event type.
     * Use {@link CartographerClient.off | off()} to remove a specific handler.
     */
    on(event, handler) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event)!.add(handler);
    },

    /**
     * Registers a wildcard handler that receives every dispatched event.
     *
     * The handler receives both the event type string and the parsed data.
     * Useful for logging, debugging, or building generic event displays.
     */
    onAny(handler) {
      anyListeners.add(handler);
    },

    /**
     * Removes a previously registered handler for a specific event type.
     *
     * If the handler was not registered or the event type has no listeners,
     * this is a safe no-op.
     */
    off(event, handler) {
      listeners.get(event)?.delete(handler);
    },

    /**
     * Opens an SSE connection to the server's `/events` endpoint.
     *
     * Once connected, the server pushes real-time events covering the full
     * lifecycle of the behavior tree: node transitions, agent activity,
     * blackboard mutations, message processing, and more.
     *
     * The connection setup works as follows:
     *
     * 1. **Guard checks** — No-op if already connected or if `EventSource` is
     *    unavailable (e.g., Node.js without polyfill).
     *
     * 2. **Snapshot listener** — The server sends a `snapshot` event immediately
     *    on connection with the full current state (tree structure, blackboard,
     *    processing status). This allows late-joining clients to hydrate without
     *    needing to reconstruct state from individual events.
     *
     * 3. **Typed event listeners** — Registers listeners for all known server
     *    event types. Each SSE message has its JSON `data` field parsed and
     *    routed through {@link dispatchEvent} to reach registered handlers.
     *    Parse failures are silently caught to prevent a single malformed event
     *    from breaking the connection.
     *
     * 4. **Error handling** — SSE connection errors (network drops, server
     *    restarts) are dispatched as synthetic `connection:error` events with
     *    the EventSource `readyState` (0 = CONNECTING, 1 = OPEN, 2 = CLOSED),
     *    allowing application code to implement reconnection UI or logic.
     */
    connect() {
      // Already connected — avoid opening duplicate connections
      if (eventSource) return;
      // EventSource not available in this runtime — fail silently rather than
      // crashing, since HTTP-only methods still work without SSE
      if (typeof globalThis.EventSource === 'undefined') return;
      eventSource = new EventSource(`${baseUrl}/events`);
      // The snapshot event delivers full state on initial connection, enabling
      // clients to hydrate immediately rather than waiting for incremental events
      eventSource.addEventListener('snapshot', (e: any) => {
        dispatchEvent('snapshot', JSON.parse(e.data));
      });
      // Register listeners for all known event types emitted by the ActorServer.
      // These cover several domains:
      //   - blackboard:*  — Data store mutations and reads
      //   - client:event  — Application-defined events from EmitToClientNode
      //   - message:*     — Message lifecycle (processed, interrupted, failed)
      //   - node:*        — Node execution lifecycle (enter, exit, error)
      //   - tree:*        — Tree-level lifecycle (tick, init, reset, abort)
      //   - agent:*       — Claude agent activity (prompts, responses, tool use, errors)
      //   - strategy:*    — Strategy decision events
      for (const type of [
        'blackboard:write', 'client:event', 'message:processed',
        'message:interrupted', 'message:failed', 'message:queued',
        'message:dequeued', 'node:enter', 'node:exit', 'tree:tick',
        'node:error', 'tree:init', 'tree:reset', 'tree:abort', 'tree:tick:skipped',
        'agent:prompt', 'agent:thinking', 'agent:text', 'agent:tool_use', 'agent:response',
        'agent:error', 'agent:message', 'agent:tool_progress', 'agent:init', 'agent:status',
        'agent:rate_limit', 'agent:elicitation_declined',
        'blackboard:keys', 'blackboard:read', 'strategy:decision',
      ]) {
        eventSource.addEventListener(type, (e: any) => {
          // Silently catch JSON parse errors — a single malformed event should
          // not break the SSE connection or crash the client
          try { dispatchEvent(type, JSON.parse(e.data)); } catch {}
        });
      }
      // Surface SSE connection errors as synthetic events so application code
      // can react (e.g., show a "reconnecting..." indicator in the dashboard).
      // readyState 2 (CLOSED) indicates the connection was lost and EventSource
      // has given up reconnecting.
      eventSource.onerror = () => {
        const readyState = eventSource?.readyState ?? 2;
        dispatchEvent('connection:error', { readyState });
      };
    },

    /**
     * Closes the SSE connection and releases the EventSource resource.
     *
     * After disconnecting, SSE-dependent methods (`commandAndWait`,
     * `interruptAndCommand` when processing) will throw until `connect()`
     * is called again. HTTP-only methods continue to work normally.
     *
     * Registered listeners are preserved — they will resume receiving events
     * if `connect()` is called again.
     */
    disconnect() {
      eventSource?.close();
      eventSource = null;
    },
  };
}

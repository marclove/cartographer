/** Thrown when the server returns 429 (message queue is full). */
export class QueueFullError extends Error {
  constructor() {
    super('Server message queue is full');
    this.name = 'QueueFullError';
  }
}

/** Response returned by command(), write(), and send(). */
export interface SendResponse {
  id: string;
  status?: 'processing' | 'queued';
  position?: number;
}

/**
 * Client for communicating with an ActorServer over HTTP and SSE.
 *
 * Methods that only need HTTP (`command`, `write`, `send`, `interrupt`, `resume`)
 * work without an SSE connection. Methods that wait for server-side events
 * (`commandAndWait`, `interruptAndCommand` when processing is active) require
 * {@link connect} to have been called first.
 */
export interface CartographerClient {
  /** Send a command message. Returns immediately with the message ID. */
  command(name: string, payload?: unknown): Promise<SendResponse>;
  /** Write a value to the blackboard. Returns immediately with the message ID. */
  write(key: string, value: unknown): Promise<SendResponse>;
  /** Send any message type. Returns immediately with the message ID. */
  send(msg: { type: string; name?: string; payload?: unknown; key?: string; value?: unknown }): Promise<SendResponse>;
  /**
   * Send a command and wait for processing to complete via SSE.
   * Resolves with the tree status on success, rejects on failure.
   * Requires {@link connect} to have been called first.
   */
  commandAndWait(name: string, payload?: unknown): Promise<{ messageId: string; treeStatus: string }>;
  /** Interrupt the currently processing message. Bypasses the lock. */
  interrupt(): Promise<{ interrupted: boolean; messageId?: string }>;
  /** Clear the held state so the next tick processes normally. */
  resume(): Promise<{ resumed: boolean }>;
  /**
   * Interrupt current processing, wait for the lock to release, then send a new command.
   * The command clears the held state implicitly.
   *
   * If nothing is being processed, the command is sent immediately without waiting.
   * Otherwise, waits for the interrupted message's `message:processed`,
   * `message:failed`, or `message:interrupted` SSE event before sending. Requires {@link connect} when
   * processing is active.
   */
  interruptAndCommand(name: string, payload?: unknown): Promise<SendResponse>;
  /** Returns the current blackboard state. */
  blackboard(): Promise<Record<string, unknown>>;
  /** Returns tree structure metadata. */
  tree(): Promise<unknown>;
  /** Returns tree status metadata. */
  status(): Promise<unknown>;
  /**
   * Subscribe to a specific SSE event type. For `client:event` events, you can
   * also subscribe by event name (e.g., `on('ui:show_review', handler)`).
   */
  on(event: string, handler: (data: unknown) => void): void;
  /** Subscribe to all SSE events. */
  onAny(handler: (event: string, data: unknown) => void): void;
  /** Unsubscribe a handler from a specific event type. */
  off(event: string, handler: (data: unknown) => void): void;
  /**
   * Open an SSE connection to the server's event stream.
   * No-op if already connected or if `globalThis.EventSource` is undefined.
   */
  connect(): void;
  /** Close the SSE connection. */
  disconnect(): void;
}

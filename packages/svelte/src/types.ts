/**
 * The result of the most recent behavior tree tick, delivered via SSE.
 *
 * A new `TreeStatusInfo` is produced every time the client receives a
 * `tree:tick` event from the server.
 */
export interface TreeStatusInfo {
  /** Node status returned by the root tick — typically `"success"`, `"failure"`, or `"running"`. */
  status: string;
  /** Wall-clock duration of the tick in milliseconds, as reported by the server. */
  durationMs: number;
  /**
   * Client-side tick counter, incremented on every `tree:tick` SSE event.
   *
   * This value resets to `0` whenever the SSE connection is re-established,
   * so it reflects ticks observed during the current session, not a global count.
   */
  localTickCount: number;
}

/**
 * SSE connection lifecycle state.
 *
 * - `'connecting'` — an SSE connection attempt is in progress.
 * - `'connected'`  — the SSE stream is open and receiving events.
 * - `'disconnected'` — the connection has been closed or has not yet been initiated.
 */
export type ConnectionStatus = 'connecting' | 'connected' | 'disconnected';

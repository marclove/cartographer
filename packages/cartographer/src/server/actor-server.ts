import { serve } from '@hono/node-server';
import type { ServerType } from '@hono/node-server';
import type { Hono } from 'hono';
import type { ActorMessage } from '../actor/types.js';
import type { ProcessResult } from '../actor/message-processor.js';
import { createApp } from './app.js';
import type { AppOptions, AppHandle, QueuedResult } from './app.js';

// Re-export types that were previously defined here
export type { QueuedResult } from './app.js';

/**
 * Configuration for creating an {@link ActorServer}.
 *
 * At minimum, you must provide a `createTree` factory. All other options have
 * sensible defaults suitable for local development.
 */
export interface ActorServerOptions extends AppOptions {
  /**
   * TCP port to listen on. Defaults to the `PORT` environment variable, or `3148`
   * if unset. Pass `0` to let the OS assign an available port — the actual port
   * is returned by {@link ActorServer.start}.
   */
  port?: number;
}

/**
 * HTTP server that wraps a {@link AppHandle} with a REST + SSE API.
 *
 * ActorServer provides a message-driven interface to a behavior tree. Clients
 * send messages (ticks, commands, blackboard writes) via HTTP POST and observe
 * tree activity in real time through a Server-Sent Events stream. Only one
 * message is processed at a time; additional messages are queued and drained
 * in order.
 *
 * For programmatic (non-HTTP) usage within the same process, call
 * {@link processMessage} directly instead of going through the REST API.
 */
export class ActorServer {
  /** The underlying Hono application. Can be mounted into other servers via `app.fetch`. */
  readonly app: Hono;
  /** The persistence backend used for tree state, locks, events, and the message queue. */
  readonly stateStore;
  /** How the server handles tree topology changes between ticks. */
  readonly topologyPolicy;
  /** Maximum queued messages allowed while a message is being processed. */
  readonly maxQueueDepth;

  private readonly handle: AppHandle;
  private server: ServerType | null = null;
  private readonly configPort: number;

  constructor(options: ActorServerOptions) {
    this.handle = createApp(options);
    this.app = this.handle.app;
    this.stateStore = this.handle.stateStore;
    this.topologyPolicy = this.handle.topologyPolicy;
    this.maxQueueDepth = this.handle.maxQueueDepth;
    this.configPort = options.port ?? parseInt(process.env.PORT ?? '3148', 10);
  }

  /**
   * Initialize state (if needed) and start the HTTP server.
   */
  async start(): Promise<{ port: number }> {
    await this.handle.start();

    const result = await new Promise<{ port: number }>((resolve, reject) => {
      this.server = serve(
        { fetch: this.handle.app.fetch, port: this.configPort },
        (info) => { resolve({ port: info.port }); },
      );
      this.server.on('error', reject);
    });

    return result;
  }

  /**
   * Gracefully shut down the server.
   */
  async stop(): Promise<void> {
    this.handle.stop();
    if (this.server) {
      await new Promise<void>((resolve) => this.server!.close(() => resolve()));
    }
  }

  /**
   * Process a message programmatically without going through the REST API.
   */
  async processMessage(msg: ActorMessage, sessionKey: string): Promise<ProcessResult | QueuedResult | null> {
    return this.handle.processMessage(msg, sessionKey);
  }

}

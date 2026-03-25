import { serve } from '@hono/node-server';
import type { ServerType } from '@hono/node-server';
import type { Hono } from 'hono';
import type { BehaviorTree } from '../core/behavior-tree.js';
import { createObserverApp } from './observer-app.js';
import type { ObserverHandle } from './observer-app.js';

export interface ObserverServerOptions {
  port?: number;
  eventStreamCapacity?: number;
}

export class ObserverServer {
  readonly app: Hono;
  private readonly handle: ObserverHandle;
  private server: ServerType | null = null;
  private readonly port: number;

  constructor(
    tree: BehaviorTree,
    options: ObserverServerOptions = {},
  ) {
    this.handle = createObserverApp({
      tree,
      eventStreamCapacity: options.eventStreamCapacity,
    });
    this.app = this.handle.app;
    this.port = options.port ?? 3147;
  }

  async start(): Promise<{ port: number }> {
    return new Promise((resolve, reject) => {
      this.server = serve(
        { fetch: this.handle.app.fetch, port: this.port },
        (info) => { resolve({ port: info.port }); },
      );
      this.server.on('error', reject);
    });
  }

  async close(): Promise<void> {
    this.handle.close();
    if (this.server) {
      await new Promise<void>((resolve) => this.server!.close(() => resolve()));
    }
  }
}

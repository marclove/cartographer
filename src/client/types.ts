export class ConflictError extends Error {
  constructor() {
    super('Session is currently processing a message');
    this.name = 'ConflictError';
  }
}

export interface CartographerClient {
  action(name: string, payload?: unknown): Promise<{ id: string }>;
  write(key: string, value: unknown): Promise<{ id: string }>;
  send(msg: { type: string; name?: string; payload?: unknown; key?: string; value?: unknown }): Promise<{ id: string }>;
  actionAndWait(name: string, payload?: unknown): Promise<{ messageId: string; treeStatus: string }>;
  /** Interrupt the currently processing message. Bypasses the lock. */
  interrupt(): Promise<{ interrupted: boolean; messageId?: string }>;
  /** Clear the held state so the next tick processes normally. */
  resume(): Promise<{ resumed: boolean }>;
  /** Interrupt, wait for processing to finish, then send a new action (clears held implicitly). */
  interruptAndAction(name: string, payload?: unknown): Promise<{ id: string }>;
  blackboard(): Promise<Record<string, unknown>>;
  tree(): Promise<unknown>;
  status(): Promise<unknown>;
  on(event: string, handler: (data: unknown) => void): void;
  onAny(handler: (event: string, data: unknown) => void): void;
  off(event: string, handler: (data: unknown) => void): void;
  connect(): void;
  disconnect(): void;
}

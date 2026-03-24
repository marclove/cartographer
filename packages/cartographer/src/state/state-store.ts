import type { SerializedTreeState } from '../core/serialization.js';
import type { ActorMessage } from '../actor/types.js';

export interface TreeSessionState {
  blackboard: Record<string, unknown>;
  treeState: SerializedTreeState;
  /** Serialized tree structure for API/SSE snapshots. Enables multi-server SSE without an in-process tree. */
  treeStructure?: { id: string; name: string; type: string; children: unknown[] };
  createdAt: number;
  lastMessageAt: number;
  /** When true, the tree is held after interrupt — tick messages are no-ops. */
  held?: boolean;
  /** Named session registry. Optional for backward compatibility. Defaults to empty when absent. */
  sessions?: Record<string, string>;
}

export interface TreeEvent {
  id: string;
  type: string;
  data: unknown;
  timestamp: number;
}

export interface StateStore {
  getState(key: string): Promise<TreeSessionState | null>;
  saveState(key: string, state: TreeSessionState): Promise<void>;
  deleteState(key: string): Promise<void>;
  listKeys(): Promise<string[]>;

  acquireLock(key: string, requestId: string, ttlMs: number): Promise<boolean>;
  releaseLock(key: string, requestId: string): Promise<void>;

  appendEvents(key: string, events: TreeEvent[]): Promise<void>;
  readEvents(key: string, lastEventId?: string, options?: { signal?: AbortSignal }): AsyncIterable<TreeEvent>;

  // Queue
  enqueueMessage(stateKey: string, message: ActorMessage, maxQueueDepth: number): Promise<{ position: number; queueSize: number }>;
  dequeueMessage(stateKey: string): Promise<ActorMessage | null>;
  getQueueSize(stateKey: string): Promise<number>;
  getQueuedMessages(stateKey: string): Promise<ActorMessage[]>;
}

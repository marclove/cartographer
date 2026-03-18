import type { CartographerClient } from '@cartographer/client';
import type { TreeStatusInfo, ConnectionStatus } from './types.js';

export interface SyncStore {
  getBlackboardValue(key: string): unknown;
  getBlackboardVersion(key: string): number;
  getBlackboardSnapshot(): Record<string, unknown>;
  getGlobalVersion(): number;
  getTreeStatus(): TreeStatusInfo | null;
  getConnectionStatus(): ConnectionStatus;
  subscribe(listener: () => void): () => void;
  attach(client: CartographerClient): () => void;
}

export function createSyncStore(): SyncStore {
  let blackboard: Record<string, unknown> = {};
  let blackboardVersions: Record<string, number> = {};
  let globalVersion = 0;
  let treeStatus: TreeStatusInfo | null = null;
  let connectionStatus: ConnectionStatus = 'connecting';
  const listeners = new Set<() => void>();

  function notify(): void {
    for (const listener of listeners) listener();
  }

  function onSnapshot(data: unknown): void {
    const d = data as { blackboard: Record<string, unknown> };
    blackboard = { ...d.blackboard };
    blackboardVersions = {};
    for (const key of Object.keys(blackboard)) {
      blackboardVersions[key] = 1;
    }
    globalVersion++;
    treeStatus = null;
    connectionStatus = 'connected';
    notify();
  }

  function onBlackboardWrite(data: unknown): void {
    const d = data as { key: string; value: unknown };
    blackboard = { ...blackboard, [d.key]: d.value };
    blackboardVersions = {
      ...blackboardVersions,
      [d.key]: (blackboardVersions[d.key] ?? 0) + 1,
    };
    globalVersion++;
    notify();
  }

  function onTreeTick(data: unknown): void {
    const d = data as { status: string; durationMs: number };
    treeStatus = {
      status: d.status,
      durationMs: d.durationMs,
      localTickCount: (treeStatus?.localTickCount ?? 0) + 1,
    };
    notify();
  }

  return {
    getBlackboardValue(key: string): unknown {
      return blackboard[key];
    },

    getBlackboardVersion(key: string): number {
      return blackboardVersions[key] ?? 0;
    },

    getBlackboardSnapshot(): Record<string, unknown> {
      return blackboard;
    },

    getGlobalVersion(): number {
      return globalVersion;
    },

    getTreeStatus(): TreeStatusInfo | null {
      return treeStatus;
    },

    getConnectionStatus(): ConnectionStatus {
      return connectionStatus;
    },

    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    attach(client: CartographerClient): () => void {
      client.on('snapshot', onSnapshot);
      client.on('blackboard:write', onBlackboardWrite);
      client.on('tree:tick', onTreeTick);
      return () => {
        client.off('snapshot', onSnapshot);
        client.off('blackboard:write', onBlackboardWrite);
        client.off('tree:tick', onTreeTick);
        connectionStatus = 'disconnected';
        notify();
      };
    },
  };
}

import type { CartographerClient } from '@cartographer/client';
import type { TreeStatusInfo, ConnectionStatus } from './types.js';

export class CartographerState {
  connectionStatus = $state<ConnectionStatus>('connecting');
  blackboardEntries = $state<Record<string, unknown>>({});
  blackboardVersions = $state<Record<string, number>>({});
  globalVersion = $state(0);
  treeStatus = $state<TreeStatusInfo | null>(null);

  attach(client: CartographerClient): () => void {
    const onSnapshot = (data: unknown) => {
      const d = data as { blackboard: Record<string, unknown> };
      this.blackboardEntries = { ...d.blackboard };
      const versions: Record<string, number> = {};
      for (const key of Object.keys(d.blackboard)) {
        versions[key] = 1;
      }
      this.blackboardVersions = versions;
      this.globalVersion++;
      this.treeStatus = null;
      this.connectionStatus = 'connected';
    };

    const onBlackboardWrite = (data: unknown) => {
      const d = data as { key: string; value: unknown };
      this.blackboardEntries = { ...this.blackboardEntries, [d.key]: d.value };
      this.blackboardVersions = {
        ...this.blackboardVersions,
        [d.key]: (this.blackboardVersions[d.key] ?? 0) + 1,
      };
      this.globalVersion++;
    };

    const onTreeTick = (data: unknown) => {
      const d = data as { status: string; durationMs: number };
      this.treeStatus = {
        status: d.status,
        durationMs: d.durationMs,
        localTickCount: (this.treeStatus?.localTickCount ?? 0) + 1,
      };
    };

    const onConnectionError = (data: unknown) => {
      const d = data as { readyState: number };
      if (d.readyState === 2) {
        this.connectionStatus = 'disconnected';
      } else {
        this.connectionStatus = 'connecting';
      }
    };

    client.on('snapshot', onSnapshot);
    client.on('blackboard:write', onBlackboardWrite);
    client.on('tree:tick', onTreeTick);
    client.on('connection:error', onConnectionError);

    return () => {
      client.off('snapshot', onSnapshot);
      client.off('blackboard:write', onBlackboardWrite);
      client.off('tree:tick', onTreeTick);
      client.off('connection:error', onConnectionError);
      this.connectionStatus = 'disconnected';
    };
  }
}

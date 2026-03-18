import { onDestroy } from 'svelte';
import { getClient } from './context.js';

export interface ActionRef {
  readonly pending: boolean;
  send(payload?: unknown): Promise<{ id: string }>;
  sendAndWait(payload?: unknown): Promise<{ messageId: string; treeStatus: string }>;
}

export function createAction(name: string): ActionRef {
  const client = getClient();

  let pending = $state(false);
  const pendingIds = new Set<string>();
  let inflight = 0;

  function clearIfDone() {
    if (inflight === 0 && pendingIds.size === 0) {
      pending = false;
    }
  }

  const onProcessed = (data: unknown) => {
    const d = data as { messageId: string };
    if (pendingIds.has(d.messageId)) {
      pendingIds.delete(d.messageId);
      clearIfDone();
    }
  };

  const onFailed = (data: unknown) => {
    const d = data as { messageId: string };
    if (pendingIds.has(d.messageId)) {
      pendingIds.delete(d.messageId);
      clearIfDone();
    }
  };

  client.on('message:processed', onProcessed);
  client.on('message:failed', onFailed);

  onDestroy(() => {
    client.off('message:processed', onProcessed);
    client.off('message:failed', onFailed);
  });

  return {
    get pending() {
      return pending;
    },
    async send(payload?: unknown): Promise<{ id: string }> {
      inflight += 1;
      pending = true;
      try {
        const result = await client.action(name, payload);
        inflight -= 1;
        pendingIds.add(result.id);
        return result;
      } catch (err) {
        inflight -= 1;
        clearIfDone();
        throw err;
      }
    },
    async sendAndWait(payload?: unknown): Promise<{ messageId: string; treeStatus: string }> {
      pending = true;
      try {
        return await client.actionAndWait(name, payload);
      } finally {
        pending = false;
      }
    },
  };
}

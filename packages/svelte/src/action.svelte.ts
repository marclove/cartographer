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
  const waitResolvers = new Map<string, { resolve: (v: { messageId: string; treeStatus: string }) => void; reject: (e: Error) => void }>();
  let inflight = 0;

  function clearIfDone() {
    if (inflight === 0 && pendingIds.size === 0) {
      pending = false;
    }
  }

  function settle(id: string, outcome: { messageId: string; treeStatus: string } | Error) {
    if (!pendingIds.has(id)) return;
    pendingIds.delete(id);
    const resolver = waitResolvers.get(id);
    if (resolver) {
      waitResolvers.delete(id);
      if (outcome instanceof Error) {
        resolver.reject(outcome);
      } else {
        resolver.resolve(outcome);
      }
    }
    clearIfDone();
  }

  const onProcessed = (data: unknown) => {
    const d = data as { messageId: string; treeStatus: string };
    settle(d.messageId, { messageId: d.messageId, treeStatus: d.treeStatus });
  };

  const onFailed = (data: unknown) => {
    const d = data as { messageId: string; error?: string };
    settle(d.messageId, new Error(d.error ?? 'Action failed'));
  };

  client.on('message:processed', onProcessed);
  client.on('message:failed', onFailed);

  onDestroy(() => {
    client.off('message:processed', onProcessed);
    client.off('message:failed', onFailed);
  });

  async function submitAction(payload?: unknown): Promise<string> {
    inflight += 1;
    pending = true;
    try {
      const result = await client.action(name, payload);
      inflight -= 1;
      pendingIds.add(result.id);
      return result.id;
    } catch (err) {
      inflight -= 1;
      clearIfDone();
      throw err;
    }
  }

  return {
    get pending() {
      return pending;
    },
    async send(payload?: unknown): Promise<{ id: string }> {
      const id = await submitAction(payload);
      return { id };
    },
    async sendAndWait(payload?: unknown): Promise<{ messageId: string; treeStatus: string }> {
      const id = await submitAction(payload);
      return new Promise<{ messageId: string; treeStatus: string }>((resolve, reject) => {
        waitResolvers.set(id, { resolve, reject });
      });
    },
  };
}

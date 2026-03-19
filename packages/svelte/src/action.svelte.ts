import { onDestroy } from 'svelte';
import { getClient } from './context.js';

/**
 * Reactive handle for a named behavior-tree action.
 *
 * Returned by {@link createAction}. Provides fire-and-forget (`send`) and
 * awaitable (`sendAndWait`) methods, plus a reactive `pending` flag that
 * tracks whether any dispatched action is still in flight or awaiting
 * server-side completion.
 */
export interface ActionRef {
  /**
   * `true` while at least one HTTP request is in flight **or** a dispatched
   * message ID has not yet received a `message:processed` / `message:failed`
   * SSE event. Reactive (Svelte 5 `$state`).
   */
  readonly pending: boolean;

  /**
   * Fires the action over HTTP and returns once the server acknowledges it.
   *
   * The returned `id` is tracked internally — `pending` remains `true` until
   * the corresponding `message:processed` or `message:failed` SSE event
   * arrives.
   *
   * @param payload - Optional data forwarded to the server action handler.
   * @returns The server-assigned message ID.
   */
  send(payload?: unknown): Promise<{ id: string }>;

  /**
   * Fires the action and waits for the server to finish processing it.
   *
   * Performs the same HTTP call as {@link send}, but the returned promise does
   * not resolve until the `message:processed` SSE event arrives (or rejects
   * on `message:failed`). Useful when subsequent UI logic depends on the
   * tree run completing.
   *
   * @param payload - Optional data forwarded to the server action handler.
   * @returns The message ID and final tree status once processing completes.
   * @throws If the server reports `message:failed`.
   */
  sendAndWait(payload?: unknown): Promise<{ messageId: string; treeStatus: string }>;
}

/**
 * Creates a reactive {@link ActionRef} for the given named action.
 *
 * Registers `message:processed` and `message:failed` SSE listeners at
 * creation time and tears them down automatically via Svelte's `onDestroy`.
 *
 * Must be called during component initialization (i.e. at the top level of a
 * component's `<script>` block) inside a `<Cartographer>` provider so that
 * the client context and lifecycle hooks are available.
 *
 * @param name - The action name recognized by the server-side tree.
 * @returns A reactive handle for dispatching and tracking the action.
 */
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
    for (const [, resolver] of waitResolvers) {
      resolver.reject(new Error('Component unmounted'));
    }
    waitResolvers.clear();
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

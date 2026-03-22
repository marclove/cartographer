import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useCartographerContext } from './provider.js';
import type { TreeStatusInfo } from './types.js';

// ─── useBlackboard ───

export function useBlackboard<T = unknown>(key: string): [T | undefined, (value: T) => Promise<void>] {
  const { client, store } = useCartographerContext();

  const versionRef = useRef<number>(-1);
  const valueRef = useRef<T | undefined>(undefined);

  const getSnapshot = useCallback(() => {
    const currentVersion = store.getBlackboardVersion(key);
    if (currentVersion !== versionRef.current) {
      versionRef.current = currentVersion;
      valueRef.current = store.getBlackboardValue(key) as T | undefined;
    }
    return valueRef.current;
  }, [store, key]);

  const value = useSyncExternalStore(store.subscribe, getSnapshot);

  const setter = useCallback(
    async (newValue: T): Promise<void> => {
      await client.write(key, newValue);
    },
    [client, key],
  );

  return [value, setter];
}

// ─── useBlackboardSnapshot ───

export function useBlackboardSnapshot(): Record<string, unknown> {
  const { store } = useCartographerContext();

  const versionRef = useRef<number>(-1);
  const snapshotRef = useRef<Record<string, unknown>>({});

  const getSnapshot = useCallback(() => {
    const currentVersion = store.getGlobalVersion();
    if (currentVersion !== versionRef.current) {
      versionRef.current = currentVersion;
      snapshotRef.current = store.getBlackboardSnapshot();
    }
    return snapshotRef.current;
  }, [store]);

  return useSyncExternalStore(store.subscribe, getSnapshot);
}

// ─── useTreeStatus ───

export function useTreeStatus(): TreeStatusInfo | null {
  const { store } = useCartographerContext();
  return useSyncExternalStore(store.subscribe, store.getTreeStatus);
}

// ─── useCommand ───

interface UseCommandReturn {
  send: (payload?: unknown) => Promise<{ id: string }>;
  sendAndWait: (payload?: unknown) => Promise<{ messageId: string; treeStatus: string }>;
  pending: boolean;
}

export function useCommand(name: string): UseCommandReturn {
  const { client } = useCartographerContext();
  const [pending, setPending] = useState(false);
  // IDs of sends that reached the server and are awaiting SSE completion events.
  const pendingIdsRef = useRef<Set<string>>(new Set());
  // Count of send/sendAndWait calls whose HTTP request hasn't returned yet (no ID assigned).
  const inflightRef = useRef<number>(0);
  // Resolvers for sendAndWait promises, keyed by message ID.
  const waitResolversRef = useRef<Map<string, { resolve: (v: { messageId: string; treeStatus: string }) => void; reject: (e: Error) => void }>>(new Map());

  const clearIfDone = useCallback(() => {
    if (inflightRef.current === 0 && pendingIdsRef.current.size === 0) {
      setPending(false);
    }
  }, []);

  useEffect(() => {
    const settle = (id: string, outcome: { messageId: string; treeStatus: string } | Error) => {
      if (!pendingIdsRef.current.has(id)) return;
      pendingIdsRef.current.delete(id);
      const resolver = waitResolversRef.current.get(id);
      if (resolver) {
        waitResolversRef.current.delete(id);
        if (outcome instanceof Error) {
          resolver.reject(outcome);
        } else {
          resolver.resolve(outcome);
        }
      }
      clearIfDone();
    };
    const onProcessed = (data: unknown) => {
      const d = data as { messageId: string; treeStatus: string };
      settle(d.messageId, { messageId: d.messageId, treeStatus: d.treeStatus });
    };
    const onFailed = (data: unknown) => {
      const d = data as { messageId: string; error?: string };
      settle(d.messageId, new Error(d.error ?? 'Command failed'));
    };
    client.on('message:processed', onProcessed);
    client.on('message:failed', onFailed);
    return () => {
      client.off('message:processed', onProcessed);
      client.off('message:failed', onFailed);
      for (const [, resolver] of waitResolversRef.current) {
        resolver.reject(new Error('Component unmounted'));
      }
      waitResolversRef.current.clear();
    };
  }, [client, clearIfDone]);

  const send = useCallback(
    async (payload?: unknown): Promise<{ id: string }> => {
      inflightRef.current += 1;
      setPending(true);
      try {
        const result = await client.command(name, payload);
        inflightRef.current -= 1;
        pendingIdsRef.current.add(result.id);
        return result;
      } catch (err) {
        inflightRef.current -= 1;
        clearIfDone();
        throw err;
      }
    },
    [client, name, clearIfDone],
  );

  const sendAndWait = useCallback(
    async (payload?: unknown): Promise<{ messageId: string; treeStatus: string }> => {
      inflightRef.current += 1;
      setPending(true);
      try {
        const result = await client.command(name, payload);
        inflightRef.current -= 1;
        pendingIdsRef.current.add(result.id);
        return new Promise<{ messageId: string; treeStatus: string }>((resolve, reject) => {
          waitResolversRef.current.set(result.id, { resolve, reject });
        });
      } catch (err) {
        inflightRef.current -= 1;
        clearIfDone();
        throw err;
      }
    },
    [client, name, clearIfDone],
  );

  return { send, sendAndWait, pending };
}

// ─── useClientEvent ───

export function useClientEvent(name: string, handler: (data: unknown) => void): void {
  const { client } = useCartographerContext();
  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  useEffect(() => {
    const listener = (data: unknown) => handlerRef.current(data);
    client.on(name, listener);
    return () => client.off(name, listener);
  }, [client, name]);
}

// ─── useTreeEvent ───

export function useTreeEvent(type: string, handler: (data: unknown) => void): void {
  const { client } = useCartographerContext();
  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  useEffect(() => {
    const listener = (data: unknown) => handlerRef.current(data);
    client.on(type, listener);
    return () => client.off(type, listener);
  }, [client, type]);
}

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

// ─── useAction ───

interface UseActionReturn {
  send: (payload?: unknown) => Promise<{ id: string }>;
  sendAndWait: (payload?: unknown) => Promise<{ messageId: string; treeStatus: string }>;
  pending: boolean;
}

export function useAction(name: string): UseActionReturn {
  const { client } = useCartographerContext();
  const [pending, setPending] = useState(false);
  const pendingIdRef = useRef<string | null>(null);

  useEffect(() => {
    const onProcessed = (data: unknown) => {
      const d = data as { messageId: string };
      if (d.messageId === pendingIdRef.current) {
        pendingIdRef.current = null;
        setPending(false);
      }
    };
    const onFailed = (data: unknown) => {
      const d = data as { messageId: string };
      if (d.messageId === pendingIdRef.current) {
        pendingIdRef.current = null;
        setPending(false);
      }
    };
    client.on('message:processed', onProcessed);
    client.on('message:failed', onFailed);
    return () => {
      client.off('message:processed', onProcessed);
      client.off('message:failed', onFailed);
    };
  }, [client]);

  const send = useCallback(
    async (payload?: unknown): Promise<{ id: string }> => {
      const result = await client.action(name, payload);
      pendingIdRef.current = result.id;
      setPending(true);
      return result;
    },
    [client, name],
  );

  const sendAndWait = useCallback(
    async (payload?: unknown): Promise<{ messageId: string; treeStatus: string }> => {
      setPending(true);
      try {
        return await client.actionAndWait(name, payload);
      } finally {
        pendingIdRef.current = null;
        setPending(false);
      }
    },
    [client, name],
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

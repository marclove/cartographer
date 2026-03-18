import { createContext, useContext, useEffect, useMemo, useSyncExternalStore } from 'react';
import { createCartographerClient, type CartographerClient } from '@cartographer/client';
import { createSyncStore, type SyncStore } from './store.js';
import type { ConnectionStatus } from './types.js';

interface CartographerContextValue {
  client: CartographerClient;
  store: SyncStore;
}

const CartographerContext = createContext<CartographerContextValue | null>(null);

interface CartographerProviderProps {
  url: string;
  client?: CartographerClient;
  children: React.ReactNode;
}

export function CartographerProvider({ url, client: clientProp, children }: CartographerProviderProps) {
  const { client, store } = useMemo(() => {
    const client = clientProp ?? createCartographerClient(url);
    const store = createSyncStore();
    return { client, store };
  }, [url, clientProp]);

  useEffect(() => {
    const detach = store.attach(client);
    client.connect();
    return () => {
      client.disconnect();
      detach();
    };
  }, [client, store]);

  return (
    <CartographerContext.Provider value={{ client, store }}>
      {children}
    </CartographerContext.Provider>
  );
}

export function useCartographerContext(): CartographerContextValue {
  const ctx = useContext(CartographerContext);
  if (!ctx) throw new Error('Cartographer hooks must be used within a <CartographerProvider>');
  return ctx;
}

export function useClient(): CartographerClient {
  return useCartographerContext().client;
}

export function useConnectionStatus(): ConnectionStatus {
  const { store } = useCartographerContext();
  return useSyncExternalStore(store.subscribe, store.getConnectionStatus);
}

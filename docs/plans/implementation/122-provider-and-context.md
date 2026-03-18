# Task 122: Implement CartographerProvider, useClient, and useConnectionStatus

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Implement the React context provider that manages the CartographerClient lifecycle and SyncStore, plus the `useClient` and `useConnectionStatus` hooks.

**Depends on:** Task 121 (SyncStore)

**Spec Reference:** `docs/superpowers/specs/2026-03-18-react-integration-design.md` — CartographerProvider section

---

### Step 1: Implement the provider

Update `packages/react/src/provider.tsx`:

```tsx
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
  children: React.ReactNode;
}

export function CartographerProvider({ url, children }: CartographerProviderProps) {
  // Create client and store once per url, stable across re-renders
  const { client, store } = useMemo(() => {
    const client = createCartographerClient(url);
    const store = createSyncStore();
    return { client, store };
  }, [url]);

  useEffect(() => {
    const detach = store.attach(client);
    client.connect();
    return () => {
      client.disconnect();
      detach();
    };
  }, [client, store]);

  return (
    <CartographerContext value={{ client, store }}>
      {children}
    </CartographerContext>
  );
}
```

### Step 2: Implement useCartographerContext (internal)

Internal helper used by all hooks:

```ts
function useCartographerContext(): CartographerContextValue {
  const ctx = useContext(CartographerContext);
  if (!ctx) {
    throw new Error('useCartographerContext must be used within a <CartographerProvider>');
  }
  return ctx;
}
```

### Step 3: Implement useClient

```ts
export function useClient(): CartographerClient {
  return useCartographerContext().client;
}
```

### Step 4: Implement useConnectionStatus

```ts
export function useConnectionStatus(): ConnectionStatus {
  const { store } = useCartographerContext();
  return useSyncExternalStore(
    store.subscribe,
    store.getConnectionStatus,
  );
}
```

### Step 5: Update exports

Update `packages/react/src/index.ts` to export:
- `CartographerProvider`
- `useClient`
- `useConnectionStatus`

### Step 6: Verify

Run:
- `npm run typecheck --workspace=packages/react`
- `npm run build --workspace=packages/react`

### Step 7: Commit

```bash
git add packages/react/src/
git commit -m "feat(react): implement CartographerProvider, useClient, useConnectionStatus"
```

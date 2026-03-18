# Task 122: Implement CartographerProvider, useClient, and useConnectionStatus

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Implement the React context provider that manages the CartographerClient lifecycle and SyncStore, plus the `useClient` and `useConnectionStatus` hooks.

**Depends on:** Task 121 (SyncStore)

**Spec Reference:** `docs/superpowers/specs/2026-03-18-react-integration-design.md` — CartographerProvider section

**Approach:** TDD — write failing tests first, then minimal implementation.

---

### Step 1: RED — Write failing tests

Create `packages/react/src/provider.test.tsx`. Use `createMockClient` and React Testing Library's `renderHook` / `render`.

**Provider lifecycle tests:**
- Provider calls `client.connect()` on mount
- Provider calls `client.disconnect()` on unmount
- Provider creates new client when `url` prop changes (disconnect old, connect new)

**useClient tests:**
- `useClient()` returns the CartographerClient instance
- `useClient()` throws when used outside a `CartographerProvider`

**useConnectionStatus tests:**
- Returns initial connection status (`'connecting'`)
- Updates when a `snapshot` event arrives (status becomes `'connected'`)

For provider tests, you'll need to inject the mock client. Add an optional `client` prop to the provider for testing (or use a factory injection pattern).

### Step 2: Verify RED

Run: `npx vitest run packages/react/src/provider.test.tsx`

Confirm all tests fail because the provider and hooks don't exist yet.

### Step 3: GREEN — Implement

Create `packages/react/src/provider.tsx`:

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
  client?: CartographerClient; // optional override for testing
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
    <CartographerContext value={{ client, store }}>
      {children}
    </CartographerContext>
  );
}

function useCartographerContext(): CartographerContextValue {
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
```

Export `useCartographerContext` internally (not from the package) so hook files can import it.

### Step 4: Verify GREEN

Run: `npx vitest run packages/react/src/provider.test.tsx`

All tests pass. Also: `npm run typecheck --workspace=packages/react`

### Step 5: Update exports

Add `CartographerProvider`, `useClient`, `useConnectionStatus` to `packages/react/src/index.ts`.

### Step 6: Commit

```bash
git add packages/react/src/
git commit -m "feat(react): implement CartographerProvider, useClient, useConnectionStatus"
```

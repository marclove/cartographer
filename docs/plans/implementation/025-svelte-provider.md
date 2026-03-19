# Task 25: Svelte Package — Provider Component

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Implement the `<Cartographer>` provider component that manages client lifecycle and provides context to child components.

**Architecture:** A Svelte 5 component using `$props()` for props and `Snippet` for children. On mount: creates or accepts a client, creates `CartographerState`, attaches SSE listeners, connects, and sets both into Svelte context via `setContext`. On destroy: detaches and disconnects.

**Tech Stack:** TypeScript, Svelte 5, `@testing-library/svelte`, Vitest

**Depends on:** Task 22 (context keys), Task 24 (CartographerState)

---

### Step 1: Write failing tests for the provider

Create `packages/svelte/src/provider.test.svelte.ts`:

Testing Svelte 5 components requires rendering them via `@testing-library/svelte`. Since we can't directly test `setContext` from outside a component, we'll create a small test harness component that reads context and exposes it.

First, create a test helper component `packages/svelte/src/__tests__/ContextReader.svelte`:

```svelte
<script lang="ts">
  import { getContext } from 'svelte';
  import { CARTOGRAPHER_CLIENT_KEY, CARTOGRAPHER_STATE_KEY } from '../context.js';
  import type { CartographerClient } from '@cartographer/client';
  import type { CartographerState } from '../state.svelte.js';

  const client = getContext<CartographerClient>(CARTOGRAPHER_CLIENT_KEY);
  const state = getContext<CartographerState>(CARTOGRAPHER_STATE_KEY);

  let { onContext }: { onContext: (ctx: { client: CartographerClient; state: CartographerState }) => void } = $props();

  onContext({ client, state });
</script>

<div data-testid="context-reader">ready</div>
```

Then create the test file `packages/svelte/src/provider.test.svelte.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { render, cleanup } from '@testing-library/svelte';
import Cartographer from './provider.svelte';
import ContextReader from './__tests__/ContextReader.svelte';
import { createMockClient } from './test-utils.svelte.js';

// Note: We need a wrapper approach to test context. The exact testing pattern
// may need adjustment based on @testing-library/svelte's Svelte 5 support.
// An alternative is to create a test wrapper component that renders
// <Cartographer> with a <ContextReader> child.

describe('Cartographer provider', () => {
  it('calls client.connect() on mount', () => {
    const client = createMockClient();
    // Render with the client prop to verify connect is called
    // The exact rendering approach will depend on how @testing-library/svelte
    // handles Svelte 5 snippets/slots. May need a wrapper .svelte file.
    render(Cartographer, { props: { url: 'http://localhost:3148', client } });
    expect(client.connect).toHaveBeenCalledTimes(1);
  });

  it('calls client.disconnect() on unmount', () => {
    const client = createMockClient();
    render(Cartographer, { props: { url: 'http://localhost:3148', client } });
    cleanup();
    expect(client.disconnect).toHaveBeenCalledTimes(1);
  });

  it('provides client via context', () => {
    const client = createMockClient();
    // This test needs a child component that reads context.
    // Use the ContextReader helper or a test wrapper component.
    // The exact approach depends on @testing-library/svelte's Svelte 5 API.
    // See implementation notes below.
  });
});
```

**Implementation note:** Testing Svelte 5 components with snippets/children in `@testing-library/svelte` may require creating wrapper `.svelte` test components. The implementer should create whatever test harness components are needed under `src/__tests__/` to properly test context provision. The key behaviors to verify:
1. `client.connect()` called on mount
2. `client.disconnect()` called on unmount/cleanup
3. Client and state are available via `getContext` in child components
4. `getClient()` returns the client instance when called within the provider
5. `getClient()` throws when called outside the provider

### Step 2: Run tests to verify they fail

Run: `pnpm --filter @cartographer/svelte test`
Expected: FAIL — cannot import provider component

### Step 3: Implement the provider component

Create `packages/svelte/src/provider.svelte`:

```svelte
<script lang="ts">
  import { setContext, onMount, onDestroy } from 'svelte';
  import { createCartographerClient, type CartographerClient } from '@cartographer/client';
  import { CartographerState } from './state.svelte.js';
  import { CARTOGRAPHER_CLIENT_KEY, CARTOGRAPHER_STATE_KEY } from './context.js';
  import type { Snippet } from 'svelte';

  let { url, client: clientProp, children }: {
    url?: string;
    client?: CartographerClient;
    children: Snippet;
  } = $props();

  const client = clientProp ?? createCartographerClient(url!);
  const state = new CartographerState();

  setContext(CARTOGRAPHER_CLIENT_KEY, client);
  setContext(CARTOGRAPHER_STATE_KEY, state);

  const detach = state.attach(client);

  onMount(() => {
    client.connect();
  });

  onDestroy(() => {
    client.disconnect();
    detach();
  });
</script>

{@render children()}
```

### Step 4: Run tests to verify they pass

Run: `pnpm --filter @cartographer/svelte test`
Expected: PASS

### Step 5: Commit

```bash
git add packages/svelte/src/provider.svelte packages/svelte/src/provider.test.svelte.ts packages/svelte/src/__tests__/
git commit -m "feat(svelte): implement Cartographer provider component"
```

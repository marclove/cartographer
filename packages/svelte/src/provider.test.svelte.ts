import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/svelte';
import ProviderTest from './__tests__/ProviderTest.svelte';
import GetClientAlone from './__tests__/GetClientAlone.svelte';
import { createMockClient } from './test-utils.svelte.js';
import type { CartographerState } from './state.svelte.js';
import type { CartographerClient } from '@cartographer/client';

describe('Cartographer provider', () => {
  it('calls client.connect() on mount', () => {
    const client = createMockClient();
    render(ProviderTest, { props: { client } });
    expect(client.connect).toHaveBeenCalledTimes(1);
  });

  it('calls client.disconnect() on unmount', () => {
    const client = createMockClient();
    const { unmount } = render(ProviderTest, { props: { client } });
    unmount();
    expect(client.disconnect).toHaveBeenCalledTimes(1);
  });

  it('provides client and state via context', () => {
    const client = createMockClient();
    let receivedCtx: { client: CartographerClient; state: CartographerState } | undefined;

    render(ProviderTest, {
      props: {
        client,
        onContext: (ctx: { client: CartographerClient; state: CartographerState }) => {
          receivedCtx = ctx;
        },
      },
    });

    expect(receivedCtx).toBeDefined();
    expect(receivedCtx!.client).toBe(client);
    expect(receivedCtx!.state).toBeDefined();
    expect(receivedCtx!.state.connectionStatus).toBe('connecting');
  });

  it('getClient() throws when used outside provider', () => {
    expect(() => render(GetClientAlone)).toThrow('must be used within');
  });
});

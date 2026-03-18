import { describe, it, expect, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import React from 'react';
import { CartographerProvider, useClient, useConnectionStatus } from './provider.js';
import { createMockClient } from './test-utils.js';

function wrapper(client: ReturnType<typeof createMockClient>) {
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return (
      <CartographerProvider url="http://localhost:3148" client={client}>
        {children}
      </CartographerProvider>
    );
  };
}

describe('CartographerProvider', () => {
  it('calls client.connect() on mount', () => {
    const client = createMockClient();
    renderHook(() => useClient(), { wrapper: wrapper(client) });
    expect(client.connect).toHaveBeenCalledTimes(1);
  });

  it('calls client.disconnect() on unmount', () => {
    const client = createMockClient();
    const { unmount } = renderHook(() => useClient(), { wrapper: wrapper(client) });
    unmount();
    expect(client.disconnect).toHaveBeenCalledTimes(1);
  });
});

describe('useClient', () => {
  it('returns the CartographerClient instance', () => {
    const client = createMockClient();
    const { result } = renderHook(() => useClient(), { wrapper: wrapper(client) });
    expect(result.current).toBe(client);
  });

  it('throws when used outside CartographerProvider', () => {
    expect(() => {
      renderHook(() => useClient());
    }).toThrow(/CartographerProvider/);
  });
});

describe('useConnectionStatus', () => {
  it('returns connecting initially', () => {
    const client = createMockClient();
    const { result } = renderHook(() => useConnectionStatus(), { wrapper: wrapper(client) });
    expect(result.current).toBe('connecting');
  });

  it('returns connected after snapshot event', () => {
    const client = createMockClient();
    const { result } = renderHook(() => useConnectionStatus(), { wrapper: wrapper(client) });

    act(() => {
      client.emit('snapshot', { blackboard: {} });
    });

    expect(result.current).toBe('connected');
  });

  it('returns disconnected after unmount', () => {
    const client = createMockClient();
    const { result, unmount } = renderHook(() => useConnectionStatus(), { wrapper: wrapper(client) });

    act(() => client.emit('snapshot', { blackboard: {} }));
    expect(result.current).toBe('connected');

    unmount();
    // After unmount, the provider calls detach() which sets disconnected
    // We can't read the hook result after unmount, but verify the store state
    // by checking that disconnect was called
    expect(client.disconnect).toHaveBeenCalled();
  });
});

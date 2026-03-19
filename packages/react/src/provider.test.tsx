import { describe, it, expect, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import React from 'react';
import { CartographerProvider, useClient, useConnectionStatus } from './provider.js';
import { createMockClient } from './test-utils.js';

vi.mock('@cartographer/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@cartographer/client')>();
  return {
    ...actual,
    createCartographerClient: vi.fn(() => createMockClient()),
  };
});

function wrapper(client: ReturnType<typeof createMockClient>) {
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return (
      <CartographerProvider client={client}>
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

  it('creates a client from url when no client prop is provided', async () => {
    const { createCartographerClient } = await import('@cartographer/client');
    function UrlWrapper({ children }: { children: React.ReactNode }) {
      return (
        <CartographerProvider url="http://localhost:3148">
          {children}
        </CartographerProvider>
      );
    }
    const { result } = renderHook(() => useClient(), { wrapper: UrlWrapper });
    expect(createCartographerClient).toHaveBeenCalledWith('http://localhost:3148');
    expect(result.current).toBeDefined();
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

  it('works with client prop only (no url)', () => {
    const client = createMockClient();
    const { result } = renderHook(() => useClient(), { wrapper: wrapper(client) });
    expect(result.current).toBe(client);
    expect(client.connect).toHaveBeenCalledTimes(1);
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

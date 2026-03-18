import { vi } from 'vitest';
import type { CartographerClient } from '@cartographer/client';
import { CartographerState } from './state.svelte.js';

/**
 * Creates a mock {@link CartographerClient} suitable for unit tests.
 *
 * All client methods (`action`, `write`, `send`, etc.) are stubbed with
 * `vi.fn()` and return sensible defaults. The mock's `on`/`off` methods
 * manage a real listener map so the returned `emit` helper can dispatch
 * synthetic SSE events to any registered handler.
 *
 * @returns A mock client with an additional `emit(event, data)` method for
 *          simulating server-sent events in tests.
 */
export function createMockClient(): CartographerClient & {
  /** Dispatches {@link data} to all handlers registered for {@link event} via `on()`. */
  emit(event: string, data: unknown): void;
} {
  const listeners = new Map<string, Set<(data: unknown) => void>>();

  return {
    action: vi.fn().mockResolvedValue({ id: 'msg-1' }),
    write: vi.fn().mockResolvedValue({ id: 'msg-2' }),
    send: vi.fn().mockResolvedValue({ id: 'msg-3' }),
    actionAndWait: vi.fn().mockResolvedValue({ messageId: 'msg-1', treeStatus: 'success' }),
    interrupt: vi.fn().mockResolvedValue({ interrupted: false }),
    resume: vi.fn().mockResolvedValue({ resumed: true }),
    interruptAndAction: vi.fn().mockResolvedValue({ id: 'msg-4' }),
    blackboard: vi.fn().mockResolvedValue({}),
    tree: vi.fn().mockResolvedValue({}),
    status: vi.fn().mockResolvedValue({}),
    on(event: string, handler: (data: unknown) => void) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event)!.add(handler);
    },
    onAny: vi.fn(),
    off(event: string, handler: (data: unknown) => void) {
      listeners.get(event)?.delete(handler);
    },
    connect: vi.fn(),
    disconnect: vi.fn(),
    emit(event: string, data: unknown) {
      const handlers = listeners.get(event);
      if (handlers) {
        for (const handler of handlers) handler(data);
      }
    },
  };
}

/**
 * Creates a mock client and a {@link CartographerState} instance already wired
 * together via {@link CartographerState.attach | attach()}.
 *
 * Use this to test reactive state transitions driven by SSE events without
 * rendering a full Svelte component tree. Call `client.emit(event, data)` to
 * simulate server events and then assert against `state.*` properties.
 *
 * @param overrides - Optional partial overrides merged onto the mock client
 *                    before `attach()` is called, useful for customizing
 *                    individual method stubs.
 * @returns An object containing the mock `client` and the reactive `state`.
 */
export function createTestContext(overrides?: Partial<CartographerClient>): {
  client: CartographerClient & { emit(event: string, data: unknown): void };
  state: CartographerState;
} {
  const client = createMockClient();
  if (overrides) {
    Object.assign(client, overrides);
  }
  const state = new CartographerState();
  state.attach(client);
  return { client, state };
}

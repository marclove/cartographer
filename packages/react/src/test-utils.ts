import { vi } from 'vitest';
import type { CartographerClient } from '@cartographer/client';

/** Creates a mock CartographerClient that stores listeners and lets tests simulate SSE events. */
export function createMockClient(): CartographerClient & {
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

import { describe, it, expect } from 'vitest';
import type { TreeStatusInfo, ConnectionStatus } from './types.js';

describe('types', () => {
  it('TreeStatusInfo has the expected shape', () => {
    const info: TreeStatusInfo = {
      status: 'success',
      durationMs: 42,
      localTickCount: 1,
    };
    expect(info.status).toBe('success');
    expect(info.durationMs).toBe(42);
    expect(info.localTickCount).toBe(1);
  });

  it('ConnectionStatus accepts valid values', () => {
    const statuses: ConnectionStatus[] = ['connecting', 'connected', 'disconnected'];
    expect(statuses).toHaveLength(3);
  });
});

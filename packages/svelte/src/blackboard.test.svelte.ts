import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/svelte';
import { tick } from 'svelte';
import BlackboardTest from './__tests__/BlackboardTest.svelte';
import { createMockClient } from './test-utils.svelte.js';

describe('getBlackboard', () => {
  it('returns undefined for unset key before snapshot', () => {
    const client = createMockClient();
    render(BlackboardTest, { props: { client, bbKey: 'name' } });

    expect(screen.getByTestId('bb-value').textContent).toBe('');
  });

  it('returns value after snapshot', async () => {
    const client = createMockClient();
    render(BlackboardTest, { props: { client, bbKey: 'name' } });

    client.emit('snapshot', { blackboard: { name: 'Alice' } });
    await tick();

    expect(screen.getByTestId('bb-value').textContent).toBe('"Alice"');
  });

  it('updates on blackboard:write for matching key', async () => {
    const client = createMockClient();
    render(BlackboardTest, { props: { client, bbKey: 'count' } });

    client.emit('snapshot', { blackboard: { count: 1 } });
    await tick();
    expect(screen.getByTestId('bb-value').textContent).toBe('1');

    client.emit('blackboard:write', { key: 'count', value: 42 });
    await tick();
    expect(screen.getByTestId('bb-value').textContent).toBe('42');
  });

  it('setter calls client.write with correct args', async () => {
    const client = createMockClient();
    let capturedSet: ((v: unknown) => Promise<void>) | undefined;

    render(BlackboardTest, {
      props: {
        client,
        bbKey: 'foo',
        onResult: (result: { set: (v: unknown) => Promise<void> }) => {
          capturedSet = result.set;
        },
      },
    });

    expect(capturedSet).toBeDefined();
    await capturedSet!('bar');

    expect(client.write).toHaveBeenCalledWith('foo', 'bar');
  });

  it('setter propagates rejection', async () => {
    const client = createMockClient();
    client.write = vi.fn().mockRejectedValue(new Error('write failed'));
    let capturedSet: ((v: unknown) => Promise<void>) | undefined;

    render(BlackboardTest, {
      props: {
        client,
        bbKey: 'fail',
        onResult: (result: { set: (v: unknown) => Promise<void> }) => {
          capturedSet = result.set;
        },
      },
    });

    expect(capturedSet).toBeDefined();
    await expect(capturedSet!('nope')).rejects.toThrow('write failed');
  });
});

describe('getBlackboardSnapshot', () => {
  it('returns empty object before snapshot', () => {
    const client = createMockClient();
    render(BlackboardTest, { props: { client, bbKey: 'unused' } });

    expect(screen.getByTestId('bb-snapshot').textContent).toBe('{}');
  });

  it('returns full blackboard after snapshot', async () => {
    const client = createMockClient();
    render(BlackboardTest, { props: { client, bbKey: 'unused' } });

    client.emit('snapshot', { blackboard: { a: 1, b: 'two' } });
    await tick();

    const parsed = JSON.parse(screen.getByTestId('bb-snapshot').textContent!);
    expect(parsed).toEqual({ a: 1, b: 'two' });
  });

  it('updates on any key change', async () => {
    const client = createMockClient();
    render(BlackboardTest, { props: { client, bbKey: 'unused' } });

    client.emit('snapshot', { blackboard: { x: 1 } });
    await tick();

    client.emit('blackboard:write', { key: 'y', value: 2 });
    await tick();

    const parsed = JSON.parse(screen.getByTestId('bb-snapshot').textContent!);
    expect(parsed).toEqual({ x: 1, y: 2 });
  });
});

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/svelte';
import { tick } from 'svelte';
import StatusTest from './__tests__/StatusTest.svelte';
import { createMockClient } from './test-utils.svelte.js';

describe('getConnectionStatus', () => {
  it('returns connecting initially', () => {
    const client = createMockClient();
    render(StatusTest, { props: { client } });

    expect(screen.getByTestId('conn-status').textContent).toBe('connecting');
  });

  it('returns connected after snapshot event', async () => {
    const client = createMockClient();
    render(StatusTest, { props: { client } });

    client.emit('snapshot', { blackboard: {} });
    await tick();

    expect(screen.getByTestId('conn-status').textContent).toBe('connected');
  });

  it('returns connecting on connection:error with readyState 0', async () => {
    const client = createMockClient();
    render(StatusTest, { props: { client } });

    client.emit('snapshot', { blackboard: {} });
    await tick();
    expect(screen.getByTestId('conn-status').textContent).toBe('connected');

    client.emit('connection:error', { readyState: 0 });
    await tick();

    expect(screen.getByTestId('conn-status').textContent).toBe('connecting');
  });

  it('returns disconnected on connection:error with readyState 2', async () => {
    const client = createMockClient();
    render(StatusTest, { props: { client } });

    client.emit('snapshot', { blackboard: {} });
    await tick();

    client.emit('connection:error', { readyState: 2 });
    await tick();

    expect(screen.getByTestId('conn-status').textContent).toBe('disconnected');
  });
});

describe('getTreeStatus', () => {
  it('returns null before first tree:tick', () => {
    const client = createMockClient();
    render(StatusTest, { props: { client } });

    expect(screen.getByTestId('tree-status').textContent).toBe('null');
  });

  it('returns status after tree:tick', async () => {
    const client = createMockClient();
    render(StatusTest, { props: { client } });

    client.emit('tree:tick', { status: 'SUCCESS', durationMs: 42 });
    await tick();

    const parsed = JSON.parse(screen.getByTestId('tree-status').textContent!);
    expect(parsed).toEqual({ status: 'SUCCESS', durationMs: 42, localTickCount: 1 });
  });

  it('increments localTickCount on subsequent ticks', async () => {
    const client = createMockClient();
    render(StatusTest, { props: { client } });

    client.emit('tree:tick', { status: 'SUCCESS', durationMs: 10 });
    await tick();

    client.emit('tree:tick', { status: 'RUNNING', durationMs: 20 });
    await tick();

    client.emit('tree:tick', { status: 'SUCCESS', durationMs: 30 });
    await tick();

    const parsed = JSON.parse(screen.getByTestId('tree-status').textContent!);
    expect(parsed).toEqual({ status: 'SUCCESS', durationMs: 30, localTickCount: 3 });
  });

  it('resets on snapshot', async () => {
    const client = createMockClient();
    render(StatusTest, { props: { client } });

    client.emit('tree:tick', { status: 'SUCCESS', durationMs: 10 });
    await tick();

    const before = JSON.parse(screen.getByTestId('tree-status').textContent!);
    expect(before.localTickCount).toBe(1);

    client.emit('snapshot', { blackboard: {} });
    await tick();

    expect(screen.getByTestId('tree-status').textContent).toBe('null');
  });
});

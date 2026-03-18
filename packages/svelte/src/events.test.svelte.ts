import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/svelte';
import ClientEventTest from './__tests__/ClientEventTest.svelte';
import TreeEventTest from './__tests__/TreeEventTest.svelte';
import { createMockClient } from './test-utils.svelte.js';

describe('onClientEvent', () => {
  it('calls handler when matching event fires', () => {
    const client = createMockClient();
    const handler = vi.fn();
    render(ClientEventTest, { props: { client, eventName: 'ui:modal', handler } });
    client.emit('ui:modal', { title: 'Hello' });
    expect(handler).toHaveBeenCalledWith({ title: 'Hello' });
  });

  it('cleans up on component destroy', () => {
    const client = createMockClient();
    const handler = vi.fn();
    const { unmount } = render(ClientEventTest, { props: { client, eventName: 'ui:modal', handler } });
    unmount();
    client.emit('ui:modal', { title: 'After unmount' });
    expect(handler).not.toHaveBeenCalled();
  });
});

describe('onTreeEvent', () => {
  it('calls handler when matching event fires', () => {
    const client = createMockClient();
    const handler = vi.fn();
    render(TreeEventTest, { props: { client, eventType: 'tree:tick', handler } });
    client.emit('tree:tick', { nodeId: 'root' });
    expect(handler).toHaveBeenCalledWith({ nodeId: 'root' });
  });

  it('cleans up on component destroy', () => {
    const client = createMockClient();
    const handler = vi.fn();
    const { unmount } = render(TreeEventTest, { props: { client, eventType: 'tree:tick', handler } });
    unmount();
    client.emit('tree:tick', { nodeId: 'root' });
    expect(handler).not.toHaveBeenCalled();
  });
});

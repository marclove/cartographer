import { describe, it, expect, vi } from 'vitest';
import { EventBridge } from './event-bridge.js';
import { InMemoryStateStore } from '../state/in-memory-state-store.js';
import { BehaviorTree } from '../core/behavior-tree.js';
import { TreeBuilder } from '../builder/tree-builder.js';
import { NodeStatus } from '../types.js';

describe('EventBridge onEvent callback', () => {
  function makeTree(): BehaviorTree {
    return new TreeBuilder('test')
      .sequence('root', (b) => {
        b.action('a', () => NodeStatus.SUCCESS);
      })
      .build();
  }

  it('fires onEvent for tree events as they arrive', async () => {
    const store = new InMemoryStateStore();
    const received: Array<{ type: string; data: Record<string, unknown> }> = [];
    const bridge = new EventBridge(store, 'default', undefined, (evt) => {
      received.push(evt);
    });

    const tree = makeTree();
    bridge.bridgeTree(tree);
    await tree.tick();

    // Should have received events before flush
    expect(received.length).toBeGreaterThan(0);
    expect(received.some(e => e.type === 'node:enter')).toBe(true);
  });

  it('fires onEvent for lifecycle events', async () => {
    const store = new InMemoryStateStore();
    const received: Array<{ type: string; data: Record<string, unknown> }> = [];
    const bridge = new EventBridge(store, 'default', undefined, (evt) => {
      received.push(evt);
    });

    await bridge.emitProcessed('success');

    const lifecycle = received.filter(e => e.type === 'message:processed');
    expect(lifecycle).toHaveLength(1);
    expect(lifecycle[0].data).toEqual(
      expect.objectContaining({ treeStatus: 'success' }),
    );
  });

  it('works without onEvent callback (backward compatible)', async () => {
    const store = new InMemoryStateStore();
    const bridge = new EventBridge(store, 'default');

    const tree = makeTree();
    bridge.bridgeTree(tree);
    await tree.tick();
    await bridge.emitProcessed('success');
    // No error thrown — callback is optional
  });
});
